# Stage 1 — result

Plan: `docs/PLAN-english-completion-20260830.md`. Baseline for comparison: the parent directory's
`report.raw.json` and `shots/`, both committed in `d68ee743`. Both runs used the **same classifier**,
so these numbers are comparable to each other even though the parent `report.json` was later
re-classified more strictly.

## What was done

Eleven files re-wired to keys that already held an English value. **67 Hebrew lines → 0**, and
`scripts/i18n-baseline.json` moved from **91 files / 1,387 lines to 80 / 1,320**.

| file | Hebrew lines before |
|---|---:|
| `src/pages/dashboards/AccountantDashboard.tsx` | 14 |
| `src/pages/Credits.tsx` | 13 |
| `src/pages/Reports.tsx` | 11 |
| `src/pages/Invoices.tsx` | 6 |
| `src/components/Layout.tsx` | 6 |
| `src/pages/neworder/SupplierGroupCard.tsx` | 4 |
| `src/pages/neworder/SupplierSplitStep.tsx` | 4 |
| `src/pages/neworder/MinimumFixPanel.tsx` | 4 |
| `src/pages/neworder/NewOrder.tsx` | 3 |
| `src/components/PlanTicket.tsx` | 1 |
| `src/pages/SupplierLog.tsx` | 1 |

Only **one** new English string had to be written — `nav.productGuide` — against the plan's estimate
of three. The other two turned out to exist already: `credits.fmtMoneyExact_2` carries its trailing
colon and `minimumFix.modalTitle` carries a `{supplier}` variable, and the sizing script's segment
splitter had stripped both, so it counted them as missing. The estimate was pessimistic in the
harmless direction.

## Screens that went to zero

`/credits` 11→0 · `/invoices` 8→0 · `/settings/webhooks` 5→0 · `/receiving` 2→0 ·
`/receiving/:id` 2→0 · `/invoices/:id` 2→0 · `/payments` 2→0 · `/reports/products` 2→0 ·
`/onboarding` 2→0. `/reports` 18→6 and `/documents/consolidated-invoices` 5→1.

**Every other signed-in screen dropped by exactly 2** — the two `Layout.tsx` aria-labels
(`ניווט ראשי`, `חיפוש`) that render on all 33 of them.

Run total, like for like: **368 → 315**.

## Three screens went UP, and not because of this change

| screen | before | after | where the new strings come from |
|---|---:|---:|---|
| `/settings` | 7 | 26 | 21 of 21 from `CurrencyTolerancesPanel.tsx` |
| `/pricing` | 0 | 16 | `OrgSubscriptionPanel.tsx`, `Pricing.tsx` |
| `/settings/subscription` | 15 | 24 | `OrgSubscriptionPanel.tsx`, `Pricing.tsx` |

None of those files was touched in Stage 1. They are all **Stage 4** files, and their Hebrew was
always there — it simply had nothing to render against. The local database moved from migration
`0241` to `0245` **during the session**, so the currency-tolerance panel and the plan rows now load
where they previously produced an error state. The first audit measured those screens broken; this
one measures them working.

This is the reading Stage 0 of the plan exists to prevent, and it happened because Stage 1 ran
first. The screen-level deltas above are only sound for screens whose rendering did not change with
the database; **the file-level evidence — 67 Hebrew lines to 0, verified statically — is unaffected
by any of it** and is the load-bearing proof for this stage.

## Two things the stage found that were not translation

**A real bug in the product tour.** `Layout.tsx` set `openGroup` to the Hebrew words `'ניהול'` and
`'בקרה'` when a tour step asked for a nav group, while `NavSection.section` is a `TKey`. The
comparison in `topNavGroup` could therefore never be true, and two steps of the owner first-run tour
spotlighted links inside a group that stayed shut. Nothing failed loudly — the tour still advanced.
Fixed to `'nav.text_6'` / `'nav.text_8'`, with a new assertion in
`productTourIntegration.spec.ts` that every `prepare` target is a section the shell actually
declares. No spec covered this, which is why it survived.

**The audit could measure the wrong language and say nothing.** `ProfileLocaleSync` adopts
`profiles.locale` after sign-in and the profile beats the localStorage copy — by design. The demo
owner's row said `he`, so a full 44-screen run produced confident counts of the Hebrew UI. `audit.cjs`
now reads `document.documentElement.lang` straight after sign-in and refuses to produce a report if
it is not `en`. Pin the fixtures before a run:

```sql
update profiles set locale = 'en'
where id in (select id from auth.users where email like '%@demo.supplyflow.local');
```

## Checks

`npx tsc --noEmit` clean · `npm run build` clean · every guard in `npm run verify` passed, including
`check:i18n` at the new pin and `check:money` · Vitest **1949/1951**, the two failures being
`Test timed out in 5000ms` on `exportTemplateWorkbook` and `p2Reliability`, which pass in isolation
and vary between runs — the known fork-timeout flakiness under full-suite load, not this change.

## Also noticed, not acted on

`profiles.locale` exists in the local database while `supabase_migrations.schema_migrations` has its
head at `0245` and holds no `0253` row. The schema and the ledger disagree, so the local stack does
not match any recorded migration state. Stage 0 should reconcile that before it re-baselines.
