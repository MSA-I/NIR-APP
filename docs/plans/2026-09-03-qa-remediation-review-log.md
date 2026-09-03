# Plan Review Log: remediation of 172 QA findings

Started 2026-09-03. MAX_ROUNDS=5. Reviewer: Codex CLI 0.149.0, model `gpt-5.6-sol`,
reasoning effort xhigh, forced read-only every round.

## Round 1 — Codex
VERDICT: REVISE. Three root causes verified, one partially, two wrong as stated.
Key refutations (all four independently re-verified by Claude before acceptance):
- RC1: 0031:1219-1229 injects an accountant-only approval check into match_bank_transaction;
  0232 preserves it. Owner is not blocked; the existing-payment branch checks no invoice at all.
- RC2: 0032's function was renamed at 0035:350 and replaced at 0048:1294, so 0032:606 is dead
  history — three live broken bodies, not four. And '[^0-9.]' turns -145 into 145: copying the
  "already written fix" to the writers would ship silent value corruption.
- RC3: the functions.invoke scan missed `invoke<{...}>('name')` call sites. Eleven browser-invoked
  functions, of which TWO lack CORS — webhook-verify and billing-checkout, the purchase flow.
- Stale PR/base state: origin/main already carries #235/#238/#240; HEAD moved mid-review.
Also: no per-finding traceability, no exit criteria, 3377 runbook not executable, capacity-last
contaminates verification of earlier waves.

### Claude's response
Accepted all four refutations after verifying each in the repo myself. Rewrote the plan:
restated RC1 as a role x branch matrix and raised it to an open product decision (C);
replaced "copy the fix" with one canonical parser across preview/write/shadow; added
billing-checkout to wave 1 given the owner's "selling within weeks"; added Wave 0 for base
lock, discovery gates and the 172-finding inventory; moved capacity from last to wave 3;
separated invoice 3377 into a data-remediation runbook with preconditions; added migration
mechanics. Owner answers of 03.09 folded in: per-org numbering is now in scope; no original
price file exists, so product-name repair becomes a discovery item rather than a fix.
Rejected nothing material.

## Round 2 — Codex
VERDICT: REVISE. All six root causes now confirmed correct against the repo. The critique
moved from correctness to execution rigor, plus two substantive new catches:
- RC1 / decision C rested on a FALSE premise of mine: I claimed every `p_existing_payment_id`
  came through the payment-request flow. `payments.payment_request_id` is nullable
  (0001_init.sql:275) and src/pages/Bank.tsx:481-524 offers every unmatched supplier payment
  without filtering on it. Standalone payments reach that branch having passed no approval.
- RC2: a currency-tolerant parser is not enough — the writer's rows carry no currency
  (0048:1595-1601) and supplier_products/price_history default to ILS (0217:199-200), so
  accepting "145.00 USD" would store 145 ILS. 0229 taught the dry run to resolve currency;
  the writers were never taught. Same asymmetry as the regex, one layer down.
Also: 13 browser-invoked functions not 11 (public-signup, upload-organization-logo missed,
both have CORS); base SHAs conflated (HEAD 8bc22bae / origin/main 35a62759 / main a269b382);
gh returned 401 so the PR inventory is unevidenced; next-free-number neither locks nor
reserves; no exception_type exists for "settled against unapproved invoice" and
bank_allocations records created_by, not the role at the time; 172/41 totals can pass with a
duplicate cancelling an omission; max(number)+1 races without a lock; 3377 runbook accepts
zero rows too easily.

### Claude's response
Verified both substantive catches in the repo myself; both stand. Corrected the false premise
and split the existing-payment branch into request-backed vs standalone. Redesigned the wave-2
fix as parse_price(text, expected_currency) -> {ok,value,reason} with currency threaded to the
write, sign preserved, per-row rejection semantics kept (the writers mark-and-continue today,
so a throwing parser would break partial intake). Corrected the function inventory to 13.
Rewrote the Wave 0 base gate to fail closed on fetch failure and record the exact origin/main
SHA; required an authenticated PR listing; required a single-writer lease for migration
numbers. Added gate format (id, command, expected output, environment) and made Wave 0 an
explicit dependency of every wave. Added the exception-type contract and the note that
historical role is not recoverable. Changed the inventory check from totals to set equality.
Added the locked six-table transition for per-org numbering and split it into its own wave 4b.
Placed the two orphaned findings (signup rollback -> wave 3, mobile data loss -> wave 7).
Tightened the 3377 assertion to exactly-one-row. Stated explicitly that the wave list is a
first ordering, not the final DAG, which can only be built after the Wave 0 inventory.
Rejected nothing material.

## Rounds 3-5 — Codex
All three returned REVISE. Root causes confirmed correct from round 3 onward; the critique
moved to design contracts and then to execution scaffolding.

Round 3 forced: parse_price must reach p1_import_supplier_prices_internal (0032:239-258,
318-367, live body patched 0207:111-150) which writes without currency; trusted request-backed
cannot be inferred from a nullable FK; counter-per-entity-kind must be decided; Wave 0 gates
were prose.

Round 4 forced: two real holes in the plan itself — (a) supplier_products is
unique(supplier_id, product_id) with one currency column, so a USD list against an ILS-priced
product has no representable outcome and the plan had to DECIDE (it now rejects the row); and
(b) the numbering allocator seeded only in the migration would return zero rows for an
organization created later — exactly the case the owner's ruling is about. Now an upsert.

