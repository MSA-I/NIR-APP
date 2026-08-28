-- 0239: the compatibility wrapper reads and writes nothing itself. It can be SECURITY INVOKER and
-- call the 0234 SECURITY DEFINER command, so the temporary 0235 exemption is drained.

create or replace function public.execute_payment_request(
  p_payment_request_id uuid,p_paid_date date,p_method text,p_reference text,p_notes text,
  p_allocations jsonb,p_reason text
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if auth_org() is null or auth.uid() is null or auth_role() <> 'accountant' then
    raise exception 'payment_request_not_executable' using errcode='42501';
  end if;
  perform public.assert_recent_password_authentication();
  return public.execute_payment_request(
    p_payment_request_id,p_paid_date,p_method,p_reference,p_notes,p_allocations,
    null,null,p_reason);
end
$$;

delete from private.scope_definer_exemptions
where function_signature in (
  select replace(to_regprocedure(
    'public.execute_payment_request(uuid,date,text,text,text,jsonb,text)')::text,'public.','')
);

do $assert_0239$
declare v_violations text;
begin
  if (select prosecdef from pg_proc where oid=
      'public.execute_payment_request(uuid,date,text,text,text,jsonb,text)'::regprocedure) then
    raise exception '0239: compatibility wrapper remains SECURITY DEFINER'; end if;
  if exists(select 1 from private.scope_definer_exemptions
    where function_signature='execute_payment_request(uuid,date,text,text,text,jsonb,text)') then
    raise exception '0239: compatibility exemption remains'; end if;
  select string_agg(assertion||' -- '||detail,e'\n' order by assertion,detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then raise exception e'0239 scope failed:\n%',v_violations; end if;
end
$assert_0239$;
