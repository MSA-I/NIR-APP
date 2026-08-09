-- Package 2 of the "finished product" campaign (owner decisions, 08.08.2026):
--
--   (1) OPEN-DECISIONS #49, decided: damaged/returned receipt lines open a credit request
--       AUTOMATICALLY, under the same p_open_credits switch the shortage automation already
--       uses. The credit is the full unusable quantity at the order's snapshot price —
--       "partial replacement" refinements remain a later decision; today the supplier owes
--       for everything that arrived unusable.
--   (2) OPEN-DECISIONS #116, decided: a manual exception can be opened by owner/office only,
--       via one reasoned command (open_manual_exception), on a purchase order or an invoice.
--       The browser still holds NO INSERT grant on `exceptions` (0036) — this command is the
--       single door, and it audits with a reason like every other reasoned command.
--
-- The save_goods_receipt change is an INJECTION into the live body (pg_get_functiondef +
-- anchors asserted to appear exactly once), never a restatement of 0023's text — the
-- silent-revert trap this repo has documented three times (0078/0079 pattern).

-- ===== 1. Damaged/returned lines join the credit automation =====
do $receipt_credit_injection$
declare
  v_signature regprocedure :=
    'public.save_goods_receipt(uuid,uuid,boolean,text,boolean,jsonb,text)'::regprocedure;
  v_definition text;
  v_eol text;
  v_anchor text;
  v_inject text;
