do $$
declare
  v_count bigint;
  v_bad text;
begin
  foreach v_bad in array array[
    'supplier_categories','purchase_request_items','purchase_order_items',
    'goods_receipt_items','invoice_order_links','invoice_receipt_links',
    'payment_request_invoices'
  ] loop
    execute format('select count(*) from %I where org_id is null', v_bad) into v_count;
    if v_count <> 0 then raise exception 'upgrade left null tenant identity on %', v_bad; end if;
  end loop;

  select count(*) into v_count
  from pg_constraint
  where conname like 'p0\_%\_tenant\_fk' escape '\' and not convalidated;
  if v_count <> 0 then raise exception 'upgrade left % unvalidated P0 tenant constraints', v_count; end if;

  select count(*) into v_count from invoices where invoice_number in ('UP-A','UP-B');
  if v_count <> 2 then raise exception 'upgrade did not preserve invoice fixtures'; end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'audit_logs'
      and grantee in ('PUBLIC','anon','authenticated') and privilege_type = 'INSERT'
  ) then raise exception 'browser audit INSERT survived upgrade'; end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name in ('invoices','payments','payment_allocations','documents')
      and grantee in ('PUBLIC','anon','authenticated') and privilege_type = 'DELETE'
  ) then raise exception 'financial DELETE survived upgrade'; end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and grantee in ('PUBLIC','anon','authenticated') and privilege_type = 'TRUNCATE'
  ) then raise exception 'browser TRUNCATE survived upgrade'; end if;

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'invoice_balances'
      and c.reloptions @> array['security_invoker=on','security_barrier=on']
  ) then raise exception 'invoice_balances lost invoker/barrier options'; end if;
end
$$;

-- Wave 3 (0054-0056): the scope backfill must leave both fixture organizations with a
-- complete default unit chain and every scoped row anchored to its dimension default.
-- The fixture deliberately has organizations with ZERO profiles -- the user assertions
-- therefore check "no profile left behind", not "profiles exist".
do $$
declare
  v_count bigint;
  v_table text;
begin
  select count(*) into v_count
  from organizations o
  where (select count(*) from org_units u where u.org_id = o.id and u.unit_type = 'root') <> 1;
  if v_count <> 0 then
    raise exception 'upgrade left % org(s) without exactly one root unit', v_count;
  end if;

  select count(*) into v_count
  from organizations o
  where not exists (select 1 from org_units u where u.org_id = o.id and u.unit_type = 'legal_entity')
     or not exists (select 1 from org_units u where u.org_id = o.id and u.unit_type = 'branch')
     or not exists (select 1 from org_units u where u.org_id = o.id and u.unit_type = 'warehouse');
  if v_count <> 0 then
    raise exception 'upgrade left % org(s) without the default legal_entity/branch/warehouse units', v_count;
  end if;

  select count(*) into v_count
  from org_units u join org_units up on up.id = u.parent_id
  where up.org_id <> u.org_id;
  if v_count <> 0 then
    raise exception 'upgrade produced % org_units row(s) with a cross-tenant parent', v_count;
  end if;

  select count(*) into v_count
  from profiles p
  where not exists (
          select 1 from user_scope_grants g where g.org_id = p.org_id and g.user_id = p.id)
     or not exists (
          select 1 from user_scope_closure c where c.org_id = p.org_id and c.user_id = p.id);
  if v_count <> 0 then
    raise exception 'upgrade left % profile(s) without a scope grant or closure row', v_count;
  end if;

  foreach v_table in array array[
    'invoices', 'payments', 'purchase_orders', 'goods_receipts', 'inventory_movements'
  ] loop
    execute format('select count(*) from %I where unit_id is null', v_table) into v_count;
    if v_count <> 0 then
      raise exception 'upgrade left % row(s) of % without a unit', v_count, v_table;
    end if;
    execute format(
      'select count(*) from %I t join org_units u on u.id = t.unit_id where u.org_id <> t.org_id',
      v_table) into v_count;
    if v_count <> 0 then
      raise exception 'upgrade produced % cross-tenant unit pointer(s) on %', v_count, v_table;
    end if;
  end loop;

  -- documents are cross-scope: the backfill must NOT have invented a unit for them.
  select count(*) into v_count from documents where unit_id is not null;
  if v_count <> 0 then
    raise exception 'upgrade assigned a unit to % document(s); documents stay org-visible', v_count;
  end if;
end
$$;

select 'P0 upgrade verification passed.' as result;
