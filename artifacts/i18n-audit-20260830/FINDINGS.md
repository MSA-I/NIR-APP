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

## Appendix A — every route walked

`hardcoded` = the string exists as a literal in `src/` outside the dictionaries, so it renders
in Hebrew whatever the reader chose. `data` = not in the source; it came out of the database.
Counts are distinct strings per screen, so the same header on ten rows counts once.

| screen | route | hardcoded | visible | data | screenshot |
|---|---|---:|---:|---:|---|
| owner-expenses | `/expenses` | 34 | 31 | 8 | `owner-expenses.png` |
| owner-dashboard | `/dashboard` | 24 | 23 | 26 | `owner-dashboard.png` |
| owner-reports | `/reports` | 12 | 10 | 16 | `owner-reports.png` |
| owner-credits | `/credits` | 11 | 4 | 13 | `owner-credits.png` |
| owner-settings-subscription | `/settings/subscription` | 11 | 10 | 22 | `owner-settings-subscription.png` |
| owner-supplier-detail | `/suppliers/aa000000-0000-4000-8000-000000000001` | 10 | 9 | 11 | `owner-supplier-detail.png` |
| owner-payment-requests | `/payment-requests` | 10 | 8 | 15 | `owner-payment-requests.png` |
| owner-bank | `/bank` | 10 | 3 | 25 | `owner-bank.png` |
| owner-suppliers | `/suppliers` | 9 | 6 | 68 | `owner-suppliers.png` |
| owner-orders | `/orders` | 9 | 6 | 25 | `owner-orders.png` |
| owner-invoices | `/invoices` | 8 | 5 | 43 | `owner-invoices.png` |
| owner-document-review | `/documents/f1111111-1111-4111-8111-111111111112/review` | 7 | 6 | 15 | `owner-document-review.png` |
| owner-finance-supplier | `/finance/suppliers/aa000000-0000-4000-8000-000000000001` | 6 | 5 | 8 | `owner-finance-supplier.png` |
| owner-settings | `/settings` | 6 | 5 | 10 | `owner-settings.png` |
| owner-order-detail | `/orders/f0000000-0000-4000-8000-000000000001` | 5 | 4 | 13 | `owner-order-detail.png` |
| owner-documents-consolidated | `/documents/consolidated-invoices` | 5 | 4 | 4 | `owner-documents-consolidated.png` |
| owner-settings-webhooks | `/settings/webhooks` | 5 | 4 | 4 | `owner-settings-webhooks.png` |
| public-operator-invite | `/operator-invite` | 4 | 4 | 0 | `public-operator-invite.png` |
| owner-prices | `/prices` | 4 | 3 | 43 | `owner-prices.png` |
| owner-supplier-log | `/supplier-log` | 3 | 1 | 47 | `owner-supplier-log.png` |
| owner-products | `/products` | 2 | 1 | 69 | `owner-products.png` |
| owner-inventory | `/inventory` | 2 | 1 | 55 | `owner-inventory.png` |
| owner-order-new | `/orders/new` | 2 | 1 | 104 | `owner-order-new.png` |
| owner-receiving | `/receiving` | 2 | 1 | 9 | `owner-receiving.png` |
| owner-receive-order | `/receiving/f0000000-0000-4000-8000-000000000001` | 2 | 1 | 59 | `owner-receive-order.png` |
| owner-invoice-new | `/invoices/new` | 2 | 1 | 20 | `owner-invoice-new.png` |
| owner-invoice-detail | `/invoices/f4000000-0000-4000-8000-000000000008` | 2 | 1 | 4 | `owner-invoice-detail.png` |
| owner-documents | `/documents` | 2 | 1 | 26 | `owner-documents.png` |
| owner-documents-archive | `/documents/archive` | 2 | 1 | 20 | `owner-documents-archive.png` |
| owner-documents-operations | `/documents/operations` | 2 | 1 | 10 | `owner-documents-operations.png` |
| owner-payments | `/payments` | 2 | 1 | 4 | `owner-payments.png` |
| owner-exceptions | `/exceptions` | 2 | 1 | 27 | `owner-exceptions.png` |
| owner-alerts | `/alerts` | 2 | 1 | 6 | `owner-alerts.png` |
| owner-reports-products | `/reports/products` | 2 | 1 | 4 | `owner-reports-products.png` |
| owner-analytics | `/analytics` | 2 | 1 | 19 | `owner-analytics.png` |
| owner-onboarding | `/onboarding` | 2 | 1 | 4 | `owner-onboarding.png` |
| public-login | `/login` | 0 | 0 | 0 | `public-login.png` |
| public-signup | `/signup` | 0 | 0 | 0 | `public-signup.png` |
| public-pricing | `/pricing` | 0 | 0 | 0 | `public-pricing.png` |
| public-forgot-password | `/forgot-password` | 0 | 0 | 0 | `public-forgot-password.png` |
| public-reset-password | `/reset-password` | 0 | 0 | 0 | `public-reset-password.png` |
| public-accept-invite | `/accept-invite` | 0 | 0 | 0 | `public-accept-invite.png` |
| public-terms | `/terms` | 0 | 0 | 0 | `public-terms.png` |
| public-privacy | `/privacy` | 0 | 0 | 0 | `public-privacy.png` |

