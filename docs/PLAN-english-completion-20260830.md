# Plan — finishing English, 30.08.2026

Evidence this plan is built on: `artifacts/i18n-audit-20260830/` — 44 screenshots, `FINDINGS.md`,
`report.json`, `worklist.json` (per-file sizing), `already-translated.json`, `orphan-keys.json`.

## What the audit changed about the problem

`DEBT §84` reads as a translation backlog — 1,387 Hebrew lines across 91 files, closed by running
`scripts/extract.mjs` file by file. **That is the wrong shape.** Extraction already ran. The
dictionary already holds the English.

- **516 strings** are still rendered in Hebrew across the tenant application (43 files, excluding
  the operator console and the documented exemptions).
- **285 of them already have an English value at a matching key in `en.ts`.** Only **231** need a
  key and a sentence written.
- **462 of 5,354 dictionary keys have no call site at all.**
- The merge `7278f787` dropped **439 `t()` calls across 41 files** against the English branch —
  `Expenses.tsx` from 59 to 0, `DocumentReviewWorkspace.tsx` from 45 to 0.

So the work splits cleanly into **re-wiring** (large, mechanical, no judgement, existing specs are
the safety net) and **translation** (smaller, needs the voice rules in `PRODUCT.md` / `DESIGN.md`).
Doing them in that order gets the most screens fixed for the least risk.

## The rule this plan does not break

The classes listed in `scripts/i18n-baseline.json` `__reason` stay Hebrew, and each stage re-reads
them before touching a file:

- values written to `p_reason` and landing in `audit_logs`;
- OCR and spreadsheet matching vocabulary (`model.ts`, `FieldSpec.aliases`, `matchColumn`);
- stored values — `products.unit`, `categories.name`, `definition.title`;
- the supplier-facing WhatsApp text and order image.

The extractor has been caught rewriting all four before. Every stage below ends with a read of the
diff against that list, not a trust in the tool.

## How each stage is proved

Four checks, in this order, on every stage:

1. `npx tsc --noEmit` — a key that is not in the dictionary is a type error, not a blank screen.
2. `npm run test` — **the existing Hebrew specs are the regression net.** `src/test/setup.ts` pins
   the test locale to `he`, so `t('expenses.text_5')` returns the same Hebrew the literal held. A
   spec that breaks means the wording moved, which is exactly the signal wanted.
3. `node scripts/check-i18n.ts --update` — the guard is a two-way ratchet and will fail with
   *"extracted, baseline is stale"* the moment a file loses Hebrew. The baseline move commits with
   the change that earned it. Never `--update` a stage you have not read.
4. `node artifacts/i18n-audit-20260830/audit.cjs` — **the audit is the acceptance test.** The
   screen's count goes to zero or the stage is not done. This is the part that makes the plan
   falsifiable rather than a checklist.

`npm run verify` runs 1–3 together plus `check:money`, which is the guard that matters here: the
merge conflict was *"the branch turned a literal into `t()` on the same line main gave the money
call its currency"*, so money shape is the thing re-wiring can silently damage.

---

## Stage 0 — make the measurement honest (prerequisite)

The local database is on migration `0241` while the repo carries `0253`. `/pricing` could not load
plans at all during the audit, and everything `0246`–`0253` added rendered a failure state. Fixing
screens against a stale database produces evidence that proves nothing.

- Apply `0242`–`0253` locally (`docker exec … psql`, the `Invoke-SqlTest` pattern).
- `npm run demo:restore` afterwards — CLAUDE.md makes this mandatory for whoever touches the shared
  stack, and check the QA lock first: one run at a time on this machine.
- Re-run the audit to get a pre-fix baseline against a current database. Numbers in this plan will
  move; that is the point of taking the reading.
- Commit the audit harness so every later stage can re-measure.

**Risk:** `supplyflow-p0` is shared. Do not start mid-gate.

---

## Stage 1 — pure re-wiring, no English to write

Eight files, **50 strings**, every one of which already has an English value at a key nothing calls.
No translation, no judgement, no new copy.

| file | strings |
|---|---:|
| `src/pages/dashboards/AccountantDashboard.tsx` | 17 |
| `src/pages/Reports.tsx` | 11 |
| `src/pages/Invoices.tsx` | 6 |
| `src/pages/neworder/SupplierGroupCard.tsx` | 6 |
| `src/pages/neworder/SupplierSplitStep.tsx` | 5 |
| `src/pages/neworder/NewOrder.tsx` | 3 |
| `src/components/PlanTicket.tsx` | 1 |
| `src/pages/SupplierLog.tsx` | 1 |

Then three near-pure files — **22 strings, 3 of them new**: `Credits.tsx` (9+1), `Layout.tsx`
(5+1, including the `ניווט ראשי` aria-label that appears on *every* screen), and
`MinimumFixPanel.tsx` (5+1).

**Stage 1 total: 11 files, 72 strings, only 3 of which need English written.**

