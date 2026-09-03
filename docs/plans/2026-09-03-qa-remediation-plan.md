# Plan: remediation of 200 QA findings (41 critical) across InPlace

_Round 8 — Wave 0 executed. Eight gates ran; three findings changed class. See
`artifacts/w0/RESULTS.md`. Reopened after the final QA report (200 findings, 17 agents, 866 artefacts) and the
3.9 regression round. Two new verified root causes; the wave order changed._

Every root-cause claim was verified by me against this repository; every Codex refutation was
independently re-verified before acceptance. Owner rulings of 2026-09-03 are marked
**[owner 03.09]**. The full argument is in `docs/plans/2026-09-03-qa-remediation-review-log.md`.

## Goal

Turn 200 live-site QA findings into ordered work packages, each closing a category rather
than a symptom. **The owner intends to start selling within weeks [owner 03.09]** — so
everything a prospect touches, and everything that breaks under a second tenant, moves
forward.

---

## Verified root causes

Codex confirmed all six as correctly describing the live state (rounds 3 and 4).

- **RC1 — bank matching and approval.** `0023:963-978` does not check `review_status` on the
  direct branch. `0031:1219-1229` injects a check for `accountant` **only**; `0232:20-29`
  rewrites the live body for currency and preserves it. The payment-request path
  (`0073:626-663`) rejects unapproved invoices with no role condition. So `owner` can settle
  an unapproved invoice at the bank screen and cannot at the approvals screen.
- **RC2 — the price parser.** Live bodies carrying the narrow strip expression:
  `0048:1555-1568`, `0081:645-655` (renamed `0182:16-21`), `0096:697-707`. The dry-run
  replacement `'[^0-9.]'` — **not** a corrected expression, since it destroys the sign
  and swallows letters — exists exactly once in the whole history, inside
  `get_qualified_product_creation_dry_run` (`0229:38-42`). `0032` is dead: renamed at
  `0035:348-358`, replaced at `0048:1292-1308`.
- **RC3 — CORS.** Thirteen browser-invoked Edge functions; `webhook-verify`
  (`index.ts:41-53`) and `billing-checkout` (`index.ts:31-35`, `core.ts:82-95`) handle no
  CORS and no `OPTIONS`. `_shared/cors.ts:34-43` is opt-in; no gateway supplies it.
- **RC4 — VAT.** `organizations.vat_rate` has no CHECK (`0001_init.sql:22-28`); the 0-100
  check is on invoice lines (`0099:108`). Clients send free values
  (`Settings.tsx:186-190,550-551`; `Admin.tsx:122-132,430-432`).
- **RC5 — numbering.** Six `number int generated always as identity` columns
  (`0001_init.sql:129-177, 230-274`); no later migration converts them.
- **RC6 — dark table heads.** `.table-head` takes `bg-action` with `text-shell-ink-soft`
  (`index.css:1197-1206`); in dark, `action` becomes L=95% (`:652-679`) while
  `shell-ink-soft` stays L=88% (`:205-223`). The only later override is `@media print`
  (`:2377-2386`).

- **RC7 — three assistant adapters read money keys that no longer exist.** `0218`/`0221` moved
  every money key to a per-currency shape (`0218:344-347, 523-599`; `0221:107-129` returns
  `*_by_currency`). The screens followed; three adapters did not:
  `getDashboardSnapshot.ts:48-68` (`openBalance`, `overdueAmount`, `committed`, `sum`),
  `getPaymentExposure.ts:33-84` (scalar sums, emitting ILS facts), and
  `getPurchaseMetrics.ts:91-122` (`gross_expense`).
  **Two corrections Codex forced on my own wording, both fair:**
  - **It is not universally silent.** A missing key still produces a Fact with `value: null`
    plus an explicit warning that null means "not measured" (`getDashboardSnapshot.ts:95-110,
    132-136`; `he.ts:6358`), and `AnswerView.tsx:32-39` renders it as `—`. The genuinely
    silent one is `topBalances` (`:141-155`), which also hardcodes `unit: "ils"`.
  - **It is not "every financial number".** It is these three adapters; other financial tools
    still return facts. The link to the reported question-substitution is plausible but **not
    provable from the code alone**, and the plan no longer asserts it as established.