Totals: **44** routes, **128** distinct hardcoded strings of which **115** rendered visible, **8** screens with none.

## Appendix B — what an English reader sees, screen by screen

Visible strings only, ordered worst first. Screens with nothing visible are omitted.

### `/expenses`  (31)

- `ריכוז הוצאות` — src/pages/Expenses.tsx
- `הדפסה` — src/pages/Expenses.tsx, src/pages/Orders.tsx
- `החודש` — src/pages/Expenses.tsx
- `חודש קודם` — src/pages/Expenses.tsx
- `3 חודשים` — src/pages/Expenses.tsx
- `שנה` — src/pages/Expenses.tsx
- `עד` — src/pages/Expenses.tsx
- `סה״כ הוצאות בטווח` — src/pages/Expenses.tsx
- `מספר חשבוניות` — src/pages/Expenses.tsx, src/pages/ProductPurchaseSummary.tsx
- `חשבוניות שאינן מחוקות בטווח` — src/pages/Expenses.tsx
- `ממוצע לחשבונית` — src/pages/Expenses.tsx
- `סה״כ חלקי מספר החשבוניות, בכל מטבע בנפרד` — src/pages/Expenses.tsx
- `הוצאות לפי ספק` — src/pages/Expenses.tsx
- `ספק` — src/pages/Credits.tsx, src/pages/Expenses.tsx, src/pages/Invoices.tsx, src/pages/Orders.tsx, src/pages/Payments.tsx
- `סה״כ` — src/pages/ConsolidatedInvoices.tsx, src/pages/Expenses.tsx, src/pages/Invoices.tsx, src/pages/neworder/SupplierSplitStep.tsx, src/pages/Orders.tsx, src/pages/Reports.tsx, src/pages/Suppliers.tsx
- `% מהסך` — src/pages/Expenses.tsx
- `פירוט מוצרים לפי קטגוריה` — src/pages/Expenses.tsx
- `מידע משלים מהזמנות מקושרות; אינו מחליף את סכומי החשבוניות בטבלת הספקים.` — src/pages/Expenses.tsx
- `הצג פירוט` — src/pages/Expenses.tsx
- `חשבוניות מקושרות בסך` — src/pages/Expenses.tsx
- `מתוך` — src/components/document-review/DocumentLineMapping.tsx, src/pages/Expenses.tsx
- `. הסכומים למטה הם ערכי פריטי ההזמנה במחירי snapshot.` — src/pages/Expenses.tsx
- `אין בטווח חשבוניות עם הזמנה מקושרת ופריטי קטגוריה.` — src/pages/Expenses.tsx
- `ניווט ראשי` — src/components/Layout.tsx [aria-label]
- `הורדת הריכוז כקובץ Excel` — src/pages/Expenses.tsx [title]
- `הורדת הריכוז כקובץ PDF מעוצב עם הלוגו של הארגון` — src/pages/Expenses.tsx [title]
- `הדפסת הריכוז` — src/pages/Expenses.tsx [title]
- `טווחי תאריכים מהירים` — src/pages/Expenses.tsx [aria-label]
- `ייצוא Excel` — src/pages/Expenses.tsx
- `הורדת PDF` — src/pages/Expenses.tsx, src/pages/Orders.tsx
- `מ־` — src/pages/Expenses.tsx

### `/dashboard`  (23)

