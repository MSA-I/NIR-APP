-- 0118 -- One overcharge, one exception, one alert, one draft credit request.
--
-- `0108` already computes the overcharge: for each line whose price exceeds the baseline that was
-- in force on the DOCUMENT'S date, the positive difference times the normalised quantity, summed
-- into `credit_required`. `0110` applies the document. This is the step that turns a finding into
-- something a person can act on -- and the entire risk is quantity, not correctness.
--
-- A supplier who has been overcharged-by-mistake once should receive ONE credit request. Not one
-- per re-processing, not one per retry from a phone on a dropping connection, not two because an
-- approval was submitted twice. So this is a TRIGGER on `document_review_applications` rather than
-- a command anyone can call:
--
--   * That ledger is immutable and unique on (org_id, document_id, idempotency_key), so one
--     application row exists per real approval, and a retry produces no row at all. Idempotency is
--     therefore structural rather than something this code has to get right.
--   * It runs inside the apply transaction. An exception that exists without its application, or
--     an application without its exception, is a state nobody can explain later.
--
-- WHAT IT CREATES, AND WHAT IT REFUSES TO:
--   * The credit request is a DRAFT (`status = 'open'`). Nothing is sent to the supplier. Asking a
--     supplier for money back is a relationship decision, and the machine's job ends at "here is
--     the arithmetic, and here is the document it came from".
--   * THE PRICE LIST IS NOT TOUCHED. It is the contractual baseline; a document is evidence about
--     what was charged, never an instruction about what was agreed (OPEN-DECISIONS #144).
--   * A price BELOW the baseline creates nothing. A negative credit request is an invoice to our
--     own supplier, and "we were undercharged" is not an exception, it is a good day.
--   * A product charged but never ordered is NOT credited here. 0108 raises it as a blocking
--     finding so a person decides whether it was a legitimate direct purchase first -- and if it
--     was, a credit request would be an accusation.
--
-- The amount is `credit_required`'s own figure, unchanged. Recomputing it here would create a
-- second place where money is calculated, and the two would eventually disagree.

create or replace function private.record_document_overcharge()
returns trigger
language plpgsql
-- SECURITY INVOKER, deliberately. The only writer of this ledger is
-- `apply_reviewed_document`, which is already a definer that has narrowed the document and
-- the order to the actor's scope -- so this runs inside that narrowing and adds no reach of
-- its own. Making it a definer would add an A5 exemption row for privilege it does not need.
security invoker
set search_path = public, pg_temp
as $$
declare
  v_overcharge numeric;
  v_supplier_name text;
  v_exception_id uuid;
  v_credit_id uuid;
  v_invoice public.invoices;
begin
  -- Only an applied INVOICE can be overcharged: a delivery note carries no prices we owe on, and
  -- a receipt is evidence about money already paid.
  if new.invoice_id is null then
    return new;
  end if;

  v_overcharge := (new.assessment -> 'totals' ->> 'overcharge_total')::numeric;
  if coalesce(v_overcharge, 0) <= 0 then
    return new;
  end if;

  select * into v_invoice from public.invoices i
  where i.org_id = new.org_id and i.id = new.invoice_id;
  if not found then
    return new;
  end if;
  select s.name into v_supplier_name from public.suppliers s
  where s.org_id = new.org_id and s.id = new.supplier_id;

  -- ---- The exception: one row, pointing at the exact invoice and supplier.
  insert into public.exceptions (
    org_id, type, severity, status, title, details, supplier_id, invoice_id, assigned_role
  ) values (
    new.org_id, 'amount_mismatch', 'high', 'open',
    format('חיוב מעל המחיר המוסכם — %s, חשבונית %s',
           coalesce(v_supplier_name, 'ספק'), v_invoice.invoice_number),
    jsonb_build_object(
      'source', 'document_review_application',
      'application_id', new.id,
      'document_id', new.document_id,
      'interpretation_id', new.interpretation_id,
      'overcharge_amount', round(v_overcharge, 2),
      -- The per-line findings travel with the exception so the person opening it sees WHICH lines
      -- and by how much, without re-deriving anything from a price list that may since have moved.
      'lines', coalesce((
        select jsonb_agg(finding)
        from jsonb_array_elements(new.assessment -> 'findings') finding
        where finding ->> 'code' = 'price_above_baseline'), '[]'::jsonb)),
    new.supplier_id, new.invoice_id, 'office'
  ) returning id into v_exception_id;

  -- ---- The draft credit request. `open` is the draft state: it exists, it is not sent, and only
  -- transition_credit_request moves it -- with a reason, by a person.
  insert into public.credit_requests (
    org_id, supplier_id, invoice_id, reason, amount, status, notes, created_by
  ) values (
    new.org_id, new.supplier_id, new.invoice_id, 'wrong_price', round(v_overcharge, 2), 'open',
    format('טיוטה שנוצרה מבדיקת מסמך שאושרה. חריגה מהמחיר המוסכם שהיה בתוקף בתאריך המסמך. '
           || 'חריג %s · מסמך %s', v_exception_id, new.document_id),
    new.actor_id
  ) returning id into v_credit_id;

  -- ---- One alert, to the person who approved. `dedupe_key` is the application id, which is
  -- unique per approval, so the notifications table refuses a second one structurally.
  insert into public.notifications (
    org_id, user_id, event_code, entity_key, severity, title, body, target_url, dedupe_key
  ) values (
    new.org_id, new.actor_id, 'document_overcharge_detected', new.invoice_id::text, 'warning',
    'נמצא חיוב מעל המחיר המוסכם',
    format('%s · חשבונית %s · חריגה של ₪%s. נפתחה טיוטת בקשת זיכוי — היא אינה נשלחת לספק עד '
           || 'שתאשר אותה.',
           coalesce(v_supplier_name, 'ספק'), v_invoice.invoice_number, round(v_overcharge, 2)),
    '/credits', 'document_overcharge:' || new.id::text
  ) on conflict (user_id, dedupe_key) do nothing;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    new.org_id, new.actor_id, 'document_overcharge_credit_drafted', 'credit_requests', v_credit_id,
    null,
    jsonb_build_object(
      'application_id', new.id, 'document_id', new.document_id, 'invoice_id', new.invoice_id,
      'exception_id', v_exception_id, 'overcharge_amount', round(v_overcharge, 2)),
    'טיוטת זיכוי אוטומטית מחריגת מחיר שנמצאה בבדיקת המסמך');

  return new;
