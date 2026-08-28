-- 0237: keep the structural step-up contract on the 0235 compatibility signature. The delegated
-- 0234 command checks again; the duplicate check is intentional fail-closed compatibility.

create or replace function public.execute_payment_request(
  p_payment_request_id uuid,p_paid_date date,p_method text,p_reference text,p_notes text,
  p_allocations jsonb,p_reason text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform public.assert_recent_password_authentication();
  return public.execute_payment_request(
    p_payment_request_id,p_paid_date,p_method,p_reference,p_notes,p_allocations,
    null,null,p_reason);
end
$$;

do $assert_0237$
declare v_violations text;
begin
  if position('assert_recent_password_authentication' in (select prosrc from pg_proc where oid=
       'public.execute_payment_request(uuid,date,text,text,text,jsonb,text)'::regprocedure))=0 then
    raise exception '0237: compatibility wrapper lost step-up'; end if;
  select string_agg(assertion||' -- '||detail,e'\n' order by assertion,detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then raise exception e'0237 scope failed:\n%',v_violations; end if;
end
$assert_0237$;