- `דרישות תשלום באיחור` — src/pages/Dashboard.tsx
- `חריגים פתוחים` — src/pages/Dashboard.tsx, src/pages/Reports.tsx, src/pages/Suppliers.tsx
- `2 בחומרה גבוהה` — src/pages/Dashboard.tsx
- `הזמנות באיחור באספקה` — src/pages/Dashboard.tsx
- `חשבוניות הממתינות לאישור` — src/pages/Dashboard.tsx
- `דרישות תשלום הממתינות לאישור` — src/pages/Dashboard.tsx
- `הזמנות ממתינות לאישור ספק` — src/pages/Dashboard.tsx
- `זיכויים פתוחים` — src/pages/Dashboard.tsx, src/pages/dashboards/AccountantDashboard.tsx, src/pages/Suppliers.tsx
- `התחייבויות רכש פתוחות` — src/pages/Dashboard.tsx
- `אין תשלומים להיום` — src/pages/Dashboard.tsx
- `אין שינויי מחירים` — src/pages/Dashboard.tsx
- `11 חשבוניות פתוחות` — src/pages/Dashboard.tsx
- `. קיימת פעילות גם ב־` — src/pages/Dashboard.tsx
- `אין רכש החודש` — src/pages/Dashboard.tsx
- `מתוכם באיחור` — src/pages/Dashboard.tsx
- `דרישות` — src/pages/Dashboard.tsx
- `לפירעון בשבעת הימים הקרובים` — src/pages/Dashboard.tsx
- `רכש` — src/pages/Dashboard.tsx
- `תשלומים` — src/components/CurrencyTolerancesPanel.tsx, src/pages/Dashboard.tsx, src/pages/dashboards/AccountantDashboard.tsx
- `ניווט ראשי` — src/components/Layout.tsx [aria-label]
- `יתרת חשבוניות פתוחות: 11 חשבוניות` — src/pages/dashboards/AccountantDashboard.tsx [aria-label]
- `המגמות והתמהיל מוצגים ב־` — src/pages/Dashboard.tsx
- `, והיא אינה מחוברת אליהם.` — src/pages/Dashboard.tsx

### `/reports`  (10)

- `חשבוניות` — src/components/CurrencyTolerancesPanel.tsx, src/pages/Dashboard.tsx, src/pages/Expenses.tsx, src/pages/Reports.tsx
- `סה״כ חשבוניות` — src/pages/Reports.tsx
- `מע״מ` — src/pages/Reports.tsx
- `שולם החודש` — src/pages/dashboards/AccountantDashboard.tsx, src/pages/Reports.tsx
- `חשבוניות שטרם שולמו` — src/pages/Reports.tsx
- `תנועות בנק ללא התאמה` — src/pages/Reports.tsx
- `התאמות שממתינות לאישור` — src/pages/dashboards/AccountantDashboard.tsx, src/pages/Reports.tsx
- `זיכויים בחודש` — src/pages/Reports.tsx
- `חריגים פתוחים` — src/pages/Dashboard.tsx, src/pages/Reports.tsx, src/pages/Suppliers.tsx
- `ניווט ראשי` — src/components/Layout.tsx [aria-label]

### `/settings/subscription`  (10)

- `גלובלי בדולרים` — src/components/OrgSubscriptionPanel.tsx
- `מטבע החיוב טרם אומת ואינו נגזר ממטבע התצוגה.` — src/components/OrgSubscriptionPanel.tsx
- `טוען` — src/components/PlanTicket.tsx, src/pages/AcceptOperatorInvite.tsx
- `מחיר` — src/components/OrgSubscriptionPanel.tsx
- `מומלץ` — src/components/OrgSubscriptionPanel.tsx, src/pages/Pricing.tsx
- `מכסה` — src/components/OrgSubscriptionPanel.tsx
- `חוזית` — src/components/OrgSubscriptionPanel.tsx
- `ניווט ראשי` — src/components/Layout.tsx [aria-label]
- `מוצג קטלוג` — src/components/OrgSubscriptionPanel.tsx
- `, לפני מס.` — src/components/OrgSubscriptionPanel.tsx

### `/suppliers/aa000000-0000-4000-8000-000000000001`  (9)

- `יתרה פתוחה` — src/pages/FinancialSupplier.tsx, src/pages/Suppliers.tsx
- `חריגים פתוחים` — src/pages/Dashboard.tsx, src/pages/Reports.tsx, src/pages/Suppliers.tsx
- `0 בסה״כ` — src/pages/Suppliers.tsx
- `זיכויים פתוחים` — src/pages/Dashboard.tsx, src/pages/dashboards/AccountantDashboard.tsx, src/pages/Suppliers.tsx
- `9 פריטים` — src/pages/Orders.tsx, src/pages/Suppliers.tsx
- `מינימום הזמנה` — src/pages/Suppliers.tsx
- `תנאי תשלום` — src/pages/Suppliers.tsx
- `שוטף + 30` — src/pages/Suppliers.tsx
- `ניווט ראשי` — src/components/Layout.tsx [aria-label]

