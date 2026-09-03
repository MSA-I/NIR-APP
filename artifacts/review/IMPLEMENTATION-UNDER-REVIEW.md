# Under review: nine waves of QA remediation, as built

_Adversarial review target. This is **not** a plan — the work is written and applied. What is
wanted is the argument against it._

## What you are reviewing

Branch `claude/implementation-prompt-review-a91515`, four commits above `main`:

| commit | what |
|---|---|
| `e23c24d6` | docs only — the plan and its review log |
| `1b34eb4e` | Waves 1 and 1b — the bank door, password audit, CORS, the assistant's money keys |
| `0b3b17d0` | Wave 4b — per-tenant document numbering |
| `adf8f80a` | Waves 2, 3, 4, 8 — the price parser, the signup rollback, input bounds, contrast |

**Plus uncommitted work in the tree**, which is Waves 5 and 6 and is equally in scope:
migrations `0299`, `0300`, `0301`, and the TypeScript beside them. `artifacts/review/uncommitted-modified.txt`
and `uncommitted-new.txt` list every path.

Wave 7 landed while this document was being written and **is in scope**: the citation routes and
the dashboard-tile parity, in `src/lib/assistant/{routeAccess,summaryLines}.ts`,
`src/lib/alerts.ts`, `src/pages/{Dashboard,Inventory,Invoices,Orders,PaymentRequests,PriceLists}.tsx`,
nine files under `supabase/functions/assistant/tools/`, and `src/pages/tileClaimParity.spec.ts`.
Its load-bearing claims are item 11 below. The tree typechecks clean and every key guard passes,
so anything red you find is a finding rather than an artefact of work in progress.

The plan that produced all of this is `docs/plans/2026-09-03-qa-remediation-plan.md`. The
project's constitution is `CLAUDE.md` and it overrides everything.

## The claims that carry weight

Attack these first. Each is a decision that would be expensive to get wrong, and each is stated
as a claim you can falsify by reading the code.

**1. `0292` — the bank door declares instead of refusing.** The direct branch's only approval
condition was `(v_role = 'accountant' and i.review_status <> 'approved')` — it refused the
accountant and waved the owner through. It is gone. Recording money that already left the account
is never refused; instead every match is classified TRUSTED or RECORDING, and a RECORDING
settlement of an unapproved invoice opens an `unapproved_invoice_settled` exception in the same
transaction as the allocations.
- Is the TRUSTED test actually sufficient? It requires: the payment carries a request, that
  request is `executed` or `matched`, an execution audit row names **this** `payment_id`, and
  every invoice the payment allocates to is on that request. Can a caller construct a payment
  that passes all four and should not be trusted?
- The exception insert is deduplicated on `(org_id, type, invoice_id, bank_transaction_id)` with
  no unique index behind it. Is the `not exists` enough under concurrency, given what the
  function already locks?
- Is opening the direct branch to `accountant` a real widening of authority, and if so is a
  declaration adequate compensation?

**2. `0293` — every password change writes an audit row, from a trigger inside GoTrue's own
transaction on `auth.users`.** Two alternatives were rejected on measurement: reconciliation from
`auth.audit_log_entries` (which records a password change indistinguishably from a metadata
update) and a new Edge function (still two effects in two transactions).
- The trigger is `after update ... when (old.encrypted_password is distinct from new.encrypted_password)`.
  Does that fire where it must and only there?
- It **fails closed**: if the insert raises, GoTrue's UPDATE rolls back and the password does not
  change. Is that the right direction for a *password change*, or does it hand an attacker a way
  to lock somebody out of their own account?
- The write guard gains an `identity_audit_exempt` carve-out so a suspended tenant's member can
  still recover their account. It relaxes only the access-mode refusal and leaves
  `organization_write_guard_missing_org` in force. Is the carve-out narrow enough?
- A user with no `profiles` row gets **no** audit row (there is no tenant to file it against) but
  the password change succeeds. Named as a known gap. Is it acceptable?

