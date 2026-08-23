-- 0173 -- Partial supplier-credit consumption through payment execution.
--
-- OPEN-DECISIONS #244: a payment may consume any positive amount up to the credit's computed
-- remainder. The credit row is locked before the remainder is checked. It stays `received` while
-- money remains and becomes `offset` exactly when fully consumed. The payment row records only
-- cash transferred; invoice allocations plus credit allocations still equal the approved request.

-- ===== 1. Canonical computed credit balance =====
create or replace function public.credit_request_balance_rows(p_supplier_id uuid)
returns table (
  credit_id uuid,
  supplier_id uuid,
  invoice_id uuid,
  credit_number integer,
  amount numeric,
  allocated_amount numeric,
  remaining_amount numeric,
  status credit_status
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select credit.id,
         credit.supplier_id,
         credit.invoice_id,
         credit.number,
         credit.amount::numeric(12,2),
         coalesce(sum(allocation.amount), 0)::numeric(12,2),
         greatest(credit.amount - coalesce(sum(allocation.amount), 0), 0)::numeric(12,2),
         credit.status
  from public.credit_requests credit
  left join public.payment_allocations allocation
    on allocation.org_id = credit.org_id and allocation.credit_id = credit.id
  where credit.org_id = auth_org()
    and credit.supplier_id = p_supplier_id
    and auth_role() in ('owner', 'accountant')
  group by credit.id, credit.supplier_id, credit.invoice_id, credit.number,
           credit.amount, credit.status
  order by credit.created_at, credit.id
$$;

revoke all on function public.credit_request_balance_rows(uuid) from public, anon;
grant execute on function public.credit_request_balance_rows(uuid) to authenticated;

comment on function public.credit_request_balance_rows(uuid) is
  'Computed supplier-credit balances (0173): original amount minus every payment_allocation that '
  'names the credit. Owner/accountant only through the existing invoker RLS surface. A received '
  'credit with zero allocations still reports its full amount; intake alone changes no balance.';

-- ===== 2. Invoice balance consumes allocated credit, not lifecycle labels =====
do $patch_invoice_credit_balance$
declare
  v_signature regprocedure := 'public.p0_invoice_balance_rows()'::regprocedure;
  v_definition text := replace(pg_get_functiondef(v_signature), e'\r', '');
  v_anchor text := $anchor$  ), credited as (
    select cr.org_id, cr.invoice_id, sum(cr.amount) as amount
    from public.credit_requests cr
    where cr.org_id = auth_org() and cr.invoice_id is not null
      and cr.status in ('offset','closed')
    group by cr.org_id, cr.invoice_id
  )$anchor$;
  v_replacement text := $replacement$  ), credited as (
    select cr.org_id, cr.invoice_id, sum(pa.amount) as amount
    from public.credit_requests cr
    join public.payment_allocations pa
      on pa.org_id = cr.org_id and pa.credit_id = cr.id
    where cr.org_id = auth_org() and cr.invoice_id is not null
    group by cr.org_id, cr.invoice_id
  )$replacement$;
begin
  if position(v_anchor in v_definition) = 0
     or position('sum(pa.amount) as amount' in v_definition) > 0 then
    raise exception '0173: p0_invoice_balance_rows credit anchor moved or patch already applied';
  end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_invoice_credit_balance$;

-- ===== 3. Patch the live executor; preserve 0061 step-up and 0133 accountant-only gate =====
do $patch_partial_credit_executor$
declare
  v_signature regprocedure :=
    'public.execute_payment_request(uuid,date,text,text,text,jsonb,text)'::regprocedure;
  v_definition text := replace(pg_get_functiondef(v_signature), e'\r', '');
  v_anchor text;
  v_replacement text;
