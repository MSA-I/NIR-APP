# Gates: a tolerance the owner can reach, and a check that admits it did not run

Execution branch: `plan/currency-tolerances-20260830`, cut from `origin/main`
(`0486995e91ea2fb6d35ea3c9d518f75c5b27ec70`). The previous campaign's gates — "money carries its
currency", 43/43 — are closed, recorded in `DEBT §69`, and preserved in git history.

Plan: `docs/PLAN-currency-tolerances-20260830.md`. Decisions: `#290`–`#294` (owner, 30.08.2026).
`#294` arrived after phases 0–5 were built, when the owner asked why a business abroad could not
simply work the way a business here works. Phase 7 is that answer, and it supersedes part of two
earlier gates rather than pretending they always said this.

Migration numbers: **`0243`, `0244` and `0245`**, each verified free against every local and remote branch at the
moment they were written. The previous campaign found **seven** files claiming `0213`–`0216` across
branches, which is why this is checked rather than assumed.

**What this campaign is not.** It adds no exchange rate in any form — not live, not stored, not
derived (`#290`). The owner's original wording, "a tolerance worth about a shekel against the
dollar", was read back as a conversion, put to the owner, and settled as a number typed once.

---

## Phase 0 — the guard before the code

- [x] P0-G1: a tolerance with nowhere to be decided fails the build
  CHECK: `node scripts/check-tolerance-surfaces.mjs` on the tree; then on a scratch migration
  calling `private.money_tolerance(o, c, 'invented_tolerance')`; then with the pinned key removed
  from the surface file
  EXPECT: green, then exit 2, then exit 3
  EVIDENCE: green, reporting `4 tolerance key(s) classified, 0 unlisted`. The scratch migration
  failed with exit 2 naming `invented_tolerance` and the file it came from. Renaming
  `bank_match_amount_tolerance` inside the surface file failed with exit 3. Both scratch changes
  were reverted and `git status` confirmed the tree byte-identical. Zero product behaviour changed
  in this phase — a script, a pinned JSON list, and one line of `package.json`.

---

## Phase 1 — stop the overwrite

The first phase in code, and the order is the point: while the save path collapsed the key to a
scalar, any per-currency value written by a later phase would be deleted by one press of "save".

- [x] P1-G1: a per-currency map survives a save from a screen that knows only shekels
  CHECK: `writeTolerance` against every stored shape; `npx tsc --noEmit`
  EXPECT: the other currencies untouched, the object not mutated, a cleared field absent rather
  than zero, and a shekel-only business left on the scalar shape
  EVIDENCE: `src/lib/tolerances.spec.ts`, 17 assertions, all passing. It keeps the replaced line as
  a measurement — `readTolerance(Number('1.5'), 'USD')` is null — so the reason the module exists
  is legible without reading history. `tsc --noEmit` exits 0.

- [x] P1-G2: the client stops inventing the number `#288` forbids
  CHECK: read `Bank.tsx` for the tolerance it hands `MatchModal`
  EXPECT: the tolerance is read in the LINE's own currency and may be null; no `?? 1`
  EVIDENCE: `effectiveTolerance(org?.settings?.bank_match_amount_tolerance, selected.currency,
  'bank_match_amount_tolerance')`, typed `number | null`. Both amount comparisons are guarded on
  `tolerance != null`; reference-equality candidates survive, because an exact reference match
  needs no tolerance.
  SUPERSEDED IN PART BY PHASE 7. When this gate closed, a dollar line had no threshold and the
  modal said so. Since `#294` it has one, derived from the dollar, so the sentence is now reached
  only by a currency this database cannot answer for. What this gate asserts — that the client
  never substitutes a shekel figure for another currency's — is unchanged and still enforced.
  SCREENSHOT: `artifacts/currency-tolerances/p1-g2-bank-usd-line.png` — a USD 3,100 statement line
  opening the match modal with no demand for setup and no invented threshold.

---

## Phase 2 — the reader (`0243`)

- [x] P2-G1: the answer is history, not open balance (`#292`)
  CHECK: an organisation whose only USD invoice is soft-deleted
  EXPECT: `currencies_in_use()` still returns USD
  EVIDENCE: `p82` asserts it, and the negative audit proves the assertion is real — adding
  `and invoice.deleted_at is null` to the migration fails P82 with exactly the history message.

