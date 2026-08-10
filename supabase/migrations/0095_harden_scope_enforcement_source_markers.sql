-- 0095 -- A5 must recognize executable scope enforcement, not marker text hidden in
-- line or block comments. Keep the existing table-touch and exemption contract.

do $guard$
declare
  v_source text;
begin
  select p.prosrc
    into v_source
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private'
    and p.proname = 'scope_enforcement_violations'
    and p.pronargs = 0;

  if v_source is null then
    raise exception '0095 requires private.scope_enforcement_violations() from migration 0057';
  end if;

  -- Preserve statement content, including whitespace inside literals. Only transport
  -- newlines and outer whitespace are normalized for the historical-body fingerprint.
  if md5(btrim(
       replace(replace(v_source, chr(13) || chr(10), chr(10)), chr(13), chr(10)),
       chr(9) || chr(10) || chr(13) || chr(32)
     )) <> '28ed254d7c81faa09f87a8172974ec11' then
    raise exception '0095 ancestry guard failed: unexpected A5 marker implementation';
  end if;
end
$guard$;

-- PostgreSQL supports nested block comments and several string syntaxes. Regex deletion cannot
-- distinguish all of them, so A5 uses one small lexer and searches only executable source.
create or replace function private.sql_has_executable_scope_marker(p_source text)
returns boolean
language plpgsql immutable strict
set search_path = pg_catalog
as $function$
declare
  v_i integer := 1;
  v_length integer := length(p_source);
  v_state text := 'code';
  v_depth integer := 0;
  v_char text;
  v_pair text;
  v_tag text;
  v_marker text;
  v_after integer;
