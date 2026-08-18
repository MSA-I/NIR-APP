-- 0146 -- Two money predicates that stopped telling the truth, and one that never spoke.
--
-- ===== (1) soft_delete_supplier counted invoices that are no longer money =====
--
-- THE GAP, reported by the owner and reproduced in the source: the supplier list shows ₪0, the
-- browser pre-check passes, and the RPC still raises supplier_has_open_balance.
--
-- 0137 added invoices.financial_role ('payable' | 'supporting_evidence') and taught every money
-- reader to count only 'payable' -- p0_invoice_balance_rows (0137:2449), p0_supplier_balance_rows
-- (0137:2469), the report snapshot. Consolidation (0137:591-608) flips an interim invoice to
-- 'supporting_evidence' while KEEPING its total_amount and creating no allocation and no credit:
-- the money moved to the consolidated anchor, the interim row stayed as evidence.
--
-- soft_delete_supplier (0036:279-307) was written before that column existed and was never
-- revisited. It sums invoices in every financial_role, so a supplier whose interim invoices were
-- all consolidated carries a phantom balance that only the delete path can see. That is the exact
-- shape the owner hit: the number on the screen and the number in the guard came from two
-- different definitions of "owed".
--
-- WHAT THIS DOES NOT CHANGE, deliberately: the predicate stays ORGANIZATION-WIDE on unit_id. The
-- balance readers filter to `unit_id is null or unit_id = any(auth_scopes())` because they answer
-- "what do I, in my scope, owe". Deletion is not scoped -- suppliers is an org-level table and a
-- soft delete hides the row from every legal entity at once. Filtering the delete predicate to the
-- caller's scope would let a user scoped to one entity hide a supplier a sibling entity still owes
-- money to. The narrower reader and the wider guard are correct at different questions, and the
-- deviation is stated here rather than discovered later. (Practically nil today: 0054:467 seeds one
-- legal_entity per organization and DEBT §7 keeps sibling entities out of production.)
--
-- AND (owner decision, 19.08.2026): a purchase order in 'draft' no longer blocks deletion. A draft
-- is an intention, not a commitment -- nothing was sent to the supplier and nothing is owed. Only
-- ready/sent/confirmed/partial block. The two guards also stop sharing one sentence in the client
-- (src/lib/errors.ts): an unsent draft used to report "יתרה פתוחה".
--
-- ===== (2) payment_request_financial_check_signals could not see an over-allocated request =====
--
-- THE DEAD END, traced from the owner's "cannot close a payment request when a credit exists":
-- payment_request_invoices.amount_allocated is fixed when the request is created and is never
-- recomputed. When a credit is later offset/closed it reduces the invoice balance underneath it.
-- From that moment approval raises payment_request_checks_failed (0073:650-656) and execution
-- raises allocation_exceeds_balance (0031:678-691) -- and no screen can edit the allocation, so
-- the only forward move is cancel. The browser had no way to know that before pressing approve,
-- so the state reads as "the system refuses and will not say why".
--
-- The signal added here is a COUNT, in the same anti-oracle shape as paid_invoice_count and
-- unapproved_invoice_count (0034): office learns that an allocation no longer fits, never by how
-- much and never the balance itself. The comparison is character-for-character the one already
-- enforced at 0073:650-656, so the check and the rejection cannot drift apart.
--
-- NOT CHANGED HERE: the open-credit predicate (0073:693-710), the state machine, the three
-- override columns. The owner decided the exceptional-approval model stays; this migration only
-- makes an existing rejection visible before it fires.
--
-- SCOPE / A5: soft_delete_supplier keeps its 0057:215 exemption (draining it is DEBT §7, not this
-- migration). payment_request_financial_check_signals keeps its executable marker
-- (`perform public.assert_unit_in_scope(...)`) and is re-pinned below with a COMPUTED hash --
-- md5(replace(prosrc, e'\r', '')), never a literal, so a CRLF checkout cannot forge a match.

-- ===== 1. soft_delete_supplier -- payable-only balance, drafts do not block =====

