-- Global search (spec §5): one round trip across the six searchable entities.
-- SECURITY INVOKER on purpose (note: the opposite of refresh_invoice_payment_status,
-- 0002_payer_execution.sql:13) -- every underlying table's RLS applies to the caller, so
-- payer/supplier/accountant/kitchen visibility needs no duplicated logic here.

create extension if not exists pg_trgm with schema extensions;

-- Hebrew has no Postgres text-search dictionary, so matching is ILIKE '%term%'.
-- Trigram indexes are character-based (dictionary-free) and accelerate that at 3+ chars.
create index if not exists suppliers_name_trgm    on suppliers using gin (name extensions.gin_trgm_ops);
create index if not exists suppliers_contact_trgm on suppliers using gin (contact_name extensions.gin_trgm_ops);
create index if not exists products_name_trgm     on products  using gin (name extensions.gin_trgm_ops);
create index if not exists products_sku_trgm      on products  using gin (sku extensions.gin_trgm_ops);
create index if not exists invoices_number_trgm   on invoices  using gin (invoice_number extensions.gin_trgm_ops);
create index if not exists payments_ref_trgm      on payments  using gin (reference extensions.gin_trgm_ops);

-- identity numbers are int; prefix-match them as text so "12" finds #12, #120, #121
create index if not exists po_number_txt       on purchase_orders (((number)::text) text_pattern_ops);
create index if not exists credits_number_txt  on credit_requests (((number)::text) text_pattern_ops);
create index if not exists payments_number_txt on payments        (((number)::text) text_pattern_ops);

create or replace function global_search(q text, per_type int default 5)
returns table (
  entity text, id uuid, title text, subtitle text,
  status text, amount numeric(12,2), occurred_at date, rank int
)
language plpgsql stable set search_path = public as $$
#variable_conflict use_column
declare
  term text; like_any text; like_pre text;
begin
  -- '#123' is how users actually type document numbers
  term := btrim(regexp_replace(coalesce(q, ''), '^#', ''));
  if length(term) < 2 then return; end if;
  -- neutralise LIKE wildcards typed by the user
  term := replace(replace(replace(term, '\', '\\'), '%', '\%'), '_', '\_');
  like_any := '%' || term || '%';
  like_pre := term || '%';

  return query
  select * from (
    -- ספקים  (aliases here name the whole derived table: first UNION branch wins)
    (select 'supplier'::text as entity, s.id as id, s.name as title,
            nullif(concat_ws(' · ', s.contact_name, s.phone), '') as subtitle,
            s.status::text as status, null::numeric(12,2) as amount,
            null::date as occurred_at,
            (case when s.name ilike like_pre then 1 else 2 end)::int as rank
     from suppliers s
     where s.org_id = auth_org() and s.deleted_at is null
       and (s.name ilike like_any or s.contact_name ilike like_any
            or s.phone ilike like_any or s.tax_id ilike like_any or s.email ilike like_any)
     order by (case when s.name ilike like_pre then 1 else 2 end), s.name
     limit per_type)
  union all
    -- מוצרים
    (select 'product'::text, p.id, p.name,
            nullif(concat_ws(' · ', c.name, p.sku), ''),
            (case when p.active then 'active' else 'inactive' end)::text,
            null::numeric(12,2), null::date,
            (case when p.name ilike like_pre then 1 else 2 end)::int
     from products p left join categories c on c.id = p.category_id
     where p.org_id = auth_org()
       and (p.name ilike like_any or p.sku ilike like_any or p.barcode ilike like_any)
     order by (case when p.name ilike like_pre then 1 else 2 end), p.name
     limit per_type)
  union all
    -- חשבוניות  (joining suppliers lets "שופרסל" surface that supplier's invoices)
    (select 'invoice'::text, i.id, i.invoice_number, s.name,
            i.payment_status::text, i.total_amount, i.invoice_date,
            (case when i.invoice_number ilike like_pre then 1 else 2 end)::int
     from invoices i join suppliers s on s.id = i.supplier_id
     where i.org_id = auth_org() and i.deleted_at is null
       and (i.invoice_number ilike like_any or s.name ilike like_any or i.notes ilike like_any)
     order by (case when i.invoice_number ilike like_pre then 1 else 2 end), i.invoice_date desc
     limit per_type)
  union all
    -- הזמנות
    (select 'order'::text, o.id, '#' || o.number::text, s.name,
            o.status::text, null::numeric(12,2), o.created_at::date,
            (case when o.number::text like like_pre then 1 else 2 end)::int
     from purchase_orders o join suppliers s on s.id = o.supplier_id
     where o.org_id = auth_org()
       and (o.number::text like like_pre or s.name ilike like_any or o.notes ilike like_any)
     order by (case when o.number::text like like_pre then 1 else 2 end), o.created_at desc
     limit per_type)
  union all
    -- תשלומים  (payments has no status column -> null; StatusBadge renders nothing, ui.tsx:7)
    (select 'payment'::text, pm.id, '#' || pm.number::text,
            nullif(concat_ws(' · ', s.name, pm.method, pm.reference), ''),
            null::text, pm.amount, pm.paid_date,
            (case when pm.number::text like like_pre then 1 else 2 end)::int
     from payments pm join suppliers s on s.id = pm.supplier_id
     where pm.org_id = auth_org()
       and (pm.number::text like like_pre or s.name ilike like_any
            or pm.reference ilike like_any or pm.notes ilike like_any)
     order by (case when pm.number::text like like_pre then 1 else 2 end), pm.paid_date desc
     limit per_type)
  union all
    -- זיכויים
    (select 'credit'::text, cr.id, '#' || cr.number::text, s.name,
            cr.status::text, cr.amount, cr.created_at::date,
            (case when cr.number::text like like_pre then 1 else 2 end)::int
     from credit_requests cr join suppliers s on s.id = cr.supplier_id
     where cr.org_id = auth_org()
       and (cr.number::text like like_pre or s.name ilike like_any or cr.notes ilike like_any)
     order by (case when cr.number::text like like_pre then 1 else 2 end), cr.created_at desc
     limit per_type)
  ) hits
  order by hits.rank, hits.occurred_at desc nulls last, hits.title
  limit 30;
end $$;

grant execute on function global_search(text, int) to authenticated;
