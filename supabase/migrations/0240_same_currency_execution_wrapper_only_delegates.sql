-- 0240: the compatibility wrapper is a pure invoker. Authorization and step-up live once in the
-- 0234 command it delegates to; duplicating the private helper in an invoker required a privilege
-- the browser intentionally does not have.

create or replace function public.execute_payment_request(
  p_payment_request_id uuid,p_paid_date date,p_method text,p_reference text,p_notes text,
  p_allocations jsonb,p_reason text
) returns jsonb language sql security invoker set search_path=public,pg_temp as $$
  select public.execute_payment_request(
    p_payment_request_id,p_paid_date,p_method,p_reference,p_notes,p_allocations,
    null,null,p_reason)
$$;

do $assert_0240$
declare v_body text; v_violations text;
begin
  select prosrc into v_body from pg_proc where oid=
    'public.execute_payment_request(uuid,date,text,text,text,jsonb,text)'::regprocedure;
  if position('execute_payment_request' in v_body)=0 or position('null,null' in replace(v_body,' ',''))=0 then
    raise exception '0240: compatibility wrapper does not delegate canonically'; end if;
  if (select prosecdef from pg_proc where oid=
      'public.execute_payment_request(uuid,date,text,text,text,jsonb,text)'::regprocedure) then
    raise exception '0240: compatibility wrapper is not invoker'; end if;
  select string_agg(assertion||' -- '||detail,e'\n' order by assertion,detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then raise exception e'0240 scope failed:\n%',v_violations; end if;
end
$assert_0240$;
