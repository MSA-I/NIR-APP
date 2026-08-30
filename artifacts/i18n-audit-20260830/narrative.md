# English-locale screen audit — 30.08.2026

**What was run.** `audit.cjs` signed in as the demo owner against the local stack with the locale
pinned to `en`, walked 44 routes, screenshotted each one full-page, and scanned the rendered DOM —
text nodes plus `aria-label`, `placeholder`, `title` and `alt` — for Hebrew. Every finding was then
classified against the product source: if the string exists in `src/` outside the dictionaries it is
**hardcoded** and renders in Hebrew whatever the reader chose; if not, it came from the **database**.

**Headline.** 44 routes, **115 distinct visible hardcoded Hebrew strings**, **8 clean screens** —
and all eight are the signed-out ones (`/login`, `/signup`, `/pricing`, `/forgot-password`,
`/reset-password`, `/accept-invite`, `/terms`, `/privacy`). **Every signed-in screen has Hebrew on
it.** The shell is English; the work is not.

**And the important part: most of it is already translated.**

> Of the 115 strings a reader sees, **86 already exist in `he.ts` with an English value at the same
> key**, and **47 of those keys are called from nowhere in the codebase**. `dashboard.text_24` holds
> `"Overdue payment requests"` in `en.ts` today. The dashboard renders `דרישות תשלום באיחור` anyway.

This is not a translation backlog. It is mostly a **wiring** backlog, and the wiring was lost at a
known commit.

---

## What actually happened, from the record

`7278f787` merged `claude/add-english-language-system-371a49` into `main`. Its own message says the
branch was cut from a `main` 43 commits behind, that the merge opened **326 conflicts across 79
files**, and states the resolution rule:

> main's BEHAVIOUR and wording win, the branch's translation layer survives

On most files that worked. On some it did not, because on those files the conflicting hunk *was*
the translation layer — the branch turned a Hebrew literal into `t('key')` on the same line `main`
had touched for the currency campaign, so keeping "main's wording" meant keeping the Hebrew literal.

Measured directly — translator calls on the English side of the merge versus what landed:

| file | on the branch | after the merge | dropped |
|---|---:|---:|---:|
| `src/pages/Expenses.tsx` | 59 | **0** | 59 |
| `src/pages/Suppliers.tsx` | 174 | 121 | 53 |
| `src/components/document-review/DocumentReviewWorkspace.tsx` | 45 | **0** | 45 |
| `src/pages/Dashboard.tsx` | 128 | 87 | 41 |
| `src/pages/dashboards/AccountantDashboard.tsx` | 35 | 15 | 20 |
| `src/pages/AccountantPaymentQueue.tsx` | 75 | 59 | 16 |
| `src/pages/PaymentRequests.tsx` | 124 | 108 | 16 |
| `src/pages/ProductPurchaseSummary.tsx` | 34 | 19 | 15 |
| … 33 more files | | | |
| **total** | | | **439 across 41 files** |

**`Expenses.tsx` and `DocumentReviewWorkspace.tsx` came through with their translation layer removed
entirely** — 59 and 45 calls to zero. `Expenses.tsx` still imports `useT`, but only for
`statusLabel`; it makes **no** `t('expenses.…')` call at all, while `he.ts` and `en.ts` each carry
**65 `expenses.*` keys** that nothing in the repository references. That is why `/expenses` is a
fully Hebrew page inside an English frame.

Not all 439 are regressions to undo. Where `main` genuinely restructured a line — `MoneyByCurrency`
instead of a scalar, one workbook sheet per currency — the branch's single-string version was the
wrong shape and dropping it was correct. **439 is the size of the gap to work through, not a count
of mistakes.** The 47 orphaned keys that the audit caught rendering as Hebrew on screen are the part
that is unambiguous.

Across the whole dictionary, **462 of 5,354 leaf keys have no literal call site** — concentrated
exactly where the audit found broken screens: `expenses` 65, `suppliers` 53, `docWorkspace` 45,
`dashboard` 38, `accountantDashboard` 20, `paymentRequests` 16, `payQueue` 16, `productPurchase` 15.
(Approximate: `status.*` and `errors.*` resolve dynamically and are excluded rather than counted.)

---

## The rest, in three classes

### A. Strings that were never translated — 29 of the 115

These are not in the dictionary in either language, and they cluster in **screens built after the
English branch was cut**, which is exactly what `DEBT §84` predicts:

