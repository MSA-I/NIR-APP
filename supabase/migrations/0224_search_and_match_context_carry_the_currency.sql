-- 0224: two read models hand the client a money figure with no currency on it.
--
-- Phase 3 deletes the one-argument money formatter, and every render site then has to say which
-- currency its figure is in. Two of them cannot, because the server never told them:
--
--   public.global_search()               returns `amount` for an invoice, a payment and a credit,
--                                        and nothing that says what money it is. The search panel
--                                        drew it with a shekel sign.
--   private.invoice_three_way_raw()      builds `candidate_context`, the order items an invoice
--                                        line may be matched against, each with its `unit_price`.
--                                        The review modal drew those with a shekel sign too.
--
-- Both get the currency from the row it belongs to — the invoice's, the payment's, the credit's,
-- the ORDER's — never from the organisation and never from the screen.
--
-- `global_search` is dropped rather than replaced: a `returns table` cannot gain a column in
-- place, and its one caller (`src/components/GlobalSearch.tsx`) moves with it in the same change.
-- A supplier, a product and a draft carry no amount and so carry no currency: null, which the
-- panel already renders as nothing at all.
--
-- `invoice_three_way_raw` is edited by anchor rather than restated. It is 600 lines of three-way
-- assessment whose output is HASHED INTO AN IMMUTABLE APPROVAL SNAPSHOT, and retyping it to add
-- one key is how a clause goes missing in the one place where a lost clause is unrecoverable.
--
-- WHAT THIS CHANGES ABOUT THE SNAPSHOT, stated because it is not nothing: `candidate_context` is
-- part of the assessment that `0099` hashes, so adding a key changes the hash of an assessment
-- computed after this migration. That is the intended behaviour of that hash — it exists so an
-- override issued against older facts cannot be reused — and an existing snapshot is not touched,
-- rewritten or re-hashed. A new assessment is simply a new assessment.

drop function if exists public.global_search(text, integer);

create function public.global_search(q text, per_type integer default 5)
returns table (
  entity text, id uuid, title text, subtitle text, status text,
  amount numeric, currency text, occurred_at date, rank integer
)
language plpgsql
stable
set search_path to 'public'
as $$
#variable_conflict use_column
declare
  term text; like_any text; like_pre text;
  -- The reachable result types of this caller. Read once; every branch below consults it.
  v_types text[];