### `/payment-requests`  (8)

- `דרישות תשלום` — src/pages/PaymentRequests.tsx _(exempt)_
- `4 דרישות בתצוגה` — src/pages/PaymentRequests.tsx _(exempt)_
- `מס׳` — src/pages/Credits.tsx, src/pages/Orders.tsx, src/pages/Payments.tsx, src/pages/Suppliers.tsx
- `ספק` — src/pages/Credits.tsx, src/pages/Expenses.tsx, src/pages/Invoices.tsx, src/pages/Orders.tsx, src/pages/Payments.tsx
- `סכום` — src/pages/Credits.tsx, src/pages/Payments.tsx, src/pages/Suppliers.tsx
- `סטטוס` — src/pages/Credits.tsx, src/pages/neworder/SupplierGroupCard.tsx, src/pages/Orders.tsx, src/pages/Suppliers.tsx
- `נוצרה` — src/pages/Orders.tsx
- `ניווט ראשי` — src/components/Layout.tsx [aria-label]

### `/suppliers`  (6)

- `קטגוריות` — src/pages/Suppliers.tsx
- `איש קשר` — src/pages/Suppliers.tsx
- `מינ׳ הזמנה` — src/pages/Suppliers.tsx
- `התראות` — src/pages/Suppliers.tsx
- `סטטוס` — src/pages/Credits.tsx, src/pages/neworder/SupplierGroupCard.tsx, src/pages/Orders.tsx, src/pages/Suppliers.tsx
- `ניווט ראשי` — src/components/Layout.tsx [aria-label]

### `/orders`  (6)

- `מס׳` — src/pages/Credits.tsx, src/pages/Orders.tsx, src/pages/Payments.tsx, src/pages/Suppliers.tsx
- `ספק` — src/pages/Credits.tsx, src/pages/Expenses.tsx, src/pages/Invoices.tsx, src/pages/Orders.tsx, src/pages/Payments.tsx
- `פריטים` — src/pages/Orders.tsx, src/pages/Suppliers.tsx
- `סה״כ` — src/pages/ConsolidatedInvoices.tsx, src/pages/Expenses.tsx, src/pages/Invoices.tsx, src/pages/neworder/SupplierSplitStep.tsx, src/pages/Orders.tsx, src/pages/Reports.tsx, src/pages/Suppliers.tsx
- `סטטוס` — src/pages/Credits.tsx, src/pages/neworder/SupplierGroupCard.tsx, src/pages/Orders.tsx, src/pages/Suppliers.tsx
- `ניווט ראשי` — src/components/Layout.tsx [aria-label]

### `/documents/f1111111-1111-4111-8111-111111111112/review`  (6)

- `מצב המסמך` — src/components/document-review/DocumentReviewWorkspace.tsx
- `שכבות בדיקה` — src/components/document-review/DocumentReviewWorkspace.tsx
- `תיקונים ·` — src/components/document-review/DocumentReviewWorkspace.tsx
- `הערות` — src/components/document-review/DocumentReviewWorkspace.tsx
- `לא ניתן לטעון תצוגה מאובטחת של המקור. אפשר לנסות לרענן את המסך.` — src/components/document-review/DocumentReviewWorkspace.tsx
- `ניווט ראשי` — src/components/Layout.tsx [aria-label]

### `/finance/suppliers/aa000000-0000-4000-8000-000000000001`  (5)

- `שוטף + 30` — src/pages/Suppliers.tsx
- `יתרה פתוחה` — src/pages/FinancialSupplier.tsx, src/pages/Suppliers.tsx
- `חשיפה שהגיעה למועד` — src/pages/FinancialSupplier.tsx
- `אין במערכת מועדי פירעון שמאפשרים לחשב חשיפה שהגיעה למועד; לכן מוצג — ולא אפס.` — src/pages/FinancialSupplier.tsx
- `ניווט ראשי` — src/components/Layout.tsx [aria-label]

### `/invoices`  (5)

- `מס׳ חשבונית` — src/pages/Invoices.tsx, src/pages/Suppliers.tsx
- `ספק` — src/pages/Credits.tsx, src/pages/Expenses.tsx, src/pages/Invoices.tsx, src/pages/Orders.tsx, src/pages/Payments.tsx
- `בדיקה` — src/pages/Invoices.tsx, src/pages/Suppliers.tsx
- `תשלום` — src/pages/Invoices.tsx, src/pages/Suppliers.tsx
- `ניווט ראשי` — src/components/Layout.tsx [aria-label]