- **RC8 — a measured zero is read as failure, in TWO consumers.** When nothing is owed the
  database deliberately returns a **currency-less** measured zero (`0219:212-224`), because
  "nothing is owed" is true in every currency at once. Both readers throw that row away on the
  same predicate:
  - `assistant/tools/business-summary.ts:88-102` filters on `/^[A-Z]{3}$/`, then reports
    `complete: false` (`:151-164`), and `AnswerView.tsx:263-280` paints a partial result as an
    alert.
  - **`src/lib/summary.ts:96-105` repeats the identical filter**, and `:106-109` pushes a
    failure and returns null — which `/alerts` draws as a red bar (`Alerts.tsx:89-95`).
    **I had scoped this to the assistant; fixing only that would leave `/alerts` broken.**
  - **And the filter cannot simply be deleted.** `contracts.ts:218-223` requires a money fact
    to carry a lower-case ISO-4217 unit; there is no "zero in all currencies". A currency-less
    row would fall through to `count`, which is a different lie. **How this zero is
    represented is decision F below — it is a contract question, not an implementation
    detail.**
- **RC9 — the first-password screen has no context guard.** `SetPassword.tsx:40-45` decides on
  `data.session ? 'ready' : 'noSession'`, shows the form to any session (`:96-103`), and
  changes the password directly (`:49-57`); the route is public (`App.tsx:287-304, 326`), so
  routing pending users here protects nothing.
  **Reclassified after Codex, and the reclassification matters:** this is **not** a new
  password capability. A signed-in user already changes their password with no current-password
  field via `Settings.tsx:269-279`, and recovery does the same at `ResetPassword.tsx:69-94`;
  `password_pending` is documented as a self-asserted UI hint, never authorization
  (`src/lib/password.ts:29-34`). So the defect is **a misleading context and a missing audit
  trail**, not an authorization hole. The fix is `passwordPendingOf` gating the screen and an
  honest heading. Whether all three password paths need an application-level audit row is
  **decision G** — and it cannot be a naive write after `auth.updateUser`, because that pair
  is not atomic: the password can change and the audit fail.

### The two things I got wrong, both verified### The two things I got wrong, both verified

**Existing payments prove nothing by their foreign key.** `payments.payment_request_id` is
nullable (`0001_init.sql:275`), `Bank.tsx:481-524` offers every unmatched supplier payment
without filtering on it, and a non-null value proves only that the request row exists
(`0021:226-230`).

**The currency gap is one function deeper.** The three functions carrying the bad expression
hand rows to `p1_import_supplier_prices_internal`, and *that* writes: it reads
`(supplier_id, product_id, price, available)` with no currency, rounds to two decimals, and
inserts into `supplier_products` and `price_history` without naming the currency column
(`0032:239-258, 318-367`; live body patched by `0207:111-150`), so both take the ILS default
(`0217:199-200`). Currency sources differ per path: document uses `resolve_document_currency`;
manual intake (`0035:5-20`) has none and must use `suppliers.default_currency`
(`0217:160-169`).

---

## Wave 0 — measurement and contracts. No schema change, no product code.

**Contract, stated once:** Wave 0 is a set of **independent prerequisites**, not a barrier.
Each wave names exactly the gates it needs. There is no blanket "all of Wave 0 before any
code" rule — the earlier draft said both and contradicted itself.

**Every gate produces a classified outcome, not a hoped-for one.** A discovery gate passes
when it emits a valid classification token; it does not fail because reality was unwelcome.
Each token maps to a named next step. Gates that require a script that does not yet exist say
so, and name the path it will live at — a gate whose command is a sentence is not a gate.