`worklist.json` names every string and its existing key, so this stage is lookup, not search.

**Why first:** it proves the method against the existing specs before anything harder, and it moves
the ratchet immediately. `AccountantDashboard.tsx` also un-breaks a screen the audit never even
rendered (owner role only), so it is the one stage that fixes something unmeasured.

---

## Stage 2 — the two files the merge emptied

**`src/pages/Expenses.tsx` — 46 matched + 12 new.** The worst screen in the audit: everything except
the nav bar and one subtitle is Hebrew, and 65 `expenses.*` keys sit translated and uncalled.

**Do not check out the branch version.** It is 451 lines against today's 567; `main` added the
currency campaign on top (`MoneyByCurrency`, a workbook sheet per currency). Re-wire *main's current
file*, using the branch side of `7278f787` only as the key map:

```bash
git show 830014b9:src/pages/Expenses.tsx
```

**`src/components/document-review/DocumentReviewWorkspace.tsx` — 13 matched + 1 new.** Same
zero-calls state, different cause: `main` restructured it from 435 lines to 201 and split parts out.
So `docWorkspace.*`'s 45 orphan keys do not all belong to this file any more — some describe UI that
now lives in `DocumentLineMapping.tsx` and `DocumentAssessmentPanel.tsx`, and some describe UI that
no longer exists. Re-home what applies, **delete what does not**, and say so in the commit.

---

## Stage 3 — the partially-wired money screens

Eight files, **178 strings** (115 already keyed, 63 new). These carry money and are where
`check:money` and the specs earn their place.

| file | matched | new |
|---|---:|---:|
| `src/pages/Suppliers.tsx` | 36 | 17 |
| `src/pages/Dashboard.tsx` | 32 | 16 |
| `src/pages/ProductPurchaseSummary.tsx` | 13 | 6 |
| `src/pages/Orders.tsx` | 8 | 8 |
| `src/pages/Payments.tsx` | 9 | 4 |
| `src/pages/Settings.tsx` | 7 | 6 |
| `src/pages/ConsolidatedInvoices.tsx` | 7 | 3 |
| `src/pages/FinancialSupplier.tsx` | 3 | 3 |

`Dashboard.tsx` carries one item that is not a string swap: **line 1018** writes a whole Hebrew
sentence into JSX around two interpolations, and its fragments reflow into an unreadable line on an
LTR page. It needs a single key with `{baseCurrency}` and `{others}` as variables, not four
fragments. Visible in `shots/owner-dashboard.png`.

---

## Stage 4 — screens born after the English branch was cut

Mostly translation rather than re-wiring: these screens were built after the English branch was
cut, so four fifths of their copy is in the dictionary in neither language. This is the part
`DEBT §84` correctly predicted.

**21 files, 177 strings — 137 of them needing English written**, the largest authoring block in the
plan and the smallest re-wiring one.

| file | already keyed | new |
|---|---:|---:|
| `src/components/CurrencyTolerancesPanel.tsx` | 8 | 30 |
| `src/components/document-review/DocumentLineMapping.tsx` | 8 | 27 |
| `src/pages/AcceptOperatorInvite.tsx` | 4 | 15 |
| `src/components/OrgSubscriptionPanel.tsx` | 9 | 12 |
| `src/components/document-review/DocumentAssessmentPanel.tsx` | 1 | 10 |
| `src/components/product-tour/ProductTour.tsx` | 3 | 8 |
| `src/components/InvoiceLineReviewModal.tsx` | 0 | 5 |
| `src/pages/Signup.tsx` | 1 | 4 |
| `src/pages/Pricing.tsx` | 0 | 4 |
| `src/App.tsx` (the capability-gate screen) | 0 | 3 |
| `src/pages/SupplierProposalReview.tsx` | 0 | 3 |
| `src/components/WhatsAppConnectionCard.tsx` | 1 | 3 |
| `src/components/document-review/PriceListAutomationReadiness.tsx` | 2 | 3 |
| eight smaller files | 4 | 10 |

`en.ts` copy rules, from its own header: British-neutral, sentence case, B2B control room — not a
marketing page. `PRODUCT.md` and `DESIGN.md` govern the voice.

---

## Stage 5 — `errors.ts` and the transitional shim

`src/lib/errors.ts` holds `ALLOCATION_REFUSAL_MESSAGES` and `toleranceRefusalMessage` — 17 strings,
15 of them Hebrew refusal sentences with no key at all, which its own comment calls *"for the transitional `toHebrewError` only"*. They reach
the reader on the money screens.

Move them to `errors.*` keys, resolve through `errorText()` — which `LocaleProvider` already
exposes and which already pairs `toErrorKey` with a dictionary lookup — and delete `toHebrewError`.
Its own stage because it changes an error surface that every screen touches.

---

## Stage 6 — formatters stop ignoring the reader

