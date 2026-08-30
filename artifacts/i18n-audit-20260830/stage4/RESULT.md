# Stage 4 — result

Plan: `docs/PLAN-english-completion-20260830.md`. Compared against `../stage3/report.json`.

This is the first stage that **wrote English** rather than reconnecting English that already existed.

## What was translated

| file | Hebrew lines before | after |
|---|---:|---:|
| `src/components/CurrencyTolerancesPanel.tsx` | 39 | **0** |
| `src/components/document-review/DocumentLineMapping.tsx` | 31 | 2 |
| `src/pages/AcceptOperatorInvite.tsx` | 17 | **0** |
| `src/components/OrgSubscriptionPanel.tsx` | 15 | **0** |
| `src/components/document-review/DocumentAssessmentPanel.tsx` | 7 | 1 |
| `src/components/InvoiceLineReviewModal.tsx` | 5 | 2 |
| `src/components/document-review/PriceListAutomationReadiness.tsx` | 5 | 2 |
| `src/pages/Signup.tsx` | 4 | **0** |
| `src/pages/Pricing.tsx` | 4 | **0** |
| `src/App.tsx` | 3 | **0** |
| `src/components/SupplierCommunicationCard.tsx` | 3 | 1 |
| `src/pages/SupplierProposalReview.tsx` | 3 | 1 |
| `src/components/document-review/DocumentScanPreview.tsx` | 2 | **0** |
| `src/pages/Inventory.tsx` | 1 | **0** |
| `src/components/FileUpload.tsx` | 1 | **0** |

Baseline **1,099 → 968** lines across **72 → 63** files. Six new namespaces — `tolerances`,
`lineMapping`, `operatorInvite`, `scanPreview`, and additions to eight more — carrying **about 120
sentences written in English for the first time**.

## On screen

| screen | stage 3 | stage 4 |
|---|---:|---:|
| `/settings` | 23 | **0** |
| `/operator-invite` | 4 | **0** |
| `/settings/subscription` | 24 | 11 |
| `/pricing` | 16 | 11 |

Forty of forty-four screens unchanged. **Twenty-four of 44 now carry no hardcoded Hebrew.** Run
total 190 → 145.

**The eleven left on both subscription screens are the same eleven, and none of them is ours.** They
are entitlement labels seeded by `0154_subscription_plans_and_entitlements.sql` — `מסמכים בחודש`,
`משתמשים פעילים`, `קריאה אוטומטית של מסמכים` — attributed by the classifier to operator files that
merely contain the same words. The proof that this stage worked is visible inside one of them:
`קריאה אוטומטית של מסמכים — open for the first 30 days` is the new `entitlementIntroOnly` key
rendering its English half around a Hebrew label the database supplied. **Class C, and Stage 8's
decision.**

## What did not get translated, and why each one is a decision

Twelve files gained a `__reason` entry rather than a translation. Every one falls in a class the
register already names:

- **Eight are audit reasons** reaching `p_reason` and `audit_logs` — `WhatsAppConnectionCard`,
  `PriceListAutomationReadiness`, `InvoiceLineReviewModal`, `DocumentOperations`,
  `DocumentAssessmentPanel`, `SupplierCommunicationCard`, `SupplierProposalReview`,
  `ProductNameRepairReview`. A ledger whose wording follows the reader cannot be searched.
- **`ProductTour.tsx` is bilingual by its own design** — `Record<ProductHelpLocale, …>`, complete on
  both sides, exactly like `productHelpRegistry.ts`. Moving its Hebrew into the dictionary would
  delete the base locale the guard compares against.
- **`DocumentLineMapping` keeps the unit** written into `products.unit`, which owner decision #282
  holds in Hebrew because the value IS the key `name_match_key` is built on.
- **`reportTemplateExport.ts` and `workbook.ts`** write into the .xlsx, not onto a screen. Off-screen
  surfaces are outside this plan's scope.

**One defect found while writing those reasons, and left as found.**
`DocumentAssessmentPanel.tsx:184` passes `t('docAssessment.reasonOr')` into `p_reason` — so that
audit reason *does* follow the reader's language, which is precisely what the iron rule forbids. It
is the same defect `settings.text_47`/`text_48` recorded in Stage 3. Changing it rewrites ledger
wording, so it is not something to do inside a translation pass; it is written into the baseline
reason so the next reader sees it.

## Two things the mechanics taught

**CRLF.** Some files here are checked out with CRLF, so a multi-line search pattern written with
`\n` matches nothing and reports "expected 1, got 0" exactly as a moved anchor would. Every swap
helper now normalises the pattern to the file's own terminator.

**Anchor on the namespace, not on a key's text.** `actionPrint: 'הדפסה'` exists in *two* namespaces,
and `quotaUnlimited` and `prepareReasonLabel` were already taken in the namespaces this stage added
to. Three near-misses, all caught by `tsc`'s duplicate-property error rather than by the script.
Inserts anchor on `  <namespace>: {`, which is unique.

## Checks

`npx tsc --noEmit` clean · `npm run build` clean · every guard in `npm run verify` passed, including
`check:i18n` at the new pin (58 documented exceptions), `check:money`, `check:jsx-space` and
`check:tolerance-surfaces` — the last one matters here, because `TOLERANCE_KEYS` now carries keys
instead of labels and the guard reads that table.

Vitest **1951/1952**; the one failure is `p2Reliability` at `Test timed out in 5000ms`, which passes
in isolation. Same machine load as Stage 3.

Dictionary keys with no call site: **146 → 145** — flat, because this stage created keys and used
them in the same commit rather than reconnecting keys that were already there.
