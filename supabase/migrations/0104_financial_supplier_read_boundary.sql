-- 0104 -- Financial supplier projections replace the accountant's historical raw-table grant.
-- PostgreSQL RLS cannot mask columns, so the raw policy denies accountant and this server view
-- exposes only accounting identity/payment fields. Historical suppliers remain visible.

drop policy if exists suppliers_select on public.suppliers;
create policy suppliers_select on public.suppliers for select to authenticated using (
  org_id = auth_org() and (
    auth_role() in ('owner', 'office', 'kitchen')
    or (auth_role() = 'payer' and exists (
      select 1 from public.payment_requests pr
      where pr.org_id = suppliers.org_id and pr.supplier_id = suppliers.id
        and pr.status in ('approved', 'sent_for_execution', 'executed', 'matched')
    ))
  )
);

create view public.financial_supplier_directory
with (security_barrier = true)
as
select s.id, s.name, s.tax_id, s.payment_terms, s.status, s.bank_details
from public.suppliers s
where s.org_id = auth_org()
  and auth.uid() is not null
  and (
    auth_role() in ('owner', 'office', 'kitchen', 'accountant')
    or (auth_role() = 'payer' and exists (
      select 1 from public.payment_requests pr
      where pr.org_id = s.org_id and pr.supplier_id = s.id
        and pr.status in ('approved', 'sent_for_execution', 'executed', 'matched')
    ))
  );

revoke all on public.financial_supplier_directory from public, anon, authenticated;
grant select on public.financial_supplier_directory to authenticated;

create or replace function public.read_financial_supplier(p_supplier_id uuid)
returns table (
  id uuid,
  name text,
  tax_id text,
  payment_terms text,
  status supplier_status
)
language sql stable security invoker
set search_path = public
as $$
  select s.id, s.name, s.tax_id, s.payment_terms, s.status
  from public.financial_supplier_directory s
  where p_supplier_id is not null
    and s.id = p_supplier_id
    and auth_role() in ('owner', 'accountant')
$$;

revoke all on function public.read_financial_supplier(uuid) from public, anon;
grant execute on function public.read_financial_supplier(uuid) to authenticated;

do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0104 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
