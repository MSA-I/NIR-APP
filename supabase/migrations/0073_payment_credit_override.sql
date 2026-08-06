-- 0073 -- Explicit payment approval override for supplier credits, scoped to one legal entity.
--
-- OPEN-DECISIONS #107 is fail-closed: payment requests belong to the one legal entity of
-- their linked invoices. credit_requests stays DERIVED (ADR-0004) and receives no unit_id;
-- an invoice credit inherits invoices.unit_id, while a receipt credit walks
-- receipt_item -> goods_receipt warehouse -> legal-entity ancestor. An active credit whose
-- legal entity cannot be proved blocks both this migration and approval-time evaluation.
--
-- No path in this migration allocates, offsets, closes or otherwise changes a credit, and no
-- path changes a payment-request amount. The approval-policy evaluator deliberately remains a
-- zero-consumer vocabulary function (0070 / OPEN-DECISIONS #104).

-- ===== 1. Legal-entity ownership and immutable override facts =====

alter table public.payment_requests
  add column unit_id uuid,
  add column open_credit_override_total numeric(12,2),
  add column open_credit_override_reason text,
  add column open_credit_override_at timestamptz,
  add constraint payment_requests_unit_fk
    foreign key (org_id, unit_id) references public.org_units (org_id, id) not valid,
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
        and nullif(btrim(open_credit_override_reason), '') is not null
      )
    )
  ) not valid;

create index payment_requests_org_unit_idx
  on public.payment_requests (org_id, unit_id);

-- Every pre-0073 request must resolve from all of its linked invoices to exactly one
-- legal_entity. No default unit is used: a default would guess when an organization grows a
-- second legal entity and would turn unknown ownership into an authorization decision.
with resolved as (
  select pr.id,
         min(i.unit_id::text)::uuid as unit_id
  from public.payment_requests pr
  join public.payment_request_invoices pri
    on pri.org_id = pr.org_id and pri.payment_request_id = pr.id
  left join public.invoices i
    on i.org_id = pr.org_id
   and i.id = pri.invoice_id
   and i.supplier_id = pr.supplier_id
   and i.deleted_at is null
  left join public.org_units u
    on u.org_id = pr.org_id
   and u.id = i.unit_id
   and u.unit_type = 'legal_entity'
  group by pr.id
  having count(*) > 0
     and count(u.id) = count(*)
     and count(distinct i.unit_id) = 1
)
update public.payment_requests pr
set unit_id = resolved.unit_id
from resolved
where resolved.id = pr.id;

do $$
declare
  v_unresolved bigint;
begin
  select count(*) into v_unresolved
  from public.payment_requests pr
  where pr.unit_id is null;

  if v_unresolved > 0 then
    raise exception
      '0073_payment_request_scope_unresolved: % payment requests require reviewed legal-entity attribution',
      v_unresolved
      using errcode = '23514';
  end if;
end
$$;

alter table public.payment_requests
  validate constraint payment_requests_unit_fk;
alter table public.payment_requests
  validate constraint payment_requests_open_credit_override_complete;

comment on column public.payment_requests.unit_id is
  'The single legal_entity shared by every linked invoice. Set only by create_payment_request.';
comment on column public.payment_requests.open_credit_override_total is
  'Open supplier-credit total in this legal entity observed by the trusted approval command; informational only.';
comment on column public.payment_requests.open_credit_override_reason is
  'Immutable approval-time reason for proceeding without automatically offsetting open credits.';
comment on column public.payment_requests.open_credit_override_at is
  'Timestamp of the explicit open-credit approval override.';

-- Derived-scope resolver. It is intentionally SECURITY INVOKER and ungranted: callers are
-- trusted definer commands or migration/test code. Making it a definer would either require
-- granting it a sibling-scope exemption or make A5's textual check look safer than its data
-- semantics. NULL is the only answer for a missing, ambiguous or supplier-mismatched anchor.
create or replace function private.credit_request_legal_entity(
  p_credit_request_id uuid,
  p_org_id uuid
)
returns uuid
language plpgsql
stable
security invoker
set search_path = public, private
as $$
declare
  v_credit public.credit_requests%rowtype;
  v_invoice_unit uuid;
  v_receipt_unit uuid;
  v_receipt_unit_count int;
