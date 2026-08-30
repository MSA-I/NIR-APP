# Stage 2 — result

Plan: `docs/PLAN-english-completion-20260830.md`. Compared against `../stage1/report.json`, same
classifier, same database state, same harness.

## The two files the merge emptied

Merge `7278f787` brought both of these across with their translation layer removed — 59 and 45
`t()` calls to zero — while their dictionary keys came through translated and uncalled.

| file | Hebrew lines before | after | `t()` calls now |
|---|---:|---:|---:|
| `src/pages/Expenses.tsx` | 67 | **0** | 68 |
| `src/components/document-review/DocumentReviewWorkspace.tsx` | 12 | **0** | 12 |

Baseline moved **1,320 → 1,241** lines across **80 → 78** files. Dictionary keys with no call site:
**462 → 281**.

## On screen

| screen | stage 1 | stage 2 |
|---|---:|---:|
| `/expenses` | 31 | **0** |
| `/documents/:id/review` | 11 | **6** |

**Forty-two of the forty-four screens are unchanged**, which is the result worth reading: the change
did exactly what it claimed and touched nothing else. Seventeen of 44 screens now carry no hardcoded
Hebrew, against eight at the original baseline — and all eight of those were signed-out.

`shots/owner-expenses.png` is the screen the audit named worst. The only Hebrew left on it is a
supplier name, which is tenant data.

## `Expenses.tsx` — not a revert

The branch version is 451 lines against today's 567; `main` added the currency campaign on top.
The file was re-wired in place against `main`, using the branch only as the key map. Nine keys had
to be added and five reworded, all for surface the branch never saw:

- `currencyColumn` — the currency column main added to all three Excel sheets;
- `pdfTitle`, `pdfSubtitle`, `toastPdf`, `exportPdf`, `exportPdfLabel` — the branded PDF export;
- `shareOfCurrency` — a share is now *of the total in one currency*, so the sentence takes the
  currency as a variable;
- `rowLabel`, `drillTitle` — both now name the currency, because a supplier appears once per
  currency and two rows with the same accessible name are two rows nobody can tell apart;
- `text_22` — "total divided by the number of invoices" became "…, in each currency separately";
- `print` / `print_2` — main's print button says something narrower than the branch's.

Every reworded key was an orphan, so no call site and no spec moved under it.

`PRESETS` is module-level and cannot hold a translated string, so it carries `labelKey: TKey` and
the one place that renders it resolves it — the same split `Layout`'s `NavSection` already uses.

## `DocumentReviewWorkspace.tsx` — and 31 keys deleted

`main` restructured this component from 435 lines to 201, so only 12 of its 45 `docWorkspace.*` keys
still describe anything. The other 31 cover the technical-details disclosure, the raw-confidence
tables and the evidence chips — **a surface the owner had removed on 28.08.2026** ("אנחנו לא אמורים
לראות את כל הprocess של ה-OCR"), and `DocumentReviewWorkspace.spec.tsx:158-160` asserts its absence.

They were deleted from both dictionaries rather than re-homed. Translated copy for a panel the owner
removed is an invitation to put the panel back.

## The harness stopped depending on a fixture

Stage 1 pinned `profiles.locale = 'en'` for the demo accounts in SQL. **It did not hold.** The demo
owner's row was back to `he` before this run, with no gate, no `demo:restore` and no migration
running — only read-only MCP servers. The assertion added in Stage 1 caught it and refused to
measure, which is what it is for, but refusing is not the same as working.

`audit.cjs` now switches to English **through the product's own control** — `#settings-ui-locale` on
`/settings` — and waits for `document.documentElement.lang` to follow, before it measures anything.
It no longer depends on a value another process may rewrite, and a broken language switch now fails
the audit instead of quietly changing what it measures. This run used that path and logged
`switched to English through /settings`.

## Checks

`npx tsc --noEmit` clean · `npm run build` clean · every guard in `npm run verify` passed, including
`check:i18n` at the new pin, `check:money` and `check:jsx-space` · Vitest **1950/1952**, the two
failures being `Test timed out in 5000ms` on workbook/report specs that pass in isolation and differ
between runs — the same fork-timeout flakiness as Stage 1.

## Still open from Stage 1, unchanged

`/settings` (26), `/pricing` (16) and `/settings/subscription` (24) remain high. Their Hebrew is in
`CurrencyTolerancesPanel.tsx`, `OrgSubscriptionPanel.tsx` and `Pricing.tsx` — **Stage 4**, and none
of it is in the dictionary in either language yet.
