-- 0225: the last two figures the client is asked to render without being told their currency.
--
-- Phase 3 walks every money render site and asks "which currency is this in". Two more sites could
-- not answer, and both for the same reason as `global_search` in 0224 — the server never said.
--
--   inventory_intelligence.latest_purchase_unit_price   the price the product was last bought at.
--                                                       It comes from a purchase order item, so it
--                                                       is in the ORDER's currency, and the view
--                                                       returned the number alone.
--   get_document_control_price_review_queue             the shadow price-list queue: a proposed
--                                                       price against the current one, both in the
--                                                       supplier's own currency, neither carrying
--                                                       it. 0223 gave the same view its
--                                                       `cheapest_currency`; this is its twin.
--
-- Neither is a new decision. They are the two rows the systematic scan of `sum(...)` could not
-- reach, because neither is a sum — they are single figures, and a single figure with no unit is
-- the same lie a false total is, only quieter.

create temp table v0225_view_snapshot as
select c.relname::text                            as view_name,
       rtrim(pg_get_viewdef(c.oid, true), E' \n;') as definition,
       array_to_string(c.reloptions, ', ')        as options,
       obj_description(c.oid, 'pg_class')         as description
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'v' and c.relname = 'inventory_intelligence';

create temp table v0225_view_grants as
select c.relname::text as view_name, acl.grantee::regrole::text as role_name, acl.privilege_type
from pg_class c
join pg_namespace n on n.oid = c.relnamespace,
lateral aclexplode(c.relacl) acl
where n.nspname = 'public' and c.relkind = 'v' and c.relname = 'inventory_intelligence';

do $edit_0225$
declare
  v_definition text;
  v_edited     text;
  v_pairs      text[][];
  i            integer;
begin
  v_pairs := array[
    array[
      E'            poi.unit_price AS latest_purchase_unit_price,',
      E'            poi.unit_price AS latest_purchase_unit_price,\n            po.currency AS latest_purchase_currency,'],
    array[
      E'    lp.latest_purchase_unit_price,\n    lp.latest_purchase_at',
      E'    lp.latest_purchase_unit_price,\n    lp.latest_purchase_currency,\n    lp.latest_purchase_at']
  ];

  select definition into v_definition from v0225_view_snapshot;
  if v_definition is null then
    raise exception '0225: inventory_intelligence was not captured';
  end if;

  for i in 1 .. array_length(v_pairs, 1) loop
    if (length(v_definition) - length(replace(v_definition, v_pairs[i][1], ''))) / length(v_pairs[i][1]) <> 1 then
      raise exception '0225: anchor % does not appear exactly once', i;
    end if;
    v_edited := replace(v_definition, v_pairs[i][1], v_pairs[i][2]);
    v_definition := v_edited;
  end loop;

  update v0225_view_snapshot set definition = v_definition;
end
$edit_0225$;

drop view public.inventory_intelligence;

do $rebuild_0225$
declare
  v record;
begin
  for v in select * from v0225_view_snapshot loop
    execute format('create view public.%I with (%s) as %s', v.view_name, v.options, v.definition);
    if v.description is not null then
      execute format('comment on view public.%I is %L', v.view_name, v.description);
    end if;
  end loop;
  for v in select * from v0225_view_grants where role_name <> current_user
           order by role_name, privilege_type loop
    execute format('grant %s on public.%I to %I', v.privilege_type, v.view_name, v.role_name);
  end loop;
end
$rebuild_0225$;

drop table v0225_view_snapshot;
drop table v0225_view_grants;

-- ===== The price-review queue says which currency both figures are in =====
-- Dropped rather than replaced: a `returns table` cannot gain a column in place. Its one caller,
-- `src/pages/DocumentOperations.tsx`, moves with it in the same change.
drop function if exists public.get_document_control_price_review_queue(integer);