`src/lib/format.ts:95` pins `monthFmt` to `he-IL`. `fmtMonth` feeds the dashboard chart axis, the
accountant dashboard, the `/reports` month picker, **and the printed heading of the monthly
accountant report** — an English reader hands their accountant a document headed `אוגוסט 2026`.

Give it the locale. `src/pages/PriceLists.tsx:33` already shows the shape (`INTL_LOCALE[locale]`).
Four more sites carry the same pin: `consolidatedInvoices.ts:229`, `offlineQueue.ts:99`,
`PriceListUpload.tsx:39`, `Dashboard.tsx:36`.

**One decision inside this stage, and it is not a defect:** `fmtDate` renders `28.08.2026` in both
languages. Whether an English reader should see that or `08/28/2026` is a business question. The
default this plan carries is **leave it** — an Israeli business reads Israeli dates — recorded in
`OPEN-DECISIONS.md` rather than changed silently.

---

## Stage 7 — counted phrases

Seven strings the audit found that are not flat sentences: `2 בחומרה גבוהה`, `11 חשבוניות פתוחות`,
`9 פריטים`, `4 דרישות בתצוגה`, `0 בסה״כ`, and two more. Each needs a key **with a variable and a
plural rule**. `src/lib/i18n/t.ts` already exports `pluralCategory`, so the mechanism is there and
this is authoring, not building.

---

## Stage 8 — three owner decisions (blocks nothing, runs in parallel)

Hebrew that comes out of the database and reaches an English reader. None of it is extraction work,
and today all three are being decided by default. Each goes into `docs/OPEN-DECISIONS.md` **with a
default so nothing waits on an answer**:

| what | where it comes from | proposed default |
|---|---|---|
| Exception and alert titles | `exceptions.title`; `0142` writes the stuck-processing alert | show the translated *type* and keep the stored title as detail — the `exceptionType_*` keys already exist |
| Plan names, taglines, entitlement labels | `plans`, `0154:70` (`documents.monthly` → `מסמכים בחודש`) | add an English column beside the stored Hebrew; never translate the stored value |
| Audit-log display on `/supplier-log` | `audit_logs` | keep the record Hebrew (iron rule) and translate the *rendering* only |

Category names are **already decided** and are not on this list: the baseline explains that
`categories.name` is written byte-for-byte from `seed.sql`. What is missing is a display label
beside the stored one — a smaller, separate question.

---

## Stage 9 — stop it happening again

The merge that caused this was reviewed, documented and deliberate. Nothing in the repository
noticed that 439 translator calls had vanished. That is the actual defect.

1. **`scripts/check-i18n-orphans.ts`** — a pinned ratchet, same shape as `check:i18n` and
   `check-exemption-pin.ts`: fail when a dictionary key gains no call site, pinned at today's 462
   and only ever going down. `status.*` and `errors.*` resolve dynamically and are excluded by name
   with the reason written in the script. Wire it into `npm run verify`.
   `artifacts/i18n-audit-20260830/orphan-keys.cjs` is the working prototype.
2. **Document the four operator files** — `Overview.tsx`, `Team.tsx`, `UserDetail.tsx`,
   `Users.tsx` are missing from `__reason` in `scripts/i18n-baseline.json`, so 180 Hebrew lines
   covered by the 27.08.2026 owner ruling read as undocumented debt. One paragraph.
3. **Rewrite `DEBT §84`** with the real mechanism — it currently says the extractor never saw these
   files, and the truth is that the extraction landed and the wiring was dropped at `7278f787`.
   A next agent reading §84 today would run `extract.mjs` over files that already have keys and
   create a second set.
4. **`docs/PROGRESS.md`** entry stating what was measured, on which commit, and against which
   database.

---

## What this plan deliberately does not cover

- **Roles other than owner.** The audit walked one role. `AccountantDashboard.tsx` is in Stage 1 on
  the strength of static evidence, not a screenshot. Before calling English done, walk `office` and
  `accountant` with the same harness.
- **Modals, dropdowns, toasts, validation and error states.** Invisible to a page-load audit. They
  need an interaction pass, and it belongs after Stage 4 so it measures the fixed screens.
- **The supplier portal** (`src/portal/`) — its own dictionary and `?lang=` switch.
- **Off-screen surfaces** — Excel and PDF exports, WhatsApp order text, auth emails, push. Several
  are deliberately Hebrew; the auth email templates are already `DEBT` (English defaults in a
  Hebrew product, `PROGRESS.md:887`).
- **The operator console.** Owner ruling, 27.08.2026. Stage 9.2 documents it; it is not translated.

## Order, and why

Stages 1 → 2 → 3 are ordered by risk, not by size: mechanical first, then the two files with a known
good reference, then the money screens. Stages 4 → 7 are authoring and can run in any order or in
parallel. Stage 8 blocks nothing. **Stage 9 should not wait for the end** — the orphan guard is what
keeps stages 1–3 from being undone by the next large merge, so it is worth landing right after
Stage 1 proves the shape.
