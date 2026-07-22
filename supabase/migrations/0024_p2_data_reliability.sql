-- P2 data reliability: atomic notification persistence, retryable Push delivery,
-- canonical credit transitions, and server-side aggregates for decision surfaces.

-- A notification row is the durable Push outbox. Provider failures leave it pending;
-- a retry with the same event key reuses the row instead of creating another one.
alter table notifications
  add column push_sent_at timestamptz,
  add column push_attempts integer not null default 0 check (push_attempts >= 0),
  add column push_last_error text;

-- Rows created before the durable outbox existed have no trustworthy provider outcome.
-- Treat them as completed rather than replaying historical alerts after this upgrade.
update notifications
set push_sent_at = created_at
where push_sent_at is null;

create index notifications_push_pending_idx
  on notifications (org_id, created_at)
  where push_sent_at is null;

-- P0 added and validated tenant-composite FKs alongside their legacy single-column FKs.
-- Keeping both makes PostgREST see two relationships for every embed and return HTTP 300.
-- The composite FK is strictly stronger, so remove only a legacy FK whose child/parent
-- columns are the non-org half of a matching P0 tenant FK.
do $$
declare
  legacy record;
begin
  for legacy in
    select distinct
      old_fk.conrelid::regclass as relation,
      old_fk.conname
    from pg_constraint old_fk
    join pg_constraint tenant_fk
      on tenant_fk.contype = 'f'
     and tenant_fk.conrelid = old_fk.conrelid
     and tenant_fk.confrelid = old_fk.confrelid
     and tenant_fk.conname like 'p0\_%\_tenant\_fk' escape '\'
     and cardinality(tenant_fk.conkey) = 2
     and cardinality(tenant_fk.confkey) = 2
     and old_fk.conkey[1] = tenant_fk.conkey[2]
     and old_fk.confkey[1] = tenant_fk.confkey[2]
    where old_fk.contype = 'f'
      and old_fk.connamespace = 'public'::regnamespace
      and old_fk.conname not like 'p0\_%' escape '\'
      and cardinality(old_fk.conkey) = 1
      and cardinality(old_fk.confkey) = 1
  loop
    execute format('alter table %s drop constraint %I', legacy.relation, legacy.conname);
  end loop;