| where | strings | what |
|---|---:|---|
| `src/components/OrgSubscriptionPanel.tsx` | 7 | `מחיר`, `מכסה`, `חוזית`, `מומלץ`, `גלובלי בדולרים`, the billing-currency note |
| `src/pages/Dashboard.tsx` | 5 | the currency footnote's fragments and two counted phrases |
| `src/pages/AcceptOperatorInvite.tsx` | 4 | `הצטרפות לצוות`, `ניהול הפלטפורמה, לא ניהול עסק`, `הקישור אינו תקין.`, `למסך הכניסה` |
| `src/pages/Expenses.tsx` | 4 | PDF/print actions and the per-currency average note |
| `src/pages/Orders.tsx` | 3 | the PDF download action and its tooltip |
| `src/App.tsx` | 3 | the capability-gate screen: `היכולת אינה כלולה במסלול` and its two lines |
| `src/pages/Suppliers.tsx` | 2 | two counted phrases |
| six more files | 1 each | `CurrencyTolerancesPanel`, `AccountantDashboard`, `InvoiceDetail`, `PaymentRequests`, `errors.ts`, `Pricing` |

(29 distinct strings; the rows sum higher because several are written in more than one file — the
PDF download action appears in three.)

Seven of the 29 are **counted phrases** — `2 בחומרה גבוהה`, `11 חשבוניות פתוחות`, `9 פריטים`,
`4 דרישות בתצוגה`, `0 בסה״כ`. They need a key **with a variable and a plural rule**, not a flat
string — `t.ts` already exports `pluralCategory`, so the mechanism is there.

One more of this class deserves naming on its own: `Dashboard.tsx:1018` writes a whole Hebrew
sentence straight into JSX around two interpolations — `המגמות והתמהיל מוצגים ב־{baseCurrency}. קיימת
פעילות גם ב־{…}, והיא אינה מחוברת אליהם.` It renders under the "Needs attention" card on every
dashboard, and its RTL fragments reflow into an unreadable line on an LTR page. Visible in
`shots/owner-dashboard.png`.

### B. Formatters pinned to `he-IL`, so dates ignore the reader

`src/lib/format.ts:95` builds `monthFmt` as `Intl.DateTimeFormat('he-IL', { month: 'long' })` and
never consults the locale. `fmtMonth` feeds the dashboard chart axis, the accountant dashboard, the
`/reports` month picker **and the printed heading of the monthly accountant report** — so an English
reader hands their accountant a document headed `אוגוסט 2026`. Four more sites do the same:
`consolidatedInvoices.ts:229`, `offlineQueue.ts:99`, `PriceListUpload.tsx:39`, `Dashboard.tsx:36`.

`src/pages/PriceLists.tsx:33` already does it correctly — `INTL_LOCALE[locale]` — so the pattern
exists in the repo and these sites simply predate it.

The numeric formatters (`fmtDate` → `28.08.2026`, `fmtNum`) produce the same digits either way.
Whether an English reader should see `28.08.2026` or `08/28/2026` is a business question, not a
defect; it is listed so the decision gets made rather than inherited.

### C. Hebrew stored in the database and rendered raw

The product is Hebrew-first and several columns are Hebrew by owner decision. Four surfaces reach
the reader with no recorded decision behind them:

- **Exception titles.** `/exceptions`, `/dashboard` and `/reports` print
  `Possible duplicate invoice — חשד לחשבונית כפולה — בשר והבן #7702`: the *type* resolves through
  the dictionary, the stored `exceptions.title` does not. The key
  `exceptionType_duplicate_invoice` already exists, so half the mechanism is built.
- **Alert titles and bodies written by migrations.** `0142_stuck_document_processing_alert.sql:94`
  inserts `עיבוד המסמכים אינו מתקדם` and its explanatory paragraph. `/alerts` shows both in Hebrew
  to an English reader.
- **Entitlement labels.** `0154_subscription_plans_and_entitlements.sql:70` seeds
  `'documents.monthly' → 'מסמכים בחודש'`. `/settings/subscription` prints the quota rows in Hebrew
  under English headings, next to plan names (`חינם`, `בסיס`, `פרו`, `פרימיום`, `ביזנס`) that
  produce sentences like `The פרימיום plan was given to this organisation…` and buttons reading
  `Move to חינם`.
- **Audit log wording.** `/supplier-log` shows its entries in Hebrew — 15 of the 17 Hebrew strings on the screen are log rows (`Created · קמח לבן (שק 25 ק"ג) ·
  תבליני הגליל`). The register's iron rule says audit evidence must not change language with the
  reader — which is right for the *stored* record and leaves open what the *reader* is shown.

