-- Wave 1 of Customer Operations (owner decision 19.08.2026) -- platform authority stops being a
-- single boolean, and the operator's customer list starts answering a question `platform_orgs()`
-- could not.
--
-- Shape: `platform_admins` (0006:11) stays exactly as it is -- one row per operator, granted
-- out-of-band, read by `is_platform_admin()`, and depended on by five reasoned commands and a
-- whole family of RLS policies. This migration does not touch it. It adds a SECOND axis ON TOP:
-- a capability vocabulary, five named roles that bundle capabilities, and an assignment table.
-- `platform_has_capability(text)` answers "may this operator do X", and is false for anyone who
-- is not already a platform admin -- capability never grants membership, it only narrows it.
-- Every existing operator is backfilled to `super_admin`, so nothing that works today stops
-- working; the narrowing becomes available the moment a second operator is hired.
--
-- Role assignment is deliberately NOT writable through the API, for the same reason 0006:27-31
-- gives for membership itself: a table that hands out cross-tenant power must not be reachable
-- from anything holding only a user JWT, including its own members, which would make the grant
-- self-propagating. The operator console renders the roster; it never writes it.
--
-- The list function replaces the console's read of `platform_orgs()` with one that supports
-- server-side search, filtering and paging, and adds the column the console has never had: when
-- the tenant last actually did something. That answer comes from `audit_logs`, not from the
-- business tables -- see section 4 for why that is both cheaper and more honest than four
-- MAX(created_at) probes.
--
-- What this deliberately does not cover: `platform_orgs()` is left in place and unchanged (the
-- 0006 contract, still a working read); no existing command gains a capability check in this
-- file, so every capability except `customer.view` is DECLARED, not yet ENFORCED -- each is wired
-- by the wave that owns its surface, and `enforced_since` in the seed says which is which. Plans,
-- subscriptions, entitlements, usage and health are waves 3-5 and are absent here; the console
-- shows nothing for them rather than a zero.