begin
  select cr.* into v_credit
  from public.credit_requests cr
  where cr.id = p_credit_request_id and cr.org_id = p_org_id;

  if not found or (v_credit.invoice_id is null and v_credit.receipt_item_id is null) then
    return null;
  end if;

  if v_credit.invoice_id is not null then
    select i.unit_id into v_invoice_unit
    from public.invoices i
    join public.org_units u
      on u.org_id = i.org_id and u.id = i.unit_id and u.unit_type = 'legal_entity'
    where i.org_id = v_credit.org_id
      and i.id = v_credit.invoice_id
      and i.supplier_id = v_credit.supplier_id;

    if not found then
      return null;
    end if;
  end if;

  if v_credit.receipt_item_id is not null then
    with recursive lineage as (
      select u.id, u.parent_id, u.unit_type
      from public.goods_receipt_items gri
      join public.goods_receipts gr
        on gr.org_id = gri.org_id and gr.id = gri.receipt_id
      join public.purchase_orders po
        on po.org_id = gr.org_id and po.id = gr.order_id
      join public.org_units u
        on u.org_id = gr.org_id and u.id = gr.unit_id
      where gri.org_id = v_credit.org_id
        and gri.id = v_credit.receipt_item_id
        and po.supplier_id = v_credit.supplier_id
      union all
      select parent.id, parent.parent_id, parent.unit_type
      from lineage child
      join public.org_units parent
        on parent.org_id = v_credit.org_id and parent.id = child.parent_id
    )
    select count(*), min(l.id::text)::uuid
      into v_receipt_unit_count, v_receipt_unit
    from lineage l
    where l.unit_type = 'legal_entity';

    if v_receipt_unit_count <> 1 then
      return null;
    end if;
  end if;

  if v_invoice_unit is not null and v_receipt_unit is not null
     and v_invoice_unit is distinct from v_receipt_unit then
    return null;
  end if;

  return coalesce(v_invoice_unit, v_receipt_unit);
end
$$;

revoke all on function private.credit_request_legal_entity(uuid, uuid)
  from public, anon, authenticated;

-- OPEN-DECISIONS #107 migration gate: existing active credits must be attributable before
-- approval logic can be installed. Resolved/closed history is not an approval-time input.
do $$
declare
  v_unresolved bigint;
begin
  select count(*) into v_unresolved
  from public.credit_requests cr
  where cr.status in ('open', 'requested', 'received')
    and private.credit_request_legal_entity(cr.id, cr.org_id) is null;

  if v_unresolved > 0 then
    raise exception
      '0073_open_credit_scope_unresolved: % active credits require reviewed legal-entity attribution',
      v_unresolved
      using errcode = '23514';
  end if;
end
$$;

-- payment_requests now carries a real legal-entity pointer, so activate the same canonical
-- restrictive rider used by the six wave-3 tables. NULL remains in the canonical expression
-- for upgrade/fixture compatibility; every application command below rejects or avoids NULL.
do $$
declare
  v_updated int;
begin
  update private.scope_registry
  set enforced = true
  where table_name = 'payment_requests' and scope_class = 'legal_entity';
  get diagnostics v_updated = row_count;

  if v_updated <> 1 then
    raise exception '0073_payment_requests_scope_registry_missing' using errcode = '23514';
  end if;
end
$$;

create policy scope_rider_payment_requests
  on public.payment_requests
  as restrictive
  for all
  to public
  using ((unit_id is null) or (unit_id = any (auth_scopes())));

-- ===== 2. Creation binds a request to exactly one in-scope legal entity =====