create or replace function public.soft_delete_supplier(
  p_supplier_id uuid,
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
  v_role public.user_role := auth_role();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_supplier public.suppliers;
  v_deleted_at timestamptz;
  v_open_balance numeric := 0;
  v_previous_writer text := coalesce(
    current_setting('app.p0_supplier_soft_delete_writer', true),
    ''
  );
begin
  if v_org is null or v_user is null or v_role is null
     or v_role not in ('owner', 'office') then
    raise exception 'supplier_soft_delete_not_authorized' using errcode = '42501';
  end if;
  if p_supplier_id is null or v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select s.* into v_supplier
  from public.suppliers s
  where s.id = p_supplier_id and s.org_id = v_org
  for update;

  if not found then
    raise exception 'supplier_not_found' using errcode = 'P0002';
  end if;
  if v_supplier.deleted_at is not null then
    return jsonb_build_object(
      'supplier_id', v_supplier.id,
      'status', 'deleted',
      'idempotent', true
    );
  end if;

  -- Do not call the role-filtered balance helper here: office is intentionally excluded from
  -- that read surface. This SECURITY DEFINER command computes only the deletion predicate and
  -- returns no amount, preserving the office balance-oracle boundary.
  --
  -- financial_role = 'payable' mirrors p0_invoice_balance_rows (0137:2449) so the guard and the
  -- supplier screen answer the same question. unit_id is deliberately NOT filtered -- see the
  -- header: deletion is organization-wide, so the debt it must not hide is organization-wide too.
  with paid as (
    select pa.invoice_id, sum(pa.amount) as amount
    from public.payment_allocations pa
    where pa.org_id = v_org and pa.invoice_id is not null
    group by pa.invoice_id
  ), credited as (
    select cr.invoice_id, sum(cr.amount) as amount
    from public.credit_requests cr
    where cr.org_id = v_org and cr.invoice_id is not null
      and cr.status in ('offset', 'closed')
    group by cr.invoice_id
  )
  select coalesce(sum(
    i.total_amount - coalesce(p.amount, 0) - coalesce(c.amount, 0)
  ), 0)
  into v_open_balance
  from public.invoices i
  left join paid p on p.invoice_id = i.id
  left join credited c on c.invoice_id = i.id
  where i.org_id = v_org
    and i.supplier_id = v_supplier.id
    and i.deleted_at is null
    and i.financial_role = 'payable';

  if coalesce(v_open_balance, 0) > 0 then
    raise exception 'supplier_has_open_balance' using errcode = 'P0001';
  end if;

  -- 'draft' joins the terminal statuses (owner decision, 19.08.2026): an order that was never
  -- sent commits the business to nothing. src/pages/Suppliers.tsx mirrors this list.
  if exists (
    select 1
    from public.purchase_orders po
    where po.org_id = v_org
      and po.supplier_id = v_supplier.id
      and po.status not in ('draft', 'received', 'cancelled')
  ) then
    raise exception 'supplier_has_active_orders' using errcode = 'P0001';
  end if;

  perform set_config('app.p0_supplier_soft_delete_writer', v_user::text, true);
  begin
    update public.suppliers
    set deleted_at = clock_timestamp()
    where id = v_supplier.id and org_id = v_org
    returning deleted_at into v_deleted_at;
  exception when others then
    perform set_config('app.p0_supplier_soft_delete_writer', v_previous_writer, true);
    raise;
  end;
  perform set_config('app.p0_supplier_soft_delete_writer', v_previous_writer, true);

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org,
    v_user,
    'supplier_deleted',
    'suppliers',
    v_supplier.id,
    jsonb_build_object('deleted_at', v_supplier.deleted_at),
    jsonb_build_object('deleted_at', v_deleted_at),
    v_reason
  );

  return jsonb_build_object(
    'supplier_id', v_supplier.id,
    'status', 'deleted',
    'idempotent', false
  );
end
$$;

revoke all on function public.soft_delete_supplier(uuid, text) from public, anon, authenticated;
grant execute on function public.soft_delete_supplier(uuid, text) to authenticated;

-- The 0057 A5 exemption must survive this replacement; draining it is DEBT §7, not this wave.
do $soft_delete_exemption$
begin
  if not exists (
    select 1 from private.scope_definer_exemptions e
    where e.function_signature = 'public.soft_delete_supplier(uuid,text)'::regprocedure::text
  ) then
    raise exception '0146: soft_delete_supplier lost its A5 exemption registration';
  end if;
end
$soft_delete_exemption$;

-- ===== 2. payment_request_financial_check_signals -- name the over-allocated invoice =====

