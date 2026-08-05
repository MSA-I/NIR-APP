-- Feature flags (wave 4, PLAN-04 §2.1; OPEN-DECISIONS #85-#86; SECURITY-MODEL §8).
--
-- The flag LAW comes before the mechanism: a flag only ever gates whether UI and a code
-- path are active. It never grants permission -- permission stays in RLS and in the RPC
-- role checks, flag-free, so a flag switched on by mistake cannot open a door. The
-- evaluator below is therefore granted to authenticated for READING, and is never
-- referenced from any policy USING/WITH CHECK or from any role check inside an RPC
-- (structurally asserted in supabase/tests/p4_flags_identity.sql).
--
-- Who writes what (OPEN-DECISIONS #86):
--   * global definitions      -- the platform operator, out-of-band (SQL console /
--                                service_role), exactly like platform_admins membership;
--   * per-organization config -- ONLY platform_set_org_flag (platform admin + reason +
--                                audit). No tenant-facing write path in this wave; a future
--                                owner-facing surface needs no schema change, only a new
--                                reasoned RPC.
-- organizations.settings was rejected as a flag store: it is browser-writable (0036:51)
-- and organizations carries no generic audit trigger (PLAN-04 §1.5).

-- ===== Global definitions =====
-- Schema `private`, like scope_registry (0054:97-101): platform vocabulary, owned by no
-- tenant, outside the all-tables browser-ACL contract scan. No org_id, hence no
-- scope_registry row -- A1 scans public base tables only.
create table private.flag_definitions (
  flag_key      text primary key check (trim(flag_key) <> ''),
  description   text not null,
  risk_level    text not null check (risk_level in ('low', 'medium', 'high')),
  default_state boolean not null default false,
  -- Kill semantics are "off only" (SECURITY-MODEL §8): a raised kill switch forces the
  -- flag OFF everywhere, regardless of any org configuration. There is deliberately no
  -- "force on" counterpart -- that would let a platform toggle expand behaviour.
  kill_switch   boolean not null default false
);
revoke all on table private.flag_definitions from public, anon, authenticated;

-- The two consumers this campaign already knows about. Both born OFF.
insert into private.flag_definitions (flag_key, description, risk_level, default_state, kill_switch) values
  ('sso.enabled',       'Organization SSO surfaces (wave 4+ consumer; SECURITY-MODEL §7)', 'high', false, false),
  ('receiving.barcode', 'Barcode-assisted goods receiving (wave 8 consumer)',              'low',  false, false);

-- ===== Per-organization configuration =====
-- Shape-1 (browser-readable): tenant members may SEE their configuration -- the resolver
-- is the normal read path, but hiding the raw rows would add nothing, and the table
-- carries no secrets. Writes are RPC-only.
create table org_flag_configurations (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  flag_key   text not null check (trim(flag_key) <> ''),
  state      boolean not null default false,
  -- Stored targeting, evaluated ONLY inside resolve_feature_flags() (PLAN-04 §2.1):
  --   unit_ids  uuid[] as jsonb -- caller's scopes must intersect
  --   percentage 0..100         -- deterministic per (flag, user) bucket
  --   starts_at / ends_at       -- ISO timestamps bounding the rollout window
  -- Unknown keys are ignored; malformed values fail CLOSED (flag off).
  targeting  jsonb not null default '{}'::jsonb check (jsonb_typeof(targeting) = 'object'),
  -- Optional unit focus, same composite-FK idiom as every 0055 scope column: a config row
  -- can never point at another tenant's unit, structurally. NULL = whole organization.
  -- The latch limitation (PLAN-04 §1.6) is declared: unit-focused rollout is storable and
  -- testable against the default chain (one unit of each type); real multi-branch
  -- rollout exercises belong to the multi-unit enablement wave.
  unit_id    uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint org_flag_configurations_unit_fk foreign key (org_id, unit_id)
    references org_units (org_id, id),
  -- No FK to private.flag_definitions ON PURPOSE: definitions live outside public and an
  -- orphaned config row must surface as a preflight anomaly
  -- (flag_config_without_definition), not as a broken cascade when a definition retires.
  constraint org_flag_configurations_flag_key_shape check (flag_key ~ '^[a-z0-9_.-]+$')
);
-- One org-wide row and one row per focused unit, per flag. Two partial indexes because a
-- plain UNIQUE treats NULL unit_id rows as always-distinct.
create unique index org_flag_configurations_org_key
  on org_flag_configurations (org_id, flag_key) where unit_id is null;
create unique index org_flag_configurations_org_key_unit
  on org_flag_configurations (org_id, flag_key, unit_id) where unit_id is not null;
create index org_flag_configurations_unit_idx on org_flag_configurations (org_id, unit_id);

create trigger org_flag_configurations_touch before update on org_flag_configurations
  for each row execute function set_updated_at();

-- Shape-1 ACL, consistent with the all-tables contract (p1_financial_commands.sql:18-64):
-- a permissive read policy exists <=> authenticated holds SELECT. No browser DML.
alter table org_flag_configurations enable row level security;
create policy org_flag_configurations_select on org_flag_configurations
  for select to authenticated using (org_id = auth_org());
revoke all on table org_flag_configurations from public, anon, authenticated;
grant select on table org_flag_configurations to authenticated;

-- ===== The generic audit trigger learns about platform operators =====
-- org_flag_configurations is written by platform_set_org_flag on behalf of an ARBITRARY
-- organization, by an operator who typically has no profile at all (auth_org() IS NULL) or
-- a profile in a different org. audit_row_change (0020:198) rejects exactly that shape
-- ('audit_source_org_mismatch'), because until now every JWT-authored write was tenant
-- work. The escape below mirrors the platform bypass that 0006 already established for
-- guard triggers (profiles_guard_privileged_columns, 0006:104) and the audit_platform_insert
-- policy (0006:159): a verified platform operator MAY author a row for another tenant, and
-- the audit row still records the target org and the operator's uid -- record, not reject.
-- Same signature, same oid, so the 0057 exemption row keyed on it stays valid; behaviour
-- for every tenant-authored write is byte-identical.
create or replace function audit_row_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_org uuid := nullif(v_row ->> 'org_id', '')::uuid;
  v_actor uuid := auth.uid();
begin
  if v_org is null then
    raise exception 'audit_source_missing_org: %', tg_table_name;
  end if;
  if v_actor is not null and v_org is distinct from auth_org()
     and not is_platform_admin() then
    raise exception 'audit_source_org_mismatch: %', tg_table_name using errcode = '42501';
  end if;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, old_values, new_values)
  values (
    v_org,
    v_actor,
    lower(tg_op),
    tg_table_name,
    nullif(v_row ->> 'id', '')::uuid,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );

  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

create trigger org_flag_configurations_audit
  after insert or update or delete on org_flag_configurations
  for each row execute function audit_row_change();

-- ===== Targeting evaluation =====
-- Internal, fail-closed: any malformed targeting value disables the row rather than
-- enabling it. Deterministic percentage bucket per (flag, user) so a user's experience is
-- stable across sessions.
create or replace function private.flag_targeting_matches(p_flag_key text, p_targeting jsonb)
returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  v_pct numeric;
begin
  if p_targeting is null or p_targeting = '{}'::jsonb then
    return true;
  end if;

  if p_targeting ? 'unit_ids' then
    if jsonb_typeof(p_targeting -> 'unit_ids') <> 'array' then
      return false;
    end if;
    if not exists (
      select 1
      from jsonb_array_elements_text(p_targeting -> 'unit_ids') t(unit_id)
      where t.unit_id ~ '^[0-9a-fA-F-]{36}$'
        and t.unit_id::uuid = any (public.auth_scopes())
    ) then
      return false;
    end if;
  end if;

  if p_targeting ? 'percentage' then
    if jsonb_typeof(p_targeting -> 'percentage') <> 'number' then
      return false;
    end if;
    v_pct := (p_targeting ->> 'percentage')::numeric;
    if v_pct < 0 or v_pct > 100 then
      return false;
    end if;
    if auth.uid() is null
       or abs(hashtext(p_flag_key || ':' || auth.uid()::text)) % 100 >= v_pct then
      return false;
    end if;
  end if;

  if p_targeting ? 'starts_at' then
    if (p_targeting ->> 'starts_at')::timestamptz > clock_timestamp() then
      return false;
    end if;
  end if;
  if p_targeting ? 'ends_at' then
    if (p_targeting ->> 'ends_at')::timestamptz < clock_timestamp() then
      return false;
    end if;
  end if;

  return true;
exception when others then
  -- Malformed timestamps/numbers land here: closed, never open.
  return false;
end
$$;
revoke all on function private.flag_targeting_matches(text, jsonb) from public, anon, authenticated;

-- ===== The single evaluator =====
-- Stable definer; the ONLY sanctioned flag read path for the app. Returns every defined
-- flag with its evaluated state for (auth.uid(), auth_org(), auth_scopes()) -- never a key
-- outside private.flag_definitions, so resolution cannot "expand" the flag surface.
-- Precedence per key: kill switch forces off > the most specific applicable config row
-- (a unit-focused row whose unit is inside the caller's scopes beats the org-wide row;
-- among several unit rows the newest wins) > the global default. A config row only
-- applies when its targeting matches; targeting failures fall THROUGH to off, not to the
-- next row -- an explicitly configured flag is the operator's answer, not a hint.
create or replace function resolve_feature_flags()
returns table (flag_key text, state boolean)
language sql stable security definer set search_path = public as $$
  select d.flag_key,
         case
           when d.kill_switch then false
           else coalesce(
             (select c.state and private.flag_targeting_matches(d.flag_key, c.targeting)
                from org_flag_configurations c
               where c.org_id = auth_org()
                 and c.flag_key = d.flag_key
                 and (c.unit_id is null or c.unit_id = any (public.auth_scopes()))
               order by (c.unit_id is not null) desc, c.updated_at desc, c.id
               limit 1),
             d.default_state)
         end
  from private.flag_definitions d
  order by d.flag_key
$$;
revoke all on function resolve_feature_flags() from public, anon;
grant execute on function resolve_feature_flags() to authenticated;

-- ===== The only write path =====
-- Platform operator + mandatory reason + audit in the same transaction, mirroring
-- set_organization_lifecycle (0020:152). Upserts the org-wide row or the unit-focused row
-- of (org, flag). Touches no enforced table -- no exemption registry entry needed (A5).
create or replace function platform_set_org_flag(
  p_org_id uuid,
  p_flag_key text,
  p_state boolean,
  p_targeting jsonb,
  p_unit_id uuid,
  p_reason text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid();
  v_reason text := nullif(trim(p_reason), '');
  v_targeting jsonb := coalesce(p_targeting, '{}'::jsonb);
  v_id uuid;
begin
  if v_actor is null or not is_platform_admin() then
    raise exception 'not_platform_admin' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'flag_reason_required' using errcode = '22023';
  end if;
  if p_org_id is null or p_state is null then
    raise exception 'flag_configuration_invalid' using errcode = '22023';
  end if;
  if jsonb_typeof(v_targeting) <> 'object' then
    raise exception 'flag_targeting_invalid' using errcode = '22023';
  end if;
  if not exists (select 1 from private.flag_definitions d where d.flag_key = p_flag_key) then
    raise exception 'flag_unknown' using errcode = 'P0002';
  end if;
  if not exists (select 1 from organizations o where o.id = p_org_id) then
    raise exception 'organization_unknown' using errcode = 'P0002';
  end if;
  if p_unit_id is not null and not exists (
    select 1 from org_units u where u.id = p_unit_id and u.org_id = p_org_id
  ) then
    raise exception 'unit_unknown' using errcode = 'P0002';
  end if;

  if p_unit_id is null then
    insert into org_flag_configurations (org_id, flag_key, state, targeting, unit_id)
    values (p_org_id, p_flag_key, p_state, v_targeting, null)
    on conflict (org_id, flag_key) where unit_id is null
    do update set state = excluded.state, targeting = excluded.targeting, updated_at = now()
    returning id into v_id;
  else
    insert into org_flag_configurations (org_id, flag_key, state, targeting, unit_id)
    values (p_org_id, p_flag_key, p_state, v_targeting, p_unit_id)
    on conflict (org_id, flag_key, unit_id) where unit_id is not null
    do update set state = excluded.state, targeting = excluded.targeting, updated_at = now()
    returning id into v_id;
  end if;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, new_values, reason)
  values (
    p_org_id, v_actor, 'org_flag_configured', 'org_flag_configurations', v_id,
    jsonb_build_object(
      'flag_key', p_flag_key, 'state', p_state,
      'targeting', v_targeting, 'unit_id', p_unit_id),
    v_reason
  );
  return v_id;
end
$$;
revoke all on function platform_set_org_flag(uuid, text, boolean, jsonb, uuid, text)
  from public, anon;
grant execute on function platform_set_org_flag(uuid, text, boolean, jsonb, uuid, text)
  to authenticated;

-- ===== Registry + re-assertion (wave-3 inherited duties, PLAN-04 §2.4) =====
-- cross_scope: unit_id is a rollout focus reference, never ownership; no rider (the read
-- policy already pins the tenant, and flag config is not row-scoped business data).
insert into private.scope_registry (table_name, scope_class, enforced)
values ('org_flag_configurations', 'cross_scope', false);

-- Re-run the 0057 assertions (the 0058:207-218 idiom): A1/A3/A5 are migration-time
-- snapshots, so every migration that adds a table or a definer must prove the contract
-- still holds -- a forgotten registry row fails HERE, not three hours into the gate.
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0059 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