begin
  while v_i <= v_length loop
    v_char := substr(p_source, v_i, 1);
    v_pair := substr(p_source, v_i, 2);

    if v_state = 'line_comment' then
      if v_char in (chr(10), chr(13)) then
        v_state := 'code';
      end if;
      v_i := v_i + 1;
      continue;
    end if;

    if v_state = 'block_comment' then
      if v_pair = '/*' then
        v_depth := v_depth + 1;
        v_i := v_i + 2;
      elsif v_pair = '*/' then
        v_depth := v_depth - 1;
        v_i := v_i + 2;
        if v_depth = 0 then v_state := 'code'; end if;
      else
        v_i := v_i + 1;
      end if;
      continue;
    end if;

    if v_state = 'escape_single_quote' then
      if v_char = E'\\' then
        v_i := least(v_i + 2, v_length + 1);
      elsif v_pair = '''''' then
        v_i := v_i + 2;
      elsif v_char = '''' then
        v_state := 'code';
        v_i := v_i + 1;
      else
        v_i := v_i + 1;
      end if;
      continue;
    end if;

    if v_state = 'single_quote' then
      if v_pair = '''''' then
        v_i := v_i + 2;
      elsif v_char = '''' then
        v_state := 'code';
        v_i := v_i + 1;
      else
        v_i := v_i + 1;
      end if;
      continue;
    end if;

    if v_state = 'double_quote' then
      if v_pair = '""' then
        v_i := v_i + 2;
      elsif v_char = '"' then
        v_state := 'code';
        v_i := v_i + 1;
      else
        v_i := v_i + 1;
      end if;
      continue;
    end if;

    if v_state = 'dollar_quote' then
      if substr(p_source, v_i, length(v_tag)) = v_tag then
        v_i := v_i + length(v_tag);
        v_state := 'code';
        v_tag := null;
      else
        v_i := v_i + 1;
      end if;
      continue;
    end if;

    if v_pair = '--' then
      v_state := 'line_comment';
      v_i := v_i + 2;
    elsif v_pair = '/*' then
      v_state := 'block_comment';
      v_depth := 1;
      v_i := v_i + 2;
    elsif v_char = '''' then
      -- Backslash escapes apply only to E'...' strings when
      -- standard_conforming_strings is on; ordinary strings use doubled quotes.
      v_state := case
        when v_i > 1
         and lower(substr(p_source, v_i - 1, 1)) = 'e'
         and (v_i = 2 or substr(p_source, v_i - 2, 1) !~ '[A-Za-z0-9_$]')
          then 'escape_single_quote'
        else 'single_quote'
      end;
      v_i := v_i + 1;
    elsif v_char = '"' then
      v_state := 'double_quote';
      v_i := v_i + 1;
    elsif v_char = '$' then
      v_tag := substring(substr(p_source, v_i) from '^(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)');
      if v_tag is null then
        v_i := v_i + 1;
      else
        v_state := 'dollar_quote';
        v_i := v_i + length(v_tag);
      end if;
    else
      v_marker := null;
      if v_i = 1 or substr(p_source, v_i - 1, 1) !~ '[A-Za-z0-9_$]' then
        if lower(substr(p_source, v_i, 20)) = 'assert_unit_in_scope' then
          v_marker := 'assert_unit_in_scope';
        elsif lower(substr(p_source, v_i, 11)) = 'auth_scopes' then
          v_marker := 'auth_scopes';
        end if;
      end if;
      if v_marker is not null then
        v_after := v_i + length(v_marker);
        if v_after > v_length or substr(p_source, v_after, 1) !~ '[A-Za-z0-9_$]' then
          while v_after <= v_length
            and substr(p_source, v_after, 1) ~ '[[:space:]]'
          loop
            v_after := v_after + 1;
          end loop;
          if substr(p_source, v_after, 1) = '(' then return true; end if;
        end if;
      end if;
      v_i := v_i + 1;
    end if;
  end loop;
  return false;
end
$function$;

revoke all on function private.sql_has_executable_scope_marker(text) from public, anon, authenticated;

-- A marker is not proof by itself: `perform auth_scopes();` changes no result. Every accepted
-- implementation is therefore reviewed once and pinned to its live body. A later body change
-- must update this visible ledger or A5 fails closed.
create table private.scope_definer_enforcements (
  function_signature text primary key,
  body_hash text not null check (body_hash ~ '^[0-9a-f]{32}$'),
  enforcement_kind text not null check (enforcement_kind in ('assert_unit', 'filtered_read')),
  scope_proof text not null check (length(trim(scope_proof)) between 20 and 500)
);

revoke all on table private.scope_definer_enforcements from public, anon, authenticated;

insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
) values
  (
    'create_monthly_report_snapshot(date,uuid)',
    '7c9566caca02f48902791f95a23ec7f8', 'assert_unit',
    '0074 locks the requested legal entity and asserts p_unit_id before reading snapshot sources.'
  ),
  (
    'create_payment_request(uuid,uuid,date,text,text,jsonb,text)',
    'ec6870ddbe75ea86eeacd515a7f5e836', 'assert_unit',
    '0073 derives the request unit from locked invoices and asserts it before the financial write.'
  ),
  (
    'mark_monthly_report_snapshot_sent(uuid,text)',
    'd8718aefec3cabc60547826eb12b50a3', 'assert_unit',
    '0074 locks the snapshot row and asserts its persisted unit before changing sent state.'
  ),
  (
    'open_manual_exception(text,uuid,exception_type,text)',
    '6f1d9039b9dfeeada46c9ab981e281b0', 'assert_unit',
    '0087 locks the exact purchase order or invoice, derives its persisted unit and asserts that unit before inserting the reasoned exception.'
  ),
  (
    'p0_invoice_balance_rows()',
    '2ea54924b75ef99057fbac0f167e699d', 'filtered_read',
    '0057 filters every invoice row to unit_id null or unit_id present in auth_scopes().'
  ),
  (
    'p0_supplier_balance_rows()',
    '305bb1741da579c9f62ce354b9711309', 'filtered_read',
    '0057 derives supplier balances only from invoices filtered by null-or-auth_scopes unit.'
  ),
  (
    'p1_transition_payment_request(uuid,text,text,boolean,text,uuid,numeric)',
    '624abddd16eb937474c86f360bc5dfa4', 'assert_unit',
    '0073 locks the payment request and asserts its unit before any state or allocation mutation.'
  ),
  (
    'payment_request_financial_check_signals(uuid,numeric,uuid[],uuid)',
    '225c699716392ae7eed878b22373e920', 'assert_unit',
    '0073 derives one unit from the selected invoices or request and asserts it before returning signals.'
  );

-- Keep the catalogue filter ahead of the character-by-character lexer. A SQL UNION may reorder
-- a lateral expression and feed every installed extension function to the lexer before filtering.
create or replace function private.scope_definer_marker_violations()
returns table (detail text)
language plpgsql stable
set search_path = public, pg_catalog
as $$
declare
  v_candidate record;
  v_registered boolean;
  v_enforcement record;
begin
  for v_candidate in
    select p.oid, p.prosrc, p.oid::regprocedure::text as function_signature
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.prosecdef
      and (
        exists (
          select 1 from private.scope_registry r
          where r.enforced and p.prosrc ~ ('\m' || r.table_name || '\M'))
        or exists (
          select 1
          from pg_catalog.pg_trigger tg
          join pg_catalog.pg_class c on c.oid = tg.tgrelid
          join pg_catalog.pg_namespace cn on cn.oid = c.relnamespace
          join private.scope_registry r on r.table_name = c.relname and r.enforced
          where cn.nspname = 'public'
            and not tg.tgisinternal
            and tg.tgfoid = p.oid))
  loop
    if exists (
      select 1 from private.scope_definer_exemptions e
      where e.function_signature = v_candidate.function_signature
    ) then
      continue;
    end if;

    select enforcement.body_hash = md5(v_candidate.prosrc)
           and private.sql_has_executable_scope_marker(v_candidate.prosrc)
      into v_registered
    from private.scope_definer_enforcements enforcement
    where enforcement.function_signature = v_candidate.function_signature;

    if not coalesce(v_registered, false) then
      detail := 'uncovered security definer function: ' || v_candidate.function_signature;
      return next;
    end if;
  end loop;

  for v_enforcement in
    select enforcement.function_signature
    from private.scope_definer_enforcements enforcement
    left join pg_catalog.pg_proc p
      on p.oid = pg_catalog.to_regprocedure(enforcement.function_signature)
    where p.oid is null or not p.prosecdef or md5(p.prosrc) <> enforcement.body_hash
  loop
    detail := 'stale scope enforcement registration: ' || v_enforcement.function_signature;
    return next;
  end loop;
end;
$$;

revoke all on function private.scope_definer_marker_violations() from public, anon, authenticated;

create or replace function private.scope_enforcement_violations()
returns table (assertion text, detail text)
language plpgsql stable set search_path = public as $$
declare
  v_marker record;
begin
  return query
  -- A1: every public base table is classified in the registry.
  select 'A1'::text, 'unclassified public table: ' || t.table_name
  from information_schema.tables t
  where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
    and not exists (select 1 from private.scope_registry r where r.table_name = t.table_name)
  union all
  -- A1 (staleness arm): a registry row that classifies a table that no longer exists.
  select 'A1'::text, 'registry row without a live table: ' || r.table_name
  from private.scope_registry r
  where not exists (
    select 1 from information_schema.tables t
    where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
      and t.table_name = r.table_name)
  union all
  -- A3: every enforced table carries the exact canonical restrictive scope rider.
  select 'A3'::text, 'missing or non-canonical scope rider on: ' || r.table_name
  from private.scope_registry r
  where r.enforced
    and not exists (
      select 1
      from pg_catalog.pg_policy pol
      join pg_catalog.pg_class c on c.oid = pol.polrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = r.table_name
        and pol.polname = 'scope_rider_' || r.table_name
        and not pol.polpermissive
        and pol.polcmd = '*'
        and pol.polroles = '{0}'::oid[]
        and pg_catalog.pg_get_expr(pol.polqual, pol.polrelid)
              = '((unit_id IS NULL) OR (unit_id = ANY (auth_scopes())))');

  -- A5: a marker counts only when it remains after comments and strings are removed.
  -- An exemption remains the explicit path for a reasoned definer that cannot enforce
  -- unit scope directly.
  for v_marker in
    select violation.detail from private.scope_definer_marker_violations() violation
  loop
    assertion := 'A5';
    detail := v_marker.detail;
    return next;
  end loop;
end;
$$;

revoke all on function private.scope_enforcement_violations() from public, anon, authenticated;

do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();

  if v_violations is not null then
    raise exception e'0095 scope enforcement assertions failed:\n%', v_violations;
  end if;
end
$$;
