-- Wave 2 of Customer Operations (owner decision 19.08.2026) -- the customer record itself: who
-- we deal with, what was said internally, and what the platform did to them and when.
--
-- Shape: four tables, all carrying org_id but none of them tenant data. RLS is enabled and there
-- is deliberately NO policy and NO grant to `authenticated` on any of them -- the only way in is
-- the SECURITY DEFINER commands below, each of which proves a capability first. That is the
-- mechanism the brief asks for when it says a tenant user must never read internal
-- customer-management data: it is a privilege boundary, not a hidden screen.
--
-- Why a separate account table instead of columns on `organizations`: `organizations` is read by
-- every tenant member through org_select. An `internal_owner` column there would publish which of
-- our people is assigned to the account, to the account.
--
-- The platform timeline is a NEW table rather than a read of `audit_logs`, and that is forced,
-- not stylistic. 0006:160-162 deliberately withholds SELECT on audit_logs from platform
-- operators, because those rows carry the full old/new JSONB of every financial table for every
-- tenant; 0020:194-196 then removed the browser INSERT as well. So the operator can neither read
-- the tenant ledger nor should. Commands keep writing their audit row to the TARGET tenant's
-- audit_logs exactly as before -- that record does not move -- and additionally record a
-- platform-scoped event here, which is the half an operator is allowed to read back.
--
-- Writes reach a suspended or offboarding customer on purpose. Every org_id table carries
-- zz_organization_write_guard (0092:177-199), which refuses writes once the tenant is not in a
-- writable access mode. These tables keep that trigger -- coverage stays whole -- and the
-- commands instead use the existing handshake the offboarding commands already use
-- (0103:2570): a definer that has proven is_platform_admin() sets
-- `app.organization_lifecycle_writer` to its own auth.uid(), which is exactly the exception the
-- guard was written to allow. No new mechanism, and no table quietly opted out of the guard --
-- the point of customer operations is that a suspended customer is when a note matters most.
--
-- What this deliberately does not cover: no usage, no plan, no subscription, no health and no
-- onboarding state -- waves 3-5 own those, and the detail read below returns nothing for them
-- rather than a zero. No business-table counts either: suppliers, orders, invoices and documents
-- are scope-enforced (0054:140-152), and reading them from a definer would cost a
-- scope_definer_exemptions row (DEBT-REGISTER §7) for a number the operator does not yet act on.

-- ===== 1. One new capability, and the roles that carry it =====
-- 0151 seeded the vocabulary for the surfaces it could see. Editing the customer record is a
-- write that did not exist then; `enforced_since` records that it becomes real here.
insert into private.platform_capability_definitions
  (capability, description, sensitivity, requires_step_up, enforced_since)
values
  ('customer.edit', 'Edit the internal customer record: account owner, start date and contacts.',
   'write', false, '0152');

update private.platform_capability_definitions
   set enforced_since = '0152'
 where capability in ('notes.view', 'notes.add');

insert into platform_role_capabilities (role_key, capability) values
  ('super_admin',  'customer.edit'),
  ('customer_ops', 'customer.edit')
on conflict (role_key, capability) do nothing;

