-- 0219: the summary readers stop returning one number for two currencies, and a tolerance stops
-- being a number with no unit.
--
-- 0218 handled the balance readers. This file finishes the money READERS that the client and the
-- assistant call directly, and closes two identity keys 0217 left open.
--
-- WHAT WAS ACTUALLY WRONG, measured on `pg_proc` rather than assumed:
--
--   p2_active_payment_request_total()  returned ONE numeric for every active payment request in
--                                      the organisation. With two currencies that is the false
--                                      total the whole plan exists to prevent, and it feeds the
--                                      business summary screen and the assistant's
--                                      get_business_summary tool.
--   credit_request_balance_rows()      returned amounts with no unit at all.
--   payment_request_financial_check_signals()  summed the open balance of an arbitrary SET of
--                                      invoices and compared it to a requested amount within
--                                      "± 1" — a tolerance whose unit was the shekel by accident.
--
-- AND TWO IDENTITY KEYS 0217 SHOULD HAVE CARRIED. A credit note is issued against an invoice and a
-- payment discharges a payment request; in both cases the two rows must be in the same currency,
-- and in both cases 0217 tied only the tenant. They are added here rather than in a later phase
-- because the readers below depend on them: once they exist, summing the credits attached to one
-- invoice is a single-currency sum by construction, and `invoice_financial_check_signals` needs
-- no change at all.

-- ===== 1. The two identity keys 0217 left open =====
alter table credit_requests
  add constraint credit_requests_invoice_currency_fk
  foreign key (org_id, invoice_id, currency) references invoices (org_id, id, currency);

alter table payments
  add constraint payments_request_currency_fk
  foreign key (org_id, payment_request_id, currency) references payment_requests (org_id, id, currency);

comment on constraint credit_requests_invoice_currency_fk on credit_requests is
  'A credit note is issued against an invoice, so it is in that invoice''s currency (0219). Not a '
  'preference — it is what makes summing the credits attached to one invoice a single-currency '
  'sum, which is why invoice_financial_check_signals needs no change.';

