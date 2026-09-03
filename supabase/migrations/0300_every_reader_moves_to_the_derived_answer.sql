-- 0300 — every database reader moves onto the derived answer. Wave 6, step 2 of three.
--
-- `0299` gave the derived answer a name and changed nothing else. This step moves the eight
-- database readers of `invoices.payment_status` onto `private.invoice_payment_state(...)`, and
-- deliberately does NOT touch the write path: the column is still written by
-- `p1_refresh_invoice_payment_statuses` and still agrees with the derived answer everywhere
-- except the one row `0299`'s self-check already reported.
--
-- WHY THAT SPLIT IS THE WHOLE POINT. A step that moved the readers AND stopped the writer would
-- have no way back: a mis-ported reader and a missing column would arrive together and the
-- symptom would not say which caused it. Here the column is still there and still correct, so
-- any reader this migration got wrong is a one-line revert against a working baseline. Step 3 —
-- which removes the writer and the column — refuses to run while `private.p1_payment_status_drift()`
-- returns anything, and is not in this file.
--
-- THE READERS, all eight read from their LIVE bodies rather than from the migrations that created
-- them: `soft_delete_invoice`, `private.assert_invoice_supporting_conversion`,
-- `private.document_removal_impact`, `reverse_invoice_three_way_approval_consumption`,
-- `invoice_financial_check_signals`, `create_monthly_report_snapshot`,
-- `get_consolidated_invoice_workspace` and `global_search`. There is no policy, no constraint and
-- no view over the column — measured, not assumed.
--
-- ONE READER NEEDED A DIFFERENT SHAPE, and it is the kind of thing only reading the live body
-- finds. `create_monthly_report_snapshot` reads from a materialized CTE whose row type is
-- `invoices` PLUS two joined columns, so the row-form overload does not typecheck there; that is
-- why `0299` declared the four-argument form as the real one and the row form as a delegate.
--
-- THREE PINNED BODIES MOVE and their hashes move with them, in this file:
-- `reverse_invoice_three_way_approval_consumption`, `create_monthly_report_snapshot` and
-- `get_consolidated_invoice_workspace`. A rewrite that leaves a pin behind fails the scope
-- assertions rather than shipping — that is the guard working, and re-pinning is the deliberate
-- act of saying the new body was looked at.
--
-- STILL OUTSTANDING AFTER THIS FILE, and named so it is not discovered later: the eleven client
-- screens still read the stored column. They keep working, because it is still written. They are
-- step 3's precondition, and the file:line inventory is in
-- `artifacts/w6/migration-requests/w6-money.sql`.

-- STEP 2 — MOVE EVERY READER ONTO THE DERIVED ANSWER. THE COLUMN IS STILL WRITTEN.
--
-- WHY THIS IS SAFE ON ITS OWN: the write path is untouched and the column still exists, so any
-- reader that is mis-ported can be reverted by a one-line patch back to `payment_status`, and
-- `private.p1_payment_status_drift()` from STEP 1 still proves the two agree while the porting
-- happens. Nothing is dropped in this step. It is the step that must NOT also remove the write
-- path — a step that changed both would leave no reference to compare against.
--
-- THE CLIENT HALF SHIPS IN THE SAME MERGE AS THIS MIGRATION AND NOT BEFORE. `select('*,
-- invoice_payment_state')` against a database without STEP 1 returns HTTP 400, so the eleven
-- screens listed in the header cannot be converted on a branch that does not carry STEP 1.
-- #############################################################################################

-- --- 2a. `soft_delete_invoice` — the guard that blocks deleting an invoice money touched. ------
do $patch_soft_delete$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.soft_delete_invoice(uuid,text)'::regprocedure), e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  v_anchor := e'  if v_invoice.payment_status <> \'unpaid\'\n'
    || e'     or v_invoice.export_status <> \'not_sent\'';
  v_replacement := e'  if private.invoice_payment_state(v_invoice) <> \'unpaid\'\n'
    || e'     or v_invoice.export_status <> \'not_sent\'';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
             / length(v_anchor);
  if v_count <> 1 then raise exception 'w6/step2: soft_delete anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_soft_delete$;