Round 5 forced: 0217:283-285 already widened current_price/previous_price/price_history.price
to numeric(14,3), so the "three-decimal limitation" I declared was false; the git-ref lease was
not create-only (a plain push succeeds when the ref matches or fast-forwards); the RC1 blast
radius was a stated risk with no gate; decision D was not a dependency of Wave 5's export item.

### Claude's response
Verified each correction in the repo before accepting. Applied all five: removed the false
limitation and required minor_units 0-3; renamed the dry-run expression so the plan stops
calling it "corrected" when the plan itself proves it corrupts -145; replaced the lease with a
create-only ref via the GitHub API (422 is the lock); added W0-G10 as a blocking blast-radius
preflight for Wave 1; split the accountant export out of Wave 5 behind decision D.

### Outcome — MAX_ROUNDS reached, no APPROVED
Not a stalemate of opinion. The residue is that six Wave 0 gates are described but their
wrapper scripts are unwritten — implementation, and the first task of Wave 0. Recorded in
PLAN.md under "Where the review stopped".

Recurring lesson, five instances: a first definition in this repo is almost never the live one.

## Round 6 — Codex (plan reopened after the 200-finding final report)
VERDICT: REVISE. Ten findings; every verifiable one checked by Claude and accepted.
Substantive:
- RC7 overstated. A missing key still emits a Fact with value:null plus an explicit
  "not measured" warning (getDashboardSnapshot.ts:95-110,132-136) rendered as an em dash
  (AnswerView.tsx:32-39). Only topBalances is truly silent. "Every financial number" is three
  adapters, not all. The question-substitution link is plausible, not provable from code.
- RC8 exists in TWO consumers: src/lib/summary.ts:96-105 repeats the same /^[A-Z]{3}$/ filter
  and /alerts paints the failure red (Alerts.tsx:89-95). Scoping it to the assistant would have
  left /alerts broken. And the filter cannot simply be removed: contracts.ts:218-223 requires a
  money fact to carry an ISO unit, so a currency-less row falls through to `count` — a
  different lie. Became decision F.
- SetPassword reclassified: Settings.tsx:269-279 and ResetPassword.tsx:69-94 already change a
  password with no current-password field, and password_pending is a documented self-asserted
  UI hint (password.ts:29-34). It is a context/UX defect, not an authorization hole. Audit after
  auth.updateUser is not atomic. Became RC9 + decision G.
- Wave 1b was mis-scoped: "no money path" is wrong (it sends financial data to an external
  model provider — correct phrasing is "no financial mutation"), and it is not a rename: the new
  keys are arrays requiring one Fact per currency, and topBalancesByCurrency is grouped.
- Injection claim corrected: provider.test.ts:396-430 and business.test.ts:185-194 already cover
  instruction-in-tool-data and role refusal. Only the LIVE round never reached them.
- ROLLOUT RANGE WRONG: not five migrations 0285-0289 but SEVEN, 0284-0290, fully applied,
  ledger 0283/274 -> 0290/281 (PROGRESS.md:3-9, ROLLOUT-0284-0290-20260903.md:191-206, merge
  b12d387d). The evidence was in the session's own opening git log.
- 0289 does not narrow the signup item: it caps the debris window at 24h, it does not fix the
  immediate rollback (provision.ts:272-281,296-316,308-314).
- Price snapshot is PROVEN in-repo after all: p33_canonical_purchase_metrics.sql:110-121 orders
  at 5 with a current price of 999 and requires 50. Live QA inconclusive; p33 is the proof.
- Wave 0: zero gates runnable — the four named script files do not exist either.

### Claude's response
Verified the rollout range, the duplicate filter in summary.ts, the FactUnit contract and the
p33 assertion directly; all four stand. Accepted all ten. Narrowed RC7 to three adapters and
withdrew the "entirely silent" and "every financial number" claims; split RC8 into RC8 (zero as
failure, two consumers) and RC9 (first-password context), reclassifying RC9 out of the security
category; rescoped Wave 1b to include src/lib/summary.ts and /alerts, per-currency Fact emission
and grouped topBalances, with a matrix plus live isolation and injection gates needing an
authorised test allowance; corrected the rollout to seven migrations 0284-0290; restored the
signup failure-injection gate and the untested success path to Wave 3; corrected the price
snapshot to "live inconclusive, p33 is the proof, re-run on the implementation SHA"; and restated
Wave 0 as ten designed gates and zero runnable. Opened decisions F and G. Rejected nothing.

### Owner decisions F and G (03.09.2026)
F — "no open obligations" is rendered as a sentence with no figure. The currency-less measured
zero therefore never becomes a money Fact: contracts.ts:218-223 is left intact, nothing is
widened, no currency is invented, and no `count` unit is misapplied. Both consumers change
together (business-summary.ts and src/lib/summary.ts) so /alerts stops showing red on a healthy
organisation. The wave must keep "nothing is owed" and "could not be measured" distinguishable —
today both collapse into a failure.
G — yes: all three password-change paths write an application audit row. The non-atomicity of a
write following auth.updateUser is an implementation constraint inside the wave, not a further
owner decision.