-- Drift guard before replacing a pinned financial body: if the live source no longer matches the
-- A5 pin, someone changed it out of band and this migration must not paper over that.
do $signals_drift$
begin
  if not exists (
    select 1
    from private.scope_definer_enforcements e
    join pg_catalog.pg_proc p
      on p.oid = pg_catalog.to_regprocedure(e.function_signature)
    where e.function_signature = 'payment_request_financial_check_signals(uuid,numeric,uuid[],uuid)'
      and e.body_hash = md5(replace(p.prosrc, e'\r', ''))
  ) then
    raise exception
      '0146: payment_request_financial_check_signals drifted from its A5 pin; re-review before replacing';
  end if;
end
$signals_drift$;

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
  v_over_allocated_count int := 0;
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
    -- 22023 is the 0034 contract for this rejection; the P1 suite and error handling pin it.
    raise exception 'payment_request_checks_mismatch' using errcode = '22023';
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
      -- 22023 is the 0034 contract for this rejection; the P1 suite and error handling pin it.
      raise exception 'payment_request_checks_mismatch' using errcode = '22023';
    end if;

    -- 0146: the allocation this request was born with, measured against the balance that is left
    -- now. An offset or closed credit reduces that balance after the fact, and from then on both
    -- approval (0073:650-656) and execution (0031:678-691) reject the request with no way to
    -- repair it. Return a COUNT only -- office must learn that the allocation no longer fits
    -- without learning any balance (the 0034 anti-oracle). The comparison below is the same
    -- expression the approval command enforces, so the warning and the rejection cannot diverge.
    select count(*) into v_over_allocated_count
    from public.payment_request_invoices pri
    join public.invoices i on i.org_id = pri.org_id and i.id = pri.invoice_id
    where pri.org_id = v_org
      and pri.payment_request_id = v_request.id
      and round(pri.amount_allocated, 2) > round(
        i.total_amount
        - coalesce((select sum(pa.amount) from public.payment_allocations pa
                    where pa.org_id = v_org and pa.invoice_id = i.id), 0)
        - coalesce((select sum(cr.amount) from public.credit_requests cr
                    where cr.org_id = v_org and cr.invoice_id = i.id
                      and cr.status in ('offset', 'closed')), 0),
        2
      );
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

  return jsonb_build_object(
    'requested_invoice_count', v_requested_count,
    'visible_invoice_count', v_visible_count,
    'paid_invoice_count', v_paid_count,
    'unapproved_invoice_count', v_unapproved_count,
    -- The 0034 anti-oracle, preserved through this rewrite: office can approve against
    -- invoice status, but cannot probe hidden balances by varying p_amount. Only the
    -- balance-reading role receives the real comparison; office reads a constant.
    'amount_matches_open_balance', case when v_role = 'owner'
      then abs(round(v_open_balance, 2) - round(p_amount, 2)) <= 1
      else true end,
    -- bank_imports is not legal-entity scoped yet. Returning an organization-wide existence
    -- bit would leak sibling activity, so 0073 reports an explicit unavailable state and makes
    -- no bank query or approval decision from substitute data.
    'similar_bank_transfer_check', 'unavailable',
    'open_credit_total', v_open_credit_total,
    'over_allocated_invoice_count', v_over_allocated_count
  );
end
$$;

revoke all on function public.payment_request_financial_check_signals(uuid, numeric, uuid[], uuid)
  from public, anon;
grant execute on function public.payment_request_financial_check_signals(uuid, numeric, uuid[], uuid)
  to authenticated;

-- Re-pin the replaced body. Computed, never literal (the CRLF trap): md5 over prosrc with carriage
-- returns stripped, exactly as private.scope_definer_marker_violations() recomputes it.
insert into private.scope_definer_enforcements(
  function_signature, body_hash, enforcement_kind, scope_proof
)
select reviewed.signature, md5(replace(proc.prosrc, e'\r', '')), reviewed.kind, reviewed.proof
from (values
  ('payment_request_financial_check_signals(uuid,numeric,uuid[],uuid)', 'assert_unit',
    '0146 keeps 0073''s single-unit derivation and assert_unit_in_scope, and adds an allocation-fit count that reads no balance out.')
) reviewed(signature, kind, proof)
join pg_catalog.pg_proc proc on proc.oid = pg_catalog.to_regprocedure(reviewed.signature)
on conflict(function_signature) do update
set body_hash = excluded.body_hash,
    enforcement_kind = excluded.enforcement_kind,
    scope_proof = excluded.scope_proof;

-- Structural assertions: both replacements must leave the A1/A3/A5 surface clean.
do $assert_0146$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0146 scope assertions failed:\n%', v_violations;
  end if;
end
$assert_0146$;
