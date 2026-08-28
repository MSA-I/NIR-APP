# Gates: money carries its currency — a plan, measured before it is written

Planning branch: `plan/multi-currency-20260828`, based on `main` (`c04d37a`). Phase P below was
achieved there and is history.

Execution branch: `ביצוע-תוכנית-מערכת-הדולרים`, branched from `plan/multi-currency-20260828`
(`770617c`). **`main` was not merged in, and that is a measurement, not an omission:** `main` is
still `c04d37a`, the exact commit the planning branch was cut from, and
`claude/add-english-language-system-f43d1e` is **not** in `git branch --merged main`. There is
nothing to merge. The English branch is still read read-only through `git show`.

Migration number: **`0217`, not the `0214` the plan expected**, and the plan was right to say
"verify before you decide". `git ls-tree` over every local branch returns **seven** migration files
claiming `0213`–`0216`, and they already collide with each other:

| number | files claiming it | branch |
|---|---|---|
| 0213 | `profile_locale` · `plan_capability_ladder` · `export_branding_entitlement` | English · codex/subscription-plans · another |
| 0214 | `platform_user_administration` · `plan_capability_decisions` | feat/app-admin-console · fix/exports-rtl-and-design |
| 0215 | `scan_pages_label` | |
| 0216 | `plan_capability_enforcement` | `fixes` |

The shared local database confirms it independently: `select max(version) from
supabase_migrations.schema_migrations` returns `0214`, applied as `platform_user_administration` —
somebody else's. `0217` is the first number above every claim, and it is correct under any merge
order. This is a repository-wide hazard, not a currency one: two pairs of unmerged migrations will
collide on merge whatever this branch does.

