-- 0090 -- Turn a confidently-read delivery note into a DRAFT goods receipt, linked to its order.
--
-- WHY THIS EXISTS. Measured on production 09.08.2026: four phone photos of delivery notes were
-- read perfectly (1,176-1,503 chars of Hebrew, supplier matched at 0.98-0.99, 3-7 priced lines)
-- and then produced nothing, because 0077's ladder refuses everything that is not an invoice
-- (`not_an_invoice`, 0077:976-980). The owner read that as "automatic processing only works for
-- PDF and Excel". It never was a format gate -- it is a document-type gate, and delivery notes
-- are exactly what a kitchen photographs at the door.
--
-- WHY A DRAFT AND NOT A COMPLETED RECEIPT. Owner decision, 09.08.2026. Completing a receipt is
-- not a filing action, it is four financial ones, and each collides with a rule that already
-- exists:
--   * 0026_inventory_ledger.sql:113-158 fires on draft->completed and RAISES
--     `inventory_receipt_actor_required` when received_by is null. Completing automatically would
--     mean naming a human who never touched the goods -- against 0077:54-59.
--   * 0023:1505-1525 requires one payload line per ORDER line. A delivery note listing 3 of 8
--     ordered products cannot be completed without asserting the other 5 are missing, which is a
--     claim about the world that the document does not make.
--   * received_qty, purchase_orders.status and credit_requests would all move on the strength of
--     a photograph.
-- A draft moves none of them. It is the whole job done except the one keystroke that carries
-- human responsibility.
--
-- THE IRON RULE OF THIS FILE: it writes goods_receipts (status 'draft'), goods_receipt_items,
-- its own two ledger tables, one document_filings row, the documents row and the job stage.
-- It writes NOTHING to purchase_order_items, purchase_orders, inventory_movements,
-- credit_requests or invoices. The p16 suite asserts that as a fact about the data, not a hope.
--
-- WHY A SEPARATE COMMAND AND NOT A NEW ARM OF 0077. Same reason 0081 was separate, and 0081
-- never had to touch p14: `p14_apply_interpretation.sql:1566-1581` pins
-- apply_document_interpretation to exactly 14 reason codes, and :1603-1616 pins that its source
-- text never writes purchase_order_items. A third destination belongs beside the second, not
-- inside the first.

-- ===== 1. The third financial policy =====
insert into private.autonomy_policy_definitions (
  policy_key, description, baseline_enabled, baseline_min_confidence, kill_switch
) values (
  'delivery_note.receiving',
  'May the system open a DRAFT goods receipt from an interpreted delivery note without a human. '
  'The draft is linked to one purchase order, carries only the lines whose sku or barcode matched '
  'a product already on that order, and moves no stock, no received quantity, no order status and '
  'no credit request -- a person still completes it. Baseline is off; 0.900 is uncalibrated.',
  false, 0.900, false
);

-- ===== 2. The decision ledger =====
-- Same shape as price_list_interpretation_decisions: the reversal handle, the reason the machine
-- stopped, and the per-line record of what it did and did not take.
create table public.delivery_note_interpretation_decisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  document_id uuid not null,
  job_id uuid not null,
  interpretation_id uuid not null,
  actor_id uuid not null,
  supplier_id uuid,
  order_id uuid,
  receipt_id uuid,
  outcome text not null check (outcome in ('queued_for_review', 'draft_created')),
  reason_code text,
  -- Which tier of evidence resolved the order. Stored because "why is this receipt attached to
  -- that order" is the first question anyone will ask when a link turns out wrong, and the three
  -- tiers are not equally trustworthy.
  order_matched_by text check (
    order_matched_by in ('by_number', 'by_items', 'single_open_order')
  ),
  decision_confidence numeric,
  matched_count integer not null default 0 check (matched_count >= 0),
  waiting_count integer not null default 0 check (waiting_count >= 0),
  created_at timestamptz not null default now(),
  reverted_at timestamptz,
  reverted_by uuid,
  reverted_reason text,
  constraint delivery_note_decisions_org_id_id unique (org_id, id),
  constraint delivery_note_decisions_interpretation_key unique (org_id, interpretation_id),
  constraint delivery_note_decisions_document_fk
    foreign key (org_id, document_id) references public.documents(org_id, id) on delete restrict,
  constraint delivery_note_decisions_job_fk
    foreign key (org_id, job_id)
      references public.document_processing_jobs(org_id, id) on delete restrict,
  constraint delivery_note_decisions_interpretation_fk
    foreign key (org_id, interpretation_id)
      references public.document_interpretations(org_id, id) on delete restrict,
  constraint delivery_note_decisions_actor_fk
    foreign key (org_id, actor_id) references public.profiles(org_id, id) on delete restrict,
  constraint delivery_note_decisions_supplier_fk
    foreign key (org_id, supplier_id) references public.suppliers(org_id, id) on delete restrict,
  constraint delivery_note_decisions_order_fk
    foreign key (org_id, order_id) references public.purchase_orders(org_id, id) on delete restrict,
  -- No FK to goods_receipts: reversal DELETES the draft, and a restrict FK would refuse while a
  -- cascade would silently erase the audit handle. The id is kept as evidence of what was made.
  constraint delivery_note_decisions_reversal_shape check (
    (reverted_at is null and reverted_by is null and reverted_reason is null)
    or (
      reverted_at is not null and reverted_by is not null
      and length(trim(reverted_reason)) between 1 and 1000
      and receipt_id is not null
    )
  ),
  constraint delivery_note_decisions_outcome_shape check (
    (
      outcome = 'queued_for_review'
      and receipt_id is null and order_matched_by is null and matched_count = 0
    )
    or (
      outcome = 'draft_created'
      and receipt_id is not null and order_id is not null
      and order_matched_by is not null and matched_count > 0 and reason_code is null
    )
  )
);

