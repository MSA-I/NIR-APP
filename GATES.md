# Gates: money carries its currency — a plan, measured before it is written

Branch: `plan/multi-currency-20260828`, based on `main` (`c04d37a`). **Planning branch. No product
code, no migration.** The English work on `claude/add-english-language-system-f43d1e` is untouched
and unmerged; this branch reads it read-only through `git show`.

OWNS: docs/PLAN-multi-currency-20260828.md, docs/OPEN-DECISIONS.md (rows #284–#289), GATES.md

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

- [ ] P0-G1: `check:money` stops being blind to a multi-line and a computed-argument formatter
  CHECK: npm run -s check:money
  EXPECT: /check:money passed/
  NEGATIVE CONTROL (must FAIL before the fix and after planting, pass after removal):
  `new Intl.NumberFormat(localeOf(row), { style: 'currency', currency: row.currency })` on one line,
  and a second formatter split across two lines. Both escape the current
  `/new Intl\.NumberFormat\([^)]*currency/` evaluated per line (`scripts/check-money.ts:88-90`) —
  `DEBT §69` and `RESEARCH §1` document the two halves of the same hole.

- [ ] P0-G2: a money column without a currency companion cannot be added quietly
  CHECK: node scripts/check-currency.mjs columns
  EXPECT: GATE_CURRENCY_COLUMNS_OK
  NEGATIVE CONTROL: plant a money column in a scratch create-table block with no currency companion
  ⇒ non-zero exit naming the column. The 22 measured non-money `numeric(12,2)` columns (quantities,
  rates, confidences) sit in an explicit exemption list, pinned like `scripts/i18n-baseline.json`;
  they keep their scale of 2 while the 24 money columns widen to `numeric(14,3)` for `#284`.

- [ ] P0-G3: an aggregate over money without `currency` in its `group by` fails the guard
  CHECK: node scripts/check-currency.mjs aggregates
  EXPECT: GATE_CURRENCY_AGGREGATES_OK

- [ ] P0-G4: `0108` still refuses a currency that is not on the list
  CHECK: node scripts/check-currency.mjs intake-guard
  EXPECT: GATE_CURRENCY_INTAKE_GUARD_OK
  This assertion must keep passing **after** phase 4, when the rejection narrows rather than
  disappears. A guard that only passes today is worthless.

---

## Phase 1 — the schema

- [ ] P1-G1: every money row carries a currency and no legacy row was guessed
  CHECK: select count(*) from invoices where currency is null; select count(*) from invoices where currency <> 'ILS';
  EXPECT: 0 and 0 immediately after the backfill

- [ ] P1-G4: a currency the reference table does not hold cannot be written (`#284`)
  CHECK: update invoices set currency = 'XQZ' where id = :any;
  EXPECT: a foreign-key violation against `currencies`. The table carries `minor_units`, and every
  money column is `numeric(14,3)` so a 0-decimal (JPY) and a 3-decimal (KWD) currency both fit.

- [ ] P1-G5: an amount cannot be stored with more decimals than its currency has (`#284`)
  CHECK: write a JPY amount of 1000.50 through the owning RPC
  EXPECT: refused. Rounding reads `currencies.minor_units` instead of the hard-coded 2
  (`0023:1712-1725` is the site), and the write commands are already the only write path.

- [ ] P1-G2: a cross-currency allocation is not rejected — it is unrepresentable
  CHECK: insert a `payment_allocations` row linking a USD payment to an ILS invoice
  EXPECT: a foreign-key violation, not a trigger warning. The composite FKs onto
  `(org_id, payment_id, currency)` and `(org_id, invoice_id, currency)` are the mechanism.

- [ ] P1-G3: the migration meets the standing obligations
  CHECK: node scripts/check-anchored-replacements.mjs && npm run -s check:exemptions
  EXPECT: both exit 0; plus A5 (scope-enforced table name read from the settings table, never a
  literal or a comment), A6 (`tenant_export_registry` rehashed), explicit column grants — the step
  `0213` skipped — and forward-only.

---

## Phase 2 — the money readers

- [ ] P2-G1: the old readers are gone by name, so an un-migrated caller fails loudly
  CHECK: select to_regprocedure('public.p0_supplier_balance_rows()') is null;
  EXPECT: t

- [ ] P2-G2: a supplier with two currencies returns two rows, and nothing merges them
  CHECK: fixture ₪12,400 open and $3,100 open for one supplier; select count(*) from supplier_balances_by_currency where supplier_id = :s;
  EXPECT: 2 — and no surface anywhere shows 15,500

- [ ] P2-G3: the dashboard refuses to combine instead of combining quietly
  CHECK: management_dashboard_snapshot(current_date) on a mixed-currency org
  EXPECT: per-currency rows, or `null` for a metric that cannot be split — never a summed scalar.
  The `null` ⇒ `—` mechanism already exists (`0100`, partial coverage); the trigger is new.

- [ ] P2-G4: the P4 journey script was updated with the readers it calls
  CHECK: node scripts/check-p4-integrated-journey.cjs
  EXPECT: PASS — its two `p0_invoice_balance_rows` calls (`:273`, `:303`) are the proof the rename
  actually propagated.

---

## Phase 3 — the client

- [ ] P3-G1: an amount cannot be rendered without saying which currency it is
  CHECK: npx tsc --noEmit
  EXPECT: exit 0
  EVIDENCE REQUIRED: the error list produced by deleting the one-argument signature is pasted here
  **before** the work — 267 sites in 46 files is the measurement, and `tsc` returning 0 afterwards
  is the only proof each one was answered.

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