- [x] P2-G2: one tenant's answer, through RLS rather than through a definer
  CHECK: two organisations, one with USD/EUR and one with JPY, read in both directions
  EXPECT: neither sees the other's currencies; a retired role sees nothing
  EVIDENCE: `p82` proves both directions and a zero-row answer for `kitchen`. The role gate is
  inside the body, so a retired role gets zero rows rather than a privilege error — the shape that
  does not take the backend down with it.

- [x] P2-G3: no definer surface was added to answer a question about ISO codes
  CHECK: `prosecdef` on the new function; `check:exemptions`; the scope and export assertions
  EXPECT: `f`, green, and no new exemption row
  EVIDENCE: the migration's own proof block raises if `prosecdef` is true, if `anon` can execute,
  or if `scope_enforcement_violations()` / `tenant_export_registry_violations()` return anything.
  Dry-run inside `begin/rollback` returned `0243_DRY_RUN_ALL_ASSERTIONS_PASSED`; the shared local
  stack was verified unchanged afterwards (`0241/235`, function absent, zero fixture rows).

---

## Phase 3 — the settings screen

- [x] P3-G1: four keys x every currency, and the unstated ones say so
  CHECK: render the panel for a two-currency business holding the legacy scalar
  EXPECT: eight fields; the shekel one carrying 1; the seven others empty and counted as needing
  a decision
  EVIDENCE: `currencyTolerancesPanel.spec.tsx` asserts the four labels per currency and that the
  stored shekel value is the only one carrying a figure. Six tests, stable across repeated runs.
  SUPERSEDED IN PART BY PHASE 7: the count of fields "needing a decision" was the defect `#294`
  removed, and the spec now asserts that no such demand appears. The gate's actual claim — a field
  per key per currency, and a stored value shown where there is one — still holds.
  SCREENSHOT: `artifacts/currency-tolerances/p3-g1-tolerances-panel.png` — ILS, EUR and USD, four
  fields each, the shekel bank field carrying the legacy `1`, every other box showing the
  threshold in force as its placeholder.

- [x] P3-G2: stating one currency's value does not touch another's
  CHECK: type a USD value and save
  EXPECT: the PATCH body carries `{ILS: 1, USD: 0.3}`, and keys the panel does not edit survive
  EVIDENCE: the spec captures the PATCH body through MSW and asserts both.

- [x] P3-G3: clearing a field returns it to never-stated, not to zero
  CHECK: clear the only value and save
  EXPECT: the key is absent from the saved settings
  EVIDENCE: asserted on the captured body. Zero would say "nothing may differ at all", which is a
  stricter instruction than the one being removed.

- [x] P3-G4: two defects the tests found rather than review
  EVIDENCE: (a) the draft mirrored stored settings through an effect and raced the organisation
  load, so a stored value could paint empty on the one screen whose job is to say what is missing;
  it now reads through at render time and holds only typed edits. (b) the loading skeleton added a
  second `role="status"` region to a page that already announces itself, which broke two existing
  `/settings` tests — a real accessibility defect, not a test to adjust.

---

## Phase 4 — the fields that write

- [x] P4-G1: no hardcoded currency symbol remains in a user-facing string
  CHECK: `git grep "₪" -- src` excluding specs and comments
  EXPECT: only parsers
  EVIDENCE: the live uses that remain are `document-review/model.ts` (stripping the symbol from OCR
  text, and mapping `₪ → ILS`) and `importSheet.ts` (stripping it from a cell) — all reading the
  symbol to LEARN a currency, which is the direction that is correct. Every other hit is comment
  prose. `check:money` and `check:currency` green.

- [x] P4-G2: each write field names the currency of the row it writes
  EVIDENCE: supplier minimum from `suppliers.default_currency`, and a supplier that does not exist
  yet gets no invented currency — the label says where the currency will come from instead. Credit
  from `invoice.currency`. Price list from `row.currency`. The import price cap now names NO
  currency, because `0023:2330` is a bare `> 1000000` and calling it a shekel ceiling described a
  rule the server never had.
  SCREENSHOT: `artifacts/currency-tolerances/p4-g2-supplier-minimum-usd.png` — the edit dialog
  reading `מינימום הזמנה (USD)` where it used to read `(₪)`.