-- Re-declared from the live 0023 body, with only the legal-entity contract added. The server
-- derives unit_id from the invoices, asserts the caller's scope and includes it in replay and
-- duplicate comparisons. The browser never chooses a request unit independently.
create or replace function public.create_payment_request(
  p_request_id uuid,
  p_supplier_id uuid,
  p_due_date date,
  p_notes text,
  p_requested_status text,
  p_allocations jsonb,
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
  v_request public.payment_requests;
  v_reason text := nullif(btrim(p_reason), '');
  v_notes text := nullif(btrim(p_notes), '');
  v_status payment_request_status;
  v_amount numeric;
  v_count int;
  v_distinct int;
  v_visible_count int;
  v_unit_count int;
  v_unit uuid;
  v_duplicate boolean;
  v_input jsonb;
  v_existing jsonb;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null or p_supplier_id is null or v_reason is null
     or p_requested_status not in ('draft', 'pending_approval') then
    raise exception 'payment_request_invalid' using errcode = '22023';
  end if;
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' then
    raise exception 'allocation_invalid' using errcode = '22023';
  end if;

  select count(*), count(distinct invoice_id), round(coalesce(sum(amount), 0), 2),
         coalesce(jsonb_agg(
           jsonb_build_object('invoice_id', invoice_id, 'amount', round(amount, 2))
           order by invoice_id
         ), '[]'::jsonb)
    into v_count, v_distinct, v_amount, v_input
  from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, amount numeric);

  if v_count = 0 or v_count <> v_distinct or v_amount <= 0 or exists (
    select 1
    from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, amount numeric)
    where invoice_id is null or amount is null or amount <= 0
  ) then
    raise exception 'allocation_invalid' using errcode = '22023';
  end if;

  -- Lock the exact invoice set before deriving its legal entity or checking balances.
  perform 1
  from public.invoices i
  join (
    select distinct invoice_id
    from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, amount numeric)
  ) input on input.invoice_id = i.id
  order by i.id
  for update of i;

  select count(u.id), count(distinct i.unit_id), min(i.unit_id::text)::uuid
    into v_visible_count, v_unit_count, v_unit
  from (
    select distinct invoice_id
    from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, amount numeric)
  ) input
  left join public.invoices i
    on i.id = input.invoice_id
   and i.org_id = v_org
   and i.supplier_id = p_supplier_id
   and i.deleted_at is null
  left join public.org_units u
    on u.org_id = v_org
   and u.id = i.unit_id
   and u.unit_type = 'legal_entity';

  if v_visible_count <> v_count or v_unit_count <> 1 or v_unit is null then
    raise exception 'payment_request_scope_invalid' using errcode = 'P0001';
  end if;
  perform public.assert_unit_in_scope(v_unit);

  select * into v_request
  from public.payment_requests
  where id = p_request_id and org_id = v_org
  for update;

  if found then
    if v_request.unit_id is null then
      raise exception 'payment_request_scope_unresolved' using errcode = 'P0001';
    end if;
    perform public.assert_unit_in_scope(v_request.unit_id);

    select coalesce(jsonb_agg(
      jsonb_build_object('invoice_id', pri.invoice_id, 'amount', round(pri.amount_allocated, 2))
      order by pri.invoice_id
    ), '[]'::jsonb)
      into v_existing
    from public.payment_request_invoices pri
    where pri.org_id = v_org and pri.payment_request_id = v_request.id;

    if v_request.supplier_id <> p_supplier_id
       or v_request.unit_id is distinct from v_unit
       or round(v_request.amount, 2) <> v_amount
       or v_request.due_date is distinct from p_due_date
       or v_request.notes is distinct from v_notes
       or v_existing is distinct from v_input then
      raise exception 'payment_request_idempotency_conflict' using errcode = 'P0001';
    end if;

    return jsonb_build_object(
      'payment_request_id', v_request.id,
      'number', v_request.number,
      'status', v_request.status,
      'amount', v_request.amount,
      'unit_id', v_request.unit_id,
      'idempotent', true
    );
  end if;

  if not exists (
    select 1 from public.suppliers s
    where s.id = p_supplier_id and s.org_id = v_org and s.deleted_at is null
  ) then
    raise exception 'payment_request_supplier_invalid' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, amount numeric)
    left join public.invoices i on i.id = a.invoice_id
    where i.id is null or i.org_id <> v_org or i.supplier_id <> p_supplier_id
       or i.unit_id is distinct from v_unit
       or i.deleted_at is not null
       or round(a.amount, 2) > round(
         i.total_amount
         - coalesce((select sum(pa.amount) from public.payment_allocations pa where pa.invoice_id = i.id), 0)
         - coalesce((select sum(cr.amount) from public.credit_requests cr
                     where cr.invoice_id = i.id and cr.status in ('offset', 'closed')), 0),
         2
       )
  ) then
    raise exception 'payment_request_allocation_invalid' using errcode = 'P0001';
  end if;

  select exists (
    select 1
    from public.payment_requests pr
    where pr.org_id = v_org
      and pr.unit_id = v_unit
      and pr.supplier_id = p_supplier_id
      and round(pr.amount, 2) = v_amount
      and pr.status in ('draft', 'pending_approval', 'approved', 'sent_for_execution', 'executed', 'matched')
  ) into v_duplicate;

  v_status := case
    when v_duplicate then 'suspected_duplicate'::payment_request_status
    else p_requested_status::payment_request_status
  end;

  perform set_config('app.p1_financial_writer', v_user::text, true);

  insert into public.payment_requests (
    id, org_id, unit_id, supplier_id, amount, due_date, status, notes, created_by
  ) values (
    p_request_id, v_org, v_unit, p_supplier_id, v_amount, p_due_date, v_status, v_notes, v_user
  ) returning * into v_request;

  insert into public.payment_request_invoices (org_id, payment_request_id, invoice_id, amount_allocated)
  select v_org, v_request.id, invoice_id, round(amount, 2)
  from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, amount numeric)
  order by invoice_id;

  if v_duplicate then
    insert into public.exceptions (
      org_id, type, severity, status, title, details,
      supplier_id, payment_request_id, assigned_role
    ) values (
      v_org, 'duplicate_payment', 'high', 'open',
      'חשד לדרישת תשלום כפולה — #' || v_request.number,
      jsonb_build_object('code', 'similar_payment_request'),
      p_supplier_id, v_request.id, 'office'
    );
  end if;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_org, v_user, 'payment_request_created', 'payment_requests', v_request.id,
    jsonb_build_object(
      'status', v_request.status,
      'amount', v_request.amount,
      'invoice_count', v_count,
      'unit_id', v_request.unit_id
    ),
    v_reason
  );

  return jsonb_build_object(
    'payment_request_id', v_request.id,
    'number', v_request.number,
    'status', v_request.status,
    'amount', v_request.amount,
    'unit_id', v_request.unit_id,
    'idempotent', false
  );