-- ===== 2. A tolerance is an amount, so it has a currency (#288) =====
--
-- `organizations.settings` has carried `bank_match_amount_tolerance` as a bare number since
-- `0001:27`, and "within 1" meant "within one shekel" only because there was nothing else it
-- could mean. In dollars the same number is a tolerance several times wider.
--
-- The owner decided a value PER CURRENCY, with the old scalar read as the ILS value so that no
-- existing organisation changes behaviour. The second half of that decision is the half that is
-- easy to lose: **a currency with no configured tolerance does not get an invented one.** This
-- function returns null, and every caller must treat null as "cannot compare" rather than
-- substituting a number. Settings shows it as needing a decision.
create function private.money_tolerance(p_org_id uuid, p_currency text, p_key text)
returns numeric
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  select case
    -- The new shape: a map from ISO code to amount.
    when jsonb_typeof(organization.settings -> p_key) = 'object'
      then (organization.settings -> p_key ->> p_currency)::numeric
    -- The old shape: one number, which every organisation that has one wrote when the product
    -- was shekels only. It answers for ILS and for nothing else.
    when jsonb_typeof(organization.settings -> p_key) = 'number' and p_currency = 'ILS'
      then (organization.settings ->> p_key)::numeric
    else null
  end
  from public.organizations organization
  where organization.id = p_org_id
$$;

comment on function private.money_tolerance(uuid, text, text) is
  'The configured tolerance for one currency (0219, OPEN-DECISIONS #288), or NULL when this '
  'organisation has never stated one for it. NULL means "cannot compare" and must never be '
  'replaced by a default: a shekel tolerance applied to a dollar figure is several times wider '
  'than anybody agreed to.';

revoke all on function private.money_tolerance(uuid, text, text) from public, anon, authenticated;

-- ===== 3. A credit's remaining balance says which currency it is in =====
-- The amounts were already single-currency by construction — 0217's keys tie an allocation to the
-- credit it consumes — so nothing here changes except that the row now carries its unit, and the
-- casts follow the columns to numeric(14,3).
drop function if exists public.credit_request_balance_rows(uuid);

create function public.credit_request_balance_rows(p_supplier_id uuid)
returns table (
  credit_id        uuid,
  supplier_id      uuid,
  invoice_id       uuid,
  credit_number    integer,
  currency         text,
  amount           numeric,
  allocated_amount numeric,
  remaining_amount numeric,
  status           credit_status
)
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  select credit.id,
         credit.supplier_id,
         credit.invoice_id,
         credit.number,
         credit.currency,
         credit.amount::numeric(14,3),
         coalesce(sum(allocation.amount), 0)::numeric(14,3),
         greatest(credit.amount - coalesce(sum(allocation.amount), 0), 0)::numeric(14,3),
         credit.status
  from public.credit_requests credit
  left join public.payment_allocations allocation
    on allocation.org_id = credit.org_id and allocation.credit_id = credit.id
  where credit.org_id = auth_org()
    and credit.supplier_id = p_supplier_id
    and auth_role() in ('owner', 'accountant')
  group by credit.id, credit.supplier_id, credit.invoice_id, credit.number,
           credit.currency, credit.amount, credit.status
  order by credit.created_at, credit.id
$$;

revoke all on function public.credit_request_balance_rows(uuid) from public, anon;
grant execute on function public.credit_request_balance_rows(uuid) to authenticated, service_role;

comment on function public.credit_request_balance_rows(uuid) is
  'A supplier''s credit notes with what is left on each, in the currency of the invoice the credit '
  'was issued against (0173, per-currency since 0219).';

-- ===== 4. The committed-payment total splits, and loses its old name =====
-- Renamed rather than reshaped in place: this returned a bare `numeric` and now returns a set, and
-- a caller that was not updated must fail rather than receive the first row of a table where it
-- expected a total.
drop function if exists public.p2_active_payment_request_total();

create function public.p2_active_payment_request_total_by_currency()
returns table (currency text, total numeric)
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  select pr.currency, coalesce(sum(pr.amount), 0)::numeric
  from payment_requests pr
  where pr.org_id = auth_org()
    and pr.status in ('draft', 'pending_approval', 'approved', 'sent_for_execution')
  group by pr.currency
$$;

revoke all on function public.p2_active_payment_request_total_by_currency() from public, anon;
grant execute on function public.p2_active_payment_request_total_by_currency() to authenticated, service_role;

comment on function public.p2_active_payment_request_total_by_currency() is
  'Money committed on active payment requests, one row per currency (0024, per-currency since '
  '0219). No rows means nothing is committed, which the caller reports as a measured zero — the '
  'only figure that means the same thing in every currency.';

-- ===== 5. The business summary carries the unit of every number it reports =====
--
-- The contract was `(metric_key, value, measured)`, and three of its five metrics are counts while
-- one is money. A count is the same question in every currency; money is not. The row gains a
-- `currency`, null for the counts and set for the money, and the money metric returns ONE ROW PER
-- CURRENCY.
--
-- The function is renamed for the reason every reader in this campaign is renamed: `src/lib/
-- summary.ts:52` and the assistant's `get_business_summary` tool both read this by key, and a
-- second `expected_payments` row arriving under the same key would overwrite the first in whatever
-- map the reader builds — one of two currencies shown, with nothing anywhere to say so.
--
-- The `measured` flag and its per-metric exception handling are 0165's and are unchanged: a metric
-- that could not be read stays `measured = false` so the screen draws an em dash rather than a
-- zero it did not measure.
drop function if exists public.p2_business_summary_rows();

create function public.p2_business_summary_rows_by_currency()
returns table (metric_key text, currency text, value numeric, measured boolean)
language plpgsql
stable
set search_path to 'public', 'pg_temp'
as $$
declare
  -- The business day, not the server day: a browser in any timezone and this function must
  -- agree on what "today" means, and the product says Israel time (src/lib/format.ts).
  v_today constant date := (now() at time zone 'Asia/Jerusalem')::date;
  v_rows  integer;
begin
  -- 1. invoices received in the trailing 7 days
  begin
    return query select 'received_week'::text, null::text,
      (select count(*)
         from invoices i
        where i.org_id = auth_org()
          and i.financial_role = 'payable'
          and i.deleted_at is null
          and i.received_date >= v_today - 7)::numeric,
      true;
  exception when others then
    return query select 'received_week'::text, null::text, null::numeric, false;
  end;

  -- 2. invoices awaiting approval (see the header note on open decision #1)
  begin
    return query select 'awaiting_approval'::text, null::text,
      (select count(*)
         from invoices i
        where i.org_id = auth_org()
          and i.financial_role = 'payable'
          and i.deleted_at is null
          and i.review_status = 'pending_approval')::numeric,
      true;
  exception when others then
    return query select 'awaiting_approval'::text, null::text, null::numeric, false;
  end;

  -- 3. money committed on active payment requests -- 0024's definition, called, not copied.
  --    One row per currency. Nothing committed at all is a measured zero with no currency on it,
  --    because "no money is committed" is true in every currency at once.
  begin
    select count(*) into v_rows from public.p2_active_payment_request_total_by_currency();
    if v_rows = 0 then
      return query select 'expected_payments'::text, null::text, 0::numeric, true;
    else
      return query select 'expected_payments'::text, committed.currency, committed.total, true
      from public.p2_active_payment_request_total_by_currency() committed;
    end if;
  exception when others then
    return query select 'expected_payments'::text, null::text, null::numeric, false;
  end;

  -- 4. distinct suppliers who raised a catalogue price in the trailing 30 days -- 0024's
  --    definition, called, not copied
  begin
    return query select 'suppliers_raised'::text, null::text,
      public.p2_suppliers_with_price_increase_since(v_today - 30)::numeric,
      true;
  exception when others then
    return query select 'suppliers_raised'::text, null::text, null::numeric, false;
  end;

  -- 5. exceptions still needing a decision
  begin
    return query select 'open_exceptions'::text, null::text,
      (select count(*)
         from exceptions x
        where x.org_id = auth_org()
          and x.status in ('open', 'in_progress'))::numeric,
      true;
  exception when others then
    return query select 'open_exceptions'::text, null::text, null::numeric, false;
  end;
end
$$;

revoke all on function public.p2_business_summary_rows_by_currency() from public, anon;
grant execute on function public.p2_business_summary_rows_by_currency() to authenticated, service_role;

comment on function public.p2_business_summary_rows_by_currency() is
  'The five business-summary metrics (0165, per-currency since 0219). `currency` is null for a '
  'count and set for money, and the money metric returns one row per currency. Replaces '
  'p2_business_summary_rows(), whose single expected_payments row could only carry one of two '
  'currencies.';

-- ===== 6. A payment request may not be raised against invoices in two currencies =====
--
-- This function sums `greatest(balance, 0)` over an arbitrary SET of invoices the caller names and
-- compares that total to the amount being requested. Across two currencies the total is the false
-- number, and the comparison against it is worse than useless — it would pass or fail for reasons
-- nobody could read off the screen.
--
-- The answer is not to split the total. A payment request pays ONE supplier ONE amount, and 0217
-- gives it one `currency`; a request covering a shekel invoice and a dollar invoice is not a
-- request that needs a per-currency view, it is a request that cannot exist. So the set is
-- refused, with its own error code rather than the generic mismatch, because "you mixed
-- currencies" is something a person can act on and "checks mismatch" is not.
--
-- THE ± 1 TOLERANCE WAS A SHEKEL BY ACCIDENT. It is a bare literal in this body — never a setting
-- — and it meant "within one shekel" only because there was nothing else it could mean. Under
-- #288 it is read per currency, ILS keeps the 1 it has always had, and a currency nobody has
-- configured returns NULL: the signal becomes unknown rather than silently comparing dollars
-- against a shekel-sized window. `open_credit_total` splits per currency and is renamed with it,
-- because a dollar credit cannot offset a shekel request and adding the two states that it can.
--
-- Everything else is restated verbatim from the live body: this is SECURITY DEFINER, it carries an
-- `assert_unit` enforcement row, and a partial replacement is how a security property gets dropped
-- in silence.
create or replace function public.payment_request_financial_check_signals(
  p_supplier_id uuid,
  p_amount numeric,
  p_invoice_ids uuid[],
  p_payment_request_id uuid default null::uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_org uuid := auth_org();
  v_role user_role := auth_role();
  v_request public.payment_requests;
  v_requested_count int;
  v_visible_count int;
  v_unit_count int;
  v_unit uuid;
  v_paid_count int;
  v_unapproved_count int;
  v_open_balance numeric;
  v_currency_count int;
  v_currency text;
  v_tolerance numeric;
  v_open_credit_total jsonb;
  v_over_allocated_count int := 0;
begin
  if v_org is null or auth.uid() is null or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_supplier_id is null or p_amount is null or p_amount <= 0
     or p_invoice_ids is null or cardinality(p_invoice_ids) = 0
     or array_position(p_invoice_ids, null) is not null then
    raise exception 'payment_request_checks_invalid' using errcode = '22023';
  end if;

  select count(*) into v_requested_count
  from (select distinct unnest(p_invoice_ids) as id) requested;

  with requested as (
    select distinct unnest(p_invoice_ids) as id
  ), visible as (
    select i.id, i.unit_id, i.review_status, i.currency,
           i.total_amount
           - coalesce((select sum(pa.amount) from public.payment_allocations pa
                       where pa.org_id = v_org and pa.invoice_id = i.id), 0)
           - coalesce((select sum(pa.amount) from public.payment_allocations pa
                       join public.credit_requests cr
                         on cr.org_id = pa.org_id and cr.id = pa.credit_id
                       where cr.org_id = v_org and cr.invoice_id = i.id), 0) as balance
    from requested r
    join public.invoices i on i.id = r.id
    join public.org_units u
      on u.org_id = i.org_id and u.id = i.unit_id and u.unit_type = 'legal_entity'
    where i.org_id = v_org and i.supplier_id = p_supplier_id and i.deleted_at is null
  )
  select count(*), count(distinct unit_id), min(unit_id::text)::uuid,
         count(*) filter (where balance <= 0),
         count(*) filter (where review_status <> 'approved'),
         coalesce(sum(greatest(balance, 0)), 0),
         count(distinct currency), min(currency)
    into v_visible_count, v_unit_count, v_unit,
         v_paid_count, v_unapproved_count, v_open_balance,
         v_currency_count, v_currency
  from visible;

  if v_visible_count <> v_requested_count or v_unit_count <> 1 or v_unit is null then
    -- 22023 is the 0034 contract for this rejection; the P1 suite and error handling pin it.
    raise exception 'payment_request_checks_mismatch' using errcode = '22023';
  end if;
  -- 0219: its own code, because "these invoices are in two currencies" is something a person can
  -- act on, and the generic mismatch is not.
  if v_currency_count <> 1 then
    raise exception 'payment_request_checks_currency_mismatch' using errcode = '22023';
  end if;
  perform public.assert_unit_in_scope(v_unit);

  if p_payment_request_id is not null then
    select * into v_request
    from public.payment_requests pr
    where pr.id = p_payment_request_id and pr.org_id = v_org;

    if not found then
      raise exception 'payment_request_unknown' using errcode = 'P0002';
    end if;
    if v_request.unit_id is null then
      raise exception 'payment_request_scope_unresolved' using errcode = 'P0001';
    end if;
    perform public.assert_unit_in_scope(v_request.unit_id);

    if v_request.currency is distinct from v_currency then
      raise exception 'payment_request_checks_currency_mismatch' using errcode = '22023';
    end if;

    if v_request.supplier_id is distinct from p_supplier_id
       or round(v_request.amount, 2) <> round(p_amount, 2)
       or v_request.unit_id is distinct from v_unit
       or exists (
         select 1
         from public.payment_request_invoices pri
         where pri.org_id = v_org and pri.payment_request_id = v_request.id
           and not (pri.invoice_id = any(p_invoice_ids))
       )
       or exists (
         select 1
         from unnest(p_invoice_ids) as requested(requested_id)
         where not exists (
           select 1
           from public.payment_request_invoices pri
           where pri.org_id = v_org
             and pri.payment_request_id = v_request.id
             and pri.invoice_id = requested.requested_id
         )
       ) then
      -- 22023 is the 0034 contract for this rejection; the P1 suite and error handling pin it.
      raise exception 'payment_request_checks_mismatch' using errcode = '22023';
    end if;

    -- 0146: the allocation this request was born with, measured against the balance that is left
    -- now. An offset or closed credit reduces that balance after the fact, and from then on both
    -- approval (0073:650-656) and execution (0031:678-691) reject the request with no way to
    -- repair it. Return a COUNT only -- office must learn that the allocation no longer fits
    -- without learning any balance (the 0034 anti-oracle). The comparison below is the same
    -- expression the approval command enforces, so the warning and the rejection cannot diverge.
    select count(*) into v_over_allocated_count
    from public.payment_request_invoices pri
    join public.invoices i on i.org_id = pri.org_id and i.id = pri.invoice_id
    where pri.org_id = v_org
      and pri.payment_request_id = v_request.id
      and round(pri.amount_allocated, 2) > round(
        i.total_amount
        - coalesce((select sum(pa.amount) from public.payment_allocations pa
                    where pa.org_id = v_org and pa.invoice_id = i.id), 0)
        - coalesce((select sum(pa.amount) from public.payment_allocations pa
                    join public.credit_requests cr
                      on cr.org_id = pa.org_id and cr.id = pa.credit_id
                    where cr.org_id = v_org and cr.invoice_id = i.id), 0),
        2
      );
  end if;

  if exists (
    select 1
    from public.credit_requests cr
    where cr.org_id = v_org
      and cr.supplier_id = p_supplier_id
      and cr.status in ('open', 'requested', 'received')
      and private.credit_request_legal_entity(cr.id, cr.org_id) is null
  ) then
    raise exception 'payment_request_credit_scope_unresolved' using errcode = 'P0001';
  end if;

  -- Every currency the supplier has an open credit in stays visible: the approval guard (0073)
  -- still considers all of them, and a signal that showed only the request's currency would
  -- diverge from the rejection it exists to warn about. What it no longer does is add them.
  select coalesce(jsonb_agg(jsonb_build_object('currency', remaining.currency, 'amount', remaining.amount)
           order by remaining.currency), '[]'::jsonb)
    into v_open_credit_total
  from (
    select cr.currency,
           coalesce(sum(greatest(cr.amount - coalesce((
             select sum(applied.amount)
             from public.payment_allocations applied
             where applied.org_id = cr.org_id and applied.credit_id = cr.id
           ), 0), 0)), 0)::numeric(14,3) as amount
    from public.credit_requests cr
    where cr.org_id = v_org
      and cr.supplier_id = p_supplier_id
      and cr.status in ('open', 'requested', 'received')
      and private.credit_request_legal_entity(cr.id, cr.org_id) = v_unit
    group by cr.currency
  ) remaining;

  -- #288. The literal 1 stays the ILS answer because that is the window this check has always
  -- used; it is not a default invented for other currencies, and there is deliberately none.
  v_tolerance := coalesce(
    private.money_tolerance(v_org, v_currency, 'payment_request_amount_tolerance'),
    case when v_currency = 'ILS' then 1 end);

  return jsonb_build_object(
    'requested_invoice_count', v_requested_count,
    'visible_invoice_count', v_visible_count,
    'paid_invoice_count', v_paid_count,
    'unapproved_invoice_count', v_unapproved_count,
    'currency', v_currency,
    -- The 0034 anti-oracle, preserved through this rewrite: office can approve against
    -- invoice status, but cannot probe hidden balances by varying p_amount. Only the
    -- balance-reading role receives the real comparison; office reads a constant.
    --
    -- 0219: null, not false, when this organisation has stated no tolerance for this currency.
    -- False would say "the amount does not match"; null says "nobody has decided what matching
    -- means here", and the screen already has a dash for that.
    'amount_matches_open_balance', case
      when v_role <> 'owner' then to_jsonb(true)
      when v_tolerance is null then 'null'::jsonb
      else to_jsonb(abs(round(v_open_balance, 2) - round(p_amount, 2)) <= v_tolerance)
    end,
    -- bank_imports is not legal-entity scoped yet. Returning an organization-wide existence
    -- bit would leak sibling activity, so 0073 reports an explicit unavailable state and makes
    -- no bank query or approval decision from substitute data.
    'similar_bank_transfer_check', 'unavailable',
    'open_credit_total_by_currency', v_open_credit_total,
    'over_allocated_invoice_count', v_over_allocated_count
  );
end
$$;

-- The body changed, so A5's pinned hash has to be recomputed here or every later migration fails
-- with "stale scope enforcement registration". Computed from pg_proc, never written as a literal.
update private.scope_definer_enforcements enforcement
set body_hash = md5(replace(proc.prosrc, e'\r', '')),
    scope_proof = '0219 keeps 0073/0146 single-legal-entity assertion and the 0034 anti-oracle '
      || 'unchanged, refuses an invoice set spanning two currencies, and reports the open credit '
      || 'per currency instead of as one sum.'
from pg_catalog.pg_proc proc
where proc.oid = pg_catalog.to_regprocedure(
        'public.payment_request_financial_check_signals(uuid,numeric,uuid[],uuid)')
  and enforcement.function_signature = 'payment_request_financial_check_signals(uuid,numeric,uuid[],uuid)';

-- ===== 7. Proof =====
do $assert_0219$
declare
  v_violations text;
  v_count      integer;
  v_probe      uuid;
begin
  -- The two identity keys exist.
  select count(*) into v_count from pg_constraint
   where conname in ('credit_requests_invoice_currency_fk', 'payments_request_currency_fk');
  if v_count <> 2 then
    raise exception '0219: % of the 2 identity keys exist', v_count;
  end if;

  -- A credit note cannot be issued against an invoice in another currency.
  select id into v_probe from credit_requests where invoice_id is not null limit 1;
  if v_probe is not null then
    begin
      update credit_requests set currency = 'USD' where id = v_probe;
      raise exception '0219: a credit changed currency while its invoice did not';
    exception
      when foreign_key_violation then null;
    end;
  end if;

  -- The old reader names are gone.
  if to_regprocedure('public.p2_active_payment_request_total()') is not null
     or to_regprocedure('public.p2_business_summary_rows()') is not null then
    raise exception '0219: an old summary reader is still callable';
  end if;
  if to_regprocedure('public.p2_active_payment_request_total_by_currency()') is null
     or to_regprocedure('public.p2_business_summary_rows_by_currency()') is null then
    raise exception '0219: a by-currency summary reader is missing';
  end if;

  -- The tolerance helper invents nothing for an organisation that has stated nothing.
  if private.money_tolerance('00000000-0000-0000-0000-000000000000'::uuid, 'USD', 'nope') is not null then
    raise exception '0219: money_tolerance answered for an organisation that does not exist';
  end if;

  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0219 scope assertions failed:\n%', v_violations;
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0219 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0219$;
