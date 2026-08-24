-- 0172 -- A reviewed credit note becomes one received credit, and nothing else.
--
-- OPEN-DECISIONS #243: the paper is already evidence that the supplier issued a credit, so the
-- row starts at `received`. Intake does not offset a balance. Supplier and credited invoice are
-- resolved again in the database from the immutable interpretation; zero or multiple invoices
-- leave the document in review. The browser never supplies authoritative provenance.

-- ===== 1. Provenance on the existing financial row =====
alter table public.credit_requests
  add column source_document_id uuid,
  add column source_extraction_id uuid,
  add column source_interpretation_id uuid,
  add constraint credit_requests_document_source_shape check (
    num_nonnulls(source_document_id, source_extraction_id, source_interpretation_id) in (0, 3)
  ),
  add constraint credit_requests_document_source_context_fk foreign key (
    org_id, source_interpretation_id, source_extraction_id, source_document_id
  ) references public.document_interpretations(org_id, id, extraction_id, document_id)
    on delete restrict;

create unique index credit_requests_source_document_unique
  on public.credit_requests (org_id, source_document_id)
  where source_document_id is not null;

alter table public.document_review_applications
  add column credit_id uuid,
  add constraint document_review_applications_credit_tenant_fk
    foreign key (org_id, credit_id) references public.credit_requests(org_id, id)
    on delete restrict;

alter table public.document_review_applications
  drop constraint document_review_applications_outcome_check;
alter table public.document_review_applications
  add constraint document_review_applications_outcome_check check (outcome in (
    'invoice_created', 'receipt_draft_created', 'receipt_evidence_linked', 'credit_received'));

-- ===== 2. One resolver for both the read model and the write command =====
create or replace function private.resolve_credit_note_invoice(
  p_org_id uuid,
  p_document_id uuid,
  p_payload jsonb
) returns jsonb
language plpgsql
stable
security invoker
set search_path = public, private, pg_temp
as $fn$
declare
  v_supplier jsonb;
  v_supplier_id uuid;
  v_reference text;
  v_reference_key text;
  v_amount numeric;
  v_invoice_ids uuid[];
