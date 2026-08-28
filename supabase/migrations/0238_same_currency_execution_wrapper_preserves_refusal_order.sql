-- 0238: preserve the original refusal order on the 0235 compatibility signature: authorization
-- before step-up, then the currency-aware delegate. An owner must not receive an authentication
-- freshness error for a command only accountants may execute.

create or replace function public.execute_payment_request(
  p_payment_request_id uuid,p_paid_date date,p_method text,p_reference text,p_notes text,
  p_allocations jsonb,p_reason text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
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

do $assert_0238$
declare v_body text; v_violations text;
begin
  select prosrc into v_body from pg_proc where oid=
    'public.execute_payment_request(uuid,date,text,text,text,jsonb,text)'::regprocedure;
  if position('auth_role() <> ''accountant''' in v_body)=0
     or position('assert_recent_password_authentication' in v_body)=0 then
    raise exception '0238: compatibility refusal order is incomplete'; end if;
  select string_agg(assertion||' -- '||detail,e'\n' order by assertion,detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then raise exception e'0238 scope failed:\n%',v_violations; end if;
end
$assert_0238$;
