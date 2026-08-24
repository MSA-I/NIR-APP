-- 0173 -- Partial supplier-credit consumption through payment execution.
--
-- OPEN-DECISIONS #244: a payment may consume any positive amount up to the credit's computed
-- remainder. The credit row is locked before the remainder is checked. It stays `received` while
-- money remains and becomes `offset` exactly when fully consumed. The payment row records only
-- cash transferred; invoice allocations plus credit allocations still equal the approved request.
--
-- Owner ruling 2026-08-23: a credit whose `invoice_id` is null may be allocated against ANY invoice
-- of the same supplier, and the link is RECORDED at the moment of allocation. The caller names the
-- target on the allocation row itself (`credit_invoice_id`); an unlinked credit that names no target
-- is refused by name, because the per-invoice coverage rule has nothing to check without one. Once
-- the link is recorded the credit is an ordinary linked credit, so any later partial allocation of
-- the same credit lands on the same invoice -- section 3 explains why the schema admits no other
-- consistent answer.

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
  -- Two DIFFERENT states, measured on disjoint evidence and named separately. The earlier single
  -- test used 'sum(pa.amount) as amount' as its already-applied sentinel, but the live body has
  -- summed payment_allocations that way in its `paid` CTE since 0022 -- the sentinel matched the
  -- function's OWN unchanged text, so the guard fired on a body that was in perfect shape and no
  -- migration after this one could run. A sentinel must be a property the patch CREATES, never a
  -- string that also occurs in what it reads.
  --
  -- "Already applied" is therefore the DISAPPEARANCE of what this patch removes: the lifecycle
  -- credit predicate. That is the same predicate section 4 uses to define a stale reader, so the
  -- two cannot drift apart, and nothing else in this body can reintroduce it.
  if position('cr.status in (''offset''' in v_definition) = 0 then
    raise exception '0173: p0_invoice_balance_rows credit patch already applied';
  end if;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0173: p0_invoice_balance_rows credit anchor moved';
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
  v_linked_credits uuid[];
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

  -- The allocation row grows one optional key. `invoice_id` stays the CASH target: reusing it for
  -- the credit's target would put credit money into v_cash_sum and into payments.amount, which is
  -- exactly the money the rest of this migration takes out of there. `credit_invoice_id` is only
  -- meaningful next to a credit_id, so a cash row that carries one is a caller mistake and is
  -- refused rather than silently ignored.
  v_anchor := $anchor$    from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, credit_id uuid, amount numeric)
    where num_nonnulls(invoice_id, credit_id) <> 1 or amount is null or amount <= 0$anchor$;
  v_replacement := $replacement$    from jsonb_to_recordset(p_allocations) as a(
      invoice_id uuid, credit_id uuid, amount numeric, credit_invoice_id uuid
    )
    where num_nonnulls(invoice_id, credit_id) <> 1 or amount is null or amount <= 0
       or (credit_id is null and credit_invoice_id is not null)$replacement$;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0173: executor allocation shape anchor moved';
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

  -- The containment block reads the credit's target, so its recordset needs the new key too.
  v_anchor := $anchor$    from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, credit_id uuid, amount numeric)
    left join public.invoices i on i.id = a.invoice_id$anchor$;
  v_replacement := $replacement$    from jsonb_to_recordset(p_allocations) as a(
      invoice_id uuid, credit_id uuid, amount numeric, credit_invoice_id uuid
    )
    left join public.invoices i on i.id = a.invoice_id$replacement$;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0173: executor containment recordset anchor moved';
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- Containment, for both legal shapes of a credit. The EFFECTIVE target is
  -- `coalesce(c.invoice_id, a.credit_invoice_id)`: a recorded link always wins, and a caller that
  -- names a different invoice for an already-linked credit is refused rather than quietly moved.
  -- Whichever shape applies, the target must be an invoice this request pays, alive and payable.
  -- Supplier identity is asserted separately, under its own name, before this block runs.
  v_anchor := $anchor$             c.id is null or c.org_id <> v_org or c.supplier_id <> v_request.supplier_id
             or c.status <> 'received' or round(a.amount, 2) <> round(c.amount, 2)$anchor$;
  v_replacement := $replacement$             c.id is null or c.org_id <> v_org or c.supplier_id <> v_request.supplier_id
             or c.status <> 'received'
             or (c.invoice_id is not null and a.credit_invoice_id is not null
                 and a.credit_invoice_id <> c.invoice_id)
             or not exists (
               select 1
               from public.payment_request_invoices pri_credit
               join public.invoices credit_invoice
                 on credit_invoice.org_id = pri_credit.org_id
                and credit_invoice.id = pri_credit.invoice_id
               where pri_credit.org_id = v_org
                 and pri_credit.payment_request_id = v_request.id
                 and pri_credit.invoice_id = coalesce(c.invoice_id, a.credit_invoice_id)
                 and credit_invoice.deleted_at is null
                 and credit_invoice.financial_role = 'payable'
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

  -- Two refusals that must not hide inside `allocation_target_invalid`, because each says something
  -- the caller has to act on differently. Both run AFTER `for update of c`, so a credit that a
  -- concurrent winner has just linked is read at its committed value, not at the value this session
  -- saw before it queued for the lock.
  --
  --   credit_allocation_invoice_required -- an unlinked credit arrived with no target. There is no
  --     defensible implicit choice: the per-invoice coverage rule below has nothing to balance, and
  --     silently picking an invoice would decide, on the caller's behalf, which invoice this credit
  --     permanently belongs to.
  --   credit_allocation_supplier_mismatch -- the credit's supplier is not the supplier of the
  --     invoice it would settle. A payment request already pins the credit to the request supplier,
  --     but an invoice that receives only credit coverage and no cash is never supplier-checked by
  --     the cash branch, so without this a credit could cross suppliers through a mixed request.
  v_anchor := $anchor$  ) input on input.credit_id = c.id
  order by c.id
  for update of c;

  if exists ($anchor$;
  v_replacement := $replacement$  ) input on input.credit_id = c.id
  order by c.id
  for update of c;

  if exists (
    select 1
    from jsonb_to_recordset(p_allocations) as a(
      invoice_id uuid, credit_id uuid, amount numeric, credit_invoice_id uuid
    )
    join public.credit_requests c on c.id = a.credit_id and c.org_id = v_org
    where a.credit_id is not null
      and coalesce(c.invoice_id, a.credit_invoice_id) is null
  ) then
    raise exception 'credit_allocation_invoice_required' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_allocations) as a(
      invoice_id uuid, credit_id uuid, amount numeric, credit_invoice_id uuid
    )
    join public.credit_requests c on c.id = a.credit_id and c.org_id = v_org
    join public.invoices credit_target
      on credit_target.org_id = c.org_id
     and credit_target.id = coalesce(c.invoice_id, a.credit_invoice_id)
    where a.credit_id is not null
      and credit_target.supplier_id <> c.supplier_id
  ) then
    raise exception 'credit_allocation_supplier_mismatch' using errcode = '22023';
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
      select coalesce(c.invoice_id, a.credit_invoice_id) as invoice_id, sum(a.amount) as amount
      from jsonb_to_recordset(p_allocations) as a(
        invoice_id uuid, credit_id uuid, amount numeric, credit_invoice_id uuid
      )
      join public.credit_requests c on c.id = a.credit_id and c.org_id = v_org
      where a.credit_id is not null
      group by coalesce(c.invoice_id, a.credit_invoice_id)
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

  -- Recording the link is the substance of the 2026-08-23 ruling, and it is also the only shape the
  -- schema can represent. `credit_requests.invoice_id` is a single scalar, and EVERY reader of "how
  -- much credit settled this invoice" -- p0_invoice_balance_rows, p1_refresh_invoice_payment_statuses,
  -- soft_delete_supplier, the two approval-side readers and the overpayment guard below -- attributes
  -- the credit's WHOLE applied sum to that one invoice. A credit split 40/60 across two invoices
  -- would therefore over-credit one and under-credit the other in every one of them. So the link is
  -- written once, on the first allocation, and a later partial allocation of the same credit travels
  -- the ordinary linked path and must land on the same invoice. Splitting a credit across invoices
  -- would need per-allocation invoice attribution, which is a data-model change, not a wider guard.
  --
  -- The write is audited with the caller's reason, exactly one row per credit that changed, never
  -- one per allocation. Which credits changed is captured BEFORE the update, because afterwards
  -- nothing distinguishes a credit linked a second ago from one linked at intake; the audit row
  -- itself is written AFTER, because 0175 files a credit_requests audit row under the legal entity
  -- of `credit_requests.invoice_id`, and a row written a statement earlier would be filed
  -- cross_scope -- attributing the event to nowhere precisely as it acquires a somewhere.
  v_anchor := $anchor$  update public.credit_requests c
  set status = 'offset', resolved_at = now()
  from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, credit_id uuid, amount numeric)
  where a.credit_id = c.id;$anchor$;
  v_replacement := $replacement$  select coalesce(array_agg(c.id order by c.id), '{}'::uuid[])
    into v_linked_credits
  from jsonb_to_recordset(p_allocations) as a(
    invoice_id uuid, credit_id uuid, amount numeric, credit_invoice_id uuid
  )
  join public.credit_requests c on c.id = a.credit_id and c.org_id = v_org
  where a.credit_id is not null
    and c.invoice_id is null
    and a.credit_invoice_id is not null;

  update public.credit_requests c
  set invoice_id = a.credit_invoice_id
  from jsonb_to_recordset(p_allocations) as a(
    invoice_id uuid, credit_id uuid, amount numeric, credit_invoice_id uuid
  )
  where a.credit_id = c.id
    and c.org_id = v_org
    and c.invoice_id is null
    and a.credit_invoice_id is not null;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  )
  select v_org, v_user, 'credit_request_invoice_linked', 'credit_requests', c.id,
         jsonb_build_object('invoice_id', null::uuid),
         jsonb_build_object(
           'invoice_id', c.invoice_id,
           'payment_id', v_payment.id,
           'payment_request_id', v_request.id,
           'amount', round(a.amount, 2)
         ),
         v_reason
  from jsonb_to_recordset(p_allocations) as a(
    invoice_id uuid, credit_id uuid, amount numeric, credit_invoice_id uuid
  )
  join public.credit_requests c on c.id = a.credit_id and c.org_id = v_org
  where c.id = any (v_linked_credits)
  order by c.id;

  update public.credit_requests c
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
  'leaves partial credits received until their computed remainder reaches zero. An unlinked credit '
  'may settle any invoice of its own supplier that this request pays, named by credit_invoice_id on '
  'the allocation row; the link is written and audited under the same lock, after which the credit '
  'is an ordinary linked credit.';

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