-- --- 2b. `private.assert_invoice_supporting_conversion`. ---------------------------------------
-- Note this body ALREADY tests `exists (select 1 from payment_allocations a where
-- a.invoice_id = ...)` two lines later, so the stored test was mostly redundant — except that
-- the existing `exists` misses a credit-only offset, which the derived state catches.
do $patch_supporting$
declare
  v_definition text := replace(pg_get_functiondef(
    'private.assert_invoice_supporting_conversion(uuid)'::regprocedure), e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  v_anchor := e'  if v_invoice.payment_status <> \'unpaid\'\n'
    || e'     or v_invoice.review_status = \'approved\'';
  v_replacement := e'  if private.invoice_payment_state(v_invoice) <> \'unpaid\'\n'
    || e'     or v_invoice.review_status = \'approved\'';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
             / length(v_anchor);
  if v_count <> 1 then raise exception 'w6/step2: supporting anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_supporting$;

-- --- 2c. `private.document_removal_impact` — the `invoice_paid` blocker. ------------------------
do $patch_removal_impact$
declare
  v_definition text := replace(pg_get_functiondef(
    'private.document_removal_impact(uuid,uuid)'::regprocedure), e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  v_anchor := e'        if v_invoice.payment_status <> \'unpaid\' then';
  v_replacement := e'        if private.invoice_payment_state(v_invoice) <> \'unpaid\' then';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
             / length(v_anchor);
  if v_count <> 1 then raise exception 'w6/step2: removal impact anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_removal_impact$;
-- `get_document_removal_impact(uuid)` is the PINNED public wrapper and its body does not change,
-- so its hash does not move. Only the private helper is patched.

-- --- 2d. `reverse_invoice_three_way_approval_consumption` — PINNED. ----------------------------
do $patch_reversal$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.reverse_invoice_three_way_approval_consumption(uuid,text)'::regprocedure), e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  v_anchor := e'  if v_invoice.payment_status <> \'unpaid\'\n'
    || e'     or v_invoice.export_status <> \'not_sent\'';
  v_replacement := e'  if private.invoice_payment_state(v_invoice) <> \'unpaid\'\n'
    || e'     or v_invoice.export_status <> \'not_sent\'';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
             / length(v_anchor);
  if v_count <> 1 then raise exception 'w6/step2: reversal anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_reversal$;
update private.scope_definer_enforcements
set body_hash = md5(replace((select prosrc from pg_proc
      where oid = 'public.reverse_invoice_three_way_approval_consumption(uuid,text)'::regprocedure),
    e'\r', ''))
where function_signature = 'reverse_invoice_three_way_approval_consumption(uuid,text)';

-- --- 2e. `invoice_financial_check_signals` — THE THIRD ANSWER, retired. -------------------------
-- Both arms now come from the same expression. The office arm keeps reading a LABEL and gains
-- no number, which is the boundary the body's own comment draws; the owner/accountant arm stops
-- computing a private balance with a credit rule nobody else uses.
do $patch_check_signals$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.invoice_financial_check_signals(uuid)'::regprocedure), e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  v_anchor := e'    select v_invoice.total_amount\n'
    || e'           - coalesce((select sum(pa.amount) from public.payment_allocations pa\n'
    || e'                       where pa.org_id = v_org and pa.invoice_id = v_invoice.id), 0)\n'
    || e'           - coalesce((select sum(cr.amount) from public.credit_requests cr\n'
    || e'                       where cr.org_id = v_org and cr.invoice_id = v_invoice.id\n'
    || e'                         and cr.status in (\'offset\', \'closed\')), 0)\n'
    || e'      into v_balance;\n'
    || e'    v_already_paid := v_balance <= 0;';
  v_replacement :=
       e'    -- 0219 gave this function its own balance, with its own credit rule: the SUM OF THE\n'
    || e'    -- CREDIT REQUESTS in state offset/closed, rather than the credit ALLOCATIONS every\n'
    || e'    -- other surface counts. On invoice 3377 the two disagreed by 150 ILS. One answer now.\n'
    || e'    v_already_paid := private.invoice_payment_state(v_invoice) = \'paid\';';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
             / length(v_anchor);
  if v_count <> 1 then raise exception 'w6/step2: check signals anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := e'    v_already_paid := v_invoice.payment_status = \'paid\';';
  v_replacement := e'    v_already_paid := private.invoice_payment_state(v_invoice) = \'paid\';';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
             / length(v_anchor);
  if v_count <> 1 then
    raise exception 'w6/step2: check signals office anchor count %', v_count;
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- `v_balance` becomes unused. Removing its declaration keeps the body honest.
  v_anchor := e'  v_balance numeric;\n';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
             / length(v_anchor);
  if v_count <> 1 then raise exception 'w6/step2: check signals decl anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, '');
end
$patch_check_signals$;

-- --- 2f. `create_monthly_report_snapshot` — PINNED. --------------------------------------------
-- The snapshot's JSON KEY NAMES DO NOT CHANGE. `monthlyReport.ts` reads `payment_status` and
-- `payment_status_label` out of stored snapshots that already exist and are immutable; renaming
-- the key would make every historical snapshot unreadable. Only the SOURCE of the value moves.
do $patch_snapshot$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.create_monthly_report_snapshot(date,uuid)'::regprocedure), e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  -- `i` here is the `invoice_source` CTE, whose row type is `invoices` PLUS `supplier_name` and
  -- `legal_entity_id`, so the ROW overload would not typecheck. The four-argument form is used
  -- for exactly this reason; it is why that overload exists.
  v_anchor := e'        \'payment_status\', i.payment_status,\n'
    || e'        \'payment_status_label\', case i.payment_status::text';
  v_replacement := e'        \'payment_status\', private.invoice_payment_state(i.org_id, i.id, i.total_amount, i.currency),\n'
    || e'        \'payment_status_label\', case private.invoice_payment_state(i.org_id, i.id, i.total_amount, i.currency)::text';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
             / length(v_anchor);
  if v_count <> 1 then raise exception 'w6/step2: snapshot rows anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := e'          else i.payment_status::text end';
  v_replacement := e'          else private.invoice_payment_state(i.org_id, i.id, i.total_amount, i.currency)::text end';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
             / length(v_anchor);
  if v_count <> 1 then raise exception 'w6/step2: snapshot else anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := e'      count(*) filter (where i.payment_status <> \'paid\')::integer as unpaid_count';
  v_replacement := e'      count(*) filter (where private.invoice_payment_state(i.org_id, i.id, i.total_amount, i.currency) <> \'paid\')::integer as unpaid_count';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
             / length(v_anchor);
  if v_count <> 1 then raise exception 'w6/step2: snapshot count anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_snapshot$;
update private.scope_definer_enforcements
set body_hash = md5(replace((select prosrc from pg_proc
      where oid = 'public.create_monthly_report_snapshot(date,uuid)'::regprocedure), e'\r', ''))
where function_signature = 'create_monthly_report_snapshot(date,uuid)';
-- PERFORMANCE NOTE, MEASURED NOWHERE YET: the snapshot's row builder now calls the derived
-- expression per invoice, three times per row. Fold it into a lateral once if the monthly
-- snapshot is measured slower; do not fold it before it is measured.

-- --- 2g. `get_consolidated_invoice_workspace` — PINNED. ---------------------------------------
do $patch_workspace$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.get_consolidated_invoice_workspace(uuid)'::regprocedure), e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  v_anchor := e'\'review_status\',invoice.review_status,\'payment_status\',invoice.payment_status';
  v_replacement := e'\'review_status\',invoice.review_status,'
    || e'\'payment_status\',private.invoice_payment_state(invoice)';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
             / length(v_anchor);
  if v_count <> 1 then raise exception 'w6/step2: workspace anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_workspace$;
update private.scope_definer_enforcements
set body_hash = md5(replace((select prosrc from pg_proc
      where oid = 'public.get_consolidated_invoice_workspace(uuid)'::regprocedure), e'\r', ''))
where function_signature = 'get_consolidated_invoice_workspace(uuid)';

-- --- 2h. `global_search`. ----------------------------------------------------------------------
do $patch_global_search$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.global_search(text,integer)'::regprocedure), e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  v_anchor := e'            i.payment_status::text, i.total_amount, i.currency, i.invoice_date,';
  v_replacement := e'            private.invoice_payment_state(i)::text, i.total_amount, i.currency, i.invoice_date,';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
             / length(v_anchor);
  if v_count <> 1 then raise exception 'w6/step2: global_search anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_global_search$;

-- --- 2i. STEP 2 self-check. --------------------------------------------------------------------
do $assert_step2$
declare
  v_violations text;
  v_left integer;
begin
  -- Not one product reader may still READ the column. The writer and its wrapper still do, by
  -- design: they are STEP 3's job, and naming them here is what makes this step separable.
  --
  -- A COLUMN READ, not the word. The first version of this assertion matched `payment_status`
  -- anywhere in a body and refused the migration over two bodies that were already correct:
  -- `create_monthly_report_snapshot` and `get_consolidated_invoice_workspace` each emit
  -- `'payment_status'` as a JSON KEY in the shape they return. That key is an output name every
  -- consumer of the snapshot and the workspace depends on — renaming it would be the breaking
  -- change this whole teardown is arranged to avoid. So the test is a qualified column
  -- reference, which is what all eight readers used and what none of them uses now (measured:
  -- both bodies show zero column reads and one JSON key each).
  select count(*) into v_left
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where p.prokind in ('f','p') and n.nspname in ('public','private')
    and p.prosrc ~ '[A-Za-z_]+\.payment_status\M'
    and p.oid::regprocedure::text not in (
      'p1_refresh_invoice_payment_statuses(uuid,uuid[])',
      'refresh_invoice_payment_status(uuid)',
      'private.invoice_payment_state(invoices)',
      'private.invoice_payment_state(uuid,uuid,numeric,text)',
      'private.p1_payment_status_drift()');
  if v_left > 0 then
    raise exception 'w6/step2: % function(s) still read invoices.payment_status', v_left;
  end if;
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'w6/step2 scope failed:\n%', v_violations;
  end if;
end
$assert_step2$;


-- #############################################################################################