| Gate | Command | Outcome tokens → next step | Env |
|---|---|---|---|
| **W0-G1** | `git fetch origin && git rev-parse origin/main` | `BASE_LOCKED <sha>` → worktree from that SHA. Non-zero exit → **fail closed**, stop. | local |
| **W0-G2** | `gh auth status && gh pr list --state open --json number,headRefName,headRefOid`, then per head `git ls-tree -r <sha> --name-only supabase/migrations` | `PR_INVENTORY_OK` → proceed. `PR_INVENTORY_UNAUTHENTICATED` (401) → stop; no claim about PR state is made without it. | local |
| **W0-G3** | New `scripts/w0/g3-unmatch-probe.sql`, run under `Invoke-SqlTest`, exercising **both** paths: the direct branch, whose failure is deliberate (`0034:507-514`), and the existing-payment branch, which succeeds (`0034:516-583`) | `UNMATCH_BY_DESIGN` → the fix is the message, not the behaviour. `UNMATCH_DEFECT <sqlstate>` → the fix is the behaviour. | local DB |
| **W0-G4** | Read auth rate-limit settings via the Management API | `RATE_LIMIT_PRESENT <values>` → tune. `RATE_LIMIT_ABSENT` → enable. | prod read-only |
| **W0-G5** | `curl -i -X OPTIONS -H "Origin: https://app.inplace.digital" -H "Access-Control-Request-Method: POST" <fn-url>` | `PREFLIGHT_OK` → my reading is wrong, re-diagnose before touching. `PREFLIGHT_MISSING` → Wave 1 fix confirmed. **OPTIONS only; never POST, never a purchase.** | prod read-only |
| **W0-G6** | New `scripts/w0/g6-credit-guard-probe.sql` reproducing a 3377-shaped credit | `GUARD_PRESENT` → 3377 is the data runbook. `MIGRATION_REQUIRED` → 3377 returns to Wave 6 as code. **Both tokens pass the gate.** | local DB |
| **W0-G7** | Existing browser-gate harness at 1/3/6 concurrent sessions, with server logs captured | `CAPACITY_CAUSE <name>` → Wave 3 fixes that cause. `CAPACITY_UNREPRODUCED` → Wave 3 drops to observation only. | prod read-only |
| **W0-G8** | Production **read-only** query over `documents`/price submissions plus an authorised Storage read — **not** a local DB, because `documents` holds `storage_path`, not the file (`0001_init.sql:360-369`) | `NAME_SOURCE_FOUND <ref>` → automated repair. `NAME_SOURCE_ABSENT` → escalate to the owner as "supplier file required"; the manual queue stays. | prod read-only |
| **W0-G9** | New `scripts/w0/g9-findings-matrix.mjs`, reading the canonical evidence artifact (path and sha256 recorded in its header) and writing `artifacts/qa-findings.csv` | `MATRIX_OK` on set equality with the source, unique ids, and exactly one wave and one gate per finding. **Totals are not the check** — a duplicate and an omission cancel. | local |
| **W0-G10** | New `scripts/w0/g10-bank-blast-radius.sql`: union confirmed direct allocations (`bank_allocations.invoice_id`) and indirect ones (`payment_id` through `payment_allocations`), grouped by invoice approval state, currency, replay and **user** | `BLAST_RADIUS <counts>` — a measured population before any permission is widened. Blocking for Wave 1: the direct path creates `payments`, writes two allocation layers and refreshes status (`0023:984-1016`). | prod read-only |

**Migration numbering.** `scripts/next-free-number.mjs` only reports a number already visible
on a branch (`:149-177, 229-243`); it neither locks nor reserves, and two agents can pick the
same number before either pushes. **My first proposal was not a lock** — a plain
`git push` to a custom ref succeeds when the ref already points at the same SHA or can
fast-forward, and the default fetchspec would not even show it. The reservation is a
**create-only ref through the GitHub create-ref API**, which returns 422 when the ref exists;
that 422 is the lock. **No empty SQL stub is ever committed** — a stub that is applied and
later edited breaks the forward-only contract.

---

## What Wave 0 measured, and what it changed

Base locked at `b12d387d` (origin/main == main == HEAD), migration head `0290`, **zero open
PRs**. Full evidence in `artifacts/w0/RESULTS.md`.

| Gate | Token | What it changed |
|---|---|---|
| G1 | `BASE_LOCKED b12d387d` | next free migration number is `0291`; no contention |
| G2 | `PR_INVENTORY_OK` | zero open PRs — the lease matters less than feared |
| G3 | `UNMATCH_BY_DESIGN` | the unmatch item shrank to one message entry |
| G4 | `RATE_LIMIT_ABSENT` | brute force is three switches, not code |
| G5 | `PREFLIGHT_MISSING` | both CORS defects fail *inside* the function, not at the gateway |
| G6 | `GUARD_PRESENT` | the 3377 migration is unnecessary |
| G8 | `NAME_SOURCE_FOUND` | 105 of 271 damaged, not 271; the source PDFs were never discarded |
| G10 | `BLAST_RADIUS = 1` | no historical remediation needed |

**G10 — the bank door has never been used against a customer.** One confirmed allocation settled
an unapproved invoice: **invoice 6633, 2,950 ILS, created by the QA agent itself**. The
`via_payment` branch shows zero. So RC1 is *close the door*, not *close it and repair a
population*, and the standalone/legacy branch Codex correctly flagged is empty in fact.