**3. `0294` — per-tenant numbering, and the allocator is SECURITY INVOKER.** Six tables moved off
a global identity sequence onto `private.org_number_counters`, seeded from each tenant's own
maximum. The load-bearing argument for INVOKER: `private` grants nothing to anybody but its owner;
four of the six tables are scope-enforced, so a DEFINER trigger on them would need an A5 exemption;
and every writer already runs as `postgres` inside a SECURITY DEFINER command because
`authenticated` holds no INSERT on any of the six and no Edge function inserts into them.
- Is that inventory complete? Find a writer it missed.
- The migration takes `lock table ... in exclusive mode` and holds it to commit, in an explicit
  `begin;`/`commit;`. Is the explicit transaction correct under both runners this repo uses
  (`supabase db reset` and `scripts/db-query.ps1` via the Management API)?
- The trigger refuses an explicit `NEW.number`. Does anything in the repo supply one?

**4. `0295` — bounds, and a granted `id`.** VAT and eleven quantity columns get CHECKs, measured
at zero out-of-range rows and therefore `NOT VALID` then `VALIDATE`. And `insert (id)` on
`products`/`suppliers` is granted to `authenticated` so a retried create collides with the primary
key instead of making a second row.
- Granting the browser control of a surrogate id: what does that open? Consider a cross-tenant
  existence oracle via 23505, and whether RLS still fully constrains the row.
- The command conversion the house pattern would prefer was **not** taken (six client call sites
  insert products, two insert suppliers). Is the cheaper fix actually sufficient?

**5. `0296` — the sign-in lockout hook.** A Postgres function GoTrue calls: ten consecutive
failures inside fifteen minutes lock the account for fifteen minutes; a success clears the run; a
correct password does not open a locked door; and **any internal error returns `continue`**.
- Fail-open on a rate limiter: right call, or a bypass an attacker can force by making the
  function raise?
- It counts per account, not per caller, and says so. What does that leave open?
- `grant usage on schema private to supabase_auth_admin` — what else does that reach?

**6. `0297` — the signup rollback.** One `organizations` insert fires five triggers writing six
tables; two are `on delete restrict` in `private`, which PostgREST does not expose, so no Edge
function could ever have completed the rollback. The new door is fenced on age (fifteen minutes)
and zero business activity, both re-derived under a row lock, and deliberately **not** on owner
verification.
- Is `service_role` plus those two fences enough for a function that deletes a whole tenant?
- The function sets `app.audit_purge` around the teardown and clears it after. What happens if the
  teardown raises?

**7. `0298` — one price parser.** Replaces `[[:space:]₪,]` in three live bodies and `[^0-9.]` in
the preview. Never raises (per-row rejection is preserved); a foreign currency is refused, never
coerced; a currency change on an existing `supplier_products` row is refused with
`currency_mismatch_existing_price`.
- Read `private.parse_price`. Find an input that produces a wrong number rather than a refusal —
  a thousands separator, a decimal comma, a minus sign, a currency symbol in an unexpected place.
- The comma rule: a comma is a thousands separator only when it groups in threes, so `1,5` is
  refused. Is that right for every locale this product serves?

**8. `0299`/`0300` — the stored `payment_status` teardown, steps 1 and 2 of 3.** Step 1 is
additive; step 2 moves eight database readers onto `private.invoice_payment_state(...)` while the
column is still written. Step 3 (removing the writer and the column) is deliberately **not**
applied: eleven client screens still read the column.
- Is step 2 safe while the clients still read the stored column? The two answers now disagree on
  exactly one row (invoice 3377, stored `paid`, 150 ILS owed).
- The derived expression uses `private.money_tolerance(org, currency, 'invoice_payment_settled_tolerance')`,
  whose derived value for a two-decimal currency is exactly 1.00 — the number the old bare `<= 1`
  produced for a shekel. Does anything change for a currency with 0 or 3 minor units, and is that
  the intended change?
- The public computed column is SECURITY DEFINER and re-reads the invoice under `invoices_select`
  rather than trusting the composite it is handed. Is that re-read actually closing the oracle it
  claims to close?

**9. `0301` — decision E, the accountant's payment sheet.** RLS can hide a payment or reveal it
but cannot report a different amount, so the fix is a `security_invoker` view returning, per
payment, the sum of its allocations to invoices the caller may see. `payments_select` is untouched.
- Does `security_invoker` + `security_barrier` really answer "invoices the caller may see" here,
  or can the view leak an amount that the underlying policies would have hidden?
- A partly allocated payment is now reported at its allocated portion **for every reader,
  including the owner**. Intended, or a regression?

