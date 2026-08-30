-- 0243 — the settings screen can finally ask which currencies this business works in.
--
-- `#288` said a used currency with no configured tolerance is "shown in settings as needing a
-- decision". `0219` built the half that answers what the tolerance is; nothing was ever built that
-- could answer WHICH CURRENCIES TO ASK ABOUT, so the sentence had no subject and the screen was
-- never written. This function is that subject.
--
-- `#292` (owner, 30.08.2026) decided the answer is the full history, not the open balance. A dollar
-- supplier whose file closed last year is still a dollar the business has handled, and a tolerance
-- stated once should not disappear from the screen because the last invoice was paid. So nothing
-- here filters `deleted_at`, and nothing here requires a balance.
--
-- SECURITY INVOKER, DELIBERATELY, AND IT IS NOT A DETAIL. Every table below already carries an RLS
-- policy filtering `org_id = auth_org()`, so an invoker function sees exactly one tenant's rows
-- without any new trust. A definer would have needed a row in `private.scope_registry`'s definer
-- coverage, would have fallen under A5 (which only inspects `prosecdef` functions), and would have
-- widened the definer surface to answer a question about ISO codes. The explicit `org_id =
-- auth_org()` predicates below are therefore belt-and-braces rather than the only guard — the house
-- pattern from `0219`, kept so the scoping is legible in the body itself.
--
-- `bank_transactions` is deliberately absent: `0217` locks its currency to its statement through
-- `bank_transactions_import_currency_fk`, so it can contain no code `bank_imports` does not already
-- contain, and scanning it would only cost a second pass over the largest table here.

create function public.currencies_in_use()
returns table (currency text, sources text[])
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  with seen as (
    -- The books' own currency is in use by definition, even in a business that has never issued
    -- a document.
    select 'base_currency'::text as source, organization.base_currency as currency
      from public.organizations organization
      where organization.id = auth_org()
    union all
    -- A supplier configured for dollars is the ONE entry here that appears BEFORE any money does.
    -- It is what lets an owner state the tolerance ahead of the first invoice instead of meeting
    -- the refusal first (#293).
    select 'supplier_default', supplier.default_currency
      from public.suppliers supplier where supplier.org_id = auth_org()
    union all
    select 'invoice', invoice.currency
      from public.invoices invoice where invoice.org_id = auth_org()
    union all
    select 'payment', payment.currency
      from public.payments payment where payment.org_id = auth_org()
    union all
    select 'payment_request', request.currency
      from public.payment_requests request where request.org_id = auth_org()
    union all
    select 'credit_request', credit.currency
      from public.credit_requests credit where credit.org_id = auth_org()
    union all
    select 'purchase_order', purchase_order.currency
      from public.purchase_orders purchase_order where purchase_order.org_id = auth_org()
    union all
    select 'purchase_request', purchase_request.currency
      from public.purchase_requests purchase_request where purchase_request.org_id = auth_org()
    union all
    select 'bank_import', bank_import.currency
      from public.bank_imports bank_import where bank_import.org_id = auth_org()
    union all
    select 'supplier_product', supplier_product.currency
      from public.supplier_products supplier_product where supplier_product.org_id = auth_org()
    union all
    select 'price_history', price.currency
      from public.price_history price where price.org_id = auth_org()
    union all
    select 'approval_threshold', policy.currency
      from public.approval_policy_configurations policy where policy.org_id = auth_org()
  )
  select seen.currency, array_agg(distinct seen.source order by seen.source)
  from seen
  where seen.currency is not null
    and auth_role() in ('owner', 'office', 'accountant')
  group by seen.currency
  order by seen.currency
$$;

comment on function public.currencies_in_use() is
  'Every currency this organisation has ever used, with the surfaces it was seen on (0243, '
  'OPEN-DECISIONS #292). History, not open balance: a closed file still counts, because a '
  'tolerance stated for it should not vanish from settings when the last invoice is paid. '
  'SECURITY INVOKER — RLS does the tenant scoping and no definer surface is added.';

revoke all on function public.currencies_in_use() from public, anon;
grant execute on function public.currencies_in_use() to authenticated, service_role;

-- ===== Proof =====
do $assert_0243$
declare
  v_violations text;
  v_secdef     boolean;
begin
  if to_regprocedure('public.currencies_in_use()') is null then
    raise exception '0243: currencies_in_use() is missing';
  end if;

  -- The whole argument for this shape. If it ever becomes a definer, A5 starts applying to it and
  -- the reasoning in the header above stops being true — so the migration says so out loud rather
  -- than leaving it to a reviewer to notice.
  select proc.prosecdef into v_secdef
  from pg_catalog.pg_proc proc
  where proc.oid = 'public.currencies_in_use()'::regprocedure;
  if v_secdef then
    raise exception '0243: currencies_in_use() is SECURITY DEFINER; it is written to be INVOKER';
  end if;

  if has_function_privilege('anon', 'public.currencies_in_use()', 'execute') then
    raise exception '0243: anon can execute currencies_in_use()';
  end if;
  if not has_function_privilege('authenticated', 'public.currencies_in_use()', 'execute') then
    raise exception '0243: authenticated cannot execute currencies_in_use()';
  end if;

  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0243 scope assertions failed:\n%', v_violations;
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0243 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0243$;