end
$$;

revoke all on function public.create_payment_request(uuid, uuid, date, text, text, jsonb, text)
  from public, anon;
grant execute on function public.create_payment_request(uuid, uuid, date, text, text, jsonb, text)
  to authenticated;

-- ===== 3. One trusted transition implementation owns normal and override approval =====

create or replace function public.p1_transition_payment_request(
  p_payment_request_id uuid,
  p_target_status text,
  p_transition_reason text,
  p_override_requested boolean,
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
  v_transition_reason text := nullif(btrim(p_transition_reason), '');
  v_override_reason text := nullif(btrim(p_override_reason), '');
  v_open_credit_total numeric(12,2) := 0;
  v_approved_at timestamptz;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  -- The explicit RPC cannot degrade into ordinary approval by passing NULL/whitespace. The
  -- boolean is supplied only by the ungranted wrappers and is not client-controlled.
  if coalesce(p_override_requested, false) then
    if v_override_reason is null
       or p_expected_supplier_id is null
       or p_expected_open_credit_total is null
       or p_expected_open_credit_total <= 0
       or p_target_status <> 'approved' then
      raise exception 'payment_request_credit_override_invalid' using errcode = '22023';
    end if;
  elsif v_override_reason is not null
        or p_expected_supplier_id is not null
        or p_expected_open_credit_total is not null then
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
  if v_request.unit_id is null then
    raise exception 'payment_request_scope_unresolved' using errcode = 'P0001';
  end if;
  perform public.assert_unit_in_scope(v_request.unit_id);

  if p_expected_supplier_id is not null
     and p_expected_supplier_id is distinct from v_request.supplier_id then
    raise exception 'payment_request_credit_supplier_mismatch' using errcode = '22023';
  end if;

  if v_request.status = v_target then
    if coalesce(p_override_requested, false) and not (
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
    -- Lock the supplier row first. New credits referencing this supplier require a FK key
    -- lock and therefore cannot race the stable snapshot below. Existing active credits are
    -- then locked by id before their derived legal entities are evaluated.
    perform 1
    from public.suppliers s
    where s.id = v_request.supplier_id and s.org_id = v_org and s.deleted_at is null
    for update;
    if not found then
      raise exception 'payment_request_checks_failed' using errcode = 'P0001';
    end if;

    perform 1
    from public.invoices i
    join public.payment_request_invoices pri
      on pri.org_id = i.org_id and pri.invoice_id = i.id
    where pri.org_id = v_org and pri.payment_request_id = v_request.id
    order by i.id
    for update of i;

    if not exists (
      select 1
      from public.payment_request_invoices pri
      where pri.org_id = v_org and pri.payment_request_id = v_request.id
    ) or exists (
      select 1
      from public.payment_request_invoices pri
      left join public.invoices i
        on i.org_id = pri.org_id and i.id = pri.invoice_id
      where pri.org_id = v_org and pri.payment_request_id = v_request.id
        and (
          i.id is null or i.org_id <> v_org or i.supplier_id <> v_request.supplier_id
          or i.unit_id is distinct from v_request.unit_id
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

    perform 1
    from public.credit_requests cr
    where cr.org_id = v_org
      and cr.supplier_id = v_request.supplier_id
      and cr.status in ('open', 'requested', 'received')
    order by cr.id
    for update;

    if exists (
      select 1
      from public.credit_requests cr
      where cr.org_id = v_org
        and cr.supplier_id = v_request.supplier_id
        and cr.status in ('open', 'requested', 'received')
        and private.credit_request_legal_entity(cr.id, cr.org_id) is null
    ) then
      raise exception 'payment_request_credit_scope_unresolved' using errcode = 'P0001';
    end if;

    select coalesce(sum(cr.amount), 0)::numeric(12,2)
      into v_open_credit_total
    from public.credit_requests cr
    where cr.org_id = v_org
      and cr.supplier_id = v_request.supplier_id
      and cr.status in ('open', 'requested', 'received')
      and private.credit_request_legal_entity(cr.id, cr.org_id) = v_request.unit_id;

    if v_open_credit_total > 0 then
      if not coalesce(p_override_requested, false) then
        raise exception 'payment_request_credit_override_required' using errcode = 'P0001';
      end if;
      if round(v_open_credit_total, 2) <> round(p_expected_open_credit_total, 2) then
        raise exception 'payment_request_credit_total_changed' using errcode = 'P0001';
      end if;
    elsif coalesce(p_override_requested, false) then
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
  where id = v_request.id and org_id = v_org;

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
        'unit_id', v_request.unit_id,
        'legal_entity_id', v_request.unit_id,
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
      jsonb_build_object('status', v_target, 'unit_id', v_request.unit_id),
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

revoke all on function public.p1_transition_payment_request(
  uuid, text, text, boolean, text, uuid, numeric
) from public, anon, authenticated;

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
    false,
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
    true,
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

-- ===== 4. Scope-bound approval signals =====

-- Re-declared from 0031. The server now returns the scoped open-credit total, so the browser
-- never reads raw credit rows to construct an approval decision. For an existing request the
-- supplier, amount, legal entity and exact invoice set are rebound before any credit value is
-- returned. The similar-bank boolean keeps its pre-0073 semantics because bank_imports is a
-- separately deferred legal-entity table (0054); this migration does not invent its scope.
create or replace function public.payment_request_financial_check_signals(
  p_supplier_id uuid,
  p_amount numeric,
  p_invoice_ids uuid[],
  p_payment_request_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid := auth_org();
  v_role user_role := auth_role();
  v_request public.payment_requests;
  v_requested_count int;
  v_visible_count int;
  v_unit_count int;
  v_unit uuid;
  v_paid_count int;
  v_unapproved_count int;
  v_open_balance numeric;
  v_open_credit_total numeric(12,2) := 0;
  v_similar_bank boolean;
begin
  if v_org is null or auth.uid() is null or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_supplier_id is null or p_amount is null or p_amount <= 0
     or p_invoice_ids is null or cardinality(p_invoice_ids) = 0
     or array_position(p_invoice_ids, null) is not null then
    raise exception 'payment_request_checks_invalid' using errcode = '22023';
  end if;

  select count(*) into v_requested_count
  from (select distinct unnest(p_invoice_ids) as id) requested;

  with requested as (
    select distinct unnest(p_invoice_ids) as id
  ), visible as (
    select i.id, i.unit_id, i.review_status,
           i.total_amount
           - coalesce((select sum(pa.amount) from public.payment_allocations pa
                       where pa.org_id = v_org and pa.invoice_id = i.id), 0)
           - coalesce((select sum(cr.amount) from public.credit_requests cr
                       where cr.org_id = v_org and cr.invoice_id = i.id
                         and cr.status in ('offset', 'closed')), 0) as balance
    from requested r
    join public.invoices i on i.id = r.id
    join public.org_units u
      on u.org_id = i.org_id and u.id = i.unit_id and u.unit_type = 'legal_entity'
    where i.org_id = v_org and i.supplier_id = p_supplier_id and i.deleted_at is null
  )
  select count(*), count(distinct unit_id), min(unit_id::text)::uuid,
         count(*) filter (where balance <= 0),
         count(*) filter (where review_status <> 'approved'),
         coalesce(sum(greatest(balance, 0)), 0)
    into v_visible_count, v_unit_count, v_unit,
         v_paid_count, v_unapproved_count, v_open_balance
  from visible;

  if v_visible_count <> v_requested_count or v_unit_count <> 1 or v_unit is null then
    raise exception 'payment_request_checks_mismatch' using errcode = 'P0001';
  end if;
  perform public.assert_unit_in_scope(v_unit);

  if p_payment_request_id is not null then
    select * into v_request
    from public.payment_requests pr
    where pr.id = p_payment_request_id and pr.org_id = v_org;

    if not found then
      raise exception 'payment_request_unknown' using errcode = 'P0002';
    end if;
    if v_request.unit_id is null then
      raise exception 'payment_request_scope_unresolved' using errcode = 'P0001';
    end if;
    perform public.assert_unit_in_scope(v_request.unit_id);

    if v_request.supplier_id is distinct from p_supplier_id
       or round(v_request.amount, 2) <> round(p_amount, 2)
       or v_request.unit_id is distinct from v_unit
       or exists (
         select 1
         from public.payment_request_invoices pri
         where pri.org_id = v_org and pri.payment_request_id = v_request.id
           and not (pri.invoice_id = any(p_invoice_ids))
       )
       or exists (
         select 1
         from unnest(p_invoice_ids) as requested(requested_id)
         where not exists (
           select 1
           from public.payment_request_invoices pri
           where pri.org_id = v_org
             and pri.payment_request_id = v_request.id
             and pri.invoice_id = requested.requested_id
         )
       ) then
      raise exception 'payment_request_checks_mismatch' using errcode = 'P0001';
    end if;
  end if;

  if exists (
    select 1
    from public.credit_requests cr
    where cr.org_id = v_org
      and cr.supplier_id = p_supplier_id
      and cr.status in ('open', 'requested', 'received')
      and private.credit_request_legal_entity(cr.id, cr.org_id) is null
  ) then
    raise exception 'payment_request_credit_scope_unresolved' using errcode = 'P0001';
  end if;

  select coalesce(sum(cr.amount), 0)::numeric(12,2)
    into v_open_credit_total
  from public.credit_requests cr
  where cr.org_id = v_org
    and cr.supplier_id = p_supplier_id
    and cr.status in ('open', 'requested', 'received')
    and private.credit_request_legal_entity(cr.id, cr.org_id) = v_unit;

  select exists (
    select 1
    from public.bank_transactions bt
    where bt.org_id = v_org
      and bt.supplier_id = p_supplier_id
      and round(bt.amount, 2) = round(p_amount, 2)
      and bt.is_debit
      and bt.tx_date >= current_date - 45
  ) into v_similar_bank;

  return jsonb_build_object(
    'requested_invoice_count', v_requested_count,
    'visible_invoice_count', v_visible_count,
    'paid_invoice_count', v_paid_count,
    'unapproved_invoice_count', v_unapproved_count,
    'amount_matches_open_balance', abs(round(v_open_balance, 2) - round(p_amount, 2)) <= 1,
    'similar_bank_transfer_exists', v_similar_bank,
    'open_credit_total', v_open_credit_total
  );
end
$$;

revoke all on function public.payment_request_financial_check_signals(uuid, numeric, uuid[], uuid)
  from public, anon;
grant execute on function public.payment_request_financial_check_signals(uuid, numeric, uuid[], uuid)
  to authenticated;

-- ===== 5. Drain remediated A5 exemptions and re-assert the scope contract =====

delete from private.scope_definer_exemptions e
where e.function_signature in (
  to_regprocedure('public.create_payment_request(uuid,uuid,date,text,text,jsonb,text)')::text,
  to_regprocedure('public.transition_payment_request(uuid,text,text)')::text,
  to_regprocedure('public.payment_request_financial_check_signals(uuid,numeric,uuid[],uuid)')::text
);

do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0073 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
