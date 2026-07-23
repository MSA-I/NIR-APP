-- Restore the privileged server CRUD surface that exists through 0029. Trusted Edge Functions
-- use service_role for provisioning, Push delivery and price-list intake, while browser roles keep
-- the explicit column/operation allowlist from 0030. RLS is not the service-role boundary: keeping
-- this key server-only is mandatory.

grant select, insert, update, delete on all tables in schema public to service_role;

do $$
begin
  if exists (
    select 1
    from pg_catalog.pg_tables table_info
    where table_info.schemaname = 'public'
      and (
        not has_table_privilege(
          'service_role',
          format('%I.%I', table_info.schemaname, table_info.tablename),
          'SELECT'
        )
        or not has_table_privilege(
          'service_role',
          format('%I.%I', table_info.schemaname, table_info.tablename),
          'INSERT'
        )
        or not has_table_privilege(
          'service_role',
          format('%I.%I', table_info.schemaname, table_info.tablename),
          'UPDATE'
        )
        or not has_table_privilege(
          'service_role',
          format('%I.%I', table_info.schemaname, table_info.tablename),
          'DELETE'
        )
      )
  ) then
    raise exception 'service_role_public_crud_restore_incomplete' using errcode = '42501';
  end if;
end
$$;
