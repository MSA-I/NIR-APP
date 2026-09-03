# Wave 0 — gate results

Base: `b12d387d44a2d5991bdb42f72b86543fa75cf626` (origin/main == main == HEAD).
Migration head `0290`. Run 2026-09-03. Read-only throughout; no product code changed.

| Gate | Token | Result |
|---|---|---|
| W0-G1 | `BASE_LOCKED b12d387d` | fetch clean; origin/main, main and HEAD identical; ledger head `0290`. |
| W0-G2 | `PR_INVENTORY_OK` | authenticated as MSA-I; **zero open PRs**. No migration-number contention; next free number is `0291`. |
| W0-G3 | `UNMATCH_BY_DESIGN` | see below |
| W0-G5 | `PREFLIGHT_MISSING` | see below |
| W0-G6 | `GUARD_PRESENT` | see below |
| W0-G4, G7, G8, G10 | — | **blocked**: need production read access (see "Blocked"). |
| W0-G9 | — | not yet run. |

## W0-G3 — the unmatch refusal is deliberate; the message is the defect

The live `unmatch_bank_transaction` raises
`bank_direct_match_requires_financial_correction` (P0001) whenever the match carries an
`invoice_id` (`0034:507-514`). That is a design position, not a bug: undoing a **direct**
bank match would delete a payment record, so it must be reversed by a financial correction
instead.

**The defect is the translation.** The code is absent from the `PATTERNS` list in
`src/lib/errors.ts:67-82`, so it falls through to the generic "the action failed — contact
support". And that same file already carries a comment (`:68-72`) explaining that this exact
failure mode was fixed for four currency refusals in `0227`-`0232`, because "support is the
wrong destination for all four". The pattern to copy is nine lines above the gap.

**Consequence for Wave 1:** the item shrinks from "make unmatch work" to one entry in an
existing list plus one translation string — and a screen-level explanation of what a
financial correction is and where to make it.

## W0-G5 — both CORS defects reproduce live, and they fail differently

Preflight (`OPTIONS` + `Origin` + `Access-Control-Request-Method`) against production:

| Function | Status | CORS headers |
|---|---|---|
| `billing-checkout` | **401** | none |
| `webhook-verify` | **405** | none |
| `send-invite` | 200 | full |
| `interpret-document` | 200 | full |

**The gateway is not the cause.** `assistant`, `submit-price-list` and `tenant-export` all
declare `verify_jwt = true` and all answer the preflight **200**, so Supabase passes `OPTIONS`
through to the function. `billing-checkout` therefore returns 401 **from its own code**, which
checks environment and authorization before it ever inspects the method
(`billing-checkout/index.ts:31-35`), while `webhook-verify` reaches its method check and
returns 405 (`webhook-verify/index.ts:41-53`).

**One fix shape for both:** answer `OPTIONS` first, before any auth or environment check — the
pattern already in `assistant/index.ts:222-223`.

## W0-G6 — the credit guard is present, and my earlier reading was of a dead body

The **live** definition of `transition_credit_request` contains a guard that does not appear in
`0024`:

```
if p_status = 'offset'
   and <credit amount> < (select sum(allocation.amount)
                          from payment_allocations allocation
                          where allocation.org_id = v_org
                            and allocation.credit_id = v_credit.id)
then
  raise exception 'credit_request_not_fully_allocated' using errcode = 'P0001';
```

A manual move to `offset` now requires the credit to be allocated, which is precisely the 3377
shape it refuses. `0173` added it.

**Two consequences.** Invoice 3377 is confirmed as a **one-row data remediation, not a code
fix** — the migration this plan once contemplated is unnecessary. And I had told the owner that
"the manual transition creates no allocation", reading `0024`. That was true of `0024` and
false of the live body: **the ninth instance of this repository's recurring trap.**

## Blocked — production read access

