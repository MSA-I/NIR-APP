-- 0223: the last two read models that add — and rank — unlike money.
--
-- HOW THESE WERE FOUND, and it is worth stating because it is repeatable. After 0217–0222 the
-- whole schema was scanned for anything that sums a money column and never mentions a currency:
--
--   select … from pg_proc  where prosrc ~* 'sum\(…(amount|total_amount|unit_price|…)' and prosrc !~* 'currency'
--   select … from pg_class where relkind = 'v' and pg_get_viewdef(oid) ~* 'sum\(' and !~* 'currency'
--
-- Seven functions came back, and all seven are single-currency by construction or belong to the
-- payment and bank commands of phase 5. Three views came back. `inventory_balances` sums
-- `quantity_delta`, which is a quantity and has no currency. The other two are these.
--
--   supplier_metrics.open_credits_amount   sums what is left of every open credit for a supplier.
--                                          Across two currencies that is the false total, on the
--                                          supplier card.
--   inventory_intelligence                 picks a product's CHEAPEST supplier with
--                                          `row_number() OVER (… ORDER BY sp.current_price …)`.
--                                          That is the same defect `purchase_comparison` had in
--                                          0221 and the worse half of the family: sorting $12
--                                          below ₪40 does not display a wrong number, it makes a
--                                          wrong RECOMMENDATION.
--
-- THE RULE IS THE ONE THE PLAN GIVES EVERYWHERE: one currency, or no answer.
--
--   supplier_metrics       — one currency: exactly today's figure, plus `open_credits_currency`
--                            naming it. Two or more: `open_credits_amount` is NULL, which the two
--                            existing readers already draw as an em dash, because they had to
--                            handle the `office` case that has always returned NULL there.
--   inventory_intelligence — one currency: exactly today's cheapest supplier, tie-break and all,
--                            plus `cheapest_currency`. Two or more: no cheapest supplier at all
--                            and `prices_span_currencies` true, so the screen can say why rather
--                            than name a winner nobody could defend.
--
-- HOW THE BODIES ARE CHANGED. Not by restating them: `supplier_metrics` is 106 lines of delivery,
-- exception, credit and price-change aggregation last written by 0204, and `inventory_intelligence`
-- is 116 lines from 0102. Retyping either to change one clause is how a clause goes missing. The
-- live definitions are captured, edited by exact anchors, and rebuilt — and every anchor is
-- asserted to appear EXACTLY ONCE before anything is replaced, so a body that has moved fails the
-- migration instead of being silently left alone. The storage options, grants and comments are
-- captured beside the definitions and put back, the same way 0217 did it.

create temp table v0223_view_snapshot as
select c.relname::text                            as view_name,
       rtrim(pg_get_viewdef(c.oid, true), E' \n;') as definition,
       array_to_string(c.reloptions, ', ')        as options,
       obj_description(c.oid, 'pg_class')         as description
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'v'
  and c.relname in ('supplier_metrics', 'inventory_intelligence');

create temp table v0223_view_grants as
select c.relname::text as view_name, acl.grantee::regrole::text as role_name, acl.privilege_type
from pg_class c
join pg_namespace n on n.oid = c.relnamespace,
lateral aclexplode(c.relacl) acl
where n.nspname = 'public' and c.relkind = 'v'
  and c.relname in ('supplier_metrics', 'inventory_intelligence');

do $edit_0223$
declare
  v_definition text;
  v_edited     text;
  v_anchor     text;
  v_replacement text;
  v_pairs      text[][];
  v_view       text;
  i            integer;