**G3 — the unmatch refusal is deliberate.** `unmatch_bank_transaction` raises
`bank_direct_match_requires_financial_correction` for any direct match, because undoing one would
delete a payment record. The defect is that the code is missing from `PATTERNS` in
`src/lib/errors.ts:67-82`, so it falls through to "contact support" — the very failure that file's
own comment (`:68-72`) says was already fixed for four currency refusals. **One list entry, one
string, plus a screen that says where a financial correction is made.**

**G5 — the gateway is not the cause.** `assistant`, `submit-price-list` and `tenant-export` all
set `verify_jwt = true` and all answer the preflight 200. `billing-checkout` returns **401 from
its own code**, which checks environment and authorization before it inspects the method;
`webhook-verify` reaches its method check and returns **405**. One fix for both: answer `OPTIONS`
before anything else, the pattern already in `assistant/index.ts:222-223`.

**G6 — the credit guard exists in the live body.** `transition_credit_request` now refuses
`offset` unless the credit is allocated (`credit_request_not_fully_allocated`, added by `0173`).
The migration this plan once contemplated is unnecessary; 3377 is a one-row data fix. **I had read
`0024` and reported its dead body — the ninth instance of this repository's trap.**

**G4 — brute force is configuration.** Production auth carries `password_min_length = 6` (not the
10 the regression report states — that check is client-side only), `password_required_characters
= null`, `password_hibp_enabled = false`, `security_captcha_enabled = false`, and
`hook_password_verification_attempt_enabled = false`. **No sign-in attempt limit exists at all.**
Enabling HiBP alone refuses `1234567890`; the verification-attempt hook is the supported lockout
mechanism and it is off. Two further readings: `security_update_password_require_current_password
= false` platform-wide, which confirms RC9's reclassification, and the "your password was changed"
mail template exists and is **disabled** — so today a password change is neither audited nor
announced, which bears directly on decision G.

**G8 — the name damage is 39%, and the source was never lost.** 271 products, all with a SKU, 149
with a barcode; **105 names damaged, 166 clean**. Bilingual names are not damage. The signature is
a bidi extraction failure — 6 names open with a closing parenthesis, 27 close without opening, 93
fuse a digit to a Hebrew letter. **The four original submission PDFs are still in storage.**
**Decision A's blocker is therefore gone:** no supplier file is needed. The fix is the bidi
handling in the extraction path, re-run against the retained submissions — which is the "fix at
the root" the owner ruled for. It also explains `A9-07`: the 163 identical proposals are identical
because those names were never damaged.

**Still open in Wave 0:** G7 (capacity cause) and G9 (the 200-finding matrix). Neither blocks
Wave 1.

## Waves

A defensible first sequence. **Wave 1's first task is to build the real dependency graph from
W0-G9**; the ordering below is what we execute until that exists.

**Wave 1 — holes open right now.** Needs W0-G1..G6, G10 (all run).
- **RC1, per decision C — and G10 says the scope is the door only.** Close it per the trusted /
  standalone / recording classification, create the exception in the same transaction as the
  allocations, and state the role matrix explicitly. **No backfill of a historical population is
  required** — there is one row, the QA agent's own, and it is cleaned in Wave 9.
- **The unmatch message (G3).** One entry in `PATTERNS` (`src/lib/errors.ts:67-82`), one
  translation, and a screen line saying where a financial correction is made. The refusal itself
  is correct and stays.
- **Brute force (G4) — configuration first, then code.** Enable `password_hibp_enabled`, raise
  `password_min_length` to match the client's own 10 (the server currently accepts 6), and enable
  `hook_password_verification_attempt_enabled` for lockout. CAPTCHA is a separate judgement.
  **Each toggle is recorded before and after**; nothing here is a code change.
- **CORS (G5).** Answer `OPTIONS` before any auth or environment check in `billing-checkout` and
  `webhook-verify`, copying `assistant/index.ts:222-223`. Re-probe live afterwards: both must
  return 200 with the headers.
- **RC9's first-password screen** — `passwordPendingOf` gating plus an honest heading.

**Wave 1b — reconnect the assistant and the summary readers (RC7 + RC8).** Needs W0-G1.
Separate from Wave 1 because it changes **no permission and performs no financial mutation** —
though it does read financial data and send it to an external model provider, so it is not
"outside the money path", as I first wrote.
**It is not a rename.** The new keys are **arrays**, so each adapter must emit **one Fact per
currency**; `topBalancesByCurrency` is a list of per-currency groups, not the old flat list;
and null, measured zero, partial completeness and the ban on adding currencies together must
all survive the change. Scope:
- the three adapters of RC7, per currency;
- the hardcoded `unit: "ils"` in `topBalances`;
- **`src/lib/summary.ts` and `/alerts` alongside the assistant** — same predicate, same defect,
  and fixing one alone leaves the other red;
