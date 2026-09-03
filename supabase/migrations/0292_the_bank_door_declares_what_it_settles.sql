-- 0292 — nobody settles an unapproved invoice quietly. Owner decision C, and RC1 of the
-- 2026-09-03 remediation plan.
--
-- WHAT WAS WRONG. `match_bank_transaction` has two branches. The DIRECT branch creates a payment
-- from a bank line and allocates it straight to invoices; its only approval condition was
--
--     or (v_role = 'accountant' and i.review_status <> 'approved')
--
-- which refuses the ACCOUNTANT and waves the OWNER through. That is backwards twice over. Reading
-- money that already left the account into the ledger is the accountant's job, and it is the owner
-- who was able to settle an invoice nobody approved — with nothing anywhere saying it happened.
--
-- WHAT THE MEASUREMENT SAID, so this file does not do more than it must. W0-G10 unioned direct
-- allocations and indirect ones over production, split by approval state: exactly ONE unapproved
-- settlement exists, invoice 6633 at 2,950 ILS, created by the QA agent that demonstrated the gap.
-- The `via_payment` branch shows zero. So this is "close the door", not "close the door and repair
-- a population"; there is no backfill here and none is needed.
--
-- A CORRECTION TO THE PLAN'S OWN WORDING, made against the live bodies rather than the migrations
-- that created them. The plan said the payment-request path "rejects unapproved invoices with no
-- role condition". The live `execute_payment_request` in fact carries
-- `((v_role = 'accountant' or v_emergency) and i.review_status <> 'approved')` — the same
-- owner-shaped hole. The role-blind rejection is one step earlier, in the live
-- `p1_transition_payment_request`, which refuses to move a request to `approved` unless EVERY
-- invoice on it is approved, for every role. That is why the request path is trustworthy and the
-- bank path was not: the request path has an upstream gate, and the bank path had none.
--
-- THE FIX IS A DECLARATION, NOT A REFUSAL. Recording is never blocked; blocking it would make the
-- ledger less true and strand the transaction. Instead:
--
--   * the accountant-only condition goes, so the direct branch treats both roles the same;
--   * a match is classified TRUSTED or RECORDING;
--   * every RECORDING settlement of an invoice that is not `approved` opens an
--     `unapproved_invoice_settled` exception (`0291`) IN THE SAME TRANSACTION as the allocations,
--     so a settlement and its exception can never disagree.
--
-- TRUSTED means the product itself paid: the payment carries a payment request, that request is
-- `executed` (or `matched` on replay — bank matching moves `executed` to `matched` a few lines
-- below), an execution audit row names THIS payment, and every invoice the payment allocates to is
-- on that request. A payment sitting beside a still-`approved` request is a suspicious shape, not
-- a trusted one, and does not qualify. Everything else — standalone, legacy, service-role or
-- migration-created — is RECORDING and is declared.
--
-- THE ROLE MATRIX, stated explicitly because this widens a permission that was explicitly closed:
--
--   | branch          | owner | accountant | anyone else | unapproved invoice          |
--   |-----------------|-------|------------|-------------|-----------------------------|
--   | direct          | yes   | yes        | not_authorized | allowed, exception opened |
--   | existing payment| yes   | yes        | not_authorized | allowed, exception opened unless trusted |
--
-- `owner`/`accountant` was already the function's entry condition and does not change here; what
-- changes is that the accountant is no longer singled out inside the direct branch.
--
-- ANCHORED, NOT REDECLARED. `0023` created this body; `0031`, `0034` and `0232` have each patched
-- the live one since. Re-declaring from `0023` would silently roll all three back — the failure
-- this repository has already paid for eight times. So the live body is read, each anchor is
-- asserted to appear exactly once, and only those places change. `e'\r'` is stripped on read
-- because a body applied from Windows carries CRLF and one applied on CI does not.

