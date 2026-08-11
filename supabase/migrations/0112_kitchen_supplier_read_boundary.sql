-- 0112 -- A kitchen manager orders from suppliers. They do not hold the supplier's bank account.
--
-- THE OBVIOUS FIX IS THE BROKEN ONE, and it was measured before anything here was written.
-- Removing `kitchen` from `suppliers_select` (0097:6-15) looks like the whole job. It is not: it
-- breaks ordering and receiving outright. PostgREST filters EMBEDS by RLS, so
-- `purchase_orders?select=*,supplier:suppliers(name)` returns `supplier: null` the moment the
-- reader loses row access -- and Orders, Receiving, ReceiptDetail, NewOrder and the WhatsApp share
-- all read the supplier's name that way. The kitchen manager would keep the buttons and lose the
-- supplier's name on every one of them.
--
-- WHAT ACTUALLY WORKS. PostgreSQL RLS cannot mask columns -- 0097 says so in its first line -- but
-- COLUMN PRIVILEGES can, and they are enforced beneath RLS rather than beside it. So:
--
--   * `suppliers_select` is left exactly as it is. Every embed keeps returning the name, and
--     nothing in ordering or receiving changes.
--   * `select (bank_details)` is revoked from `authenticated` -- from EVERY app role, because they
--     share one database role and a column grant cannot tell them apart.
--   * `public.financial_supplier_directory` (0097) hands it back. A view reads with its OWNER's
--     privileges, so it can select a column its caller cannot, and its own predicate decides who
--     gets to ask. That predicate is where `kitchen` is removed -- one line, one place, and the
--     rest of the schema untouched.
--
-- WHY `bank_details` AND NOT ALSO `tax_id`/`payment_terms`. Narrow on purpose. `bank_details` is
-- the column this product already treats as special: 0061 revoked its UPDATE grant and routed
-- changes through `update_supplier_bank_details`, precisely because it is the field that moves
-- money to a destination. `tax_id` is on every invoice a kitchen manager already handles, and
-- `QuickCreateSupplier` reads it to stop a duplicate supplier being created mid-order. Revoking
-- those would cost a working flow and buy a secret that is printed on the paperwork anyway.
--
-- WHAT KITCHEN KEEPS, deliberately: the supplier's name, status, phone, whatsapp and email -- what
-- you need to place an order and receive goods. What it loses: the bank account, and the supplier
-- management screen (client-side, same wave).

-- ===== 1. The column leaves the browser's reach =====
--
-- A column-level REVOKE does nothing while a TABLE-level SELECT grant stands: table SELECT already
-- implies every column, and the two are not subtracted from one another. So the table grant is
-- dropped and re-issued column by column, every column except this one. The list is built from
-- information_schema rather than typed out, because a typed list silently stops covering a column
-- added later -- and anchor (a) below re-derives it to prove the coverage is complete.
do $$
declare
  v_columns text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into v_columns
  from information_schema.columns
  where table_schema = 'public' and table_name = 'suppliers'
    and column_name <> 'bank_details';

  revoke select on public.suppliers from authenticated, anon;
  execute format('grant select (%s) on public.suppliers to authenticated', v_columns);
end
$$;

comment on column public.suppliers.bank_details is
  'The destination money is sent to. NOT directly selectable by any client role (0112): a column '
  'privilege is revoked from `authenticated`, beneath RLS, so no crafted PostgREST query reaches '
  'it. Readers go through public.financial_supplier_directory, which runs with its owner''s '
  'privileges and carries its own role predicate. Writes have gone through '
  'update_supplier_bank_details since 0061 for the same reason.';

-- ===== 2. The directory stops serving kitchen =====
--
-- Same body as 0097 apart from one word. `kitchen` leaves the role list; every other reader --
-- owner, office, accountant, and payer for a request they are executing -- is unchanged, and the
-- `security_barrier` property is restated rather than assumed.
create or replace view public.financial_supplier_directory
with (security_barrier = true)
as
select s.id, s.name, s.tax_id, s.payment_terms, s.status, s.bank_details
from public.suppliers s
where s.org_id = auth_org()
  and auth.uid() is not null
  and (
    auth_role() in ('owner', 'office', 'accountant')
    or (auth_role() = 'payer' and exists (
      select 1 from public.payment_requests pr
      where pr.org_id = s.org_id and pr.supplier_id = s.id
        and pr.status in ('approved', 'sent_for_execution', 'executed', 'matched')
    ))
  );

