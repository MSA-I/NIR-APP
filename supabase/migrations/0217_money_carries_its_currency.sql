-- 0217: every amount of money in this schema starts carrying the currency it is in.
--
-- THE DECISION THIS IMPLEMENTS. OPEN-DECISIONS #277 (28.08.2026, owner, superseding #14): InPlace
-- will really work in dollars — not a converted display and not a swapped symbol. A supplier who
-- issues a dollar invoice has that invoice received in dollars, stored in dollars, paid in dollars,
-- and their dollar balance managed SEPARATELY from their shekel balance. #284 widened it from two
-- currencies to every ISO one; #285, #286, #288 and #289 settled tax, settlement, tolerances and
-- bank accounts. `docs/PLAN-multi-currency-20260828.md` is the plan; `GATES.md` holds the gates.
--
-- THE RULE EVERYTHING HERE SERVES. A screen that adds ₪12,400 and $3,100 into one number shows a
-- false number on a screen decisions are made from — the direct breach of the constitution's
-- clause 12. A sum is only defined inside one currency. This migration is the half of that rule
-- the database can enforce; phases 2 and 3 are the half the readers and the client must.
--
-- WHY THE BACKFILL TO 'ILS' IS NOT A GUESS, and this is the load-bearing argument for `not null`.
-- Two measured facts, not one assumption: (a) `0001_init.sql:2` declares "All monetary values in
-- ILS (₪)"; (b) `0108:228-233` has, since it was written, REFUSED any document printing another
-- currency — `currency_not_ils`, severity `error`, approval blocked. There is not one row in this
-- schema that could have arrived in another currency. Stamping the existing rows `ILS` records
-- what a live guard already enforced. An amount whose currency is unknown is exactly the
-- unit-less number the rule above forbids, which is why the column may not be null.
--
-- WHY EVERY NEW COLUMN CARRIES `default 'ILS'` AND NO STATEMENT UPDATES A ROW. Postgres 11 and
-- later store a non-null default as table metadata, so `add column … not null default` rewrites
-- nothing and fires no row trigger. That matters here beyond speed: `p1_financial_command_guard`,
-- `zz_organization_write_guard` and the tenant-identity guards sit on almost every table below,
-- and a backfill UPDATE would have to be argued past all of them. Nothing here writes a row.
--
-- The default is DELIBERATELY TEMPORARY on the intake path. It keeps phases 1 through 3 running
-- against writers that do not yet name a currency — which is honest, because until phase 4 opens
-- `0108` no writer CAN produce anything but a shekel. Phase 4 drops the default from `invoices`
-- at the moment `apply_reviewed_document` starts supplying the value, so that a currency nobody
-- stated becomes a failure rather than a shekel. That is recorded in GATES.md, not left to memory.
--
-- WHAT THIS FILE DOES NOT DO. It converts nothing and fetches no exchange rate — an external rate
-- source is a trust-boundary expansion of the same kind as DEBT §63 and needs its own owner
-- decision and DPA (plan §4.7). It does not touch evidence: `document_extractions`,
-- `document_interpretations`, `audit_logs`, signed snapshots, the portal's `order_snapshot` and
-- `bank_transactions.raw` are read, never rewritten, and their currency is decided by whoever
-- reads the interpretation behind them (plan §3.3). It changes no function body: the balance
-- readers are phase 2 and the intake guard is phase 4, and opening `0108` before there is a column
-- to write into is the "we will fix it as we go" failure the phase order exists to prevent.

