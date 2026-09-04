# Plan: remediate the 2026-09-04 live-site QA sweep

_Written 2026-09-04 by Claude, after reading the sweep, verifying its causes against the tree, and
two adversarial review rounds. Status: **PLANNED / NOT_IMPLEMENTED**. No product code written._

## 0. What this is

Thirteen QA agents swept `app.inplace.digital` on 2026-09-04 in three identities and produced
**146 structured findings** with file:line causes, 605 screenshots and 273 measurement files.
Zero confirmed regressions from the Wave 0-8 rollout — 130 of the 146 pre-date it. This is debt
collection, and the owner asked for the full scope.

**137 actionable · 9 not defects** (`ASSIST-V1`..`V4` verified-working, `EXP-R1`/`PERM-R1`/`OWN-16`
retractions, `PL-10` code-level only, `DOC-12` unchanged). `ASSIST-02` was never issued — the ids
run 01, 03-12, V1-V4 and 146 is the true total. Every id is placed in exactly one wave and the
placement is checked mechanically, which is how `PERM-06` was caught after being missed twice.

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

Two things these answers did **not** dissolve, and they stay owner decisions of their own:
`MON-04`'s existing 200% bank allocation (which of the two rows is real) and the sweep's leftover
data in the live tenant. Both are in §6.

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
- Change: per D1's chosen model. **The function may not be re-declared from `0073`** — `0231`
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

- The **screen** half is unblocked: show the live balance, mark queued requests whose invoice is
  settled, surface the open exception, and never render an enabled primary under a blocking panel.
- The **server** half follows ruling #353: the recording is accepted and the excess becomes a
  supplier advance. It needs a named contract before it is written.
- Oracle: a browser scenario in the QA harness that opens `/pay` with a settled invoice in the
  queue and asserts the balance is visible and the primary is disabled; plus a screenshot read and
  compared, per the project rule that a visual change is not done without one.

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
- Ruling #351: two-phase rollout, client first. `organizations` needs no narrowing — its
  `settings` column was measured and holds no personal data and no secret.

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

**F1 — four findings, one line.** `ui.tsx:2216` renders the mobile card from
`visibleColumns.filter((c, i) => (c.priority ?? 2) <= 2 …)`, so a `priority: 3` column is excluded
**unconditionally** — while `:2432-2436` shows the column checklist *is* in the mobile sheet,
toggling a `columnVisibility` the priority filter then overrides. An explicit picker choice must
win over the priority default. Closes `RTL-A11Y-02`..`-05` at `ui.tsx`, not on four pages.

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
`ASSIST-04`, `ASSIST-11`. (`OWN-12` moved to B2; `PERM-06` was missed twice and caught by the
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
| `RTL-A11Y-09` | `ui.tsx:1987` announces `role="dialog"` on a popover that deliberately does **not** contain focus. **Half the report is wrong**: `:1920-1922` shows Escape calls `close(true)`, which returns focus to the trigger, and `:1934-1949` shows Tab entering and leaving by design. The defect is the mismatch between what it announces and what it is — the fix is to stop calling it a dialog, not to trap focus in it | verified in code, **finding partly refuted** |
| `RTL-A11Y-10` | `Dashboard.tsx:169` renders the hero figure inside `dir="ltr"` while the same formatter (`fmtMoneyRounded`) renders elsewhere in RTL — so the shekel sign lands on the other side of the number on one screen | verified in code |
| `RTL-A11Y-11` | `Suppliers.tsx:213` — the risk column carries `mobileLabel: null`, so on a phone its value is an orphan number with no field name | verified in code |
| `ASSIST-V2`, `ASSIST-V3`, `ASSIST-V4` | not defects — verified-working records | no work owed |

## 4. Dependency map

```
P1,P2 (isolation)  ──────────────────────────────► everything
D1 ──► A2                     D4 ──► A3 server half
D2 ──► A5                     D5 ──► F2
D3 ──► ENTRY-01, ENTRY-03     D6 ──► A1 (Google owners)
D7 ──► DASH-02 (C3)
OWN-12 (VAT) ──► DOC-13       B5 needs production rows read first
B1 needs the document payload read first   D3 needs the live 429 message captured first
A5 needs a two-phase rollout: client projection ships BEFORE the migration
```

## 5. PR map

One PR per root cause, each naming the finding ids it closes and updating their `GATES.md` rows.
Stacked PRs are checked normally — `build.yml:23` carries a bare `pull_request:` guarded by
`check:workflow-triggers`, so `DEBT §65` is closed.

| order | PR | closes |
|---|---|---|
| 0 | isolation: base SHA, worktree, branch, staging allowlist | P1, P2 |
| 1 | offboarding step-up | `OWN-01`, `RTL-A11Y-01` |
| 2 | receipt conflict re-read | `PROC-01` (+ `PROC-03`, `-04`, `-07`) |
| 3 | profile + organisation projection, client first | `PERM-01` |
| 4 | profile + organisation projection, migration + guard | `PERM-01` |
| 5 | committed-amount guard | `MON-01`, `REQ-02`, `REQ-03`, `REQ-05` |
| 6 | `/pay` screen truth | `FIN-03`, `FIN-10`, `MON-05`, `REQ-01` |
| 7 | bank allocation trigger | `MON-04` |
| 8 | audit read-model scope | `PERM-02` (+ `-03`, `-05` diagnosis) |
| 9 | entrance | Wave D |
| 10 | supplier balance role predicate | `MON-03`, `FIN-04`, `FIN-07`, `MON-06` |
| 11 | multi-supplier import | `PL-01`, `PL-02`, `PL-10` |
| 12 | document assessment coverage | `DOC-02`, `DOC-03`, `DOC-04`, `DOC-08` |
| 13 | document status: awaiting scan approval | `DOC-01`, `DOC-06` |
| 14 | mobile column override | `RTL-A11Y-02`..`-05` |
| 15 | atmosphere token | `RTL-A11Y-06`, `-07` |
| 16 | assistant history guard | `ASSIST-01` |
| 17.. | the remainder, grouped the same way | C2, E, F3-F5, G, H |

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
2. `npm run verify` is **32** sub-commands and `build.yml:265-278` runs the thirteen that were
   unwired. The guards debt is **§105**, not §97 — §97 is `my_entitlements()`.
3. `check:contrast` **passes** on a clean tree, run alone. The claim that it never has is wrong.
4. Migrations reach production through `scripts/rollout-apply.ps1`, which applies, writes the
   ledger row and verifies as one sequence and stops without a row on failure. "Add the ledger row
   by hand" is a recipe for a half-applied rollout.

## 8. Out of scope

- The 9 findings that are not defects.
- Rewriting the OCR engine — extraction was measured accurate on every field of three documents;
  every defect is downstream of it.
- `worker/ocr` and `worker/render`, unless a group changes a gateway contract version — in which
  case that group redeploys the VPS in the same rollout.
- New features. Nothing here adds a capability the product does not already claim.
