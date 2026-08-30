# The date picker is Chrome's, not ours — measured 30.08.2026

**Owner question:** the date picker is still in Hebrew — is that covered by one of the stages?

**Answer: no, and it cannot be.** It is not a translation hole in the product.

## What was measured

The product has **no date-picker component**. It has 23 `<input type="date">` and
`<input type="month">` and nothing else, so the calendar that drops down is drawn by the browser,
outside the page. A page screenshot cannot even capture it.

`datepicker-probe.cjs` varies the two things the product controls and reads back the format Chrome
renders the value in — the same setting that names the months in the calendar:

| browser context locale | page `lang` | `navigator.language` | rendered |
|---|---|---|---|
| `en-US` | `en` | `en-US` | `01/08/2026` |
| `en-US` | `he` | `en-US` | `01/08/2026` |
| `he-IL` | `en` | `he-IL` | `01/08/2026` |
| `he-IL` | `he` | `he-IL` | `01/08/2026` |
| `de-DE` | `en` | `de-DE` | `01/08/2026` |
| `de-DE` | `he` | `de-DE` | `01/08/2026` |

**All six identical.** A US browser would render `08/01/2026` and a German one `01.08.2026`; neither
appeared. So the widget ignores `document.documentElement.lang` — which `LocaleProvider` sets and
which is the whole of the product's control over language — and it ignores `navigator.language` too.
It follows **Chrome's own UI language**, which on this machine is Hebrew.

Screenshots: `datepicker-en-US-en.png`, `datepicker-he-IL-en.png`, `datepicker-de-DE-en.png` — the
same picture three times, which is the finding.

## So what changes it

Only the reader's browser setting: Chrome → Settings → Languages. Switching the product to English
will never change that calendar, on any stage of the plan.

## What IS ours, and where it sits

Three things around the picker, and they are all in the plan:

- **The labels beside it** — `From` / `To` on `/expenses` were Hebrew until Stage 2; they read in
  English now.
- **`fmtMonth`, pinned to `he-IL`** — this is the one that looks like the picker and is not. It
  renders `אוגוסט 2026` in the `/reports` month selector, on both dashboard chart axes, and in the
  printed heading of the monthly accountant report. **Stage 6**, and it is one line.
- **`fmtDate` rendering `01.08.2026`** — an Israeli date format shown to an English reader. Not a
  defect; a decision, and Stage 6 records it in `OPEN-DECISIONS.md` with "leave it" as the default.

## If the native calendar in Hebrew is not acceptable

The only fix is to stop using the native input and render a date picker in the product, which then
follows the interface language like everything else. That is a new component with a keyboard and
screen-reader contract to meet, on 23 call sites — real work, and **not** part of this plan. It is
worth doing only if the owner decides the browser's calendar is a problem worth that price.

---

## Correction, 30.08.2026 (later) — this document tested the wrong control

**The owner asked again: "the dates the user sets to filter — right now they appear in Hebrew."
They are right, and the measurement above hid it.**

The probe tested `<input type="date">`, which renders **digits** — `01/08/2026` — so it never looks
Hebrew in any language, and "the widget ignores the page language" read as "there is nothing here
to see". There is. Five screens filter by MONTH, not by date:

| screen | control |
|---|---|
| `/reports` | `<input type="month">` — the monthly report's month |
| `/bank` | `<input type="month">` — the statement month filter |
| `/credits` | `<input type="month">` — the credits month filter |
| `/invoices` | `<input type="month">` — the invoices month filter |
| price-list review | `<input type="month">` — the target month |

`<input type="month">` renders a month **NAME**. `monthinput-probe.cjs` puts both controls side by
side on one `lang="en"` page and varies the browser context locale:

| context locale | month input | date input |
|---|---|---|
| `en-US` | `אוגוסט 2026` | `01/08/2026` |
| `he-IL` | `אוגוסט 2026` | `01/08/2026` |
| `de-DE` | `אוגוסט 2026` | `01/08/2026` |

Screenshots `monthinput-en-US.png`, `monthinput-he-IL.png`, `monthinput-de-DE.png` are the same
picture three times. So the conclusion about *control* holds — it follows Chrome's own UI language
and nothing the app sets can change it — but the consequence is the opposite of what this document
implied: **one of the two controls does display Hebrew words to an English reader, on five screens,
and Stage 6 did not touch it.** Stage 6 fixed `fmtMonth`, which is the month name the APP renders;
this is the month name the BROWSER renders.

## What it would take

The only fix is to stop using the native control on those five screens. Two shapes:

- **A month and a year select, rendered by the app.** Fully translated, keyboard-navigable, and it
  matches how `/expenses` already offers quick ranges. Costs a small component and an a11y pass on
  five call sites; the value stays the same `YYYY-MM` string, so `safeMonthISO`, `monthRange` and
  every query behind them are untouched.
- **`<input type="date">` pinned to the first of the month.** Nearly free — it renders digits, so
  the Hebrew disappears — but it asks the reader for a day when the screen means a month, and the
  native calendar would still open on days. Worse product for a cheaper change.

Neither is in the plan, because the plan was written from a measurement that had already looked
past this control. It is the owner's call whether the first is worth doing.
