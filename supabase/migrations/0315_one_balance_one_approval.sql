-- 0315: one balance, one approval — and the last reader of a credit predicate that moved in 0173.
--
-- TWO anchored patches, ONE migration, on purpose. Both land on bodies that were themselves
-- written by anchored replacement (0231 for both commands, 0173 for the approval barrier's credit
-- term), and two anchored patches applied to the same body from two migrations land as one
-- silently winning. Neither changes a signature, so no open tab breaks; neither touches the unit
-- derivation or `assert_unit_in_scope`; both A5 enforcement rows are re-pinned from `pg_proc`
-- below, computed and never written as a literal.
--
-- (1) MON-01, under owner decision #350: an invoice's money is committed AT APPROVAL, not at
-- creation. `p1_transition_payment_request` already locks the request's invoice set in id order
-- before it recomputes — that part was right — but it recomputed the invoice balance as
-- `total − payments − applied credit` and nothing else. An invoice already carrying an approved,
-- unexecuted request was therefore measured as if that money were still available: 300.00 approved
-- against a 640.00 invoice was followed by 640.00 approved against the same invoice, and both
-- reached the accountant's execution queue, where `/pay`'s job is to RECORD a transfer the bank has
-- already made. The guard added here subtracts what `approved` and `sent_for_execution` requests
-- already hold on the same invoice, excludes the request being approved so a replay is not counted
-- against itself, and refuses the second arrival BY NAME — `payment_request_invoice_reserved` —
-- rather than through the generic `payment_request_checks_failed`, so a screen can say which
-- invoice is spoken for. Because the invoices are locked first, two approvals racing on one invoice
-- serialise here: the second waits, re-reads the winner's committed status, and loses.
-- `executed` and `matched` are deliberately NOT in the reserving set — their money is already in
-- `payment_allocations` and counting it twice would refuse a legitimate remainder.
-- Creation stays untouched: #350 rules that a second request may be typed, and is refused only
-- when a person decides. Splitting stays legal — 250 + 390 against 640 leaves the remainder
-- non-negative at both approvals; only the excess is blocked.
--
-- (2) `docs/DEBT-REGISTER.md` §119: `create_payment_request` is the last reader of the credit
-- predicate 0173 retired. That migration moved the invoice-balance reader and
-- `execute_payment_request` off `credit_requests.status in ('offset','closed')` and onto the money
-- actually allocated to the credit; this command was not converted with them. A PARTIALLY consumed
-- credit stays `received`, so the writer subtracted NOTHING where the reader subtracts what was
-- applied — and the writer then admitted an allocation above the balance the product had just
-- printed. The replacement below is the same one 0173 made at
-- `0173_partial_credit_allocations.sql:292-307`, applied to the one body it missed.

do $patch_approval_reservation_0315$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.p1_transition_payment_request(uuid,text,text,boolean,text,uuid,numeric)'::regprocedure),
    e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  -- Anchored on the END of the existing barrier plus the supplier lock that follows it. The
  -- refusal string alone appears twice in this body; the pair appears once, and the count is
  -- asserted rather than assumed.
  v_anchor := $anchor$    ) then
      raise exception 'payment_request_checks_failed' using errcode = 'P0001';
    end if;

    perform 1
    from public.suppliers s$anchor$;
  v_replacement := $replacement$    ) then
      raise exception 'payment_request_checks_failed' using errcode = 'P0001';
    end if;

    -- #350. Only `approved` and `sent_for_execution` hold an invoice's money. The invoice set is
    -- already locked in id order above, so a second approver blocks here, then re-reads the
    -- winner's committed status under a fresh statement snapshot and is refused by name.
    -- First committer wins, and the loser learns it when a person decides rather than when one types.
    if exists (
      select 1
      from public.payment_request_invoices pri
      join public.invoices i on i.org_id = pri.org_id and i.id = pri.invoice_id
      where pri.org_id = v_org and pri.payment_request_id = v_request.id
        and round(pri.amount_allocated, v_minor_units) > round(
          i.total_amount
          - coalesce((select sum(pa.amount) from public.payment_allocations pa
                      where pa.org_id = i.org_id and pa.invoice_id = i.id), 0)
          - coalesce((select sum(pa.amount) from public.payment_allocations pa
                      join public.credit_requests cr
                        on cr.org_id = pa.org_id and cr.id = pa.credit_id
                      where cr.org_id = i.org_id and cr.invoice_id = i.id), 0)
          - coalesce((select sum(held.amount_allocated)
                      from public.payment_request_invoices held
                      join public.payment_requests holder
                        on holder.org_id = held.org_id and holder.id = held.payment_request_id
                      where held.org_id = v_org and held.invoice_id = i.id
                        and held.payment_request_id <> v_request.id
                        and holder.status in ('approved', 'sent_for_execution')), 0),
          v_minor_units
        )
    ) then
      raise exception 'payment_request_invoice_reserved' using errcode = 'P0001';
    end if;

    perform 1
    from public.suppliers s$replacement$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0315: approval reservation anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_approval_reservation_0315$;