- the representation chosen in decision F for the currency-less measured zero.
**Gates — one comparison is not enough:**
- a per-currency / zero / null matrix over the three adapters;
- the same question put to the dashboard and the assistant in one frame, returning the same
  figure (the report's own evidence shape: dashboard 11,571 ILS · 7 open invoices against the
  assistant's "not measured");
- **a live owner / office / accountant isolation probe and a prompt-injection probe before
  deployment.** Unit coverage already exists — `provider.test.ts:396-430` tests an instruction
  embedded in tool data and `business.test.ts:185-194` tests role refusal — so the claim is
  narrower than I wrote: **the live round never reached them**, because the demo organisation's
  monthly assistant allowance ran out after 18 questions. This gate needs an authorised test
  allowance, not an open wait.

**Wave 2 — price list intake.** Needs W0-G1.
- One canonical `parse_price(text, expected_currency)` returning `{ok, value, reason}`,
  shared by preview, the three consumers and the shadow run: sign preserved, wrong currency
  rejected rather than coerced, and **per-row rejection semantics kept** — the three writers
  mark a bad row and continue today, so a raising parser would turn a partial intake into a
  total failure.
- **`p1_import_supplier_prices_internal` is in scope**: currency threaded through and written
  explicitly to `supplier_products` and `price_history`. Its live body is patched
  (`0207:111-150`), so this is an anchored patch with hash pins updated.
- **Currency change on an existing row — decided here, not left to implementation.**
  `supplier_products` is `unique (supplier_id, product_id)` with a single `current_price`,
  a single `previous_price` and one currency column (`0001_init.sql:102-115`, contract
  re-pinned at `0105:162-171`). So the pair holds exactly one currency, and a USD list
  arriving for an ILS-priced product has no representable outcome. **The writer rejects the
  row** with reason `currency_mismatch_existing_price` and does not convert, does not
  overwrite the currency, and does not attempt a second row. Changing the currency a supplier
  trades in is a deliberate act with its own migration path, not a side effect of a price
  upload.
- **A limitation I wrongly declared, and Codex caught.** I wrote that `numeric(12,2)`
  (`0001_init.sql:107`) could not hold a three-decimal currency. `0217:283-285` already
  widened `supplier_products.current_price`, `previous_price` and `price_history.price` to
  `numeric(14,3)`, and nothing narrows them again. **Wave 2 therefore supports `minor_units`
  0 through 3 in full**, and there is no debt to record. Fifth time in this review that I
  cited a first definition the migration history had already replaced.
- The message that blames the wrong cause; preview/write divergence.

**Wave 3 — what a prospect meets.** Needs W0-G1, W0-G7.
Pricing page showing quota as price; 17 excluded features carrying an identical checkmark ·
public dark-mode contrast · capacity, per W0-G7's token · **signup rollback**, whose live
evidence is the orphan production organization `QA-AGENT10-DO-NOT-KEEP`. This is that
defect's only assignment.

**Wave 4 — refuse invalid input.** Needs W0-G1.
RC4: measure out-of-range rows first; zero permits `NOT VALID` then `VALIDATE`, otherwise an
explicit remediation policy and **never a silent clamp**. Add `min` and `max` to both
clients. Quantity caps; triple-submit.

**Wave 4b — per-org numbering.** Needs W0-G1; decision B (settled).
Separate from Wave 4 because a locked six-table transition and a column CHECK share nothing,
and bundling them means one rollback takes out both.
- **`private.org_number_counters(org_id, entity_kind, next_value)`**, `PRIMARY KEY
  (org_id, entity_kind)`, a CHECK restricting `entity_kind` to the six known kinds, and
  **zero grants to `authenticated` or `anon`** — a readable counter table would publish the
  cross-tenant activity signal this change exists to remove.
- **Counter per `(org_id, entity_kind)`**, decided: with six independent sequences today, one
  shared org counter would let only the first entity kind start at 1.
- **The allocator upserts, it does not assume a seeded row.** An organization created after
  the migration has no counter row, and a plain `UPDATE ... RETURNING` would return zero rows
  instead of 1. `INSERT ... ON CONFLICT (org_id, entity_kind) DO UPDATE SET next_value =
  org_number_counters.next_value + 1 RETURNING next_value`, called from a `BEFORE INSERT`
  trigger that **rejects an explicit `NEW.number`** rather than honouring it.
- One transaction locks the six tables, seeds counters from existing maxima, drops the
  identity, installs the trigger, and only then releases — no window in which a write can
  land un-numbered. The six orphaned sequences are dropped in the same migration.
- Historical numbers preserved and never reused, so **"starts at 1" applies to a new
  tenant**; the existing tenant keeps its sequence. `unique(org_id, number)` per table makes
  it checkable. Tests: rollback, concurrency, explicit-number rejection, and **a brand-new
  organization getting 1**, on all six tables.

**Wave 5 — what leaves the system.** Needs W0-G1; Wave 2 for the cost report.
`webhook-verify` CORS · product purchase report with no cost · the "final locked report"
that blames a zero.
**The accountant export returns to scope through decision E, in a different shape than
`R13-01` proposed.** The invoice sheet is left exactly as it is (decision D: approved only,
no omission notice). The payment sheet moves onto a new allocation-aware read model that
reports each payment's approved-invoice portion. The `R13-01` fix I originally planned —
declaring what was omitted — remains rejected.

**Wave 6 — money.** Needs W0-G1, W0-G6.
Stored `payment_status` teardown in three steps [owner: fix fully] · payment-request message
and state defects. Invoice 3377 goes to the runbook below unless W0-G6 returns
`MIGRATION_REQUIRED`.

**Wave 7 — one trustworthy number.** Needs W0-G1, W0-G9, **Wave 1b**.
Reframed: the assistant does not need *constraining*, it needs **reconnecting** — Wave 1b does
that, and this wave handles what remains once it can read.
- **Citation landing.** 61 claim cards, only 3 without a source — but on clicking every link,
  **only 5 of 13 land on a screen that isolates the claim**. "No supplier raised a price"
  links to a screen headed "7 price rises". A source that does not isolate its claim is not a
  source.
- Dashboard tiles linking to a different figure. **Correction from the final report:** in the
  payment-requests case the **dashboard was right and the list was wrong** — the list wrongly
  includes drafts, while the "due soon" filter three lines below excludes them, with a comment
  explaining why. My earlier framing blamed the wrong side.
- Zero where an em dash is required · **mobile data loss** (accountant-export status dropping
  from 26 occurrences to zero) — a number that disappears, not a styling defect.
- **`R4-04`, which belongs to the currency rule and not to charting:** in dollar view one
  dashboard chart renders the **shekel figures under a `$` label**, byte-identical once the
  sign is stripped, while the banner directly above it reads "no conversion between
  currencies". Every neighbouring card switches correctly, so this is one chart and not the
  screen — but it makes that banner an explicit false statement.

**Wave 8 — visibility.** Needs W0-G1.
RC6, using a dedicated table-head token fixed dark in both themes, with `DESIGN.md` and the
rendered-contrast check updated together · column-picker focus trap · documents-screen
latency · reversed Hebrew filenames.

**Wave 9 — cleanup.** Needs waves 1, 5 and 6.
Three leftover rows are undeletable until those land, so cleanup is also the last integration
test.

---

## Data remediation, separate from code (invoice 3377)

Primary key and `org_id`, a snapshot before, an idempotent update guarded on expected old
values, an audit row with a reason, a postflight read. Runs only on W0-G6 = `GUARD_PRESENT`.
**Exactly one row on the first run.** Zero is acceptable only when the target state *and* the
exact audit marker are already present; otherwise zero means a concurrent change or wrong
expected-old-values, and the run stops.

## Migration mechanics (every DB change)

Forward-only patch migrations rewriting live bodies through unambiguous anchors. Never edit
`0023`, `0032` or `0048` in place — an installed database will not change. Update pinned body
hashes, run the scope and exemption guards, `npm run verify`, the SQL suite, and a full
workflow on the final SHA.

---

## Decisions

**Settled [owner 03.09]:** bank door first · selling within weeks · per-org numbering from 1
(Wave 4b) · a manual credit offset must really offset · the stored "paid" label is derived, not
fenced.

**A — product names, and W0-G8 removed the blocker.** The owner ruled "fix at the root,
permanently", and the obstacle was believed to be a missing supplier spreadsheet. It is not
missing: **the four original submission PDFs are still in storage**, and the damage is a bidi
extraction failure in **105 of 271** names, not a whole-catalogue reversal. The fix is therefore
exactly the root fix that was ruled for — correct the bidi handling in the extraction path, then
re-run it against the retained submissions and diff the result against the 166 names already
known good, which must not move. The 224-click approval queue is not the fix and largely
evaporates once the extraction is right.

**C — bank matching is BOTH [owner 03.09].** The owner sometimes pays through the product and
sometimes transfers at the bank and records it afterwards, so the fix distinguishes them.

- **Trusted request-backed — and the test is the request's *state at match time*, not the
  foreign key.** The execution command accepts `approved`/`sent_for_execution` and, in the
  same transaction, moves the request to `executed` (`0031:630-675`, `:728-730`); bank
  matching then moves `executed` to `matched` (`0023:937-943`). So at match time a trusted
  payment's request is **`executed`**, or `matched` on replay. **A payment sitting beside a
  still-`approved` request is a suspicious shape, not a trusted one.** Trust therefore
  requires: request in `executed` (or `matched` for replay), an audit execution row linking
  this `payment_id`, and allocations that match. The enum is at `0001_init.sql:16`.
- **Everything else** — standalone, legacy, service-role or migration-created — takes the
  recording treatment, the same as the direct branch.
- **The direct branch is recording, and blocking it is the wrong fix.** Refusing to record
  money that already left makes the ledger less true and strands the transaction. Today it
  blocks `accountant` (`0031:1219-1229`) and allows `owner` — backwards, since recording is
  the accountant's job.
- **This is an authorization change, not a display change.** Opening the direct path to
  `accountant` widens a permission that was explicitly closed, and the path creates
  `payments`, writes two allocation layers and refreshes `payment_status` (`0023:984-1016`).
  Wave 1 states an explicit role matrix and creates the exception **in the same transaction
  as the allocations**.
- The control that matters: nobody settles an unapproved invoice **quietly**.

**D — settled [owner 03.09].** The accountant sees **only approved invoices**, and the export
**says nothing at all about what was omitted**. My proposed "declare the omission" fix is
therefore rejected by the owner, and `R13-01` is closed as *working as intended* rather than
fixed. It leaves the plan.

**E — settled [owner 03.09]: the payment sheet is filtered too, and shows only the approved
portion.** A payment covering three invoices of which two are approved is reported at the
sum allocated to those two, not in full.

**This is a bigger change than a filter, and the plan says so rather than discovering it
later.** Row-level security can hide a payment or reveal it; **it cannot report a different
amount**. So the fix is not a change to `payments_select` (`0133:205-209`, today: any payment
in the org for `owner` and `accountant`). It is a **read model** — a definer view or function
that returns, per payment, the sum of its allocations to invoices the caller may see — and
the report reads that instead of `payments` directly. The accountant's raw table access
stays as it is or is withdrawn, but the reported figure never comes from the raw row again.

Two consequences to record before anyone reads them as bugs:
- **The accountant's "paid this month" will legitimately differ from the owner's.** The QA
  report saw both at 8,131. Under this ruling they diverge whenever a payment touches an
  unapproved invoice. That is the intended behaviour, not an inconsistency.
- **The accountant's total will not reconcile against the bank statement**, by design: it is
  the approved-invoice portion of money that moved, not the money that moved.
- A payment with no allocations at all has no approved portion, so it does not appear.

---

## Risks

- **RC1 blast radius is uncounted.** The preflight unions direct allocations
  (`bank_allocations.invoice_id`) and indirect ones (`payment_id` through
  `payment_allocations`), split by approval state, currency and replay. **It cannot split by
  role:** `bank_allocations` records `created_by`, not the role held at the time
  (`0001_init.sql:325-334`), so any historical breakdown is by user, never by role.
- Wave 2's `currency_mismatch_existing_price` rejection is a deliberate refusal to guess. It
  will surface as rejected rows on any genuinely multi-currency supplier, and that is the
  signal that the currency-transition model is needed — which is not in this plan.
- Wave 3's capacity work has no measured cause until W0-G7.
- Four branches are live and other agents are active on this machine — W0-G1 exists for that.

## Out of scope

Everything the report verified as working: role enforcement, over-allocation blocking,
concurrent double-allocation, per-currency separation, price snapshots, export integrity,
English locale, login enumeration resistance. Also the OCR and render VPS contract versions;
widening `current_price` for three-decimal currencies; the supplier currency-transition
model; and redesigning the assistant's retrieval layer — Wave 1b reconnects its existing
tools and Wave 7 fixes their citations; neither rebuilds retrieval.


---

## Status after the final report

**The base moved again, and I described the move wrongly.** The rollout was **`0284`→`0290`,
seven migrations — not five.** It is fully applied: production and `main` are aligned, the
ledger head went `0283`/274 → **`0290`/281**, `scope_enforcement_violations()` was empty before
and after, and all eleven business counts were identical (`docs/PROGRESS.md:3-9`;
`docs/ROLLOUT-0284-0290-20260903.md:191-206`; merge `b12d387d`). It also touched the VPS OCR
contract, five mail templates, seven Edge functions and the frontend. The regression round
found **zero regressions** across 15 real writes and 24 permission probes, and explicitly
cleared `0286`, the write guard on every tenant table. **It shipped no fixes from this plan.**
W0-G1 must re-lock the base against `0290`.

**`0289` does NOT reduce the signup item to the success path — I overstated it.** It releases an
abandoned signup after 24 hours (`0289:82-97, 126-164`); it does not repair the immediate
rollback. The flow still creates the organisation (`provision.ts:272-281`), then creates the
user over a separate HTTP call (`:296-316`), then attempts manual compensation on failure
(`:308-314, 348-351`). If that compensation is broken, a next-day sweep only bounds how long
the debris lives. **Two things are needed, and Wave 3 currently declares neither:**
- a gate that **injects a failure at each step** and proves zero leftovers *immediately*;
- an end-to-end signup → confirmation → first-password success run. **The success path has
  never been exercised** — an agent read the code and refused, because the organisation is
  created before the permission user. This is the front door for new customers and the owner
  intends to sell within weeks.

**The price-snapshot result is stronger than I said, and I should have checked.** The live QA
was inconclusive because every price rise in this organisation predates every order — but the
repository proves the rule under exactly the breaking condition:
`p33_canonical_purchase_metrics.sql:110-121` places an order at ₪5, sets the current price to
₪999, and requires the committed figure to stay 50. **Live QA inconclusive; p33 is the
regression proof**, and it must be re-run on the implementation SHA rather than cited from
memory.

**Wave 0 is a plan to build gates, not a set of gates.** Ten are designed; **zero are runnable
today** — not only the six wrappers I admitted, but the four named script files (G3, G6, G9,
G10) do not exist either, and the outcome tokens appear nowhere but in this document. Creating
and running every one of them is Wave 0's exit condition, and the table above is a
specification, not an inventory.

## Decisions

- **F — settled [owner 03.09]: no obligations is a SENTENCE, not a number.** When nothing is
  owed the surface reads "no open obligations" and shows no figure at all — not `0 ILS`, which
  would assert something about one currency while saying nothing about the others, and not an
  em dash, which the constitution reserves for *unknown* and would misdescribe a value we
  positively know.
  **What this means for the contract.** The currency-less row never becomes a money Fact, so
  `contracts.ts:218-223` is left intact — no widening, no `count` unit, no invented currency.
  It becomes a **stated absence**: the reader emits the "no obligation exists" meaning and the
  surfaces render the sentence. Both consumers change together — `business-summary.ts:88-102`
  and `src/lib/summary.ts:96-109` — so `/alerts` stops painting a red bar over a healthy
  organisation.
  **The distinction the wave must not blur:** *nothing is owed* and *we could not measure what
  is owed* are different states and must read differently. Today both collapse into a failure;
  after this, only the second one may.
- **G — settled [owner 03.09]: yes, every password change is recorded.** All three paths —
  `SetPassword`, `Settings`, `ResetPassword` — write an application audit row.
  **The implementation constraint, carried so nobody discovers it mid-build:** a write placed
  after `auth.updateUser` is not atomic with it, so a password can change while the audit fails
  and the record silently disagrees with reality. The row must therefore be written through a
  server boundary that owns both effects, or reconciled from the identity provider's own log —
  never as a best-effort call from the browser after the fact. Which of those two, and whether
  the reconciliation source is trustworthy enough on its own, is a design task inside the wave,
  not a further owner decision.

## Where the Codex review stands

Seven rounds. Codex has never returned APPROVED, and that has been worth it: it refuted a claim
of mine in **every single round**, including three in this one — the rollout range, the scope of
RC7's silence, and the reclassification of the first-password screen from an authorization hole
to a context defect. The residue each time has been execution scaffolding, not disagreement
about the diagnosis.

**The recurring lesson, now at eight instances.** The price regex, the accountant guard, the
browser-invoke inventory, the payment foreign key, the price column width, the assistant's
money keys, its currency unit, and the rollout range. In this repository **the first definition
of anything is almost never the live one**, and a rename lands in one half of the system while
the other half keeps reading the old name. Any claim of the form "the code does X" must be made
against the live body, and any claim about what shipped must be made against the rollout ledger.
