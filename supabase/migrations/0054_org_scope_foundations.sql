-- Organization scope foundations (wave 3, PLAN-03 §2.1).
--
-- A third authorization axis is introduced NEXT TO the existing two, never instead of them:
--   * tenant -- org_id = auth_org()            (0001/0006, unchanged)
--   * role   -- auth_role()                    (0001, unchanged; user_role stays frozen)
--   * scope  -- unit_id = any(auth_scopes())   (vocabulary lands here, enforcement in 0057)
--
-- This migration is vocabulary only: the unit tree, the classification registry, per-user
-- grants, the synchronously-maintained closure, auth_scopes()/assert_unit_in_scope(), and
-- the seeding triggers. Not a single existing policy, table or function is edited, so the
-- 172 (table, policy) pairs and every definer command keep behaving exactly as before.
--
-- Why AFTER INSERT triggers and not only a backfill (orchestrator decision, PLAN-03 §1.3):
-- [db.seed] is enabled, so seed.sql's baseline org, the demo tenant and every test fixture
-- are created AFTER migrations on each `db reset`. A one-shot backfill would leave all of
-- them without a root unit, auth_scopes() would return empty, and the 0057 rider would deny
-- every row -- 266 P0 assertions red. Provisioning is therefore self-seeding; 0056 covers
-- only rows that predate 0054 (the live database and the 0019 upgrade fixture).

-- ===== The unit tree =====
-- One tree (ADR-0004): a single org_units table with parent_id + unit_type, not five
-- tables. 'region' / 'department' from the model document are future enum additions, not
-- rows we can invent today.
create type org_unit_type as enum ('root', 'legal_entity', 'branch', 'warehouse');

create table org_units (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  parent_id  uuid,
  unit_type  org_unit_type not null,
  name       text not null check (trim(name) <> ''),
  created_at timestamptz not null default now(),
  -- Target for every composite (org_id, unit_id) foreign key in 0055: a referencing row
  -- can only ever point at a unit of its OWN organization, structurally.
  constraint org_units_org_id_id_key unique (org_id, id),
  -- The parent must live in the same organization -- same composite-FK idiom. Deliberately
  -- the default NO ACTION (checked at statement end), so an organization-level cascade that
  -- removes a whole subtree in one statement does not trip over its own ordering.
  constraint org_units_parent_fk foreign key (org_id, parent_id)
    references org_units (org_id, id),
  -- Exactly the root carries no parent; every other unit hangs off the tree.
  constraint org_units_root_shape check ((unit_type = 'root') = (parent_id is null))
);

-- One root per organization. The scope model of this wave depends on it (every user is
-- anchored to the root), and the 0057 exemption latch reasons about "a second unit" -- a
-- second ROOT must be impossible rather than merely anomalous.
create unique index org_units_one_root_per_org on org_units (org_id) where unit_type = 'root';
create index org_units_org_parent_idx on org_units (org_id, parent_id);

-- Cycle/depth guard. A parent chain that loops would send the closure recompute into
-- infinite recursion; a chain deeper than the documented hierarchy (root > legal_entity >
-- region > branch > warehouse, plus slack) is a data error, not a layout choice.
create or replace function org_units_guard_hierarchy() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_ancestor uuid := new.parent_id;
  v_depth int := 0;
begin
  if tg_op = 'UPDATE' and new.org_id is distinct from old.org_id then
    raise exception 'org_units_org_immutable' using errcode = '42501';
  end if;
  while v_ancestor is not null loop
    if v_ancestor = new.id then
      raise exception 'org_units_cycle_detected' using errcode = '23514';
    end if;
    v_depth := v_depth + 1;
    if v_depth > 8 then
      raise exception 'org_units_depth_exceeded' using errcode = '23514';
    end if;
    select u.parent_id into v_ancestor from org_units u where u.id = v_ancestor;
  end loop;
  return new;
end
$$;
revoke all on function org_units_guard_hierarchy() from public, anon, authenticated;

create trigger org_units_guard_hierarchy
  before insert or update on org_units
  for each row execute function org_units_guard_hierarchy();

-- Tenant-scoped read; no browser writes in this wave (units are created by the seeding
-- trigger, 0056, or future owner commands). Grant and policy stay mutually consistent so
-- the all-tables ACL contract in p1_financial_commands.sql:18-64 holds.
alter table org_units enable row level security;
create policy org_units_select on org_units for select to authenticated
  using (org_id = auth_org());