-- ===== 3c. The one writer that could still contradict those readers =====
--
-- Sections 2, 3 and 3b moved every READER of "how much credit settled this invoice" onto applied
-- payment_allocations. transition_credit_request is the writer, and it was left able to stamp
-- 'offset' -- setting resolved_at, and telling the Credits screen the credit is spent -- with
-- nothing allocated at all. After this migration that combination is incoherent in a way that
-- costs money in both directions at once: the invoice stays unpaid because no allocation exists,
-- and credit_request_balance_rows still reports the full amount as remaining, so the same credit
-- can be applied again in a payment. Owner ruling, 24.08.2026: the label follows the money, so the
-- transition refuses until the credit is consumed. Reaching 'offset' is what execute_payment_request
-- already does when it allocates the credit; this makes the manual path agree with it rather than
-- become a second, unaudited way to settle an invoice.
--
-- No tolerance. Both amounts are numeric(12,2) and allocations sum exactly, so an epsilon here would
-- only re-open the double-count it closes, one agora at a time.
--
-- Anchored replacement of the LIVE body, like every other patch in this migration. The function sits
-- on the A5 exemption list rather than the enforcement ledger, so there is no body hash to re-pin and
-- the pinned exemption count is unchanged.
do $patch_credit_offset_gate$
declare
  v_definition text;
  v_anchor text;
  v_replacement text;
