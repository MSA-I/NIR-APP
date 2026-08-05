-- Scope enforcement (wave 3, PLAN-03 §3.1).
--
-- 0054 built the vocabulary, 0055 the columns, 0056 the backfill. This migration turns the
-- third axis ON and proves it stays on:
--
--   1. The scope condition enters the BODY of the two balance functions -- the definer-layer
--      gap the security model marks as the real risk (they bypass RLS by design).
--   2. A RESTRICTIVE rider policy is stamped on every table the registry marks enforced.
--   3. A definer exemption registry records, with a reason each, every security definer
--      function that touches a scoped table but is deliberately NOT remediated this wave
--      (orchestrator decision, PLAN-03 §1.1: re-declaring ~50 functions in one wave is a
--      larger regression risk than the risk it prevents).
--   4. Three structural assertions (A1/A3/A5) fail this migration -- and every future
--      `db reset` that replays it -- if the contract ever regresses. The same checks are
--      installed as private.scope_enforcement_violations() so the p3 suite can prove they
--      actually detect weakened riders, unregistered tables and uncovered definers.
--
-- THE CANONICAL RIDER STRING -- pinned here, written to ENTERPRISE-SECURITY-MODEL.md §4:
--
--     ((unit_id IS NULL) OR (unit_id = ANY (auth_scopes())))
--
-- This exact form is the pg_get_expr(polqual, polrelid) normalization, derived empirically
-- against PostgreSQL before pinning (a `public.auth_scopes()` spelling deparses to the same
-- text while `public` is on the search_path, which A3 pins via SET search_path below).
-- It is the only accepted shape because it is InitPlan-liftable (auth_scopes() is stable and
-- argument-free, so the array is computed once per statement), `unit_id = any(...)` stays an
-- indexable ScalarArrayOpExpr against the 0055 (org_id, unit_id) indexes, and NULL stays
-- org-visible -- the backward-compatible reading of every pre-0055 row. A per-row helper
-- like unit_in_scope(unit_id) is explicitly forbidden (SECURITY-MODEL §5): definer +
-- SET search_path block SQL inlining, and the price is a real function call per row.
--
-- storage.objects is deliberately NOT touched: docs_storage_delete is pinned BY NAME in
-- supabase/tests/document_export_templates.sql:842-848. A storage rider, if one is ever
-- needed, is a separate policy under a distinct name -- never an edit of that one.

-- ===== 1. The scope condition inside the two balance functions =====
-- Re-declared from 0031:233 / 0031:277 ONLY -- the current declarations, which narrowed the
-- role gates. 0022:397/0022:440 is a silent-revert trap: copying from there would reopen
-- what 0031 closed (office lost balance access there, accountant became approved-only).
--
-- The injected test is the same canonical predicate the rider uses, INSIDE the definer body,
-- because SECURITY DEFINER functions never see RLS riders. The paid/credited CTEs take NO
-- unit predicate: payment_allocations and credit_requests are derived tables with no scope
-- column (ADR-0004 §4) -- their rows only ever surface through the invoice join below, and
-- the invoice row is where the scope decision belongs.
create or replace function public.p0_invoice_balance_rows()
returns table (
  invoice_id uuid,
  total_amount numeric(12,2),
  paid_amount numeric(12,2),
  credited_amount numeric(12,2),
  balance numeric(12,2)
)
language sql stable security definer set search_path = public as $$
  with paid as (
    select pa.org_id, pa.invoice_id, sum(pa.amount) as amount
    from public.payment_allocations pa
    where pa.org_id = auth_org() and pa.invoice_id is not null
    group by pa.org_id, pa.invoice_id
  ), credited as (
    select cr.org_id, cr.invoice_id, sum(cr.amount) as amount
    from public.credit_requests cr
    where cr.org_id = auth_org() and cr.invoice_id is not null
      and cr.status in ('offset','closed')
    group by cr.org_id, cr.invoice_id
  )
  select i.id,
         i.total_amount,
         coalesce(p.amount, 0)::numeric(12,2),
         coalesce(c.amount, 0)::numeric(12,2),
         (i.total_amount - coalesce(p.amount, 0) - coalesce(c.amount, 0))::numeric(12,2)
  from public.invoices i
  left join paid p on p.org_id = i.org_id and p.invoice_id = i.id
  left join credited c on c.org_id = i.org_id and c.invoice_id = i.id
  where i.org_id = auth_org() and i.deleted_at is null
    and (i.unit_id is null or i.unit_id = any(public.auth_scopes()))
    and (
      auth_role() in ('owner', 'kitchen')
      or (auth_role() = 'accountant' and i.review_status = 'approved')
      or (auth_role() = 'payer' and exists (
        select 1
        from public.payment_request_invoices pri
        join public.payment_requests pr
          on pr.org_id = pri.org_id and pr.id = pri.payment_request_id
        where pri.org_id = i.org_id and pri.invoice_id = i.id
          and pr.status in ('approved','sent_for_execution','executed','matched')
      ))
    )
