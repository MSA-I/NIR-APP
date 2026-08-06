-- 0068 -- Notification preferences (wave 9, PLAN-10 §2; OPEN-DECISIONS #37/#39/#40).
--
-- THE LAW, before the mechanism: a preference FILTERS delivery. It never creates delivery,
-- and it never widens the audience. The audience is decided in exactly one place -- the
-- `eligible` CTE of public.enqueue_notification_delivery (0024:96-102) -- and this migration
-- NARROWS that CTE with a LEFT JOIN. The role list it tests is not touched. A preference row
-- for somebody outside the audience therefore changes nothing at all; a configuration surface
-- may tighten, never grant (ENTERPRISE-SECURITY-MODEL.md:246, by analogy with the flag law).
--
-- ABSENT ROW = TODAY'S BEHAVIOUR, BYTE FOR BYTE. The default is opt-IN: coalesce(..., true)
-- on both columns, so an installation that stores no preference delivers exactly what it
-- delivered before this migration ran. This is asserted in supabase/tests/p9_five_domains.sql
-- by running the command with and without preference rows and comparing the returned sets.
--
-- push_enabled = false removes Push and LEAVES the notification row. That is not a taste
-- call: the unread-badge contract of OPEN-DECISIONS #39 counts notification rows, so deleting
-- a row to silence a phone would silently break the bell. Muting Push means "do not buzz my
-- phone", never "hide this from me". Mechanically the row is inserted with push_sent_at
-- already set -- the Push leg is SETTLED at insert time rather than left pending. 0024:11-15
-- already uses the column with that meaning for pre-outbox rows. Without it, a muted row
-- would sit in notifications_push_pending_idx forever and be re-offered on every retry.
-- push_attempts = 0 beside a non-null push_sent_at is how "settled by preference" is told
-- apart from "delivered".
--
-- inapp_enabled = false is the one that removes the row -- and therefore Push with it,
-- because Push rides on the row (the row IS the durable outbox, 0024:1-9). There is no state
-- in which Push is delivered without a stored notification.
--
-- THE THREE MIRRORS of the audience line, corrected together in this wave:
--   1. this file / 0024:96-102          -- authoritative;
--   2. supabase/functions/send-push/index.ts:46  (ALERT_ROLES)  -- a Deno copy of the roles;
--   3. supabase/functions/send-push/index.ts:398 (the due-scan org discovery) -- a coarse
--      org filter, deliberately NOT preference-aware.
-- No new Edge Function and no fourth cron job: the delivery cycle
-- (claim_notification_event -> enqueue_notification_delivery ->
-- record_notification_push_result) is unchanged.

-- ===== 1. The event-code catalog =====
-- Schema `private`, like flag_definitions (0059:24): platform vocabulary, owned by no tenant,
-- no org_id -- and therefore NO scope_registry row, because A1 scans public base tables only
-- (the 0059:21-23 note). The browser never reads this table directly; it reaches the client
-- only through read_notification_preferences().
--
-- These three codes are the complete live set: every send-push event today is one of them.
-- Membership is VALIDATED by the write command, unlike org_flag_configurations.flag_key --
-- a preference is an enumerable UI surface, so a code nobody defined would be dead data that
-- the reader could never show. Adding an event code is a seed row here, not a client change.
create table private.notification_event_definitions (
  event_code  text primary key check (btrim(event_code) <> ''),
  description text not null
);
revoke all on table private.notification_event_definitions from public, anon, authenticated;

insert into private.notification_event_definitions (event_code, description) values
  ('price_increase',    'Supplier price moved upward (the 0017:120 catalog trigger)'),
  ('duplicate_invoice', 'Two records of one supplier carry the same number (0017:213-219)'),
  ('payment_due',       'A payment request is at or past its due date (the daily cron scan)');

-- ===== 2. The preference rows =====
-- Keyed (org_id, user_id, event_code) with a surrogate id, so audit_row_change has an
-- entity_id to record (0059:101 is the live declaration of that trigger).
create table notification_preferences (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  -- No single-column FK to profiles, on purpose: the saved_views shape (0058:35). A composite
  -- (org_id, user_id) FK against the 0021:178 unique key makes a cross-tenant member pointer
  -- structurally impossible AND keeps PostgREST seeing exactly one relationship -- a second,
  -- weaker single-column FK is precisely what 0024:21-52 removed everywhere and what
  -- p2_data_reliability.sql:188 keeps out. A preference still dies with its profile, through
  -- the same cascade.
  user_id       uuid not null,
  event_code    text not null check (btrim(event_code) <> ''),
  push_enabled  boolean not null default true,
  inapp_enabled boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint notification_preferences_user_event_key unique (org_id, user_id, event_code),
  -- The preflight arm notification_preference_cross_tenant verifies the constraint above
  -- anyway -- the house style for constraints that matter (p1_preflight.sql:244-248).
  constraint notification_preferences_user_fk foreign key (org_id, user_id)
    references profiles (org_id, id) on delete cascade
);

create trigger notification_preferences_touch before update on notification_preferences
  for each row execute function set_updated_at();

-- Shape-1 ACL, the all-tables contract (p1_financial_commands.sql:18-64): a permissive read
-- policy exists <=> authenticated holds SELECT, and there is no browser DML. A member reads
-- only their OWN preferences -- another member's notification settings are none of their
-- business, and no screen needs them.
alter table notification_preferences enable row level security;
create policy notification_preferences_select_own on notification_preferences
  for select to authenticated
  using (org_id = auth_org() and user_id = auth.uid());
revoke all on table notification_preferences from public, anon, authenticated;
grant select on table notification_preferences to authenticated;

create trigger notification_preferences_audit
  after insert or update or delete on notification_preferences
  for each row execute function audit_row_change();

-- ===== 3. The write command -- self only, systemic reason =====
-- SECURITY DEFINER because the table carries no browser DML grant. The body names no
-- enforced table, so A5 needs no exemption row (the registry stays at 59).
--
-- SELF ONLY: the row is written for auth.uid() inside auth_org(), and there is deliberately
-- no p_user_id parameter. An owner adjusting somebody else's notifications is a different
-- decision with a different audit story, and it is not in this wave.
--
-- SYSTEMIC REASON: there is no p_reason parameter either. Muting one's own phone is not a
-- business decision that needs a human justification, so the command supplies its own reason
-- string -- the audit trail stays complete without asking the user to explain themselves.
create or replace function set_notification_preference(
  p_event_code    text,
  p_push_enabled  boolean,
  p_inapp_enabled boolean
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_code text := nullif(btrim(coalesce(p_event_code, '')), '');
  v_id uuid;
  v_created boolean;
begin
  if v_org is null or v_user is null then
    raise exception 'notification_preference_not_authorized' using errcode = '42501';
  end if;
  if v_code is null or p_push_enabled is null or p_inapp_enabled is null then
    raise exception 'notification_preference_invalid' using errcode = '22023';
  end if;
  if not exists (
    select 1 from private.notification_event_definitions d where d.event_code = v_code
  ) then
    raise exception 'notification_event_unknown' using errcode = 'P0002';
  end if;

  -- Read the shape before writing it, rather than reading xmax afterwards: `created` is
  -- reported to the client, and a catalog trick is a poor thing to base a contract on.
  v_created := not exists (
    select 1
    from notification_preferences pref
    where pref.org_id = v_org and pref.user_id = v_user and pref.event_code = v_code
  );

  insert into notification_preferences (org_id, user_id, event_code, push_enabled, inapp_enabled)
  values (v_org, v_user, v_code, p_push_enabled, p_inapp_enabled)
  on conflict (org_id, user_id, event_code) do update
    set push_enabled = excluded.push_enabled,
        inapp_enabled = excluded.inapp_enabled
  returning id into v_id;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_org, v_user, 'notification_preference_set', 'notification_preferences', v_id,
    jsonb_build_object(
      'event_code', v_code,
      'push_enabled', p_push_enabled,
      'inapp_enabled', p_inapp_enabled),
    'notification preference set by the member for themselves'
  );

  return jsonb_build_object(
    'preference_id', v_id,
    'event_code', v_code,
    'push_enabled', p_push_enabled,
    'inapp_enabled', p_inapp_enabled,
    'created', v_created
  );
end
$$;

revoke all on function set_notification_preference(text, boolean, boolean)
  from public, anon;
grant execute on function set_notification_preference(text, boolean, boolean) to authenticated;

-- ===== 4. The read surface =====
-- Definer for the same reason resolve_feature_flags() is (0059:206): the catalog lives in
-- `private`. The body pins user_id = auth.uid() and org_id = auth_org(), so it can return
-- nobody else's rows -- the definer rights buy access to the vocabulary, not to other members.
--
-- One row per catalogued code, ALWAYS the full set: where the member stored nothing, both
-- flags come back true and configured is false. `configured` exists so the UI can say
-- "default" versus "you chose this" without inferring it from the booleans. It is display
-- information, never a permission.
create or replace function read_notification_preferences()
returns table (
  event_code    text,
  push_enabled  boolean,
  inapp_enabled boolean,
  configured    boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.event_code,
         coalesce(pref.push_enabled, true),
         coalesce(pref.inapp_enabled, true),
         pref.id is not null
  from private.notification_event_definitions d
  left join notification_preferences pref
    on pref.event_code = d.event_code
   and pref.org_id = auth_org()
   and pref.user_id = auth.uid()
  where auth_org() is not null and auth.uid() is not null
  order by d.event_code
$$;

revoke all on function read_notification_preferences() from public, anon;
grant execute on function read_notification_preferences() to authenticated;

-- ===== 5. The one authoritative audience line =====
-- Re-declared from the LIVE definition of 0024:54 (verified with pg_get_functiondef before
-- editing: the live body is that source, character for character). The ONLY change is inside
-- the `eligible` CTE and the insert's push_sent_at column -- the validation block, the
-- organization-status gate, the dedupe test, the ON CONFLICT clause and the second statement
-- that returns pending rows are untouched.
--
-- CREATE OR REPLACE preserves the ACL; 0024:257/260 revoked the browser roles and granted
-- service_role. Re-asserted below so the contract is visible here (the 0066:544 idiom).
create or replace function public.enqueue_notification_delivery(
  p_org_id uuid,
  p_event_code text,
  p_entity_key text,
  p_severity text,
  p_title text,
  p_body text,
  p_target_url text,
  p_dedupe_key text
) returns table (
  notification_id uuid,
  user_id uuid,
  notification_dedupe_key text,
  created boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_created_ids uuid[];
begin
  if p_org_id is null
     or nullif(trim(p_event_code), '') is null
     or nullif(trim(p_entity_key), '') is null
     or p_severity not in ('warning', 'critical')
     or nullif(trim(p_title), '') is null
     or nullif(trim(p_body), '') is null
     or nullif(trim(p_target_url), '') is null
     or left(p_target_url, 1) <> '/'
     or left(p_target_url, 2) = '//'
     or nullif(trim(p_dedupe_key), '') is null then
    raise exception 'notification_delivery_invalid' using errcode = '22023';
  end if;

  -- This duplicates the Edge eligibility check deliberately. The database remains the
  -- final authority even though the caller uses service_role and bypasses RLS.
  perform 1
  from organizations o
  where o.id = p_org_id and o.status in ('trial', 'active')
  for key share;
  if not found then return; end if;

  with eligible as (
    -- The audience: active members of the tenant holding a decision role. The LEFT JOIN can
    -- only REMOVE members from this set -- it adds no row and it does not touch the role
    -- test. An absent preference row means the historical behaviour exactly: both
    -- coalesce() defaults are true, so nothing is filtered.
    select p.id,
           coalesce(pref.push_enabled, true) as push_enabled
    from profiles p
    left join notification_preferences pref
      on pref.org_id = p.org_id
     and pref.user_id = p.id
     and pref.event_code = trim(p_event_code)
    where p.org_id = p_org_id
      and p.active
      and p.role in ('owner', 'office')
      -- Muting the in-app row removes the record itself, and Push with it.
      and coalesce(pref.inapp_enabled, true)
  ), inserted as (
    insert into notifications (
      org_id, user_id, event_code, entity_key, severity,
      title, body, target_url, dedupe_key, push_sent_at
    )
    select
      p_org_id, e.id, trim(p_event_code), trim(p_entity_key), p_severity,
      trim(p_title), trim(p_body), trim(p_target_url), trim(p_dedupe_key),
      -- Muted Push is SETTLED, not pending: the row belongs in the bell, and no retry may
      -- ever offer it to the provider again.
      case when e.push_enabled then null else now() end
    from eligible e
    where not exists (
      select 1
      from notifications existing
      where existing.user_id = e.id
        and existing.dedupe_key in (
          trim(p_dedupe_key),
          trim(p_dedupe_key) || ':' || e.id::text
        )
    )
    on conflict on constraint notifications_user_id_dedupe_key_key do nothing
    returning id
  )
  select coalesce(array_agg(i.id), '{}'::uuid[])
    into v_created_ids
  from inserted i;

  -- Use a second statement so newly inserted rows are visible to the query snapshot.
  return query
  select n.id, n.user_id, n.dedupe_key, n.id = any(v_created_ids)
  from notifications n
  where n.org_id = p_org_id
    and n.event_code = trim(p_event_code)
    and n.entity_key = trim(p_entity_key)
    and n.dedupe_key in (
      trim(p_dedupe_key),
      trim(p_dedupe_key) || ':' || n.user_id::text
    )
    and n.push_sent_at is null
  order by n.user_id;
end
$$;

revoke all on function public.enqueue_notification_delivery(
  uuid, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.enqueue_notification_delivery(
  uuid, text, text, text, text, text, text, text
) to service_role;

-- ===== 6. Registry (A1) + re-assert (the 0058:207-218 idiom, literal 0068) =====
-- org_global: a notification preference belongs to a member of the tenant, never to a branch
-- or a warehouse -- the same classification push_subscriptions carries (0054:127).
insert into private.scope_registry (table_name, scope_class, enforced)
values ('notification_preferences', 'org_global', false);

do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0068 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