### `/settings`  (5)

- `שם הארגון לתצוגה` — src/pages/Settings.tsx
- `שיעור מע״מ (%)` — src/pages/Settings.tsx
- `טווח ימים להתאמת בנק` — src/pages/Settings.tsx
- `סטיות סכום מותרות` — src/components/CurrencyTolerancesPanel.tsx, src/lib/errors.ts
- `ניווט ראשי` — src/components/Layout.tsx [aria-label]

### `/operator-invite`  (4)

- `הצטרפות לצוות` — src/pages/AcceptOperatorInvite.tsx
- `ניהול הפלטפורמה, לא ניהול עסק` — src/pages/AcceptOperatorInvite.tsx
- `הקישור אינו תקין.` — src/pages/AcceptOperatorInvite.tsx
- `למסך הכניסה` — src/pages/AcceptOperatorInvite.tsx

### `/orders/f0000000-0000-4000-8000-000000000001`  (4)

- `הדפסה` — src/pages/Expenses.tsx, src/pages/Orders.tsx
- `ניווט ראשי` — src/components/Layout.tsx [aria-label]
- `הורדת ההזמנה כקובץ PDF מעוצב עם הלוגו של הארגון` — src/pages/Orders.tsx [title]
- `הורדת PDF` — src/pages/Expenses.tsx, src/pages/Orders.tsx

### `/documents/consolidated-invoices`  (4)

- `היכולת אינה כלולה במסלול` — src/App.tsx
- `המסך נשאר סגור גם בבקשה ישירה לשרת. אפשר לראות באיזה מסלול הוא נפתח במסך המנוי.` — src/App.tsx
- `למסלולים ולמחירים` — src/App.tsx
- `ניווט ראשי` — src/components/Layout.tsx [aria-label]

### `/credits`  (4)

- `זיכויים` — src/components/CurrencyTolerancesPanel.tsx, src/pages/Credits.tsx
- `סה״כ זיכויים פתוחים:` — src/pages/Credits.tsx
- `מס׳` — src/pages/Credits.tsx, src/pages/Orders.tsx, src/pages/Payments.tsx, src/pages/Suppliers.tsx
- `ניווט ראשי` — src/components/Layout.tsx [aria-label]

### `/settings/webhooks`  (4)

- `היכולת אינה כלולה במסלול` — src/App.tsx
- `המסך נשאר סגור גם בבקשה ישירה לשרת. אפשר לראות באיזה מסלול הוא נפתח במסך המנוי.` — src/App.tsx
- `למסלולים ולמחירים` — src/App.tsx
- `ניווט ראשי` — src/components/Layout.tsx [aria-label]

### `/prices`  (3)

- `ייבוא רב־ספקים מ־Excel` — src/lib/assistant/productHelpRegistry.ts, src/pages/PriceLists.tsx _(exempt)_
- `העלאת מחירון` — src/lib/assistant/productHelpRegistry.ts, src/pages/PriceLists.tsx _(exempt)_
- `ניווט ראשי` — src/components/Layout.tsx [aria-label]

### `/bank`  (3)

- `תאריך` — src/pages/ConsolidatedInvoices.tsx, src/pages/Expenses.tsx, src/pages/Invoices.tsx, src/pages/Payments.tsx, src/pages/Suppliers.tsx
- `ניווט ראשי` — src/components/Layout.tsx [aria-label]
- `חיפוש בתנועות בנק` — src/pages/Bank.tsx _(exempt)_ [aria-label]

### `/products`  (1)

- `ניווט ראשי` — src/components/Layout.tsx [aria-label]

### `/inventory`  (1)

- `ניווט ראשי` — src/components/Layout.tsx [aria-label]

### `/orders/new`  (1)

- `ניווט ראשי` — src/components/Layout.tsx [aria-label]

### `/receiving`  (1)

- `ניווט ראשי` — src/components/Layout.tsx [aria-label]

### `/receiving/f0000000-0000-4000-8000-000000000001`  (1)

- `ניווט ראשי` — src/components/Layout.tsx [aria-label]

### `/invoices/new`  (1)

- `ניווט ראשי` — src/components/Layout.tsx [aria-label]

### `/invoices/f4000000-0000-4000-8000-000000000008`  (1)

- `ניווט ראשי` — src/components/Layout.tsx [aria-label]

### `/documents`  (1)

- `ניווט ראשי` — src/components/Layout.tsx [aria-label]