begin
  if p_org_id is null or p_document_id is null
     or lower(btrim(coalesce(p_payload ->> 'document_type', ''))) <> 'credit_note' then
    return jsonb_build_object(
      'resolved', false, 'reason', 'not_credit_note', 'supplier_id', null,
      'invoice_id', null, 'reference_invoice_number', null, 'amount', null);
  end if;

  v_supplier := private.resolve_document_supplier(p_org_id, p_document_id, p_payload);
  if not coalesce((v_supplier ->> 'resolved')::boolean, false) then
    return jsonb_build_object(
      'resolved', false,
      'reason', case when v_supplier ->> 'reason' = 'ambiguous'
                     then 'supplier_ambiguous' else 'supplier_unresolved' end,
      'supplier_id', null, 'invoice_id', null,
      'reference_invoice_number', null, 'amount', null,
      'supplier_resolution', v_supplier);
  end if;
  v_supplier_id := (v_supplier ->> 'supplier_id')::uuid;

  v_reference := private.document_text_sanitize(nullif(btrim(
    private.interpretation_field(p_payload, array[
      'reference_invoice_number', 'original_invoice_number', 'credited_invoice_number',
      'related_invoice_number', 'חשבונית מקור', 'מספר חשבונית מקורית',
      'invoice_number', 'מספר חשבונית']) #>> '{}'), ''));
  v_reference_key := private.document_text_key(v_reference);

  v_amount := abs(private.interpretation_number(private.interpretation_field(p_payload, array[
    'total', 'total_amount', 'grand_total', 'amount_due', 'סכום כולל', 'סה"כ לתשלום'])));

  if v_reference_key is null then
    return jsonb_build_object(
      'resolved', false, 'reason', 'invoice_reference_unresolved',
      'supplier_id', v_supplier_id, 'invoice_id', null,
      'reference_invoice_number', v_reference, 'amount', v_amount,
      'supplier_resolution', v_supplier);
  end if;
  if v_amount is null or v_amount <= 0 then
    return jsonb_build_object(
      'resolved', false, 'reason', 'credit_amount_unresolved',
      'supplier_id', v_supplier_id, 'invoice_id', null,
      'reference_invoice_number', v_reference, 'amount', null,
      'supplier_resolution', v_supplier);
  end if;

  select coalesce(array_agg(invoice.id order by invoice.id), '{}'::uuid[])
    into v_invoice_ids
  from public.invoices invoice
  where invoice.org_id = p_org_id
    and invoice.supplier_id = v_supplier_id
    and invoice.deleted_at is null
    and invoice.financial_role = 'payable'
    and private.document_text_key(invoice.invoice_number) = v_reference_key;

  return jsonb_build_object(
    'resolved', cardinality(v_invoice_ids) = 1,
    'reason', case cardinality(v_invoice_ids)
      when 0 then 'not_found' when 1 then null else 'ambiguous' end,
    'supplier_id', v_supplier_id,
    'invoice_id', case when cardinality(v_invoice_ids) = 1 then v_invoice_ids[1] else null end,
    'reference_invoice_number', v_reference,
    'amount', round(v_amount, 2),
    'candidate_count', cardinality(v_invoice_ids),
    'supplier_resolution', v_supplier);
end
$fn$;

revoke all on function private.resolve_credit_note_invoice(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;

comment on function private.resolve_credit_note_invoice(uuid, uuid, jsonb) is
  'The single credit-note resolver (0172). Re-resolves the supplier from the immutable document '
  'interpretation, then accepts exactly one payable, non-deleted invoice of that supplier whose '
  'normalized number equals the printed credited-invoice reference. Returns the positive printed '
  'credit amount but writes nothing. Zero or multiple matches are unresolved, never first-wins.';

-- ===== 3. Extend the review read without redeclaring its post-0133 role gate =====
do $patch_credit_review_read$
declare
  v_signature regprocedure := 'public.get_document_review_assessment(uuid)'::regprocedure;
  v_definition text := replace(pg_get_functiondef(v_signature), e'\r', '');
  v_anchor text := $anchor$    'order_resolution', v_order,
    'assessment', v_assessment,$anchor$;
  v_replacement text := $replacement$    'order_resolution', v_order,
    'credit_resolution', case
      when lower(btrim(coalesce(v_document_type, ''))) = 'credit_note'
      then private.resolve_credit_note_invoice(v_org, v_document.id, v_payload)
      else null end,
    'assessment', v_assessment,$replacement$;
begin
  if position('resolve_credit_note_invoice' in v_definition) > 0
     or position(v_anchor in v_definition) = 0 then
    raise exception '0172: get_document_review_assessment anchor moved or patch already applied';
  end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_credit_review_read$;

-- ===== 4. Extend the live apply command; preserve all later hardening =====
do $patch_credit_apply$
declare
  v_signature regprocedure :=
    'public.apply_reviewed_document(uuid,uuid,jsonb,uuid,text)'::regprocedure;
  v_definition text := replace(pg_get_functiondef(v_signature), e'\r', '');
  v_anchor text;
  v_replacement text;
begin
  if position('credit_received' in v_definition) > 0 then
    raise exception '0172: apply_reviewed_document patch already applied';
  end if;

  v_anchor := $anchor$  v_payment_id uuid;
  v_batch_id uuid;$anchor$;
  v_replacement := $replacement$  v_payment_id uuid;
  v_credit_id uuid;
  v_credit_resolution jsonb;
  v_batch_id uuid;$replacement$;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0172: apply declaration anchor moved';
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$  if v_document_type not in ('invoice', 'delivery_note', 'tax_receipt') then$anchor$;
  v_replacement := $replacement$  if v_document_type not in ('invoice', 'delivery_note', 'tax_receipt', 'credit_note') then$replacement$;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0172: apply subtype allowlist anchor moved';
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$  if v_document_type in ('invoice', 'tax_receipt') and v_role not in ('owner', 'office') then$anchor$;
  v_replacement := $replacement$  if v_document_type in ('invoice', 'tax_receipt', 'credit_note')
     and v_role not in ('owner', 'office') then$replacement$;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0172: apply financial subtype role anchor moved';
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$  v_assessment := private.document_reconciliation_assessment(
    v_org, v_document_type, v_supplier_id, v_order_id, v_payload, v_document_date);

  if (v_assessment ->> 'approval_blocked')::boolean then$anchor$;
  v_replacement := $replacement$  if v_document_type = 'credit_note' then
    -- Credit-note intake has one question, not a four-source purchase reconciliation: which
    -- payable invoice did this supplier credit, and what positive amount did the paper state?
    v_credit_resolution := private.resolve_credit_note_invoice(
      v_org, v_document.id, v_interpretation.payload);
    v_assessment := jsonb_build_object(
      'document_type', 'credit_note',
      'severity', case
        when coalesce((v_credit_resolution ->> 'resolved')::boolean, false)
         and v_supplier_id = (v_credit_resolution ->> 'supplier_id')::uuid
        then 'info' else 'error' end,
      'approval_blocked', not (
        coalesce((v_credit_resolution ->> 'resolved')::boolean, false)
        and v_supplier_id = (v_credit_resolution ->> 'supplier_id')::uuid),
      'findings', case
        when not coalesce((v_credit_resolution ->> 'resolved')::boolean, false)
        then jsonb_build_array(jsonb_build_object(
          'code', 'credit_invoice_unresolved', 'severity', 'error',
          'message', 'לא ניתן לזהות חשבונית מקור אחת לזיכוי'))
        when v_supplier_id is distinct from (v_credit_resolution ->> 'supplier_id')::uuid
        then jsonb_build_array(jsonb_build_object(
          'code', 'supplier_mismatch', 'severity', 'error',
          'message', 'הספק שאושר אינו הספק שנפתר מן המסמך'))
        else '[]'::jsonb end,
      'credit_resolution', v_credit_resolution,
      'totals', jsonb_build_object('header_total', v_credit_resolution -> 'amount'),
      'lines', '[]'::jsonb, 'order_items', '[]'::jsonb);
  else
    v_assessment := private.document_reconciliation_assessment(
      v_org, v_document_type, v_supplier_id, v_order_id, v_payload, v_document_date);
  end if;

  if (v_assessment ->> 'approval_blocked')::boolean then$replacement$;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0172: apply assessment gate anchor moved';
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$  -- ================= tax receipt =================
  else
    v_outcome := 'receipt_evidence_linked';$anchor$;
  v_replacement := $replacement$  -- ================= credit note =================
  elsif v_document_type = 'credit_note' then
    v_credit_id := gen_random_uuid();
    v_outcome := 'credit_received';

    insert into public.credit_requests (
      id, org_id, supplier_id, invoice_id, reason, amount, status, notes, created_by,
      source_document_id, source_extraction_id, source_interpretation_id
    ) values (
      v_credit_id, v_org, v_supplier_id,
      (v_credit_resolution ->> 'invoice_id')::uuid,
      'other', round((v_credit_resolution ->> 'amount')::numeric, 2), 'received',
      'התקבל לפי מסמך זיכוי מאושר ' || v_document.id::text,
      v_actor, v_document.id, v_interpretation.extraction_id, v_interpretation.id
    );

    update public.documents
    set entity_type = 'invoice', entity_id = (v_credit_resolution ->> 'invoice_id')::uuid,
        supplier_id = v_supplier_id, document_kind = 'credit',
        document_date = coalesce(v_document_date, document_date)
    where id = v_document.id;

  -- ================= tax receipt =================
  else
    v_outcome := 'receipt_evidence_linked';$replacement$;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0172: apply tax-receipt branch anchor moved';
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$    supplier_id, order_id, outcome, invoice_id, receipt_id, payment_id,
    reviewed, assessment, reason$anchor$;
  v_replacement := $replacement$    supplier_id, order_id, outcome, invoice_id, receipt_id, payment_id, credit_id,
    reviewed, assessment, reason$replacement$;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0172: application insert column anchor moved';
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$    v_supplier_id, v_order_id, v_outcome, v_invoice_id, v_receipt_id, v_payment_id,
    p_reviewed, v_assessment, v_reason$anchor$;
  v_replacement := $replacement$    v_supplier_id, v_order_id, v_outcome, v_invoice_id, v_receipt_id, v_payment_id, v_credit_id,
    p_reviewed, v_assessment, v_reason$replacement$;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0172: application insert value anchor moved';
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- Both idempotent and first-write responses expose the credit row, just as the existing
  -- branches expose invoice/receipt/payment ids.
  v_anchor := $anchor$      'receipt_id', v_existing.receipt_id, 'payment_id', v_existing.payment_id,
      'assessment', v_existing.assessment);$anchor$;
  v_replacement := $replacement$      'receipt_id', v_existing.receipt_id, 'payment_id', v_existing.payment_id,
      'credit_id', v_existing.credit_id,
      'assessment', v_existing.assessment);$replacement$;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0172: idempotent response anchor moved';
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$      'invoice_id', v_invoice_id, 'receipt_id', v_receipt_id, 'payment_id', v_payment_id,
      'applied_lines', v_applied,$anchor$;
  v_replacement := $replacement$      'invoice_id', v_invoice_id, 'receipt_id', v_receipt_id, 'payment_id', v_payment_id,
      'credit_id', v_credit_id,
      'applied_lines', v_applied,$replacement$;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0172: audit payload anchor moved';
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := $anchor$    'receipt_id', v_receipt_id, 'payment_id', v_payment_id,
    'applied_lines', v_applied, 'assessment', v_assessment);$anchor$;
  v_replacement := $replacement$    'receipt_id', v_receipt_id, 'payment_id', v_payment_id, 'credit_id', v_credit_id,
    'applied_lines', v_applied, 'assessment', v_assessment);$replacement$;
  if position(v_anchor in v_definition) = 0 then
    raise exception '0172: first-write response anchor moved';
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  execute v_definition;
end
$patch_credit_apply$;