revoke all on table org_units from public, anon, authenticated;
grant select on table org_units to authenticated;

-- Structural changes to the unit tree are sensitive: they change what every scoped user
-- can see. org_units carries org_id, so the 0009:175-195 structural assert stays quiet.
create trigger org_units_audit
  after insert or update or delete on org_units
  for each row execute function audit_row_change();

-- ===== The classification registry =====
-- GLOBAL and in schema `private` (precedent: private.whatsapp_reminder_config, 0028): it
-- classifies tables, it does not belong to any tenant, and living outside `public` keeps it
-- out of the all-tables browser-ACL contract scan. 0057 reads it to stamp RESTRICTIVE
-- riders on the rows marked enforced, and asserts (A1) that every public table appears here
-- -- a future migration that adds an unclassified table fails the gate.
create table private.scope_registry (
  table_name  text primary key,
  scope_class text not null check (scope_class in (
    'org_global', 'legal_entity', 'branch', 'warehouse',
    'derived', 'cross_scope', 'deferred', 'system')),
  enforced    boolean not null default false
);
revoke all on table private.scope_registry from public, anon, authenticated;

-- All 55 RLS-enabled public tables, per docs/ENTERPRISE-SECURITY-MODEL.md §3.
-- Notes that are NOT in the document:
--   * payment_request_invoices is missing from §3 -- it is a junction under
--     payment_requests and is classified derived, like its allocation siblings.
--   * platform_admins carries no org_id at all (0006:11) and is cross-tenant by design;
--     'system' is the honest class, not 'org_global'.
--   * The eight tables that ARE classified but deliberately not indexed/enforced in this
--     wave (purchase_requests, next_order_items, payment_requests, bank_imports,
--     monthly_exports, exceptions, notifications, audit_logs) keep their matrix class with
--     enforced = false; enforcement arrives in a later wave. Only the six below are true.
insert into private.scope_registry (table_name, scope_class, enforced) values
  -- §3.1 org-global -- never a scope column
  ('organizations',                               'org_global',   false),
  ('profiles',                                    'org_global',   false),
  ('invitations',                                 'org_global',   false),
  ('push_subscriptions',                          'org_global',   false),
  ('categories',                                  'org_global',   false),
  ('whatsapp_connections',                        'org_global',   false),
  ('whatsapp_webhook_events',                     'org_global',   false),
  -- §3.2 catalog -- org-global by business decision (supplier/price splitting is the bug)
  ('suppliers',                                   'org_global',   false),
  ('products',                                    'org_global',   false),
  ('supplier_products',                           'org_global',   false),
  ('supplier_price_submissions',                  'org_global',   false),
  ('supplier_price_submission_intakes',           'org_global',   false),
  ('supplier_price_document_upload_reservations', 'org_global',   false),
  -- §3.3 procurement -- branch
  ('purchase_requests',                           'branch',       false),
  ('purchase_orders',                             'branch',       true),
  ('next_order_items',                            'branch',       false),
  -- §3.4 receiving & inventory -- warehouse
  ('goods_receipts',                              'warehouse',    true),
  ('inventory_movements',                         'warehouse',    true),
  -- §3.5 financial -- legal entity
  ('invoices',                                    'legal_entity', true),
  ('payment_requests',                            'legal_entity', false),
  ('payments',                                    'legal_entity', true),
  ('bank_imports',                                'legal_entity', false),
  ('monthly_exports',                             'legal_entity', false),
  -- §3.6 cross-scope -- carry a scope REFERENCE for filtering, never ownership
  ('documents',                                   'cross_scope',  true),
  ('exceptions',                                  'cross_scope',  false),
  ('notifications',                               'cross_scope',  false),
  ('audit_logs',                                  'cross_scope',  false),
  -- derived -- inherit tenant and scope through the composite FK to their parent;
  -- a derived table must NEVER receive its own scope column (ADR-0004 §4)
  ('supplier_categories',                         'derived',      false),
  ('price_history',                               'derived',      false),
  ('purchase_request_items',                      'derived',      false),
  ('purchase_order_items',                        'derived',      false),
  ('whatsapp_order_messages',                     'derived',      false),
  ('goods_receipt_items',                         'derived',      false),
  ('credit_requests',                             'derived',      false),
  ('invoice_order_links',                         'derived',      false),
  ('invoice_receipt_links',                       'derived',      false),
  ('payment_request_invoices',                    'derived',      false),
  ('payment_allocations',                         'derived',      false),
  ('bank_transactions',                           'derived',      false),
  ('bank_allocations',                            'derived',      false),
  ('comments',                                    'derived',      false),
  ('notification_event_states',                   'derived',      false),
  ('document_processing_jobs',                    'derived',      false),
  ('document_extractions',                        'derived',      false),
  ('document_interpretations',                    'derived',      false),
  ('document_learning_rules',                     'derived',      false),
  ('document_annotations',                        'derived',      false),
  ('document_feedback',                           'derived',      false),
  ('document_rule_applications',                  'derived',      false),
  ('document_export_templates',                   'derived',      false),
  ('document_export_template_versions',           'derived',      false),
  ('document_exports',                            'derived',      false),
  ('document_review_corrections',                 'derived',      false),
  ('document_type_review_decisions',              'derived',      false),
  -- system -- platform infrastructure, outside the tenant data plane
  ('platform_admins',                             'system',       false),
  -- this wave's own vocabulary (org_units/user_scope_grants are org-global bookkeeping;
  -- the closure is derived data -- a cache of grants x units, never edited directly)
  ('org_units',                                   'org_global',   false),
  ('user_scope_grants',                           'org_global',   false),
  ('user_scope_closure',                          'derived',      false);