-- ===== 2. The customer record =====
create table customer_accounts (
  org_id         uuid primary key references organizations(id) on delete restrict,
  -- The person on OUR side who owns this relationship. auth.users rather than profiles: an
  -- operator need not be a member of any tenant (0006's whole point), so a profiles reference
  -- would be unfillable for exactly the people this column is about.
  internal_owner uuid references auth.users(id) on delete set null,
  customer_since date,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table customer_contacts (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete restrict,
  kind              text not null check (kind in ('primary', 'billing', 'technical')),
  name              text not null check (length(btrim(name)) > 0),
  title             text,
  email             text,
  phone             text,
  preferred_channel text check (preferred_channel is null
                                or preferred_channel in ('email', 'phone', 'whatsapp')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  -- A contact nobody can contact is not a contact; it is a name in a box.
  constraint customer_contacts_reachable check (
    coalesce(nullif(btrim(email), ''), nullif(btrim(phone), '')) is not null),
  -- The preferred channel has to be one we actually hold an address for.
  constraint customer_contacts_channel_reachable check (
    preferred_channel is null
    or (preferred_channel = 'email' and nullif(btrim(email), '') is not null)
    or (preferred_channel in ('phone', 'whatsapp') and nullif(btrim(phone), '') is not null))
);

-- One live contact per kind: "which billing contact do we email" must have exactly one answer.
create unique index customer_contacts_live_kind_idx
  on customer_contacts (org_id, kind) where deleted_at is null;
create index customer_contacts_org_idx on customer_contacts (org_id);

create table customer_internal_notes (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id) on delete restrict,
  kind             text not null check (kind in ('note', 'support', 'follow_up')),
  body             text not null check (length(btrim(body)) >= 2),
  author           uuid not null references auth.users(id) on delete restrict,
  follow_up_due_at timestamptz,
  resolved_at      timestamptz,
  resolved_by      uuid references auth.users(id) on delete restrict,
  resolution       text,
  created_at       timestamptz not null default now(),
  -- A follow-up is a promise with a date on it; the other two kinds are statements.
  constraint customer_internal_notes_follow_up_shape check (
    (kind = 'follow_up') = (follow_up_due_at is not null)),
  constraint customer_internal_notes_resolution_shape check (
    (resolved_at is null) = (resolved_by is null)),
  constraint customer_internal_notes_resolution_kind check (
    resolved_at is null or kind = 'follow_up')
);
create index customer_internal_notes_org_idx on customer_internal_notes (org_id, created_at desc);
create index customer_internal_notes_open_follow_up_idx
  on customer_internal_notes (org_id, follow_up_due_at)
  where kind = 'follow_up' and resolved_at is null;

create table platform_lifecycle_events (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete restrict,
  occurred_at    timestamptz not null default now(),
  actor          uuid references auth.users(id) on delete set null,
  action         text not null check (length(btrim(action)) > 0),
  entity_type    text not null check (length(btrim(entity_type)) > 0),
  entity_id      uuid,
  old_values     jsonb,
  new_values     jsonb,
  reason         text not null check (length(btrim(reason)) > 0),
  correlation_id uuid
);
create index platform_lifecycle_events_org_idx
  on platform_lifecycle_events (org_id, occurred_at desc);

alter table customer_accounts         enable row level security;
alter table customer_contacts         enable row level security;
alter table customer_internal_notes   enable row level security;
alter table platform_lifecycle_events enable row level security;

-- No policy on any of the four, by design: RLS on with zero policies denies every row to every
-- non-superuser caller, and the grants below make the point twice. The definer commands are the
-- only doors, and each one asks for a capability before it opens.
revoke all on table customer_accounts         from public, anon, authenticated;
revoke all on table customer_contacts         from public, anon, authenticated;
revoke all on table customer_internal_notes   from public, anon, authenticated;
revoke all on table platform_lifecycle_events from public, anon, authenticated;

comment on table customer_accounts is
  'Internal customer-operations record, one row per organization (0152). Never tenant-readable: '
  'internal_owner names one of OUR people and must not be published to the account.';
comment on table customer_internal_notes is
  'Append-only internal notes, support interactions and follow-ups (0152). The body is never '
  'rewritten; only a follow-up''s resolution stamp may transition once, enforced by trigger.';
comment on table platform_lifecycle_events is
  'The platform-scoped timeline an operator may read back (0152). It exists because platform '
  'admins deliberately hold no SELECT on audit_logs (0006:160-162); commands write BOTH.';

-- The write guard every org_id table carries (0092:177-199). Kept, not skipped: the commands
-- below hold the documented exception instead.
create trigger zz_organization_write_guard before insert or update or delete on public.customer_accounts
  for each row execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard before insert or update or delete on public.customer_contacts
  for each row execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard before insert or update or delete on public.customer_internal_notes
  for each row execute function private.organization_row_write_guard();
create trigger zz_organization_write_guard before insert or update or delete on public.platform_lifecycle_events
  for each row execute function private.organization_row_write_guard();

-- ===== 3. Immutability =====
-- "Append-only" as a privilege fact is already true (no grants, no policy). These triggers make
-- it true against the definer commands as well, so a later command cannot quietly rewrite a note
-- body or a recorded event. A trigger is the mechanism because RLS WITH CHECK cannot see OLD.
create or replace function private.customer_internal_notes_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'internal_note_immutable' using errcode = '42501';
  end if;
  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.kind is distinct from old.kind
     or new.body is distinct from old.body
     or new.author is distinct from old.author
     or new.follow_up_due_at is distinct from old.follow_up_due_at
     or new.created_at is distinct from old.created_at then
    raise exception 'internal_note_immutable' using errcode = '42501';
  end if;
  -- Resolution is a one-way transition. Re-opening a closed follow-up is a new note, not an edit
  -- of the old one, so the record of "this was closed, by whom, saying what" cannot be erased.
  if old.resolved_at is not null then
    raise exception 'internal_note_already_resolved' using errcode = '42501';
  end if;
  return new;
end
$$;
revoke all on function private.customer_internal_notes_guard() from public, anon, authenticated;
create trigger zzz_customer_internal_notes_guard
  before update or delete on customer_internal_notes
  for each row execute function private.customer_internal_notes_guard();

create or replace function private.platform_lifecycle_events_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  raise exception 'platform_lifecycle_event_immutable' using errcode = '42501';
end
$$;
revoke all on function private.platform_lifecycle_events_guard() from public, anon, authenticated;
create trigger zzz_platform_lifecycle_events_guard
  before update or delete on platform_lifecycle_events
  for each row execute function private.platform_lifecycle_events_guard();

-- ===== 4. The recorder every platform command calls =====
create or replace function private.record_platform_lifecycle_event(
  p_org_id      uuid,
  p_actor       uuid,
  p_action      text,
  p_entity_type text,
  p_entity_id   uuid,
  p_old         jsonb,
  p_new         jsonb,
  p_reason      text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  insert into platform_lifecycle_events (
    org_id, actor, action, entity_type, entity_id, old_values, new_values, reason, correlation_id
  ) values (
    p_org_id, p_actor, p_action, p_entity_type, p_entity_id, p_old, p_new, p_reason,
    public.request_correlation_id()
  ) returning id into v_id;
  return v_id;
end
$$;
revoke all on function private.record_platform_lifecycle_event(
  uuid, uuid, text, text, uuid, jsonb, jsonb, text) from public, anon, authenticated;

-- The preamble every command below repeats: prove membership, prove the capability, demand a
-- reason, prove the target exists, and take the documented write-guard exception.
create or replace function private.assert_platform_command(
  p_org_id uuid, p_capability text, p_reason text
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
  if p_org_id is null or not exists (select 1 from organizations org where org.id = p_org_id) then
    raise exception 'organization_unknown' using errcode = 'P0002';
  end if;
  -- The 0103:2570 handshake: a proven operator writing to a tenant that may not be in a writable
  -- access mode. Transaction-local, so it cannot leak past this command.
  perform set_config('app.organization_lifecycle_writer', v_actor::text, true);
  return v_reason;
end
$$;
revoke all on function private.assert_platform_command(uuid, text, text)
  from public, anon, authenticated;

-- ===== 5. Commands =====
create or replace function public.platform_set_customer_account(
  p_org_id         uuid,
  p_internal_owner uuid,
  p_customer_since date,
  p_reason         text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor  uuid := auth.uid();
  v_reason text := private.assert_platform_command(p_org_id, 'customer.edit', p_reason);
  v_old    jsonb;
begin
  if p_internal_owner is not null
     and not exists (select 1 from auth.users account where account.id = p_internal_owner) then
    raise exception 'internal_owner_unknown' using errcode = 'P0002';
  end if;

  select to_jsonb(existing) into v_old
  from customer_accounts existing where existing.org_id = p_org_id for update;

  insert into customer_accounts (org_id, internal_owner, customer_since)
  values (p_org_id, p_internal_owner, p_customer_since)
  on conflict (org_id) do update
    set internal_owner = excluded.internal_owner,
        customer_since = excluded.customer_since,
        updated_at = now();

  perform private.record_platform_lifecycle_event(
    p_org_id, v_actor, 'customer_account_set', 'customer_accounts', p_org_id,
    v_old,
    jsonb_build_object('internal_owner', p_internal_owner, 'customer_since', p_customer_since),
    v_reason);

  return jsonb_build_object('org_id', p_org_id, 'created', v_old is null);
end
$$;
revoke all on function public.platform_set_customer_account(uuid, uuid, date, text)
  from public, anon;
grant execute on function public.platform_set_customer_account(uuid, uuid, date, text)
  to authenticated;

create or replace function public.platform_upsert_customer_contact(
  p_org_id            uuid,
  p_kind              text,
  p_name              text,
  p_title             text,
  p_email             text,
  p_phone             text,
  p_preferred_channel text,
  p_reason            text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor  uuid := auth.uid();
  v_reason text := private.assert_platform_command(p_org_id, 'customer.edit', p_reason);
  v_old    jsonb;
  v_id     uuid;
begin
  select to_jsonb(existing), existing.id into v_old, v_id
  from customer_contacts existing
  where existing.org_id = p_org_id and existing.kind = p_kind and existing.deleted_at is null
  for update;

  if v_id is null then
    insert into customer_contacts (org_id, kind, name, title, email, phone, preferred_channel)
    values (p_org_id, p_kind, p_name, nullif(btrim(coalesce(p_title, '')), ''),
            nullif(btrim(coalesce(p_email, '')), ''), nullif(btrim(coalesce(p_phone, '')), ''),
            p_preferred_channel)
    returning id into v_id;
  else
    update customer_contacts
       set name = p_name,
           title = nullif(btrim(coalesce(p_title, '')), ''),
           email = nullif(btrim(coalesce(p_email, '')), ''),
           phone = nullif(btrim(coalesce(p_phone, '')), ''),
           preferred_channel = p_preferred_channel,
           updated_at = now()
     where id = v_id;
  end if;

  perform private.record_platform_lifecycle_event(
    p_org_id, v_actor, 'customer_contact_set', 'customer_contacts', v_id,
    v_old,
    jsonb_build_object('kind', p_kind, 'name', p_name, 'preferred_channel', p_preferred_channel),
    v_reason);

  return jsonb_build_object('contact_id', v_id, 'created', v_old is null);
end
$$;
revoke all on function public.platform_upsert_customer_contact(
  uuid, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.platform_upsert_customer_contact(
  uuid, text, text, text, text, text, text, text) to authenticated;

create or replace function public.platform_remove_customer_contact(
  p_contact_id uuid, p_reason text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor   uuid := auth.uid();
  v_contact customer_contacts;
  v_reason  text;
begin
  select * into v_contact from customer_contacts where id = p_contact_id for update;
  if not found then
    raise exception 'customer_contact_unknown' using errcode = 'P0002';
  end if;
  v_reason := private.assert_platform_command(v_contact.org_id, 'customer.edit', p_reason);

  if v_contact.deleted_at is not null then
    return jsonb_build_object('contact_id', p_contact_id, 'idempotent', true);
  end if;

  -- Soft delete, like every other retired record in this project: the contact we used to write to
  -- is part of why an old note says what it says.
  update customer_contacts set deleted_at = now(), updated_at = now() where id = p_contact_id;

  perform private.record_platform_lifecycle_event(
    v_contact.org_id, v_actor, 'customer_contact_removed', 'customer_contacts', p_contact_id,
    to_jsonb(v_contact), null, v_reason);

  return jsonb_build_object('contact_id', p_contact_id, 'idempotent', false);
end
$$;
revoke all on function public.platform_remove_customer_contact(uuid, text) from public, anon;
grant execute on function public.platform_remove_customer_contact(uuid, text) to authenticated;

-- A note takes no separate reason: the body IS the reason, and demanding a second sentence to
-- justify writing the first is how "asdf" ends up in a ledger. The recorded event carries the
-- kind, and the note itself is readable beside it.
create or replace function public.platform_add_internal_note(
  p_org_id           uuid,
  p_kind             text,
  p_body             text,
  p_follow_up_due_at timestamptz
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_body  text := nullif(btrim(coalesce(p_body, '')), '');
  v_id    uuid;
begin
  if v_body is null then
    raise exception 'internal_note_body_required' using errcode = '22023';
  end if;
  perform private.assert_platform_command(p_org_id, 'notes.add', v_body);

  insert into customer_internal_notes (org_id, kind, body, author, follow_up_due_at)
  values (p_org_id, p_kind, v_body, v_actor, p_follow_up_due_at)
  returning id into v_id;

  perform private.record_platform_lifecycle_event(
    p_org_id, v_actor, 'customer_internal_note_added', 'customer_internal_notes', v_id,
    null, jsonb_build_object('kind', p_kind, 'has_follow_up', p_follow_up_due_at is not null),
    'internal note recorded');

  return jsonb_build_object('note_id', v_id);
end
$$;
revoke all on function public.platform_add_internal_note(uuid, text, text, timestamptz)
  from public, anon;
grant execute on function public.platform_add_internal_note(uuid, text, text, timestamptz)
  to authenticated;

create or replace function public.platform_resolve_follow_up(
  p_note_id uuid, p_resolution text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_note  customer_internal_notes;
  v_text  text := nullif(btrim(coalesce(p_resolution, '')), '');
begin
  select * into v_note from customer_internal_notes where id = p_note_id for update;
  if not found then
    raise exception 'internal_note_unknown' using errcode = 'P0002';
  end if;
  if v_note.kind <> 'follow_up' then
    raise exception 'internal_note_not_follow_up' using errcode = '22023';
  end if;
  if v_note.resolved_at is not null then
    raise exception 'internal_note_already_resolved' using errcode = '42501';
  end if;
  if v_text is null then
    raise exception 'internal_note_resolution_required' using errcode = '22023';
  end if;
  perform private.assert_platform_command(v_note.org_id, 'notes.add', v_text);

  update customer_internal_notes
     set resolved_at = now(), resolved_by = v_actor, resolution = v_text
   where id = p_note_id;

  perform private.record_platform_lifecycle_event(
    v_note.org_id, v_actor, 'customer_follow_up_resolved', 'customer_internal_notes', p_note_id,
    null, jsonb_build_object('resolution', v_text), v_text);

  return jsonb_build_object('note_id', p_note_id);
end
$$;
revoke all on function public.platform_resolve_follow_up(uuid, text) from public, anon;
grant execute on function public.platform_resolve_follow_up(uuid, text) to authenticated;

-- ===== 6. Reads =====
-- Every one keeps the 0006 contract: an unauthorised caller gets nothing back rather than an
-- error, so none of them is an oracle for who holds platform authority.
create or replace function public.platform_customer_detail(p_org_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_result jsonb;
begin
  if not (is_platform_admin() and public.platform_has_capability('customer.view')) then
    return null;
  end if;

  select jsonb_build_object(
    'org_id', org.id,
    'name', org.name,
    'status', org.status,
    'vat_rate', org.vat_rate,
    'created_at', org.created_at,
    'access_mode', private.organization_access_mode(org.id),
    'active_user_count', (select count(*) from profiles member
                           where member.org_id = org.id and member.active),
    'last_activity_at', (select max(entry.created_at) from audit_logs entry
                          where entry.org_id = org.id
                            and (entry.user_id is null or not exists (
                                  select 1 from platform_admins operator
                                  where operator.user_id = entry.user_id))),
    'internal_owner', account.internal_owner,
    'internal_owner_email', (select owner.email from auth.users owner
                              where owner.id = account.internal_owner),
    'customer_since', account.customer_since,
    'open_follow_up_count', (select count(*) from customer_internal_notes note
                              where note.org_id = org.id and note.kind = 'follow_up'
                                and note.resolved_at is null),
    'offboarding_status', (select request.status::text
                            from organization_offboarding_requests request
                            where request.org_id = org.id
                            order by request.requested_at desc limit 1)
  ) into v_result
  from organizations org
  left join customer_accounts account on account.org_id = org.id
  where org.id = p_org_id;

  return v_result;
end
$$;
revoke all on function public.platform_customer_detail(uuid) from public, anon;
grant execute on function public.platform_customer_detail(uuid) to authenticated;

create or replace function public.platform_customer_contacts(p_org_id uuid)
returns table (
  id uuid, kind text, name text, title text, email text, phone text,
  preferred_channel text, updated_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select contact.id, contact.kind, contact.name, contact.title, contact.email, contact.phone,
         contact.preferred_channel, contact.updated_at
  from customer_contacts contact
  where contact.org_id = p_org_id
    and contact.deleted_at is null
    and is_platform_admin()
    and public.platform_has_capability('customer.view')
  order by case contact.kind when 'primary' then 1 when 'billing' then 2 else 3 end
$$;
revoke all on function public.platform_customer_contacts(uuid) from public, anon;
grant execute on function public.platform_customer_contacts(uuid) to authenticated;

create or replace function public.platform_customer_notes(
  p_org_id uuid, p_limit integer default 50, p_offset integer default 0
)
returns table (
  id uuid, kind text, body text, author_email text, created_at timestamptz,
  follow_up_due_at timestamptz, resolved_at timestamptz, resolved_by_email text,
  resolution text, total_count bigint
)
language sql stable security definer set search_path = public as $$
  select note.id, note.kind, note.body,
         (select writer.email from auth.users writer where writer.id = note.author),
         note.created_at, note.follow_up_due_at, note.resolved_at,
         (select closer.email from auth.users closer where closer.id = note.resolved_by),
         note.resolution,
         count(*) over ()
  from customer_internal_notes note
  where note.org_id = p_org_id
    and is_platform_admin()
    and public.platform_has_capability('notes.view')
  -- Open follow-ups first: the reason to open this panel is usually a promise somebody made.
  order by (note.kind = 'follow_up' and note.resolved_at is null) desc,
           note.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0)
$$;
revoke all on function public.platform_customer_notes(uuid, integer, integer) from public, anon;
grant execute on function public.platform_customer_notes(uuid, integer, integer) to authenticated;

create or replace function public.platform_customer_timeline(
  p_org_id uuid, p_limit integer default 50, p_offset integer default 0
)
returns table (
  id uuid, occurred_at timestamptz, actor_email text, action text, entity_type text,
  entity_id uuid, old_values jsonb, new_values jsonb, reason text, correlation_id uuid,
  total_count bigint
)
language sql stable security definer set search_path = public as $$
  select event.id, event.occurred_at,
         (select operator.email from auth.users operator where operator.id = event.actor),
         event.action, event.entity_type, event.entity_id, event.old_values, event.new_values,
         event.reason, event.correlation_id,
         count(*) over ()
  from platform_lifecycle_events event
  where event.org_id = p_org_id
    and is_platform_admin()
    and public.platform_has_capability('customer.view')
  order by event.occurred_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0)
$$;
revoke all on function public.platform_customer_timeline(uuid, integer, integer)
  from public, anon;
grant execute on function public.platform_customer_timeline(uuid, integer, integer)
  to authenticated;

-- ===== 7. Registry duties (A1 + A6) =====
-- scope_class 'system': cross-tenant operator machinery that happens to reference an
-- organization, not tenant business data, and therefore never scope-enforced.
insert into private.scope_registry (table_name, scope_class, enforced) values
  ('customer_accounts',         'system', false),
  ('customer_contacts',         'system', false),
  ('customer_internal_notes',   'system', false),
  ('platform_lifecycle_events', 'system', false);

-- A6: these carry org_id, so the export contract must decide about them -- and the decision is
-- `exclude`, unanimously. A tenant export is the tenant's own records handed back on the way out.
-- Our internal notes about them, the name of the operator who owns the account, and the ledger of
-- administrative actions taken on them are OUR operational records, written for our eyes, and the
-- brief says explicitly they must not leave through a tenant-facing export.
insert into private.tenant_export_registry (table_name, disposition, excluded_columns, rationale)
values
  ('customer_accounts', 'exclude', '{}',
   'Internal customer-operations record; internal_owner names our own staff and is not tenant data.'),
  ('customer_contacts', 'exclude', '{}',
   'Internal customer-management contacts, distinct from tenant application users and not tenant data.'),
  ('customer_internal_notes', 'exclude', '{}',
   'Internal notes and support interactions written for platform operators, never customer-visible.'),
  ('platform_lifecycle_events', 'exclude', '{}',
   'Platform administrative action ledger; the tenant-facing record of the same acts is audit_logs.')
on conflict (table_name) do update
set disposition = excluded.disposition,
    excluded_columns = excluded.excluded_columns,
    rationale = excluded.rationale;

update private.tenant_export_registry registry
set exported_columns = case when registry.disposition = 'exclude' then '{}'::text[] else (
      select array_agg(column_info.column_name order by column_info.ordinal_position)
      from information_schema.columns column_info
      where column_info.table_schema = 'public' and column_info.table_name = registry.table_name
        and not (column_info.column_name = any(registry.excluded_columns))
    ) end,
    schema_hash = (
      select md5(string_agg(
        column_info.column_name || ':' || column_info.data_type || ':' || column_info.is_nullable,
        '|' order by column_info.ordinal_position))
      from information_schema.columns column_info
      where column_info.table_schema = 'public' and column_info.table_name = registry.table_name
    )
where registry.table_name in (
  'customer_accounts', 'customer_contacts', 'customer_internal_notes', 'platform_lifecycle_events');

-- ===== 8. Structural re-assertion =====
do $assert_0152$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0152 scope assertions failed:\n%', v_violations;
  end if;
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0152 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0152$;

-- ===== 9. Anchors =====
do $anchor_0152$
declare
  v_count integer;
begin
  select count(*) into v_count
  from private.platform_capability_definitions definition
  where not exists (
    select 1 from platform_role_capabilities granted
    where granted.role_key = 'super_admin' and granted.capability = definition.capability);
  if v_count > 0 then
    raise exception '0152: super_admin is missing % capability definition(s)', v_count;
  end if;

  select count(*) into v_count
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace space on space.oid = relation.relnamespace
  where space.nspname = 'public'
    and relation.relname in ('customer_accounts', 'customer_contacts',
                             'customer_internal_notes', 'platform_lifecycle_events')
    and not relation.relrowsecurity;
  if v_count > 0 then
    raise exception '0152: % customer-operations table(s) without RLS enabled', v_count;
  end if;

  select count(*) into v_count from pg_catalog.pg_policy policy
  join pg_catalog.pg_class relation on relation.oid = policy.polrelid
  where relation.relname in ('customer_accounts', 'customer_contacts',
                             'customer_internal_notes', 'platform_lifecycle_events');
  if v_count > 0 then
    raise exception '0152: % policy on a customer-operations table -- the definer commands are the only door', v_count;
  end if;

  select count(*) into v_count
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('customer_accounts', 'customer_contacts',
                       'customer_internal_notes', 'platform_lifecycle_events')
    and grantee in ('anon', 'authenticated');
  if v_count > 0 then
    raise exception '0152: % browser grant(s) on a customer-operations table', v_count;
  end if;

  -- The write guard is kept, not skipped; the commands hold the exception instead.
  select count(*) into v_count from pg_catalog.pg_trigger trg
  join pg_catalog.pg_class relation on relation.oid = trg.tgrelid
  where relation.relname in ('customer_accounts', 'customer_contacts',
                             'customer_internal_notes', 'platform_lifecycle_events')
    and trg.tgname = 'zz_organization_write_guard' and not trg.tgisinternal;
  if v_count <> 4 then
    raise exception '0152: expected 4 organization write guards, found %', v_count;
  end if;
end
$anchor_0152$;