comment on function public.apply_reviewed_document(uuid, uuid, jsonb, uuid, text) is
  'Applies a document a person approved. In addition to the 0110 invoice/delivery-note/tax-receipt '
  'branches, 0172 accepts credit_note only after database re-resolution finds one supplier and one '
  'payable credited invoice from the immutable interpretation. It creates one credit_request in '
  'received with document/extraction/interpretation provenance and files the paper as invoice '
  'evidence. Intake never offsets a balance. Existing idempotency and scope checks remain.';

-- ===== 5. Refresh A5 hashes after the anchored live-body patches =====
insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select reviewed.function_signature, md5(replace(proc.prosrc, e'\r', '')),
       'filtered_read', reviewed.scope_proof
from (values
  ('get_document_review_assessment(uuid)',
   '0172 preserves the 0109 auth_org/auth_scopes document and order narrowing and adds only an '
   'invoker credit resolver over tenant-filtered invoices.'),
  ('apply_reviewed_document(uuid,uuid,jsonb,uuid,text)',
   '0172 preserves the 0110 document lock through auth_org and auth_scopes; credit provenance is '
   'derived only after the same scoped document and immutable interpretation are locked/read.')
) as reviewed(function_signature, scope_proof)
join pg_catalog.pg_proc proc
  on proc.oid = pg_catalog.to_regprocedure(reviewed.function_signature)