begin
  -- Each pair is (view, anchor, replacement). The anchor must appear exactly once.
  v_pairs := array[
    -- ===== supplier_metrics: the credit remainder learns which currency it is in =====
    array['supplier_metrics',
      'count(*) FILTER (WHERE cr.status = ANY (ARRAY[''open''::credit_status, ''requested''::credit_status, ''received''::credit_status])) AS open_credits,',
      'count(*) FILTER (WHERE cr.status = ANY (ARRAY[''open''::credit_status, ''requested''::credit_status, ''received''::credit_status])) AS open_credits,'
      || E'\n            count(DISTINCT cr.currency) FILTER (WHERE cr.status = ANY (ARRAY[''open''::credit_status, ''requested''::credit_status, ''received''::credit_status]))::integer AS open_credit_currency_count,'
      || E'\n            min(cr.currency) FILTER (WHERE cr.status = ANY (ARRAY[''open''::credit_status, ''requested''::credit_status, ''received''::credit_status])) AS open_credit_currency,'],
    array['supplier_metrics',
      E'        CASE\n            WHEN auth_role() = ''owner''::user_role THEN COALESCE(c.open_credits_amount, 0::numeric)\n            ELSE NULL::numeric\n        END::numeric(12,2) AS open_credits_amount,',
      E'        CASE\n            WHEN auth_role() = ''owner''::user_role AND COALESCE(c.open_credit_currency_count, 0) <= 1 THEN COALESCE(c.open_credits_amount, 0::numeric)\n            ELSE NULL::numeric\n        END::numeric(14,3) AS open_credits_amount,'
      || E'\n        CASE\n            WHEN auth_role() = ''owner''::user_role AND c.open_credit_currency_count = 1 THEN c.open_credit_currency\n            ELSE NULL::text\n        END AS open_credits_currency,'],
    -- ===== inventory_intelligence: a product quoted in two currencies has no cheapest supplier ==
    array['inventory_intelligence',
      'row_number() OVER (PARTITION BY sp.product_id ORDER BY sp.current_price, sp.price_effective_date DESC, sp.id) AS price_rank,',
      E'sp.currency,\n            (min(sp.currency) OVER (PARTITION BY sp.product_id) <> max(sp.currency) OVER (PARTITION BY sp.product_id)) AS prices_span_currencies,'
      || E'\n            row_number() OVER (PARTITION BY sp.product_id ORDER BY sp.current_price, sp.price_effective_date DESC, sp.id) AS price_rank,'],
    array['inventory_intelligence',
      'max(ranked_prices.supplier_price_count) AS supplier_price_count',
      'max(ranked_prices.supplier_price_count) AS supplier_price_count,'
      || E'\n            bool_or(ranked_prices.prices_span_currencies) AS prices_span_currencies,'
      || E'\n            max(ranked_prices.currency) FILTER (WHERE ranked_prices.price_rank = 1) AS cheapest_currency'],
    array['inventory_intelligence',
      E'    ps.cheapest_supplier_id,\n    ps.cheapest_supplier_name,\n    ps.cheapest_unit_price,\n    ps.cheapest_price_effective_date,\n    ps.price_advantage,\n    ps.supplier_price_count,',
      E'    CASE WHEN NOT COALESCE(ps.prices_span_currencies, false) THEN ps.cheapest_supplier_id END AS cheapest_supplier_id,'
      || E'\n    CASE WHEN NOT COALESCE(ps.prices_span_currencies, false) THEN ps.cheapest_supplier_name END AS cheapest_supplier_name,'
      || E'\n    CASE WHEN NOT COALESCE(ps.prices_span_currencies, false) THEN ps.cheapest_unit_price END AS cheapest_unit_price,'
      || E'\n    CASE WHEN NOT COALESCE(ps.prices_span_currencies, false) THEN ps.cheapest_price_effective_date END AS cheapest_price_effective_date,'
      || E'\n    CASE WHEN NOT COALESCE(ps.prices_span_currencies, false) THEN ps.price_advantage END AS price_advantage,'
      || E'\n    ps.supplier_price_count,'
      || E'\n    CASE WHEN NOT COALESCE(ps.prices_span_currencies, false) THEN ps.cheapest_currency END AS cheapest_currency,'
      || E'\n    COALESCE(ps.prices_span_currencies, false) AS prices_span_currencies,']
  ];

  for i in 1 .. array_length(v_pairs, 1) loop
    v_view := v_pairs[i][1];
    v_anchor := v_pairs[i][2];
    v_replacement := v_pairs[i][3];

    select definition into v_definition from v0223_view_snapshot where view_name = v_view;
    if v_definition is null then
      raise exception '0223: view % was not captured', v_view;
    end if;
    if (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor) <> 1 then
      raise exception '0223: anchor % for view % does not appear exactly once', i, v_view;
    end if;
    v_edited := replace(v_definition, v_anchor, v_replacement);
    update v0223_view_snapshot set definition = v_edited where view_name = v_view;
  end loop;
end
$edit_0223$;

drop view public.inventory_intelligence;
drop view public.supplier_metrics;

do $rebuild_0223$
declare
  v record;
begin
  for v in select * from v0223_view_snapshot order by view_name loop
    execute format('create view public.%I with (%s) as %s', v.view_name, v.options, v.definition);
    if v.description is not null then
      execute format('comment on view public.%I is %L', v.view_name, v.description);
    end if;
  end loop;
  for v in select * from v0223_view_grants where role_name <> current_user
           order by view_name, role_name, privilege_type loop
    execute format('grant %s on public.%I to %I', v.privilege_type, v.view_name, v.role_name);
  end loop;
end
$rebuild_0223$;

drop table v0223_view_snapshot;
drop table v0223_view_grants;

comment on view public.supplier_metrics is
  'Per-supplier delivery, exception, credit and price-change metrics (0012, per-currency credit '
  'remainder since 0223). open_credits_amount is NULL when the supplier has open credits in more '
  'than one currency: the two readers already draw a dash there for the office role, and a sum of '
  'two currencies would be a worse answer than no answer.';

do $assert_0223$
declare
  v_definition text;
  v_violations text;
begin
  select pg_get_viewdef('public.supplier_metrics'::regclass, true) into v_definition;
  if position('open_credit_currency_count' in v_definition) = 0 then
    raise exception '0223: supplier_metrics did not take the per-currency credit guard';
  end if;

  select pg_get_viewdef('public.inventory_intelligence'::regclass, true) into v_definition;
  if position('prices_span_currencies' in v_definition) = 0 then
    raise exception '0223: inventory_intelligence did not take the single-currency guard';
  end if;

  -- The properties the rebuild must not have dropped: both views are still invoker-side, still
  -- tenant-filtered, and still readable by the browser role.
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname in ('supplier_metrics', 'inventory_intelligence')
         and c.reloptions @> array['security_invoker=on']) <> 2 then
    raise exception '0223: a rebuilt view lost security_invoker';
  end if;
  if not has_table_privilege('authenticated', 'public.supplier_metrics', 'select')
     or not has_table_privilege('authenticated', 'public.inventory_intelligence', 'select') then
    raise exception '0223: a rebuilt view lost its browser grant';
  end if;
  if position('auth_org()' in pg_get_viewdef('public.supplier_metrics'::regclass, true)) = 0
     or position('auth_org()' in pg_get_viewdef('public.inventory_intelligence'::regclass, true)) = 0 then
    raise exception '0223: a rebuilt view lost its tenant filter';
  end if;

  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0223 scope assertions failed:\n%', v_violations;
  end if;
end
$assert_0223$;
