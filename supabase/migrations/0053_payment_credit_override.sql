-- Explicit approval override when a supplier has open credits.
-- Credits are never allocated, offset, closed or otherwise changed by this command.

alter table public.payment_requests
  add column open_credit_override_total numeric(12,2),
  add column open_credit_override_reason text,
  add column open_credit_override_at timestamptz,
  add constraint payment_requests_open_credit_override_complete check (
    num_nonnulls(
      open_credit_override_total,
      open_credit_override_reason,
      open_credit_override_at
    ) in (0, 3)
    and (
      open_credit_override_total is null
      or (
        open_credit_override_total > 0
        and nullif(trim(open_credit_override_reason), '') is not null
      )
    )
  ) not valid;

alter table public.payment_requests
  validate constraint payment_requests_open_credit_override_complete;

comment on column public.payment_requests.open_credit_override_total is
  'Open supplier-credit total observed by the trusted approval command; informational only.';
comment on column public.payment_requests.open_credit_override_reason is
  'Immutable approval-time reason for proceeding without automatically offsetting open credits.';
comment on column public.payment_requests.open_credit_override_at is
  'Timestamp of the explicit open-credit approval override.';

-- One private implementation owns every payment-request transition. The public ordinary
-- command passes no override context; the explicit command supplies all three bound values.
create or replace function public.p1_transition_payment_request(
  p_payment_request_id uuid,
  p_target_status text,
  p_transition_reason text,
  p_override_reason text,
  p_expected_supplier_id uuid,
  p_expected_open_credit_total numeric
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
  v_request public.payment_requests;
  v_target payment_request_status;
  v_transition_reason text := nullif(trim(p_transition_reason), '');
  v_override_reason text := nullif(trim(p_override_reason), '');
  v_open_credit_total numeric(12,2) := 0;
  v_approved_at timestamptz;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if (v_override_reason is null) is distinct from (p_expected_supplier_id is null)
     or (v_override_reason is null) is distinct from (p_expected_open_credit_total is null)
     or (v_override_reason is not null and p_expected_open_credit_total <= 0)
     or (v_override_reason is not null and p_target_status <> 'approved') then
    raise exception 'payment_request_credit_override_invalid' using errcode = '22023';
  end if;
  if p_payment_request_id is null or v_transition_reason is null
     or p_target_status not in ('pending_approval', 'approved', 'sent_for_execution', 'investigation', 'cancelled') then
    raise exception 'payment_request_transition_invalid' using errcode = '22023';
  end if;
  v_target := p_target_status::payment_request_status;

  select * into v_request
  from public.payment_requests
  where id = p_payment_request_id and org_id = v_org
  for update;

  if not found then
    raise exception 'payment_request_unknown' using errcode = 'P0002';
  end if;
  if p_expected_supplier_id is not null
     and p_expected_supplier_id is distinct from v_request.supplier_id then
    raise exception 'payment_request_credit_supplier_mismatch' using errcode = '22023';
  end if;

  if v_request.status = v_target then
    if v_override_reason is not null and not (
      v_request.open_credit_override_total is not null
      and round(v_request.open_credit_override_total, 2) = round(p_expected_open_credit_total, 2)
      and v_request.open_credit_override_reason = v_override_reason
      and v_request.open_credit_override_at is not null
    ) then
      raise exception 'payment_request_credit_override_replay_mismatch' using errcode = 'P0001';
    end if;
    return jsonb_build_object(
      'payment_request_id', v_request.id,
      'status', v_request.status,
      'open_credit_override', v_request.open_credit_override_total is not null,
      'idempotent', true
    );
  end if;

  if not (
       (v_request.status = 'draft' and v_target in ('pending_approval', 'investigation', 'cancelled'))
    or (v_request.status in ('pending_approval', 'suspected_duplicate', 'investigation')
        and v_target in ('approved', 'investigation', 'cancelled'))
    or (v_request.status = 'approved' and v_target in ('sent_for_execution', 'cancelled'))
    or (v_request.status = 'sent_for_execution' and v_target = 'cancelled')
  ) then
    raise exception 'payment_request_transition_invalid' using errcode = 'P0001';
  end if;

  if v_target = 'approved' then
    perform 1
    from public.invoices i
    join public.payment_request_invoices pri on pri.invoice_id = i.id
    where pri.payment_request_id = v_request.id
    order by i.id
    for update of i;

    if not exists (
      select 1
      from public.payment_request_invoices pri
      where pri.payment_request_id = v_request.id
    ) or exists (
      select 1
      from public.payment_request_invoices pri
      left join public.invoices i on i.id = pri.invoice_id
      where pri.payment_request_id = v_request.id
        and (
          i.id is null or i.org_id <> v_org or i.supplier_id <> v_request.supplier_id
          or i.deleted_at is not null or i.review_status <> 'approved'
          or round(pri.amount_allocated, 2) > round(
            i.total_amount
            - coalesce((select sum(pa.amount) from public.payment_allocations pa where pa.invoice_id = i.id), 0)
            - coalesce((select sum(cr.amount) from public.credit_requests cr
                        where cr.invoice_id = i.id and cr.status in ('offset', 'closed')), 0),
            2
          )
        )
    ) then
      raise exception 'payment_request_checks_failed' using errcode = 'P0001';
    end if;

    -- Serialize against changes to the currently relevant credits before deriving the total.
    perform 1
    from public.credit_requests cr
    where cr.org_id = v_org
      and cr.supplier_id = v_request.supplier_id
      and cr.status in ('open', 'requested', 'received')
    order by cr.id
    for update;

    select coalesce(sum(cr.amount), 0)::numeric(12,2)
      into v_open_credit_total
    from public.credit_requests cr
    where cr.org_id = v_org
      and cr.supplier_id = v_request.supplier_id
      and cr.status in ('open', 'requested', 'received');

    if v_open_credit_total > 0 then
      if v_override_reason is null then
        raise exception 'payment_request_credit_override_required' using errcode = 'P0001';
      end if;
      if round(v_open_credit_total, 2) <> round(p_expected_open_credit_total, 2) then
        raise exception 'payment_request_credit_total_changed' using errcode = 'P0001';
      end if;
    elsif v_override_reason is not null then
      raise exception 'payment_request_credit_override_not_required' using errcode = 'P0001';
    end if;
  end if;

  v_approved_at := case when v_target = 'approved' then clock_timestamp() end;
  perform set_config('app.p1_financial_writer', v_user::text, true);

  update public.payment_requests
  set status = v_target,
      approved_by = case when v_target = 'approved' then v_user else approved_by end,
      approved_at = case when v_target = 'approved' then v_approved_at else approved_at end,
      open_credit_override_total = case
        when v_target = 'approved' and v_open_credit_total > 0 then v_open_credit_total
        when v_target = 'approved' then null
        else open_credit_override_total
      end,
      open_credit_override_reason = case
        when v_target = 'approved' and v_open_credit_total > 0 then v_override_reason
        when v_target = 'approved' then null
        else open_credit_override_reason
      end,
      open_credit_override_at = case
        when v_target = 'approved' and v_open_credit_total > 0 then v_approved_at
        when v_target = 'approved' then null
        else open_credit_override_at
      end
  where id = v_request.id;

  if v_target = 'approved' and v_open_credit_total > 0 then
    insert into public.audit_logs (
      org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
    ) values (
      v_org, v_user, 'payment_request_transitioned',
      'payment_requests', v_request.id,
      jsonb_build_object('status', v_request.status),
      jsonb_build_object(
        'status', v_target,
        'open_credit_override', true,
        'approving_user_id', v_user,
        'organization_id', v_org,
        'supplier_id', v_request.supplier_id,
        'payment_request_id', v_request.id,
        'open_credit_total', v_open_credit_total,
        'payment_request_amount', v_request.amount,
        'override_reason', v_override_reason,
        'approved_at', v_approved_at
      ),
      v_override_reason
    );
  else
    insert into public.audit_logs (
      org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
    ) values (
      v_org, v_user, 'payment_request_transitioned', 'payment_requests', v_request.id,
      jsonb_build_object('status', v_request.status),
      jsonb_build_object('status', v_target),
      v_transition_reason
    );
  end if;

  return jsonb_build_object(
    'payment_request_id', v_request.id,
    'status', v_target,
    'open_credit_override', v_target = 'approved' and v_open_credit_total > 0,
    'open_credit_total', case when v_target = 'approved' then v_open_credit_total end,
    'idempotent', false
  );
end
$$;

revoke all on function public.p1_transition_payment_request(uuid, text, text, text, uuid, numeric)
  from public, anon, authenticated;

create or replace function public.transition_payment_request(
  p_payment_request_id uuid,
  p_target_status text,
  p_reason text
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.p1_transition_payment_request(
    p_payment_request_id,
    p_target_status,
    p_reason,
    null,
    null,
    null
  )
$$;

create or replace function public.approve_payment_request_with_credit_override(
  p_payment_request_id uuid,
  p_supplier_id uuid,
  p_expected_open_credit_total numeric,
  p_override_reason text
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.p1_transition_payment_request(
    p_payment_request_id,
    'approved',
    p_override_reason,
    p_override_reason,
    p_supplier_id,
    p_expected_open_credit_total
  )
$$;

revoke all on function public.transition_payment_request(uuid, text, text) from public, anon;
revoke all on function public.approve_payment_request_with_credit_override(uuid, uuid, numeric, text)
  from public, anon;
grant execute on function public.transition_payment_request(uuid, text, text) to authenticated;
grant execute on function public.approve_payment_request_with_credit_override(uuid, uuid, numeric, text)
  to authenticated;
