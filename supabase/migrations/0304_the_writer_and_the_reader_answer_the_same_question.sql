-- 0304 — the writer and the readers now compute the same answer. Codex review round 1, finding 6.
--
-- WHAT THE REVIEW CAUGHT, and it is a defect in my sequencing rather than in either expression.
-- `0300` moved eight database readers onto `private.invoice_payment_state(...)` and its header
-- claimed the stored column "still agrees with the derived answer everywhere except the one row
-- 0299's self-check reported". **That was true of the current data and false in general**, and
-- `0299`'s own comment says why in two places:
--
--   * TOLERANCE. The writer settles on a bare `<= 1` — one unit of whatever currency the invoice
--     is in. The derived answer asks `private.money_tolerance`, which is 1.00 for a two-decimal
--     currency and something else for every other. A JPY invoice with 50 remaining would be
--     written `partial` and read `paid`; a three-decimal currency goes the other way.
--   * CREDIT. The writer's second arm tests CASH alone, so an invoice reduced only by a partial
--     credit is written `unpaid`. The derived answer tests cash OR credit and calls it `partial`
--     — deliberately, because money has demonstrably moved against that invoice.
--
-- The demo tenant is shekel-only and holds no partially-credited invoice, so the drift query
-- returned exactly one row and the disagreement stayed invisible. It would have appeared in
-- production the first time either shape occurred, with the readers already moved.
--
-- THE FIX IS THE ORDER THE REVIEW PROPOSED, and it is better than what I did: make the WRITER
-- compute the derived answer, so the column and the readers agree by construction rather than by
-- coincidence. `private.p1_payment_status_drift()` then has nothing to report by definition, and
-- step 3 — which refuses to run while that query returns anything — becomes reachable.
--
-- WHAT THIS CHANGES IN STORED DATA, because it is a change and not a no-op:
--   * a partially-credited invoice with no cash moves from `unpaid` to `partial`. That is the
--     correction, not a side effect: something was paid against it.
--   * an invoice in a currency whose minor units are not 2 settles on that currency's own
--     threshold instead of on one bare unit.
--   * nothing else. For a shekel invoice reduced by cash the two expressions are identical, which
--     is why the eleven client screens still reading the column see no movement.
--
-- MEASURE BEFORE APPLYING TO PRODUCTION. The verify block below prints how many rows the refresh
-- would move and asserts the two answers agree afterwards; on production, read that number before
-- accepting it. It is not a silent clamp — it is the stored label catching up with the ledger.
--
-- ANCHORED, NOT REDECLARED. `0001` created this body and it has been patched since; the anchor is
-- read from `pg_get_functiondef` with the carriage returns stripped, because a body applied from
-- Windows carries CRLF and one applied on a Linux runner does not.

do $patch_refresh_0304$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.p1_refresh_invoice_payment_statuses(uuid,uuid[])'::regprocedure), e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  if position('invoice_payment_state' in v_definition) > 0 then
    return; -- already agreed; this migration is being re-applied
  end if;

  v_anchor := $anchor$  update invoices i
  set payment_status = case
    when i.total_amount
         - coalesce((select sum(pa.amount) from payment_allocations pa where pa.invoice_id = i.id), 0)
         - coalesce((select sum(pa.amount) from payment_allocations pa
                     join credit_requests cr on cr.org_id = pa.org_id and cr.id = pa.credit_id
                     where cr.invoice_id = i.id), 0) <= 1
      then 'paid'::invoice_payment_status
    when coalesce((select sum(pa.amount) from payment_allocations pa where pa.invoice_id = i.id), 0) > 0
      then 'partial'::invoice_payment_status
    else 'unpaid'::invoice_payment_status
  end
  where i.org_id = p_org and i.id = any(coalesce(p_invoice_ids, '{}'::uuid[]));$anchor$;
  v_replacement := $replacement$  -- ONE EXPRESSION, not two. Until 0304 this arm computed its own answer -- a bare `<= 1`
  -- tolerance and a cash-only test for `partial` -- while the eight readers 0300 moved were
  -- asking `private.invoice_payment_state`. The two agreed for a shekel invoice reduced by cash
  -- and disagreed for every other shape, which is a drift waiting for a currency or a credit.
  update invoices i
  set payment_status = private.invoice_payment_state(i.org_id, i.id, i.total_amount, i.currency)
  where i.org_id = p_org and i.id = any(coalesce(p_invoice_ids, '{}'::uuid[]));$replacement$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0304: refresh body anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_refresh_0304$;

comment on function public.p1_refresh_invoice_payment_statuses(uuid,uuid[]) is
  'Writes the stored invoices.payment_status. From 0304 it writes exactly '
  'private.invoice_payment_state(...) -- the same expression the readers use -- so the column and '
  'the derived answer cannot drift apart while step 3 of the teardown is still outstanding. '
  'Before 0304 it settled on a bare `<= 1` and tested cash alone for `partial`, which agreed with '
  'the readers only for a shekel invoice reduced by cash.';

-- The stored labels catch up with the ledger. Bounded to the drifted rows rather than the whole
-- table: a full-table refresh would rewrite `updated_at` on every invoice in every tenant and
-- make an audit trail out of a no-op.
do $reconcile_0304$
declare
  v_before integer;
  v_after integer;
begin
  select count(*) into v_before from private.p1_payment_status_drift();
  raise notice '0304: % invoice(s) where the stored label disagreed with the ledger', v_before;

  perform public.p1_refresh_invoice_payment_statuses(drift.org_id, array_agg(drift.invoice_id))
  from private.p1_payment_status_drift() drift
  group by drift.org_id;

  select count(*) into v_after from private.p1_payment_status_drift();
  if v_after <> 0 then
    raise exception '0304: % invoice(s) still disagree after the refresh', v_after;
  end if;
  raise notice '0304: the stored label and the ledger now agree on every invoice';
end
$reconcile_0304$;

do $assert_0304$
declare
  v_source text := (select prosrc from pg_proc
                    where oid = 'public.p1_refresh_invoice_payment_statuses(uuid,uuid[])'::regprocedure);
  v_violations text;
begin
  if position('invoice_payment_state' in v_source) = 0 then
    raise exception '0304: the writer still computes its own answer';
  end if;
  -- The old arithmetic must be gone, not merely wrapped. Tested by the STATUS CASTS rather than
  -- by the `<= 1` literal: the first version of this assertion looked for that literal and fired
  -- on the migration's own explanatory comment, which quotes it. An assertion that a comment can
  -- trip is an assertion about prose. The casts are the arithmetic — the old body built its
  -- answer from three `::invoice_payment_status` arms and the new one calls a function that
  -- returns the type already.
  if position('invoice_payment_status' in v_source) <> 0 then
    raise exception '0304: the writer still casts its own status arms';
  end if;
  if (select count(*) from private.p1_payment_status_drift()) <> 0 then
    raise exception '0304: the writer and the readers still disagree';
  end if;

  select string_agg(assertion || ' -- ' || detail, chr(10) order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception '0304 scope assertions failed:%', chr(10) || v_violations;
  end if;
end
$assert_0304$;
