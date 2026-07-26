-- Make the profile self-service ACL explicit instead of inheriting a cluster-level default.
-- The trigger from 0020 remains the command boundary for access fields; identity columns stay closed.

revoke update on table public.profiles from public, anon, authenticated;

do $$
declare
  v_column text;
begin
  for v_column in
    select a.attname
    from pg_catalog.pg_attribute a
    where a.attrelid = 'public.profiles'::regclass
      and a.attnum > 0
      and not a.attisdropped
  loop
    execute format(
      'revoke update (%I) on table public.profiles from public, anon, authenticated',
      v_column
    );
  end loop;
end
$$;

grant update (full_name, phone, role, active, supplier_id) on table public.profiles to authenticated;

do $$
declare
  v_unexpected text;
begin
  if not has_column_privilege('authenticated', 'public.profiles', 'full_name', 'update')
     or not has_column_privilege('authenticated', 'public.profiles', 'phone', 'update')
     or not has_column_privilege('authenticated', 'public.profiles', 'role', 'update')
     or not has_column_privilege('authenticated', 'public.profiles', 'active', 'update')
     or not has_column_privilege('authenticated', 'public.profiles', 'supplier_id', 'update') then
    raise exception '0042 refused: authenticated profile command columns are not writable.';
  end if;

  select string_agg(a.attname, ', ' order by a.attname)
  into v_unexpected
  from pg_catalog.pg_attribute a
  where a.attrelid = 'public.profiles'::regclass
    and a.attnum > 0
    and not a.attisdropped
    and a.attname not in ('full_name', 'phone', 'role', 'active', 'supplier_id')
    and has_column_privilege('authenticated', 'public.profiles', a.attname, 'update');

  if v_unexpected is not null then
    raise exception '0042 refused: authenticated can update unexpected profile columns: %.', v_unexpected;
  end if;
end
$$;
