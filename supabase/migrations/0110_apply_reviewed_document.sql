-- 0110 -- A person approved this document. Now, and only now, something happens.
--
-- Everything before this migration reads. 0106 says who sent the document, 0107 says which order it
-- is about, 0108 compares four sources and 0109 hands all three to a screen. None of them writes,
-- and each says so in its own header. This is the command that writes, and its entire design is
-- about making the approval real rather than nominal.
--
-- THE REVIEWED PROPOSAL IS AN INPUT, NOT A VERDICT. The screen sends back what the person decided:
-- the supplier, the order, the product each line means, the quantities and the prices. The command
-- does NOT trust it. It rebuilds the interpretation-contract payload from that proposal and runs
-- `private.document_reconciliation_assessment` over it AGAIN, server-side, and refuses to apply
-- anything the recomputation still blocks. A client that posts `{"findings": []}` changes nothing,
-- because the findings it sends are never read. The gate is the recomputation.
--
-- WHY THE PROPOSAL CAN NAME A PRODUCT THE MATCHER CANNOT. `private.document_assessment_lines`
-- gains one branch here: an explicit `product_id` in a line's values wins over the printed codes.
-- That is the entire point of a person mapping a line -- a product the automatic matcher refuses to
-- guess at is precisely the line a human has to resolve, and without this branch such a line would
-- block approval forever no matter what anybody decided. The branch is additive: a payload that
-- carries no product_id behaves exactly as before, which is why 0108's suite still passes
-- unchanged. Every product_id is verified to belong to the tenant before it is honoured.
--
-- WHAT EACH SUBTYPE DOES, AND WHAT IT REFUSES TO DO:
--
--   invoice        Creates the supplier invoice from the reviewed proposal, with its lines as
--                  evidence, and links it to the reviewed order. It does NOT touch received_qty
--                  and it does NOT move order status. Billing is not receiving: an invoice that
--                  advanced an order to `received` would let a supplier close an order by sending
--                  paperwork.
--
--   delivery_note  Creates a DRAFT goods receipt against the reviewed order, carrying only the
--                  lines whose product and quantity are settled. A separate human confirmation
--                  that the goods physically arrived completes it, and only that completion moves
--                  received_qty, stock, order status and receipt credits. This is 0090's rule,
--                  restated for the human-approved path rather than replaced.
--
--   tax_receipt    EVIDENCE ONLY (OPEN-DECISIONS #141). It links the document to an invoice that
--                  already exists or to a payment already recorded, and it creates NOTHING: no
--                  invoice, no payment, no payable. When neither link can be proven it stops and
--                  says so, because a receipt that cannot be attached is a question, not a debt.
--
-- IDEMPOTENT, AND HONESTLY SO. `(org_id, document_id, idempotency_key)` is unique. A retry returns
-- the first application's result unchanged and writes nothing. That matters more here than usual:
-- the screen it serves runs on a phone next to a delivery truck, on a connection that drops.

-- ===== 1. A reviewer may name the product the matcher would not =====
create or replace function private.document_assessment_lines(
  p_org_id uuid,
  p_supplier_id uuid,
  p_payload jsonb
) returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $fn$
declare
  v_line jsonb;
  v_index integer;
  v_values jsonb;
  v_sku text;
  v_barcode text;
  v_match jsonb;
  v_product_id uuid;
  v_product_source text;
  v_quantity numeric;
  v_out jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_payload -> 'line_items') <> 'array' then
    return v_out;
  end if;

  for v_line, v_index in
    select item.value, (item.ordinality - 1)::integer
    from jsonb_array_elements(p_payload -> 'line_items')
      with ordinality as item(value, ordinality)
  loop
    v_values := coalesce(v_line -> 'values', '{}'::jsonb);
    v_sku := nullif(btrim(v_values ->> 'sku'), '');
    v_barcode := nullif(btrim(v_values ->> 'barcode'), '');
    v_product_id := null;
    v_product_source := null;

    -- A person's mapping outranks the printed codes (0110). It is checked against this tenant's
    -- own catalogue, so a caller cannot name a product from another organisation -- and it is
    -- labelled `reviewer` so nothing downstream can mistake a decision for a match.
    if jsonb_typeof(v_values -> 'product_id') = 'string' then
      select p.id into v_product_id
      from public.products p
      where p.org_id = p_org_id and p.id = (v_values ->> 'product_id')::uuid;
      if v_product_id is not null then
        v_product_source := 'reviewer';
      end if;
    end if;

    if v_product_id is null
       and p_supplier_id is not null and (v_sku is not null or v_barcode is not null) then
      v_match := private.match_price_list_line(p_org_id, p_supplier_id, v_sku, v_barcode);
      if v_match ->> 'status' = 'matched' then
        v_product_id := (v_match ->> 'product_id')::uuid;
        v_product_source := v_match ->> 'matched_by';
      else
        v_product_source := v_match ->> 'status';
      end if;
    end if;

    v_quantity := private.interpretation_number(v_values -> 'quantity');
    if v_quantity is not null and v_quantity <= 0 then
      v_quantity := null;
    end if;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'line_index', v_index,
      'description', nullif(btrim(v_values ->> 'description'), ''),
      'sku', v_sku,
      'barcode', v_barcode,
      'product_id', v_product_id,
      'product_source', v_product_source,
      'quantity', v_quantity,
      'unit', nullif(btrim(v_values ->> 'unit'), ''),
      'unit_price', private.interpretation_number(v_values -> 'unit_price'),
      'discount_amount', coalesce(private.interpretation_number(v_values -> 'discount_amount'), 0),
      'vat_rate', private.interpretation_number(v_values -> 'vat_rate'),
      'line_total', private.interpretation_number(v_values -> 'line_total'),
      'package_size', private.interpretation_number(v_values -> 'package_size')
    ));
  end loop;

  return v_out;