-- ===== 1. The reference table: every ISO currency, not a list somebody has to reopen =====
--
-- A table and not `check (currency in (…))`, for the lesson `user_role` taught: 77 RLS policies
-- depend on that one enum, and widening it is a migration that touches a type. A reference table
-- opens with an INSERT. And a table rather than a bare text column, because `minor_units` is a
-- fact the writers need: rounding "always to 2" is wrong for JPY, which has none, and for KWD,
-- BHD, OMR, IQD, JOD, LYD and TND, which have three.
--
-- NO `org_id`, and that is a documented exception rather than a lapse. ISO-4217 is not a tenant's
-- data — it is the same list for every organisation on the platform, exactly like
-- `subscription_plans` and `plan_price_catalogues` (0184), which also carry none. It is readable
-- by every signed-in reader because a screen that renders an amount has to know how the currency
-- is spelled, and writable only by `service_role`: nothing in a browser may invent a currency.
create table currencies (
  code        text primary key check (code ~ '^[A-Z]{3}$'),
  -- The digits after the decimal separator, from ISO-4217. Capped at 3 because every money column
  -- below is `numeric(14,3)`: CLF and UYW carry four, but they are accounting units of measure
  -- rather than currencies anything is invoiced in, and admitting them would silently truncate.
  minor_units smallint not null check (minor_units between 0 and 3),
  -- A currency that is no longer issued stays in the table: an invoice recorded in it is still
  -- evidence of what was printed. `active` decides what a picker offers, never what a row may hold.
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

comment on table currencies is
  'ISO-4217 currency codes and their minor units (0217, OPEN-DECISIONS #284). Global reference '
  'data with no org_id, like subscription_plans and plan_price_catalogues — the same list for '
  'every tenant. minor_units is what rounding reads instead of a hard-coded 2; a JPY amount has '
  'no decimals and a KWD amount has three. Deactivating a code never invalidates a row already '
  'recorded in it, because that row is evidence of what a document printed.';
comment on column currencies.minor_units is
  'Digits after the decimal separator for this currency, per ISO-4217. Read by the write commands '
  'in place of "always 2"; capped at 3 because every money column is numeric(14,3).';

insert into currencies (code, minor_units) values
  ('AED',2),('AFN',2),('ALL',2),('AMD',2),('ANG',2),('AOA',2),('ARS',2),('AUD',2),('AWG',2),('AZN',2),
  ('BAM',2),('BBD',2),('BDT',2),('BGN',2),('BHD',3),('BIF',0),('BMD',2),('BND',2),('BOB',2),('BRL',2),
  ('BSD',2),('BTN',2),('BWP',2),('BYN',2),('BZD',2),
  ('CAD',2),('CDF',2),('CHF',2),('CLP',0),('CNY',2),('COP',2),('CRC',2),('CUP',2),('CVE',2),('CZK',2),
  ('DJF',0),('DKK',2),('DOP',2),('DZD',2),
  ('EGP',2),('ERN',2),('ETB',2),('EUR',2),
  ('FJD',2),('FKP',2),
  ('GBP',2),('GEL',2),('GHS',2),('GIP',2),('GMD',2),('GNF',0),('GTQ',2),('GYD',2),
  ('HKD',2),('HNL',2),('HTG',2),('HUF',2),
  ('IDR',2),('ILS',2),('INR',2),('IQD',3),('IRR',2),('ISK',0),
  ('JMD',2),('JOD',3),('JPY',0),
  ('KES',2),('KGS',2),('KHR',2),('KMF',0),('KPW',2),('KRW',0),('KWD',3),('KYD',2),('KZT',2),
  ('LAK',2),('LBP',2),('LKR',2),('LRD',2),('LSL',2),('LYD',3),
  ('MAD',2),('MDL',2),('MGA',2),('MKD',2),('MMK',2),('MNT',2),('MOP',2),('MRU',2),('MUR',2),('MVR',2),
  ('MWK',2),('MXN',2),('MYR',2),('MZN',2),
  ('NAD',2),('NGN',2),('NIO',2),('NOK',2),('NPR',2),('NZD',2),
  ('OMR',3),
  ('PAB',2),('PEN',2),('PGK',2),('PHP',2),('PKR',2),('PLN',2),('PYG',0),
  ('QAR',2),
  ('RON',2),('RSD',2),('RUB',2),('RWF',0),
  ('SAR',2),('SBD',2),('SCR',2),('SDG',2),('SEK',2),('SGD',2),('SHP',2),('SLE',2),('SOS',2),('SRD',2),
  ('SSP',2),('STN',2),('SVC',2),('SYP',2),('SZL',2),
  ('THB',2),('TJS',2),('TMT',2),('TND',3),('TOP',2),('TRY',2),('TTD',2),('TWD',2),('TZS',2),
  ('UAH',2),('UGX',0),('USD',2),('UYU',2),('UZS',2),
  ('VED',2),('VES',2),('VND',0),('VUV',0),
  ('WST',2),
  ('XAF',0),('XCD',2),('XCG',2),('XOF',0),('XPF',0),
  ('YER',2),
  ('ZAR',2),('ZMW',2),('ZWG',2);

alter table currencies enable row level security;

-- Readable by every signed-in reader; a browser may not write one. `anon` gets nothing: the login
-- screen renders no amounts, and the smallest surface that works is the right one.
revoke all on table currencies from public, anon, authenticated;
grant select on table currencies to authenticated;
create policy currencies_read on currencies for select to authenticated using (true);

-- A1: every public base table is classified. `system`, not enforced — it holds no tenant data and
-- therefore carries no unit scope, the same classification 0184 gave the plan catalogue.
insert into private.scope_registry (table_name, scope_class, enforced) values
  ('currencies', 'system', false);

-- ===== 2. The organisation's own currency and country (#285) =====
--
-- `base_currency` is NOT a display preference. It is the answer to "what currency does this
-- business keep its books in", which is what the accountant's workbook and every summary screen
-- need in order to know which currency to show first and which to treat as the exception.
--
-- `country_code` decides VAT (#285), and the wording of that decision was corrected when it was
-- recorded: the rate follows THE COUNTRY THE BUSINESS IS IN, not where the person reading the
-- screen happens to be. A bookkeeper who travels does not change the company's VAT. Signup will
-- propose it from the browser, exactly as it already proposes the language, and only an `owner`
-- may change it afterwards with a reason and an audit row — which is why no browser UPDATE grant
-- is added here. 'IL' for existing rows is the same measured argument as the ILS backfill: this
-- product shipped with an Israeli VAT rate and a shekel-only intake guard.
alter table organizations
  add column if not exists base_currency text not null default 'ILS' references currencies(code),
  add column if not exists country_code  text not null default 'IL' check (country_code ~ '^[A-Z]{2}$');

comment on column organizations.base_currency is
  'The currency this business keeps its books in (0217, #277). Decides which currency a summary '
  'shows first and which is the exception — never a conversion target, because nothing converts.';
comment on column organizations.country_code is
  'ISO-3166-1 alpha-2 country of the BUSINESS (0217, #285). Proposed from the browser at signup '
  'and changed only by an owner with a reason and an audit row. The VAT rate is derived from it, '
  'and 0099''s VAT-rate check applies only to a supplier in the same country.';

-- ===== 3. The supplier's default and country =====
--
-- `default_currency` is a default FOR A NEW DOCUMENT and never the truth about an existing one.
-- That distinction is the whole reason the currency lives on the money row rather than on the
-- supplier: if a document's currency were derived from the supplier at read time, editing the
-- supplier would retroactively change what every one of their invoices claims to say.
--
-- `country_code` is NULLABLE on purpose, and null is not a gap to be filled with a guess. Today
-- no supplier has a country at all, and every supplier is treated as domestic. Null preserves
-- exactly that: phase 4 resolves an absent value as the supplier's bank-account country
-- (`supplier_bank_accounts.country_code`, 0171) and failing that the organisation's own. Resolving
-- on READ keeps it correct when the bank account changes; a copy frozen here would not.
alter table suppliers
  add column if not exists default_currency text not null default 'ILS' references currencies(code),
  add column if not exists country_code     text check (country_code ~ '^[A-Z]{2}$');

comment on column suppliers.default_currency is
  'The currency a NEW document for this supplier starts in (0217, #277), and the currency '
  'min_order_amount is stated in. Never the currency of a document already recorded — that lives '
  'on the document''s own row and does not move. A second column for the minimum order was '
  'considered and rejected: a supplier quotes their minimum in the currency they trade in, and '
  'two columns holding one fact is two columns that can disagree.';
comment on column suppliers.country_code is
  'ISO-3166-1 alpha-2 country of the supplier (0217, #285), or null for "nobody has said". Null '
  'resolves to the bank account''s country and then to the organisation''s, on read. A supplier '
  'whose country differs from the organisation''s is foreign, and 0099 records their document as '
  'printed instead of flagging a local VAT rate it was never supposed to carry.';

-- ===== 4. The money rows =====
--
-- Three levels, and which one a table sits at is the whole design (plan §2):
--
--   HEAD OF A DOCUMENT OR TRANSACTION — invoices, payments, payment_requests, credit_requests,
--     purchase_orders, purchase_requests, bank_imports — gets its own `currency`. This is the
--     thing that was printed, or that happened, in one currency.
--   A LINE UNDER A HEAD — invoice_lines, purchase_order_items, purchase_request_items,
--     supplier_order_proposal_lines — gets NOTHING. A document is not printed in two currencies,
--     and a column here would create a state the business does not have while doubling the surface
--     every guard has to cover.
--   A PRICE LIST OR A THRESHOLD — supplier_products, price_history, suppliers.min_order_amount,
--     approval_policy_configurations.threshold_amount — gets its own, because a supplier quotes in
--     dollars before any invoice exists, and comparing an amount to a threshold in another
--     currency is the same false comparison as adding them.
--   AN ALLOCATION BETWEEN TWO MONEY ROWS — section 6.
alter table invoices          add column if not exists currency text not null default 'ILS' references currencies(code);
alter table payments          add column if not exists currency text not null default 'ILS' references currencies(code);
alter table payment_requests  add column if not exists currency text not null default 'ILS' references currencies(code);
alter table credit_requests   add column if not exists currency text not null default 'ILS' references currencies(code);
alter table purchase_orders   add column if not exists currency text not null default 'ILS' references currencies(code);
alter table purchase_requests add column if not exists currency text not null default 'ILS' references currencies(code);
alter table bank_imports      add column if not exists currency text not null default 'ILS' references currencies(code);
alter table supplier_products add column if not exists currency text not null default 'ILS' references currencies(code);
alter table price_history     add column if not exists currency text not null default 'ILS' references currencies(code);
alter table approval_policy_configurations
  add column if not exists currency text not null default 'ILS' references currencies(code);

comment on column invoices.currency is
  'The currency this invoice was PRINTED in (0217, #277). Evidence, not a preference: it is set '
  'from the recomputed server-side assessment of the document and never from a client payload.';
comment on column payments.currency is
  'The currency of the debt this payment discharged (0217, #277) — what was paid off, which is '
  'not always what left the bank account. See settlement_amount below (#286).';
comment on column bank_imports.currency is
  'The currency of the STATEMENT (0217, plan §4.5). A statement is a document of one account, so '
  'the currency belongs to the import and every transaction in it inherits it by foreign key.';

-- `bank_transactions` is a line under `bank_imports` and by the rule above would carry no column
-- at all. It carries one anyway, and this is the single documented exception:
-- `bank_allocations` has to be prevented from linking a shekel line to a dollar payment, and that
-- prevention is a composite foreign key, which needs a column on this side to point from. The
-- column is not a second truth — section 6 locks it to the import's currency with a foreign key,
-- so a transaction whose currency differs from its statement is unrepresentable, not merely wrong.
alter table bank_transactions add column if not exists currency text not null default 'ILS' references currencies(code);
comment on column bank_transactions.currency is
  'The statement''s currency, mirrored onto the line (0217). Locked to bank_imports.currency by a '
  'composite foreign key: it cannot diverge. It exists so bank_allocations can carry a '
  'cross-currency-proof key, not because a line may differ from its statement.';

-- ===== 5. Two read models have to step aside while the columns widen =====
--
-- `alter column … type` refuses while a view reads the column: `inventory_intelligence` (0102)
-- reads `supplier_products.current_price` and `purchase_order_items.unit_price`, and
-- `supplier_metrics` (last written by 0204) reads `credit_requests.amount`,
-- `payment_allocations.amount` and `price_history.price`. Nothing else in the schema depends on
-- either, and neither of them is depended upon.
--
-- They are captured, dropped and rebuilt FROM WHAT THE DATABASE HOLDS, not from a definition
-- restated here. Restating a 60-line view body in a migration that has no business changing it is
-- how a clause goes missing in silence — the same lesson `check:anchored-replacements` encodes for
-- function bodies. `pg_get_viewdef` is the authority; the storage options, the grants and the
-- comment are captured beside it and put back.
create temp table v0217_view_snapshot as
select c.relname::text                       as view_name,
       rtrim(pg_get_viewdef(c.oid, true), E' \n;') as definition,
       array_to_string(c.reloptions, ', ')   as options,
       obj_description(c.oid, 'pg_class')    as description
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'v'
  and c.relname in ('supplier_metrics', 'inventory_intelligence');

create temp table v0217_view_grants as
select c.relname::text as view_name, acl.grantee::regrole::text as role_name, acl.privilege_type
from pg_class c
join pg_namespace n on n.oid = c.relnamespace,
lateral aclexplode(c.relacl) acl
where n.nspname = 'public' and c.relkind = 'v'
  and c.relname in ('supplier_metrics', 'inventory_intelligence');

do $snapshot_taken$
begin
  if (select count(*) from v0217_view_snapshot) <> 2 then
    raise exception '0217: expected to capture 2 read models before widening, captured %',
      (select count(*) from v0217_view_snapshot);
  end if;
end
$snapshot_taken$;

drop view public.inventory_intelligence;
drop view public.supplier_metrics;

-- ===== 6. Three decimals, because two is a shekel-shaped assumption (#284) =====
--
-- `numeric(12,2)` says "money has two decimals". JPY has none and KWD has three, so the scale has
-- to be the widest any currency needs rather than the one this product started with. Precision 14
-- with scale 3 holds eleven integer digits — 99,999,999,999.999 — which is more than any invoice
-- this system will see and does not narrow the two columns that were already `numeric(14,2)`
-- beyond a range no amount here approaches.
--
-- NOT widened, and each for a stated reason: `invoice_lines.unit_price numeric(18,6)` already
-- holds six decimals, so 14,3 would be a narrowing; the price-list evidence columns are bare
-- `numeric` with unlimited precision and are evidence besides; `plan_prices.amount` and
-- `organization_billing_periods.amount` are subscription money already restricted to ILS and USD
-- by 0184's own constraint, both of which have exactly two.
alter table suppliers                     alter column min_order_amount type numeric(14,3);
alter table supplier_products             alter column current_price    type numeric(14,3);
alter table supplier_products             alter column previous_price   type numeric(14,3);
alter table price_history                 alter column price            type numeric(14,3);
alter table purchase_requests             alter column split_total            type numeric(14,3);
alter table purchase_requests             alter column single_supplier_total  type numeric(14,3);
alter table purchase_requests             alter column savings_amount         type numeric(14,3);
alter table purchase_request_items        alter column unit_price       type numeric(14,3);
alter table purchase_order_items          alter column unit_price       type numeric(14,3);
alter table invoices                      alter column amount_before_vat type numeric(14,3);
alter table invoices                      alter column vat_amount        type numeric(14,3);
alter table invoices                      alter column total_amount      type numeric(14,3);
alter table invoice_lines                 alter column discount_amount   type numeric(14,3);
alter table invoice_lines                 alter column line_total        type numeric(14,3);
alter table credit_requests               alter column amount           type numeric(14,3);
alter table payment_requests              alter column amount           type numeric(14,3);
alter table payment_requests              alter column open_credit_override_total type numeric(14,3);
alter table payment_request_invoices      alter column amount_allocated type numeric(14,3);
alter table payments                      alter column amount           type numeric(14,3);
alter table payment_allocations           alter column amount           type numeric(14,3);
alter table bank_transactions             alter column amount           type numeric(14,3);
alter table bank_allocations              alter column amount           type numeric(14,3);
alter table approval_policy_configurations alter column threshold_amount type numeric(14,3);
alter table supplier_order_proposals      alter column total_delta      type numeric(14,3);
alter table supplier_order_proposal_lines alter column original_unit_price type numeric(14,3);
alter table supplier_order_proposal_lines alter column proposed_unit_price type numeric(14,3);
alter table supplier_order_proposal_lines alter column line_delta       type numeric(14,3);

-- ===== 7. The two read models come back exactly as they were =====
do $rebuild_views$
declare
  v record;
begin
  for v in select * from v0217_view_snapshot order by view_name loop
    execute format('create view public.%I with (%s) as %s', v.view_name, v.options, v.definition);
    if v.description is not null then
      execute format('comment on view public.%I is %L', v.view_name, v.description);
    end if;
  end loop;

  -- The owner's own privileges come back with the object; only the granted ones need restoring.
  for v in select * from v0217_view_grants where role_name <> current_user order by view_name, role_name, privilege_type loop
    execute format('grant %s on public.%I to %I', v.privilege_type, v.view_name, v.role_name);
  end loop;
end
$rebuild_views$;

drop table v0217_view_snapshot;
drop table v0217_view_grants;

-- ===== 8. An allocation cannot cross currencies, because it cannot be written =====
--
-- An allocation does not have an amount of its own in the world: it LINKS two amounts. If the two
-- are in different currencies the link is a conversion, and there is no conversion here (§4.7).
--
-- The mechanism is a key, not a trigger, and the difference matters. A trigger is code that has to
-- run, can be disabled, and can be reasoned around; a composite foreign key makes the row
-- unrepresentable. The pattern is the one this schema already uses for tenancy — `(org_id, x_id)`
-- referencing `(org_id, id)` — with the currency added to both sides.
--
-- The nullable-column halves rely on MATCH SIMPLE, which is Postgres's default and exactly the
-- semantics wanted: a `payment_allocations` row that offsets a credit has `invoice_id` null, and
-- the invoice-side key is then not checked at all rather than being checked against nothing.
alter table invoices           add constraint p0_invoices_org_id_currency_key           unique (org_id, id, currency);
alter table payments           add constraint p0_payments_org_id_currency_key           unique (org_id, id, currency);
alter table payment_requests   add constraint p0_payment_requests_org_id_currency_key   unique (org_id, id, currency);
alter table credit_requests    add constraint p0_credit_requests_org_id_currency_key    unique (org_id, id, currency);
alter table bank_imports       add constraint p0_bank_imports_org_id_currency_key       unique (org_id, id, currency);
alter table bank_transactions  add constraint p0_bank_transactions_org_id_currency_key  unique (org_id, id, currency);

-- The mirrored line currency of section 4, locked to its statement.
alter table bank_transactions
  add constraint bank_transactions_import_currency_fk
  foreign key (org_id, import_id, currency) references bank_imports (org_id, id, currency)
  on delete cascade;

alter table payment_allocations
  add column if not exists currency text not null default 'ILS';
alter table payment_allocations
  add constraint payment_allocations_payment_currency_fk
    foreign key (org_id, payment_id, currency) references payments (org_id, id, currency)
    on delete restrict,
  add constraint payment_allocations_invoice_currency_fk
    foreign key (org_id, invoice_id, currency) references invoices (org_id, id, currency),
  add constraint payment_allocations_credit_currency_fk
    foreign key (org_id, credit_id, currency) references credit_requests (org_id, id, currency);

alter table payment_request_invoices
  add column if not exists currency text not null default 'ILS';
alter table payment_request_invoices
  add constraint payment_request_invoices_request_currency_fk
    foreign key (org_id, payment_request_id, currency) references payment_requests (org_id, id, currency)
    on delete cascade,
  add constraint payment_request_invoices_invoice_currency_fk
    foreign key (org_id, invoice_id, currency) references invoices (org_id, id, currency);

alter table bank_allocations
  add column if not exists currency text not null default 'ILS';
alter table bank_allocations
  add constraint bank_allocations_transaction_currency_fk
    foreign key (org_id, bank_transaction_id, currency) references bank_transactions (org_id, id, currency)
    on delete cascade,
  add constraint bank_allocations_invoice_currency_fk
    foreign key (org_id, invoice_id, currency) references invoices (org_id, id, currency),
  add constraint bank_allocations_payment_currency_fk
    foreign key (org_id, payment_id, currency) references payments (org_id, id, currency)
    on delete restrict;

comment on column payment_allocations.currency is
  'Not a third truth — the key that makes a cross-currency allocation unrepresentable (0217, '
  'plan §4.1). Composite foreign keys tie it to the payment''s currency and to the invoice''s or '
  'the credit''s at once, so the three cannot disagree.';

-- ===== 9. Paying a dollar invoice from a shekel account (#286) =====
--
-- The owner allowed it, and the whole of the honesty is in keeping the two numbers apart.
-- `amount` + `currency` stay WHAT WAS DISCHARGED — $3,100 — so the allocation stays in dollars and
-- the dollar balance closes in dollars, which is the rule of §3 unbroken. `settlement_*` are WHAT
-- LEFT THE ACCOUNT — ₪11,470 — and they are what a shekel bank line is matched against.
--
-- Both are null in the ordinary case, which is every payment this system has ever recorded: the
-- Israeli business paying a shekel invoice from a shekel account does not touch them.
--
-- THERE IS NO `rate` COLUMN, deliberately. The rate is `settlement_amount / amount`, derived on
-- read from two figures a person can see on two documents. A stored third number can go stale, be
-- corrected on its own, and contradict the two facts it came from — and no external rate source is
-- consulted, here or anywhere, because that is a trust-boundary expansion (plan §4.7).
alter table payments
  add column if not exists settlement_amount   numeric(14,3),
  add column if not exists settlement_currency text references currencies(code);

alter table payments
  add constraint payments_settlement_pair check ((settlement_amount is null) = (settlement_currency is null)),
  add constraint payments_settlement_positive check (settlement_amount is null or settlement_amount > 0),
  -- Same currency on both sides means nothing was settled across a currency, and the pair should
  -- have stayed null. Allowing it would create two spellings of the ordinary payment.
  add constraint payments_settlement_differs check (settlement_currency is null or settlement_currency <> currency);

comment on column payments.settlement_amount is
  'What actually left the bank account, when that was in a different currency from the debt '
  '(0217, #286). Null for every payment made in the currency of its own debt. The exchange rate '
  'is settlement_amount / amount, derived on read and stored nowhere.';

-- ===== 10. Column grants — the step 0213 skipped =====
--
-- Almost every table above carries a TABLE-level SELECT grant for `authenticated`, so its new
-- columns are readable the moment they exist. `suppliers` is the exception: 0112 moved
-- `bank_details` out of reach through a COLUMN-level grant, which means every column on that table
-- is now granted one at a time and a new one is invisible until it is named.
grant select (default_currency, country_code) on suppliers to authenticated;
-- The supplier form is an allow-listed direct write (0036), and both of these are things a person
-- STATES about a supplier rather than things a command derives.
grant insert (default_currency, country_code) on suppliers to authenticated;
grant update (default_currency, country_code) on suppliers to authenticated;

-- NOT granted, and each is a decision: no UPDATE on `invoices.currency` (an invoice's currency is
-- evidence of what was printed and is written only by the server command that recomputes the
-- assessment); no UPDATE on `organizations.country_code` or `base_currency` (#285 routes both
-- through an owner action with a reason and an audit row, which is a command, not a form); and
-- nothing at all for `anon`, which renders no amounts.

-- ===== 11. A6: the tenant export registry stops describing a schema that moved =====
-- Every table above that carries `org_id` just changed shape, so every stored `schema_hash` is
-- stale. Rehashing all of them is one statement with nothing to keep in sync, which is why it is
-- preferred here to naming the twenty that changed. `currencies` gets no registry row on purpose:
-- it has no `org_id`, and the registry's own staleness arm treats a row for such a table as a
-- violation.
update private.tenant_export_registry registry
set exported_columns = case when registry.disposition = 'exclude' then '{}'::text[] else (
      select array_agg(column_info.column_name order by column_info.ordinal_position)
      from information_schema.columns column_info
      where column_info.table_schema = 'public' and column_info.table_name = registry.table_name
        and not (column_info.column_name = any(registry.excluded_columns))
    ) end,
    schema_hash = (
      select md5(string_agg(
        column_info.column_name || ':' || column_info.data_type || ':' || column_info.is_nullable,
        '|' order by column_info.ordinal_position))
      from information_schema.columns column_info
      where column_info.table_schema = 'public' and column_info.table_name = registry.table_name
    );

-- ===== 12. Proof =====
do $assert_0217$
declare
  v_violations text;
  v_count      integer;
  v_probe      uuid;
begin
  -- The reference table is seeded, and the three shapes the rounding rule depends on are all in it.
  select count(*) into v_count from currencies;
  if v_count < 150 then
    raise exception '0217: currencies holds only % rows; the ISO seed did not load', v_count;
  end if;
  if (select minor_units from currencies where code = 'ILS') <> 2
     or (select minor_units from currencies where code = 'JPY') <> 0
     or (select minor_units from currencies where code = 'KWD') <> 3 then
    raise exception '0217: minor_units is wrong for one of ILS/JPY/KWD';
  end if;

  -- Every money row carries a currency, and none of them was guessed into something other than the
  -- shekel that 0108 has been the only possible value for.
  select count(*) into v_count from invoices where currency is null;
  if v_count <> 0 then raise exception '0217: % invoice(s) have a null currency', v_count; end if;
  select count(*) into v_count from invoices where currency <> 'ILS';
  if v_count <> 0 then
    raise exception '0217: % invoice(s) are not ILS immediately after the backfill', v_count;
  end if;

  -- A currency the reference table does not hold cannot be written. Probed on `organizations`
  -- rather than on an invoice: an invoice's currency is referenced by its allocations, so an
  -- invoice probe is refused by the WRONG key and would prove the wrong thing. Nothing points at
  -- `organizations.base_currency`, so the only constraint that can refuse it is the one to
  -- `currencies`. The sub-transaction undoes the write whether it is refused or wrongly accepted.
  select id into v_probe from organizations limit 1;
  if v_probe is not null then
    begin
      update organizations set base_currency = 'XQZ' where id = v_probe;
      raise exception '0217: an unknown currency was accepted by organizations.base_currency';
    exception
      when foreign_key_violation then null;
    end;
  end if;

  -- A cross-currency allocation is not rejected — it cannot be expressed. The probe INSERTS one
  -- rather than flipping a payment, because an insert is the shape the defect would actually take:
  -- somebody allocating a dollar figure against a shekel payment.
  select payment_id into v_probe from payment_allocations limit 1;
  if v_probe is not null then
    begin
      insert into payment_allocations (id, org_id, payment_id, invoice_id, amount, currency)
      select gen_random_uuid(), allocation.org_id, allocation.payment_id, allocation.invoice_id, 1, 'USD'
      from payment_allocations allocation where allocation.payment_id = v_probe limit 1;
      raise exception '0217: a USD allocation was written against an ILS payment';
    exception
      when foreign_key_violation then null;
    end;
  end if;

  -- The keys exist even on a database with no rows to probe, which is what CI runs against.
  select count(*) into v_count
    from pg_constraint
   where conname in (
     'payment_allocations_payment_currency_fk', 'payment_allocations_invoice_currency_fk',
     'payment_allocations_credit_currency_fk', 'payment_request_invoices_request_currency_fk',
     'payment_request_invoices_invoice_currency_fk', 'bank_allocations_transaction_currency_fk',
     'bank_allocations_invoice_currency_fk', 'bank_allocations_payment_currency_fk',
     'bank_transactions_import_currency_fk');
  if v_count <> 9 then
    raise exception '0217: % of the 9 currency-identity foreign keys exist', v_count;
  end if;

  -- 0058:207-218: a migration that changes tables proves the standing contracts here, not three
  -- hours later in the gate.
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0217 scope assertions failed:\n%', v_violations;
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0217 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0217$;