create table public.delivery_note_interpretation_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  decision_id uuid not null,
  document_id uuid not null,
  interpretation_id uuid not null,
  line_index integer not null check (line_index >= 0),
  source_row integer,
  outcome text not null check (outcome in ('applied', 'waiting')),
  reason_code text,
  product_id uuid,
  order_item_id uuid,
  sku text,
  barcode text,
  qty_received numeric(12,2),
  created_at timestamptz not null default now(),
  constraint delivery_note_lines_decision_fk
    foreign key (org_id, decision_id)
      references public.delivery_note_interpretation_decisions(org_id, id) on delete cascade,
  constraint delivery_note_lines_document_fk
    foreign key (org_id, document_id) references public.documents(org_id, id) on delete restrict,
  constraint delivery_note_lines_interpretation_fk
    foreign key (org_id, interpretation_id)
      references public.document_interpretations(org_id, id) on delete restrict,
  constraint delivery_note_lines_product_fk
    foreign key (org_id, product_id) references public.products(org_id, id) on delete restrict,
  constraint delivery_note_lines_unique unique (org_id, interpretation_id, line_index),
  constraint delivery_note_lines_shape check (
    (
      outcome = 'applied' and reason_code is null
      and product_id is not null and order_item_id is not null and qty_received is not null
    )
    or (outcome = 'waiting' and reason_code is not null and order_item_id is null)
  )
);

alter table public.delivery_note_interpretation_decisions enable row level security;
alter table public.delivery_note_interpretation_decisions force row level security;
alter table public.delivery_note_interpretation_lines enable row level security;
alter table public.delivery_note_interpretation_lines force row level security;

-- Receiving is kitchen work as much as office work -- goods_receipts_write already grants
-- owner/office/kitchen (0001_init.sql:546), and the people who read this ledger are the people
-- standing at the delivery. Suppliers never see it: a delivery note is our record of what
-- arrived, not theirs.
create policy delivery_note_interpretation_decisions_select
on public.delivery_note_interpretation_decisions for select to authenticated
using (
  org_id = auth_org()
  and exists (
    select 1 from public.profiles p
    where p.org_id = auth_org() and p.id = auth.uid() and p.active
      and p.role in ('owner', 'office', 'kitchen')
  )
);

create policy delivery_note_interpretation_lines_select
on public.delivery_note_interpretation_lines for select to authenticated
using (
  exists (
    select 1 from public.delivery_note_interpretation_decisions d
    where d.org_id = delivery_note_interpretation_lines.org_id
      and d.id = delivery_note_interpretation_lines.decision_id
  )
);

revoke all on table public.delivery_note_interpretation_decisions
  from public, anon, authenticated;
revoke all on table public.delivery_note_interpretation_lines
  from public, anon, authenticated;
grant select on table public.delivery_note_interpretation_decisions to authenticated;
grant select on table public.delivery_note_interpretation_lines to authenticated;
grant select, insert, update, delete
  on table public.delivery_note_interpretation_decisions to service_role;
grant select, insert, update, delete
  on table public.delivery_note_interpretation_lines to service_role;

-- Even the trusted role cannot turn table DML into a second receiving command.
create or replace function public.delivery_note_interpretation_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if current_setting('app.delivery_note_auto_writer', true) not in ('apply', 'revert') then
    raise exception 'delivery_note_interpretation_immutable' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (
    old.id is distinct from new.id
    or old.org_id is distinct from new.org_id
    or old.document_id is distinct from new.document_id
    or old.job_id is distinct from new.job_id
    or old.interpretation_id is distinct from new.interpretation_id
    or old.actor_id is distinct from new.actor_id
    or old.supplier_id is distinct from new.supplier_id
    or old.order_id is distinct from new.order_id
    or old.receipt_id is distinct from new.receipt_id
    or old.outcome is distinct from new.outcome
    or old.reason_code is distinct from new.reason_code
    or old.order_matched_by is distinct from new.order_matched_by
    or old.decision_confidence is distinct from new.decision_confidence
    or old.matched_count is distinct from new.matched_count
    or old.waiting_count is distinct from new.waiting_count
    or old.created_at is distinct from new.created_at
  ) then
    raise exception 'delivery_note_interpretation_immutable' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;
revoke all on function public.delivery_note_interpretation_guard()
  from public, anon, authenticated, service_role;

create trigger delivery_note_interpretation_decisions_guard
  before insert or update or delete on public.delivery_note_interpretation_decisions
  for each row execute function public.delivery_note_interpretation_guard();

create or replace function public.delivery_note_interpretation_lines_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if current_setting('app.delivery_note_auto_writer', true) <> 'apply' then
    raise exception 'delivery_note_interpretation_line_immutable' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;