$$;

-- DETERMINATION on the direct invoices join below (PLAN-03 §3.1.3 left it to the code; two
-- review reports disagreed): the join does NOT strictly require its own unit predicate.
-- Both output aggregates -- sum(b.balance) and count(b.invoice_id) -- draw exclusively from
-- the `balances` CTE, which is p0_invoice_balance_rows() and therefore already applies the
-- scope test (and the role gates). An out-of-scope invoice still joins `i`, but has no
-- matching `b` row, so it contributes NULL to both aggregates -- sum() ignores it and
-- count(b.invoice_id) does not count it. No out-of-scope value can reach the output.
-- The predicate is added anyway, for two reasons: (1) defense in depth -- the function's
-- scope containment no longer depends on the other function's WHERE clause surviving future
-- edits; (2) it makes the scope handling self-evident to A5's textual coverage check. It is
-- provably a no-op today: the predicate is identical to the one inside the CTE, so it
-- removes exactly the `i` rows that already had no `b` match.
create or replace function public.p0_supplier_balance_rows()
returns table (supplier_id uuid, open_balance numeric(12,2), open_invoices bigint)
language sql stable security definer set search_path = public as $$
  with balances as (
    select * from public.p0_invoice_balance_rows()
  )
  select s.id,
         coalesce(sum(b.balance), 0)::numeric(12,2),
         count(b.invoice_id) filter (where b.balance > 0)
  from public.suppliers s
  left join public.invoices i
    on i.org_id = s.org_id and i.supplier_id = s.id and i.deleted_at is null
   and (i.unit_id is null or i.unit_id = any(public.auth_scopes()))
  left join balances b on b.invoice_id = i.id
  where s.org_id = auth_org() and auth_role() in ('owner', 'kitchen', 'accountant')
  group by s.id
$$;

-- Grants: unchanged. 0022:457-460 revoked public/anon and granted authenticated; CREATE OR
-- REPLACE preserves the existing ACL on both functions.

-- ===== 2. The RESTRICTIVE riders =====
-- One rider per enforced registry row, named scope_rider_<table>, AS RESTRICTIVE so it is
-- ANDed against the existing permissive set -- zero edits to any existing (table, policy)
-- pair, the role axis untouched (ADR-0004). FOR ALL TO PUBLIC: the same condition governs
-- read and write for every RLS-subject role (service_role has BYPASSRLS and is unaffected;
-- the trusted-server CRUD contract in p0_client_dml_acl.sql keeps passing).
do $$
declare
  r record;
begin
  for r in
    select table_name from private.scope_registry where enforced order by table_name
  loop
    execute format(
      'create policy %I on public.%I as restrictive for all to public '
      || 'using ((unit_id is null) or (unit_id = any (auth_scopes())))',
      'scope_rider_' || r.table_name, r.table_name);
  end loop;
end
$$;

-- ===== 3. The definer exemption registry =====
-- Every SECURITY DEFINER function that touches an enforced table and is NOT remediated in
-- this wave is recorded here with a reason and its target wave. A5 (below) fails on any
-- such function that is neither scope-aware nor registered -- so a NEW definer touching a
-- scoped table cannot land silently. The preflight latch (p1_preflight.sql,
-- multi_unit_org_with_open_exemptions) closes the loop: while this registry is non-empty,
-- an organization growing a second sibling unit is a blocking anomaly, so the system cannot
-- reach the state in which these exemptions would actually leak (PLAN-03 §1.1). Draining
-- the registry is the multi-unit enablement wave's entry criterion.
--
-- Reason vocabulary:
--   rls-preread-single-unit  -- authenticated RPC; every org still holds exactly one unit
--                               per dimension, so its pre-reads cannot cross a sibling unit
--   service-role-trusted-path-- reachable only with the service key; scope is the trusted
--                               caller's responsibility until remediation
--   internal-only            -- no browser grant; called only from other definer commands
--   trigger-new-old-rows     -- trigger function acting solely on the firing row's NEW/OLD
--                               images (audit, guards, defaults); it cannot widen the set
--                               of rows the statement touched
--   delegating-wrapper       -- no scoped-table text of its own; delegates to a registered
--                               or remediated command
create table private.scope_definer_exemptions (
  function_signature text primary key,
  reason text not null,
  target_wave text not null
);
revoke all on table private.scope_definer_exemptions from public, anon, authenticated;

