# Stage 6 — result

Plan: `docs/PLAN-english-completion-20260830.md`. Compared against `../stage4/report.json`.

## What was wrong

`src/lib/format.ts:95` built `monthFmt` as `Intl.DateTimeFormat('he-IL', { month: 'long' })` and
never consulted the reader. Two more sites did the same: `consolidatedInvoices.ts` for the locked
month, and `PriceListUpload.tsx` for a submission month.

`month: 'long'` produces **words**, so an English reader saw `אוגוסט 2026` — on both dashboard chart
axes, in the `/reports` heading, on `/documents/consolidated-invoices`, in the supplier card's
submission list, and **inside the printed heading of the monthly accountant report**, a document the
tenant hands to their accountant.

## What changed

`fmtMonth(v, locale)`, with the formatter cached per locale for the same reason `localeExact` is —
it runs per chart point. The locale is threaded from `useT()` at all six call sites: `Dashboard`,
`AccountantDashboard`, and four in `Reports`. `previousJerusalemMonth(now, locale)` and
`submissionMonthLabel(value, locale)` take it the same way, and their two callers pass it.

`src/pages/PriceLists.tsx:33` had been doing this correctly all along — it was the model.

## On screen

The hardcoded counts do not move, and that is expected: a month name is produced by a formatter, not
by a literal in the source, so the audit classifies it as data. What moves is the **visible Hebrew**:

| screen | Hebrew strings visible, stage 4 → 6 |
|---|---|
| `/dashboard` | 19 → **14** |
| `/documents/consolidated-invoices` | 5 → **2** |
| `/reports` | 5 → **4** |

And the strings that disappeared are exactly the ones this stage was for:

```
/dashboard      מאי 2026 · יוני 2026 · יולי 2026 · אוגוסט 2026
                and inside the chart's own aria-label:
                "Purchasing expenditure by month: מאי 2026 ₪640.00, …"
/reports        "Invoices אוגוסט 2026"      → "Invoices August 2026"
/consolidated   "Locked month: יולי 2026"   → "Locked month: July 2026"
```

The aria-label matters as much as the axis: a screen-reader user in English was being read Hebrew
month names inside an otherwise English sentence.

## What did NOT change, deliberately

**`fmtDate` still renders `28.08.2026` in both languages**, and `fmtNum`, `fmtDateTime` and the two
clock formatters are untouched. The numeric ones produce identical digits either way, so they have
nothing to decide. The date order is a real question and it is now **recorded rather than
inherited** — `docs/OPEN-DECISIONS.md #301`, decided as *"the numeric format stays Israeli; month
names follow the reader"*, with the reasoning: an English reader of an Israeli business's books is
better served by `28.08.2026` than by `08/28/2026`, which someone used to day-month order can read
as the wrong day entirely. It is marked as a default awaiting owner confirmation, and it names what
would decide otherwise.

**The `/reports` month picker is still Hebrew, and it is not ours.** `shots/owner-reports.png` shows
`אוגוסט 2026` at the top right — that is the native `<input type="month">`, drawn by Chrome in
Chrome's own UI language, exactly as `../DATE-PICKER.md` measured. The heading two-thirds down the
same screenshot now reads `Invoices August 2026`. The two sitting on one screen is the clearest
illustration of where the boundary runs.

## Checks

`npx tsc --noEmit` clean · `npm run build` clean · every guard in `npm run verify` passed ·
Vitest: two failures, `monthlyReport` and `p2Reliability`, both `Test timed out in 5000ms` and both
passing in isolation together with `format.spec.ts`, `consolidatedInvoices.spec.ts` and
`priceListsI18n.spec.ts`. The machine load is back.
