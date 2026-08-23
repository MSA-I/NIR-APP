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
             or c.invoice_id is null
             or not exists (
               select 1
               from public.payment_request_invoices pri_credit
               where pri_credit.org_id = v_org
                 and pri_credit.payment_request_id = v_request.id
                 and pri_credit.invoice_id = c.invoice_id
             )
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

  -- The credit branch above can only contain a credit inside the request once every credit names
  -- an invoice. A credit with no invoice is refused by its own name rather than being silently
  -- allowed against an arbitrary invoice or silently dropped: OPEN-DECISIONS #244 settled partial
  -- consumption of an INVOICE-LINKED credit and says nothing about an unlinked one. This is a
  -- fail-closed placeholder and must be revisited when the owner rules on the unlinked case.
  v_anchor := $anchor$  ) input on input.credit_id = c.id
  order by c.id
  for update of c;

  if exists ($anchor$;
  v_replacement := $replacement$  ) input on input.credit_id = c.id
  order by c.id
  for update of c;

  if exists (
    select 1
    from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, credit_id uuid, amount numeric)
    join public.credit_requests c on c.id = a.credit_id and c.org_id = v_org
    where a.credit_id is not null and c.invoice_id is null
  ) then
    raise exception 'credit_request_not_linked_to_invoice' using errcode = '22023';
  end if;

  if exists ($replacement$;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0173: executor credit lock anchor moved';
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$    v_org, v_request.supplier_id, v_request.id, round(v_request.amount, 2), p_paid_date,$anchor$;
  v_replacement := $replacement$    v_org, v_request.supplier_id, v_request.id, round(v_cash_sum, 2), p_paid_date,$replacement$;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0173: executor payment cash amount anchor moved';
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- The guard that actually stops overpayment. Until now it subtracted the FULL amount of every
  -- offset/closed credit and nothing at all for a credit that is only partly consumed, so a
  -- payment that had already spent 40 of a credit could be followed by another 40 of cash against
  -- the same invoice. Both readers now measure the same thing: allocations actually applied.
  v_anchor := $anchor$      - coalesce((select sum(cr.amount) from public.credit_requests cr
                  where cr.invoice_id = i.id and cr.status in ('offset', 'closed')), 0),
      2
    )
  ) then
    raise exception 'allocation_exceeds_balance' using errcode = 'P0001';
  end if;$anchor$;
  v_replacement := $replacement$      - coalesce((select sum(pa.amount) from public.payment_allocations pa
                  join public.credit_requests cr
                    on cr.org_id = pa.org_id and cr.id = pa.credit_id
                  where cr.invoice_id = i.id), 0),
      2
    )
  ) then
    raise exception 'allocation_exceeds_balance' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from public.payment_request_invoices pri_cover
    left join (
      select a.invoice_id as invoice_id, sum(a.amount) as amount
      from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, credit_id uuid, amount numeric)
      where a.invoice_id is not null
      group by a.invoice_id
    ) cash on cash.invoice_id = pri_cover.invoice_id
    left join (
      select c.invoice_id as invoice_id, sum(a.amount) as amount
      from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, credit_id uuid, amount numeric)
      join public.credit_requests c on c.id = a.credit_id and c.org_id = v_org
      where a.credit_id is not null
      group by c.invoice_id
    ) credited on credited.invoice_id = pri_cover.invoice_id
    where pri_cover.org_id = v_org and pri_cover.payment_request_id = v_request.id
      and round(coalesce(cash.amount, 0) + coalesce(credited.amount, 0), 2)
          <> round(pri_cover.amount_allocated, 2)
  ) then
    raise exception 'allocation_invoice_coverage_mismatch' using errcode = '22023';
  end if;$replacement$;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0173: executor invoice balance guard anchor moved';
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

-- ===== 3b. Every other reader of "how much credit was consumed" =====
--
-- p0_invoice_balance_rows and the executor guard are only two of six live places that answered
-- "how much of this invoice did a credit already settle". The other four still used the lifecycle
-- labels: they counted the FULL amount of an offset/closed credit and nothing at all for a credit
-- that is partly consumed. With partial allocations both halves of that rule are wrong, in
-- opposite directions, and the disagreement is what lets a payment overpay an invoice. All of
-- them now sum payment_allocations by credit_id -- money that actually moved.
--
-- Every patch below rewrites the LIVE body (0061/0133 rewrote some of these in place; a verbatim
-- redeclare from the source migration would revert those). Carriage returns are stripped before
-- matching so a CRLF checkout cannot silently miss an anchor.

do $patch_credit_consumption_readers$
declare
  v_signature regprocedure;
  v_definition text;
  v_anchor text;
  v_replacement text;
