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