end
$fn$;

revoke all on function private.document_assessment_lines(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;

comment on function private.document_assessment_lines(uuid, uuid, jsonb) is
  'The document''s line items, with a product named where one can be named (0108, extended 0110). '
  'An explicit product_id in a line''s values -- a REVIEWER''S mapping -- outranks the printed '
  'codes and is verified against this tenant''s catalogue; without that branch a line the '
  'automatic matcher refuses to guess at could never be resolved by the person whose job it is. '
  'Otherwise reuses private.match_price_list_line (0081), so product identity has one '
  'implementation, and private.interpretation_number (0077), so numbers have one reader. A '
  'quantity that cannot be read stays null rather than becoming zero.';

-- ===== 2. The immutable ledger of applications =====
create table if not exists public.document_review_applications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  document_id uuid not null,
  interpretation_id uuid not null,
  idempotency_key uuid not null,
  actor_id uuid not null,
  document_type text not null,
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  order_id uuid references public.purchase_orders(id) on delete restrict,
  outcome text not null check (outcome in (
    'invoice_created', 'receipt_draft_created', 'receipt_evidence_linked')),
  invoice_id uuid references public.invoices(id) on delete restrict,
  receipt_id uuid references public.goods_receipts(id) on delete restrict,
  payment_id uuid references public.payments(id) on delete restrict,
  -- What was applied and what the server thought of it, both frozen. Re-deriving either later
  -- would read today's catalogue and today's prices, and would therefore answer a different
  -- question than the one the approver actually answered.
  reviewed jsonb not null,
  assessment jsonb not null,
  reason text not null check (length(trim(reason)) between 1 and 1000),
  created_at timestamptz not null default now(),
  constraint document_review_applications_idempotency_key
    unique (org_id, document_id, idempotency_key)
);

alter table public.document_review_applications enable row level security;

-- Default privileges in this project hand `authenticated` full DML on a new public table. A ledger
-- a client can insert into is not a ledger: the whole value of these rows is that the only way one
-- comes into existence is through the command below, which recomputed the assessment first.
revoke all on table public.document_review_applications from anon, authenticated;
grant select on table public.document_review_applications to authenticated;

create index if not exists document_review_applications_document_idx
  on public.document_review_applications (org_id, document_id, created_at desc);

comment on table public.document_review_applications is
  'One immutable row per approved document application (0110): the reviewed proposal exactly as it '
  'was applied, the server''s own recomputed assessment of it, the actor and the reason. Unique on '
  '(org_id, document_id, idempotency_key) so a retry from a phone on a dropping connection returns '
  'the first result and writes nothing.';