begin
  select pg_get_functiondef(v_signature::oid) into v_definition;
  v_eol := case when position(E'\r\n' in v_definition) > 0 then E'\r\n' else E'\n' end;

  -- (a) one more counter in the declare block
  v_anchor := '  v_credit_count int := 0;';
  if (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception 'receipt_credit_injection: declare anchor not found exactly once';
  end if;
  v_definition := replace(v_definition, v_anchor,
    v_anchor || v_eol || '  v_damaged_credit_count int := 0;');

  -- (b) the damaged/returned insert, immediately after the shortage insert's row count,
  --     still inside `if coalesce(p_open_credits, false) then … end if`.
  v_anchor := '      get diagnostics v_credit_count = row_count;';
  if (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception 'receipt_credit_injection: credit-count anchor not found exactly once';
  end if;
  v_inject := v_anchor
    || v_eol || '      -- #49 (decided 08.08.2026): unusable delivery is credited automatically.'
    || v_eol || '      -- Full quantity at the snapshot price; refinements are a later decision.'
    || v_eol || '      insert into credit_requests ('
    || v_eol || '        org_id, supplier_id, receipt_item_id, reason, amount,'
    || v_eol || '        status, notes, created_by'
    || v_eol || '      )'
    || v_eol || '      select'
    || v_eol || '        v_org,'
    || v_eol || '        v_order.supplier_id,'
    || v_eol || '        gri.id,'
    || v_eol || '        (line.status::text)::credit_reason,'
    || v_eol || '        round(line.qty_received * poi.unit_price, 2),'
    || v_eol || '        ''open'','
    || v_eol || '        case when line.status = ''damaged'''
    || v_eol || '          then ''סחורה פגומה בקבלה #'' else ''סחורה שהוחזרה בקבלה #'' end'
    || v_eol || '          || v_receipt.number'
    || v_eol || '          || coalesce('' — '' || nullif(trim(line.notes), ''''), ''''),'
    || v_eol || '        v_user'
    || v_eol || '      from jsonb_to_recordset(p_lines) as line('
    || v_eol || '        order_item_id uuid,'
    || v_eol || '        qty_received numeric,'
    || v_eol || '        status receipt_line_status,'
    || v_eol || '        notes text'
    || v_eol || '      )'
    || v_eol || '      join purchase_order_items poi on poi.id = line.order_item_id and poi.order_id = v_order.id'
    || v_eol || '      join goods_receipt_items gri'
    || v_eol || '        on gri.receipt_id = v_receipt.id and gri.order_item_id = line.order_item_id'
    || v_eol || '      where line.status in (''damaged'', ''returned'')'
    || v_eol || '        and round(line.qty_received * poi.unit_price, 2) > 0;'
    || v_eol || '      get diagnostics v_damaged_credit_count = row_count;'
    || v_eol || '      v_credit_count := v_credit_count + v_damaged_credit_count;';
  execute replace(v_definition, v_anchor, v_inject);
end
$receipt_credit_injection$;

-- ===== 2. The one door for a manual exception (#116) =====
-- owner/office only, entity-bound, reasoned, idempotent per (entity, type) while open.
-- `exceptions` has FK columns for suppliers/invoices but none for orders, so the entity
-- itself rides details (entity_type/entity_id) and the supplier FK is derived.
create or replace function public.open_manual_exception(
  p_entity_type text,
  p_entity_id uuid,
  p_type exception_type,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role user_role := auth_role();
  v_reason text := nullif(trim(p_reason), '');
  v_order purchase_orders;
  v_invoice invoices;
  v_supplier_id uuid;
  v_invoice_id uuid;
  v_unit_id uuid;
  v_title text;
  v_entity_label text;
  v_exception_id uuid;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_reason is null then raise exception 'reason_required' using errcode = '22023'; end if;
  if p_entity_id is null or p_type is null then
    raise exception 'manual_exception_invalid' using errcode = '22023';
  end if;

  if p_entity_type = 'purchase_orders' then
    select * into v_order from purchase_orders
    where id = p_entity_id and org_id = v_org for update;
    if not found then raise exception 'purchase_order_unknown' using errcode = 'P0002'; end if;
    v_supplier_id := v_order.supplier_id;
    v_unit_id := v_order.unit_id;
    v_entity_label := 'הזמנה #' || v_order.number;
  elsif p_entity_type = 'invoices' then
    select * into v_invoice from invoices
    where id = p_entity_id and org_id = v_org and deleted_at is null for update;
    if not found then raise exception 'invoice_not_found' using errcode = 'P0002'; end if;
    v_supplier_id := v_invoice.supplier_id;
    v_invoice_id := v_invoice.id;
    v_unit_id := v_invoice.unit_id;
    v_entity_label := 'חשבונית ' || v_invoice.invoice_number;
  else
    raise exception 'manual_exception_entity_invalid' using errcode = '22023';
  end if;

  -- A5: a definer touching unit-scoped tables asserts the unit it acts on (0054).
  perform public.assert_unit_in_scope(v_unit_id);

  select e.id into v_exception_id
  from exceptions e
  where e.org_id = v_org and e.type = p_type
    and e.status in ('open', 'in_progress')
    and e.details->>'entity_type' = p_entity_type
    and e.details->>'entity_id' = p_entity_id::text
  order by e.created_at
  limit 1
  for update;
  if found then
    return jsonb_build_object('exception_id', v_exception_id, 'idempotent', true);
  end if;

  v_title := case
    when p_type = 'item_not_ordered' then 'התקבל פריט שלא הוזמן — ' || v_entity_label
    else 'חריג ידני — ' || v_entity_label
  end;

  insert into exceptions (
    org_id, type, severity, status, title, details,
    supplier_id, invoice_id, assigned_role
  ) values (
    v_org, p_type, 'medium', 'open', v_title,
    jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', p_entity_id,
      'reason', v_reason,
      'opened_manually', true
    ),
    v_supplier_id, v_invoice_id, 'office'
  ) returning id into v_exception_id;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, new_values, reason)
  values (v_org, v_user, 'manual_exception_opened', p_entity_type, p_entity_id,
          jsonb_build_object('exception_id', v_exception_id, 'type', p_type), v_reason);

  return jsonb_build_object('exception_id', v_exception_id, 'idempotent', false);
end
$$;

comment on function public.open_manual_exception(text, uuid, exception_type, text) is
  'OPEN-DECISIONS #116 (decided 08.08.2026): the single reasoned door for a human-opened '
  'exception. owner/office only; the browser holds no INSERT grant on exceptions (0036).';

revoke all on function public.open_manual_exception(text, uuid, exception_type, text)
  from public, anon, service_role;
grant execute on function public.open_manual_exception(text, uuid, exception_type, text)
  to authenticated;

-- ===== Re-assert the 0057 scope-enforcement invariants (DEBT-REGISTER §9) =====
do $reassert$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0087 scope enforcement assertions failed:\n%', v_violations;
  end if;
end
$reassert$;