revoke all on function public.delivery_note_interpretation_lines_guard()
  from public, anon, authenticated, service_role;

create trigger delivery_note_interpretation_lines_guard
  before insert or update or delete on public.delivery_note_interpretation_lines
  for each row execute function public.delivery_note_interpretation_lines_guard();

-- ===== 3. Resolving the order, on the strongest evidence available =====
-- A delivery note names a supplier and some goods. goods_receipts.order_id is NOT NULL
-- (0001_init.sql:176), so without an order there is no receipt to make. Three tiers, strongest
-- first, and the tier is recorded on the decision.
--
-- Tier 3 is the heuristic 0077:1134-1141 REFUSES BY NAME for invoices, and refusing it there is
-- still right: an invoice is a debt, created without a human, and a wrong link corrupts order
-- status and every savings analysis built on it. The owner accepted it here on 09.08.2026 for a
-- materially different artefact -- a draft that moves no stock, no quantity and no status, that a
-- person sees and confirms before anything happens, and that one reasoned action deletes. The
-- asymmetry is deliberate and is recorded in docs/DEBT-REGISTER.md, not smuggled in.
create or replace function private.resolve_delivery_note_order(
  p_org_id uuid,
  p_supplier_id uuid,
  p_order_number numeric,
  p_product_ids uuid[]
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
begin
  if p_org_id is null or p_supplier_id is null then
    return jsonb_build_object('status', 'unresolved');
  end if;

  -- Tier 1 -- the number the model actually transcribed off the page. Bounded to int4 BEFORE the
  -- cast for the reason 0077:1146-1150 records: a supplier printing a date-shaped reference like
  -- 20260403001 raised `22003: integer out of range` from the cast and aborted the command.
  if p_order_number is not null
     and p_order_number = trunc(p_order_number)
     and p_order_number between 1 and 2147483647 then
    select array_agg(po.id) into v_ids
    from public.purchase_orders po
    where po.org_id = p_org_id
      and po.supplier_id = p_supplier_id
      and po.number = p_order_number::int
      and po.status in ('sent', 'confirmed', 'partial');
    if cardinality(v_ids) = 1 then
      return jsonb_build_object('status', 'matched', 'order_id', v_ids[1],
                                'matched_by', 'by_number');
    end if;
  end if;

  -- Tier 2 -- the goods themselves. An order that contains EVERY product this note delivered is
  -- evidence off the page; an order that contains only some of them is not, because a partial
  -- overlap is exactly what two concurrent orders to one supplier look like.
  if p_product_ids is not null and cardinality(p_product_ids) > 0 then
    select array_agg(po.id) into v_ids
    from public.purchase_orders po
    where po.org_id = p_org_id
      and po.supplier_id = p_supplier_id
      and po.status in ('sent', 'confirmed', 'partial')
      and not exists (
        select 1 from unnest(p_product_ids) as wanted(product_id)
        where not exists (
          select 1 from public.purchase_order_items poi
          where poi.order_id = po.id and poi.product_id = wanted.product_id
        )
      );
    if cardinality(v_ids) = 1 then
      return jsonb_build_object('status', 'matched', 'order_id', v_ids[1],
                                'matched_by', 'by_items');
    end if;
  end if;

  -- Tier 3 -- one open order and nothing else it could be.
  select array_agg(po.id) into v_ids
  from public.purchase_orders po
  where po.org_id = p_org_id
    and po.supplier_id = p_supplier_id
    and po.status in ('sent', 'confirmed', 'partial');
  if cardinality(v_ids) = 1 then
    return jsonb_build_object('status', 'matched', 'order_id', v_ids[1],
                              'matched_by', 'single_open_order');
  end if;

  return jsonb_build_object('status', 'unresolved');
end
$$;
revoke all on function private.resolve_delivery_note_order(uuid, uuid, numeric, uuid[])
  from public, anon, authenticated, service_role;

-- ===== 4. The command =====
create or replace function public.apply_delivery_note_interpretation(
  p_job_id uuid,
  p_interpretation_id uuid,
  p_actor_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_job public.document_processing_jobs;
  v_i public.document_interpretations;
  v_doc public.documents;
  v_policy record;
  v_existing public.delivery_note_interpretation_decisions;
  v_decision_id uuid := gen_random_uuid();
  v_actor uuid;
  v_supplier_id uuid;
  v_reason_code text;
  v_line_reason_code text;
  v_decision_confidence numeric;
  v_type_conf numeric;
  v_supplier_conf numeric;
  v_payload jsonb;
  v_order_number numeric;
  v_date date;
  v_resolution jsonb;
  v_order public.purchase_orders;
  v_order_matched_by text;
  v_line jsonb;
  v_values jsonb;
  v_line_index integer;
  v_source_row integer;
  v_sku text;
  v_barcode text;
  v_qty_text text;
  v_qty numeric;
  v_match jsonb;
  v_product_id uuid;
  v_order_item public.purchase_order_items;
  v_remaining numeric;
  v_line_status public.receipt_line_status;
  v_matched_products uuid[] := array[]::uuid[];
  v_claimed_products uuid[] := array[]::uuid[];
  v_line_results jsonb := '[]'::jsonb;
  v_matched integer := 0;
  v_waiting integer := 0;
  v_receipt_id uuid;
  v_filing_id uuid;
  v_outcome text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select * into v_i
  from public.document_interpretations i
  where i.id = p_interpretation_id and i.job_id = p_job_id;
  if not found then
    raise exception 'document_interpretation_unknown' using errcode = 'P0002';
  end if;
  select * into v_job
  from public.document_processing_jobs j
  where j.id = p_job_id and j.org_id = v_i.org_id and j.document_id = v_i.document_id
  for update;
  if not found then
    raise exception 'document_processing_job_unknown' using errcode = 'P0002';
  end if;
  select * into v_doc
  from public.documents d
  where d.id = v_i.document_id and d.org_id = v_i.org_id and d.deleted_at is null
  for update;
  if not found then
    raise exception 'document_unknown' using errcode = 'P0002';
  end if;

  -- The actor chain, identical in spirit to 0081:542-553. The machine runs as somebody, and that
  -- somebody must be the one person who uploaded the document, requested the job and owns the
  -- interpretation -- not whoever the caller claims.
  v_actor := coalesce(p_actor_id, v_doc.uploaded_by);
  if v_actor is distinct from v_doc.uploaded_by
     or v_job.requested_by is distinct from v_actor
     or v_job.interpretation_actor_id is distinct from v_actor
     or v_i.interpreted_for_user_id is distinct from v_actor
     or not exists (
       select 1 from public.profiles p
       where p.org_id = v_i.org_id and p.id = v_actor and p.active
         and p.role in ('owner', 'office', 'kitchen')
     ) then
    raise exception 'document_interpretation_actor_invalid' using errcode = '42501';
  end if;

  select * into v_existing
  from public.delivery_note_interpretation_decisions d
  where d.org_id = v_i.org_id and d.interpretation_id = v_i.id;
  if found then
    return jsonb_build_object(
      'decision_id', v_existing.id,
      'outcome', v_existing.outcome,
      'reason_code', v_existing.reason_code,
      'order_id', v_existing.order_id,
      'receipt_id', v_existing.receipt_id,
      'order_matched_by', v_existing.order_matched_by,
      'matched_count', v_existing.matched_count,
      'waiting_count', v_existing.waiting_count,
      'idempotent', true
    );
  end if;

  v_payload := v_i.payload;
  if jsonb_typeof(v_payload -> 'line_items') <> 'array' then
    raise exception 'document_interpretation_invalid' using errcode = '22023';
  end if;

  v_type_conf := private.interpretation_number(v_payload -> 'document_type_confidence');
  v_supplier_conf := private.interpretation_number(v_payload #> '{supplier,confidence}');
  -- NULL-PROPAGATING minimum, for 0077's note 3 reason: least() ignores nulls, and an unknown
  -- confidence must not be allowed to disappear behind a known one.
  v_decision_confidence := case
    when v_type_conf is null or v_supplier_conf is null then null
    else least(v_type_conf, v_supplier_conf)
  end;
  v_supplier_id := v_i.suggested_supplier_id;
  v_date := private.interpretation_date(
    private.interpretation_field(v_payload, array[
      'delivery_note_date', 'invoice_date', 'document_date', 'date',
      'תאריך תעודה', 'תאריך המסמך', 'תאריך']));

  select * into v_policy
  from private.autonomy_policy_for_org(v_i.org_id, 'delivery_note.receiving');

  if not exists (
    select 1 from public.organizations o
    where o.id = v_i.org_id and o.status in ('trial', 'active')
  ) then
    v_reason_code := 'organization_inactive';
  elsif not coalesce(v_policy.autonomy_enabled, false) then
    -- OFF MEANS ZERO. Not a draft, not a filing, not a document move.
    v_reason_code := 'autonomy_disabled';
  elsif v_doc.document_kind <> 'delivery_note'
     or v_payload ->> 'document_type' <> 'delivery_note' then
    -- Doubled gate, as 0081:580-581. The classifier writes document_kind and the model writes
    -- document_type; requiring both means one of them being wrong stops the machine.
    v_reason_code := 'not_a_delivery_note';
  elsif v_decision_confidence is null then
    v_reason_code := 'confidence_unknown';
  elsif v_policy.min_confidence is null
     or v_decision_confidence < v_policy.min_confidence then
    v_reason_code := 'below_confidence_threshold';
  elsif v_supplier_id is null
     or not exists (
       select 1 from public.suppliers s
       where s.org_id = v_i.org_id and s.id = v_supplier_id and s.deleted_at is null
     ) then
    -- Without a supplier there is no set of orders to choose from, and "the likeliest supplier"
    -- is a guess that would pick somebody else's order.
    v_reason_code := 'supplier_unidentified';
  end if;

  -- Two delivery notes from one supplier must not both decide the same order has no draft yet.
  if v_reason_code is null then
    perform pg_advisory_xact_lock(
      hashtextextended(v_i.org_id::text || ':' || v_supplier_id::text, 0)
    );
  end if;

  -- ---- Pass 1: read the lines and match products. No order is known yet, and that is the
  -- point: the matched products are themselves the evidence that picks the order.
  for v_line, v_line_index in
    select item.value, (item.ordinality - 1)::integer
    from jsonb_array_elements(v_payload -> 'line_items')
      with ordinality as item(value, ordinality)
  loop
    v_values := v_line -> 'values';
    v_source_row := case
      when jsonb_typeof(v_line -> 'source_row') = 'number'
        then (v_line ->> 'source_row')::integer
      else null
    end;
    v_sku := nullif(trim(v_values ->> 'sku'), '');
    v_barcode := nullif(trim(v_values ->> 'barcode'), '');
    v_qty_text := trim(coalesce(
      v_values ->> 'quantity', v_values ->> 'qty', v_values ->> 'כמות', ''));
    v_line_reason_code := v_reason_code;
    v_product_id := null;
    v_qty := null;

    if v_line_reason_code is null then
      -- Reusing 0081's matcher rather than writing a second one. It is the same question -- which
      -- product is this printed code -- with the same three keys in the same precedence and the
      -- same refusal to answer when two products share a code. Product NAMES are never a key:
      -- "עגבניות שרי" and "עגבניות שרי 500 גרם" are one product to a person and two strings to
      -- Postgres, and a wrong match here credits the wrong product's quantity.
      v_match := private.match_price_list_line(v_i.org_id, v_supplier_id, v_sku, v_barcode);
      if v_match ->> 'status' = 'ambiguous' then
        v_line_reason_code := 'line_product_ambiguous';
      elsif v_match ->> 'status' <> 'matched' then
        v_line_reason_code := 'line_product_unmatched';
      else
        v_product_id := (v_match ->> 'product_id')::uuid;
        v_qty_text := regexp_replace(v_qty_text, '[[:space:],]', '', 'g');
        if v_qty_text ~ '^[0-9]+(\.[0-9]+)?$' then
          v_qty := v_qty_text::numeric;
        end if;
        if v_qty is null or v_qty <= 0 then
          -- A quantity that cannot be read is not a zero. Zero is a claim that nothing arrived.
          v_line_reason_code := 'line_quantity_unreadable';
          v_product_id := null;
        elsif v_product_id = any(v_matched_products) then
          -- The same product on two lines of one note would need adding up, and a misread unit on
          -- either line would make the sum wrong without either line looking wrong.
          v_line_reason_code := 'line_product_repeated';
          v_product_id := null;
        else
          v_matched_products := v_matched_products || v_product_id;
        end if;
      end if;
    end if;

    v_line_results := v_line_results || jsonb_build_array(jsonb_build_object(
      'line_index', v_line_index,
      'source_row', v_source_row,
      'reason_code', v_line_reason_code,
      'product_id', v_product_id,
      'sku', v_sku,
      'barcode', v_barcode,
      'qty', v_qty
    ));
  end loop;

  -- ---- Resolve the order from what the lines proved.
  if v_reason_code is null then
    v_order_number := private.interpretation_number(
      private.interpretation_field(v_payload, array[
        'order_number', 'purchase_order_number', 'po_number', 'reference_order_number',
        'מספר הזמנה', 'הזמנה']));
    v_resolution := private.resolve_delivery_note_order(
      v_i.org_id, v_supplier_id, v_order_number, v_matched_products);
    if v_resolution ->> 'status' <> 'matched' then
      v_reason_code := 'order_unresolved';
    else
      select * into v_order
      from public.purchase_orders po
      where po.org_id = v_i.org_id and po.id = (v_resolution ->> 'order_id')::uuid
      for update;
      if not found then
        raise exception 'purchase_order_unknown' using errcode = 'P0002';
      end if;
      v_order_matched_by := v_resolution ->> 'matched_by';
      -- 0023:1527-1533 permits one draft per order. A second one would be a receipt nobody can
      -- save, so the honest answer is to stop and say a draft is already waiting.
      if exists (
        select 1 from public.goods_receipts g
        where g.org_id = v_i.org_id and g.order_id = v_order.id and g.status = 'draft'
      ) then
        v_reason_code := 'receipt_draft_conflict';
        v_order_matched_by := null;
      end if;
    end if;
  end if;

  -- ---- Pass 2: bind each matched product to a line of THAT order.
  v_matched := 0;
  v_waiting := 0;
  if v_reason_code is null then
    declare
      v_bound jsonb := '[]'::jsonb;
    begin
      for v_line in select value from jsonb_array_elements(v_line_results)
      loop
        v_line_reason_code := v_line ->> 'reason_code';
        v_product_id := case when v_line ->> 'product_id' is null then null
                             else (v_line ->> 'product_id')::uuid end;
        v_qty := case when v_line ->> 'qty' is null then null
                      else (v_line ->> 'qty')::numeric end;
        v_order_item := null;
        v_line_status := null;

        if v_line_reason_code is null then
          select * into v_order_item
          from public.purchase_order_items poi
          where poi.order_id = v_order.id and poi.product_id = v_product_id
          for update;
          if not found then
            -- Delivered, but not on this order. 0077:1171-1236 turns the same fact into an
            -- exception for an invoice; here the honest move is to leave the line out of the
            -- draft and name it, because a receipt line needs an order line to point at
            -- (goods_receipt_items.order_item_id is NOT NULL).
            v_line_reason_code := 'line_not_on_order';
          else
            v_remaining := v_order_item.qty - v_order_item.received_qty;
            if v_remaining <= 0 then
              v_line_reason_code := 'line_already_received';
            elsif round(v_qty, 2) > round(v_remaining, 2) then
              -- save_goods_receipt refuses qty above what is outstanding (0023:1505-1525). A
              -- draft carrying such a line could never be saved by the person who opens it.
              v_line_reason_code := 'line_quantity_exceeds_order';
            else
              v_line_status := case
                when round(v_qty, 2) = round(v_remaining, 2) then 'full'
                else 'partial'
              end::public.receipt_line_status;
            end if;
          end if;
        end if;

        if v_line_reason_code is null then
          v_claimed_products := v_claimed_products || v_product_id;
          v_matched := v_matched + 1;
          v_bound := v_bound || jsonb_build_array(v_line || jsonb_build_object(
            'outcome', 'applied',
            'reason_code', null,
            'order_item_id', v_order_item.id,
            'line_status', v_line_status::text
          ));
        else
          v_waiting := v_waiting + 1;
          v_bound := v_bound || jsonb_build_array(v_line || jsonb_build_object(
            'outcome', 'waiting',
            'reason_code', v_line_reason_code,
            'product_id', null,
            'order_item_id', null,
            'qty', null,
            'line_status', null
          ));
        end if;
      end loop;
      v_line_results := v_bound;
    end;

    if v_matched = 0 then
      v_reason_code := 'no_line_matched';
    end if;
  end if;

  -- Every line inherits the document-level stop when there is one, so the ledger explains each
  -- line rather than leaving a silent gap.
  if v_reason_code is not null then
    v_line_results := (
      select coalesce(jsonb_agg(
        line || jsonb_build_object(
          'outcome', 'waiting',
          'reason_code', coalesce(line ->> 'reason_code', v_reason_code),
          'product_id', null, 'order_item_id', null, 'qty', null, 'line_status', null
        ) order by (line ->> 'line_index')::integer), '[]'::jsonb)
      from jsonb_array_elements(v_line_results) line
    );
    v_matched := 0;
    v_waiting := jsonb_array_length(v_line_results);
    v_outcome := 'queued_for_review';
  else
    v_outcome := 'draft_created';
  end if;

  -- ---- The writes.
  if v_outcome = 'draft_created' then
    -- org_id and every other tenant column SPELLED OUT: the auth_org() defaults are NULL for a
    -- trusted-server caller (0077:1161-1165). received_by stays NULL because no human received
    -- these goods -- which is also exactly what keeps 0026's inventory trigger asleep.
    insert into public.goods_receipts (org_id, order_id, status, received_by, notes)
    values (
      v_i.org_id, v_order.id, 'draft', null,
      'טיוטה שנוצרה אוטומטית מתעודת משלוח, פירוש ' || v_i.id
    )
    returning id into v_receipt_id;

    insert into public.goods_receipt_items (
      org_id, receipt_id, order_item_id, product_id, qty_received, status, notes
    )
    select v_i.org_id, v_receipt_id,
           (line ->> 'order_item_id')::uuid,
           (line ->> 'product_id')::uuid,
           (line ->> 'qty')::numeric,
           (line ->> 'line_status')::public.receipt_line_status,
           null
    from jsonb_array_elements(v_line_results) line
    where line ->> 'outcome' = 'applied';

    update public.documents
    set entity_type = 'goods_receipt',
        entity_id = v_receipt_id,
        supplier_id = v_supplier_id,
        document_date = coalesce(v_date, document_date)
    where id = v_doc.id;
  end if;

  -- The filing row, for every outcome -- this command owns it, because routing means 0077 never
  -- runs for a delivery note and nothing else would ever say why the machine stopped.
  insert into public.document_filings (
    org_id, document_id, category, supplier_id, interpretation_id,
    confidence, decided_by, reason_code
  ) values (
    v_i.org_id, v_doc.id, 'delivery_note', v_supplier_id, v_i.id,
    v_decision_confidence, 'system', v_reason_code
  ) returning id into v_filing_id;

  perform set_config('app.delivery_note_auto_writer', 'apply', true);
  insert into public.delivery_note_interpretation_decisions (
    id, org_id, document_id, job_id, interpretation_id, actor_id, supplier_id,
    order_id, receipt_id, outcome, reason_code, order_matched_by,
    decision_confidence, matched_count, waiting_count
  ) values (
    v_decision_id, v_i.org_id, v_doc.id, v_job.id, v_i.id, v_actor, v_supplier_id,
    case when v_outcome = 'draft_created' then v_order.id else null end,
    v_receipt_id, v_outcome, v_reason_code,
    case when v_outcome = 'draft_created' then v_order_matched_by else null end,
    v_decision_confidence, v_matched, v_waiting
  );

  insert into public.delivery_note_interpretation_lines (
    org_id, decision_id, document_id, interpretation_id,
    line_index, source_row, outcome, reason_code, product_id, order_item_id,
    sku, barcode, qty_received
  )
  select v_i.org_id, v_decision_id, v_doc.id, v_i.id,
         (line ->> 'line_index')::integer,
         case when line ->> 'source_row' is null then null
              else (line ->> 'source_row')::integer end,
         line ->> 'outcome', line ->> 'reason_code',
         case when line ->> 'product_id' is null then null
              else (line ->> 'product_id')::uuid end,
         case when line ->> 'order_item_id' is null then null
              else (line ->> 'order_item_id')::uuid end,
         line ->> 'sku', line ->> 'barcode',
         case when line ->> 'qty' is null then null else (line ->> 'qty')::numeric end
  from jsonb_array_elements(v_line_results) line;

  if v_outcome = 'draft_created' then
    -- The stage, guarded on 'review' for 0077:1093-1100's reason: an unguarded update on a job
    -- that moved underneath us aborts the whole command after the draft was written.
    update public.document_processing_jobs
    set status = case when v_waiting = 0 then 'completed' else 'review' end,
        last_error_code = null,
        last_error_message = null
    where org_id = v_i.org_id and id = v_job.id and status = 'review';

    insert into public.audit_logs (
      org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
    ) values (
      v_i.org_id, null, 'goods_receipt_draft_created_by_interpretation',
      'goods_receipts', v_receipt_id, null,
      jsonb_build_object(
        'decision_id', v_decision_id,
        'document_id', v_doc.id,
        'interpretation_id', v_i.id,
        'model', v_i.model,
        'provider', v_i.provider,
        'prompt_version', v_i.prompt_version,
        'supplier_id', v_supplier_id,
        'order_id', v_order.id,
        'order_matched_by', v_order_matched_by,
        'decision_confidence', to_jsonb(v_decision_confidence),
        'min_confidence', to_jsonb(v_policy.min_confidence),
        'matched_count', v_matched,
        'waiting_count', v_waiting),
      format(
        'טיוטת קבלת סחורה אוטומטית מתעודת משלוח. מודל: %s, גרסת פרומפט: %s, פירוש: %s, '
        || 'ביטחון: %s, איתור הזמנה: %s',
        v_i.model, v_i.prompt_version, v_i.id,
        coalesce(v_decision_confidence::text, 'לא ידוע'), v_order_matched_by));
  end if;

  return jsonb_build_object(
    'decision_id', v_decision_id,
    'outcome', v_outcome,
    'reason_code', v_reason_code,
    'order_id', case when v_outcome = 'draft_created' then v_order.id else null end,
    'receipt_id', v_receipt_id,
    'order_matched_by', v_order_matched_by,
    'filing_id', v_filing_id,
    'matched_count', v_matched,
    'waiting_count', v_waiting,
    'idempotent', false
  );
end
$$;

revoke all on function public.apply_delivery_note_interpretation(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
-- The trusted server and nobody else, exactly as 0077:1305-1311 and 0081:859-862.
grant execute on function public.apply_delivery_note_interpretation(uuid, uuid, uuid)
  to service_role;

-- ===== 4b. The sixth refiling leg, because 0077's reason for omitting it just expired =====
-- 0077:1406-1408 wrote, correctly at the time:
--   `goods_receipt -> inbox` is deliberately NOT added: nothing writes a goods_receipt filing
--   automatically, so there is no machine decision to reverse and no reasoned command that would
--   perform it.
-- The command above is now exactly that: it files a document to a goods receipt without a human,
-- so the reversal below has to be able to bring it back. Without this leg the revert dies on a
-- raw unnamed 42501 AFTER deleting the draft, leaving the document pointing at a receipt that no
-- longer exists.
--
-- Anchored substitution, the pattern 0077:1384-1426 established: the anchor is 0077's own
-- replacement text, so a migration that moved the predicate fails loudly here rather than
-- silently widening something else.
do $dnguard$
declare
  v_def text := replace(
    pg_get_functiondef('public.documents_guard_columns()'::regprocedure), e'\r', '');
  v_anchor text := replace($legacy$                or (old.entity_type = 'invoice'
                    and new.entity_type = 'inbox'
                    and new.entity_id is null);$legacy$, e'\r', '');
  v_replacement text := replace($widened$                or (old.entity_type = 'invoice'
                    and new.entity_type = 'inbox'
                    and new.entity_id is null)
                -- goods_receipt -> inbox (0090). The sixth leg, and the twin of the fifth: a
                -- draft receipt opened from a delivery note is a machine decision, and reverting
                -- it deletes the receipt the document was filed to. Same shape as the invoice
                -- leg -- no entity on the way back -- so it lands in the inbox where the manual
                -- שיוך actions work. Still fenced by app.document_filing_writer below, so only a
                -- reasoned command can perform it.
                or (old.entity_type = 'goods_receipt'
                    and new.entity_type = 'inbox'
                    and new.entity_id is null);$widened$, e'\r', '');
begin
  if position(v_anchor in v_def) = 0 then
    raise exception '0090: documents_guard_columns has moved -- the refiling predicate is not '
      'where 0077 left it. Re-read the live definition before editing.';
  end if;
  execute replace(v_def, v_anchor, v_replacement);
  if not (select prosecdef from pg_proc
          where oid = 'public.documents_guard_columns()'::regprocedure) then
    raise exception '0090: documents_guard_columns lost SECURITY DEFINER in the replay.';
  end if;
end
$dnguard$;
-- The trigger is NOT recreated: `create or replace function` preserves the OID, so the existing
-- trigger fires the replaced body (0077:1428-1431).

-- ===== 5. Reasoned reversal =====
-- Cheap, because the draft never moved anything. Deleting it restores the world; the only thing
-- that cannot be undone is a human having already completed it, and then it is not ours to undo.
create or replace function public.revert_delivery_note_receipt(
  p_decision_id uuid,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role public.user_role := auth_role();
  v_reason text := nullif(trim(p_reason), '');
  v_decision public.delivery_note_interpretation_decisions;
  v_receipt public.goods_receipts;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office', 'kitchen') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if length(v_reason) > 1000 then
    raise exception 'reason_too_long' using errcode = '22023';
  end if;

  select * into v_decision
  from public.delivery_note_interpretation_decisions d
  where d.id = p_decision_id and d.org_id = v_org
  for update;
  if not found then
    raise exception 'delivery_note_auto_action_unknown' using errcode = 'P0002';
  end if;
  if v_decision.receipt_id is null then
    raise exception 'delivery_note_auto_action_not_applied' using errcode = '55000';
  end if;
  if v_decision.reverted_at is not null then
    raise exception 'delivery_note_auto_action_already_reverted' using errcode = '55000';
  end if;

  select * into v_receipt
  from public.goods_receipts g
  where g.org_id = v_org and g.id = v_decision.receipt_id
  for update;
  if not found then
    raise exception 'delivery_note_auto_action_superseded' using errcode = '55000';
  end if;
  if v_receipt.status <> 'draft' then
    -- Somebody stood at the delivery, checked it and completed it. That receipt has moved stock
    -- and quantities and belongs to them now; undoing it is save_goods_receipt's business, not
    -- a reversal of a machine suggestion.
    raise exception 'delivery_note_receipt_already_completed' using errcode = '55000';
  end if;

  perform set_config('app.p1_financial_writer', v_user::text, true);
  -- goods_receipt_items cascades on receipt delete (0001_init.sql:186).
  delete from public.goods_receipts where id = v_receipt.id;

  -- The filing fence, not decoration: documents_guard_columns raises document_filing_rpc_required
  -- for any refiling by a caller with a JWT that has not announced itself. This command has one,
  -- unlike the apply path above where auth.uid() is NULL and the fence never evaluates.
  perform set_config('app.document_filing_writer', v_user::text, true);
  update public.documents
  set entity_type = 'inbox', entity_id = null
  where org_id = v_org and id = v_decision.document_id and entity_id = v_receipt.id;

  update public.document_filings
  set reverted_at = now(), reverted_reason = v_reason
  where org_id = v_org and document_id = v_decision.document_id
    and interpretation_id = v_decision.interpretation_id
    and decided_by = 'system' and reverted_at is null;

  update public.document_processing_jobs
  set status = 'review'
  where org_id = v_org and id = v_decision.job_id and status = 'completed';

  perform set_config('app.delivery_note_auto_writer', 'revert', true);
  update public.delivery_note_interpretation_decisions
  set reverted_at = now(), reverted_by = v_user, reverted_reason = v_reason
  where id = v_decision.id;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_user, 'goods_receipt_draft_reverted', 'goods_receipts', v_receipt.id,
    jsonb_build_object(
      'decision_id', v_decision.id,
      'document_id', v_decision.document_id,
      'order_id', v_decision.order_id,
      'order_matched_by', v_decision.order_matched_by,
      'matched_count', v_decision.matched_count),
    null, v_reason);

  return jsonb_build_object(
    'decision_id', v_decision.id,
    'receipt_id', v_receipt.id,
    'document_id', v_decision.document_id,
    'reverted', true
  );
end
$$;
revoke all on function public.revert_delivery_note_receipt(uuid, text)
  from public, anon, service_role;
grant execute on function public.revert_delivery_note_receipt(uuid, text) to authenticated;

-- ===== 6. Scope registry and definer exemptions =====
insert into private.scope_registry (table_name, scope_class, enforced) values
  ('delivery_note_interpretation_decisions', 'org_global', false),
  ('delivery_note_interpretation_lines', 'org_global', false);

insert into private.scope_definer_exemptions (function_signature, reason, target_wave)
values (
  'private.resolve_delivery_note_order(uuid,uuid,numeric,uuid[])'::regprocedure::text,
  'internal-only -- no role has EXECUTE; apply_delivery_note_interpretation is the only caller. '
    || 'Every candidate order is filtered by the org_id and supplier_id passed in, which the '
    || 'command derives from the interpretation row, and the function returns only an order id.',
  'multi-unit enablement wave'
);

insert into private.scope_definer_exemptions (function_signature, reason, target_wave)
values (
  'public.apply_delivery_note_interpretation(uuid,uuid,uuid)'::regprocedure::text,
  'trusted-server-no-scope -- service_role has no user JWT, so auth_scopes() is empty. Tenant '
    || 'identity is pinned by the interpretation org_id and tenant-composite document, job, '
    || 'actor, supplier and order keys before the draft receipt is written.',
  'multi-unit enablement wave'
);

insert into private.scope_definer_exemptions (function_signature, reason, target_wave)
values (
  'public.revert_delivery_note_receipt(uuid,text)'::regprocedure::text,
  'reversal-mirrors-writer -- runs as the reverting person (auth_org/auth.uid/auth_role are all '
    || 'read and enforced first) but must delete a goods_receipts row that 0023:167-168 revoked '
    || 'from authenticated, so the write cannot be an invoker one.',
  'multi-unit enablement wave'
);