`W0-G4` (auth rate-limit configuration), `W0-G7` (capacity), `W0-G8` (a source for clean
product names) and `W0-G10` (how many unapproved invoices the bank door has already settled)
all require reading production. The documented path — `scripts/db-query.ps1` with the
Management API token and `-AllowProduction` — was refused by the environment's permission
classifier. These are `SELECT`-only; none writes. They are the gates that size Wave 1's risk
and decide whether the product-name repair can be automated at all.

---

# Production gates (owner authorised, read-only, 2026-09-03)

## W0-G10 — `BLAST_RADIUS`: exactly one row, and it is the test's own

| Branch | Invoice status | Allocations | Invoices | Actors | Amount |
|---|---|---|---|---|---|
| direct | **in_review** | **1** | **1** | 1 | **2,950.00 ILS** |
| direct | approved | 7 | 6 | 1 | 8,229.00 ILS |
| via_payment | approved | 13 | 6 | 1 | 11,887.00 ILS |

The single unapproved settlement is invoice **6633 at 2,950 ILS** — the row the QA agent created
to demonstrate the gap. **No customer money has passed through this door**, and the
`via_payment` branch shows **zero** unapproved rows, so the standalone/legacy concern is real in
principle and empty in fact.

**Consequence for Wave 1:** RC1 is "close the door", not "close the door and remediate a
population". The one row is already on the cleanup list as the bank match that cannot be undone
from the interface — and W0-G3 explains why it cannot.

## W0-G8 — `NAME_SOURCE_FOUND`, and the damage is smaller and different than reported

| Measure | Value |
|---|---|
| Products | **271** — every one has a SKU; 149 have a barcode |
| Names showing extraction damage | **105 (39%)** |
| Names clean | 166 |
| Original submissions still stored | **4 PDFs, all with `storage_path`** |

**The report's "all 271 are garbled" is wrong, and so was my own note about reversal.** The
damage is a bidi extraction failure, not a reversal of every name: the PDF text layer holds
glyphs in *visual* order and the extractor read them as *logical* order. The signature is
specific — 6 names begin with a closing parenthesis, 27 carry a close with no open, and 93 have
a digit fused to a Hebrew letter (`)ג1/100תה עטוף` should read `תה עטוף 100/1ג(`). Names such as
`מפיות דמוי בד לבן PREMIUM NAPKINS` are **not damaged at all** — they are legitimately
bilingual.

**This also explains `A9-07`.** The approval queue offers 163 proposals byte-identical to the
stored name because **those names are already correct**; the queue is asking a human to approve
non-changes.

**And it changes decision A's blocker.** The owner does not hold a supplier spreadsheet, but the
source PDFs were never discarded. The fix is not to obtain a file — it is to correct the bidi
handling in the extraction path and re-run it against the retained submissions, which is exactly
the "fix at the root" the owner ruled for.

## W0-G4 — `RATE_LIMIT_ABSENT`, with four named toggles and one contradiction

Read from the production auth configuration:

| Setting | Value |
|---|---|
| `password_min_length` | **6** |
| `password_required_characters` | `null` |
| `password_hibp_enabled` | **false** |
| `security_captcha_enabled` | **false** |
| `hook_password_verification_attempt_enabled` | **false** |
| `security_update_password_require_current_password` | **false** |
| `mailer_notifications_password_changed_enabled` | **false** |

**There is no sign-in attempt limit in this configuration at all** — `rate_limit_verify`, `_otp`,
`_token_refresh` and `_anonymous_users` exist, but none of them governs password sign-in. That is
the 33-attempts-without-a-block finding, confirmed at its source.

**A contradiction worth recording:** the regression report says the password minimum "rose to 10".
**The server says 6.** So that minimum is a client-side check only, and the server would accept a
six-character password from any caller that skips the form.

**Three of these are switches, not code.** `password_hibp_enabled` alone refuses
`1234567890` and every other known-breached password, and
`hook_password_verification_attempt_enabled` is the supported mechanism for lockout — it exists,
and it is off.

**And two of them bear on decision G:** the platform never requires the current password
(confirming RC9's reclassification), and the "your password was changed" notification template
exists and is **disabled** — so today a password change is neither audited nor announced.