revoke all on public.financial_supplier_directory from public, anon, authenticated;
grant select on public.financial_supplier_directory to authenticated;

comment on view public.financial_supplier_directory is
  'Supplier identity and payment fields for the roles that need them (0097, narrowed 0112). '
  '`kitchen` was removed on 10.08.2026: a kitchen manager orders from a supplier and receives '
  'goods, and needs the name, not the bank account. This view is also the ONLY way any role now '
  'reads suppliers.bank_details, since 0112 revoked the column privilege from `authenticated`.';

-- ===== 3. A1/A3/A5 re-assertion =====
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0112 scope assertions failed:\n%', v_violations;
  end if;
end
$$;

-- ===== 4. Anchors =====
do $$
declare
  v_policy text;
  v_view text;
begin
  -- (a) THE COLUMN IS UNREACHABLE DIRECTLY. This is the whole security claim.
  if has_column_privilege('authenticated', 'public.suppliers', 'bank_details', 'select')
     or has_column_privilege('anon', 'public.suppliers', 'bank_details', 'select') then
    raise exception
      '0112: a client role can still select suppliers.bank_details directly. RLS cannot mask a '
      'column; the column privilege is the only thing standing here.';
  end if;

  -- (a2) ...and EVERY OTHER column still is. Revoking the table grant to get column granularity
  -- is the kind of change that takes a bystander with it; this re-derives the list and names the
  -- casualty instead of leaving a screen mysteriously empty.
  if exists (
    select 1 from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'suppliers'
      and c.column_name <> 'bank_details'
      and not has_column_privilege('authenticated', 'public.suppliers', c.column_name, 'select')
  ) then
    raise exception '0112: a supplier column other than bank_details became unreadable: %',
      (select string_agg(c.column_name, ', ') from information_schema.columns c
       where c.table_schema = 'public' and c.table_name = 'suppliers'
         and c.column_name <> 'bank_details'
         and not has_column_privilege('authenticated', 'public.suppliers', c.column_name, 'select'));
  end if;

  -- (b) THE EMBEDS STILL WORK. If `kitchen` leaves this policy, ordering and receiving lose the
  -- supplier name on every screen -- PostgREST filters embeds by RLS. This assertion is the
  -- difference between narrowing a role and breaking one.
  select pg_get_expr(pol.polqual, pol.polrelid) into v_policy
  from pg_policy pol join pg_class c on c.oid = pol.polrelid
  where c.relname = 'suppliers' and pol.polname = 'suppliers_select';
  if v_policy is null or position('kitchen' in v_policy) = 0 then
    raise exception
      '0112: kitchen lost row access to suppliers. PostgREST filters embeds by RLS, so every '
      'purchase order, receipt and share link would render `supplier: null`. The column privilege '
      'is what narrows this role, not the policy.';
  end if;

  -- (c) The directory no longer serves kitchen, and still serves everyone else.
  select pg_get_viewdef('public.financial_supplier_directory'::regclass) into v_view;
  if position('''kitchen''' in v_view) > 0 then
    raise exception '0112: the financial directory still serves kitchen.';
  end if;
  if position('''accountant''' in v_view) = 0 or position('''office''' in v_view) = 0
     or position('''payer''' in v_view) = 0 then
    raise exception '0112: a role that needs the financial directory was dropped from it.';
  end if;
  if not (select reloptions::text like '%security_barrier=true%'
          from pg_class where oid = 'public.financial_supplier_directory'::regclass) then
    raise exception
      '0112: the directory lost security_barrier, so a caller''s own WHERE clause can now run '
      'before the role predicate and leak rows through error messages or timing.';
  end if;

  -- (d) The write path 0061 built is untouched. Reading and writing this column are two separate
  -- boundaries and this migration only moved the first.
  if to_regprocedure('public.update_supplier_bank_details(uuid,text,text)') is null then
    raise exception '0112: the reasoned bank-details write command is gone.';
  end if;
  if has_column_privilege('authenticated', 'public.suppliers', 'bank_details', 'update') then
    raise exception
      '0112: a client role regained direct UPDATE on bank_details; 0061 revoked it so that '
      'changing where money goes is always a reasoned, audited command.';
  end if;
end
$$;