**10. Wave 2's bidi repair, `worker/ocr/src/parsers.py`.** Whole-line order restoration on top of
the existing within-word repair. Claimed: 3/3 damaged detected, 0/12 clean names moved, 12/12 round
trip. The gateway contract moved `3` → `4` on both sides, which per `CLAUDE.md` requires the VPS to
be redeployed in the same rollout.
- Can `_restore_line_order` corrupt a name that is already correct? It is claimed to be its own
  inverse.
- Is the contract bump handled on both sides, and is anything else gated on that version?

**11. Wave 7 — a source that does not isolate its claim is not a source.** Thirteen source-route
kinds were walked; most now carry a filter that reproduces the figure. Two mechanisms were added
to `src/lib/assistant/routeAccess.ts`: an **entity-param** rule (the value must equal the fact's
own `entity_id`, one parameter only) and a **shaped-param** rule (ISO-date `from`/`to`, an exact
parameter set). Nothing is composable.
- `routeAccess` decides which query strings an assistant answer may hand a reader. Can either new
  rule kind be used to construct a link the reader should not be able to follow — another
  tenant's entity, a wider window than the fact covers, a parameter set that composes into a
  broader read?
- `summaryLines.ts` grew `evidenceRoute` beside `to`, deliberately different promises. Is anything
  now rendering the wrong one?
- Seven dashboard tiles were found disagreeing with their links; in **six** of the seven the LINK
  was wrong and the tile was right, and in one — payment requests overdue — the list was wrong,
  which is the correction the plan predicted. Verify a couple against the live read models rather
  than taking the table's word.
- `/inventory` printed "below minimum: **0**" where every product was uncounted, because
  `is_low_stock` is `null` and the count tested `=== true`. It now distinguishes a measured zero
  from an em dash. Is the third state — an empty catalogue keeping an honest `0` — right?
- `R4-04`: four aggregates inside `currencyView` read the raw arrays instead of the filtered ones,
  so the dollar view rendered shekel figures. The proof offered is that the BEFORE ILS and BEFORE
  USD chart screenshots share one sha256. Check the fix covers all four and introduced no fifth.

## What this repository will punish you for missing

From `CLAUDE.md`, and every one of these has already cost this project a rollout:

- **The first definition of anything is almost never the live one.** A migration that created a
  function is not evidence of what it does; a later migration has usually replaced the body. Judge
  every claim against `pg_get_functiondef`, not against `0001`.
- **Anchored patches, never re-declaration.** Re-declaring a function from its creating migration
  silently reverts every patch since.
- **Two registries pin SECURITY DEFINER body hashes** (`private.scope_definer_enforcements`,
  `private.document_automation_authoritative_functions`). A rewrite that does not move its pin
  fails the scope assertions. `0298` was first written without those re-pins and the assertions
  caught it — check whether `0300` and `0301` have the same hole.
- **Every amount carries a currency, there is no conversion, and reporting is one row per
  currency.** Two currencies are never added or compared.
- **A metric with no data shows an em dash, never `0`** — and per decision F, "nothing is owed" is
  a sentence with no figure, which is a third state again.
- **Multi-tenancy:** every table carries `org_id` under an RLS policy filtering `org_id = auth_org()`.
  Storage paths must start with `{org_id}/`. `service_role` never reaches the browser.

## What is already known and is not a finding

Do not spend the round on these; they are recorded, not overlooked.

- Wave 6 step 3 is not applied, on purpose. Eleven client screens still read the stored column.
- Invoice 3377 is the single drifted row and has a data-remediation runbook, not a migration.
- The end-to-end signup **success** run has never been executed. The failure-injection gate exists
  and its positive control fails six of seven cases; the success path does not.
- The live assistant probes (cross-role isolation, prompt injection) never ran — the demo org's
  monthly allowance ran out. Unit coverage exists.
- The two production auth toggles are not applied; the script exists and is the owner's to run.
- `check:contrast` passes on `main`; `CLAUDE.md`'s claim that it never has is stale, and its
  `DEBT §97` citation points at an unrelated section. Correcting that text is pending.
- Zero-byte junk files keep appearing in the repo root from broken shell quoting. They are swept
  before each commit.

## What a useful finding looks like

A file and a line, what breaks, and the input or sequence that breaks it. "Consider adding tests"
is not a finding. A claim in this document that you can show is false **is** a finding, and the
most valuable one you can produce.