### `/documents/archive`  (1)

- `ניווט ראשי` — src/components/Layout.tsx [aria-label]

### `/documents/operations`  (1)

- `ניווט ראשי` — src/components/Layout.tsx [aria-label]

### `/payments`  (1)

- `ניווט ראשי` — src/components/Layout.tsx [aria-label]

### `/exceptions`  (1)

- `ניווט ראשי` — src/components/Layout.tsx [aria-label]

### `/alerts`  (1)

- `ניווט ראשי` — src/components/Layout.tsx [aria-label]

### `/reports/products`  (1)

- `ניווט ראשי` — src/components/Layout.tsx [aria-label]

### `/analytics`  (1)

- `ניווט ראשי` — src/components/Layout.tsx [aria-label]

### `/supplier-log`  (1)

- `ניווט ראשי` — src/components/Layout.tsx [aria-label]

### `/onboarding`  (1)

- `ניווט ראשי` — src/components/Layout.tsx [aria-label]

## Appendix C — file worklist

Every file that holds a string seen on screen. A string that appears in several files is
counted against each of them, so this is a candidate list, not an attribution.

| file | baseline lines | documented exemption | strings seen | screens |
|---|---:|---|---:|---:|
| `src/pages/Expenses.tsx` | 67 |  | 32 | 7 |
| `src/pages/Dashboard.tsx` | 28 |  | 22 | 3 |
| `src/pages/Suppliers.tsx` | 43 |  | 20 | 11 |
| `src/pages/Reports.tsx` | 11 |  | 10 | 5 |
| `src/pages/Orders.tsx` | 13 |  | 9 | 8 |
| `src/lib/assistant/productHelpRegistry.ts` | 132 | yes | 8 | 4 |
| `src/pages/PaymentRequests.tsx` | 26 | yes | 8 | 7 |
| `src/components/OrgSubscriptionPanel.tsx` | 15 |  | 8 | 1 |
| `src/pages/Credits.tsx` | 13 |  | 6 | 6 |
| `src/pages/Invoices.tsx` | 6 |  | 6 | 5 |
| `src/pages/AcceptOperatorInvite.tsx` | 17 |  | 5 | 2 |
| `src/pages/dashboards/AccountantDashboard.tsx` | 14 |  | 5 | 3 |
| `src/pages/Onboarding.tsx` | 22 | yes | 5 | 7 |
| `src/components/document-review/DocumentReviewWorkspace.tsx` | 12 |  | 5 | 1 |
| `src/components/CurrencyTolerancesPanel.tsx` | 39 |  | 4 | 4 |
| `src/pages/Bank.tsx` | 18 | yes | 4 | 4 |
| `src/pages/PriceLists.tsx` | 12 | yes | 4 | 6 |
| `src/pages/Payments.tsx` | 16 |  | 4 | 6 |
| `src/pages/FinancialSupplier.tsx` | 6 |  | 3 | 2 |
| `src/App.tsx` | 3 |  | 3 | 2 |
| `src/pages/Settings.tsx` | 9 |  | 3 | 1 |
| `src/lib/orderImage.ts` | 10 | yes | 2 | 5 |
| `src/pages/ConsolidatedInvoices.tsx` | 10 |  | 2 | 3 |
| `src/pages/AccountantPaymentQueue.tsx` | 22 | yes | 2 | 2 |
| `src/components/Layout.tsx` | 6 |  | 1 | 35 |
| `src/pages/neworder/SupplierGroupCard.tsx` | 4 |  | 1 | 3 |
| `src/pages/neworder/SupplierSplitStep.tsx` | 4 |  | 1 | 2 |
| `src/pages/InvoiceDetail.tsx` | 11 | yes | 1 | 2 |
| `src/components/document-review/model.ts` | 17 | yes | 1 | 1 |
| `src/operator/Funnel.tsx` | 12 | yes | 1 | 1 |
| `src/pages/ProductPurchaseSummary.tsx` | 21 |  | 1 | 1 |
| `src/components/document-review/DocumentLineMapping.tsx` | 31 |  | 1 | 1 |
| `src/operator/AutonomyPolicyPanel.tsx` | 32 | yes | 1 | 1 |
| `src/lib/errors.ts` | 16 |  | 1 | 1 |
| `src/components/PlanTicket.tsx` | 1 |  | 1 | 1 |
| `src/components/PriceListUpload.tsx` | 7 | yes | 1 | 1 |
| `src/pages/Pricing.tsx` | 4 |  | 1 | 1 |