create function public.get_document_control_price_review_queue(p_document_limit integer default 50)
returns table (
  review_key text, document_id uuid, file_name text, supplier_name text, source_row integer,
  predicted_action text, product_name text, matched_product_name text, sku text,
  proposed_unit_price numeric, current_unit_price numeric, currency text,
  document_line_count bigint, document_reviewed_count bigint, is_empty_run boolean
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if public.auth_org() is null or auth.uid() is null or public.auth_role() <> 'owner' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_document_limit is null or p_document_limit < 1 or p_document_limit > 50 then
    raise exception 'invalid_document_limit' using errcode = '22023';
  end if;

  return query
  with latest_review as (
    select distinct on (review.shadow_line_id) review.shadow_line_id, review.revision
    from public.price_list_calibration_reviews review
    where review.org_id = public.auth_org()
    order by review.shadow_line_id, review.revision desc
  ), latest_empty_review as (
    select distinct on (review.shadow_run_id) review.shadow_run_id, review.revision
    from public.price_list_empty_run_reviews review
    where review.org_id = public.auth_org()
    order by review.shadow_run_id, review.revision desc
  ), run_progress as (
    select run.id, run.created_at,
           count(line.id) as line_count,
           count(latest.shadow_line_id) as reviewed_count,
           bool_or(empty_review.shadow_run_id is not null) as empty_reviewed
    from public.price_list_shadow_runs run
    left join public.price_list_shadow_lines line
      on line.org_id = run.org_id and line.shadow_run_id = run.id
    left join latest_review latest on latest.shadow_line_id = line.id
    left join latest_empty_review empty_review on empty_review.shadow_run_id = run.id
    where run.org_id = public.auth_org()
    group by run.id, run.created_at
    having (count(line.id) > 0 and count(latest.shadow_line_id) < count(line.id))
        or (count(line.id) = 0 and not bool_or(empty_review.shadow_run_id is not null))
    order by run.created_at, run.id
    limit p_document_limit
  )
  select coalesce(line.id, run.id)::text,
         run.document_id,
         document.file_name,
         supplier.name,
         line.source_row,
         coalesce(line.predicted_action, 'review'),
         line.product_name,
         product.name,
         line.sku,
         line.proposed_unit_price,
         line.current_unit_price,
         -- 0225: both figures are the SUPPLIER's own money. A price list is that supplier's quote,
         -- and the current price is what this organisation has recorded them charging.
         supplier.default_currency,
         progress.line_count,
         progress.reviewed_count,
         line.id is null
  from run_progress progress
  join public.price_list_shadow_runs run on run.id = progress.id
  left join public.price_list_shadow_lines line
    on line.org_id = run.org_id and line.shadow_run_id = run.id
  left join latest_review latest on latest.shadow_line_id = line.id
  join public.documents document
    on document.org_id = run.org_id and document.id = run.document_id
   and document.deleted_at is null
   and (
     document.unit_id is null
     or document.unit_id = any(public.auth_scopes())
   )
  left join public.suppliers supplier
    on supplier.org_id = run.org_id and supplier.id = run.supplier_id
  left join public.products product
    on product.org_id = run.org_id and product.id = line.product_id
  where line.id is null or latest.shadow_line_id is null
  order by progress.created_at, run.id, line.line_index;
end
$$;

revoke all on function public.get_document_control_price_review_queue(integer) from public, anon, service_role;
grant execute on function public.get_document_control_price_review_queue(integer) to authenticated;

comment on function public.get_document_control_price_review_queue(integer) is
  'The owner-only shadow price-list review queue (0135, per-currency since 0225). Both prices are '
  'in the supplier''s own currency, which the row now states rather than leaving the screen to '
  'assume.';

-- A5 pins the body of every SECURITY DEFINER function that reads an enforced table. The signature
-- did not move, so the row stays; the hash has to be recomputed from pg_proc, never written out.
update private.scope_definer_enforcements enforcement
set body_hash = md5(replace(proc.prosrc, e'\r', '')),
    scope_proof = '0225 adds the supplier''s currency to the queue rows and changes nothing about '
      || 'the owner-only gate or the null-or-auth_scopes document predicate.'
from pg_catalog.pg_proc proc
where proc.oid = pg_catalog.to_regprocedure('public.get_document_control_price_review_queue(integer)')
  and enforcement.function_signature = 'get_document_control_price_review_queue(integer)';

do $assert_0225$
declare
  v_violations text;
begin
  if position('latest_purchase_currency' in pg_get_viewdef('public.inventory_intelligence'::regclass, true)) = 0 then
    raise exception '0225: inventory_intelligence did not take the latest-purchase currency';
  end if;
  if position('cheapest_currency' in pg_get_viewdef('public.inventory_intelligence'::regclass, true)) = 0 then
    raise exception '0225: the rebuild lost 0223 cheapest_currency';
  end if;
  if not has_table_privilege('authenticated', 'public.inventory_intelligence', 'select') then
    raise exception '0225: inventory_intelligence lost its browser grant';
  end if;

  if (select count(*) from information_schema.parameters p
      where p.specific_schema = 'public'
        and p.specific_name = (select specific_name from information_schema.routines
                                where routine_schema = 'public'
                                  and routine_name = 'get_document_control_price_review_queue')
        and p.parameter_mode = 'OUT' and p.parameter_name = 'currency') <> 1 then
    raise exception '0225: the price review queue does not return a currency';
  end if;
  if not has_function_privilege('authenticated', 'public.get_document_control_price_review_queue(integer)', 'execute')
     or has_function_privilege('anon', 'public.get_document_control_price_review_queue(integer)', 'execute') then
    raise exception '0225: the price review queue grants moved';
  end if;

  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0225 scope assertions failed:\n%', v_violations;
  end if;
end
$assert_0225$;