-- Seeded by NAME and resolved against pg_proc AT MIGRATION TIME: the stored key is the
-- pg_proc regprocedure rendering, so a signature that drifts (argument added, function
-- dropped) makes this seed -- or A5 -- fail loudly instead of leaving a stale row.
--
-- The inventory is the campaign's measured audit (PLAN-03 §1.1: 34 authenticated minus the
-- two balance functions remediated above, 8 service_role, 3 ungrated internals, 5 trigger
-- functions) PLUS the functions the live catalog scan surfaced beyond that audit:
-- file_document, p0_document_object_owned, record_document_export (authenticated
-- pre-readers), smart_document_source_checksum (ungrated internal), and six further
-- row-local trigger functions (audit_row_change, guard_tenant_identity,
-- reject_inventory_movement_mutation, audit_inventory_movement,
-- private.guard_purchase_order_whatsapp_sent, p0_set_default_unit). A5 is the ground truth;
-- the audit list is its floor, not its ceiling.
do $$
declare
  r record;
  v_matched int;
begin
  for r in
    select * from (values
      -- authenticated RPCs (single-unit orgs make their pre-reads scope-neutral today)
      ('refresh_invoice_payment_status',          'rls-preread-single-unit'),
      ('create_payment_request',                  'rls-preread-single-unit'),
      ('match_bank_transaction',                  'rls-preread-single-unit'),
      ('save_goods_receipt',                      'rls-preread-single-unit'),
      ('create_invoice',                          'rls-preread-single-unit'),
      ('set_invoice_review_status',               'rls-preread-single-unit'),
      ('create_invoice_credit_request',           'rls-preread-single-unit'),
      ('mark_month_export_sent',                  'rls-preread-single-unit'),
      ('transition_credit_request',               'rls-preread-single-unit'),
      ('record_inventory_movement',               'rls-preread-single-unit'),
      ('record_inventory_stocktake',              'rls-preread-single-unit'),
      ('reverse_inventory_movement',              'rls-preread-single-unit'),
      ('finalize_purchase_request_draft',         'rls-preread-single-unit'),
      ('claim_whatsapp_order_message',            'rls-preread-single-unit'),
      ('execute_payment_request',                 'rls-preread-single-unit'),
      ('transition_payment_request',              'rls-preread-single-unit'),
      ('soft_delete_invoice',                     'rls-preread-single-unit'),
      ('invoice_financial_check_signals',         'rls-preread-single-unit'),
      ('payment_request_financial_check_signals', 'rls-preread-single-unit'),
      ('p0_accountant_payment_request_ready',     'rls-preread-single-unit'),
      ('unmatch_bank_transaction',                'rls-preread-single-unit'),
      ('soft_delete_supplier',                    'rls-preread-single-unit'),
      ('cancel_purchase_order',                   'rls-preread-single-unit'),
      ('transition_purchase_order_status',        'rls-preread-single-unit'),
      ('reprocess_document',                      'rls-preread-single-unit'),
      ('p0_document_path_registered',             'rls-preread-single-unit'),
      ('supplier_price_document_owned',           'rls-preread-single-unit'),
      ('enqueue_document_processing',             'rls-preread-single-unit'),
      ('register_supplier_price_document',        'rls-preread-single-unit'),
      ('add_document_annotation',                 'rls-preread-single-unit'),
      ('add_document_review_correction',          'rls-preread-single-unit'),
      ('review_document_type',                    'rls-preread-single-unit'),
      ('file_document',                           'rls-preread-single-unit'),
      ('p0_document_object_owned',                'rls-preread-single-unit'),
      ('record_document_export',                  'rls-preread-single-unit'),
      -- service_role paths
      ('complete_whatsapp_order_message',         'service-role-trusted-path'),
      ('confirm_whatsapp_order',                  'service-role-trusted-path'),
      ('claim_whatsapp_confirmation_reminders',   'service-role-trusted-path'),
      ('begin_whatsapp_reminder_send',            'service-role-trusted-path'),
      ('claim_document_processing_job',           'service-role-trusted-path'),
      ('complete_document_processing_job',        'service-role-trusted-path'),
      ('begin_document_interpretation',           'service-role-trusted-path'),
      ('prepare_ocr_supplier_price_intake',       'service-role-trusted-path'),
      -- ungrated internals
      ('p1_refresh_invoice_payment_statuses',          'internal-only'),
      ('assert_supplier_price_interpretation_context', 'internal-only'),
      ('p1b_submit_supplier_price_list_internal',      'internal-only'),
      ('smart_document_source_checksum',               'internal-only'),
      -- trigger functions acting on the firing row only
      ('allocation_derive_org',                   'trigger-new-old-rows'),
      ('notify_duplicate_invoice_check',          'trigger-new-old-rows'),
      ('record_receipt_inventory_movements',      'trigger-new-old-rows'),
      ('documents_guard_columns',                 'trigger-new-old-rows'),
      ('sync_document_kind_from_review',          'trigger-new-old-rows'),
      ('audit_row_change',                        'trigger-new-old-rows'),
      ('guard_tenant_identity',                   'trigger-new-old-rows'),
      ('reject_inventory_movement_mutation',      'trigger-new-old-rows'),
      ('audit_inventory_movement',                'trigger-new-old-rows'),
      ('guard_purchase_order_whatsapp_sent',      'trigger-new-old-rows'),
      ('p0_set_default_unit',                     'trigger-new-old-rows'),
      -- reachable-but-textless wrappers (A5 cannot see them; registered for honesty and for
      -- the latch count -- delegates to execute_payment_request, which is registered above)
      ('execute_emergency_payment_request',       'delegating-wrapper')
    ) as t(fn_name, reason)
  loop
    insert into private.scope_definer_exemptions (function_signature, reason, target_wave)
    select p.oid::regprocedure::text, r.reason, 'multi-unit enablement wave'
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.proname = r.fn_name
      and p.prosecdef
    on conflict (function_signature) do nothing;
    get diagnostics v_matched = row_count;
    if v_matched = 0 then
      raise exception
        '0057: the exemption inventory names %, but no such security definer function exists',
        r.fn_name;
    end if;
  end loop;
