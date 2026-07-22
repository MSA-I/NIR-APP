-- In-app notifications + delivery state for the header bell and Web Push deduplication.
-- Every notification belongs to one tenant and one recipient. Browser clients may read and
-- mark only their own rows; creation and event-state maintenance are server-side only.

create table notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  user_id uuid not null references profiles(id) on delete cascade,
  event_code text not null,
  entity_key text not null,
  severity text not null check (severity in ('warning', 'critical')),
  title text not null,
  body text not null,
  target_url text not null,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (user_id, dedupe_key)
);

create index notifications_user_unread_idx
  on notifications (user_id, created_at desc)
  where read_at is null;
create index notifications_org_created_idx on notifications (org_id, created_at desc);

alter table notifications enable row level security;

create policy notifications_select_own on notifications for select
  using (org_id = auth_org() and user_id = auth.uid());
create policy notifications_mark_own_read on notifications for update
  using (org_id = auth_org() and user_id = auth.uid())
  with check (org_id = auth_org() and user_id = auth.uid());

-- RLS selects rows; column grants ensure a browser can change read_at and nothing else.
-- There is no browser insert/delete permission. send-push uses service_role and bypasses RLS.
revoke all on table notifications from anon, authenticated;
grant select on table notifications to authenticated;
grant update (read_at) on table notifications to authenticated;

-- One row tracks the current lifecycle of a standing condition. It lets a warning fire once,
-- fire again only when it escalates, and start a fresh cycle after the condition was resolved.
create table notification_event_states (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  event_code text not null,
  entity_key text not null,
  severity text not null check (severity in ('warning', 'critical')),
  cycle_id uuid not null default gen_random_uuid(),
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (org_id, event_code, entity_key)
);

create index notification_event_states_org_idx
  on notification_event_states (org_id, event_code, active);
alter table notification_event_states enable row level security;
-- Intentionally no policies: this is service-only delivery state.

-- Atomically claim one delivery per standing-condition lifecycle, plus one warning→critical
-- escalation. The row lock also prevents two simultaneous invoice triggers from creating two
-- cycles for the same duplicate condition.
create or replace function public.claim_notification_event(
  p_org_id uuid,
  p_event_code text,
  p_entity_key text,
  p_severity text
) returns text
language plpgsql security definer set search_path = public as $$
declare
  state notification_event_states%rowtype;
  next_cycle uuid := gen_random_uuid();
begin
  if p_severity not in ('warning', 'critical') then
    raise exception 'invalid notification severity';
  end if;

  insert into notification_event_states
    (org_id, event_code, entity_key, severity, cycle_id, active, updated_at)
  values
    (p_org_id, p_event_code, p_entity_key, p_severity, next_cycle, true, now())
  on conflict (org_id, event_code, entity_key) do nothing
  returning * into state;

  if found then
    return p_event_code || ':' || p_entity_key || ':' || next_cycle::text || ':' || p_severity;
  end if;

  select * into state
  from notification_event_states
  where org_id = p_org_id and event_code = p_event_code and entity_key = p_entity_key
  for update;

  if not state.active then
    next_cycle := gen_random_uuid();
    update notification_event_states
    set severity = p_severity, cycle_id = next_cycle, active = true, updated_at = now()
    where id = state.id;
    return p_event_code || ':' || p_entity_key || ':' || next_cycle::text || ':' || p_severity;
  end if;

  if state.severity = 'warning' and p_severity = 'critical' then
    update notification_event_states
    set severity = 'critical', updated_at = now()
    where id = state.id;
    return p_event_code || ':' || p_entity_key || ':' || state.cycle_id::text || ':critical';
  end if;

  return null;
end $$;

revoke all on function public.claim_notification_event(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_notification_event(uuid, text, text, text) to service_role;

-- Header bells update while the application is open. RLS still controls which row payloads
-- each authenticated socket may receive.
alter publication supabase_realtime add table notifications;

-- Replace the 0016 price trigger payload with an event key. Retries with the same key are
-- harmless because notifications(user_id, dedupe_key) is unique.
create or replace function private.notify_price_increase() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  cfg private.push_config%rowtype;
  rec record;
begin
  select * into cfg from private.push_config where id;
  if not found then return null; end if;

  for rec in
    select n.org_id, count(*)::int as cnt
    from new_rows n
    join old_rows o on o.id = n.id
    where n.current_price > o.current_price
    group by n.org_id
  loop
    perform net.http_post(
      url := cfg.edge_url,
      body := jsonb_build_object(
        'event', 'price_increase',
        'org_id', rec.org_id,
        'payload', jsonb_build_object('count', rec.cnt, 'event_key', gen_random_uuid()::text)),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', cfg.secret)
    );
  end loop;
  return null;
end $$;

-- Check the duplicate condition only when its identifying fields or soft-delete state change.
-- A false check closes the lifecycle; recreating the duplicate later starts a new cycle.
create or replace function private.notify_duplicate_invoice_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  cfg private.push_config%rowtype;
  duplicate_count int;
  normalized_key text;
  old_duplicate_count int;
  old_normalized_key text;
begin
  select * into cfg from private.push_config where id;
  if not found then return new; end if;

  normalized_key := new.supplier_id::text || ':' || lower(trim(new.invoice_number));
  select count(*)::int into duplicate_count
  from invoices
  where org_id = new.org_id
    and supplier_id = new.supplier_id
    and lower(trim(invoice_number)) = lower(trim(new.invoice_number))
    and deleted_at is null;

  perform net.http_post(
    url := cfg.edge_url,
    body := jsonb_build_object(
      'event', 'duplicate_invoice_check',
      'org_id', new.org_id,
      'payload', jsonb_build_object(
        'entity_key', normalized_key,
        'active', new.deleted_at is null and duplicate_count > 1,
        'count', duplicate_count)),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', cfg.secret)
  );

  -- When the identifying key changes, recompute the group the invoice left as well. Without
  -- this close signal, returning to that duplicate later would incorrectly look like the same
  -- still-active lifecycle and would never notify again.
  if tg_op = 'UPDATE' and (
    old.org_id is distinct from new.org_id
    or old.supplier_id is distinct from new.supplier_id
    or lower(trim(old.invoice_number)) is distinct from lower(trim(new.invoice_number))
  ) then
    old_normalized_key := old.supplier_id::text || ':' || lower(trim(old.invoice_number));
    select count(*)::int into old_duplicate_count
    from invoices
    where org_id = old.org_id
      and supplier_id = old.supplier_id
      and lower(trim(invoice_number)) = lower(trim(old.invoice_number))
      and deleted_at is null;

    perform net.http_post(
      url := cfg.edge_url,
      body := jsonb_build_object(
        'event', 'duplicate_invoice_check',
        'org_id', old.org_id,
        'payload', jsonb_build_object(
          'entity_key', old_normalized_key,
          'active', old_duplicate_count > 1,
          'count', old_duplicate_count)),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', cfg.secret)
    );
  end if;
  return new;
end $$;

create trigger invoices_push_duplicate_insert
  after insert on invoices
  for each row execute function private.notify_duplicate_invoice_check();

create trigger invoices_push_duplicate_update
  after update of supplier_id, invoice_number, deleted_at on invoices
  for each row execute function private.notify_duplicate_invoice_check();
