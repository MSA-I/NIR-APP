-- 0214 -- User administration for the platform console.
--
-- Two axes of "user" exist and they are not the same thing, so this file builds both and keeps
-- them apart end to end:
--
--   (a) TENANT users -- people inside a customer organization. Read across tenants with
--       `user.view`, changed with `user.access`. Every change is written to the tenant's OWN
--       audit_logs (so the customer can see what we did to their organization) AND to
--       platform_lifecycle_events (so we can read it back -- operators deliberately hold no
--       SELECT on audit_logs, 0006:160-162).
--
--   (b) PLATFORM operators -- our own staff. Managed with `operator.manage`, which only
--       `super_admin` holds.
--
-- ON REVERSING A STATED POSITION. 0006:27-31, 0151 and 0153 all say platform membership and role
-- assignment are out-of-band by design, with no API write path. Section 5 builds that write path,
-- on explicit owner instruction (28.08.2026). The stance is not abandoned, it is replaced by a
-- narrower one, and the narrowing is the point:
--   * a dedicated capability (`operator.manage`) held by one role;
--   * step-up re-authentication on every staff command, like every other 'high' capability;
--   * you may never change your own authority -- the escalation path a write door would
--     otherwise open;
--   * the last super_admin cannot be removed or demoted -- the lockout a write door would
--     otherwise open;
--   * an append-only event log the console reads back, so the roster has a history and not just
--     a current state.
--
-- WHAT THIS FILE DOES NOT BUILD: impersonation ("view as this user"). Owner decision, same date:
-- deferred to DEBT-REGISTER. It is recorded here because a later reader will look for it: the
-- capability vocabulary below has no `user.impersonate`, and that absence is deliberate rather
-- than forgotten.

-- ===== 1. Capabilities =====
insert into private.platform_capability_definitions
  (capability, description, sensitivity, requires_step_up, enforced_since)
values
  ('user.view',       'Read the cross-tenant user directory and one user''s detail.',      'read', false, '0214'),
  ('user.access',     'Change a tenant user''s role, or suspend and restore their access.', 'high', true,  '0214'),
  ('operator.manage', 'Add or remove a platform operator and change the roles they hold.',  'high', true,  '0214');

-- Who gets what, and the reasoning per role:
--   super_admin  -- everything, by its own definition (0151 anchor asserts this).
--   customer_ops -- day-to-day customer work already includes suspending an organization
--                   (`org.lifecycle`); suspending one user in it is strictly narrower.
--   support      -- read only. Support answers "why can't this person sign in", which needs the
--                   directory; changing the answer is an escalation to customer_ops.
--   analyst      -- read only, consistent with its other four capabilities.
--   billing      -- nothing. A billing operator has no business in a customer's user roster.
insert into platform_role_capabilities (role_key, capability) values
  ('super_admin',  'user.view'),
  ('super_admin',  'user.access'),
  ('super_admin',  'operator.manage'),
  ('customer_ops', 'user.view'),
  ('customer_ops', 'user.access'),
  ('support',      'user.view'),
  ('analyst',      'user.view');

-- ===== 2. The staff-axis event log =====
-- Why not platform_lifecycle_events (0152): that table's org_id is NOT NULL and carries the
-- organization write guard, because every row in it is something done TO a tenant. Granting one
-- of our own people a role is not done to a tenant, and there is no honest org_id to write.
-- Making that column nullable would weaken a guard that exists for tenant rows in order to store
-- a row that is not a tenant row. A separate, smaller table is the cheaper and safer answer.
create table platform_admin_events (
  id             uuid primary key default gen_random_uuid(),
  occurred_at    timestamptz not null default now(),
  actor          uuid references auth.users(id) on delete set null,
  subject        uuid references auth.users(id) on delete set null,
  action         text not null check (length(btrim(action)) > 0),
  old_values     jsonb,
  new_values     jsonb,
  reason         text not null check (length(btrim(reason)) > 0),
  correlation_id uuid
);
create index platform_admin_events_subject_idx on platform_admin_events (subject, occurred_at desc);
create index platform_admin_events_time_idx    on platform_admin_events (occurred_at desc);