begin
  -- Drift guard on the two bodies pinned in the A5 ledger: if the live source no longer matches
  -- its pin, someone changed it out of band and this migration must not paper over that.
  if exists (
    select 1
    from (values
      ('payment_request_financial_check_signals(uuid,numeric,uuid[],uuid)'),
      ('p1_transition_payment_request(uuid,text,text,boolean,text,uuid,numeric)')
    ) as pinned(signature)
    where not exists (
      select 1
      from private.scope_definer_enforcements e
      join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(e.function_signature)
      where e.function_signature = pinned.signature
        and e.body_hash = md5(replace(p.prosrc, e'\r', ''))
    )
  ) then
    raise exception
      '0173: a pinned financial body drifted from its A5 pin; re-review before replacing';
  end if;

  -- --- p1_refresh_invoice_payment_statuses (live decl 0023:181) ---
  -- The `paid` arm decided an invoice was settled from lifecycle labels, so an invoice closed by
  -- cash plus a partly used credit stayed `partial` forever.
  v_signature := 'public.p1_refresh_invoice_payment_statuses(uuid,uuid[])'::regprocedure;
  v_definition := replace(pg_get_functiondef(v_signature), e'\r', '');
  v_anchor := $anchor$         - coalesce((select sum(cr.amount) from credit_requests cr
                     where cr.invoice_id = i.id and cr.status in ('offset', 'closed')), 0) <= 1$anchor$;
  v_replacement := $replacement$         - coalesce((select sum(pa.amount) from payment_allocations pa
                     join credit_requests cr on cr.org_id = pa.org_id and cr.id = pa.credit_id
                     where cr.invoice_id = i.id), 0) <= 1$replacement$;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0173: p1_refresh_invoice_payment_statuses credit anchor moved';
  end if;
  execute replace(v_definition, v_anchor, v_replacement);

  -- --- soft_delete_supplier (live decl 0146:60) ---
  -- The deletion predicate must not hide debt. Its own comment says it mirrors
  -- p0_invoice_balance_rows; section 2 moved that reader, so this one moves with it.
  v_signature := 'public.soft_delete_supplier(uuid,text)'::regprocedure;
  v_definition := replace(pg_get_functiondef(v_signature), e'\r', '');
  v_anchor := $anchor$  ), credited as (
    select cr.invoice_id, sum(cr.amount) as amount
    from public.credit_requests cr
    where cr.org_id = v_org and cr.invoice_id is not null
      and cr.status in ('offset', 'closed')
    group by cr.invoice_id
  )$anchor$;
  v_replacement := $replacement$  ), credited as (
    select cr.invoice_id, sum(pa.amount) as amount
    from public.credit_requests cr
    join public.payment_allocations pa
      on pa.org_id = cr.org_id and pa.credit_id = cr.id
    where cr.org_id = v_org and cr.invoice_id is not null
    group by cr.invoice_id
  )$replacement$;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0173: soft_delete_supplier credit anchor moved';
  end if;
  execute replace(v_definition, v_anchor, v_replacement);

  -- --- payment_request_financial_check_signals (live decl 0146:221) ---
  -- 0146 states in its own comment that the office warning uses "the same expression the approval
  -- command enforces". Moving one without the other reintroduces exactly the divergence that
  -- comment exists to prevent, so all three credit sums move together.
  v_signature :=
    'public.payment_request_financial_check_signals(uuid,numeric,uuid[],uuid)'::regprocedure;
  v_definition := replace(pg_get_functiondef(v_signature), e'\r', '');

  v_anchor := $anchor$           - coalesce((select sum(cr.amount) from public.credit_requests cr
                       where cr.org_id = v_org and cr.invoice_id = i.id
                         and cr.status in ('offset', 'closed')), 0) as balance$anchor$;
  v_replacement := $replacement$           - coalesce((select sum(pa.amount) from public.payment_allocations pa
                       join public.credit_requests cr
                         on cr.org_id = pa.org_id and cr.id = pa.credit_id
                       where cr.org_id = v_org and cr.invoice_id = i.id), 0) as balance$replacement$;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0173: signals visible-balance credit anchor moved';
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$        - coalesce((select sum(cr.amount) from public.credit_requests cr
                    where cr.org_id = v_org and cr.invoice_id = i.id
                      and cr.status in ('offset', 'closed')), 0),$anchor$;
  v_replacement := $replacement$        - coalesce((select sum(pa.amount) from public.payment_allocations pa
                    join public.credit_requests cr
                      on cr.org_id = pa.org_id and cr.id = pa.credit_id
                    where cr.org_id = v_org and cr.invoice_id = i.id), 0),$replacement$;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0173: signals over-allocation credit anchor moved';
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- The open-credit figure office is shown: a credit consumed to 90% must not still be advertised
  -- at 100% of its original amount.
  v_anchor := $anchor$  select coalesce(sum(cr.amount), 0)::numeric(12,2)
    into v_open_credit_total
  from public.credit_requests cr
  where cr.org_id = v_org
    and cr.supplier_id = p_supplier_id$anchor$;
  v_replacement := $replacement$  select coalesce(sum(greatest(cr.amount - coalesce((
           select sum(applied.amount)
           from public.payment_allocations applied
           where applied.org_id = cr.org_id and applied.credit_id = cr.id
         ), 0), 0)), 0)::numeric(12,2)
    into v_open_credit_total
  from public.credit_requests cr
  where cr.org_id = v_org
    and cr.supplier_id = p_supplier_id$replacement$;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0173: signals open-credit total anchor moved';
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);
  execute v_definition;

  -- --- p1_transition_payment_request (live decl 0073:528) ---
  v_signature :=
    'public.p1_transition_payment_request(uuid,text,text,boolean,text,uuid,numeric)'::regprocedure;
  v_definition := replace(pg_get_functiondef(v_signature), e'\r', '');

  v_anchor := $anchor$            - coalesce((select sum(cr.amount) from public.credit_requests cr
                        where cr.invoice_id = i.id and cr.status in ('offset', 'closed')), 0),$anchor$;
  v_replacement := $replacement$            - coalesce((select sum(pa.amount) from public.payment_allocations pa
                        join public.credit_requests cr
                          on cr.org_id = pa.org_id and cr.id = pa.credit_id
                        where cr.invoice_id = i.id), 0),$replacement$;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0173: approval barrier credit anchor moved';
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- The override barrier summed the ORIGINAL amount of every open/requested/received credit, so a
  -- credit consumed to 90% kept forcing payment_request_credit_override_required at an inflated
  -- figure, and payment_request_credit_total_changed compared against a number nobody could match.
  v_anchor := $anchor$    select coalesce(sum(cr.amount), 0)::numeric(12,2)
      into v_open_credit_total
    from public.credit_requests cr
    where cr.org_id = v_org
      and cr.supplier_id = v_request.supplier_id$anchor$;
  v_replacement := $replacement$    select coalesce(sum(greatest(cr.amount - coalesce((
             select sum(applied.amount)
             from public.payment_allocations applied
             where applied.org_id = cr.org_id and applied.credit_id = cr.id
           ), 0), 0)), 0)::numeric(12,2)
      into v_open_credit_total
    from public.credit_requests cr
    where cr.org_id = v_org
      and cr.supplier_id = v_request.supplier_id$replacement$;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0173: override open-credit total anchor moved';
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);
  execute v_definition;
