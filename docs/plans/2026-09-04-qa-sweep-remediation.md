# Plan: remediate the 2026-09-04 live-site QA sweep

_Written 2026-09-04 by Claude, after reading the sweep, verifying its causes against the tree, and
two adversarial review rounds. Status: **PLANNED / NOT_IMPLEMENTED**. No product code written._

## 0. What this is

Thirteen QA agents swept `app.inplace.digital` on 2026-09-04 in three identities and produced
**146 structured findings** with file:line causes, 605 screenshots and 273 measurement files.
Zero confirmed regressions from the Wave 0-8 rollout — 130 of the 146 pre-date it. This is debt
collection, and the owner asked for the full scope.

**138 actionable, 8 not defects.** The eight: `ASSIST-V1`..`ASSIST-V4` (verified-working records),
the `EXP-R1`, `PERM-R1` and `OWN-16` retractions, and `ASSIST-11` — an OBSERVATION the report itself
withdrew, because its own follow-up measured eight consecutive dashboard loads with eight successes
and concluded there was no server fault. `ASSIST-02` was never issued; the ids run 01, 03-12, V1-V4
and 146 is the true total.

Five ids were placed wrongly in an earlier draft and are corrected here. `PL-10` is a real defect —
"not reproduced, code-level only" is a statement about evidence, not about the code, and
`PriceLists.tsx:494-499` reads the catalogue unpaged; it joins B3. `DOC-12` carries an explicit
acceptance criterion in its own record, so "severity unchanged" is not "no work owed"; it joins H.
`ASSIST-11` moved the other way. And two were moved in this plan's prose while the ledger still
said otherwise — `OWN-12` to B2, because `DOC-13` depends on it, and `PROC-02` to A, because storing
`12,50` as 1,250.00 is a money-shape defect. The ledger now agrees with the prose in all five.

Every id is placed in exactly one wave and the placement is checked mechanically, which is how
`PERM-06` was caught after being missed twice.

**Evidence:** `docs/QA-SWEEP-20260904.md` (in this repo) carries all 146 findings, the SHA-256 of
each of the 13 `findings.json`, and the deployment they were measured against — merge `4f477671`,
Pages `canonical_deployment` `baf1081b`, ledger head `0314`, OCR gateway contract 4.

**Ledger:** `docs/GATES.md` carries one row per finding.

---

## 1. Preconditions — before a single line is written

These are not ceremony. Each was measured on 2026-09-04 and each is currently false.

| # | Precondition | Measured now | Why it blocks |
|---|---|---|---|
| P1 | Work starts from a known base on a clean tree | **`HEAD` is on `fix/first-run-price-list-offers-the-action`, not `main`, with 4 modified product files** (`PriceListReviewConfirmation.tsx` + its spec, both dictionaries) **and 442 untracked files** | A PR cut from here carries another agent's work-in-progress into a money-and-identity change. `No git add -A` does not prevent that — only an isolated base does. |
| P2 | An isolated worktree, its own branch, and a named-file staging allowlist per PR | not created | The repo has permanent litter (`__pycache__`, brand assets, tool output). One `git add -A` swept 313 files into a one-line commit on 01.09. |
| P3 | Every number drawn at the moment it is used | `npm run next-number` reads live branches too | Six numbering collisions in one campaign on 01.09, all silently merged by git. |
| P4 | A baseline `npm run verify` on an **idle** machine | last run had 3 timeouts under CPU load from a concurrent review; `check:contrast` **passes** when run alone | Otherwise a pre-existing red is reported as caused by this work, or a real red is dismissed as "environmental". |
| P5 | Sole occupancy of the machine's QA lock | another agent is editing this repo right now | The heavy gate and the local Supabase stack are single-occupancy. |

**P1 and P2 are the first commit of this campaign, not part of a wave.**

---

## 2. Decisions — settled 2026-09-04

All seven were put to the owner and answered. They are recorded as rulings **#350-#356** in
`docs/OPEN-DECISIONS.md`, which is where they are maintained; this section says only what each one
means for the work below.

| ruling | question | answer | what it changes here |
|---|---|---|---|
| #350 | when is an invoice's money committed? | **at approval, not at creation** | A2 enforces at `p1_transition_payment_request` under the invoice lock, first-committer-wins; the create screen gets a **critical** check against the printed balance. Only `approved` and `sent_for_execution` reserve. `rejected` was named in an earlier draft and **does not exist** in the enum. |
| #351 | how is employee data hidden? | **column grants, in two phases** | A5 splits into two PRs: the client stops asking for the columns, then the migration removes them. `organizations.settings` needs **no** narrowing — measured, it holds bank-match days, money tolerances and role labels, nothing personal. |
| #352 | the entrance's enumeration oracle | **recorded as a known risk, not closed now** | Wave D keeps `ENTRY-07` (the rate-limit sentence is dead code) and `ENTRY-10`/`ENTRY-11`; `ENTRY-01` and `ENTRY-03` become a debt entry with a "before the first real customer" trigger. A proxy was rejected because the browser holds the anon key and calls `/auth/v1` directly. |
| #353 | recording a transfer larger than the balance | **accept it; the excess becomes a supplier advance** | A3's server half is unblocked and needs a named contract: the advance's currency, its place in the monthly report, its reconciliation path, its idempotency, and how the exception closes. It replaces today's `allocation_exceeds_balance` refusal at `/pay` — and **only** there. |
| #354 | the dark-mode atmosphere | **the orb is off in dark** | F2 becomes a small, safe change: no glow in dark, the approved 17% untouched, the light theme unchanged to the pixel, and `--color-ink-muted` not repainted. `DESIGN.md` moves in the same commit. |
| #355 | can a Google-authenticated owner end the service? | **no, and the screen says so** | A1 adds a sentence in place of an unfillable password box. Federated step-up is not built: there is no such owner today. |
| #356 | the on-time threshold | **five receipts, `—` below that** | C3 is unblocked. `Suppliers.tsx` moves to the same threshold — two screens will not hold two rules for one word. |

