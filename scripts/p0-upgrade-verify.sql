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

select 'P0 upgrade verification passed.' as result;
