-- 0235: compatibility for a frontend deployed before 0234. The old signature means settlement in
-- the request currency and delegates with NULL/NULL; it cannot invent or suppress cross-currency
-- settlement. New clients call the extended signature directly.

create or replace function public.execute_payment_request(
  p_payment_request_id uuid,p_paid_date date,p_method text,p_reference text,p_notes text,
  p_allocations jsonb,p_reason text
) returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select public.execute_payment_request(
    p_payment_request_id,p_paid_date,p_method,p_reference,p_notes,p_allocations,
    null,null,p_reason)
$$;

revoke all on function public.execute_payment_request(uuid,date,text,text,text,jsonb,text)
  from public,anon;
grant execute on function public.execute_payment_request(uuid,date,text,text,text,jsonb,text)
  to authenticated;

insert into private.scope_definer_exemptions(function_signature,reason,target_wave) values(
  'execute_payment_request(uuid,date,text,text,text,jsonb,text)',
  '0235 compatibility wrapper supplies NULL settlement pair to the currency-aware command; it reads and writes nothing itself',
  'multi-unit enablement wave')
on conflict(function_signature) do update set reason=excluded.reason,target_wave=excluded.target_wave;

do $assert_0235$
declare v_violations text;
begin
  if to_regprocedure('public.execute_payment_request(uuid,date,text,text,text,jsonb,text)') is null
     or position('null,null,p_reason' in replace((select prosrc from pg_proc where oid=
       'public.execute_payment_request(uuid,date,text,text,text,jsonb,text)'::regprocedure),' ',''))=0 then
    raise exception '0235: same-currency compatibility wrapper is missing or does not delegate canonically';
  end if;
  select string_agg(assertion||' -- '||detail,e'\n' order by assertion,detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then raise exception e'0235 scope failed:\n%',v_violations; end if;
end
$assert_0235$;