begin
  v_types := case auth_role()
    when 'owner'      then array['supplier', 'product', 'invoice', 'order', 'payment', 'credit', 'draft']
    when 'office'     then array['supplier', 'product', 'invoice', 'order', 'credit', 'draft']
    when 'accountant' then array['invoice', 'payment', 'credit']
    -- payer, supplier, and a NULL role all land here.
    else '{}'::text[]
  end;
  -- Nothing is reachable: answer without touching a single table.
  if cardinality(v_types) = 0 then return; end if;

  -- '#123' is how users actually type document numbers
  term := btrim(regexp_replace(coalesce(q, ''), '^#', ''));
  if length(term) < 2 then return; end if;
  -- neutralise LIKE wildcards typed by the user
  term := replace(replace(replace(term, '\', '\\'), '%', '\%'), '_', '\_');
  like_any := '%' || term || '%';
  like_pre := term || '%';

  -- Each branch carries its own type test. It is a plpgsql variable, so a branch the caller
  -- may not reach collapses to a one-time false filter instead of scanning and discarding.
  return query
  select * from (
    -- ספקים  (aliases here name the whole derived table: first UNION branch wins)
    (select 'supplier'::text as entity, s.id as id, s.name as title,
            nullif(concat_ws(' · ', s.contact_name, s.phone), '') as subtitle,
            s.status::text as status, null::numeric(14,3) as amount,
            -- No amount, so no currency. A currency beside nothing is noise.
            null::text as currency,
            null::date as occurred_at,
            (case when s.name ilike like_pre then 1 else 2 end)::int as rank
     from suppliers s
     where 'supplier' = any(v_types)
       and s.org_id = auth_org() and s.deleted_at is null
       and (s.name ilike like_any or s.contact_name ilike like_any
            or s.phone ilike like_any or s.tax_id ilike like_any or s.email ilike like_any)
     order by (case when s.name ilike like_pre then 1 else 2 end), s.name
     limit per_type)
  union all
    -- מוצרים
    (select 'product'::text, p.id, p.name,
            nullif(concat_ws(' · ', c.name, p.sku), ''),
            (case when p.active then 'active' else 'inactive' end)::text,
            null::numeric(14,3), null::text, null::date,
            (case when p.name ilike like_pre then 1 else 2 end)::int
     from products p left join categories c on c.id = p.category_id
     where 'product' = any(v_types)
       and p.org_id = auth_org()
       and (p.name ilike like_any or p.sku ilike like_any or p.barcode ilike like_any)
     order by (case when p.name ilike like_pre then 1 else 2 end), p.name
     limit per_type)
  union all
    -- חשבוניות  (joining suppliers lets "שופרסל" surface that supplier's invoices)
    (select 'invoice'::text, i.id, i.invoice_number, s.name,
            i.payment_status::text, i.total_amount, i.currency, i.invoice_date,
            (case when i.invoice_number ilike like_pre then 1 else 2 end)::int
     from invoices i join suppliers s on s.id = i.supplier_id
     where 'invoice' = any(v_types)
       and i.org_id = auth_org() and i.deleted_at is null
       and i.financial_role = 'payable'
       and (i.invoice_number ilike like_any or s.name ilike like_any or i.notes ilike like_any)
     order by (case when i.invoice_number ilike like_pre then 1 else 2 end), i.invoice_date desc
     limit per_type)
  union all
    -- הזמנות
    (select 'order'::text, o.id, '#' || o.number::text, s.name,
            o.status::text, null::numeric(14,3), null::text, o.created_at::date,
            (case when o.number::text like like_pre then 1 else 2 end)::int
     from purchase_orders o join suppliers s on s.id = o.supplier_id
     where 'order' = any(v_types)
       and o.org_id = auth_org()
       and (o.number::text like like_pre or s.name ilike like_any or o.notes ilike like_any)
     order by (case when o.number::text like like_pre then 1 else 2 end), o.created_at desc
     limit per_type)
  union all
    -- תשלומים  (payments has no status column -> null; StatusBadge renders nothing, ui.tsx:7)
    (select 'payment'::text, pm.id, '#' || pm.number::text,
            nullif(concat_ws(' · ', s.name, pm.method, pm.reference), ''),
            null::text, pm.amount, pm.currency, pm.paid_date,
            (case when pm.number::text like like_pre then 1 else 2 end)::int
     from payments pm join suppliers s on s.id = pm.supplier_id
     where 'payment' = any(v_types)
       and pm.org_id = auth_org()
       and (pm.number::text like like_pre or s.name ilike like_any
            or pm.reference ilike like_any or pm.notes ilike like_any)
     order by (case when pm.number::text like like_pre then 1 else 2 end), pm.paid_date desc
     limit per_type)
  union all
    -- זיכויים
    (select 'credit'::text, cr.id, '#' || cr.number::text, s.name,
            cr.status::text, cr.amount, cr.currency, cr.created_at::date,
            (case when cr.number::text like like_pre then 1 else 2 end)::int
     from credit_requests cr join suppliers s on s.id = cr.supplier_id
     where 'credit' = any(v_types)
       and cr.org_id = auth_org()
       and (cr.number::text like like_pre or s.name ilike like_any or cr.notes ilike like_any)
     order by (case when cr.number::text like like_pre then 1 else 2 end), cr.created_at desc
     limit per_type)
  union all
    -- טיוטות הזמנה (0145): רק היוצר יכול להמשיך טיוטה, ולכן רק הוא מקבל אותה כתוצאה.
    (select 'draft'::text, r.id, '#' || r.number::text,
            nullif(concat_ws(' · ', 'טיוטת הזמנה', r.notes), ''),
            'draft'::text, null::numeric(14,3), null::text, r.updated_at::date,
            (case when r.number::text like like_pre then 1 else 2 end)::int
     from purchase_requests r
     where 'draft' = any(v_types)
       and r.org_id = auth_org() and r.status = 'draft' and r.created_by = auth.uid()
       and (r.number::text like like_pre
            or r.notes ilike like_any
            -- "טיוטה" is how the searcher actually asks for this list.
            or 'טיוטה' ilike like_any
            or exists (select 1 from purchase_request_items ri
                       join products p2 on p2.id = ri.product_id
                       where ri.request_id = r.id and p2.name ilike like_any))
     order by (case when r.number::text like like_pre then 1 else 2 end), r.updated_at desc
     limit per_type)
  ) hits
  order by hits.rank, hits.occurred_at desc nulls last, hits.title
  limit 30;
end $$;

revoke all on function public.global_search(text, integer) from public, anon;
grant execute on function public.global_search(text, integer) to authenticated;

comment on function public.global_search(text, integer) is
  'One search box over suppliers, products, invoices, orders, payments, credits and the searcher''s '
  'own drafts (0011, per-currency since 0224). An amount comes with the currency of the row it '
  'belongs to; a result that carries no amount carries no currency either.';

-- ===== The three-way candidate context says which money the order was placed in =====
do $anchor_0224$
declare
  v_definition text;
  v_patched    text;
  v_anchor     constant text := E'      ''unit'', item.unit_snapshot,\n      ''unit_price'', item.unit_price\n    ) order by candidate.invoice_line_id, item.order_id, candidate.purchase_order_item_id), ''[]''::jsonb)\n      into v_candidate_context\n    from private.invoice_line_candidates(p_org_id, p_invoice_id) candidate\n    join public.purchase_order_items item\n      on item.org_id = p_org_id and item.id = candidate.purchase_order_item_id;';
  v_replacement constant text := E'      ''unit'', item.unit_snapshot,\n      ''unit_price'', item.unit_price,\n      -- 0224: an order item is priced in the ORDER''''s currency, not the invoice''''s and not the\n      -- organisation''''s. The review modal renders this figure, and a figure with no unit is the\n      -- thing this campaign exists to end.\n      ''currency'', purchase_order.currency\n    ) order by candidate.invoice_line_id, item.order_id, candidate.purchase_order_item_id), ''[]''::jsonb)\n      into v_candidate_context\n    from private.invoice_line_candidates(p_org_id, p_invoice_id) candidate\n    join public.purchase_order_items item\n      on item.org_id = p_org_id and item.id = candidate.purchase_order_item_id\n    join public.purchase_orders purchase_order\n      on purchase_order.org_id = item.org_id and purchase_order.id = item.order_id;';
begin
  v_definition := replace(
    pg_get_functiondef('private.invoice_three_way_raw(uuid,uuid)'::regprocedure), e'\r', '');

  if (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception '0224: the candidate_context anchor does not appear exactly once';
  end if;

  v_patched := replace(v_definition, v_anchor, v_replacement);
  execute v_patched;
end
$anchor_0224$;

do $assert_0224$
declare
  v_violations text;
  v_body       text;
begin
  if (select count(*) from information_schema.parameters p
      where p.specific_schema = 'public'
        and p.specific_name = (select specific_name from information_schema.routines
                                where routine_schema = 'public' and routine_name = 'global_search')
        and p.parameter_mode = 'OUT' and p.parameter_name = 'currency') <> 1 then
    raise exception '0224: global_search does not return a currency';
  end if;
  if not has_function_privilege('authenticated', 'public.global_search(text,integer)', 'execute')
     or has_function_privilege('anon', 'public.global_search(text,integer)', 'execute') then
    raise exception '0224: the global_search grants moved';
  end if;

  select replace(prosrc, e'\r', '') into v_body
  from pg_proc where oid = 'private.invoice_three_way_raw(uuid,uuid)'::regprocedure;
  if position('''currency'', purchase_order.currency' in v_body) = 0 then
    raise exception '0224: the candidate context did not take the currency';
  end if;
  -- The properties the anchored replacement must not have dropped. This function is SECURITY
  -- INVOKER by design -- it is reached only through the definer wrapper that already resolved the
  -- caller's scope -- so what is pinned here is that it did not silently BECOME a definer, and
  -- that it is still stable rather than volatile.
  if (select prosecdef from pg_proc
       where oid = 'private.invoice_three_way_raw(uuid,uuid)'::regprocedure) then
    raise exception '0224: invoice_three_way_raw became SECURITY DEFINER';
  end if;
  if (select provolatile from pg_proc
       where oid = 'private.invoice_three_way_raw(uuid,uuid)'::regprocedure) <> 's' then
    raise exception '0224: invoice_three_way_raw is no longer STABLE';
  end if;

  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0224 scope assertions failed:\n%', v_violations;
  end if;
end
$assert_0224$;