**Category names are already decided and are not a defect.** The `/orders/new` filter chips
(`מזון · שתייה · ניקיון · חד פעמי · ציוד`) are `categories.name`, written byte-for-byte from
`seed.sql`; the baseline explains that translating the stored value would create a duplicate
category. What is missing is a display label beside the stored one — a smaller question.

Supplier names, product names and typed notes are tenant data and are correctly left alone.

---

## The five screens to look at first

1. **`/expenses`** — the whole page is Hebrew except the nav bar and one subtitle: title, all four
   range buttons, three KPI tiles, every table header, both export buttons. Its 65 English keys are
   written and unused. `shots/owner-expenses.png`.
2. **`/dashboard`** — the screen `CLAUDE.md §12` is written about. Every row of "Needs attention
   today" is Hebrew, the currency footnote is the raw JSX sentence above, the chart axis reads
   `מאי · יוני · יולי · אוגוסט`, and the "Due in the coming week" card puts an English heading over
   two Hebrew sub-lines. 23 visible strings, **17 of them already translated**.
   `shots/owner-dashboard.png`.
3. **`/reports`** — nine KPI tiles in Hebrew under an English heading, plus the Hebrew month name in
   the picker and in the printed accountant heading. `shots/owner-reports.png`.
4. **`/settings/subscription`** — the plan ladder. English sentences with Hebrew plan names
   embedded, Hebrew quota labels, `Move to חינם` buttons. Half class A, half class C.
   `shots/owner-settings-subscription.png`.
5. **`/suppliers`** — 53 dropped translator calls, the largest single loss after `Expenses.tsx`,
   showing up as Hebrew column headers (`ספק`, `קטגוריות`, `איש קשר`, `יתרה פתוחה`, `תנאי תשלום`).

---

## What this audit did *not* cover — so the numbers are not read as complete

- **One role only.** Owner. `AccountantDashboard.tsx` lost 20 translator calls and has 20 orphan
  keys, and its screen was never rendered here. Office and accountant homes were not visited.
- **Default states only.** No modals, dropdowns, toasts, confirmation dialogs, validation errors, or
  empty states other than what the seed produces. Hebrew inside a dialog is invisible to this method.
- **The count is a floor.** A string the source index cannot see is reported as database data, never
  the reverse — so 115 understates rather than overstates.
- **The operator console is excluded by decision, not oversight.** Separate Vite entry
  (`operator.html`); the owner ruled on 27.08.2026 that it is not translated — 16 files, 529 Hebrew
  lines. But four of them — `Overview.tsx`, `Team.tsx`, `UserDetail.tsx`, `Users.tsx` — are **missing
  from `__reason` in `scripts/i18n-baseline.json`**, so they read as undocumented debt when they are
  covered by that ruling. One paragraph fixes that.
- **The supplier portal** (`src/portal/`) has its own dictionary and `?lang=` switch; not walked.
- **Nothing off-screen**: Excel and PDF exports, the WhatsApp order text, auth emails, push
  notifications. Several of those are deliberately Hebrew (`share.ts`, `orderImage.ts`).
- **The local database is on migration `0241` while the repo carries `0253`.** `/pricing` could not
  load plans at all, and surfaces added by `0246`–`0253` rendered their failure states. Nothing is
  misreported, but a few screens are thinner than they would be against a current database.
- **`0253_profile_locale.sql` is not applied locally**, so the locale came from `localStorage` only.
  The profile round-trip is untested by this run.

---

## The cheapest next step

Not `scripts/extract.mjs`. Extraction already ran and the dictionary already holds the English.

1. **Re-wire the two files that came through empty** — `src/pages/Expenses.tsx` (59 calls) and
   `src/components/document-review/DocumentReviewWorkspace.tsx` (45). The branch side of `7278f787`
   holds a working version of each to diff against, and their keys are already translated. This alone
   clears the worst screen in the audit.
2. **Work the 47 orphan keys the audit caught on screen** — `report.json` names the string, the
   screen and the file for each one; `already-translated.json` pairs each with the English that
   already exists.
3. **Make `fmtMonth` take the locale.** One function, four screens, including a printed document.
4. **Write down the three class-C decisions** in `docs/OPEN-DECISIONS.md`: exception and alert
   titles, plan names and entitlement labels, and audit-log display. None of them are extraction
   work, and today they are being decided by default.
