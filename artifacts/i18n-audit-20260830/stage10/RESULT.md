# Stage 10 — the month filter stops speaking the browser's language

Not in the plan. It exists because the owner asked the same question twice, and the second time it
was clear the first answer had been measured against the wrong control.

## What was wrong

`DATE-PICKER.md` tested `<input type="date">`, found it renders `01/08/2026` under every locale, and
concluded that the native pickers ignore the page language and there is nothing here to fix. Both
halves of that were true and the conclusion was still wrong: **`<input type="month">` renders a
month NAME**, it takes that name from Chrome's own UI language, and on five screens an English
reader was being shown `אוגוסט 2026`.

`monthinput-probe.cjs` is the proof — the same page at `lang="en"` under `en-US`, `he-IL` and
`de-DE`, three identical screenshots reading `אוגוסט 2026`. Nothing the app sets can reach it.

## What was built

`MonthPicker` in `src/components/ui.tsx` — a month `<select>` and a year `<select>`, rendered by the
app and named by `Intl.DateTimeFormat` under the interface locale.

**Two selects and not a calendar** because a month is two independent choices, and because a
`<select>` already opens on Alt+Down, types-to-select and announces itself: no new keyboard contract
to write, no new focus ring, no new roving-tabindex to get wrong.

**The value is still `YYYY-MM`.** `safeMonthISO`, `monthRange`, the URL parameters and every query
behind them are untouched — this replaced a control, not a contract.

Two behaviours the native input handled for free and this one has to state:

- **Emptying either half clears the whole filter.** A year with no month is not a filter this app
  has, and half a value would only reach `safeMonthISO` to be rejected there.
- **A chosen year outside the offered window is kept in the list.** Otherwise a stored filter older
  than six years vanishes from its own control, and touching the month silently moves the year.

Five call sites: `/reports` (required, no blank), `/bank`, `/credits`, `/invoices` (all filters, so
blank allowed) and the price-list review's target month (`disabled` while saving).

## The flaw the screenshot caught

The first build gave both selects the same blank option, so the filter row read **"Any month | Any
month"**. `common.anyYear` was added and the year select now reads "Any year". This is the whole
reason for looking at the result rather than trusting a passing typecheck.

## Proof

`stage10/monthpicker-verify.cjs` signs in, switches language through the product's own control, and
reads back the selected option text on four screens in each language:

| screen | English | Hebrew |
|---|---|---|
| `/reports` | `August` · `2026` | `אוגוסט` · `2026` |
| `/invoices` | `Any month` · `Any year` | `כל החודשים` · `כל השנים` |
| `/credits` | `Any month` · `Any year` | — |
| `/bank` | `Any month` · `Any year` | — |

Screenshots in `stage10/shots/`. `reports.png` and `reports-he.png` are the pair worth looking at:
the same control, the same layout, the month name following the reader.

`src/components/monthPicker.spec.tsx` — 7 tests, the first two being the ones that say the
replacement was worth making.

## What this does NOT fix

`<input type="date">` is untouched, on all of its call sites. It renders digits in every language,
so it never showed the reader the wrong language; its **calendar popup** is still drawn by Chrome in
Chrome's UI language, and still cannot be reached from here. `#301` already records that the numeric
date format stays Israeli in both languages. If the owner wants that popup in English too, that is a
day-grid component and a separate decision.

## Checks

`npx tsc --noEmit` clean · `npm run build` clean · every guard in `npm run verify` passed
(`check:orphan-keys` 5,534 keys / 145 orphans, `check:i18n` 951 lines / 62 files, both unmoved) ·
Vitest **1957/1961**, the four failures being the same `Test timed out in 5000ms` workbook and
reliability specs that pass in isolation — machine load, not code.

`PriceListReviewConfirmation.spec.tsx` needed a real fix, not a re-pin: it queried
`getAllByRole('combobox')` meaning *the per-row product selects*, which was only ever correct while
this screen had no other select. The row select now carries `data-testid="price-list-row-product"`
and the spec asks for that. Same rows, same indices, a question that stays true.