on conflict (function_signature) do update
  set body_hash = excluded.body_hash,
      enforcement_kind = excluded.enforcement_kind,
      scope_proof = excluded.scope_proof;

-- A6: new provenance columns are tenant evidence and belong in export. Refresh both affected
-- schema hashes so later unreviewed column drift still fails closed.
update private.tenant_export_registry registry
set exported_columns = (
      select array_agg(column_info.column_name order by column_info.ordinal_position)
      from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = registry.table_name
        and not (column_info.column_name = any(registry.excluded_columns))),
    schema_hash = (
      select md5(string_agg(
        column_info.column_name || ':' || column_info.data_type || ':' || column_info.is_nullable,
        '|' order by column_info.ordinal_position))
      from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = registry.table_name)
where registry.table_name in ('credit_requests', 'document_review_applications');

-- ===== 6. Fail-closed anchors and scope re-assertion =====
do $$
declare
  v_violations text;
  v_apply text;
  v_read text;
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.credit_requests'::regclass
      and conname = 'credit_requests_document_source_context_fk')
     or not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'credit_requests_source_document_unique') then
    raise exception '0172: credit-note provenance is not structurally tenant-bound and unique';
  end if;

  select pg_get_functiondef('public.apply_reviewed_document(uuid,uuid,jsonb,uuid,text)'::regprocedure)
    into v_apply;
  select pg_get_functiondef('public.get_document_review_assessment(uuid)'::regprocedure)
    into v_read;
  if position('resolve_credit_note_invoice' in v_apply) = 0
     or position('credit_received' in v_apply) = 0
     or position('source_interpretation_id' in v_apply) = 0
     or position('resolve_credit_note_invoice' in v_read) = 0 then
    raise exception '0172: the read/write credit-note contract did not land';
  end if;

  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0172 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