begin
  v_definition := replace(
    pg_get_functiondef('public.transition_credit_request(uuid,credit_status,text)'::regprocedure),
    e'\r', '');

  v_anchor := $anchor$  if not v_allowed then
    raise exception 'credit_request_transition_invalid' using errcode = 'P0001';
  end if;$anchor$;

  v_replacement := $replacement$  if not v_allowed then
    raise exception 'credit_request_transition_invalid' using errcode = 'P0001';
  end if;

  if p_status = 'offset'
     and coalesce((
           select sum(allocation.amount)
           from payment_allocations allocation
           where allocation.org_id = v_org and allocation.credit_id = v_credit.id
         ), 0) < v_credit.amount then
    raise exception 'credit_request_not_fully_allocated' using errcode = 'P0001';
  end if;$replacement$;

  if position(v_anchor in v_definition) = 0 then
    raise exception '0173: transition_credit_request validation anchor moved';
  end if;

  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_credit_offset_gate$;

do $assert_credit_offset_gate$
begin
  if coalesce(
       (select p.prosrc from pg_catalog.pg_proc p
         where p.oid = 'public.transition_credit_request(uuid,credit_status,text)'::regprocedure),
       '') !~ 'credit_request_not_fully_allocated' then
    raise exception '0173: the credit offset gate did not land';
  end if;
end
$assert_credit_offset_gate$;

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
     or position('credit_allocation_invoice_required' in v_executor) = 0
     or position('credit_allocation_supplier_mismatch' in v_executor) = 0
     or position('allocation_invoice_coverage_mismatch' in v_executor) = 0
     or position('pri_credit.invoice_id = coalesce(c.invoice_id, a.credit_invoice_id)'
                 in v_executor) = 0
     or position('set invoice_id = a.credit_invoice_id' in v_executor) = 0
     or position('into v_linked_credits' in v_executor) = 0
     or position('credit_request_invoice_linked' in v_executor) = 0
     -- NOT 'sum(pa.amount) as amount': the `paid` CTE has read payment_allocations that way since
     -- 0022, so that needle passes whether or not section 2 changed anything -- an assertion that
     -- cannot fail. The join this patch introduces is the only new text in the body.
     or position('pa.credit_id = cr.id' in v_balance) = 0 then
    raise exception '0173: partial-credit executor or allocation-based balance did not land';
  end if;

  -- The fail-closed placeholder this migration replaced must be gone, not merely unreachable: an
  -- executor that can still raise it is an executor that never learned the 2026-08-23 ruling.
  if position('credit_request_not_linked_to_invoice' in v_executor) > 0 then
    raise exception '0173: the unlinked-credit placeholder refusal survives in the executor';
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