An eighth was raised by the review of this plan and answered the same day: ruling **#357** widens
`PERM-01` from employee data to **all four** surfaces behind the refused settings screen —
`profiles`, the full `organizations` row, `org_flag_configurations` and `org_autonomy_policies`.
Ruling #351 had answered "how do we hide employee data", which is a narrower question than the
finding asked.

**Three decisions remain open, and each blocks a specific PR:**

| what | who decides | what it blocks |
|---|---|---|
| `MON-04` — which of the two 2,950.00 allocations is real | owner | the data half of PR 11; the trigger itself does not wait |
| The sweep's leftover data in the live tenant | owner | gate G6; soft-delete only, from the id list in the manifest |
| `DASH-01` — does `/alerts` widen its coverage, or stop calling itself the full queue | owner | PR 26, marked BLOCKED |

## 3. The work

Each group states its **root cause** (verified against the tree), the **files**, and the **oracle**
that fails before the fix and passes after. Groups are the PR unit. Waves are only an ordering.

### Wave A — money and identity

**A1 · `OWN-01`, `RTL-A11Y-01` — an org-wide switch with no confirmation**

Owner ruling #140 states the request and the cancellation take **no reason**, and
`offboardingContract.spec.ts:28` locks that in — so the report's "audited with no reason" half is
the product working as decided. What #140 *does* require is "לאחר אימות מחדש", and that is what is
broken: `Settings.tsx:883` leaves `skipWhenFresh` at its `true` default, so `ReauthModal.tsx:160`
fires `onConfirm` before paint whenever the JWT carries a `password` AMR under four minutes old —
the ruling's re-authentication is skipped exactly when someone has just signed in and walked to
settings. One click, no dialog, the whole organisation read-only.

- Files: `src/pages/Settings.tsx`, `src/pages/offboardingContract.spec.ts`. **No migration.**
- Change: `skipWhenFresh={false}` and a `details` sentence naming the read-only switch and the
  30-day window, on the request and the cancel branch.
- Oracle: a component test that mounts Settings with a JWT holding a fresh `password` AMR, clicks
  the offboarding button, and asserts the step-up dialog **renders** and the RPC is not called
  until it is satisfied. It fails on today's code.
- Also closes the Google-owner gap by ruling #355: an owner with no password identity is told
  so, in place of a password box they cannot fill.

**A2 · `MON-01`, `REQ-02`, `REQ-03`, `REQ-05` — two approved requests over one balance**

Root cause verified at `0073:441-453`: the allocation guard subtracts `payment_allocations` and
offset/closed `credit_requests` and nothing else. `p2_active_payment_request_total_by_currency()`
(`0219:134`) cannot help — it aggregates the whole organisation per currency, not per invoice.
Client side, `checks.ts:257` derives its only critical balance check from
`over_allocated_invoice_count`, which the server computes from **existing**
`payment_request_invoices` rows and is therefore structurally 0 for a request that does not exist
yet; the other signal is mapped to `severity: 'warning'`, so 999,999.99 against a 150.00 balance is
amber with a green enabled submit.

- Files: a new migration (anchored patch), `src/lib/checks.ts`, the payment-request create screen.
- Change: per ruling #350 — approval reserves, creation warns critically. **The function may not be re-declared from `0073`** — `0231`
  rewrote both `create_payment_request` and `p1_transition_payment_request` by anchored replacement
  and registered them in `private.scope_definer_enforcements` (`0231:8,175,256-266`). This is an
  anchored patch against the live body with the enforcement rows updated and the signature
  unchanged, so no open tab breaks.
- Oracle: a SQL suite that creates request 1 for part of a balance, approves it, creates request 2
  for the whole balance, and asserts the second is refused with a named code — plus a two-session
  concurrency case where both approvals race and exactly one wins.
- Shaped by ruling #350.

**A3 · `FIN-03`, `FIN-10`, `MON-05`, `REQ-01` — a queue that would over-pay, and a button that
contradicts the block above it**

Both queued transfers target invoices whose balance is already zero; the dialog shows no balance;
the product already has an open duplicate-payment exception for one of them and the screen says
nothing. Separately, an enabled "ההעברה בוצעה" sits under a block stating the transfer cannot be
performed, and an enabled approve button sits under a panel stating approval is impossible.

Ruling #353 decides the shape: **the recording is always accepted.** So the primary action is
never disabled on a settled invoice — an earlier draft of this plan said it should be, which
contradicted the ruling and the sweep's own note that recording a completed transfer is a
legitimate act. What goes is the **contradiction**, not the capability: today an enabled
"ההעברה בוצעה" sits under a panel saying the transfer cannot be performed.

- **Screen:** show the invoice's live balance beside the amount, mark a queued request whose
  invoice has since been settled, surface the tenant's open duplicate-payment exception, and stop
  rendering a block that the button beneath it ignores. Information, not prohibition.