-- ===== Per-user grants =====
-- A grant anchors a user to one unit; the closure below expands it to the whole subtree.
-- Both foreign keys are composite, so a grant can neither point at a unit of another
-- organization nor at a user of another organization -- structurally, before any policy.
create table user_scope_grants (
  org_id     uuid not null,
  user_id    uuid not null,
  unit_id    uuid not null,
  created_at timestamptz not null default now(),
  constraint user_scope_grants_pkey primary key (org_id, user_id, unit_id),
  constraint user_scope_grants_user_fk foreign key (org_id, user_id)
    references profiles (org_id, id) on delete cascade,
  constraint user_scope_grants_unit_fk foreign key (org_id, unit_id)
    references org_units (org_id, id) on delete cascade
);
create index user_scope_grants_user_idx on user_scope_grants (user_id);
create index user_scope_grants_unit_idx on user_scope_grants (org_id, unit_id);

-- Tenant-scoped read; writes ONLY through grant_user_scope()/revoke_user_scope() below.
alter table user_scope_grants enable row level security;
create policy user_scope_grants_select on user_scope_grants for select to authenticated
  using (org_id = auth_org());
revoke all on table user_scope_grants from public, anon, authenticated;
grant select on table user_scope_grants to authenticated;

-- ===== The closure =====
-- A REAL table, recomputed synchronously by the triggers below -- not a materialized view
-- and not a cron job (orchestrator decision, PLAN-03 §1.3): a stale closure is a SECURITY
-- bug, not a performance bug. Server-only cache: RLS on, no policy, no browser grant --
-- auth_scopes() (security definer) is the only read path, which keeps the ACL contract
-- consistent. No audit trigger: this is derived data, the grants themselves are audited.
create table user_scope_closure (
  user_id  uuid not null,
  org_id   uuid not null,
  unit_ids uuid[] not null,
  constraint user_scope_closure_pkey primary key (user_id, org_id),
  constraint user_scope_closure_user_fk foreign key (org_id, user_id)
    references profiles (org_id, id) on delete cascade
);
create index user_scope_closure_org_idx on user_scope_closure (org_id);
alter table user_scope_closure enable row level security;
revoke all on table user_scope_closure from public, anon, authenticated;