alter table platform_admin_events enable row level security;
-- RLS on with zero policies denies every row to every non-superuser caller; the revoke says it
-- twice. The definer readers below are the only doors, and each asks for a capability first.
revoke all on table platform_admin_events from public, anon, authenticated;

comment on table platform_admin_events is
  'Append-only history of the platform operator roster (0214): who granted or revoked whose '
  'authority, when, and why. Separate from platform_lifecycle_events because a staff change has '
  'no organization to be filed against.';

create or replace function private.platform_admin_events_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  raise exception 'platform_admin_event_immutable' using errcode = '42501';
end
$$;
revoke all on function private.platform_admin_events_guard() from public, anon, authenticated;
create trigger zzz_platform_admin_events_guard
  before update or delete on platform_admin_events
  for each row execute function private.platform_admin_events_guard();

create or replace function private.record_platform_admin_event(
  p_actor   uuid,
  p_subject uuid,
  p_action  text,
  p_old     jsonb,
  p_new     jsonb,
  p_reason  text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  insert into platform_admin_events (actor, subject, action, old_values, new_values, reason, correlation_id)
  values (p_actor, p_subject, p_action, p_old, p_new, p_reason, public.request_correlation_id())
  returning id into v_id;
  return v_id;
end
$$;
revoke all on function private.record_platform_admin_event(uuid, uuid, text, jsonb, jsonb, text)
  from public, anon, authenticated;

-- ===== 3. The staff-command preamble =====
-- private.assert_platform_command (0152:241) cannot serve here: its fourth argument is an
-- organization that must exist, and a staff command has none. Same five questions otherwise,
-- plus the step-up every 'high' capability owes.
create or replace function private.assert_platform_staff_command(
  p_capability text,
  p_reason     text
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor  uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_actor is null or not public.is_platform_admin() then
    raise exception 'not_platform_admin' using errcode = '42501';
  end if;
  if not public.platform_has_capability(p_capability) then
    raise exception 'not_platform_capability' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  perform public.assert_recent_password_authentication();
  return v_reason;
end
$$;
revoke all on function private.assert_platform_staff_command(text, text)
  from public, anon, authenticated;

-- ===== 4. Reading tenant users across tenants =====
-- This publishes customer users' email addresses to our operators. That is the point of the
-- screen -- "why can this person not sign in" cannot be answered without the address the sign-in
-- uses -- and it is why the read sits behind its own capability rather than riding along with
-- customer.view: an operator may be trusted with a customer's commercial state and not with
-- their people's contact details.
--
-- auth.users stays unreadable from the browser (0153:4-7). These functions are the strict
-- projection an operator may see: identity, sign-in recency, and the tenant role.
create or replace function public.platform_users(
  p_search text    default null,
  p_org_id uuid    default null,
  p_status text    default null,
  p_role   text    default null,
  p_limit  integer default 25,
  p_offset integer default 0
)
returns table (
  id              uuid,
  org_id          uuid,
  org_name        text,
  org_status      org_status,
  full_name       text,
  email           text,
  role            user_role,
  active          boolean,
  created_at      timestamptz,
  last_sign_in_at timestamptz,
  is_operator     boolean,
  total_count     bigint
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_search text    := nullif(btrim(coalesce(p_search, '')), '');
  v_limit  integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  if p_status is not null and p_status not in ('active', 'suspended', 'never_signed_in') then
    raise exception 'platform_filter_unknown' using errcode = '22023';
  end if;
  if p_role is not null and p_role not in (
    select unnest(enum_range(null::user_role))::text
  ) then
    raise exception 'platform_filter_unknown' using errcode = '22023';
  end if;

  -- Zero rows, never an error, for a caller without the capability -- the 0006:152 read
  -- contract, so this is not an oracle for who holds platform authority.
  if not (is_platform_admin() and public.platform_has_capability('user.view')) then
    return;
  end if;

  return query
  with base as (
    select
      member.id                                  as member_id,
      member.org_id                              as member_org,
      org.name                                   as member_org_name,
      org.status                                 as member_org_status,
      member.full_name                           as member_name,
      account.email::text                        as member_email,
      member.role                                as member_role,
      member.active                              as member_active,
      member.created_at                          as member_created,
      account.last_sign_in_at                    as member_last_sign_in,
      exists (select 1 from platform_admins roster where roster.user_id = member.id)
                                                 as member_is_operator
    from profiles member
    join organizations org on org.id = member.org_id
    join auth.users account on account.id = member.id
    where (p_org_id is null or member.org_id = p_org_id)
      and (p_role is null or member.role::text = p_role)
      and (
        p_status is null
        or (p_status = 'active'          and member.active)
        or (p_status = 'suspended'       and not member.active)
        or (p_status = 'never_signed_in' and account.last_sign_in_at is null)
      )
      and (
        v_search is null
        or member.full_name ilike '%' || v_search || '%'
        or account.email ilike '%' || v_search || '%'
        or org.name ilike '%' || v_search || '%'
      )
  ), counted as (
    select count(*) as everything from base
  )
  select
    base.member_id, base.member_org, base.member_org_name, base.member_org_status,
    base.member_name, base.member_email, base.member_role, base.member_active,
    base.member_created, base.member_last_sign_in, base.member_is_operator,
    counted.everything
  from base cross join counted
  order by base.member_active desc, base.member_created desc, base.member_id
  limit v_limit offset v_offset;
end
$$;
revoke all on function public.platform_users(text, uuid, text, text, integer, integer)
  from public, anon;
grant execute on function public.platform_users(text, uuid, text, text, integer, integer)
  to authenticated;
comment on function public.platform_users(text, uuid, text, text, integer, integer) is
  'Cross-tenant user directory for the operator console (0214). Requires user.view; zero rows '
  'without it. total_count is the filtered count before paging, per row, to spare a round trip.';

create or replace function public.platform_user_detail(p_user_id uuid)
returns table (
  id              uuid,
  org_id          uuid,
  org_name        text,
  org_status      org_status,
  full_name       text,
  email           text,
  phone           text,
  role            user_role,
  active          boolean,
  supplier_id     uuid,
  created_at      timestamptz,
  last_sign_in_at timestamptz,
  email_confirmed boolean,
  is_operator     boolean,
  operator_roles  text[],
  org_owner_count bigint
)
language sql stable security definer set search_path = public as $$
  select
    member.id,
    member.org_id,
    org.name,
    org.status,
    member.full_name,
    account.email::text,
    member.phone,
    member.role,
    member.active,
    member.supplier_id,
    member.created_at,
    account.last_sign_in_at,
    account.email_confirmed_at is not null,
    exists (select 1 from platform_admins roster where roster.user_id = member.id),
    coalesce((
      select array_agg(assignment.role_key order by assignment.role_key)
      from platform_admin_roles assignment
      where assignment.user_id = member.id
    ), '{}'::text[]),
    (select count(*) from profiles peer
      where peer.org_id = member.org_id and peer.role = 'owner' and peer.active)
  from profiles member
  join organizations org on org.id = member.org_id
  join auth.users account on account.id = member.id
  where member.id = p_user_id
    and is_platform_admin()
    and public.platform_has_capability('user.view')
$$;
revoke all on function public.platform_user_detail(uuid) from public, anon;
grant execute on function public.platform_user_detail(uuid) to authenticated;
comment on function public.platform_user_detail(uuid) is
  'One tenant user, as the operator console shows them (0214). org_owner_count rides along '
  'because the screen must be able to say WHY the last active owner cannot be suspended.';

create or replace function public.platform_user_events(p_user_id uuid, p_limit integer default 50)
returns table (
  id          uuid,
  occurred_at timestamptz,
  actor_email text,
  action      text,
  old_values  jsonb,
  new_values  jsonb,
  reason      text
)
language sql stable security definer set search_path = public as $$
  select
    event.id, event.occurred_at, actor.email::text, event.action,
    event.old_values, event.new_values, event.reason
  from platform_lifecycle_events event
  left join auth.users actor on actor.id = event.actor
  where event.entity_type = 'profiles'
    and event.entity_id = p_user_id
    and is_platform_admin()
    and public.platform_has_capability('user.view')
  order by event.occurred_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
$$;
revoke all on function public.platform_user_events(uuid, integer) from public, anon;
grant execute on function public.platform_user_events(uuid, integer) to authenticated;
comment on function public.platform_user_events(uuid, integer) is
  'What the platform did to one tenant user, read back from platform_lifecycle_events (0214). '
  'Not the tenant''s own audit trail -- operators hold no SELECT on audit_logs by design.';

-- ===== 5. Changing a tenant user's access, from outside their tenant =====
-- The write guard on profiles (0020:44-50) demands the actor be an OWNER OF THAT ORGANIZATION.
-- A platform operator is neither -- they may hold no tenant profile at all. Rather than weaken
-- the guard for everyone, this adds a second, named handshake beside the existing one, in the
-- shape 0152:262-264 already uses for the organization lifecycle writer: a transaction-local GUC
-- that only a definer command can set, checked together with is_platform_admin().
--
-- The rewrite is ANCHORED, not transcribed. Re-declaring the guard from 0020's text would
-- silently revert anything a later migration did to it. This reads the live body, asserts the
-- block it expects appears exactly once, and replaces that one occurrence.
do $rewrite_profiles_guard$
declare
  v_src         text;
  v_old         text;
  v_new         text;
  v_occurrences integer;
begin
  -- Carriage returns stripped on read, for the reason check:anchored-replacements exists: a body
  -- created on Windows carries CRLF, one created on a CI runner carries LF, and a multi-line
  -- anchor built with chr(10) would match in one and silently fail in the other. Written with
  -- chr(13) rather than e'\r' because a heredoc turns the escape into a real newline.
  select replace(p.prosrc, chr(13), '') into v_src
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'profiles_guard_privileged_columns'
    and p.pronargs = 0;
  if v_src is null then
    raise exception '0214: public.profiles_guard_privileged_columns() not found';
  end if;

  v_old :=
    'if current_setting(''app.profile_access_writer'', true) is distinct from v_actor::text' || chr(10) ||
    '       or auth_role() <> ''owner''' || chr(10) ||
    '       or old.org_id is distinct from auth_org() then';

  v_occurrences := (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old);
  if v_occurrences <> 1 then
    raise exception '0214: expected exactly 1 owner-handshake block in profiles_guard_privileged_columns, found %',
      v_occurrences;
  end if;

  -- Note the shape: the tenant-owner condition is untouched, and the platform escape is ANDed
  -- as a negation beside it. current_setting(..., true) returns NULL when unset, so the escape
  -- uses `is not distinct from` -- a plain `=` would evaluate to NULL and make the whole IF
  -- false, which is a guard that stops guarding.
  v_new :=
    'if (current_setting(''app.profile_access_writer'', true) is distinct from v_actor::text' || chr(10) ||
    '       or auth_role() <> ''owner''' || chr(10) ||
    '       or old.org_id is distinct from auth_org())' || chr(10) ||
    '       and not (current_setting(''app.platform_profile_access_writer'', true)' || chr(10) ||
    '                  is not distinct from v_actor::text' || chr(10) ||
    '                and public.is_platform_admin()) then';

  v_src := replace(v_src, v_old, v_new);

  execute format(
    'create or replace function public.profiles_guard_privileged_columns() returns trigger '
    'language plpgsql security definer set search_path = public as %L', v_src);
end
$rewrite_profiles_guard$;

create or replace function public.platform_set_user_access(
  p_user_id uuid,
  p_role    user_role,
  p_active  boolean,
  p_reason  text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor        uuid := auth.uid();
  v_target       profiles;
  v_reason       text;
  v_other_owners bigint;
begin
  if p_user_id is null or p_role is null or p_active is null then
    raise exception 'profile_access_invalid' using errcode = '22023';
  end if;

  select * into v_target from profiles where id = p_user_id for update;
  if not found then
    raise exception 'profile_unknown' using errcode = 'P0002';
  end if;

  -- Capability, reason and the tenant-write handshake, in the target's organization.
  v_reason := private.assert_platform_command(v_target.org_id, 'user.access', p_reason);
  -- 'user.access' is a step-up capability; assert_platform_command does not ask for freshness.
  perform public.assert_recent_password_authentication();

  if p_user_id = v_actor then
    raise exception 'self_access_change_forbidden' using errcode = '42501';
  end if;

  -- The retired personas (0127, 0133). The tenant path refuses to make a profile active on one
  -- of them; a console that did not would be a second door back into a persona the product
  -- closed -- and the more dangerous door, because it opens from outside the tenant.
  if p_active and p_role not in ('owner', 'office', 'accountant') then
    raise exception 'account_role_retired' using errcode = '42501';
  end if;

  -- The supplier role is inseparable from a supplier row in that tenant's catalogue
  -- (0061:260-267). Picking which supplier a person represents is a decision inside the
  -- customer's business, so this console refuses to make it in either direction rather than
  -- guessing and breaking the invariant.
  if p_role = 'supplier' or v_target.role = 'supplier' then
    raise exception 'supplier_role_change_out_of_scope' using errcode = '42501';
  end if;

  -- An organization with no active owner is an organization nobody can administer -- the exact
  -- lockout an operator is supposed to prevent, not cause.
  if v_target.role = 'owner' and v_target.active and (p_role <> 'owner' or not p_active) then
    select count(*) into v_other_owners
    from profiles peer
    where peer.org_id = v_target.org_id and peer.id <> v_target.id
      and peer.role = 'owner' and peer.active;
    if v_other_owners = 0 then
      raise exception 'last_owner_required' using errcode = '42501';
    end if;
  end if;

  if v_target.role = p_role and v_target.active = p_active then
    return jsonb_build_object('user_id', p_user_id, 'changed', false);
  end if;

  perform set_config('app.platform_profile_access_writer', v_actor::text, true);
  update profiles set role = p_role, active = p_active where id = v_target.id;
  -- Closed immediately, not merely at commit. `set_config(..., true)` lives for the whole
  -- transaction, and PostgREST wraps one request in one transaction -- so leaving it open would
  -- make every later statement in that request a second, unguarded write path into profiles.
  perform set_config('app.platform_profile_access_writer', '', true);

  -- Both logs, deliberately. The tenant's own trail so the customer can see what was done to
  -- their organization; the platform timeline so we can read it back without holding SELECT on
  -- audit_logs (0006:160-162).
  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_target.org_id, v_actor, 'profile_access_changed_by_platform', 'profiles', v_target.id,
    jsonb_build_object('role', v_target.role, 'active', v_target.active),
    jsonb_build_object('role', p_role, 'active', p_active),
    v_reason
  );

  perform private.record_platform_lifecycle_event(
    v_target.org_id, v_actor, 'user_access_set', 'profiles', v_target.id,
    jsonb_build_object('role', v_target.role, 'active', v_target.active),
    jsonb_build_object('role', p_role, 'active', p_active),
    v_reason);

  return jsonb_build_object('user_id', p_user_id, 'changed', true);
end
$$;
revoke all on function public.platform_set_user_access(uuid, user_role, boolean, text)
  from public, anon;
grant execute on function public.platform_set_user_access(uuid, user_role, boolean, text)
  to authenticated;
comment on function public.platform_set_user_access(uuid, user_role, boolean, text) is
  'Change a tenant user''s role or suspend them, from the platform console (0214). Requires '
  'user.access plus fresh password authentication. Refuses self-change, refuses the supplier '
  'role in either direction, and refuses to leave an organization without an active owner.';

-- ===== 6. The operator roster, with a write path =====
create or replace function public.platform_operator_events(p_limit integer default 100)
returns table (
  id            uuid,
  occurred_at   timestamptz,
  actor_email   text,
  subject_email text,
  action        text,
  old_values    jsonb,
  new_values    jsonb,
  reason        text
)
language sql stable security definer set search_path = public as $$
  select
    event.id, event.occurred_at, actor.email::text, subject.email::text, event.action,
    event.old_values, event.new_values, event.reason
  from platform_admin_events event
  left join auth.users actor   on actor.id = event.actor
  left join auth.users subject on subject.id = event.subject
  where is_platform_admin()
    and public.platform_has_capability('customer.view')
  order by event.occurred_at desc
  limit least(greatest(coalesce(p_limit, 100), 1), 200)
$$;
revoke all on function public.platform_operator_events(integer) from public, anon;
grant execute on function public.platform_operator_events(integer) to authenticated;
comment on function public.platform_operator_events(integer) is
  'History of the operator roster (0214). Readable by any operator -- who holds authority here '
  'is already visible through platform_admins_select (0006:31); the history of it should be too.';

create or replace function public.platform_add_operator(
  p_email    text,
  p_note     text,
  p_role_key text,
  p_reason   text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor   uuid := auth.uid();
  v_reason  text := private.assert_platform_staff_command('operator.manage', p_reason);
  v_email   text := nullif(btrim(lower(coalesce(p_email, ''))), '');
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_subject uuid;
begin
  if v_email is null or p_role_key is null then
    raise exception 'operator_invalid' using errcode = '22023';
  end if;
  if not exists (select 1 from platform_roles r where r.role_key = p_role_key) then
    raise exception 'platform_role_unknown' using errcode = 'P0002';
  end if;

  -- The account must already exist. This command grants authority to a person who has signed
  -- up; it does not create identities, which would put account creation behind an operator
  -- capability and give the console a second, weaker signup path.
  select account.id into v_subject
  from auth.users account where lower(account.email) = v_email;
  if v_subject is null then
    raise exception 'operator_account_unknown' using errcode = 'P0002';
  end if;
  if exists (select 1 from platform_admins roster where roster.user_id = v_subject) then
    raise exception 'operator_already_exists' using errcode = '23505';
  end if;

  insert into platform_admins (user_id, note) values (v_subject, v_note);
  insert into platform_admin_roles (user_id, role_key, granted_note)
  values (v_subject, p_role_key, v_note);

  perform private.record_platform_admin_event(
    v_actor, v_subject, 'operator_added', null,
    jsonb_build_object('email', v_email, 'roles', array[p_role_key], 'note', v_note),
    v_reason);

  return jsonb_build_object('user_id', v_subject);
end
$$;
revoke all on function public.platform_add_operator(text, text, text, text) from public, anon;
grant execute on function public.platform_add_operator(text, text, text, text) to authenticated;

create or replace function public.platform_remove_operator(
  p_user_id uuid,
  p_reason  text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor  uuid := auth.uid();
  v_reason text := private.assert_platform_staff_command('operator.manage', p_reason);
  v_email  text;
  v_roles  text[];
begin
  if p_user_id = v_actor then
    raise exception 'self_authority_change_forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from platform_admins roster where roster.user_id = p_user_id) then
    raise exception 'operator_unknown' using errcode = 'P0002';
  end if;

  select array_agg(assignment.role_key order by assignment.role_key) into v_roles
  from platform_admin_roles assignment where assignment.user_id = p_user_id;

  if 'super_admin' = any(coalesce(v_roles, '{}'::text[])) and (
    select count(*) from platform_admin_roles peer
    where peer.role_key = 'super_admin' and peer.user_id <> p_user_id
  ) = 0 then
    raise exception 'last_super_admin_required' using errcode = '42501';
  end if;

  select account.email::text into v_email from auth.users account where account.id = p_user_id;

  -- platform_admin_roles cascades on platform_admins delete (0151), so one delete is the whole
  -- revocation.
  delete from platform_admins where user_id = p_user_id;

  perform private.record_platform_admin_event(
    v_actor, p_user_id, 'operator_removed',
    jsonb_build_object('email', v_email, 'roles', coalesce(v_roles, '{}'::text[])),
    null, v_reason);

  return jsonb_build_object('user_id', p_user_id);
end
$$;
revoke all on function public.platform_remove_operator(uuid, text) from public, anon;
grant execute on function public.platform_remove_operator(uuid, text) to authenticated;

create or replace function public.platform_set_operator_roles(
  p_user_id   uuid,
  p_role_keys text[],
  p_reason    text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor  uuid := auth.uid();
  v_reason text := private.assert_platform_staff_command('operator.manage', p_reason);
  v_old    text[];
  v_new    text[] := coalesce(p_role_keys, '{}'::text[]);
begin
  if p_user_id = v_actor then
    raise exception 'self_authority_change_forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from platform_admins roster where roster.user_id = p_user_id) then
    raise exception 'operator_unknown' using errcode = 'P0002';
  end if;
  if cardinality(v_new) = 0 then
    -- An operator with no role holds no capability at all: a roster row that can see nothing.
    -- Removing the person is the honest expression of that, and it is a different command.
    raise exception 'operator_requires_role' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(v_new) requested
    where not exists (select 1 from platform_roles r where r.role_key = requested)
  ) then
    raise exception 'platform_role_unknown' using errcode = 'P0002';
  end if;

  select array_agg(assignment.role_key order by assignment.role_key) into v_old
  from platform_admin_roles assignment where assignment.user_id = p_user_id;
  v_old := coalesce(v_old, '{}'::text[]);

  if 'super_admin' = any(v_old) and not ('super_admin' = any(v_new)) and (
    select count(*) from platform_admin_roles peer
    where peer.role_key = 'super_admin' and peer.user_id <> p_user_id
  ) = 0 then
    raise exception 'last_super_admin_required' using errcode = '42501';
  end if;

  delete from platform_admin_roles where user_id = p_user_id and role_key <> all(v_new);
  insert into platform_admin_roles (user_id, role_key, granted_note)
  select p_user_id, requested, v_reason from unnest(v_new) requested
  on conflict (user_id, role_key) do nothing;

  perform private.record_platform_admin_event(
    v_actor, p_user_id, 'operator_roles_set',
    jsonb_build_object('roles', v_old), jsonb_build_object('roles', v_new), v_reason);

  return jsonb_build_object('user_id', p_user_id, 'roles', v_new);
end
$$;
revoke all on function public.platform_set_operator_roles(uuid, text[], text) from public, anon;
grant execute on function public.platform_set_operator_roles(uuid, text[], text) to authenticated;

-- ===== 7. The console's opening screen =====
-- Every number here answers "what should I look at first", per the constitution's §12 test. A
-- metric with no data returns NULL and the screen prints an em dash; zero is a claim about
-- reality and is only returned when it is one.
create or replace function public.platform_user_overview()
returns table (
  orgs_total              bigint,
  orgs_active             bigint,
  orgs_suspended          bigint,
  users_total             bigint,
  users_active            bigint,
  users_suspended         bigint,
  users_new_30d           bigint,
  users_never_signed_in   bigint,
  users_dormant_30d       bigint,
  orgs_without_owner      bigint,
  operators_total         bigint,
  operators_without_role  bigint
)
language sql stable security definer set search_path = public as $$
  select
    (select count(*) from organizations),
    (select count(*) from organizations where status = 'active'),
    (select count(*) from organizations where status = 'suspended'),
    (select count(*) from profiles),
    (select count(*) from profiles where active),
    (select count(*) from profiles where not active),
    (select count(*) from profiles where created_at >= now() - interval '30 days'),
    (select count(*) from profiles member
       join auth.users account on account.id = member.id
      where account.last_sign_in_at is null),
    (select count(*) from profiles member
       join auth.users account on account.id = member.id
      where account.last_sign_in_at < now() - interval '30 days'),
    (select count(*) from organizations org
      where not exists (
        select 1 from profiles member
        where member.org_id = org.id and member.role = 'owner' and member.active)),
    (select count(*) from platform_admins),
    (select count(*) from platform_admins roster
      where not exists (
        select 1 from platform_admin_roles assignment where assignment.user_id = roster.user_id))
  where is_platform_admin() and public.platform_has_capability('user.view')
$$;
revoke all on function public.platform_user_overview() from public, anon;
grant execute on function public.platform_user_overview() to authenticated;
comment on function public.platform_user_overview() is
  'The operator dashboard''s headline counts (0214). Zero rows without user.view, so the console '
  'can tell "you may not see this" apart from "everything is at zero".';

-- ===== 8. Registry duties (A1) =====
-- 'system': cross-tenant operator machinery, not tenant business data, never scope-enforced --
-- the class platform_admins and the 0151 tables carry. No org_id column, so A6 (the tenant
-- export contract, 0103:322) does not apply: a staff-authority change is not a tenant's row.
insert into private.scope_registry (table_name, scope_class, enforced) values
  ('platform_admin_events', 'system', false);

-- ===== 9. Structural re-assertion (the 0058:207-218 idiom) =====
do $assert_0214$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0214 scope assertions failed:\n%', v_violations;
  end if;
end
$assert_0214$;

-- ===== 10. Anchors -- the claims this file makes, checked here =====
do $anchor_0214$
declare
  v_count integer;
begin
  select count(*) into v_count
  from private.platform_capability_definitions definition
  where definition.capability in ('user.view', 'user.access', 'operator.manage')
    and not exists (
      select 1 from platform_role_capabilities granted
      where granted.role_key = 'super_admin' and granted.capability = definition.capability);
  if v_count > 0 then
    raise exception '0214: super_admin is missing % of the three new capabilities', v_count;
  end if;

  -- operator.manage is deliberately narrow: super_admin and nobody else.
  select count(*) into v_count
  from platform_role_capabilities
  where capability = 'operator.manage' and role_key <> 'super_admin';
  if v_count > 0 then
    raise exception '0214: operator.manage leaked to % non-super_admin role(s)', v_count;
  end if;

  -- The guard rewrite must be present in the LIVE body, not merely attempted.
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'profiles_guard_privileged_columns'
      and p.prosrc like '%app.platform_profile_access_writer%'
  ) then
    raise exception '0214: the profiles guard did not take the platform handshake';
  end if;

  -- No JWT subject here, so every new read door must be empty. A definer that answered during a
  -- migration would answer for anon at runtime.
  if exists (select 1 from public.platform_users()) then
    raise exception '0214: platform_users returned rows with no JWT subject';
  end if;
  if exists (select 1 from public.platform_user_overview()) then
    raise exception '0214: platform_user_overview returned rows with no JWT subject';
  end if;
  if exists (select 1 from public.platform_operator_events()) then
    raise exception '0214: platform_operator_events returned rows with no JWT subject';
  end if;
end
$anchor_0214$;