end
$$;

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
    select p.id
    from profiles p
    where p.org_id = p_org_id
      and p.active
      and p.role in ('owner', 'office')
  ), inserted as (
    insert into notifications (
      org_id, user_id, event_code, entity_key, severity,
      title, body, target_url, dedupe_key
    )
    select
      p_org_id, e.id, trim(p_event_code), trim(p_entity_key), p_severity,
      trim(p_title), trim(p_body), trim(p_target_url), trim(p_dedupe_key)
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

create or replace function public.claim_notification_event_and_notify(
  p_org_id uuid,
  p_event_code text,
  p_entity_key text,
  p_severity text,
  p_title text,
  p_body text,
  p_target_url text
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
  v_dedupe_key text;
  v_state notification_event_states%rowtype;
begin
  if p_org_id is null
     or nullif(trim(p_event_code), '') is null
     or nullif(trim(p_entity_key), '') is null
     or p_severity not in ('warning', 'critical')
     or nullif(trim(p_title), '') is null
     or nullif(trim(p_body), '') is null
     or nullif(trim(p_target_url), '') is null
     or left(p_target_url, 1) <> '/'
     or left(p_target_url, 2) = '//' then
    raise exception 'notification_event_invalid' using errcode = '22023';
  end if;

  perform 1
  from organizations o
  where o.id = p_org_id and o.status in ('trial', 'active')
  for key share;
  if not found then return; end if;

  -- claim_notification_event and the notification insert below share this transaction.
  -- Any insert failure therefore rolls the state claim back as well.
  v_dedupe_key := public.claim_notification_event(
    p_org_id, trim(p_event_code), trim(p_entity_key), p_severity
  );

  -- A repeated invocation may be a Push retry. Reuse the current lifecycle key only when
  -- it is still active at the same severity; warning never reopens a critical lifecycle.
  if v_dedupe_key is null then
    select * into v_state
    from notification_event_states s
    where s.org_id = p_org_id
      and s.event_code = trim(p_event_code)
      and s.entity_key = trim(p_entity_key)
    for update;

    if found and v_state.active and v_state.severity = p_severity then
      v_dedupe_key := trim(p_event_code) || ':' || trim(p_entity_key) || ':'
        || v_state.cycle_id::text || ':' || p_severity;
    end if;
  end if;

  if v_dedupe_key is null then return; end if;

  return query
  select *
  from public.enqueue_notification_delivery(
    p_org_id,
    trim(p_event_code),
    trim(p_entity_key),
    p_severity,
    p_title,
    p_body,
    p_target_url,
    v_dedupe_key
  );
end
$$;

create or replace function public.record_notification_push_result(
  p_notification_id uuid,
  p_delivered boolean,
  p_error text default null
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_notification_id is null or p_delivered is null then
    raise exception 'notification_push_result_invalid' using errcode = '22023';
  end if;

  update notifications n
  set push_attempts = n.push_attempts + 1,
      push_sent_at = case
        when p_delivered then coalesce(n.push_sent_at, now())
        else n.push_sent_at
      end,
      push_last_error = case
        when p_delivered then null
        else left(coalesce(nullif(trim(p_error), ''), 'push_delivery_failed'), 500)
      end
  where n.id = p_notification_id;

  if not found then
    raise exception 'notification_unknown' using errcode = 'P0002';
  end if;
end
$$;

-- The old two-step claim is no longer a supported service boundary.
revoke execute on function public.claim_notification_event(uuid, text, text, text) from service_role;
revoke all on function public.enqueue_notification_delivery(uuid, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.claim_notification_event_and_notify(uuid, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.record_notification_push_result(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.enqueue_notification_delivery(uuid, text, text, text, text, text, text, text) to service_role;
grant execute on function public.claim_notification_event_and_notify(uuid, text, text, text, text, text, text) to service_role;
grant execute on function public.record_notification_push_result(uuid, boolean, text) to service_role;

-- P2's normal UI graph is open -> requested -> received -> offset -> closed. The RPC
-- also accepts open -> received when receipt was already documented. A received credit
-- is evidence from the supplier, not yet a financial offset, and cannot skip offset.
create or replace function public.transition_credit_request(
  p_credit_request_id uuid,
  p_status credit_status,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role user_role := auth_role();
  v_credit credit_requests;
  v_invoice_id uuid;
  v_reason text := nullif(trim(p_reason), '');
  v_allowed boolean := false;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office', 'kitchen') then
    raise exception 'credit_request_transition_not_authorized' using errcode = '42501';
  end if;
  if p_credit_request_id is null or p_status is null or v_reason is null then
    raise exception 'credit_request_transition_fields_required' using errcode = '22023';
  end if;

  select c.invoice_id into v_invoice_id
  from credit_requests c
  where c.id = p_credit_request_id and c.org_id = v_org;
  if not found then
    raise exception 'credit_request_unknown' using errcode = 'P0002';
  end if;

  -- Payment execution locks invoices before credits. Use the same order to avoid a cycle.
  if v_invoice_id is not null then
    perform 1
    from invoices i
    where i.id = v_invoice_id and i.org_id = v_org
    for update;
    if not found then
      raise exception 'credit_request_invoice_unknown' using errcode = 'P0002';
    end if;
  end if;

  select * into v_credit
  from credit_requests c
  where c.id = p_credit_request_id and c.org_id = v_org
  for update;
  if not found or v_credit.invoice_id is distinct from v_invoice_id then
    raise exception 'credit_request_concurrent_change' using errcode = '40001';
  end if;

  if v_credit.status = p_status then
    return jsonb_build_object(
      'credit_request_id', v_credit.id,
      'status', v_credit.status,
      'idempotent', true
    );
  end if;

  v_allowed :=
    (v_credit.status = 'open' and p_status in ('requested', 'received'))
    or (v_credit.status = 'requested' and p_status = 'received')
    or (v_credit.status = 'received' and p_status = 'offset')
    or (v_credit.status = 'offset' and p_status = 'closed');

  if not v_allowed then
    raise exception 'credit_request_transition_invalid' using errcode = 'P0001';
  end if;

  perform set_config('app.p1_financial_writer', v_user::text, true);

  update credit_requests
  set status = p_status,
      resolved_at = case when p_status in ('offset', 'closed') then now() else null end
  where id = v_credit.id;

  if v_invoice_id is not null
     and (v_credit.status in ('offset', 'closed') or p_status in ('offset', 'closed')) then
    perform p1_refresh_invoice_payment_statuses(v_org, array[v_invoice_id]);
  end if;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_user, 'credit_request_transitioned', 'credit_requests', v_credit.id,
    jsonb_build_object('status', v_credit.status),
    jsonb_build_object('status', p_status),
    v_reason
  );

  return jsonb_build_object(
    'credit_request_id', v_credit.id,
    'status', p_status,
    'idempotent', false
  );
end
$$;

revoke all on function public.transition_credit_request(uuid, credit_status, text) from public;
grant execute on function public.transition_credit_request(uuid, credit_status, text) to authenticated;

-- Small independent aggregates keep partial-failure reporting while avoiding unbounded
-- browser scans. SECURITY INVOKER preserves the caller's existing RLS visibility.
create or replace function public.p2_active_payment_request_total()
returns numeric
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select coalesce(sum(pr.amount), 0)::numeric
  from payment_requests pr
  where pr.org_id = auth_org()
    and pr.status in ('draft', 'pending_approval', 'approved', 'sent_for_execution')
$$;

create or replace function public.p2_suppliers_with_price_increase_since(p_since date)
returns bigint
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select count(distinct sp.supplier_id)
  from supplier_products sp
  where sp.org_id = auth_org()
    and sp.previous_price is not null
    and sp.current_price > sp.previous_price
    and sp.price_effective_date >= p_since
$$;

create or replace function public.p2_duplicate_invoice_group_count()
returns bigint
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select count(*)
  from (
    select i.supplier_id, lower(trim(i.invoice_number))
    from invoices i
    where i.org_id = auth_org() and i.deleted_at is null
    group by i.supplier_id, lower(trim(i.invoice_number))
    having count(*) > 1
  ) duplicate_groups
$$;

create or replace function public.p2_recent_price_increase_count(p_since date)
returns bigint
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select count(*)
  from supplier_products sp
  where sp.org_id = auth_org()
    and sp.previous_price is not null
    and sp.current_price > sp.previous_price
    and sp.price_effective_date >= p_since
$$;

create or replace function public.p2_above_average_offer_count(p_margin numeric)
returns bigint
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_count bigint;
begin
  if p_margin is null or p_margin < 0 or p_margin > 10 then
    raise exception 'p2_margin_invalid' using errcode = '22023';
  end if;

  select count(*) into v_count
  from (
    select
      sp.current_price,
      avg(sp.current_price) over (partition by sp.product_id) as product_average,
      count(*) over (partition by sp.product_id) as supplier_count
    from supplier_products sp
    where sp.org_id = auth_org() and sp.available
  ) offers
  where offers.supplier_count >= 2
    and offers.product_average > 0
    and offers.current_price > offers.product_average * (1 + p_margin);

  return v_count;
end
$$;

create or replace function public.p2_invoice_without_order_count()
returns bigint
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select count(*)
  from invoices i
  where i.org_id = auth_org()
    and i.deleted_at is null
    and not exists (
      select 1
      from invoice_order_links l
      where l.org_id = i.org_id and l.invoice_id = i.id
    )
$$;

create or replace function public.p2_payment_due_counts(p_today date, p_until date)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_total bigint;
  v_late bigint;
begin
  if p_today is null or p_until is null or p_until < p_today then
    raise exception 'p2_due_range_invalid' using errcode = '22023';
  end if;

  select count(*), count(*) filter (where pr.due_date < p_today)
    into v_total, v_late
  from payment_requests pr
  where pr.org_id = auth_org()
    and pr.due_date is not null
    and pr.due_date <= p_until
    and pr.status in ('draft', 'pending_approval', 'approved', 'sent_for_execution');

  return jsonb_build_object('total', v_total, 'late', v_late);
end
$$;

revoke all on function public.p2_active_payment_request_total() from public;
revoke all on function public.p2_suppliers_with_price_increase_since(date) from public;
revoke all on function public.p2_duplicate_invoice_group_count() from public;
revoke all on function public.p2_recent_price_increase_count(date) from public;
revoke all on function public.p2_above_average_offer_count(numeric) from public;
revoke all on function public.p2_invoice_without_order_count() from public;
revoke all on function public.p2_payment_due_counts(date, date) from public;
grant execute on function public.p2_active_payment_request_total() to authenticated;
grant execute on function public.p2_suppliers_with_price_increase_since(date) to authenticated;
grant execute on function public.p2_duplicate_invoice_group_count() to authenticated;
grant execute on function public.p2_recent_price_increase_count(date) to authenticated;
grant execute on function public.p2_above_average_offer_count(numeric) to authenticated;
grant execute on function public.p2_invoice_without_order_count() to authenticated;
grant execute on function public.p2_payment_due_counts(date, date) to authenticated;
