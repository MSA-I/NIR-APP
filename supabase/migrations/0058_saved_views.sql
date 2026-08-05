-- Saved table views -- schema only (wave 3, PLAN-03 §3.2; ADR-0007; OPEN-DECISIONS #80).
--
-- #80 deferred real saved views until the unit hierarchy existed, because the brief scopes
-- them by an OPTIONAL unit and demands an audit trail for edits of a shared view. The
-- hierarchy exists as of 0054-0057, so the schema lands now.
--
-- THE UI DOES NOT ADOPT THIS TABLE IN THIS WAVE. Column preferences stay on localStorage
-- per #80's declared temporary default; adoption is a future UI wave's work, after the
-- scope switcher exists. Nothing in src/** references this table yet -- by design.
--
-- Ownership model (documented defaults, not silent guesses):
--   * A view belongs to the user who saved it. Only the owner edits or deletes it -- shared
--     views are readable tenant-wide, never editable by other users in this wave. Cross-user
--     editing rights would be a new permission surface, which is a business decision.
--   * Any write that touches a SHARED view -- saving one, editing one, unsharing or
--     deleting one -- requires an explicit reason and writes an audit_logs row in the same
--     transaction (the #80 requirement). Private saves need no reason; the generic audit
--     trigger still records them.

create table saved_views (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  user_id    uuid not null,
  screen     text not null check (trim(screen) <> ''),
  -- Optional scope reference (never ownership -- the registry classifies this table
  -- cross_scope): a view saved "for branch X" names the unit it filters by; NULL is an
  -- org-wide view. The composite FK makes a cross-tenant unit pointer structurally
  -- impossible, same idiom as every 0055 column.
  unit_id    uuid,
  name       text not null check (trim(name) <> ''),
  payload    jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  shared     boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint saved_views_user_fk foreign key (org_id, user_id)
    references profiles (org_id, id) on delete cascade,
  constraint saved_views_unit_fk foreign key (org_id, unit_id)
    references org_units (org_id, id),
  -- One name per user per screen. Duplicate names on the same picker are an error the
  -- database should refuse, not a UI nicety.
  constraint saved_views_owner_screen_name_key unique (org_id, user_id, screen, name)
);
create index saved_views_org_screen_idx on saved_views (org_id, screen, shared);
create index saved_views_org_unit_idx on saved_views (org_id, unit_id);

create trigger saved_views_touch before update on saved_views
  for each row execute function set_updated_at();

-- Generic audit on every write (the table has org_id, so the 0009:175-195 structural
-- assertion stays quiet). The command-level audit row with the human reason is written by
-- the RPCs below for shared-view writes.
create trigger saved_views_audit
  after insert or update or delete on saved_views
  for each row execute function audit_row_change();

-- ===== ACL: read own + shared in tenant; writes only through the commands =====
-- Consistent with the all-tables contract in p1_financial_commands.sql:18-64 (an RLS read
-- policy exists <=> authenticated holds SELECT) and with p0_client_dml_acl.sql (service_role
-- keeps full CRUD through the Supabase default privileges; no browser DML grants).
alter table saved_views enable row level security;
create policy saved_views_select on saved_views for select to authenticated using (
  org_id = auth_org() and (user_id = auth.uid() or shared)
);
revoke all on table saved_views from public, anon, authenticated;
grant select on table saved_views to authenticated;

-- ===== Commands =====
-- Same idiom as grant_user_scope (0054): definer, explicit actor checks, reason validated,
-- audit in the same transaction. p_id NULL creates under a fresh id; a client-generated id
-- makes the save idempotent across retries (AGENT-BRIEF §5).
create or replace function save_saved_view(
  p_id uuid,
  p_screen text,
  p_name text,
  p_payload jsonb,
  p_shared boolean,
  p_unit_id uuid,
  p_reason text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_reason text := nullif(trim(p_reason), '');
  v_id uuid := coalesce(p_id, gen_random_uuid());
  v_existing saved_views;
  v_touches_shared boolean;
begin
  if v_org is null or v_actor is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if nullif(trim(p_screen), '') is null or nullif(trim(p_name), '') is null then
    raise exception 'saved_view_name_required' using errcode = '22023';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'saved_view_payload_invalid' using errcode = '22023';
  end if;
  if p_unit_id is not null then
    if not exists (
      select 1 from org_units u where u.id = p_unit_id and u.org_id = v_org
    ) then
      raise exception 'unit_unknown' using errcode = 'P0002';
    end if;
    -- A view pinned to a unit the caller cannot see would be dead on arrival.
    perform assert_unit_in_scope(p_unit_id);
  end if;

  select * into v_existing from saved_views v where v.id = v_id for update;
  if found then
    if v_existing.org_id <> v_org then
      -- Another tenant's id: answer exactly as if it does not exist.
      raise exception 'saved_view_unknown' using errcode = 'P0002';
    end if;
    if v_existing.user_id <> v_actor then
      raise exception 'saved_view_not_owner' using errcode = '42501';
    end if;
    v_touches_shared := v_existing.shared or coalesce(p_shared, false);
    if v_touches_shared and v_reason is null then
      raise exception 'saved_view_reason_required' using errcode = '22023';
    end if;
    update saved_views
       set screen = p_screen, name = p_name, payload = p_payload,
           shared = coalesce(p_shared, false), unit_id = p_unit_id,
           updated_at = now()
     where id = v_id;
  else
    v_touches_shared := coalesce(p_shared, false);
    if v_touches_shared and v_reason is null then
      raise exception 'saved_view_reason_required' using errcode = '22023';
    end if;
    insert into saved_views (id, org_id, user_id, screen, unit_id, name, payload, shared)
    values (v_id, v_org, v_actor, p_screen, p_unit_id, p_name, p_payload,
            coalesce(p_shared, false));
  end if;

  if v_touches_shared then
    insert into audit_logs (org_id, user_id, action, entity_type, entity_id, new_values, reason)
    values (
      v_org, v_actor, 'saved_view_saved', 'saved_views', v_id,
      jsonb_build_object(
        'screen', p_screen, 'name', p_name,
        'shared', coalesce(p_shared, false), 'unit_id', p_unit_id),
      v_reason
    );
  end if;
  return v_id;
end
$$;
revoke all on function save_saved_view(uuid, text, text, jsonb, boolean, uuid, text)
  from public, anon;
grant execute on function save_saved_view(uuid, text, text, jsonb, boolean, uuid, text)
  to authenticated;

create or replace function delete_saved_view(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_reason text := nullif(trim(p_reason), '');
  v_existing saved_views;
begin
  if v_org is null or v_actor is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  select * into v_existing from saved_views v where v.id = p_id for update;
  if not found or v_existing.org_id <> v_org then
    raise exception 'saved_view_unknown' using errcode = 'P0002';
  end if;
  if v_existing.user_id <> v_actor then
    raise exception 'saved_view_not_owner' using errcode = '42501';
  end if;
  if v_existing.shared and v_reason is null then
    raise exception 'saved_view_reason_required' using errcode = '22023';
  end if;

  delete from saved_views where id = p_id;

  if v_existing.shared then
    insert into audit_logs (org_id, user_id, action, entity_type, entity_id, old_values, reason)
    values (
      v_org, v_actor, 'saved_view_deleted', 'saved_views', p_id,
      jsonb_build_object(
        'screen', v_existing.screen, 'name', v_existing.name,
        'shared', v_existing.shared, 'unit_id', v_existing.unit_id),
      v_reason
    );
  end if;
end
$$;
revoke all on function delete_saved_view(uuid, text) from public, anon;
grant execute on function delete_saved_view(uuid, text) to authenticated;

-- ===== Registry + re-assertion =====
-- A new public table must be classified (A1). cross_scope: unit_id is a filter reference,
-- never ownership; enforcement (a rider) is not warranted for per-user preference rows
-- whose read policy already pins owner-or-shared.
insert into private.scope_registry (table_name, scope_class, enforced)
values ('saved_views', 'cross_scope', false);

-- demo_verify.sql is owned by the wave's schema agent and is NOT edited here; extending its
-- tenant-isolation section to saved_views is recorded as follow-up work for the next wave's
-- schema owner (this wave seeds no demo saved views, so there is nothing to verify yet).

-- Re-run the 0057 assertions after adding the table: proves the registry row above is
-- present and no rider/registry/definer contract regressed inside this migration.
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0058 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