- **Server:** accept the recording and route the excess to a **supplier advance**. That needs its
  own contract — the advance's currency, its row in the monthly report, its reconciliation path,
  its idempotency, and how the exception it opens is closed — and its own PR. It replaces
  `allocation_exceeds_balance` (`0031:690`) **at `/pay` only**; the guard at request time (#350)
  stays, because there no money has moved yet.
- `REQ-01` does **not** belong to this group. It is a `/payment-requests` defect — an enabled
  approve button under a panel saying approval is impossible, a refusal naming a cause that did not
  happen, and an instruction that changes nothing. Its oracle is on that screen and it gets its own
  PR.
- Oracle: a browser scenario that opens `/pay` with a settled invoice in the queue and asserts the
  live balance is visible, the queued request is marked settled, and **no red block claims the
  transfer cannot be performed** — the primary stays enabled, because ruling #353 says the
  recording is always accepted. `MON-05` measured that block on every card and then performed the
  recording twice. A screenshot is read and compared, per the project rule that a visual change is
  not finished without one.

**A4 · `MON-04` — one bank line, two full allocations**

A 2,950.00 ILS statement line carries two confirmed allocations of 2,950.00 to the same invoice —
200% of the line, in production, on no screen.

- A `CHECK` cannot express a cross-row aggregate. This is a **constraint trigger** on
  `bank_allocations` that fires on `INSERT`, `UPDATE` **and** re-assignment between transactions,
  sums **confirmed** allocations only, respects the currency's minor units and the tolerance the
  product already defines, and locks the `OLD` and `NEW` transaction rows **in a fixed id order**
  so two sessions cannot deadlock or interleave.
- Migration required. Plus a read surface.
- Oracle: a SQL suite with a two-session race and an allocation moved from one transaction to
  another.
- The existing 200% row is **a data decision for the owner** — which allocation is real.

**A5 · `PERM-01` — colleague phone numbers and recovery addresses, to every role**

Measured, not inferred: `qa/out/permissions/settings-data.json` shows office and accountant each
receiving `profiles` 200 / 6 rows with `phone` and `backup_email`, and `organizations` 200 / 1 row
including `settings`.

Following the `bank_details` precedent (`0088:15`, `0112:16,51`), and the multi-tenant rule that
**application filtering is a suggestion and the database is the enforcement**:

- Revoke the table `SELECT` from `authenticated` and re-grant an explicit projection derived from
  the catalogue, so a column added later is unreadable by default.
- `backup_email` is regranted to nobody: nothing in the product reads it (the team table draws
  `full_name`/`role`/`phone`/`status`, `Settings.tsx:504-517`) and `public.my_backup_email()`
  already answers the self question (`0255`).
- `phone` moves behind a `security definer` directory function registered in the exemptions ledger
  with an exact signature, `search_path`, tenant and role checks, and **negative** tests —
  `check:exemptions` requires the record and `ENTERPRISE-SECURITY-MODEL.md:155` requires the proof.
- **Both** client readers are converted: `Settings.tsx:120` (team) and `AuthContext.tsx:147`
  (self), both `select('*')` today.
- A new `check:profile-columns` guard mirrors `scripts/check-supplier-columns.ts`, so a future
  `select('*')` fails the build instead of the browser — the same reason that guard exists.
- Oracle: `has_column_privilege` asserted **both ways** for owner, office, accountant and a
  cross-tenant identity; and a seed with three tenants, because one hides every isolation bug and
  two hide the asymmetric ones.
- Rulings #351 **and #357**: two-phase rollout, client first, across **all four surfaces the
  finding names** — `profiles`, the full `organizations` row, `org_flag_configurations` and
  `org_autonomy_policies`. An earlier draft of this plan closed only `phone` and `backup_email` and
  excused the rest on the grounds that they hold nothing personal. That answered a different
  question: the finding is that a role the product **bounces off the screen** still receives
  everything behind it. Flags and autonomy policies change what a user sees, so a blanket revoke
  can break screens — what each role genuinely needs is served by a focused reader, not by the
  table.

**A6 · `PERM-02`, `PERM-03`, `PERM-05` — the password-change audit rows**

`PERM-02` (the accountant reads rows they are the subject of none of) is a real scoping fix and
proceeds. `PERM-05` (two rows 1.4 s apart) is **diagnosed before anything is touched**:
`supabase/tests/p4_flags_identity.sql:1025` already proves one mutation writes one row, and
`docs/ROLLOUT-0291-0314-20260904.md:123` records a set **and** a restore during the rollout — it
may be correct behaviour. `PERM-03` (2 of 3 owner reads time out) gets
`EXPLAIN (ANALYZE, BUFFERS)` before an index is proposed; one already exists for the cross-scope
path. Migration likely for `PERM-02`.

### Wave D — the entrance _(ahead of every non-security wave)_

`ENTRY-01`, `ENTRY-03`, `ENTRY-04`, `ENTRY-07`, `ENTRY-09`, `ENTRY-10`/`PERM-04`, `ENTRY-11`.

Ruling #352 records the two oracles as known risk rather than closing them, because a proxy is
  bypassable. Proceeding inside this wave: `ENTRY-07` (the rate-limit sentence is
dead code because the live message does not match `/rate limit|too many/i` at
`ForgotPassword.tsx:39` — **the live message text is captured before the regex is touched**),
`ENTRY-10`/`PERM-04` (no 404; every unknown path silently lands on the dashboard), `ENTRY-11`.
`ENTRY-09` (a stranger can register any address and block it forever) is GoTrue configuration plus
the cleanup policy in `0289`/#332 — an owner decision, not repository code.

### Wave B — every step succeeded and the output was zero

**B1 · `DOC-01`..`DOC-04`, `DOC-06`, `DOC-08` — three documents read perfectly, zero records**

Root cause verified: `0108:306-317` accumulates a line into `v_lines_net` **only** when
`quantity`, `unit_price` and `line_total` are all non-null, and `0108:604` emits `null` (→ `—`)
only when there are **zero** line rows. Twenty-two rows that all fail the guard therefore emit a
measured `0.00`, and `0108:568` turns that zero into the blocking
`header_total_differs_from_lines` — a fabricated number the constitution forbids, driving a block
the user cannot clear, beside a panel saying the numbers reconcile.

Two corrections to the round-1 version:

- **The ancestor is not `0108`.** `document_reconciliation_assessment` was patched by `0227`,
  `0244`, `0260` and `0284`. This is an anchored patch against the live body that preserves every
  rung the ladder now publishes.
- **Zero-of-N is not the only broken case.** If 21 of 22 lines contribute, the plan would still
  compare a partial subtotal to a full header and produce a *different* false block. So
  `lines_net` carries **coverage** — how many lines contributed of how many exist — and is
  **not comparable** to the header unless coverage is complete.

`DOC-01` (the library labels a scan-approval wait as "לא משויך") has its own cause:
`documentStatus.ts:316-325` has states for `review` and for `unassigned` and **no state for
"waiting for scan approval"**, so such a document falls through to the residual `unassigned` and is
told to be attached to an invoice — an action that neither starts the reading nor is yet possible.
The fix adds the missing state ahead of `isUnassigned`, with a link into the review screen.

- Oracle: a SQL suite feeding a 22-line document whose lines carry totals but no unit price, and
  asserting `lines_net` is `null` with incomplete coverage and that the blocking finding names the
  real obstacle. Plus a harness screenshot of the review screen.

**B2 · `DOC-05`, `DOC-13`, `MON-07`** — draft dated today instead of the extracted date; VAT
labelled 17.5% while both documents print 18.00%; the tenant's only consolidated-invoice case stuck
24 hours at "awaiting recognition". **`DOC-13` depends on `OWN-12`** (the tenant's configured VAT
matches neither the code default nor the documents) — so that decision moves **out of Wave H and
into this group**, or `DOC-13` cannot be closed.

**B3 · `PL-01`, `PL-02` — the second door drops rows in silence**

Four defects in one file, all verified:

- `PriceLists.tsx:475` destructures `const { valid } = mapRows(...)` and drops `skipped`. The
  sister door `PriceListUpload.tsx:268` binds and renders it — same product, one door hides the
  refusals.
- `importSheet.ts:156-176` **already** passes the source `rowNumber` to the callback, which
  `PriceLists.tsx` ignores; `:503` then does `unresolved.push(index + 2)` over the **filtered**
  preview, naming row 3 for a problem on row 9.
- `:508-511` discards the resolvable rows along with the unresolvable ones.
- `:494-499` reads suppliers and products unpaged — this **is** `PL-10`, and `PL-10` is therefore
  **in this group, not out of scope**; the sweep listed it as code-level-only because it was not
  reproduced live, which is a statement about evidence, not about the defect.
- Oracle: a unit test over an 8-row sheet with 6 unreadable prices asserting the skipped panel
  lists 6 rows with their **source** numbers, and that the one resolvable row is either imported or
  refused with an explicit all-or-nothing message.

**B4 · `PL-04`, `PL-05`, `PL-11`, `PL-12`, `PROC-02`** — a named server refusal shown as "contact
support" while the cause is on screen; an approved canonical name importing as a new product; a
price list classified "הצעת מחיר" with no route to becoming prices; two intake doors keyed
differently (name vs SKU/barcode); the manual price editor bypassing the `0298` parser so `12,50`
stores as 1,250.00. **`PROC-02` is a money-shape defect and is promoted into Wave A's PR order.**

**B5 · `OWN-02`, `OWN-07`, `OWN-08` — 737 decisions with nothing to decide**

`DocumentOperations.tsx:294` renders `current_unit_price ← proposed_unit_price` unconditionally,
while `get_document_control_price_review_queue` (`0225:96`) emits a **run-level** row with all
`line.*` null when a document produced no lines — the `is_empty_run` flag exists and the decision
column already reads it, but the price column does not. **The queue's rows are read from production
before the fix**, because "every row is an empty run" and "the price columns are never populated"
need different fixes and only the data distinguishes them.

**B6 · `PROC-01`, `PROC-03`, `PROC-04`, `PROC-07` — the safety net that never worked**

`ReceiptConflictDialog.tsx:187,189,227` selects and orders by `goods_receipts.created_at`, a column
`0001_init.sql:174-183` never defined and no migration added: HTTP 400 / `42703`, every time, for
every role, since 2026-08-06. The product's designated recovery path re-reads nothing, shows every
server field as `—`, and blocks re-submission "until a successful re-read" that can never happen.
`:215`'s `?? relevant.created_at` fallback points at the same absent column. Use `received_at`.
Plus: over-receipt accepted by the form and refused only after "סיום קבלה"; the dialog blaming
another person and an offline device for a quantity typed seconds earlier online; the same
paragraph printed twice.

- Oracle: a test that asserts the re-read query selects only columns that exist — cheapest possible
  guard against the whole class.

### Wave C — one trustworthy picture (§12)

`DASH-01`..`DASH-06`, `DASH-09`..`DASH-13`, `FIN-01`, `FIN-02`, `FIN-04`, `FIN-06`, `FIN-07`,
`FIN-09`, `MON-02`, `MON-03`, `MON-06`, `MON-09`, `REQ-04`, `REQ-06`, `ASSIST-06`, `ASSIST-07`,
`ASSIST-09`, `ASSIST-12`. (`DASH-07`/`DASH-08` are export defects and live in Wave E.)

**C1 — one mismatch, four findings.** `0218_balances_are_read_per_currency.sql` holds both halves
and they disagree. `p0_invoice_balance_rows_by_currency()` ends with
`auth_role() = 'owner' or (auth_role() = 'accountant' and i.review_status = 'approved')`
(`:89-93`), so an unapproved invoice yields **no balance row** for the accountant.
`p0_supplier_balance_rows_by_currency()` (`:118-130`) joins `public.invoices` with **no such
predicate**, then `left join`s the balances and applies `coalesce(sum(...), 0)`. The accountant's
screen therefore prints **`$0` against a real `$300` debt**, directly under the banner promising an
em dash and never a zero. `MON-03`, `FIN-04` (whose own diagnosis — "a phantom row on a supplier
with no dollar activity" — is wrong), and the shape of `FIN-07` all fall out of it.

Fix: the same role predicate on the supplier function's `invoices` join, so an invoice the role
cannot value produces **no row**, not a zero. **The scope is never widened** — the accountant's
narrower population is a deliberate trust boundary (`ENTERPRISE-SECURITY-MODEL.md:94`), and making
the numbers agree by granting more rows would be a privilege leak dressed as a §12 fix. The label
carries the scope instead.

**C2 — tiles that link to lists they did not count** (`DASH-03`..`DASH-06`): each tile's query and
its link's filter are written independently; the link inherits the count's predicate or the tile
stops claiming it.

**C3 — `DASH-02`**: `Analytics.tsx:19` returns `'idle'` below 5 samples but `:54` renders
`fmtPct(...)` unconditionally — the threshold picks a **colour**, never a value. Ruling #356: five receipts, `—` below that, and `Suppliers.tsx:804` moves to the same threshold.

**C4 — `DASH-01`**: `/alerts` runs six named scans (`lib/alerts.ts:212-219`) while the dashboard
counts a different population, and `/alerts` calls itself the full queue. Coverage or copy — the
mechanism for naming uncovered scans already exists (`alertsPage.partialScan`). Owner decision.

### Wave E — exports

`EXP-01`..`EXP-10`, `DASH-07`, `DASH-08`.

`DASH-08`/`EXP-02`: `Reports.tsx:444` links to `/reports/products` with no month and
`ProductPurchaseSummary.tsx:80,87-88` has no `useSearchParams` — `from` defaults to the current
month's first day and `to` to today, so a July report opens and exports September.

Workbook rules for this wave, from the spreadsheet discipline and the constitution together:
**zero formula errors**; a measured zero renders as the same marker the screen uses and "no data"
never becomes `0.00`; existing template conventions win over any general style; every sheet states
its window; and **no sheet, section or cell may add two currencies** — a currency gets its own
sheet or its own section. Every generated workbook is recalculated and scanned for `#REF!`,
`#DIV/0!`, `#VALUE!`, `#NAME?` before it is called done.

### Wave F — mobile, RTL, contrast

`RTL-A11Y-02`..`RTL-A11Y-12`, `DOC-07`, `DOC-10`, `ENTRY-02`, `ENTRY-05`, `ENTRY-06`, `ENTRY-08`,
`ENTRY-12`, `PL-09`, `PROC-05`.

**F1 — one shared cause, but not one line.** `ui.tsx:2216` renders the mobile card from
`visibleColumns.filter((c, i) => (c.priority ?? 2) <= 2 …)`, so a `priority: 3` column is excluded
**unconditionally**, while `:2432-2436` shows the checklist *is* in the mobile sheet, toggling a
`columnVisibility` the priority filter then overrides. Making an explicit picker choice win closes
**`RTL-A11Y-02`** and nothing else — because only `/payments`, `/invoices` and `/bank` pass
`columnPicker` at all. `/prices`, `/suppliers` and `/reports` pass none, so on those three there is
nothing for a viewer to turn on and `RTL-A11Y-03`, `-04`, `-05` need the picker added as well. An
earlier draft claimed one line closed four findings; measured, it closes one.

**F2 — `RTL-A11Y-06`, `-07`**: per ruling #354 the orb is off in dark. Measured on composited pixels in both themes, and
`DESIGN.md` moves with `src/index.css` in the same commit.

**F3 — the bidi filename** (`DOC-07`, `RTL-A11Y-08`): `<bdi>` and `dir="auto"` do not fix a name
whose first strong character is Hebrew — `auto` resolves RTL and the Latin extension reorders
anyway, which is why `fileNameIsolation.spec.ts` is green while the screen is wrong. **Keep the
source scan**, narrow the sanctioned form to an explicit LTR isolate, and **add** a rendered
measurement with mixed-script names — a source scan proves coverage, not pixels.

**F4 — Hebrew plural agreement** (`ENTRY-08`, `PL-09`, `PROC-05`, and `FIN-05`'s raw key): Hebrew
has more than two plural categories, so these go through the ICU plural machinery the repo already
guards with `check:plurals`, never through string concatenation.

**F5 — `ENTRY-02`**: `/pricing` on a phone hides all 52 entitlement rows with no control to open
them, on the only public page that says what the product does.

Every fix in this wave is verified by a screenshot taken with the local harness at 1440×900 and
390×844 and **read**, compared against the desktop reference — not against memory. Screenshots go
to the session scratchpad, never `/tmp`.

### Wave G — the assistant

`ASSIST-01`, `ASSIST-03`, `ASSIST-05`, `ASSIST-08`, `ASSIST-10`, `OWN-06`.

`ASSIST-01`: `AssistantPanel.tsx:72-93` evaluates its guard at panel-open and then awaits twice;
`runSession.ts:196-200` re-checks only `inFlightRef` and the fingerprint — and a request that has
**settled** has already cleared `inFlightRef`. So history adoption overwrites the question the
person just asked and its outcome, and fast outcomes (every error path) are exactly the ones inside
the window. The guard must also refuse once the person has asked anything in this panel session.

`ASSIST-03`/`ASSIST-05`/`ASSIST-10`: a metered feature whose meter appears nowhere, one refusal code
for six different ceilings, and an entitlement override that cannot lift the ceiling during the
first 30 days because the intro branch returns before the override is read.

### Wave H — settings, webhooks, ledger, long tail

`OWN-03`, `OWN-04`, `OWN-05`, `OWN-09`..`OWN-15`, `PERM-06`, `FIN-05`, `FIN-08`, `MON-08`,
`MON-10`, `PL-03`, `PL-06`, `PL-07`, `PL-08`, `REQ-07`, `DOC-09`, `DOC-11`, `PROC-06`, `PROC-08`,
`ASSIST-04`, `DOC-12`. (`ASSIST-11` is **not** here — the report withdrew it. `DOC-12` is, because
its own record carries an acceptance criterion.) (`OWN-12` moved to B2; `PERM-06` was missed twice and caught by the
ledger's own completeness check.)

---

### The findings that were only covered by a range

Twenty-six ids were in scope by range (`DASH-01`..`DASH-06`, `RTL-A11Y-02`..`-12`, `EXP-01`..
`EXP-10`, `OWN-09`..`OWN-15`) but had no cause of their own. They do now. Each line below was
read in the file it names, except the four marked **measure** — those are recorded as unproven
rather than guessed, which is the difference between a plan and a wish.

| id | root cause | state |
|---|---|---|
| `DASH-04` | the tile's count and its link's filter are written independently, and `/receiving` has no "late" filter for the link to carry | verified in code |
| `DASH-05` | same shape: `/orders` has no "open, no delivery date" filter, so the link opens 254 rows | verified in code |
| `DASH-10` | the open-credits predicate counts a credit whose own badge reads settled, on three surfaces that all say "open" | **measure** — which predicate differs |
| `DASH-11` | `₪9 · 0%` — the amount is exact and the percentage is rounded to whole units, so a real saving prints as none | **measure** — confirm the formatter |
| `DASH-12` | the four action rows on `/alerts` are `<button>`; a queue meant to be worked through needs anchors so middle-click and open-in-new-tab work | verified in code |
| `EXP-03` | three workbook builders each pick their own representation of "no data" — blank, a literal `0`, an em dash — because no single formatter owns the empty case | verified in code |
| `EXP-04` | the provenance caveat is attached in the screen component, not in the export path, so 74 rows assert `נרכש בפועל 0` where the source is unknown | verified in code |
| `EXP-05` | an empty month writes header-only sheets and says nothing about why | verified in code |
| `EXP-06` | exceptions are fetched without the report's window predicate, so nine current rows land under a January-2020 banner | verified in code |
| `EXP-07` | the xlsx filename is built from today; the PDF button beside it is built from the window | verified in code |
| `EXP-08` | the row action labelled "ייצוא" routes to the review screen, which carries no export control | verified in code |
| `EXP-09` | the bank import template is a machine header — English keys, five columns, no currency column, no example row, no Hebrew | verified in code |
| `OWN-10` | the webhook lifecycle has deactivate and no delete, so every connection ever registered accumulates permanently. **This is why the sweep did not create one** — see the untested table in the manifest | verified in code |
| `OWN-11` | `SupplierLog.tsx:118` — `.limit(400)`, no paging and no date filter, under an empty state promising "ההיסטוריה נשמרת". 344 of 400 used, 321 of them written in one night | verified in code |
| `OWN-13` | the bank-match-days input carries no `min`/`max` while the VAT field beside it does | verified in code |
| `OWN-14` | `/onboarding` opens pre-filled from the live organisation and nothing marks its first button as a write to it | **measure** — confirm the write path |
| `RTL-A11Y-03`, `RTL-A11Y-04`, `RTL-A11Y-05` | **already F1**: `ui.tsx:2216` excludes `priority: 3` from the mobile card unconditionally, over the picker. One cause, and `RTL-A11Y-02` makes four | verified in code |
| `RTL-A11Y-07` | the mandated `—` is drawn in `text-ink-faint` (`Suppliers.tsx:989`, `PriceLists.tsx:168,171,181`) — the token `DESIGN.md` reserves for decoration. A required assertion in a decorative colour, at 1.9:1 | verified in code |
| `RTL-A11Y-09` | `ui.tsx:1987` announces `role="dialog"` on a popover that deliberately does **not** contain focus, and `:1920-1922` shows Escape calling `close(true)`, which returns focus to the trigger. But the sweep **measured** focus landing on a row button instead, and reading the source is not a runtime proof — an earlier draft called the finding refuted on that basis, which was wrong. Re-measure live first; then either it becomes a real dialog or it stops announcing itself as one | **measure** — code intent read, runtime contradicts it |
| `RTL-A11Y-10` | `Dashboard.tsx:169` renders the hero figure inside `dir="ltr"` while the same formatter (`fmtMoneyRounded`) renders elsewhere in RTL — so the shekel sign lands on the other side of the number on one screen | verified in code |
| `RTL-A11Y-11` | `Suppliers.tsx:213` — the risk column carries `mobileLabel: null`, so on a phone its value is an orphan number with no field name | verified in code |
| `ASSIST-V2`, `ASSIST-V3`, `ASSIST-V4` | not defects — verified-working records | no work owed |

## 4. Dependency map

Rulings, not the old `D1`..`D7` labels — those were the question numbers while the questions were
open and no longer name anything.

```
P1,P2  isolation ............................. blocks everything
#350   money committed at approval .......... A2, and REQ-03's client check
#351   employee columns, two phases ......... A5 phase 1 (client) -> A5 phase 2 (migration)
#357   the other three settings surfaces .... A5, both phases, widened
#352   enumeration recorded, not closed ..... ENTRY-01, ENTRY-03 become debt; ENTRY-07/10/11 proceed
#353   over-balance recording accepted ...... A3 server half + the advance contract PR
#354   orb off in dark ...................... F2
#355   no password identity, say so ......... A1's second half
#356   five receipts ........................ C3
OWN-12 (the VAT rate) ........................ DOC-13 cannot close before it
DASH-01 coverage-or-copy ..................... C4 is BLOCKED until the owner rules
MON-04 which allocation is real .............. A4's data half; the trigger does not wait for it

Measure before writing, not after:
  B1  read the production document payload — which field is null decides the fix
  B5  read the 737 queue rows — "all empty runs" and "prices never populated" differ
  D   capture the live rate-limit message — ENTRY-07's regex is dead against the real string
  RTL-A11Y-09  re-measure focus after Escape; the source says one thing, the sweep measured another
  DASH-07  root cause not established by the sweep; needs a DB check before it is planned
```

**Ordering that the PR map must respect.** Wave D is placed ahead of every non-security wave in
§3. An earlier PR map contradicted that by scheduling it ninth; it is now third.

## 5. PR map

One PR per root cause. Each names the finding ids it closes and moves their `docs/GATES.md` rows.
Stacked PRs are checked normally — `build.yml:23` carries a bare `pull_request:` guarded by
`check:workflow-triggers`, so `DEBT §65` is closed.

| # | PR | closes |
|---|---|---|
| 0 | isolation: base SHA, worktree, branch, staging allowlist | P1, P2 |
| 1 | offboarding step-up, and the sentence for an owner with no password | `OWN-01`, `RTL-A11Y-01` |
| 2 | entrance: dead rate-limit message, no-404, invite refusal | `ENTRY-07`, `ENTRY-10`, `PERM-04`, `ENTRY-11` |
| 3 | entrance: the debt record ruling #352 asks for — **closes nothing**, and the ledger keeps these BLOCKED | records `ENTRY-01`, `ENTRY-03`, `ENTRY-04`, `ENTRY-09` |
| 4 | receipt conflict re-read and its three neighbours | `PROC-01`, `PROC-03`, `PROC-04`, `PROC-07` |
| 5 | settings boundary, phase 1 — the client stops asking for what it must not receive | closes nothing on its own; the finding closes with PR 6 |
| 6 | settings boundary, phase 2 — revoke, re-grant, guard | `PERM-01` |
| 7 | committed-amount guard at approval | `MON-01`, `REQ-02`, `REQ-03`, `REQ-05` |
| 8 | `/pay` stops contradicting itself | `FIN-03`, `FIN-10`, `MON-05` |
| 9 | the supplier advance: contract, report row, reconciliation, idempotency | the server half of #353 |
| 10 | `/payment-requests` approval refusal | `REQ-01` |
| 11 | bank allocation trigger | `MON-04` |
| 12 | manual price editor uses the parser | `PROC-02` |
| 13 | audit read-model scope | `PERM-02` |
| 13a | **measure first**: `EXPLAIN (ANALYZE, BUFFERS)` on the owner's read, and tie each `password_changed` row back to one Auth request. `p4_flags_identity.sql:1025` and the rollout log may already explain both | `PERM-03`, `PERM-05` |
| 14 | supplier balance role predicate | `MON-03`, `FIN-04`, `FIN-07` |
| 15 | the credits a definer counts and the reader cannot show | `MON-06` |
| 16 | multi-supplier import: skipped rows, source row numbers, partial import, paging | `PL-01`, `PL-02`, `PL-10` |
| 17 | document assessment carries coverage | `DOC-02`, `DOC-03`, `DOC-04`, `DOC-08` |
| 18 | a state for "waiting for scan approval" | `DOC-01`, `DOC-06` |
| 19 | the VAT rate, then the draft that depends on it | `OWN-12`, `DOC-13`, `DOC-05`, `MON-07` |
| 20 | mobile columns: the override, plus a picker on three screens that have none | `RTL-A11Y-02`, `RTL-A11Y-03`, `RTL-A11Y-04`, `RTL-A11Y-05` |
| 21 | the atmosphere token | `RTL-A11Y-06`, `RTL-A11Y-07` |
| 22 | assistant history guard | `ASSIST-01` |
| 23 | assistant quota: a meter, distinct refusals, the intro-window override | `ASSIST-03`, `ASSIST-05`, `ASSIST-08`, `ASSIST-10`, `OWN-06` |
| 24 | dashboard tiles link to what they counted | `DASH-03`, `DASH-04`, `DASH-05`, `DASH-06` |
| 25 | dashboard and alerts arithmetic | `DASH-09`, `DASH-10`, `DASH-11`, `DASH-12`, `DASH-13`, `ASSIST-12` |
| 26 | `/alerts` coverage or copy | `DASH-01` — **BLOCKED** on an owner ruling |
| 27 | on-time threshold on both screens | `DASH-02` |
| 28 | credits: one answer to "are there open credits" | `FIN-01`, `FIN-02`, `FIN-06`, `FIN-09`, `MON-02`, `MON-09` |
| 29 | proposals and receipts become discoverable | `REQ-04`, `REQ-06` |
| 30 | assistant citations that match their claim | `ASSIST-06`, `ASSIST-07`, `ASSIST-09` |
| 31 | the month that travels | `DASH-08`, `EXP-02` |
| 31a | **measure first**: why every cost column on the products report is empty. Its own record says a database check is needed, so no oracle can be written before it | `DASH-07` |
| 32 | one empty-cell rule, one window header, per-currency sections | `EXP-01`, `EXP-03`, `EXP-05`, `EXP-06` |
| 33 | export provenance and naming | `EXP-04`, `EXP-07`, `EXP-08`, `EXP-09`, `EXP-10` |
| 34 | bidi file names: tighten the guard, add the rendered check | `DOC-07`, `RTL-A11Y-08`, `DOC-10` |
| 35 | Hebrew plural agreement and a raw key | `ENTRY-08`, `PL-09`, `PROC-05`, `FIN-05` |
| 36 | the public pricing page on a phone | `ENTRY-02`, `ENTRY-05`, `ENTRY-06`, `ENTRY-12` |
| 37 | column chooser: dialog or disclosure, after re-measuring | `RTL-A11Y-09`, `RTL-A11Y-10`, `RTL-A11Y-11`, `RTL-A11Y-12` |
| 38 | price intake: the second door's keys, names and refusals | `PL-04`, `PL-05`, `PL-11`, `PL-12`, `PL-03`, `PL-06`, `PL-07`, `PL-08` |
| 39 | the operations console has numbers to decide on | `OWN-02`, `OWN-07`, `OWN-08` |
| 40 | webhooks: a last step, a failure that says so, validation while typing | `OWN-03`, `OWN-10`, `OWN-15` |
| 41 | the audit ledger stops dropping history | `OWN-11`, `OWN-04`, `OWN-05`, `PERM-06` |
| 42 | settings bounds, tolerance shape, the wizard's first button | `OWN-09`, `OWN-13`, `OWN-14` |
| 43 | refusals that arrive as HTTP 500 | `REQ-07`, `DOC-09`, `DOC-11`, `PROC-06`, `PROC-08` |
| 44 | the bank un-match reason the client defeats with a placeholder | `FIN-08`, `MON-08` |
| 45 | the currency printed twice on one label | `MON-10` |
| 46 | a suggested question the asking role cannot have answered | `ASSIST-04` |
| 47 | the goods-receipt route nothing links to | `DOC-12` |

Forty-eight PRs. Every one of the 138 actionable ids appears in the `closes` column of exactly
one — checked the same way the wave placement is. Two rows deliberately close nothing and say so:
PR 3 records the entrance oracles as debt because ruling #352 says they are not closed now, and
PR 5 is the client half of a two-phase boundary whose finding closes only when PR 6 lands. PR 31a
exists because `DASH-07` has no root cause yet and a PR that pretends otherwise is worse than one
that says "measure this first". There is no remainder row.

## 6. Not repository code

Each gets its own decision record with the exact action, the rollback, the evidence that closes it,
and a `BLOCKED` status until performed — "not a code fix" is not a disposition.

- `MON-02`/`FIN-02` — 150 ILS unclaimable: stale data. The sweep proved the mechanism works by
  creating and offsetting a fresh credit.
- `MON-04`'s existing 200% allocation — which row is real.
- `ENTRY-09` — GoTrue configuration plus the `0289`/#332 cleanup policy.
- `ENTRY-04` — a manual production switch with no evidence it ran.
- The sweep's own data still in the live tenant (orders #272/#273/#274, receipt #24, payment
  requests #16-#22, credits #11/#12, three documents in "נדרשת בדיקה"): financial rows are
  soft-delete-only, so this needs an explicit id list, an authorised domain action per row, owner
  approval and before/after counts. **No hard `DELETE`.**
- Three things the sweep could not restore: the `מחיר קודם` column on six products, one invoice
  moved to "בבדיקה" with no path back, one product display name that left the approval queue.

## 7. `CLAUDE.md` is stale in four places

Measured against HEAD, not remembered. Correcting it is part of this work.

1. `DEBT §65` is closed — `build.yml:23` has a bare `pull_request:` and a guard.
2. `npm run verify` is **32** sub-commands and `build.yml:265-278` runs **fourteen** of them by
   name — an earlier draft of this very correction said thirteen, off by one, which is precisely
   the error it was written to correct. The stale count is not only in `CLAUDE.md`:
   `build.yml:252-255` still says "THIRTEEN of the 26 guards … 13 named here, 13 silent" directly
   above the fourteen it now runs, so **the workflow's own comment is corrected in the same PR**.
   The guards debt is **§105**, not §97 — §97 is `my_entitlements()`. And `check:contrast`
   **passes** when run alone on a clean tree, which replaces the claim that it never has; its log
   path is recorded under gate G2.
3. `check:contrast` **passes** on a clean tree, run alone. The claim that it never has is wrong.
4. Migrations reach production through `scripts/rollout-apply.ps1`, which applies, writes the
   ledger row and verifies as one sequence and stops without a row on failure. "Add the ledger row
   by hand" is a recipe for a half-applied rollout.

## 8. Out of scope

- The eight findings that are not defects, listed in full at the end of `docs/GATES.md`. `PL-10`
  and `DOC-12` were on that list in an earlier draft and are not on it now: both are real defects.
- Rewriting the OCR engine — extraction was measured accurate on every field of three documents;
  every defect is downstream of it.
- `worker/ocr` and `worker/render`, unless a group changes a gateway contract version — in which
  case that group redeploys the VPS in the same rollout.
- New features. Nothing here adds a capability the product does not already claim.