begin
  if position('v_cash_sum numeric' in v_definition) > 0 then
    raise exception '0173: execute_payment_request patch already applied';
  end if;
  if position('assert_recent_password_authentication' in v_definition) = 0
     or position('v_role <> ''accountant''' in v_definition) = 0 then
    raise exception '0173: refusing to patch executor without 0061 step-up and 0133 role ancestry';
  end if;

  v_anchor := $anchor$  v_sum numeric;
  v_input jsonb;$anchor$;
  v_replacement := $replacement$  v_sum numeric;
  v_cash_sum numeric;
  v_input jsonb;$replacement$;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0173: executor declaration anchor moved';
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$         round(coalesce(sum(amount), 0), 2),
         coalesce(jsonb_agg($anchor$;
  v_replacement := $replacement$         round(coalesce(sum(amount), 0), 2),
         round(coalesce(sum(amount) filter (where invoice_id is not null), 0), 2),
         coalesce(jsonb_agg($replacement$;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0173: executor allocation aggregate anchor moved';
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$    into v_count, v_distinct_count, v_sum, v_input$anchor$;
  v_replacement := $replacement$    into v_count, v_distinct_count, v_sum, v_cash_sum, v_input$replacement$;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0173: executor aggregate target anchor moved';
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$       or round(v_payment.amount, 2) <> round(v_request.amount, 2)$anchor$;
  v_replacement := $replacement$       or round(v_payment.amount, 2) <> round(v_cash_sum, 2)$replacement$;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0173: executor idempotent cash comparison anchor moved';
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$  if v_sum <> round(v_request.amount, 2) then
    raise exception 'allocation_total_mismatch' using errcode = '22023';
  end if;$anchor$;
  v_replacement := $replacement$  if v_sum <> round(v_request.amount, 2) then
    raise exception 'allocation_total_mismatch' using errcode = '22023';
  end if;
  if v_cash_sum < 0.01 then
    raise exception 'payment_cash_amount_required' using errcode = '22023';
  end if;$replacement$;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0173: executor approved-total anchor moved';
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$             c.id is null or c.org_id <> v_org or c.supplier_id <> v_request.supplier_id
             or c.status <> 'received' or round(a.amount, 2) <> round(c.amount, 2)$anchor$;
  v_replacement := $replacement$             c.id is null or c.org_id <> v_org or c.supplier_id <> v_request.supplier_id
             or c.status <> 'received'
             or round(a.amount, 2) > round(
               c.amount - coalesce((
                 select sum(existing.amount)
                 from public.payment_allocations existing
                 where existing.org_id = c.org_id and existing.credit_id = c.id
               ), 0), 2)$replacement$;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0173: executor full-only credit check anchor moved';
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$    v_org, v_request.supplier_id, v_request.id, round(v_request.amount, 2), p_paid_date,$anchor$;
  v_replacement := $replacement$    v_org, v_request.supplier_id, v_request.id, round(v_cash_sum, 2), p_paid_date,$replacement$;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0173: executor payment cash amount anchor moved';
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$  update public.credit_requests c
  set status = 'offset', resolved_at = now()
  from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, credit_id uuid, amount numeric)
  where a.credit_id = c.id;$anchor$;
  v_replacement := $replacement$  update public.credit_requests c
  set status = case
        when coalesce((
          select sum(applied.amount)
          from public.payment_allocations applied
          where applied.org_id = c.org_id and applied.credit_id = c.id
        ), 0) >= c.amount then 'offset'::credit_status
        else 'received'::credit_status end,
      resolved_at = case
        when coalesce((
          select sum(applied.amount)
          from public.payment_allocations applied
          where applied.org_id = c.org_id and applied.credit_id = c.id
        ), 0) >= c.amount then now() else null end
  from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, credit_id uuid, amount numeric)
  where a.credit_id = c.id;$replacement$;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0173: executor credit lifecycle anchor moved';
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  execute v_definition;
end
$patch_partial_credit_executor$;

comment on function public.execute_payment_request(uuid, date, text, text, text, jsonb, text) is
  'Executes an approved request as accountant with the existing fresh-password step-up. 0173 keeps '
  'invoice plus credit allocations equal to the approved amount, records only invoice-allocation '
  'cash on payments.amount, locks every credit before checking amount minus prior allocations, and '
  'leaves partial credits received until their computed remainder reaches zero.';

-- Refresh the enforced invoice-balance reader hash. The executor remains on its pre-existing A5
-- exemption; this migration neither expands its scope nor falsifies an enforcement row.
insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select 'p0_invoice_balance_rows()', md5(replace(proc.prosrc, e'\r', '')),
       'filtered_read',
       '0173 preserves the payable/auth_org/auth_scopes invoice filter and replaces lifecycle-based '
       'credit totals only with tenant-bound payment_allocations actually applied to each credit.'
from pg_catalog.pg_proc proc
where proc.oid = 'public.p0_invoice_balance_rows()'::regprocedure
on conflict (function_signature) do update
  set body_hash = excluded.body_hash,
      enforcement_kind = excluded.enforcement_kind,
      scope_proof = excluded.scope_proof;

-- ===== 4. Anchors and scope re-assertion =====
do $$
declare
  v_executor text := pg_get_functiondef(
    'public.execute_payment_request(uuid,date,text,text,text,jsonb,text)'::regprocedure);
  v_balance text := pg_get_functiondef('public.p0_invoice_balance_rows()'::regprocedure);
  v_violations text;
begin
  if position('v_cash_sum' in v_executor) = 0
     or position('existing.credit_id = c.id' in v_executor) = 0
     or position('sum(pa.amount) as amount' in v_balance) = 0 then
    raise exception '0173: partial-credit executor or allocation-based balance did not land';
  end if;
  if has_function_privilege('anon', 'public.credit_request_balance_rows(uuid)', 'execute')
     or not has_function_privilege(
       'authenticated', 'public.credit_request_balance_rows(uuid)', 'execute') then
    raise exception '0173: computed credit balance grants are wrong';
  end if;

  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0173 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
