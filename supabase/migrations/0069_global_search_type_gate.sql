-- 0069 -- The global-search type gate moves to the server (wave 9, PLAN-10 §2).
--
-- THE DEFECT, stated plainly: global_search is granted to `authenticated` as a whole
-- (0011:113), and the only thing that stopped a payer or a supplier agent from receiving
-- supplier / product / payment hits was ALLOWED in src/components/GlobalSearch.tsx:28-34 --
-- a table in the browser. RLS decides which ROWS exist; the route guards in src/App.tsx are
-- stricter than RLS about which SCREENS exist (RLS lets an accountant read a product row, but
-- /products is staff-only), so a hit whose target the caller may not open should never have
-- crossed the wire at all. This is a permission fix, not an abstraction.
--
-- WHAT DOES NOT CHANGE, verified with pg_get_functiondef against the live catalog before
-- editing (the live body is 0011:22 character for character): SECURITY INVOKER -- deliberate,
-- and the reason this function needs no duplicated tenant logic (0011:2-4); the six branches
-- and their predicates; `limit 30`; the per_type default of 5; the '#' prefix strip; the
-- LIKE-wildcard neutralisation; the two-character minimum; the ordering; `set search_path =
-- public`; every trigram and text_pattern_ops index. REPLACING pg_trgm IS FORBIDDEN in this
-- wave -- ILIKE '%term%' over trigram indexes is the Hebrew-without-a-dictionary answer of
-- 0011:8-9, and swapping it needs measurement, which is wave 10's job, not a side effect here.
--
-- WHAT CHANGES: one branch-selection array, derived from auth_role(), and one early return.
--
-- The map is not invented here -- it is read off src/App.tsx's guards, which is also where
-- the browser's ALLOWED came from, so the two agree by construction:
--   owner       -- every route                                  -> all six types
--   office      -- /payments is ['owner','accountant']           -> no payment
--   kitchen     -- same                                          -> no payment
--   accountant  -- /suppliers,/products,/orders are STAFF        -> invoice, payment, credit
--   payer       -- reaches only /pay                             -> NOTHING
--   supplier    -- has no search target at all                   -> NOTHING
-- An unresolvable role gets nothing: the gate fails closed, like every other gate here.
--
-- The browser keeps ALLOWED, demoted from a gate to a display-order map (GROUP_ORDER and the
-- group headings still need it). Nobody who could see everything sees anything different.
create or replace function global_search(q text, per_type int default 5)
returns table (
  entity text, id uuid, title text, subtitle text,
  status text, amount numeric(12,2), occurred_at date, rank int
)
language plpgsql stable set search_path = public as $$
#variable_conflict use_column
declare
  term text; like_any text; like_pre text;
  -- The reachable result types of this caller. Read once; every branch below consults it.
  v_types text[];
begin
  v_types := case auth_role()
    when 'owner'      then array['supplier', 'product', 'invoice', 'order', 'payment', 'credit']
    when 'office'     then array['supplier', 'product', 'invoice', 'order', 'credit']
    when 'kitchen'    then array['supplier', 'product', 'invoice', 'order', 'credit']
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
            s.status::text as status, null::numeric(12,2) as amount,
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
            null::numeric(12,2), null::date,
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
            i.payment_status::text, i.total_amount, i.invoice_date,
            (case when i.invoice_number ilike like_pre then 1 else 2 end)::int
     from invoices i join suppliers s on s.id = i.supplier_id
     where 'invoice' = any(v_types)
       and i.org_id = auth_org() and i.deleted_at is null
       and (i.invoice_number ilike like_any or s.name ilike like_any or i.notes ilike like_any)
     order by (case when i.invoice_number ilike like_pre then 1 else 2 end), i.invoice_date desc
     limit per_type)
  union all
    -- הזמנות
    (select 'order'::text, o.id, '#' || o.number::text, s.name,
            o.status::text, null::numeric(12,2), o.created_at::date,
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
            null::text, pm.amount, pm.paid_date,
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
            cr.status::text, cr.amount, cr.created_at::date,
            (case when cr.number::text like like_pre then 1 else 2 end)::int
     from credit_requests cr join suppliers s on s.id = cr.supplier_id
     where 'credit' = any(v_types)
       and cr.org_id = auth_org()
       and (cr.number::text like like_pre or s.name ilike like_any or cr.notes ilike like_any)
     order by (case when cr.number::text like like_pre then 1 else 2 end), cr.created_at desc
     limit per_type)
  ) hits
  order by hits.rank, hits.occurred_at desc nulls last, hits.title
  limit 30;
end $$;

-- CREATE OR REPLACE preserves the ACL (0011:113 granted authenticated). Re-asserted here so
-- the contract is visible in the file that changed the body -- the 0066:544 idiom.
revoke all on function global_search(text, int) from public, anon;
grant execute on function global_search(text, int) to authenticated;

comment on function global_search(text, int) is
  'One round trip across the six searchable entities. SECURITY INVOKER: every underlying '
  'table''s RLS applies to the caller. Since 0069 the reachable result TYPES are also decided '
  'here, from auth_role(), mirroring the src/App.tsx route guards -- payer and supplier '
  'receive nothing, and the browser''s ALLOWED map is display order, not a gate.';

-- No new table and no new definer, so there is nothing for A1 or A5 to classify. The
-- assertions are re-run anyway: a migration that touches a function surface should prove the
-- structural contract still holds here, not three hours into the gate (the 0058:207-218 idiom).
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0069 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