do $patch_bank_match_0292$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.match_bank_transaction(uuid,uuid,uuid,uuid,jsonb,numeric,text)'::regprocedure), e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  -- 1. One more local: whether this match is a RECORDING. Direct matches never carry a request, so
  --    the default is the honest one and only the existing-payment branch can lower it.
  v_anchor := e'  v_invoice_ids uuid[] := \'{}\'::uuid[];\nbegin';
  v_replacement := e'  v_invoice_ids uuid[] := \'{}\'::uuid[];\n'
    || e'  v_recording boolean := true;\nbegin';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0292: declaration anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- 2. Classify the existing-payment branch BEFORE the request is moved to `matched`, so the test
  --    is the request's state at match time. `matched` is accepted too: a replay re-enters here
  --    after the first run already moved it.
  v_anchor := $anchor$
    if v_payment.payment_request_id is not null then
      update payment_requests
      set status = 'matched'
      where id = v_payment.payment_request_id
        and org_id = v_org
        and status = 'executed';
    end if;$anchor$;
  v_replacement := $replacement$
    if v_payment.payment_request_id is not null then
      v_recording := not exists (
        select 1
        from payment_requests pr
        where pr.id = v_payment.payment_request_id
          and pr.org_id = v_org
          and pr.status in ('executed', 'matched')
          and exists (
            select 1
            from audit_logs a
            where a.org_id = v_org
              and a.entity_type = 'payment_requests'
              and a.entity_id = pr.id
              and a.action in ('payment_request_executed', 'payment_request_emergency_executed')
              and a.new_values ->> 'payment_id' = v_payment.id::text
          )
          and not exists (
            select 1
            from payment_allocations pa
            where pa.payment_id = v_payment.id
              and pa.invoice_id is not null
              and not exists (
                select 1
                from payment_request_invoices pri
                where pri.org_id = v_org
                  and pri.payment_request_id = pr.id
                  and pri.invoice_id = pa.invoice_id
              )
          )
      );

      update payment_requests
      set status = 'matched'
      where id = v_payment.payment_request_id
        and org_id = v_org
        and status = 'executed';
    end if;$replacement$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0292: trusted classification anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- 3. The accountant-only approval condition goes. Recording is not refused for either role.
  v_anchor := $anchor$
      where i.id is null or i.org_id <> v_org or i.supplier_id <> v_supplier
         or i.deleted_at is not null
         or (v_role = 'accountant' and i.review_status <> 'approved')
         or round(a.amount,v_minor_units)>round($anchor$;
  v_replacement := $replacement$
      where i.id is null or i.org_id <> v_org or i.supplier_id <> v_supplier
         or i.deleted_at is not null
         or round(a.amount,v_minor_units)>round($replacement$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0292: direct approval condition anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- 4. The declaration itself, in the same transaction as the allocations that caused it.
  v_anchor := $anchor$
  perform p1_refresh_invoice_payment_statuses(v_org, v_invoice_ids);

  insert into audit_logs ($anchor$;
  v_replacement := $replacement$
  perform p1_refresh_invoice_payment_statuses(v_org, v_invoice_ids);

  insert into exceptions (
    org_id, type, severity, status, title, details,
    supplier_id, invoice_id, payment_id, payment_request_id, bank_transaction_id, assigned_role
  )
  select
    v_org, 'unapproved_invoice_settled', 'high', 'open',
    'נרשם תשלום מול חשבונית שלא אושרה',
    jsonb_build_object(
      'invoice_number', i.invoice_number,
      'review_status', i.review_status,
      'invoice_total', i.total_amount,
      'currency', i.currency,
      'settled_by', v_user,
      'settled_by_role', v_role::text,
      'branch', case when p_existing_payment_id is not null then 'existing_payment' else 'direct' end,
      'reason', v_reason
    ),
    v_supplier, i.id, v_payment.id, v_payment.payment_request_id, v_tx.id, 'owner'
  from invoices i
  where v_recording
    and i.org_id = v_org
    and i.id = any (v_invoice_ids)
    and i.review_status <> 'approved'
    and not exists (
      select 1
      from exceptions e
      where e.org_id = v_org
        and e.type = 'unapproved_invoice_settled'
        and e.invoice_id = i.id
        and e.bank_transaction_id = v_tx.id
    );

  insert into audit_logs ($replacement$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0292: declaration anchor count (exception) %', v_count; end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_bank_match_0292$;

comment on function public.match_bank_transaction(uuid,uuid,uuid,uuid,jsonb,numeric,text) is
  'Matches a bank line to money owed. From 0292 the function distinguishes PAYING through the '
  'product from RECORDING money that already left the account: a payment whose request is '
  'executed/matched, whose execution audit row names this payment, and whose allocations are all '
  'on that request is TRUSTED; everything else is RECORDING. Recording is never refused — but a '
  'recording that settles an invoice which is not approved opens an unapproved_invoice_settled '
  'exception in the same transaction as the allocations. Entry stays owner/accountant; the '
  'accountant-only approval condition inside the direct branch is gone, because recording is the '
  'accountant''s job and it was the owner who could settle unapproved work silently.';

do $assert_0292$
declare
  v_source text := (
    select prosrc from pg_proc
    where oid = 'public.match_bank_transaction(uuid,uuid,uuid,uuid,jsonb,numeric,text)'::regprocedure
  );
  v_violations text;
begin
  if position('unapproved_invoice_settled' in v_source) = 0 then
    raise exception '0292: the bank match does not declare an unapproved settlement by name';
  end if;
  if position(e'v_role = \'accountant\' and i.review_status' in v_source) <> 0 then
    raise exception '0292: the accountant-only approval condition is still in the live body';
  end if;
  if position('v_recording' in v_source) = 0 then
    raise exception '0292: the trusted/recording classification is missing';
  end if;
  -- The value 0291 added must be reachable from here; if it is not, the exception insert would
  -- fail at run time on the first unapproved settlement instead of now.
  if not exists (
    select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'exception_type' and e.enumlabel = 'unapproved_invoice_settled'
  ) then
    raise exception '0292: 0291 has not been applied — the exception type does not exist';
  end if;

  select string_agg(assertion || ' -- ' || detail, chr(10) order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception '0292 scope assertions failed:%', chr(10) || v_violations;
  end if;
end
$assert_0292$;
