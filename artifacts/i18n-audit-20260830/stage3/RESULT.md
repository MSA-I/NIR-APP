# Stage 3 — result

Plan: `docs/PLAN-english-completion-20260830.md`. Compared against `../stage2/report.json`.

## The eight money screens

| file | Hebrew lines before | after |
|---|---:|---:|
| `src/pages/Suppliers.tsx` | 43 | **1** |
| `src/pages/Dashboard.tsx` | 28 | **0** |
| `src/pages/ProductPurchaseSummary.tsx` | 21 | **0** |
| `src/pages/Payments.tsx` | 16 | **0** |
| `src/pages/Orders.tsx` | 13 | **0** |
| `src/pages/ConsolidatedInvoices.tsx` | 10 | **0** |
| `src/pages/Settings.tsx` | 9 | **3** |
| `src/pages/FinancialSupplier.tsx` | 6 | **0** |
| **total** | **146** | **4** |

Baseline **1,241 → 1,099** lines across **78 → 72** files. Keys with no call site **281 → 146**;
`dashboard` went from 38 orphans to none and `suppliers` from 53 to 6.

**The four lines that stay are audit reasons, and staying is the rule.** `Suppliers.tsx` keeps
`BANK_DETAILS_ACTION`; `Settings.tsx` keeps the five reasons `manage_profile_access` writes when a
user is enabled, disabled, un-done or has their role changed. All of them reach `p_reason` and land
in `audit_logs`, and a ledger whose wording depends on who was reading it cannot be searched. Both
files now carry a `__reason` entry in `scripts/i18n-baseline.json`, so they read as decisions rather
than as debt.

One thing that entry records and is worth repeating here: **`settings.text_47` and `text_48` hold
English for two of those audit reasons.** The English branch translated them — exactly what this
class forbids. They are left unused rather than wired, and Stage 9's orphan guard will keep them
visible.

## On screen

| screen | stage 2 | stage 3 |
|---|---:|---:|
| `/dashboard` | 25 | **4** |
| `/suppliers` | 7 | **0** |
| `/suppliers/:id` | 8 | **0** |
| `/finance/suppliers/:id` | 6 | **0** |
| `/orders` | 7 | **0** |
| `/orders/:id` | 2 | **0** |
| `/settings` | 26 | 23 |
| `/orders/new` | 38 | 3 |

Thirty-six of forty-four screens unchanged. **Twenty-two of 44 now carry no hardcoded Hebrew**,
against eight at the original baseline. Run total 279 → 190.

### Two of those numbers need a caveat

**`/orders/new` 38 → 3 is not a clean comparison.** That page rendered a much smaller draft this
run — body text 1,895 → 1,177 characters — so most of the difference is a different order state,
not a fix. `NewOrder.tsx`'s own Hebrew went 3 → 0 in Stage 1 and that is the only claim this stage
makes about it. The three strings still counted there are a supplier name and two aria-labels built
around it, all tenant data.

**`/dashboard`'s remaining 4 are not Dashboard's copy.** They are exception titles out of
`exceptions.title` — `חשד לחשבונית כפולה — בשר והבן #7702` and three like it — which the classifier
attributes to `PaymentRequests.tsx` only because that file happens to contain the same words. The
dashboard's own copy is fully translated; what is left is **class C**, and it is one of the three
owner decisions Stage 8 exists to record.

`/settings` stays high for the same reason as Stage 2: its Hebrew is `CurrencyTolerancesPanel.tsx`,
which is Stage 4.

## What the screenshot shows that the counts do not

`shots/owner-dashboard.png` — every row of "Needs attention today" now reads in English, and so does
the currency footnote that used to reflow into an unreadable RTL fragment on an LTR page.

But the weekly chart's legend now truncates: **`Purchas` / `Paymen`**. `רכש` and `תשלומים` fit the
space the legend allocates; "Purchasing" and "Payments" do not. That is a layout defect English
exposed rather than caused, it is not a translation hole, and it belongs with the design pass rather
than with this stage. Recorded here so it is not lost.

Month labels on the same chart still read `מאי 2026`, `יוני 2026` — **Stage 6**, `fmtMonth` pinned
to `he-IL`.

## Checks

`npx tsc --noEmit` clean · `npm run build` clean · every guard in `npm run verify` passed, including
`check:i18n` at the new pin (46 documented exceptions), `check:money` and `check:jsx-space`.

Vitest failed three specs — `exportTemplateWorkbook`, `monthlyReport`, `p2Reliability` — all with
`Test timed out in 5000ms`, all passing in isolation, and a fourth (`signup.spec.tsx`, at 5,147ms)
on a file this stage never touched. **This run measured why:** the machine was at **92% CPU with 19
vite dev servers running from other worktrees** and 55 node processes. The flakiness is the load,
not the code, and it is worth clearing those servers before reading a red suite as a finding.

## Method note

Two dictionary edits nearly went into the wrong object. `actionPrint: 'הדפסה'` exists in **two**
namespaces, so anchoring an insert on a key's text put it at risk of landing in the wrong one; every
insert in this stage anchors on the namespace opener (`  orders: {`), which is unique. Worth keeping
for the remaining stages.