do $$
begin
  if not exists (
    select 1 from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relname = 'document_review_applications' and p.polname = 'document_review_applications_select'
  ) then
    create policy document_review_applications_select
      on public.document_review_applications for select
      using (org_id = auth_org()
             and auth_role() in ('owner', 'office', 'kitchen', 'accountant'));
  end if;
end
$$;

create or replace function public.reject_document_review_application_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'document_review_application_immutable' using errcode = '42501';
end
$$;

drop trigger if exists document_review_applications_immutable_trg
  on public.document_review_applications;
create trigger document_review_applications_immutable_trg
  before update or delete on public.document_review_applications
  for each row execute function public.reject_document_review_application_mutation();

-- ===== 3. The command =====
create or replace function public.apply_reviewed_document(
  p_document_id uuid,
  p_interpretation_id uuid,
  p_reviewed jsonb,
  p_idempotency_key uuid,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, private, extensions, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_role user_role := auth_role();
  v_reason text := nullif(trim(p_reason), '');
  v_document public.documents;
  v_interpretation public.document_interpretations;
  v_existing public.document_review_applications;
  v_document_type text;
  v_supplier_id uuid;
  v_order_id uuid;
  v_document_date date;
  v_document_number text;
  v_payload jsonb;
  v_assessment jsonb;
  v_lines jsonb;
  v_line jsonb;
  v_index integer;
  v_outcome text;
  v_invoice_id uuid;
  v_receipt_id uuid;
  v_payment_id uuid;
  v_batch_id uuid;
  v_net numeric;
  v_vat numeric;
  v_total numeric;
  v_line_number integer := 0;
  v_item record;
  v_applied integer := 0;
begin
  if v_actor is null or v_org is null
     or v_role not in ('owner', 'office', 'kitchen') then
    raise exception 'apply_reviewed_document_not_authorized' using errcode = '42501';
  end if;
  if v_reason is null or p_idempotency_key is null or p_reviewed is null
     or jsonb_typeof(p_reviewed) <> 'object' then
    raise exception 'apply_reviewed_document_invalid' using errcode = '22023';
  end if;

  -- A retry answers with the first application and writes nothing. Checked before any lock, so a
  -- duplicate submit from a flaky connection is cheap rather than contended.
  select * into v_existing
  from public.document_review_applications a
  where a.org_id = v_org and a.document_id = p_document_id
    and a.idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object(
      'applied', false, 'idempotent', true, 'outcome', v_existing.outcome,
      'application_id', v_existing.id, 'invoice_id', v_existing.invoice_id,
      'receipt_id', v_existing.receipt_id, 'payment_id', v_existing.payment_id,
      'assessment', v_existing.assessment);
  end if;

  -- Scope is this command's job for the same reason it is 0109's: inside a definer body the scope
  -- riders do not run. The row lock serialises two reviewers approving the same document.
  select d.* into v_document
  from public.documents d
  where d.org_id = v_org and d.id = p_document_id and d.deleted_at is null
    and (d.unit_id is null or d.unit_id = any(public.auth_scopes()))
  for update;
  if not found then
    raise exception 'document_not_found' using errcode = 'P0002';
  end if;

  select i.* into v_interpretation
  from public.document_interpretations i
  where i.org_id = v_org and i.id = p_interpretation_id and i.document_id = p_document_id;
  if not found then
    raise exception 'document_interpretation_unknown' using errcode = 'P0002';
  end if;
  -- Approving against a superseded reading would apply what the screen showed before the document
  -- was re-read. The person approved a specific reading; this is that reading or nothing.
  --
  -- "Latest" is spelled with the SAME ordering 0109 reads by -- `created_at desc, id desc` -- and
  -- not with a comparison of its own. Two definitions of latest would mean the screen could show
  -- one reading while this command accepts another, which is precisely the failure this check is
  -- for. `created_at` alone cannot decide it: two rows written in one transaction share `now()`.
  if p_interpretation_id is distinct from (
    select latest.id from public.document_interpretations latest
    where latest.org_id = v_org and latest.document_id = p_document_id
    order by latest.created_at desc, latest.id desc
    limit 1
  ) then
    raise exception 'document_interpretation_superseded' using errcode = '40001';
  end if;

  v_document_type := lower(btrim(coalesce(p_reviewed ->> 'document_type', '')));
  if v_document_type not in ('invoice', 'delivery_note', 'tax_receipt') then
    raise exception 'document_review_subtype_unsupported' using errcode = '22023';
  end if;
  -- Creating a supplier invoice or attaching payment evidence is back-office work. Receiving
  -- goods is not, which is why a kitchen manager keeps the delivery-note path.
  if v_document_type in ('invoice', 'tax_receipt') and v_role not in ('owner', 'office') then
    raise exception 'apply_reviewed_document_not_authorized' using errcode = '42501';
  end if;

  v_supplier_id := nullif(p_reviewed ->> 'supplier_id', '')::uuid;
  v_order_id := nullif(p_reviewed ->> 'order_id', '')::uuid;
  v_document_date := nullif(p_reviewed ->> 'document_date', '')::date;
  v_document_number := private.document_text_sanitize(
    nullif(btrim(p_reviewed ->> 'document_number'), ''));

  if v_supplier_id is null or not exists (
    select 1 from public.suppliers s
    where s.org_id = v_org and s.id = v_supplier_id and s.deleted_at is null
  ) then
    raise exception 'document_review_supplier_unresolved' using errcode = '22023';
  end if;
  if v_order_id is not null and not exists (
    select 1 from public.purchase_orders po
    where po.org_id = v_org and po.id = v_order_id
      and po.supplier_id = v_supplier_id
      and (po.unit_id is null or po.unit_id = any(public.auth_scopes()))
  ) then
    -- Another supplier's order, another branch's order, or none at all. Applying against it would
    -- measure every quantity and price on this document against the wrong contract.
    raise exception 'document_review_order_invalid' using errcode = '22023';
  end if;

  -- ---- Rebuild the contract payload FROM THE PROPOSAL, and assess that. This is the gate: what
  -- the client claims about findings is never read, only what the server recomputes.
  v_payload := jsonb_build_object(
    'document_type', v_document_type,
    'fields', coalesce((
      select jsonb_agg(jsonb_build_object('key', f.key, 'value', f.value))
      from (values
        ('invoice_number', v_document_number),
        ('invoice_date', to_char(v_document_date, 'YYYY-MM-DD')),
        ('subtotal', p_reviewed #>> '{totals,net}'),
        ('vat_amount', p_reviewed #>> '{totals,vat}'),
        ('total', p_reviewed #>> '{totals,total}'),
        ('currency', p_reviewed ->> 'currency')
      ) as f(key, value)
      where f.value is not null), '[]'::jsonb),
    'line_items', coalesce((
      select jsonb_agg(jsonb_build_object('values', line) order by ordinality)
      from jsonb_array_elements(coalesce(p_reviewed -> 'lines', '[]'::jsonb))
        with ordinality as reviewed(line, ordinality)), '[]'::jsonb));

  v_assessment := private.document_reconciliation_assessment(
    v_org, v_document_type, v_supplier_id, v_order_id, v_payload, v_document_date);

  if (v_assessment ->> 'approval_blocked')::boolean then
    raise exception 'document_review_blocked: %',
      coalesce((
        select string_agg(distinct f ->> 'code', ', ')
        from jsonb_array_elements(v_assessment -> 'findings') f
        where f ->> 'severity' in ('error', 'critical')), 'unknown')
      using errcode = '55000';
  end if;

  -- Past the gate, this is a financial writer. 0023's boundary exists so that an invoice or a
  -- receipt can only be written by a command that already applied its own checks, and this command
  -- has now applied them: role, tenant, scope, the reviewed order's ownership, and the recomputed
  -- assessment. Claimed here rather than at the top for exactly that reason -- everything above
  -- this line can still refuse, and a refusal must not leave a writer flag behind.
  perform set_config('app.p1_financial_writer', v_actor::text, true);
  -- The same claim for re-filing: 0019/0045 refuse to move a document from one entity to another
  -- outside a command, because the filing IS the answer to "what is this document about" and a
  -- stray UPDATE would rewrite it with no reason attached. This command has a reason.
  perform set_config('app.document_filing_writer', v_actor::text, true);

  v_lines := private.document_assessment_lines(v_org, v_supplier_id, v_payload);
  v_net := private.interpretation_number(to_jsonb(p_reviewed #>> '{totals,net}'));
  v_vat := private.interpretation_number(to_jsonb(p_reviewed #>> '{totals,vat}'));
  v_total := private.interpretation_number(to_jsonb(p_reviewed #>> '{totals,total}'));

  -- ================= invoice =================
  if v_document_type = 'invoice' then
    if v_document_number is null or v_document_date is null or v_total is null then
      raise exception 'document_review_invoice_incomplete' using errcode = '22023';
    end if;
    v_invoice_id := gen_random_uuid();
    v_outcome := 'invoice_created';

    insert into public.invoices (
      id, org_id, supplier_id, invoice_number, invoice_date, received_date,
      received_by, amount_before_vat, vat_amount, total_amount, review_status, notes, unit_id
    ) values (
      v_invoice_id, v_org, v_supplier_id, v_document_number, v_document_date, current_date,
      v_actor, round(coalesce(v_net, v_total), 2), round(coalesce(v_vat, 0), 2),
      round(v_total, 2),
      -- 'received', not 'approved' -- for 0077's reason, which a human approver does not change:
      -- approving the DOCUMENT is not approving the INVOICE for payment. That is a separate
      -- reasoned command with its own role check and its own three-way gate.
      'received'::invoice_review_status,
      'נוצרה מבדיקת מסמך שאושרה. פירוש ' || v_interpretation.id::text,
      v_document.unit_id);

    if v_order_id is not null then
      insert into public.invoice_order_links (org_id, invoice_id, order_id)
      values (v_org, v_invoice_id, v_order_id)
      on conflict do nothing;
    end if;

    -- The lines, as evidence. sha256 over the reviewed proposal: the checksum has to identify
    -- what was applied, and the interpretation's own checksum would identify what the machine
    -- read before a person corrected it.
    --
    -- 0099:267-279 admits an evidence write only from a claimed writer, and the claim names WHICH
    -- kind. `evidence` is the only one this command may make: `match`, `override` and
    -- `approval_snapshot` belong to the three-way path that runs after this, on the invoice this
    -- creates, and claiming one of those here would let a document approval pre-empt an approval
    -- decision it has no business making.
    perform set_config('app.invoice_three_way_writer', 'evidence', true);
    v_batch_id := gen_random_uuid();
    insert into public.invoice_line_evidence_batches (
      id, org_id, invoice_id, revision, idempotency_key, source_type, document_id,
      interpretation_id, actor_id, source_checksum, reason
    ) values (
      v_batch_id, v_org, v_invoice_id, 1, p_idempotency_key, 'document_interpretation',
      v_document.id,
      v_interpretation.id, v_actor,
      encode(digest(convert_to(p_reviewed::text, 'utf8'), 'sha256'), 'hex'), v_reason
    );

    for v_line, v_index in
      select item.value, (item.ordinality - 1)::integer
      from jsonb_array_elements(v_lines) with ordinality as item(value, ordinality)
    loop
      v_line_number := v_line_number + 1;
      insert into public.invoice_lines (
        org_id, evidence_batch_id, invoice_id, line_number, description, supplier_sku, barcode,
        product_id, quantity, unit, unit_price, discount_amount, vat_rate, line_total,
        evidence_block_ids, raw_evidence, source_hash
      ) values (
        v_org, v_batch_id, v_invoice_id, v_line_number,
        coalesce(
          nullif(btrim(v_line ->> 'description'), ''),
          (select p.name from public.products p
           where p.org_id = v_org and p.id = (v_line ->> 'product_id')::uuid),
          'שורה ' || v_line_number::text),
        v_line ->> 'sku', v_line ->> 'barcode',
        nullif(v_line ->> 'product_id', '')::uuid,
        (v_line ->> 'quantity')::numeric,
        coalesce(nullif(v_line ->> 'unit', ''), 'unit'),
        (v_line ->> 'unit_price')::numeric,
        coalesce((v_line ->> 'discount_amount')::numeric, 0),
        coalesce((v_line ->> 'vat_rate')::numeric, 0),
        (v_line ->> 'line_total')::numeric,
        '{}'::text[], v_line,
        encode(digest(convert_to(v_line::text, 'utf8'), 'sha256'), 'hex'));
      v_applied := v_applied + 1;
    end loop;
    -- Dropped the moment the evidence is written. A writer claim left standing would let anything
    -- later in this transaction insert three-way evidence without having earned it.
    perform set_config('app.invoice_three_way_writer', '', true);

    update public.documents
    set entity_type = 'invoice', entity_id = v_invoice_id, supplier_id = v_supplier_id,
        document_kind = 'invoice',
        document_date = coalesce(v_document_date, document_date)
    where id = v_document.id;

  -- ================= delivery note =================
  elsif v_document_type = 'delivery_note' then
    if v_order_id is null then
      raise exception 'document_review_order_required' using errcode = '22023';
    end if;
    v_outcome := 'receipt_draft_created';

    -- DRAFT. received_by stays null exactly as 0090 leaves it, which is also what keeps 0026's
    -- inventory trigger asleep: nothing moves until a person confirms the goods arrived.
    insert into public.goods_receipts (org_id, order_id, status, received_by, notes, unit_id)
    values (
      v_org, v_order_id, 'draft', null,
      'טיוטה מבדיקת תעודת משלוח שאושרה. פירוש ' || v_interpretation.id::text,
      v_document.unit_id)
    returning id into v_receipt_id;

    for v_line, v_index in
      select item.value, (item.ordinality - 1)::integer
      from jsonb_array_elements(v_lines) with ordinality as item(value, ordinality)
    loop
      if (v_line ->> 'product_id') is not null and (v_line ->> 'quantity') is not null then
        select item.id, item.qty, item.unit_snapshot into v_item
        from public.purchase_order_items item
        where item.org_id = v_org and item.order_id = v_order_id
          and item.product_id = (v_line ->> 'product_id')::uuid;
        if found then
          insert into public.goods_receipt_items (
            org_id, receipt_id, order_item_id, product_id, qty_received, status, notes
          ) values (
            v_org, v_receipt_id, v_item.id, (v_line ->> 'product_id')::uuid,
            (v_line ->> 'quantity')::numeric,
            case when (v_line ->> 'quantity')::numeric >= v_item.qty
                 then 'full' else 'partial' end::public.receipt_line_status,
            'הוצע מהמסמך — טעון אישור אנושי שהסחורה התקבלה');
          v_applied := v_applied + 1;
        end if;
      end if;
    end loop;

    update public.documents
    set entity_type = 'goods_receipt', entity_id = v_receipt_id, supplier_id = v_supplier_id,
        document_kind = 'delivery_note',
        document_date = coalesce(v_document_date, document_date)
    where id = v_document.id;

  -- ================= tax receipt =================
  else
    v_outcome := 'receipt_evidence_linked';

    -- Evidence only (OPEN-DECISIONS #141). An invoice with the printed number is the strongest
    -- link; a recorded payment of the printed amount is the next. Nothing here creates a payable,
    -- and when neither can be proven the command refuses rather than inventing an attachment.
    if v_document_number is not null then
      select i.id into v_invoice_id
      from public.invoices i
      where i.org_id = v_org and i.supplier_id = v_supplier_id and i.deleted_at is null
        and private.document_text_key(i.invoice_number)
            = private.document_text_key(v_document_number)
      limit 1;
    end if;

    if v_invoice_id is null and v_total is not null then
      -- A recorded payment of exactly this amount, within a week of the receipt's date. The window
      -- is not a tolerance on the money -- the amount must match to the agora -- it only keeps a
      -- recurring identical payment to the same supplier from attaching to the wrong month. When
      -- more than one still matches, `limit 1` would be a guess, so the count decides instead.
      select p.id into v_payment_id
      from public.payments p
      where p.org_id = v_org and p.supplier_id = v_supplier_id
        and p.amount = round(v_total, 2)
        and (v_document_date is null
             or p.paid_date between v_document_date - 7 and v_document_date + 7)
      limit 2;
      if (select count(*) from public.payments p
          where p.org_id = v_org and p.supplier_id = v_supplier_id
            and p.amount = round(v_total, 2)
            and (v_document_date is null
                 or p.paid_date between v_document_date - 7 and v_document_date + 7)) <> 1 then
        v_payment_id := null;
      end if;
    end if;

    if v_invoice_id is null and v_payment_id is null then
      raise exception 'document_review_receipt_unlinked' using errcode = '55000';
    end if;

    update public.documents
    set entity_type = case when v_invoice_id is not null then 'invoice' else 'payment' end,
        entity_id = coalesce(v_invoice_id, v_payment_id),
        supplier_id = v_supplier_id,
        document_kind = 'tax_receipt',
        document_date = coalesce(v_document_date, document_date)
    where id = v_document.id;
  end if;

  insert into public.document_review_applications (
    org_id, document_id, interpretation_id, idempotency_key, actor_id, document_type,
    supplier_id, order_id, outcome, invoice_id, receipt_id, payment_id,
    reviewed, assessment, reason
  ) values (
    v_org, v_document.id, v_interpretation.id, p_idempotency_key, v_actor, v_document_type,
    v_supplier_id, v_order_id, v_outcome, v_invoice_id, v_receipt_id, v_payment_id,
    p_reviewed, v_assessment, v_reason
  ) returning id into v_existing.id;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_actor, 'reviewed_document_applied', 'documents', v_document.id,
    jsonb_build_object('entity_type', v_document.entity_type, 'entity_id', v_document.entity_id),
    jsonb_build_object(
      'application_id', v_existing.id, 'document_type', v_document_type,
      'supplier_id', v_supplier_id, 'order_id', v_order_id, 'outcome', v_outcome,
      'invoice_id', v_invoice_id, 'receipt_id', v_receipt_id, 'payment_id', v_payment_id,
      'applied_lines', v_applied,
      'assessment_severity', v_assessment ->> 'severity'),
    v_reason);

  return jsonb_build_object(
    'applied', true, 'idempotent', false, 'outcome', v_outcome,
    'application_id', v_existing.id, 'invoice_id', v_invoice_id,
    'receipt_id', v_receipt_id, 'payment_id', v_payment_id,
    'applied_lines', v_applied, 'assessment', v_assessment);
end
$$;

revoke all on function public.apply_reviewed_document(uuid, uuid, jsonb, uuid, text)
  from public, anon;
grant execute on function public.apply_reviewed_document(uuid, uuid, jsonb, uuid, text)
  to authenticated;

comment on function public.apply_reviewed_document(uuid, uuid, jsonb, uuid, text) is
  'Applies a document a person approved, by subtype (0110). The reviewed proposal is an INPUT: the '
  'command rebuilds the contract payload from it and re-runs the four-source assessment '
  'server-side, refusing anything the recomputation still blocks -- a client''s claim about '
  'findings is never read. An invoice is created but never moves received_qty or order status; a '
  'delivery note produces a DRAFT receipt that only a separate human confirmation completes; a tax '
  'receipt is linked to an existing invoice or payment and creates nothing at all '
  '(OPEN-DECISIONS #141). Idempotent on (org_id, document_id, idempotency_key), because the screen '
  'it serves runs on a phone next to a delivery truck.';

-- ===== 4. The A5 ledger =====
insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select reviewed.function_signature, md5(replace(proc.prosrc, e'\r', '')),
       'filtered_read', reviewed.scope_proof
from (values (
  'apply_reviewed_document(uuid,uuid,jsonb,uuid,text)',
  '0110 locks the document through auth_org, role and the canonical null-or-auth_scopes unit '
  'predicate, and rejects a reviewed order failing the same predicate before any write.'
)) as reviewed(function_signature, scope_proof)
join pg_catalog.pg_proc proc
  on proc.oid = pg_catalog.to_regprocedure(reviewed.function_signature)
on conflict (function_signature) do update
  set body_hash = excluded.body_hash,
      enforcement_kind = excluded.enforcement_kind,
      scope_proof = excluded.scope_proof;

-- `derived`, not `branch`: this ledger carries no unit of its own. It is reachable only through
-- the document it applied, and that document was already narrowed by the canonical predicate
-- before a single row here could be written -- so a rider on this table would re-ask a question
-- that has already been answered, on a column it does not have.
insert into private.scope_registry (table_name, scope_class, enforced)
values ('document_review_applications', 'derived', false)
on conflict (table_name) do nothing;

-- A6 (0103): every tenant table is classified for offboarding export, or the export is silently
-- incomplete. This one is INCLUDED and nothing is redacted -- it is the record of what a person
-- approved and why, which is exactly the evidence a departing tenant is owed and an auditor asks
-- for. No column here holds a credential.
insert into private.tenant_export_registry (table_name, disposition, excluded_columns, rationale)
values ('document_review_applications', 'include', '{}',
        'Approved document applications: the reviewed proposal, the assessment, actor and reason.')
on conflict (table_name) do nothing;

-- `exported_columns` and `schema_hash` are derived, not typed: 0103 fills them from
-- information_schema so that a column added later without a deliberate export decision shows up
-- as drift rather than silently leaving the tenant's export short.
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
where registry.table_name = 'document_review_applications';

-- ===== 5. A1/A3/A5 re-assertion =====
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0110 scope assertions failed:\n%', v_violations;
  end if;
end
$$;

-- ===== 6. Anchors =====
do $$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'apply_reviewed_document';

  -- (a) The gate. If the recomputation stops being consulted, the command becomes a client-driven
  -- writer of financial records and every read-side guarantee in 0106-0109 becomes decoration.
  if position('document_reconciliation_assessment' in v_def) = 0
     or position('approval_blocked' in v_def) = 0 then
    raise exception
      '0110: the apply command no longer recomputes the assessment or no longer reads '
      'approval_blocked. The reviewed proposal would then be trusted as submitted.';
  end if;

  -- (b) An invoice must not receive goods. These two column names appearing here would mean
  -- billing had started moving stock.
  if position('received_qty' in v_def) > 0
     or position('transition_purchase_order_status' in v_def) > 0 then
    raise exception
      '0110: the apply command touches received_qty or order status. Billing is not receiving -- '
      'a supplier could close an order by sending paperwork.';
  end if;

  -- (c) A delivery note produces a DRAFT and nothing else.
  if position('''completed''' in v_def) > 0 then
    raise exception
      '0110: the apply command can write a completed receipt. Only a separate human confirmation '
      'that the goods arrived may do that (0090, OPEN-DECISIONS #125-126).';
  end if;

  -- (d) A receipt creates no payable. `insert into public.payments` or a second invoice insert in
  -- the tax_receipt branch would make a receipt a debt.
  if (select count(*) from regexp_matches(v_def, 'insert into public\.invoices', 'g')) <> 1 then
    raise exception '0110: the apply command creates invoices in more than one place.';
  end if;
  if position('insert into public.payments' in v_def) > 0 then
    raise exception
      '0110: the apply command creates a payment. A tax receipt is evidence, never a payable '
      '(OPEN-DECISIONS #141).';
  end if;

  -- (e) Scope, which RLS cannot do inside a definer body.
  if position('auth_scopes()' in v_def) = 0 then
    raise exception '0110: the apply command no longer narrows by auth_scopes().';
  end if;

  -- (f) The ledger is immutable and the browser cannot rewrite history.
  if not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'document_review_applications'
      and t.tgname = 'document_review_applications_immutable_trg' and not t.tgisinternal) then
    raise exception '0110: the application ledger lost its immutability trigger.';
  end if;
  if has_table_privilege('authenticated', 'public.document_review_applications', 'insert')
     or has_table_privilege('authenticated', 'public.document_review_applications', 'update')
     or has_table_privilege('authenticated', 'public.document_review_applications', 'delete') then
    raise exception '0110: a client role can write the application ledger directly.';
  end if;

  -- (g) A reviewer''s product mapping is honoured, and labelled as a decision rather than a match.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.proname = 'document_assessment_lines';
  if position('''reviewer''' in v_def) = 0 then
    raise exception
      '0110: a reviewer''s explicit product mapping is no longer honoured, so a line the automatic '
      'matcher refuses to guess at can never be resolved by the person whose job that is.';
  end if;
end
$$;