do $patch_create_partial_credit_0315$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.create_payment_request(uuid,uuid,date,text,text,jsonb,text)'::regprocedure),
    e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  -- §119. The writer's last lifecycle-label credit term, replaced with the money actually applied
  -- — the same expression the reader (`p0_invoice_balance_rows`) and `execute_payment_request`
  -- have used since 0173. A credit allocation carries a null `invoice_id` (0234:107-111), so this
  -- does not double-subtract against the payments term above it.
  v_anchor := $anchor$         - coalesce((select sum(cr.amount) from public.credit_requests cr
                     where cr.invoice_id = i.id and cr.status in ('offset', 'closed')), 0),$anchor$;
  v_replacement := $replacement$         - coalesce((select sum(pa.amount) from public.payment_allocations pa
                     join public.credit_requests cr
                       on cr.org_id = pa.org_id and cr.id = pa.credit_id
                     where cr.invoice_id = i.id), 0),$replacement$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0315: create partial-credit anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_create_partial_credit_0315$;

-- A5: both bodies changed, so their pinned hashes are recomputed here or every later migration
-- fails with "stale scope enforcement registration". Read from pg_proc, never written as a literal.
update private.scope_definer_enforcements enforcement
set body_hash = md5(replace(proc.prosrc, e'\r', '')),
    scope_proof = case enforcement.function_signature
      when 'create_payment_request(uuid,uuid,date,text,text,jsonb,text)'
        then '0315 keeps the 0231 currency derivation, the tenant/supplier/unit fences and '
          || 'assert_unit_in_scope, and replaces the last lifecycle-label credit total with the '
          || 'payment_allocations actually applied, as 0173 did for the reader and the executor.'
      else '0315 keeps the 0073 request lock, the id-ordered invoice lock and assert_unit_in_scope, '
        || 'and subtracts only same-tenant payment_request_invoices held by approved or '
        || 'sent_for_execution requests on the same invoice.' end
from pg_proc proc
where (proc.oid = 'public.create_payment_request(uuid,uuid,date,text,text,jsonb,text)'::regprocedure
       and enforcement.function_signature = 'create_payment_request(uuid,uuid,date,text,text,jsonb,text)')
   or (proc.oid = 'public.p1_transition_payment_request(uuid,text,text,boolean,text,uuid,numeric)'::regprocedure
       and enforcement.function_signature = 'p1_transition_payment_request(uuid,text,text,boolean,text,uuid,numeric)');

do $assert_0315$
declare v_violations text;
begin
  if position('payment_request_invoice_reserved' in (select prosrc from pg_proc where oid =
       'public.p1_transition_payment_request(uuid,text,text,boolean,text,uuid,numeric)'::regprocedure)) = 0 then
    raise exception '0315: the approval command does not refuse a reserved invoice by name'; end if;
  -- The sentinel is a property this patch CREATES, never one the body already had: the join onto
  -- payment_allocations by credit_id inside the create command. Testing for the ABSENCE of the old
  -- predicate would pass on a body that never carried it.
  if position('on cr.org_id = pa.org_id and cr.id = pa.credit_id' in (select prosrc from pg_proc where oid =
       'public.create_payment_request(uuid,uuid,date,text,text,jsonb,text)'::regprocedure)) = 0 then
    raise exception '0315: the create command still measures credit by lifecycle label'; end if;
  if position($old$cr.status in ('offset', 'closed')$old$ in (select prosrc from pg_proc where oid =
       'public.create_payment_request(uuid,uuid,date,text,text,jsonb,text)'::regprocedure)) <> 0 then
    raise exception '0315: the retired credit predicate survives in the create command'; end if;
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then raise exception e'0315 scope failed:\n%', v_violations; end if;
end
$assert_0315$;

comment on function public.p1_transition_payment_request(uuid,text,text,boolean,text,uuid,numeric) is
  'Payment-request transition command. 0315: approval is where an invoice''s money is committed '
  '(#350) — the locked invoice set is recomputed against what approved and sent_for_execution '
  'requests already hold, and a second arrival is refused with payment_request_invoice_reserved.';