end
$patch_credit_consumption_readers$;

-- Re-pin the two A5-registered bodies this migration replaced. Computed, never literal -- md5 over
-- prosrc with carriage returns stripped, exactly as private.scope_definer_marker_violations()
-- recomputes it. Neither replacement touches the unit derivation or assert_unit_in_scope.
insert into private.scope_definer_enforcements(
  function_signature, body_hash, enforcement_kind, scope_proof
)
select reviewed.signature, md5(replace(proc.prosrc, e'\r', '')), reviewed.kind, reviewed.proof
from (values
  ('payment_request_financial_check_signals(uuid,numeric,uuid[],uuid)', 'assert_unit',
    '0173 keeps 0146 single-unit derivation, assert_unit_in_scope and the count-only signal, and replaces lifecycle credit totals with applied payment_allocations.'),
  ('p1_transition_payment_request(uuid,text,text,boolean,text,uuid,numeric)', 'assert_unit',
    '0173 keeps 0073 request lock and assert_unit_in_scope, and replaces lifecycle credit totals with the remainder computed from applied payment_allocations.')
) reviewed(signature, kind, proof)
join pg_catalog.pg_proc proc on proc.oid = pg_catalog.to_regprocedure(reviewed.signature)
on conflict(function_signature) do update
set body_hash = excluded.body_hash,
    enforcement_kind = excluded.enforcement_kind,
    scope_proof = excluded.scope_proof;

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
  v_stale text;
begin
  if position('v_cash_sum' in v_executor) = 0
     or position('existing.credit_id = c.id' in v_executor) = 0
     or position('credit_request_not_linked_to_invoice' in v_executor) = 0
     or position('allocation_invoice_coverage_mismatch' in v_executor) = 0
     or position('pri_credit.invoice_id = c.invoice_id' in v_executor) = 0
     or position('sum(pa.amount) as amount' in v_balance) = 0 then
    raise exception '0173: partial-credit executor or allocation-based balance did not land';
  end if;

  -- No live financial reader may still answer "how much credit was consumed" from lifecycle
  -- labels. This is the assertion that keeps the six readers from drifting apart again.
  select string_agg(signature, ', ' order by signature) into v_stale
  from (
    select proc.oid::regprocedure::text as signature
    from pg_catalog.pg_proc proc
    where proc.oid in (
      'public.execute_payment_request(uuid,date,text,text,text,jsonb,text)'::regprocedure,
      'public.p0_invoice_balance_rows()'::regprocedure,
      'public.p1_refresh_invoice_payment_statuses(uuid,uuid[])'::regprocedure,
      'public.soft_delete_supplier(uuid,text)'::regprocedure,
      'public.payment_request_financial_check_signals(uuid,numeric,uuid[],uuid)'::regprocedure,
      'public.p1_transition_payment_request(uuid,text,text,boolean,text,uuid,numeric)'::regprocedure
    )
      and position('cr.status in (''offset''' in replace(proc.prosrc, e'\r', '')) > 0
  ) stale;
  if v_stale is not null then
    raise exception '0173: lifecycle-based credit consumption survives in %', v_stale;
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