- [x] P4-G3: a live defect found in passing, on the same field
  CHECK: does `/suppliers` fetch the column its minimum-order cell formats with?
  EXPECT: it should
  EVIDENCE: it did not. `Suppliers.tsx` imports `SUPPLIER_COLUMNS` and uses it for the edit dialog,
  but the list query spelled the column list out a second time and that copy fell behind:
  `default_currency` reached the table in `0217` and the shared constant, never this query. So
  `r.default_currency` was undefined for every row and `fmtMoneyExact(amount, undefined)` drew the
  minimum as an em dash for every supplier that had one — **in production, on a value that was in
  the database the whole time**. `check:supplier-columns` forbids `select('*')` on this table; it
  does not require the canonical list, so nothing caught the drift.
  SCREENSHOT: `artifacts/currency-tolerances/p4-g3-supplier-minimum-column.png` — the list column
  reading `$ 500.00`, on the same fixture that produced an em dash before this change.

---

## Phase 5 — intake stops skipping in silence (`0244`)

- [x] P5-G1: a document whose amount check cannot run says so, and still enters
  CHECK: a USD document with wrong line arithmetic, in an organisation with no USD tolerance
  EXPECT: `amount_check_skipped_no_tolerance` at `warning`, `approval_blocked` false, and no
  arithmetic finding — because the comparison genuinely was not made
  EVIDENCE: `p83` asserts all four. The fixture carries a real catalogue entry: without it the
  document raises `product_unidentified` at error and `approval_blocked` is true for a reason that
  has nothing to do with currency, which is what the first run of this suite measured.

- [x] P5-G2: state the tolerance and the check runs, for that currency only
  EVIDENCE: `p83` proves the skipped-check finding disappears, `line_arithmetic_discrepancy`
  appears for 2 x 100 billed as 250, and a EUR document still warns — a dollar tolerance does not
  answer for euros.

- [x] P5-G3: the shekel business feels nothing
  EVIDENCE: `p83` proves an ILS document from an ILS supplier gains no new finding and keeps its
  arithmetic check, on `0227`'s unchanged ILS fallbacks of `0.05` and `1`.

- [x] P5-G4: four refusals stop reading as one sentence
  EVIDENCE: `errors.ts` maps `bank_match_tolerance_unconfigured`, `bank_match_currency_mismatch`,
  `payment_request_currency_mixed` and `invoice_currency_precision_invalid`, all of which fell
  through to "the action failed, contact support". `toleranceRefusalMessage(canChangeSettings)`
  picks the destination by capability rather than by hope.
  NO SCREENSHOT, deliberately. Since `#294` the tolerance refusal is unreachable for any currency
  this database recognises, so there is no honest way to photograph it without deactivating a
  currency first — which `p83` does, in SQL, where the assertion belongs. The other three codes
  are one-line mappings with no screen of their own. A picture staged to show a state the product
  no longer produces would be worse than no picture.

- [x] P5-G5: the pins that failed the last campaign twice are asserted inside the migration
  CHECK: `document_automation_negative_guard_violations()` and `scope_definer_marker_violations()`
  EXPECT: empty
  EVIDENCE: both are asserted in `0244`'s proof block, so a P68 drift is a failed migration rather
  than a failed CI run an hour later. Measured first: the assessment is `SECURITY INVOKER` and
  carries no pinned body hash, and its two definer callers are untouched. Dry-run inside
  `begin/rollback` returned `P83_ALL_PASSED`; running `p83` WITHOUT the migration fails with
  "the skip is still silent".

- [x] P5-G6: `check:currency`'s intake guard still reads a live refusal out of the newest migration
  EVIDENCE: the guard failed first, correctly: it reads the LATEST migration touching the
  assessment and requires the unrecognised-currency refusal in it, and an anchored patch does not
  restate the clause. `0244`'s proof now asserts the code and severity together, verbatim, against
  the live body — strictly stronger than the string check it replaced, and the same fact the guard
  reads. Green: `still rejects an unrecognised currency as currency_unrecognised/error`.

---

## Visual evidence — how the pictures were taken, and what they are worth

`node scripts/check-currency-tolerance-evidence.cjs`, after `npm run build`. Four screenshots and
`evidence.json` land in `artifacts/currency-tolerances/`. The last run reported zero console errors.

**No database was touched, and that is enforced rather than promised.** The app is built against
`http://127.0.0.1:59999`, where nothing listens, and Playwright answers every request to that
origin from fixtures. A request this harness fails to stub cannot quietly reach the shared local
stack — it fails with a connection refusal. `supplyflow-p0` stayed at `0241/235` throughout, which
is why these gates could be photographed while the stack belongs to everyone.