OWNS: docs/PLAN-multi-currency-20260828.md, docs/OPEN-DECISIONS.md (rows #284–#289), GATES.md,
scripts/check-currency.mjs, scripts/currency-baseline.json

Plan: `docs/PLAN-multi-currency-20260828.md`.
Decision this starts from: `OPEN-DECISIONS #277` (28.08.2026, supersedes `#14`), timing by `#281`.

## What the owner decided (verbatim intent)

> InPlace will really work in dollars. Not a converted display and not a swapped symbol. A supplier
> who issues a dollar invoice — the invoice is received in dollars, stored in dollars, paid in
> dollars, and that supplier's balance is managed in dollars **separately** from their shekel balance.

The rule the whole plan is tested against: a screen that adds ₪12,400 and $3,100 into one number
shows **a false number on a screen decisions are made from** — the direct breach of the
constitution's clause 12.

---

## Phase P — planning (this branch)

- [x] P-G1: the scope was measured, not assumed
  CHECK: the commands in `docs/PLAN-multi-currency-20260828.md` §1, column "ראיה"
  EXPECT: the numbers in that table
  EVIDENCE: measured on `main` `c04d37a`, 28.08.2026 — 207 migrations · head `0212` ·
  48 `numeric(12,2)` columns in create-table blocks, of which **26 are money and 24 lack a
  currency, across 17 tables** · 111 money aggregation sites in 20 migration files · ~23 distinct
  money-summing functions · 31 non-definition references to `p0_*_balance_rows` in 10 files ·
  **267 money-format call sites in 46 non-spec files** (`fmtMoneyExact` 230, `fmtMoneyRounded` 40,
  `fmtMoneyCompact` 3, `fmtPlanPrice` 4) · 42 lines carrying `₪` in 22 files · 13 spec files
  touching money · 8 client reads of `invoice_balances` in 7 files · 5 of `supplier_balances`.

- [x] P-G2: three claims the sources carry were checked and two are wrong
  EVIDENCE: (a) **"no currency column anywhere"** (`#277`, `DEBT §69`) is false for the system —
  `plan_price_catalogues.currency` and `organization_billing_periods.currency` exist since `0184`,
  `text not null check (currency in ('ILS','USD'))`, and are the exact pattern the plan generalises.
  It is true only of the procurement money. (b) **`invoice_balances`/`supplier_balances` "were
  deleted"** (`ARCHITECTURE.md`) is false — `0022:394-395` dropped them and `0022:462-465`
  recreated them as `security_invoker` views over the definer functions; the client reads the
  **views** at 13 sites. (c) **"52 currency sites in src"** was not reproduced by any measurement
  run here; the closest figures are 267 money-format call sites, 42 `₪` lines, or 299 lines
  matching `ILS|₪|currency` in 86 non-spec files.

- [x] P-G3: the untyped client boundary was found, and it changes where the plan puts its lever
  EVIDENCE: `src/lib/supabase.ts:44` calls `createClient(url, anonKey, { global: { fetch: correlatedFetch } })` **with no schema generic**,
  and rows are read through hand-written casts — `Suppliers.tsx:93`
  `as { supplier_id: string; open_balance: number }[]`. A renamed or reshaped column therefore
  produces **zero compile errors**; `Suppliers.tsx:95` would silently keep one of a supplier's two
  balances. Hence plan §3.2: the compiler-forcing change lives in TypeScript (delete the
  one-argument money formatter signature ⇒ 267 errors), and the SQL side forces failure by
  **dropping the old names** rather than replacing their bodies.

- [x] P-G4: all eight questions are decided — six of them by the owner on 28.08.2026
  EVIDENCE: plan §4.1–§4.8. Decided: where currency sits (§4.1, on the money row, `not null`,
  backfilled `ILS` because `0108` provably prevented anything else), how a balance stays true
  (§4.2, per supplier×currency, old names dropped), where summation is blocked (§4.3/§3.1), what
  happens to `0108` (§4.4, the rejection narrows and is renamed `currency_unsupported`, and an
  absent printed currency stays silent for a shekel-only supplier), bank matching (§4.5,
  cross-currency matching refused), FX (§4.7, none, and no external rate source — that would be a
  trust-boundary expansion like `DEBT §63`). Put to the owner and **answered on 28.08.2026**,
  recorded as `#284`–`#289`: **every ISO currency** is accepted, not a closed list (`#284`, and
  §2 measures what that adds: one reference table, 24 type widenings, rounding by `minor_units`);
  **VAT follows the country the business is in** (`#285`, implemented as the organisation's country
  rather than where a user happens to sit, with the rate check applying only to a domestic
  supplier); **paying a foreign-currency invoice from a local account is allowed** (`#286`, via
  `settlement_amount`/`settlement_currency`, rate derived and never stored); **the workbook gets a
  currency column**, not a sheet per currency (`#287`); **tolerances are per currency** (`#288`);
  **a supplier keeps one bank account** (`#289`).

- [x] P-G5: this branch changed no product code and created no migration
  CHECK: git diff --name-only main...HEAD
  EXPECT: only `docs/PLAN-multi-currency-20260828.md`, `docs/OPEN-DECISIONS.md`, `GATES.md`
  EVIDENCE: the scope line of the task. `supabase/migrations/` is untouched; head stays `0212`.

---

## Phase 0 — the guard before the schema

- [x] P0-G1: `check:money` stops being blind to a multi-line and a computed-argument formatter
  CHECK: npm run -s check:money
  EXPECT: /check:money passed/
  NEGATIVE CONTROL (must FAIL before the fix and after planting, pass after removal):
  `new Intl.NumberFormat(localeOf(row), { style: 'currency', currency: row.currency })` on one line,
  and a second formatter split across two lines. Both escape the current
  `/new Intl\.NumberFormat\([^)]*currency/` evaluated per line (`scripts/check-money.ts:88-90`) —
  `DEBT §69` and `RESEARCH §1` document the two halves of the same hole.
  EVIDENCE: both controls planted under `src/__negctl__/` **before** the fix ⇒
  `check:money passed: 3 rules …`, exit 0 — the hole reproduced. After the fix (rule 3 becomes
  `/new Intl\.NumberFormat\([\s\S]{0,240}?currency/`, and every rule is matched against the whole
  file with the line derived from the match offset) ⇒ `check:money FAILED — 3 hand-rolled money
  format(s)`, exit 1, naming both controls **and a third site the guard had never seen**:
  `src/portal/i18n.ts:113`, a real `Intl.NumberFormat` split across three lines with
  `currency: 'ILS'`. That site is not exempted — it moved into `src/lib/format.ts` as
  `fmtMoneyExactInLocale(locale, v)`, the one money formatter that does not pin `he-IL`, because
  the supplier portal renders in the supplier's language. Behaviour is unchanged: still ILS, still
  two decimals; `src/portal/i18n.spec.ts` 2/2 green. Controls removed ⇒ exit 0, and
  `npx tsc --noEmit` exit 0.

- [x] P0-G2: a money column without a currency companion cannot be added quietly
  CHECK: node scripts/check-currency.mjs columns
  EXPECT: GATE_CURRENCY_COLUMNS_OK
  NEGATIVE CONTROL: plant a money column in a scratch create-table block with no currency companion
  ⇒ non-zero exit naming the column. The 22 measured non-money `numeric(12,2)` columns (quantities,
  rates, confidences) sit in an explicit exemption list, pinned like `scripts/i18n-baseline.json`;
  they keep their scale of 2 while the 24 money columns widen to `numeric(14,3)` for `#284`.
  EVIDENCE: `GATE_CURRENCY_COLUMNS_OK — 51 numeric columns declared, all classified (28 money,
  23 not money); carrier check pending the currencies table`, exit 0. Control
  `9990_negctl_columns.sql` declaring `scratch_negctl_fees.service_fee_amount numeric(12,2)` ⇒
  exit **2**, naming the column and the file. Removed; exit 0 again.
  **Two measured corrections to plan §1.1, and neither is a scope decision — both follow §2's own
  rules applied to rows the plan's measurement could not see.** The plan counted `numeric(12,2)`
  columns inside `create table` blocks only, so it missed columns added by `alter table … add
  column`: **`purchase_requests.split_total`** (`0027`) and
  **`payment_requests.open_credit_override_total`** (`0073`) are money. The second inherits its own
  row's `payment_requests.currency`; the first is a draft head and takes `own`. The guard also
  classifies every numeric scale rather than `(12,2)` alone, which is why 51 and not 48: the money
  set includes `invoice_lines.unit_price numeric(18,6)`, `line_total`/`discount_amount
  numeric(14,2)` and the two `supplier_order_proposal*` deltas, and the not-money set includes
  `organizations.vat_rate numeric(5,2)` and five confidences. **26 of the money columns lack a
  currency today and 2 already carry one** (`plan_prices` through its catalogue,
  `organization_billing_periods` on the row) — the plan's "26 money, 24 without" holds for the set
  it measured; the phase-1 migration answers 26.
  The carrier half of the assertion is derived, not pinned: it switches itself on when a migration
  declares `create table currencies`, so nothing has to be remembered in phase 1.

- [x] P0-G3: an aggregate over money without `currency` in its `group by` fails the guard
  CHECK: node scripts/check-currency.mjs aggregates
  EXPECT: GATE_CURRENCY_AGGREGATES_OK
  EVIDENCE: `GATE_CURRENCY_AGGREGATES_OK — money aggregates enforced from 0214 onward`, exit 0.
  Control `9991_negctl_aggregate.sql` — a function doing `sum(i.total_amount)` with no mention of
  currency ⇒ exit **3**, naming the file and the function. Removed; exit 0. The 111 pre-existing
  aggregation sites are out of the window by the pin `aggregatesEnforcedFrom: "0214"`; phase 2
  rewrites them, this guard stops new ones.

- [x] P0-G4: `0108` still refuses a currency that is not on the list
  CHECK: node scripts/check-currency.mjs intake-guard
  EXPECT: GATE_CURRENCY_INTAKE_GUARD_OK
  This assertion must keep passing **after** phase 4, when the rejection narrows rather than
  disappears. A guard that only passes today is worthless.
  EVIDENCE: `GATE_CURRENCY_INTAKE_GUARD_OK — 0108_document_reconciliation_assessment.sql still
  rejects an unrecognised currency as currency_not_ils/error`, exit 0. The assertion reads the
  **latest** migration that defines `private.document_reconciliation_assessment`, not `0108` by
  name, and accepts `currency_not_ils` (today) or `currency_unrecognised` / `currency_unsupported`
  (phase 4) — what it will not accept is the rejection being gone, or its severity dropping below
  `error`. Control `9992_negctl_intake.sql`, a later redefinition with the rejection deleted ⇒
  exit **4**. Removed; exit 0.

- [x] P0-G5: the guard runs where the other guards run, and the phase changed no behaviour
  CHECK: npm run -s test; npx tsc --noEmit; npm run -s check:dead-code
  EXPECT: suite green; exit 0; no new knip findings
  EVIDENCE: `Test Files 158 passed (158) · Tests 1658 passed (1658)`; `TypeScript: No errors
  found`; knip unchanged (5 pre-existing configuration hints, no unused-export findings).
  `check:currency` is wired into `npm run verify` between `check:money` and `check:exemptions`,
  so CI runs it on every `src`/`scripts`/`migrations` change rather than only when somebody
  remembers. No product behaviour changed: the only runtime edit is the portal's money formatter
  moving into `format.ts` with identical output.

---

## Phase 1 — the schema

The migration is `supabase/migrations/0217_money_carries_its_currency.sql`. Every gate below was
measured by applying that file to the local stack inside `begin; … rollback;`, so the shared
database was never left changed — see the migration-number note above for why the local stack is
not on this branch's schema in the first place.

- [x] P1-G1: every money row carries a currency and no legacy row was guessed
  CHECK: select count(*) from invoices where currency is null; select count(*) from invoices where currency <> 'ILS';
  EXPECT: 0 and 0 immediately after the backfill
  EVIDENCE: `null_currency 0 | non_ils 0 | total 14` on the local stack's demo data. No statement
  in the migration updates a row: every new column is `not null default 'ILS'`, which Postgres 11+
  stores as metadata, so nothing was rewritten and none of `p1_financial_command_guard`,
  `zz_organization_write_guard` or the tenant-identity guards had to be argued past.

- [x] P1-G4: a currency the reference table does not hold cannot be written (`#284`)
  CHECK: update invoices set currency = 'XQZ' where id = :any;
  EXPECT: a foreign-key violation against `currencies`. The table carries `minor_units`, and every
  money column is `numeric(14,3)` so a 0-decimal (JPY) and a 3-decimal (KWD) currency both fit.
  EVIDENCE: the invoice probe in the CHECK line is the WRONG probe and the run proved it —
  `update invoices set currency = 'XQZ'` is refused by
  `payment_request_invoices_invoice_currency_fk`, a *referencing* key, so it would have passed even
  if the `currencies` key were missing. The migration's own assertion therefore probes
  `organizations.base_currency`, which nothing references: `ERROR: insert or update on table
  "organizations" violates foreign key constraint` is the only constraint that can refuse it.
  `currencies` holds **157** ISO-4217 codes, asserted with `minor_units` of 2 for ILS, 0 for JPY
  and 3 for KWD — the three shapes the rounding rule turns on.

- [x] P1-G2: a cross-currency allocation is not rejected — it is unrepresentable
  CHECK: insert a `payment_allocations` row linking a USD payment to an ILS invoice
  EXPECT: a foreign-key violation, not a trigger warning. The composite FKs onto
  `(org_id, payment_id, currency)` and `(org_id, invoice_id, currency)` are the mechanism.
  EVIDENCE: `ERROR: insert or update on table "payment_allocations" violates foreign key
  constraint "payment_allocations_payment_currency_fk" — DETAIL: Key (org_id, payment_id,
  currency)=(…, USD) is not present in table "payments".` The same insert with `'ILS'` is
  **accepted**, so the key discriminates rather than blocking everything. Flipping the payment
  instead of the allocation is refused from the other side. Nine composite keys were built and the
  assertion counts all nine; a negative control that renamed one produced
  `ERROR: 0217: 8 of the 9 currency-identity foreign keys exist`.
  Two more identity keys beyond the plan's three allocation tables: `bank_transactions.currency` is
  locked to `bank_imports.currency` (`ERROR: … violates foreign key constraint
  "bank_allocations_transaction_currency_fk"` when a line is flipped), and `payments` carries
  `payments_settlement_pair` / `payments_settlement_differs`, both of which fired on probe.

- [x] P1-G3: the migration meets the standing obligations
  CHECK: node scripts/check-anchored-replacements.mjs && npm run -s check:exemptions
  EXPECT: both exit 0; plus A5 (scope-enforced table name read from the settings table, never a
  literal or a comment), A6 (`tenant_export_registry` rehashed), explicit column grants — the step
  `0213` skipped — and forward-only.
  EVIDENCE: `check:anchored-replacements passed: 208 migration(s) scanned … 0 new unnormalised
  reader(s)`; `check:exemptions passed: 144 post-0057 migration(s) re-assert A1/A3/A5`. The
  migration adds **no** `SECURITY DEFINER` function, so A5's definer and trigger arms have nothing
  new to cover; it re-runs `private.scope_enforcement_violations()` and
  `private.tenant_export_registry_violations()` in its own assertion block and both return empty.
  A1 is met by the one new base table: `currencies` is registered `('currencies','system',false)`,
  the same classification `0184` gave the plan catalogue, and it deliberately gets NO
  `tenant_export_registry` row because it has no `org_id` and the registry's staleness arm treats
  such a row as a violation. A6 rehashes **every** registry row rather than naming the twenty that
  changed — one statement, nothing to keep in sync (`UPDATE 131`).
  Column grants: only `suppliers` needed them. Every other table carries a TABLE-level `SELECT`
  for `authenticated`, so its new columns are readable as soon as they exist; `suppliers` has been
  column-by-column since `0112` moved `bank_details` out of reach, so `default_currency` and
  `country_code` are granted by name (SELECT, and INSERT/UPDATE because the supplier form is an
  allow-listed direct write). Deliberately NOT granted: UPDATE on `invoices.currency` (evidence of
  what was printed, written only by the server command that recomputes the assessment), UPDATE on
  `organizations.country_code`/`base_currency` (`#285` routes both through an owner action with a
  reason and an audit row), and anything at all for `anon`.

- [x] P1-G6: widening the columns did not quietly drop a read model
  CHECK: two views read the widened columns and `alter column … type` refuses while they do
  EXPECT: both back, byte-identical in behaviour, with their storage options, grants and comment
  EVIDENCE: `inventory_intelligence` (0102) reads `supplier_products.current_price` and
  `purchase_order_items.unit_price`; `supplier_metrics` (0204) reads `credit_requests.amount`,
  `payment_allocations.amount` and `price_history.price`. The first run of the migration failed
  with `ERROR: cannot alter type of a column used by a view or rule — DETAIL: rule _RETURN on view
  inventory_intelligence depends on column "current_price"`, which is how they were found. They are
  captured from `pg_get_viewdef` into a temp table, dropped, and rebuilt from what the database
  holds — **not** from a definition restated in this migration, which is how a clause goes missing
  in silence. After the run both report `security_invoker=on, security_barrier=on`,
  `has_table_privilege('authenticated', …, 'select') = t`, and `inventory_intelligence` still
  carries its comment. Both return 0 rows to `postgres`, which is correct and not a defect: they
  are `security_invoker` and filter on `auth_org()`, which is null outside a session.
  Nothing else in the schema depends on either view.

- ABANDON — moved, not dropped: **P1-G5** ("an amount cannot be stored with more decimals than its
  currency has") **moves to phase 4 as P4-G6.** It cannot be measured in phase 1, and that is a
  measurement rather than a preference: the gate asks for "a JPY amount of 1000.50 through the
  owning RPC", and until phase 4 opens `0108` **no writer in this system can produce a row in any
  currency but ILS** — `create_invoice` takes no currency argument and the intake guard refuses
  every non-shekel document. A gate whose precondition cannot exist is not a gate. The schema half
  it depends on is delivered here: `currencies.minor_units` is seeded and asserted for the 0-, 2-
  and 3-decimal cases, and every money column is `numeric(14,3)` so all three fit. The rounding
  itself belongs in the write commands (`0023:1712-1725` hard-codes `round(…, 2)`), which phase 4
  edits anyway to accept a currency — doing it now would mean rewriting the same function twice.

---

## Phase 2 — the money readers

The migration is `supabase/migrations/0218_balances_are_read_per_currency.sql`, measured the same
way as phase 1: `begin; 0217; 0218; fixture; rollback;` against the local stack.

**The live surface was smaller than the plan estimated, and that is a measurement.** Plan §4.2
counted 31 textual references across 10 migration FILES; migration files are immutable history, and
what a new migration has to change is what is live. `pg_proc` says exactly three functions and two
views name the balance readers: the two definitions themselves, `management_dashboard_snapshot`
(which reads both views), and `soft_delete_supplier` — which turned out to name
`p0_invoice_balance_rows` only in a comment while carrying its own copy of the sum. Nineteen live
functions sum money in total, against the plan's estimate of ~23; the rest are phases 4 and 5.

- [x] P2-G1: the old readers are gone by name, so an un-migrated caller fails loudly
  CHECK: select to_regprocedure('public.p0_supplier_balance_rows()') is null;
  EXPECT: t
  EVIDENCE: `fn_gone t | view_gone t | inv_fn_gone t | inv_view_gone t` — both functions and both
  views dropped, and the four `_by_currency` replacements created. The field names moved with them:
  `balance` ⇒ `balance_in_currency`, `open_balance` ⇒ `open_balance_in_currency`, asserted by
  column name in the migration itself. `drop`, not `create or replace`, is the whole mechanism:
  `src/lib/supabase.ts:44` has no schema generic, so a reshaped return type produces zero compile
  errors and `Suppliers.tsx:95` would keep one of a supplier's two balances with nothing to say so.

- [x] P2-G2: a supplier with two currencies returns two rows, and nothing merges them
  CHECK: fixture ₪12,400 open and $3,100 open for one supplier; select count(*) from supplier_balances_by_currency where supplier_id = :s;
  EXPECT: 2 — and no surface anywhere shows 15,500
  EVIDENCE: exactly the fixture the plan names, on the demo organisation's supplier
  `aa000000-…-0001`:
  ```
   supplier_id  | currency | open_balance_in_currency | open_invoices
   aa000000-…01 | ILS      |                12400.000 |             1
   aa000000-…01 | USD      |                 3100.000 |             1
   rows_for_that_supplier = 2
  ```
  `15500` appears nowhere in the output of any reader. A supplier with **no** invoices now returns
  no row at all rather than the old `(supplier, 0)`: grouping by currency has no honest currency to
  put on that row, and the constitution already says the screen draws `—`, never `0`.

- [x] P2-G3: the dashboard refuses to combine instead of combining quietly
  CHECK: management_dashboard_snapshot(current_date) on a mixed-currency org
  EXPECT: per-currency rows, or `null` for a metric that cannot be split — never a summed scalar.
  The `null` ⇒ `—` mechanism already exists (`0100`, partial coverage); the trigger is new.
  EVIDENCE: on the same mixed fixture —
  `money.openBalanceByCurrency = [{ILS, 30224.600, 10 invoices}, {USD, 3100.000, 1 invoice}]`,
  and `topBalancesByCurrency` returns one group per currency, base currency first, six suppliers
  ranked WITHIN each currency (ranking across currencies is the same false comparison as the sum,
  wearing an ordering instead of a total). All six money figures split:
  `openBalanceByCurrency`, `overdueAmountByCurrency`, `dueWithin7AmountByCurrency`,
  `credits.sumByCurrency`, `openOrders.committedByCurrency`/`remainingByCurrency`,
  `topBalancesByCurrency`. Every key was RENAMED, and the absence of the old ones is asserted both
  in the migration and on the live result: `still_has_open_balance f | still_has_top_balances f |
  still_has_credit_sum f`. Counts deliberately do not split — a count means the same thing in
  every currency. The `null`-means-unknown branches are unchanged.

- [x] P2-G5: deleting a supplier asks the question per currency
  CHECK: `soft_delete_supplier` on the two-currency supplier
  EXPECT: `supplier_has_open_balance`
  EVIDENCE: `ERROR: supplier_has_open_balance`. The old predicate was `sum(total − paid − credited)
  > 0` across ALL of a supplier's invoices — an addition of unlike things that could net a credit
  balance in one currency against a real debt in another and let the supplier be deleted with money
  still owed. It is now `exists (… group by currency having open_balance > 0)`, which is the
  question the guard was always asking. The rest of the body is restated in full: it is
  `SECURITY DEFINER` with a registered scope exemption keyed on a signature that does not move.

- [x] P2-G6: A5's definer registry follows the rename
  EVIDENCE: the first run failed with exactly the four lines it should have —
  `A5 -- stale scope enforcement registration: p0_invoice_balance_rows()` (and the supplier twin),
  `A5 -- uncovered security definer function: p0_invoice_balance_rows_by_currency()` (and its
  twin). `private.scope_definer_enforcements` now deletes the two dead signatures and registers the
  two new ones as `filtered_read`, with the body hash **computed from `pg_proc`** rather than typed
  as a literal — a digest written into a migration is a value produced on a machine whose line
  endings may not match CI's, which is how the `0171`–`0205` rollout aborted at `0181`.
  `check:anchored-replacements` (209 migrations, 0 new unnormalised readers) and `check:exemptions`
  (145 re-asserting migrations, pin 90 unchanged) both pass.

- [x] P2-G4: the P4 journey script was updated with the readers it calls
  CHECK: node scripts/check-p4-integrated-journey.cjs
  EXPECT: PASS — its two `p0_invoice_balance_rows` calls (`:273`, `:303`) are the proof the rename
  actually propagated.
  EVIDENCE: both RPC names updated to `p0_invoice_balance_rows_by_currency`, and the two reads of
  the renamed field updated with them (`:320`, `:702` now read `balance_in_currency`).
  `node --check` passes. The script itself runs only inside the manual Windows gate, which
  `CLAUDE.md` records as outside CI; it is exercised in phase 6, not claimed here.
  NOT touched, and deliberately: the two `invoice_balances` route mocks in
  `scripts/check-browser-smoke.cjs` (`:1603`, `:1681`). They mock what the CLIENT asks for, and the
  client still asks for the old name until phase 3. They move with it.

- [x] P2-G7: the summary readers split, and a tolerance stops being a shekel by accident
  The migration is `supabase/migrations/0219_summary_readers_and_tolerances_per_currency.sql`.
  CHECK: `p2_active_payment_request_total_by_currency()`, `p2_business_summary_rows_by_currency()`,
  `credit_request_balance_rows()`, `payment_request_financial_check_signals()`
  EXPECT: money per currency, an invoice set spanning two currencies refused, and no invented
  tolerance for a currency nobody configured
  EVIDENCE, on a fixture of one supplier with a ₪12,400 and a $3,100 invoice and a payment request
  on each:
  ```
  p2_active_payment_request_total_by_currency: ILS 19676.000 · USD 3100.000   (never 22,776)
  old_total_gone t | old_summary_gone t
  p2_business_summary_rows_by_currency: expected_payments ILS · expected_payments USD ·
                                        the three counts with currency NULL
  mixed set  ⇒ ERROR: payment_request_checks_currency_mismatch
  ILS set    ⇒ {"currency":"ILS", "amount_matches_open_balance": true,  "open_credit_total_by_currency": []}
  USD set    ⇒ {"currency":"USD", "amount_matches_open_balance": null,  …}
  credit_request_balance_rows ⇒ credit … | ILS | 85.000
  ```
  **`amount_matches_open_balance` is `null`, not `false`, for the dollar set** and that is the
  point of `#288`: the ± 1 window in that function was a bare literal and meant "one shekel" only
  because there was nothing else it could mean. `private.money_tolerance()` reads a per-currency
  map, falls back to the old scalar **for ILS only**, and returns NULL for a currency nobody has
  configured. False would claim the amount does not match; null says nobody has decided what
  matching means here, which is the honest answer and the one the screen already draws as `—`.
  Two identity keys `0217` left open are closed here, because the readers depend on them: a credit
  note is tied to its invoice's currency and a payment to its request's. That is why
  `invoice_financial_check_signals` needed no change at all — summing the credits attached to one
  invoice is now single-currency by construction. Probe: flipping a credit's currency ⇒
  foreign-key violation.

- [x] P2-G8: the SQL suites were run against the migrated schema, and the two things that broke
  were found here rather than in CI
  CHECK: every file in `supabase/tests/` replayed against `0217`+`0218`+`0219`+`0220` inside one
  rolled-back transaction (the local stack is on somebody else's `0214`, so nothing may be left
  behind)
  EXPECT: no suite fails for a reason this campaign caused
  EVIDENCE: **80 suites run. Two failed because of this work, and both are fixed:**
  1. `monthly_report_snapshots` — `ERROR: column "b.currency" must appear in the GROUP BY clause`.
     `create_monthly_report_snapshot` aggregates a CTE of bank transactions with a GROUP BY that
     ENUMERATES every column by name. Postgres infers the rest of a row from a grouped primary key
     only for a real table; a CTE has none, so the enumeration is load-bearing and `0217`'s new
     column broke the plan. Fixed by `0220` — an **anchored replacement** of one GROUP BY list
     against the live body with `\r` stripped, not a restatement of 21,000 characters, and the
     migration fails if the anchor is absent or appears twice. A search of every function body
     carrying both `group by` and a column of an altered table returns five; the other four group
     by columns of REAL tables that gained nothing, so the key dependency covers them.
  2. `p9_five_domains` — "the policy configuration must carry exactly one FK". The rule that
     assertion states in its own comment is that `approval_policy_configurations` must not be
     FK-bound to the private definitions; "exactly one" was a proxy that held while the tenant was
     the only key. `threshold_amount` now has a currency beside it, so the assertion names each
     relationship instead of counting them, and gains a third: the threshold must keep the currency
     it is compared in. It passes with the migrations and **fails without them**, which is the
     coupling worth having.
  Seven suites also updated for the renames, each verified passing against the migrated schema:
  `p2_data_reliability`, `p3_org_scope`, `p21_dashboard_snapshot`, `p46_consolidated_supplier_invoice`,
  `p57_business_summary_parity`, `p63_financial_credit_contracts`, `payment_credit_override`.
  `p57` gains a two-currency block proving `expected_payments` returns two rows, that neither is
  495.25, and that the three counts carry no currency at all. `p21` gains a helper that names the
  currency it asserts about, because reading "the first element" would pass today and assert about
  the wrong currency the moment a second appears.
  **NOT claimed to pass, and honestly:** eleven suites cannot run in this harness at all — they
  open second connections through `dblink` or own a schema, and an outer transaction that also
  strips their own transaction control breaks that. `p46` fails identically **at baseline** on the
  unmodified file, which is how that was established. Seven more fail identically at baseline for
  reasons this work did not cause (`p22_trial_read_only`, `p49_platform_capabilities`,
  `p51_plan_entitlements`, `p5_domain_events`, `p70_launch_plans_and_usage_anchor`,
  `p18_document_automation_calibration`, `smart_document_processing`) — the shared local database
  is carrying another branch's `0213`/`0214`. CI runs all of these on a clean reset; this gate is
  the fast local sweep, not a substitute for P6-G1.

- [x] P2-G9: the purchase analytics stop adding — and one of them stops RANKING — unlike money
  The migrations are `0221_purchase_analytics_per_currency.sql` and
  `0222_consolidated_case_lines_carry_their_currency.sql`.
  CHECK: `private.canonical_purchase_metrics`, `private.product_purchase_summary`,
  `public.purchase_comparison`, `private.consolidated_case_lines`/`consolidated_comparison`
  EXPECT: money per currency; no comparison across currencies
  EVIDENCE:
  * `canonical_purchase_metrics` — all five money figures are arrays now, proven on the demo
    organisation: `committed_by_currency [{ILS, 26314.860}]`, `gross_expense_by_currency
    [{ILS, 13163.000}]`, `credits_recognised/pending`, `net_expense_by_currency [{ILS, 12928.000}]`,
    and `net_definition` renamed to `gross_minus_offset_and_closed_credits_within_one_currency`.
    Net subtracts a credit only inside the currency it was issued in, through a full outer join,
    so a currency with only credits reports no net at all rather than a negative expense nobody
    was billed.
  * `purchase_comparison` **was ranking across currencies**, and that is the worst defect this
    phase found: `order by offers.current_price` sorted a $12 offer below a ₪40 offer and returned
    the dollar supplier as cheaper — a false comparison presented as a recommendation, on the
    screen a person uses to choose a supplier. Probed by giving one product a shekel offer of 8.50
    and a dollar offer of 12:
    ```
    status                 | chosen | chosen_currency | offer_count | lines_spanning_currencies
    offers_span_currencies |        |                 |           2 | 1
    offers:  8.500 ILS · 12.000 USD          ← both listed, with their units, for a person to judge
    ```
    Putting both offers back in one currency restores exactly the old answer:
    `ok | ILS | 8.500 | 850.000`. The supplier minimum follows the same rule —
    `min_order_amount` is stated in the supplier's own currency, so against a subtotal in another
    `below_minimum` is **null**, not false, because false claims the minimum was cleared.
  * `product_purchase_summary` — spend splits per currency; the average unit price exists **only**
    when a product was billed in one currency, because its divisor is the canonical QUANTITY, a
    physical fact with no currency, and part of the money over all of the quantity is a unit price
    nobody was charged. `spans_currencies` names the rows in that state. This is the same rule the
    function already applied to unknown spend, which it renders as `—` rather than `0`.
  * `consolidated_case_lines` — the reconciliation grain becomes `(identity_key, currency)`, taken
    from the invoice a line was printed on or the order a receipt was priced against, and
    `consolidated_comparison` joins on both. Every `difference_amount` is now a subtraction inside
    one currency by construction.
  `p33_canonical_purchase_metrics` and `p34_product_purchase_summary` are updated and pass; both
  gained a helper that names the currency it asserts about rather than reading the first element.
  A full sweep of all 94 suites after these two migrations returns **the same 19 failures as
  before them** — eleven harness (dblink/superuser), eight identical at baseline — and no new one.

- **Phase 3's scope is wider than "the client", and this is where that was decided.** Two
  server-side consumers still call names this phase deleted: `src/lib/summary.ts:52` and the Edge
  tool `supabase/functions/assistant/tools/business-summary.ts:74` both call
  `p2_business_summary_rows`, and both build a `Map` keyed by `metric_key` — the exact
  silent-overwrite the rename exists to prevent, since `expected_payments` now returns one row per
  currency. They are NOT patched here: both need the per-currency rendering that phase 3 builds,
  and splitting one change across two phases is how half of it gets forgotten. Phase 3 covers the
  React client **and** the assistant tools that read these readers.
  Recorded with it, because it becomes reachable in phase 4 and not before:
  `assistant_facts.unit` (`0164`) accepts `('ils','count','percent','date','text')` and the
  TypeScript twin `FACT_UNITS` (`src/lib/assistant/contracts.ts:214`) is the same closed list. A
  dollar figure quoted by the assistant needs both widened, plus `provider.ts:178`'s JSON-Schema
  enum and `AnswerView.tsx:36`'s `case 'ils'`. Until phase 4 no non-ILS row can exist, so nothing
  is wrong today; the moment one can, this is four files, and it is written down so it is not
  discovered by a constraint violation in production.

---

## Phase 3 — the client

- [ ] P3-G1: an amount cannot be rendered without saying which currency it is
  CHECK: npx tsc --noEmit
  EXPECT: exit 0
  EVIDENCE REQUIRED: the error list produced by deleting the one-argument signature is pasted here
  **before** the work — 267 sites in 46 files is the measurement, and `tsc` returning 0 afterwards
  is the only proof each one was answered.
  MEASURED BEFORE THE WORK, on this branch: **265 errors in 50 files** (the plan measured 267 in 46
  on `main`; the difference is the branch, not the method). Call sites counted directly:
  **233 occurrences on 214 lines in 41 non-spec files** — `fmtMoneyExact` 202, `fmtMoneyRounded` 30,
  `fmtMoneyCompact` 1. Every error is `TS2554: Expected 2 arguments, but got 1`, which is one place
  where a person has to answer "which currency is this figure in".

  | file | errors | | file | errors |
  |---|---|---|---|---|
  | `pages/Reports.tsx` | 24 | | `pages/dashboards/AccountantDashboard.tsx` | 5 |
  | `pages/Dashboard.tsx` | 18 | | `pages/SupplierProposalReview.tsx` | 5 |
  | `pages/InvoiceDetail.tsx` | 15 | | `pages/Payments.tsx` | 4 |
  | `pages/neworder/SupplierSplitStep.tsx` | 13 | | `components/document-review/DocumentAssessmentPanel.tsx` | 4 |
  | `pages/AccountantPaymentQueue.tsx` | 12 | | `pages/quickCreateSupplierWiring.spec.tsx` | 3 |
  | `pages/Orders.tsx` | 11 | | `pages/ProductPurchaseSummary.tsx` | 3 |
  | `pages/Suppliers.tsx` | 10 | | `pages/Inventory.tsx` | 3 |
  | `pages/neworder/SupplierGroupCard.tsx` | 9 | | `pages/Credits.tsx` | 3 |
  | `pages/PriceLists.tsx` | 9 | | `lib/monthlyReport.spec.ts` | 3 |
  | `pages/PaymentRequests.tsx` | 9 | | `pages/Products.tsx` | 2 |
  | `pages/FinancialSupplier.tsx` | 9 | | `pages/Invoices.tsx` | 2 |
  | `pages/Bank.tsx` | 9 | | `pages/DocumentOperations.tsx` | 2 |
  | `components/charts.tsx` | 9 | | `components/ui.tsx` | 2 |
  | `pages/neworder/NewOrder.tsx` | 8 | | `components/document-review/PriceListAutomationReadiness.tsx` | 2 |
  | `pages/neworder/MinimumFixPanel.tsx` | 8 | | `portal/i18n.ts` | 1 |
  | `pages/Expenses.tsx` | 8 | | `pages/supplierCardHonesty.spec.tsx` | 1 |
  | `lib/checks.ts` | 7 | | `pages/serverListScreens.spec.tsx` | 1 |
  | `pages/neworder/SummaryStep.tsx` | 6 | | `pages/neworder/ProductStep.tsx` | 1 |
  | `pages/dashboardDueWindow.spec.tsx` | 6 | | `pages/Onboarding.tsx` | 1 |
  | `lib/supplierLogChanges.spec.ts` | 6 | | `pages/Exceptions.tsx` · `pages/ConsolidatedInvoices.tsx` · `pages/Analytics.tsx` · `lib/supplierLogChanges.ts` · `lib/share.ts` · `components/assistant/assistantPanel.spec.tsx` · `components/assistant/AnswerView.tsx` · `components/PriceListUpload.tsx` · `components/OrgSubscriptionPanel.tsx` · `components/InvoiceLineReviewModal.tsx` · `components/GlobalSearch.tsx` | 1 each |

- [ ] P3-G2: the tests and the money guard survive it
  CHECK: npm run -s test && npm run -s check:money
  EXPECT: suite green; /check:money passed/

- [ ] P3-G3: a supplier card shows two balances and never their sum
  EVIDENCE: screenshot of one supplier with ₪12,400 and $3,100 on two lines. An empty list renders
  `—`, never `0` (constitution).

---

## Phase 4 — intake

- [ ] P4-G1: a dollar document becomes a dollar invoice
  CHECK: apply a reviewed document printing USD; select currency from invoices where id = :new;
  EXPECT: USD

- [ ] P4-G2: something that is not a currency is still blocked
  CHECK: a document whose printed currency reads `US0` through `private.document_reconciliation_assessment`
  EXPECT: finding `currency_unrecognised`, severity `error`, `approval_blocked` true. EUR now
  passes (`#284`); "I could not read it" must never resolve to shekels.

- [ ] P4-G5: a foreign supplier's invoice is not flagged for the local VAT rate (`#285`)
  CHECK: an invoice from a supplier whose `country_code` differs from the organisation's, printing zero VAT
  EXPECT: no VAT-rate finding. The same document from a domestic supplier still produces one —
  the discriminator is the country, not the currency.

- [ ] P4-G3: the shekel-only business feels nothing (regression)
  CHECK: a shekel document with no printed currency from a shekel supplier
  EXPECT: zero new findings — identical to today's behaviour

- [ ] P4-G6 (was P1-G5): an amount cannot be stored with more decimals than its currency has (`#284`)
  CHECK: write a JPY amount of 1000.50 through the owning RPC
  EXPECT: refused. Rounding reads `currencies.minor_units` instead of the hard-coded 2
  (`0023:1712-1725` is the site), and the write commands are already the only write path.
  Moved here from phase 1 because no writer could produce a non-ILS row until this phase — see the
  ABANDON note under phase 1.

- [ ] P4-G7: the temporary `default 'ILS'` comes off the intake path
  CHECK: `alter table invoices alter column currency drop default;` lands in this phase's migration,
  and an insert that names no currency then fails
  EXPECT: `null value in column "currency"`. `0217` carried the default so that phases 1–3 kept
  running against writers that do not name a currency; the moment `apply_reviewed_document`
  supplies one, a currency nobody stated must be a failure rather than a shekel.

- [ ] P4-G8: the manual invoice form can state a currency, and `create_invoice` records it
  ADDED 28.08.2026, during phase 3. `create_invoice` (`0023`) takes no currency parameter, so an
  invoice typed by hand is stored `ILS` by the temporary default — which means the form is
  telling the truth today and stops doing so the moment P4-G7 removes that default. Phase 3 made
  the form's duty checks read a named constant (`INTAKE_CURRENCY`) rather than an invented
  supplier currency, precisely so that this gate replaces one reference.
  CHECK: create an invoice by hand for a supplier whose `default_currency` is USD
  EXPECT: the form offers the currency (defaulting to that supplier's), `create_invoice` records
  what was chosen, and the duplicate/order/credit checks compare against invoices in the SAME
  currency — a shekel invoice with the same number is not this invoice's duplicate in any figure
  it reports

- [ ] P4-G4: the client cannot dictate the currency
  CHECK: a review payload asserting a currency the recomputed assessment did not derive
  EXPECT: `document_review_currency_mismatch`. `0110:358-378` already ignores client findings; this
  extends the same rule to the currency it writes.

---

## Phase 5 — bank, payments, reports

- [ ] P5-G1: a shekel statement line settles a dollar invoice only through a payment that recorded both figures (`#286`)
  CHECK: (a) match a shekel transaction to a payment whose `settlement_currency` is ILS and whose
  `settlement_amount` equals the line within that currency's tolerance; (b) match the same
  transaction straight to a dollar invoice
  EXPECT: (a) matched, the allocation staying in USD so the dollar balance closes in dollars;
  (b) `bank_match_currency_mismatch` with a stated exception reason. The rate is derived on read
  from `settlement_amount / amount` and is stored nowhere.

- [ ] P5-G2: a single-currency month is byte-for-byte the workbook it is today, plus one column
  CHECK: build a shekel-only month workbook
  EXPECT: the same five sheets with the same names, each money sheet carrying one added `מטבע`
  column reading `ILS`. No split, because there is nothing to split (`#287`, owner 28.08.2026).

- [ ] P5-G3: a mixed month splits per currency, and no sheet mixes two in one amount column
  CHECK: build a month holding ILS and USD invoices, payments, credits and bank rows
  EXPECT: one sheet per currency per money surface, named `<sheet> <ISO>`, ordered base currency
  first then ISO code ascending; every amount cell formatted from its own row's currency; the single
  `פרטי הדוח` sheet holding one total row per currency and **no** combined row. Sheet names
  stay within Excel's 31-character limit, and no cell carries a formula — the workbook neutralises
  formulas by policy and this gate must not be the reason that changes.

- [ ] P5-G4: the workbook is a pure function of the snapshot, so the hash still means something
  CHECK: build the same mixed month twice and compare the two files
  EXPECT: identical sheet set, identical order. Naming and ordering are derived from the data, never
  from insertion order.

- [ ] P5-G5: an immutable snapshot keeps the meaning it was written with
  CHECK: read a snapshot created before `0214`
  EXPECT: reported as ILS through its `report_version`; `content_hash` unchanged — read, never rewrite

- [ ] P5-G6: the two payment-request COMMANDS carry the currency their money is in
  ADDED 28.08.2026, during phase 3, from reading the code the client calls. Not a re-plan: the
  plan's §3 rule ("an amount cannot be rendered without saying which currency it is") is a rule
  about reading, and these two are writing. Both were measured, both are real:
  (a) `create_payment_request` (`0073:292`) derives `amount` from the allocations and inserts the
      request WITHOUT a currency, so a request built from dollar invoices is stored `ILS` by the
      temporary default. The client now refuses to build a mixed selection (`PaymentRequests.tsx`,
      commit below), so the browser cannot produce a wrong row — but the RPC still can, and an
      RPC's correctness may not rest on its caller.
  (b) `approve_payment_request` (`0073:693-707`) computes `sum(cr.amount)` over the supplier's open
      credits with no currency clause, and compares that scalar to `p_expected_open_credit_total`.
      For a supplier holding credits in two currencies that sum is a number with no unit. It is
      only ever COMPARED, never shown — the screen already lists the credits per currency and
      withholds the "net after credits" line when the credit is in another currency — so today it
      fails closed rather than lying. That is the reason it may wait for this phase, not a reason
      to leave it.
  CHECK: (a) create a request from two dollar invoices; (b) approve a request for a supplier
  holding an open credit in ILS and one in USD
  EXPECT: (a) the row's `currency` is `USD`, derived from the allocated invoices, and a set spanning
  two currencies is refused `payment_request_currency_mixed`; (b) the override compares the credit
  total IN THE REQUEST'S CURRENCY, and a credit in another currency neither blocks the plain
  approval nor is counted into the recorded override total

---

## Phase 6 — evidence and rollout

- [ ] P6-G1: the heavy gate is green on the SHA
  CHECK: gh workflow run quality-gate.yml && gh run watch
  EXPECT: success

- [ ] P6-G2: the rollout matrix rows that were touched were actually executed
  EXPECT: the union of `Migration / חוזה DB` and `Frontend` rows — backup, dry-run + ledger,
  forward-only apply, postflight; build with production env, Pages, hash parity, canonical smoke.
  The manual `schema_migrations` ledger row after `db-query.ps1` is part of it, not optional.
  `worker/ocr` is out of scope and is **not** redeployed unless a gateway contract version moves.

---

ABANDON: none yet. A gate dropped later is recorded here with `ABANDON:` and its reason — never
deleted quietly.