-- ===== 1. The capability vocabulary =====
-- private: this is a definition registry, not tenant data and not operator-editable content.
-- A role referencing an undefined capability would be a typo that denies silently forever -- the
-- foreign key below makes that impossible.
create table private.platform_capability_definitions (
  capability       text primary key
                   check (capability ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  description      text not null check (length(btrim(description)) >= 10),
  sensitivity      text not null check (sensitivity in ('read', 'write', 'high')),
  requires_step_up boolean not null default false,
  enforced_since   text,
  created_at       timestamptz not null default now()
);
revoke all on table private.platform_capability_definitions
  from public, anon, authenticated, service_role;

comment on table private.platform_capability_definitions is
  'The vocabulary of platform-operator capabilities. enforced_since names the migration that '
  'actually checks it; NULL means declared for a later wave and enforced nowhere yet (0151).';

-- `requires_step_up` is documentation of intent, read by the wave that wires each command. It is
-- NOT an enforcement mechanism: step-up is asserted by calling
-- assert_recent_password_authentication() (0061:51) inside the command itself, which is the one
-- mechanism this project has for it. A flag in a registry cannot make a function re-authenticate.
insert into private.platform_capability_definitions
  (capability, description, sensitivity, requires_step_up, enforced_since)
values
  ('customer.view',        'Read the cross-tenant customer list and a customer''s detail page.', 'read',  false, '0151'),
  ('usage.view',           'Read a customer''s measured product usage against plan limits.',     'read',  false, null),
  ('billing.view',         'Read a customer''s subscription and billing state.',                 'read',  false, null),
  ('notes.view',           'Read internal customer-operations notes and support interactions.',  'read',  false, null),
  ('incidents.view',       'Read organization-scoped operational incidents and failures.',       'read',  false, null),
  ('notes.add',            'Append an internal note or support interaction to a customer.',      'write', false, null),
  ('onboarding.edit',      'Record manual onboarding completion or a reasoned exception.',       'write', false, null),
  ('subscription.edit',    'Change a customer''s plan, interval or subscription status.',        'high',  true,  null),
  ('entitlement.override', 'Grant or revoke a per-customer entitlement override.',               'high',  true,  null),
  ('org.lifecycle',        'Suspend or reactivate a customer organization.',                     'high',  true,  null),
  ('offboarding.handle',   'Approve offboarding, build or reissue a tenant export.',             'high',  true,  null),
  ('platform.export',      'Export platform-level customer-operations data.',                    'high',  true,  null);

-- ===== 2. Roles and assignment =====
create table platform_roles (
  role_key    text primary key check (role_key ~ '^[a-z][a-z0-9_]*$'),
  label       text not null,
  description text not null check (length(btrim(description)) >= 10),
  created_at  timestamptz not null default now()
);

create table platform_role_capabilities (
  role_key   text not null references platform_roles(role_key) on delete cascade,
  capability text not null
             references private.platform_capability_definitions(capability) on delete restrict,
  primary key (role_key, capability)
);

create table platform_admin_roles (
  user_id      uuid not null references platform_admins(user_id) on delete cascade,
  role_key     text not null references platform_roles(role_key) on delete restrict,
  granted_at   timestamptz not null default now(),
  granted_note text,
  primary key (user_id, role_key)
);

alter table platform_roles             enable row level security;
alter table platform_role_capabilities enable row level security;
alter table platform_admin_roles       enable row level security;

-- Read-only through the API, to operators only. There is deliberately no INSERT/UPDATE/DELETE
-- policy and no DML grant, so a direct PostgREST write is refused twice over -- once by the
-- missing privilege, once by the missing policy.
revoke all on table platform_roles             from public, anon, authenticated;
revoke all on table platform_role_capabilities from public, anon, authenticated;
revoke all on table platform_admin_roles       from public, anon, authenticated;
grant select on table platform_roles             to authenticated;
grant select on table platform_role_capabilities to authenticated;
grant select on table platform_admin_roles       to authenticated;

create policy platform_roles_select on platform_roles
  for select to authenticated using (is_platform_admin());
create policy platform_role_capabilities_select on platform_role_capabilities
  for select to authenticated using (is_platform_admin());
-- An operator sees the whole assignment roster, not only their own row: who else holds which
-- role is part of operating the platform, and the roster itself is already visible through
-- platform_admins_select (0006:31).
create policy platform_admin_roles_select on platform_admin_roles
  for select to authenticated using (is_platform_admin());

comment on table platform_roles is
  'Named bundles of platform-operator capabilities (0151). Assignment is out-of-band only.';
comment on table platform_admin_roles is
  'Which platform operator holds which role. Written out-of-band; no API write path exists, by '
  'the same argument 0006:27-31 makes for platform_admins membership itself.';

insert into platform_roles (role_key, label, description) values
  ('super_admin',  'מנהל פלטפורמה ראשי', 'Every capability, including the high-impact ones.'),
  ('customer_ops', 'תפעול לקוחות',       'Day-to-day customer operations: state, onboarding, notes, lifecycle.'),
  ('support',      'תמיכה',              'Read a customer and record support interactions. No money, no lifecycle.'),
  ('billing',      'חיוב',               'Subscription, entitlement and usage. No lifecycle and no notes.'),
  ('analyst',      'ניתוח',              'Read-only across customers, usage and billing state, plus export.');

insert into platform_role_capabilities (role_key, capability)
select 'super_admin', capability from private.platform_capability_definitions;

insert into platform_role_capabilities (role_key, capability) values
  ('customer_ops', 'customer.view'),
  ('customer_ops', 'usage.view'),
  ('customer_ops', 'billing.view'),
  ('customer_ops', 'notes.view'),
  ('customer_ops', 'notes.add'),
  ('customer_ops', 'incidents.view'),
  ('customer_ops', 'onboarding.edit'),
  ('customer_ops', 'org.lifecycle'),
  ('customer_ops', 'offboarding.handle'),

  ('support',      'customer.view'),
  ('support',      'notes.view'),
  ('support',      'notes.add'),
  ('support',      'incidents.view'),

  ('billing',      'customer.view'),
  ('billing',      'usage.view'),
  ('billing',      'billing.view'),
  ('billing',      'subscription.edit'),
  ('billing',      'entitlement.override'),

  ('analyst',      'customer.view'),
  ('analyst',      'usage.view'),
  ('analyst',      'billing.view'),
  ('analyst',      'platform.export');

-- Backfill: every operator that exists at migration time keeps unrestricted authority. This is
-- the whole reason nothing breaks -- the new axis starts fully open and is narrowed per person,
-- deliberately, rather than starting closed and locking the operators out of their own console.
insert into platform_admin_roles (user_id, role_key, granted_note)
select user_id, 'super_admin', 'Backfilled by 0151: authority held before capabilities existed.'
from platform_admins
on conflict (user_id, role_key) do nothing;

-- ===== 3. The capability questions =====
-- Same shape and rationale as is_platform_admin() (0006:21-23): `security definer` so it can be
-- called from a policy or another definer without recursing into RLS, `stable` so the planner
-- evaluates it once per statement, pinned search_path against temp-schema shadowing.
--
-- Fail-closed by construction: an anonymous caller has a NULL auth.uid(), which matches no
-- assignment row; a signed-in tenant user is not in platform_admins; and an operator with no
-- role rows gets false for every capability rather than a default-allow.
create or replace function public.platform_has_capability(p_capability text) returns boolean
language sql stable security definer set search_path = public as $$
  select is_platform_admin() and exists (
    select 1
    from platform_admin_roles assignment
    join platform_role_capabilities granted on granted.role_key = assignment.role_key
    where assignment.user_id = auth.uid()
      and granted.capability = p_capability
  )
$$;
revoke all on function public.platform_has_capability(text) from public, anon;
grant execute on function public.platform_has_capability(text) to authenticated;

-- The console needs the whole set in one round trip: it renders an action only when the
-- capability is present, and must be able to tell "you may not do this" apart from "there is
-- nothing here" -- which a zero-row list read cannot express on its own.
create or replace function public.platform_my_capabilities() returns text[]
language sql stable security definer set search_path = public as $$
  select case when is_platform_admin() then coalesce((
    select array_agg(distinct granted.capability order by granted.capability)
    from platform_admin_roles assignment
    join platform_role_capabilities granted on granted.role_key = assignment.role_key
    where assignment.user_id = auth.uid()
  ), '{}'::text[]) else '{}'::text[] end
$$;
revoke all on function public.platform_my_capabilities() from public, anon;
grant execute on function public.platform_my_capabilities() to authenticated;

-- ===== 4. Last meaningful activity, and why it reads audit_logs =====
-- The obvious implementation is MAX(created_at) over purchase_orders, goods_receipts, invoices
-- and documents. It is rejected on two counts.
--
--   (a) Correctness of the question. Those columns answer "when was a row last CREATED", so a
--       tenant who spent the week approving invoices, receiving goods against existing orders and
--       reconciling bank lines reads as dormant. audit_logs records every mutation on the audited
--       financial tables (0001:441-449), which is the activity actually being asked about.
--
--   (b) Cost of the answer, in the A5 sense. All four of those tables are scope-ENFORCED
--       (0054:140-152), so a SECURITY DEFINER naming them without filtering on auth_scopes()
--       trips the A5 assertion and needs a row in private.scope_definer_exemptions. That registry
--       is already the reason multi-unit organizations stay blocked (DEBT-REGISTER §7), and
--       paying into it for a display column would be the wrong trade. audit_logs is classified
--       cross_scope/enforced=false (0054:155), so this read needs no exemption at all and the pin
--       in p9_five_domains.sql:331 does not move.
--
-- Operator actions are excluded: suspending a tenant writes to THAT tenant's audit log
-- (0134:186-193), so counting it would make every organization look active immediately after an
-- operator touched it -- the console reporting its own footprint back as customer engagement.
create index if not exists audit_logs_org_created_idx on audit_logs (org_id, created_at desc);
comment on index audit_logs_org_created_idx is
  'Serves the per-organization MAX(created_at) in platform_customers() as a backward index scan '
  '(0151). audit_logs_org_idx (0005:56) alone would read every row of the tenant to find one.';

-- ===== 5. The operator customer list =====
-- plpgsql rather than sql (platform_orgs()'s shape) for one reason: an unknown filter value must
-- fail loudly. In a pure-SQL predicate chain an unrecognised filter matches no branch and returns
-- an empty list, which reads as "this customer base is empty" -- a typo in a query string
-- silently becoming a business claim. Everything else keeps the 0006 contract: a caller who is
-- not an authorised operator gets zero rows, never an error, so the function is not an oracle for
-- who holds platform authority.
create or replace function public.platform_customers(
  p_search    text    default null,
  p_status    text[]  default null,
  p_attention text    default null,
  p_limit     integer default 25,
  p_offset    integer default 0
)
returns table (
  id                 uuid,
  name               text,
  status             org_status,
  vat_rate           numeric,
  created_at         timestamptz,
  active_user_count  bigint,
  last_activity_at   timestamptz,
  offboarding_status text,
  total_count        bigint
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_limit  integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  if p_attention is not null
     and p_attention not in ('offboarding', 'suspended', 'no_users', 'dormant') then
    raise exception 'platform_filter_unknown' using errcode = '22023';
  end if;
  if p_status is not null and exists (
    select 1 from unnest(p_status) requested
    where requested not in ('active', 'suspended', 'trial')
  ) then
    raise exception 'platform_filter_unknown' using errcode = '22023';
  end if;

  if not (is_platform_admin() and public.platform_has_capability('customer.view')) then
    return;
  end if;

  return query
  with base as (
    select
      org.id           as org_id,
      org.name         as org_name,
      org.status       as org_state,
      org.vat_rate     as org_vat_rate,
      org.created_at   as org_created_at,
      (select count(*) from profiles member
        where member.org_id = org.id and member.active) as org_active_user_count,
      (select max(entry.created_at) from audit_logs entry
        where entry.org_id = org.id
          and (entry.user_id is null or not exists (
                select 1 from platform_admins operator where operator.user_id = entry.user_id))
      ) as org_last_activity_at,
      (select request.status::text from organization_offboarding_requests request
        where request.org_id = org.id
        order by request.requested_at desc
        limit 1) as org_offboarding_status
    from organizations org
  ),
  filtered as (
    select candidate.* from base candidate
    where (v_search is null or candidate.org_name ilike '%' || v_search || '%')
      and (p_status is null or cardinality(p_status) = 0
           or candidate.org_state::text = any (p_status))
      and (
        p_attention is null
        or (p_attention = 'offboarding'
            and candidate.org_offboarding_status is not null
            and candidate.org_offboarding_status not in ('cancelled', 'reactivated'))
        or (p_attention = 'suspended' and candidate.org_state = 'suspended')
        or (p_attention = 'no_users'  and candidate.org_active_user_count = 0)
        or (p_attention = 'dormant'
            and (candidate.org_last_activity_at is null
                 or candidate.org_last_activity_at < now() - interval '30 days'))
      )
  )
  select page.org_id, page.org_name, page.org_state, page.org_vat_rate, page.org_created_at,
         page.org_active_user_count, page.org_last_activity_at, page.org_offboarding_status,
         count(*) over () as page_total_count
  from filtered page
  order by page.org_created_at desc
  limit v_limit offset v_offset;
end
$$;
revoke all on function public.platform_customers(text, text[], text, integer, integer)
  from public, anon;
grant execute on function public.platform_customers(text, text[], text, integer, integer)
  to authenticated;

comment on function public.platform_customers(text, text[], text, integer, integer) is
  'Operator customer list with server-side search, filter and paging (0151). Zero rows for a '
  'caller without customer.view, so it never reveals who holds platform authority. total_count '
  'is the filtered count before paging, returned per row to spare a second round trip.';

-- ===== 6. Registry duties (A1) =====
-- 'system' is the class platform_admins carries (0054:116-117): cross-tenant operator machinery,
-- not tenant business data, and therefore never scope-enforced. None of the three tables has an
-- org_id column, so A6 (private.tenant_export_registry, 0103:322) does not apply -- a tenant
-- export contains a tenant's rows, and an operator's role assignment is not one.
insert into private.scope_registry (table_name, scope_class, enforced) values
  ('platform_roles',             'system', false),
  ('platform_role_capabilities', 'system', false),
  ('platform_admin_roles',       'system', false);

-- ===== 7. Structural re-assertion (the 0058:207-218 idiom) =====
do $assert_0151$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0151 scope assertions failed:\n%', v_violations;
  end if;
end
$assert_0151$;

-- ===== 8. Anchors -- the claims this file makes, checked here rather than three hours into a gate =====
do $anchor_0151$
declare
  v_count integer;
begin
  select count(*) into v_count from platform_admins roster
  where not exists (
    select 1 from platform_admin_roles assignment where assignment.user_id = roster.user_id);
  if v_count > 0 then
    raise exception '0151: % platform admin(s) left without a role -- the backfill is the reason nothing breaks', v_count;
  end if;

  select count(*) into v_count from private.platform_capability_definitions definition
  where not exists (
    select 1 from platform_role_capabilities granted
    where granted.role_key = 'super_admin' and granted.capability = definition.capability);
  if v_count > 0 then
    raise exception '0151: super_admin is missing % capability definition(s)', v_count;
  end if;

  -- No JWT subject here, so both answers must be false. A definer that answered true during a
  -- migration would answer true for anon at runtime.
  if public.platform_has_capability('customer.view') then
    raise exception '0151: platform_has_capability answered true with no JWT subject -- it must fail closed';
  end if;
  if cardinality(public.platform_my_capabilities()) <> 0 then
    raise exception '0151: platform_my_capabilities returned capabilities with no JWT subject';
  end if;
end
$anchor_0151$;