**What a screenshot here proves is the SCREEN, not the server.** These are the real components,
router and stylesheet rendering the state the server would produce. That the server produces it is
what `p82`, `p83` and the two migrations' proof blocks are for.

Four environment traps are recorded in the script itself so the next person pays for them once:
the bundled chromium will not launch on this machine, vite binds to `localhost` rather than
`127.0.0.1`, `.single()` needs an object rather than an array of one, and — the one that cost the
most — an orphaned dev server from an earlier run held the port, so `--strictPort` made every later
`preview` exit silently under `stdio: 'ignore'` and the browser talked to the orphan. Every fix
measured after that point was measured against the wrong server.

---

## Phase 7 — every currency answers for itself (`0245`, `#294`)

Added after the owner asked why a business abroad could not simply work the way a business here
works. The answer was that it could, and that nothing but a decision was stopping it.

- [x] P7-G1: the shekel cannot tell that this happened
  CHECK: `private.money_tolerance` for ILS on all four keys, before and after
  EXPECT: 1, 1, 1 and 0.05 — the figures `0227`/`0232` hard-coded
  EVIDENCE: `0245`'s own proof block raises on any other answer, so an existing Israeli business
  cannot be affected by a migration it did not ask for. `p83` asserts the same from the outside.

- [x] P7-G2: a dollar document is checked without anybody configuring anything
  CHECK: the same wrong line (2 x 100 billed as 250) in a USD document, in an organisation that
  has stated no dollar value
  EXPECT: `line_arithmetic_discrepancy`, and NO `amount_check_skipped_no_tolerance`
  EVIDENCE: `p83`. Before `0245` this document produced the opposite of both.

- [x] P7-G3: the rule reads the currency, not a scale somebody assumed
  CHECK: JPY (no minor unit) and KWD (three)
  EXPECT: JPY 100 and 5; KWD 0.100 and 0.005
  EVIDENCE: `p83` and `0245`'s proof. The numbers come from `currencies.minor_units`, seeded for
  all 157 codes in `0217`, so no list is maintained twice.

- [x] P7-G4: nothing was converted, and "cannot compare" survived
  CHECK: a deactivated currency; and a grep for anything rate-shaped
  EXPECT: `null`, `0232` still refusing and `0244` still finding; no rate stored anywhere
  EVIDENCE: `p83` deactivates EUR and proves both. A dollar threshold of 1.00 is a hundred cents,
  derived from the dollar — no amount here is computed from another currency (`#287`, `#290`).

- [x] P7-G5: a stated value still wins, and only for the currency it names
  EVIDENCE: `p83` states USD 60, proves it beats the derived 0.05, proves EUR still derives 0.05,
  and proves the wider window actually silences the discrepancy it is wide enough to cover.

- [x] P7-G6: the settings screen stops demanding work that does not exist
  CHECK: render the panel for a brand-new shekel-only business
  EXPECT: no banner, and every empty field showing the threshold in force as its placeholder
  EVIDENCE: `currencyTolerancesPanel.spec.tsx` asserts the banner is absent and that the USD
  placeholders read 1.00 and 0.05.
  SCREENSHOT: `artifacts/currency-tolerances/fresh-org-tolerances-panel.png` — the same screen that
  previously told a new business "3 values still need a decision" while the server was answering
  all three. Reproduce with `node scripts/check-currency-tolerance-evidence.cjs --fresh-org`.

---

## Phase 6 — CI and rollout

- [ ] P6-G1: the heavy gate is green on the SHA
  CHECK: `gh workflow run quality-gate.yml && gh run watch`
  EXPECT: success, including the new `p82` and `p83` stages

- [ ] P6-G2: the rollout matrix rows that were touched were actually executed
  ROWS: `Migration / חוזה DB` (backup, dry-run, forward-only apply, **manual ledger row**,
  postflight) and `Frontend / נכס ציבורי` (build, Pages, hash parity, smoke).
  NOT RUN, deliberately: no Edge function changed, `worker/ocr` is untouched and its two gateway
  contract versions did not move, and no permission changed, so there is no role matrix.

---

No gate is abandoned. A gate dropped later is recorded with `ABANDON:` and its reason — never
deleted quietly.