end
$$;

revoke all on function private.record_document_overcharge()
  from public, anon, authenticated, service_role;

comment on function private.record_document_overcharge() is
  'Turns an overcharge finding into one exception, one draft credit request and one alert (0118). '
  'A TRIGGER on document_review_applications rather than a command, because that ledger is unique '
  'per approval -- so a retry produces no row and therefore no second credit request, and '
  'idempotency is structural instead of something this code has to get right. The credit is a '
  'DRAFT: asking a supplier for money back is a relationship decision. The price list is never '
  'touched, and a price BELOW the baseline creates nothing, because a negative credit request is '
  'an invoice to our own supplier.';

drop trigger if exists document_review_applications_overcharge_trg
  on public.document_review_applications;
create trigger document_review_applications_overcharge_trg
  after insert on public.document_review_applications
  for each row execute function private.record_document_overcharge();

-- ===== A1/A3/A5 re-assertion =====
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0118 scope assertions failed:\n%', v_violations;
  end if;
end
$$;

-- ===== Anchors =====
do $$
declare
  v_src text;
begin
  select p.prosrc into v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.proname = 'record_document_overcharge';

  -- (a) Positive overcharge only. "We were undercharged" is not an exception.
  if position('v_overcharge, 0) <= 0' in v_src) = 0 then
    raise exception
      '0118: the overcharge guard is gone. A non-positive difference must create nothing -- a '
      'negative credit request is an invoice to our own supplier.';
  end if;

  -- (b) A DRAFT. Nothing is sent to a supplier by a machine.
  if position('''open''' in v_src) = 0 then
    raise exception '0118: the credit request is no longer created as a draft.';
  end if;

  -- (c) THE PRICE LIST IS NOT TOUCHED. This is OPEN-DECISIONS #144, and it is the difference
  -- between evidence about what was charged and an instruction about what was agreed.
  if position('supplier_products' in v_src) > 0 or position('price_history' in v_src) > 0 then
    raise exception
      '0118: the overcharge path writes to the price list. The price list is the contractual '
      'baseline and is never updated from a document.';
  end if;

  -- (d) The amount is the assessment's own figure. A second place where money is calculated is a
  -- second answer waiting to disagree with the first.
  if position('overcharge_total' in v_src) = 0 then
    raise exception '0118: the credit amount is no longer read from the assessment.';
  end if;

  -- (e) It fires on the ledger that is unique per approval, so a retry cannot double-charge.
  if not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'document_review_applications'
      and t.tgname = 'document_review_applications_overcharge_trg' and not t.tgisinternal) then
    raise exception '0118: the overcharge trigger is not attached.';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.document_review_applications'::regclass
      and conname = 'document_review_applications_idempotency_key') then
    raise exception
      '0118: the application ledger lost its uniqueness constraint, which is the ONLY thing '
      'stopping a retry from drafting a second credit request against the same supplier.';
  end if;
end
$$;