-- Recompute one (org, user) pair: every granted unit plus its whole subtree, deduplicated,
-- sorted for deterministic comparison in tests. UNION (not UNION ALL) also makes the
-- recursion terminate even if a cycle ever slipped past the hierarchy guard.
create or replace function p0_recompute_scope_closure(p_org uuid, p_user uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_units uuid[];
begin
  select array_agg(d.id order by d.id) into v_units
  from (
    with recursive reachable as (
      select u.id
      from org_units u
      where u.org_id = p_org
        and exists (
          select 1 from user_scope_grants g
          where g.org_id = p_org and g.user_id = p_user and g.unit_id = u.id)
      union
      select c.id
      from org_units c
      join reachable r on c.parent_id = r.id
      where c.org_id = p_org
    )
    select id from reachable
  ) d;

  if v_units is null then
    delete from user_scope_closure where org_id = p_org and user_id = p_user;
  else
    insert into user_scope_closure (user_id, org_id, unit_ids)
    values (p_user, p_org, v_units)
    on conflict (user_id, org_id) do update set unit_ids = excluded.unit_ids;
  end if;
end
$$;
revoke all on function p0_recompute_scope_closure(uuid, uuid) from public, anon, authenticated;

-- Grant changes resync the affected user immediately, in the same transaction.
create or replace function p0_scope_grants_sync_closure() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    perform p0_recompute_scope_closure(new.org_id, new.user_id);
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    perform p0_recompute_scope_closure(old.org_id, old.user_id);
  end if;
  return null;
end
$$;
revoke all on function p0_scope_grants_sync_closure() from public, anon, authenticated;

create trigger p0_scope_grants_sync_closure
  after insert or update or delete on user_scope_grants
  for each row execute function p0_scope_grants_sync_closure();

-- Tree changes resync every granted user of that organization: moving or adding a unit
-- changes which subtrees existing grants expand to.
create or replace function p0_org_units_sync_closure() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  r record;
begin
  if tg_op = 'DELETE' then v_org := old.org_id; else v_org := new.org_id; end if;
  for r in select distinct g.user_id from user_scope_grants g where g.org_id = v_org loop
    perform p0_recompute_scope_closure(v_org, r.user_id);
  end loop;
  return null;
end
$$;
revoke all on function p0_org_units_sync_closure() from public, anon, authenticated;

create trigger p0_org_units_sync_closure
  after insert or update or delete on org_units
  for each row execute function p0_org_units_sync_closure();

-- ===== auth_scopes() =====
-- Mirrors auth_org() (0006:79-86) deliberately and exactly: zero arguments, language sql,
-- stable, security definer, pinned search_path. Returning uuid[] (never setof) keeps the
-- 0057 rider an InitPlan evaluated once per statement, and `unit_id = any($0)` an
-- indexable ScalarArrayOpExpr (ENTERPRISE-SECURITY-MODEL §5). Keying on auth_org() means a
-- suspended organization loses its scopes through the same chokepoint that already revokes
-- everything else.
create or replace function auth_scopes() returns uuid[]
language sql stable security definer set search_path = public as
$$ select coalesce(
     (select c.unit_ids
        from user_scope_closure c
       where c.user_id = auth.uid()
         and c.org_id = auth_org()),
     '{}'::uuid[]) $$;

-- The definer-side guard (A5). RLS riders never apply inside security definer functions,
-- so every definer command that touches a scoped table must call this on the unit it is
-- about to act on. NULL is org-visible by design; a missing JWT subject is migration/seed/
-- service work and is already trusted (same early-out as p1_financial_command_guard).
create or replace function assert_unit_in_scope(p_unit_id uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if p_unit_id is null or auth.uid() is null then
    return;
  end if;
  if not (p_unit_id = any (auth_scopes())) then
    raise exception 'unit_out_of_scope' using errcode = '42501';
  end if;
end
$$;
revoke all on function assert_unit_in_scope(uuid) from public, anon, authenticated;

-- The deterministic default unit of a dimension: the oldest unit of that type. In this
-- wave every organization holds exactly one legal_entity, one branch and one warehouse, so
-- "oldest" is simply "the one"; the ordering keeps the answer stable if a later wave adds
-- siblings before defaults become explicit.
create or replace function p0_default_unit(p_org uuid, p_type org_unit_type) returns uuid
language sql stable security definer set search_path = public as
$$ select u.id
     from org_units u
    where u.org_id = p_org and u.unit_type = p_type
    order by u.created_at, u.id
    limit 1 $$;
revoke all on function p0_default_unit(uuid, org_unit_type) from public, anon, authenticated;

-- ===== Scope grant commands =====
-- The ONLY write path for user_scope_grants from the API: owner-only, mandatory reason,
-- audit row in the same transaction, and the closure resync happens synchronously through
-- the grant trigger before the command returns.
create or replace function grant_user_scope(p_user_id uuid, p_unit_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_reason text := nullif(trim(p_reason), '');
  v_unit org_units;
begin
  if v_org is null or v_actor is null or auth_role() <> 'owner' then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'scope_reason_required' using errcode = '22023';
  end if;
  select * into v_unit from org_units where id = p_unit_id and org_id = v_org;
  if not found then
    raise exception 'unit_unknown' using errcode = 'P0002';
  end if;
  if not exists (select 1 from profiles p where p.id = p_user_id and p.org_id = v_org) then
    raise exception 'profile_unknown' using errcode = 'P0002';
  end if;

  insert into user_scope_grants (org_id, user_id, unit_id)
  values (v_org, p_user_id, p_unit_id)
  on conflict (org_id, user_id, unit_id) do nothing;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, new_values, reason)
  values (
    v_org, v_actor, 'user_scope_granted', 'user_scope_grants', p_user_id,
    jsonb_build_object(
      'user_id', p_user_id, 'unit_id', p_unit_id,
      'unit_type', v_unit.unit_type, 'unit_name', v_unit.name),
    v_reason
  );
end
$$;
revoke all on function grant_user_scope(uuid, uuid, text) from public, anon;
grant execute on function grant_user_scope(uuid, uuid, text) to authenticated;

create or replace function revoke_user_scope(p_user_id uuid, p_unit_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_reason text := nullif(trim(p_reason), '');
  v_unit org_units;
begin
  if v_org is null or v_actor is null or auth_role() <> 'owner' then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'scope_reason_required' using errcode = '22023';
  end if;
  select * into v_unit from org_units where id = p_unit_id and org_id = v_org;
  if not found then
    raise exception 'unit_unknown' using errcode = 'P0002';
  end if;

  delete from user_scope_grants
  where org_id = v_org and user_id = p_user_id and unit_id = p_unit_id;
  if not found then
    raise exception 'scope_grant_unknown' using errcode = 'P0002';
  end if;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, old_values, reason)
  values (
    v_org, v_actor, 'user_scope_revoked', 'user_scope_grants', p_user_id,
    jsonb_build_object(
      'user_id', p_user_id, 'unit_id', p_unit_id,
      'unit_type', v_unit.unit_type, 'unit_name', v_unit.name),
    v_reason
  );
end
$$;
revoke all on function revoke_user_scope(uuid, uuid, text) from public, anon;
grant execute on function revoke_user_scope(uuid, uuid, text) to authenticated;

-- ===== Seeding triggers (PLAN-03 §1.3 -- the critical piece) =====
-- Every organization created from now on receives its default unit chain the moment it is
-- born, mirroring the documented hierarchy (ENTERPRISE-SECURITY-MODEL §2):
--   root (the organization's own name)
--   └── legal_entity 'ישות משפטית ראשית'
--       └── branch 'סניף ראשי'
--           └── warehouse 'מחסן ראשי'
-- The Hebrew names are the documented defaults for this wave. The function touches no auth
-- context at all, so raw inserts (seed.sql, demo_seed.sql, live_schema_alignment.sql:80,
-- service-role fixtures) keep working unchanged with auth.uid() IS NULL.
create or replace function p0_seed_org_units() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_root uuid;
  v_le uuid;
  v_branch uuid;
begin
  if exists (select 1 from org_units u where u.org_id = new.id and u.unit_type = 'root') then
    return new;
  end if;
  insert into org_units (org_id, parent_id, unit_type, name)
  values (new.id, null, 'root', new.name)
  returning id into v_root;
  insert into org_units (org_id, parent_id, unit_type, name)
  values (new.id, v_root, 'legal_entity', 'ישות משפטית ראשית')
  returning id into v_le;
  insert into org_units (org_id, parent_id, unit_type, name)
  values (new.id, v_le, 'branch', 'סניף ראשי')
  returning id into v_branch;
  insert into org_units (org_id, parent_id, unit_type, name)
  values (new.id, v_branch, 'warehouse', 'מחסן ראשי');
  return new;
end
$$;
revoke all on function p0_seed_org_units() from public, anon, authenticated;

create trigger p0_organizations_seed_units
  after insert on organizations
  for each row execute function p0_seed_org_units();

-- Every new profile is anchored to the organization's root: scope-neutral behaviour,
-- identical visibility to today. The grant insert resyncs the closure synchronously via
-- p0_scope_grants_sync_closure. If the org somehow predates 0054 mid-upgrade the root does
-- not exist yet -- return quietly, 0056 anchors those users.
create or replace function p0_seed_profile_scope() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_root uuid;
begin
  select u.id into v_root
  from org_units u
  where u.org_id = new.org_id and u.unit_type = 'root';
  if v_root is null then
    return new;
  end if;
  insert into user_scope_grants (org_id, user_id, unit_id)
  values (new.org_id, new.id, v_root)
  on conflict (org_id, user_id, unit_id) do nothing;
  return new;
end
$$;
revoke all on function p0_seed_profile_scope() from public, anon, authenticated;

create trigger p0_profiles_seed_scope
  after insert on profiles
  for each row execute function p0_seed_profile_scope();