end
$$;

-- ===== 4. A1 / A3 / A5 as a reusable report =====
-- Installed as a function rather than inlined in the assertion block so that the p3 suite
-- can prove, by mutation, that the SAME logic the migration enforces actually detects a
-- weakened rider, an unregistered table and an uncovered definer. SET search_path = public
-- also pins the pg_get_expr deparse: with `public` visible, auth_scopes() renders
-- unqualified, which is the form the canonical string pins.
create or replace function private.scope_enforcement_violations()
returns table (assertion text, detail text)
language sql stable set search_path = public as $$
  -- A1: every public base table is classified in the registry.
  select 'A1'::text, 'unclassified public table: ' || t.table_name
  from information_schema.tables t
  where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
    and not exists (select 1 from private.scope_registry r where r.table_name = t.table_name)
  union all
  -- A1 (staleness arm): a registry row that classifies a table that no longer exists.
  select 'A1'::text, 'registry row without a live table: ' || r.table_name
  from private.scope_registry r
  where not exists (
    select 1 from information_schema.tables t
    where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
      and t.table_name = r.table_name)
  union all
  -- A3: every enforced table carries scope_rider_<table>, RESTRICTIVE, FOR ALL, TO PUBLIC,
  -- and its USING expression deparses to EXACTLY the canonical string. A weakened rider --
  -- not only a missing one -- is a violation.
  select 'A3'::text, 'missing or non-canonical scope rider on: ' || r.table_name
  from private.scope_registry r
  where r.enforced
    and not exists (
      select 1
      from pg_catalog.pg_policy pol
      join pg_catalog.pg_class c on c.oid = pol.polrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = r.table_name
        and pol.polname = 'scope_rider_' || r.table_name
        and not pol.polpermissive
        and pol.polcmd = '*'
        and pol.polroles = '{0}'::oid[]
        and pg_catalog.pg_get_expr(pol.polqual, pol.polrelid)
              = '((unit_id IS NULL) OR (unit_id = ANY (auth_scopes())))')
  union all
  -- A5: every SECURITY DEFINER function (real prosecdef from pg_proc -- never a text match,
  -- 0012/0053 carry 'security definer' in comments) that references an enforced table by
  -- word boundary in its body OR is attached to one through pg_trigger must either be
  -- scope-aware (it calls assert_unit_in_scope, or filters by auth_scopes -- the correct
  -- remediation for set-returning reads like the balance functions) or hold an exemption
  -- row. Extension/system schemas are out of scope; ours are public and private.
  select 'A5'::text, 'uncovered security definer function: ' || p.oid::regprocedure::text
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and p.prosecdef
    and (
      exists (
        select 1 from private.scope_registry r
        where r.enforced and p.prosrc ~ ('\m' || r.table_name || '\M'))
      or exists (
        select 1
        from pg_catalog.pg_trigger tg
        join pg_catalog.pg_class c on c.oid = tg.tgrelid
        join pg_catalog.pg_namespace cn on cn.oid = c.relnamespace
        join private.scope_registry r on r.table_name = c.relname and r.enforced
        where cn.nspname = 'public'
          and not tg.tgisinternal
          and tg.tgfoid = p.oid))
    and p.prosrc !~ 'assert_unit_in_scope'
    and p.prosrc !~ 'auth_scopes'
    and not exists (
      select 1 from private.scope_definer_exemptions e
      where e.function_signature = p.oid::regprocedure::text)
$$;
revoke all on function private.scope_enforcement_violations() from public, anon, authenticated;

-- ===== 5. The assertions -- fail the migration, not the runtime =====
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0057 scope enforcement assertions failed:\n%', v_violations;
  end if;
end
$$;
