# GATES — acceptance ledger for the 2026-09-04 sweep

One row per finding. A wave is not finished because its pull request merged; it is finished when
every row below it reads `MET`, with the evidence named. A row that is given up on reads
`ABANDON:` followed by the reason — never a blank, and never a silent drop.

**Status vocabulary.** `PENDING` nothing started · `DIAGNOSED` root cause confirmed against
the running system, no fix yet · `FIXED` change written, oracle not yet re-run ·
`MET` oracle re-run and green, with the evidence path · `BLOCKED` waiting on a named owner
decision · `ABANDON:` given up, with the reason.

**The oracle column is the point.** It names the check that FAILS without the fix and passes with
it — a test, a measured value, a screenshot compared against a reference. "It looks right" is not
an oracle, and a status may not move to `MET` on one.

Counted from the sweep aggregate: **146 findings · 137 actionable · 9 not defects.**
Every id appears exactly once; `scripts/` in the QA scratchpad verifies that mechanically.


## Wave A — money and identity — 15 findings

| id | sev | route | what is wrong | oracle | status |
|---|---|---|---|---|---|
| `OWN-01` | high | /settings | Ending the organisation's service has no confirmation at all within 4 minutes of signing in, and is audited with no reason | — | PENDING |
| `RTL-A11Y-01` | high | /settings | Org-wide switch to read-only fires from ONE click with no confirmation, whenever the user signed in less than 4 minutes ago | — | PENDING |
| `MON-01` | high | /payment-requests | Two payment requests for the same invoice can both be created AND approved, together exceeding its balance — and the product's ow… | — | PENDING |
| `REQ-02` | medium | /payment-requests | Not one of the five live payment requests in this tenant can be approved, and nothing in the product says so — the money still co… | — | PENDING |
| `REQ-03` | medium | /payment-requests | The create screen has no check that can ever be critical for an over-allocation: 999,999.99 against a 150.00 balance is a soft am… | — | PENDING |
| `REQ-05` | medium | /payment-requests | When any critical check fires, the only submit button promises the request will be flagged as a suspected duplicate — the server … | — | PENDING |
| `FIN-03` | high | /pay | Both items in the execution queue target invoices whose balance is already zero, and the dialog never shows the invoice balance | — | PENDING |
| `FIN-10` | low | /pay | The execution dialog says the transfer cannot be performed and offers an enabled 'ההעברה בוצעה' button two blocks below | — | PENDING |
| `MON-05` | medium | /pay | FIN-10 confirmed by action and raised to medium: the red block says the transfer cannot be performed, and I performed it twice on… | — | PENDING |
| `REQ-01` | high | /payment-requests | The approval panel says the request cannot be approved, and the enabled red button beside it says "approve despite the warnings" … | — | PENDING |
| `MON-04` | medium | /bank | One 2,950.00 ILS statement line carries two confirmed allocations of 2,950.00 each to the same invoice — 200% of the line, in pro… | — | PENDING |
| `PERM-01` | high | /settings | The /settings refusal is cosmetic: every row the screen displays is served to office and accountant by the API, including colleag… | — | PENDING |
| `PERM-02` | medium | REST /rest/v1/audit_log_read_model?action=e… | 0293's password-change audit rows are readable by the accountant, who is the subject of none of them and has no audit screen in t… | — | PENDING |
| `PERM-03` | medium | REST /rest/v1/audit_log_read_model?action=e… | The owner cannot reliably read the new password-change audit rows: 2 of 3 attempts returned HTTP 500 statement timeout, while the… | — | PENDING |
| `PERM-05` | low | REST /rest/v1/audit_log_read_model?action=e… | Two password_changed audit rows 1.4 s apart for the same user — either the deploy set the password twice or the 0293 trigger fire… | — | PENDING |

## Wave D — the entrance — 8 findings

| id | sev | route | what is wrong | oracle | status |
|---|---|---|---|---|---|
| `ENTRY-01` | high | /forgot-password | Password recovery turns the entrance into a member directory: submit the same address twice and a registered one errors while an … | — | PENDING |
| `ENTRY-03` | high | /login | Sign-in leaks whether an address is registered through a constant ~85 ms timing gap whose ranges never overlap | — | PENDING |
| `ENTRY-04` | medium | /login | No sign-in throttle of any kind was observable, and the switch that turns the new lockout on is a manual owner step the rollout n… | — | PENDING |
| `ENTRY-07` | medium | /forgot-password | The recovery rate-limit sentence is dead code: the user is told 'the operation failed, contact support' when the truth is 'wait f… | — | PENDING |
| `ENTRY-09` | medium | /signup | GoTrue's own signup endpoint is open, so a stranger can register any address and permanently block it from ever opening a busines… | — | PENDING |
| `ENTRY-10` | low | /no-such-screen | A nonexistent route is a silent bounce to /login with HTTP 200, not a 404 | — | PENDING |
| `PERM-04` | low | /no-such-screen, /admin, /admin/*, /operator | There is no 404: every unknown or refused path silently lands on the dashboard with no message | — | PENDING |
| `ENTRY-11` | low | /operator-invite | The operator invitation refuses a bad link by naming a state; its tenant twin names a next step | — | PENDING |

## Wave B — every step succeeded and the output was zero — 23 findings

| id | sev | route | what is wrong | oracle | status |
|---|---|---|---|---|---|
| `DOC-01` | high | /documents · /documents/:documentId/review | An uploaded photo stops at a manual scan-approval gate, and the library names the wrong cause — so nobody knows to open it and th… | — | PENDING |
| `DOC-02` | high | /documents/:documentId/review | The review screen says the invoice number and date are missing while displaying both, extracted and marked 'זוהה בבירור' | — | PENDING |
| `DOC-03` | high | /documents/:documentId/review | 'סכום שורות' reads 0.00 ₪ while 22 extracted line totals are on the same screen — creating a blocking 'header ≠ lines' finding th… | — | PENDING |
| `DOC-04` | high | /documents · /documents/:documentId/review | Yield: 3 documents uploaded, 3 read accurately, 0 produced a business record — and nothing errored | — | PENDING |
| `DOC-06` | medium | /documents/:documentId/review | A document read and classified with full confidence has its approval permanently disabled and offers no alternative action | — | PENDING |
| `DOC-08` | medium | /documents/:documentId/review | The line grid shows '—' under 'מחיר במסמך' for every line, while the price for that same line is extracted and displayed lower on… | — | PENDING |
| `DOC-05` | medium | /documents/:documentId/review → /invoices/n… | The invoice draft built from a document carries today's date instead of the invoice date the document declares | — | PENDING |
| `DOC-13` | medium | /invoices/new?document=:id | The invoice form labels VAT as 17.5% while both scanned documents print 18.00% and the extraction agrees | — | PENDING |
| `MON-07` | medium | /documents/consolidated-invoices | The only consolidated-invoice case in the tenant has had its page uploaded for ~24 hours and still reads 'awaiting recognition · … | — | PENDING |
| `PL-01` | high | /prices → ייבוא רב־ספקים מ־Excel | The multi-supplier price importer drops every refused row with no count, no reason and no panel | — | PENDING |
| `PL-02` | high | /prices → ייבוא רב־ספקים מ־Excel | The import abort names a row number that belongs to a different row, and one unmatched row discards the whole file | — | PENDING |
| `PL-04` | medium | /documents/:id/review (price list) | A named server refusal is shown to the user as "contact support", while the screen already displays the actual cause one line abo… | — | PENDING |
| `PL-05` | medium | /prices → העלאת מחירון · /products | An approved canonical product name is the name shown everywhere, and a price list using it imports as a NEW product | — | PENDING |
| `PL-11` | medium | /documents/:id/review (price list) | A supplier price list classified as "הצעת מחיר" has no route to becoming prices, and a second one has been "בעיבוד" with 79 rows … | — | PENDING |
| `PL-12` | low | /prices vs /documents/:id/review | The two intake doors answer "which line is which product?" by different keys — name in the sheet importer, SKU/barcode only in th… | — | PENDING |
| `PROC-02` | medium | /prices | The manual price editor bypasses the 0298 price parser: '12,50' is stored as 1,250.00 ₪, and 1.2345 is silently rounded | — | PENDING |
| `OWN-02` | high | /documents/operations | The price-list review queue asks for 737 human decisions and shows no prices on any of them | — | PENDING |
| `OWN-07` | medium | /documents/operations | Two numbers on one screen answer 'how much is waiting for your decision': 40 and 737, neither carrying its unit | — | PENDING |
| `OWN-08` | medium | /documents/operations | Three documents sit in the console under 'מצב לא ידוע' - the console cannot name their state | — | PENDING |
| `PROC-01` | high | /receiving/:orderId | The receipt-conflict dialog queries a column that does not exist, so it can never re-read the server and permanently blocks re-su… | — | PENDING |
| `PROC-03` | medium | /receiving/:orderId | A received quantity above the outstanding quantity is accepted by the form, labelled 'התקבל מלא', and only refused after 'סיום קב… | — | PENDING |
| `PROC-04` | medium | /receiving/:orderId | The conflict dialog names the wrong cause: it blames another person and an offline device for a quantity the user typed seconds e… | — | PENDING |
| `PROC-07` | low | /receiving/:orderId | The conflict dialog prints the same explanatory paragraph twice | — | PENDING |

## Wave C — §12, one trustworthy picture — 27 findings

| id | sev | route | what is wrong | oracle | status |
|---|---|---|---|---|---|
| `DASH-01` | high | /alerts (reached from /dashboard) | /alerts calls itself "the full queue of everything requiring action" and shows 4 items while the dashboard that links to it count… | — | PENDING |
| `DASH-02` | high | /analytics | Every on-time percentage on /analytics is drawn from 1–2 receipts, on a screen whose own header says the metric is shown only aft… | — | PENDING |
| `DASH-03` | medium | /dashboard → /invoices?pay=unpaid | The ₪11,582 open-invoice-balance tile lands on a list that excludes the ₪150 partially-paid invoice inside that figure and includ… | — | PENDING |
| `DASH-04` | medium | /dashboard → /receiving | "2 הזמנות באיחור באספקה" opens a list of 9 with no way to isolate the 2 | — | PENDING |
| `DASH-05` | medium | /dashboard → /orders | "7 הזמנות פתוחות ללא תאריך אספקה" opens the whole order list — 254 rows | — | PENDING |
| `DASH-06` | medium | /dashboard → /orders?status=all | "נרכש החודש ₪2,353" opens every order the tenant has ever placed | — | PENDING |
| `DASH-09` | low | /dashboard | The currency marker sits on opposite sides of the figure for ILS and USD in the same tile | — | PENDING |
| `DASH-10` | low | /dashboard → /credits?status=active, /analy… | "8 זיכויים פתוחים ₪3,381" counts a credit whose own status badge reads התקבל | — | PENDING |
| `DASH-11` | low | /dashboard | A non-zero saving is reported as 0% | — | PENDING |
| `DASH-12` | low | /alerts | The four action rows on /alerts are buttons, not links — no open-in-new-tab, no middle-click, on the screen that is meant to be w… | — | PENDING |
| `DASH-13` | low | /dashboard | The currency choice is dropped on reload with no signal that the figures changed meaning | — | PENDING |
| `FIN-01` | high | /pay · /credits · /exceptions · /dashboard | Three screens give three different answers to "are there open credits?" — the payment dialog names 50 ILS of credits no screen ca… | — | PENDING |
| `FIN-02` | high | /invoices/:id · /finance/suppliers/:id · /c… | A credit whose status says it was offset never reduces the invoice balance — the supplier card's own ledger nets to zero while it… | — | PENDING |
| `FIN-04` | medium | /finance/suppliers/:id | A phantom '$ 0' balance row on a supplier with no dollar activity, directly above the banner stating the product shows — and not … | — | PENDING |
| `FIN-06` | medium | /invoices?attention=duplicates · /invoices/… | The duplicate-suspect filter returns zero invoices while the invoice card and the exceptions queue both flag the same invoice as … | — | PENDING |
| `FIN-07` | medium | /dashboard · /invoices | The same KPI label, 'יתרת חשבוניות פתוחות', reports 790 ILS to the accountant and 11,582 ILS to the owner, with nothing saying th… | — | PENDING |
| `FIN-09` | low | /invoices | The balance column renders a measured zero as '—', so 'paid in full' and 'balance unknown' are indistinguishable | — | PENDING |
| `MON-02` | high | /invoices · /invoices/:id · /payment-reques… | The open balance the product prints on invoice 3377 cannot be paid: requesting exactly the printed 150.00 is refused server-side,… | — | PENDING |
| `MON-03` | high | /finance/suppliers/:id | FIN-04 severity raised and cause inverted: the '$ 0' is not a phantom row on a supplier with no dollar activity — the supplier ow… | — | PENDING |
| `MON-06` | high | /pay · /credits | FIN-01's mechanism, measured: the accountant can see only credits attached to an APPROVED invoice — 2 of the tenant's 11 — so the… | — | PENDING |
| `MON-09` | low | /invoices | FIN-09 confirmed from the action side: I drove an invoice to a MEASURED 0.00 and the list renders it as '—', identical to a balan… | — | PENDING |
| `REQ-04` | high | /orders/proposals/:proposalId · /orders · /… | A supplier's counter-offer waiting for a decision is announced nowhere: not on the orders list, not on the dashboard, not in aler… | — | PENDING |
| `REQ-06` | medium | /receipts/:receiptId | The receipt record never says what is still outstanding and never mentions the credit request it opened — for the only kind of cr… | — | PENDING |
| `ASSIST-06` | high | /expenses?from=2026-08-05&to=2026-09-04 | A citation that contradicts the claim attached to it: the assistant says 562, the screen it sends you to is headed 663 | — | PENDING |
| `ASSIST-07` | high | assistant panel vs /dashboard | Asked for the coming week's payment exposure the assistant answers 0, while the dashboard tile answering the same question says 4… | — | PENDING |
| `ASSIST-09` | medium | assistant panel | Three answers to 'did a supplier raise prices?' — a measured 0, an unmeasured null, and a 1 — inside fifteen minutes | — | PENDING |
| `ASSIST-12` | low | /dashboard (accountant) | OBSERVATION — the accountant's dashboard shows 'זיכויים פתוחים 0' where the assistant correctly refuses | — | PENDING |

## Wave E — exports — 12 findings

| id | sev | route | what is wrong | oracle | status |
|---|---|---|---|---|---|
| `EXP-01` | high | /reports?month=2026-08 | A mixed-currency month takes a different builder that drops the reporting window from every sheet header and writes 0.00 where th… | — | PENDING |
| `EXP-02` | medium | /reports → /reports/products | Severity raised: the bare 'סיכום רכישות מוצרים' link now yields a SEPTEMBER file from a JULY report screen, in two clicks | — | PENDING |
| `EXP-03` | medium | /reports · /reports/products | 'No data' leaves the screen as — and reaches the file as three different things: a blank cell, a literal 0, and an em dash — some… | — | PENDING |
| `EXP-04` | medium | /reports/products | The export drops the provenance caveat the screen attaches to every quantity, and states 'נרכש בפועל 0' on 74 rows whose own sour… | — | PENDING |
| `EXP-05` | low | /reports?month=2020-01 | An empty month exports a file with three header-only sheets and no statement that there was nothing to report | — | PENDING |
| `EXP-06` | low | /reports?month=2020-01 | Nine exceptions dated today appear inside a January-2020 report, under a banner claiming the January 2020 window | — | PENDING |
| `EXP-07` | low | /expenses | The expenses Excel is named for the day it was produced, not the window it covers — the PDF button beside it is named for the win… | — | PENDING |
| `EXP-08` | low | /documents | The row action named 'ייצוא' leads to a screen with no export control on it | — | PENDING |
| `EXP-09` | low | /bank → ייבוא תדפיס בנק | The bank import template is an English-keyed five-column sheet with no currency column, no example row and no Hebrew at all | — | PENDING |
| `EXP-10` | low | /reports/products | A product name beginning with '-' gains a visible leading apostrophe in the exported file | — | PENDING |
| `DASH-07` | medium | /reports/products | The product purchase summary produces no cost at all — הוצאה, מחיר יחידה ממוצע and חויב are empty for all 115 products over nine … | — | PENDING |
| `DASH-08` | medium | /reports → /reports/products | The "סיכום רכישות מוצרים" link carries no month — from a July report it opens September | — | PENDING |

## Wave F — mobile, RTL, contrast — 20 findings

| id | sev | route | what is wrong | oracle | status |
|---|---|---|---|---|---|
| `RTL-A11Y-02` | high | /payments | At 390px the payments list drops the invoice-allocation column, the notes and the executed-by column, and there is no way to get … | — | PENDING |
| `RTL-A11Y-03` | high | /prices | At 390px every price loses its unit of measure and its previous price, on the screen whose job is comparing prices | — | PENDING |
| `RTL-A11Y-04` | medium | /suppliers | At 390px the supplier list drops rating, categories, contact person and minimum order value | — | PENDING |
| `RTL-A11Y-05` | medium | /reports | At 390px the accountant's monthly report loses the entry date and four of the five totals | — | PENDING |
| `RTL-A11Y-06` | medium | 13 of 14 routes measured | In dark mode the page description on every screen measures 3.07-3.95:1 against the background actually painted under it (AA needs… | — | PENDING |
| `RTL-A11Y-07` | medium | /suppliers, /prices, /alerts | The mandated '—' no-data marker is painted in the token DESIGN.md reserves for decoration, at 1.9:1 light and 2.4:1 dark | — | PENDING |
| `RTL-A11Y-08` | medium | /documents | A file name containing Hebrew renders with its number and extension reordered: '93_00002007 — חלק 3.pdf' is shown as 'pdf.3 חלק —… | — | PENDING |
| `RTL-A11Y-09` | medium | /invoices (column chooser; same control on … | The column-chooser announces role=dialog but does not contain focus and does not return it on Escape | — | PENDING |
| `RTL-A11Y-10` | low | /dashboard, /expenses | The shekel sign sits on opposite sides of the figure in two places on the same screen | — | PENDING |
| `RTL-A11Y-11` | low | /suppliers | The alerts field on the mobile supplier card has no label, unlike every other field on it | — | PENDING |
| `RTL-A11Y-12` | low | /dashboard | The monthly bar chart shows four bars and three axis labels at 390px | — | PENDING |
| `DOC-07` | medium | /documents · /documents/:documentId/review | A file name mixing Hebrew and Latin renders with its extension torn off and re-parked, and the element drawing it carries no bidi… | — | PENDING |
| `DOC-10` | low | /documents (upload) | A Hebrew file name is stripped to nothing in the storage object key | — | PENDING |
| `ENTRY-02` | high | /pricing | On a phone /pricing shows four plan names and four document counts and nothing else — all 52 entitlement rows are display:none wi… | — | PENDING |
| `ENTRY-05` | medium | /pricing | The banner says every capability is open on every plan and only volume differs; the cards directly beneath it exclude eight capab… | — | PENDING |
| `ENTRY-06` | medium | /pricing | The Free rung breaks its own card: the trial badge leaves the card by 19 px, the label wraps one word per line, and the row is 13… | — | PENDING |
| `ENTRY-08` | medium | /pricing | Hebrew plural agreement is wrong five times on the public pricing page: '1 משתמשים פעילים', '1 סניפים' | — | PENDING |
| `ENTRY-12` | low | /login · /signup · /forgot-password | Text controls on the public entrance are 16-20 px tall on a phone, against the 44 px the product's own stylesheet says it holds to | — | PENDING |
| `PL-09` | low | /prices → העלאת מחירון | Hebrew number agreement in the import preview: "1 מוצרים חדשים" and "צור מוצר חדש אחד … ועדכן את מחירם" | — | PENDING |
| `PROC-05` | low | /orders/new | The confirmation of the product's central action has no plural form: 'נוצרו 1 הזמנות ספק' | — | PENDING |

## Wave G — the assistant — 6 findings

| id | sev | route | what is wrong | oracle | status |
|---|---|---|---|---|---|
| `ASSIST-01` | high | any (measured on /dashboard) | The panel silently replaces the user's question and its outcome with an older answer to a DIFFERENT question | — | PENDING |
| `ASSIST-03` | medium | /pricing, /settings | A metered feature with no meter: the assistant quota appears nowhere in the product | — | PENDING |
| `ASSIST-05` | medium | POST /functions/v1/assistant | One refusal code for six different ceilings, so nobody can tell when they may ask again | — | PENDING |
| `ASSIST-08` | medium | POST /functions/v1/assistant | A run that takes 51 seconds, discards its own answer, and tells the person to try again — on a metered feature | — | PENDING |
| `ASSIST-10` | medium | private.assistant_effective_quota() | During the first 30 days a per-organisation entitlement override cannot lift the assistant ceiling, because the intro branch retu… | — | PENDING |
| `OWN-06` | medium | /settings/subscription | The subscription screen promises quota usage and the current plan's contents, and shows neither | — | PENDING |

## Wave H — settings, webhooks, ledger, long tail — 26 findings

| id | sev | route | what is wrong | oracle | status |
|---|---|---|---|---|---|
| `OWN-03` | high | /settings/webhooks | A verification handshake the server reports as failed is shown to the owner as an open, pending request | — | PENDING |
| `OWN-04` | medium | /supplier-log | A successful price-list import is listed under the subject 'שורת מחירון שנמחקה' - a deletion that never happened | — | PENDING |
| `OWN-05` | medium | /supplier-log | Every reasoned price command is duplicated by a reason-less row-trigger row, and the screen shows both | — | PENDING |
| `PERM-06` | low | /supplier-log | Price changes are audited without a reason: 24 of the 25 most recent reason-less audit rows are supplier_products updates and pri… | — | PENDING |
| `OWN-09` | low | /settings | Setting and then clearing a second currency's tolerance permanently rewrites the stored shape; there is no path back | — | PENDING |
| `OWN-10` | low | /settings/webhooks | A webhook subscription cannot be deleted - the lifecycle has no last step | — | PENDING |
| `OWN-11` | low | /supplier-log | The audit ledger is hard-capped at the last 400 rows with no paging and no date filter | — | PENDING |
| `OWN-12` | low | /settings | The VAT rate this tenant is configured with (17.5%) matches neither the code default nor the rate real supplier documents print | — | PENDING |
| `OWN-13` | low | /settings | 'טווח ימים להתאמת בנק' carries no bound in the DOM while the VAT field beside it does | — | PENDING |
| `OWN-14` | low | /onboarding | The setup wizard opens pre-filled with the live business record and nothing marks its first button as a write to it | — | PENDING |
| `OWN-15` | low | /settings/webhooks | The URL field's refusals never appear while typing, only on submit | — | PENDING |
| `FIN-05` | medium | /credits | The credits table prints the raw translation key 'creditReason_returned' instead of the Hebrew reason | — | PENDING |
| `FIN-08` | low | /bank | The bank un-match dialog marks its reason box required with '*' but never enforces it and substitutes a placeholder into the audi… | — | PENDING |
| `MON-08` | low | /bank | FIN-08's open question answered: the server DOES enforce the un-match reason; the client's placeholder is what defeats the asteri… | — | PENDING |
| `MON-10` | low | /invoices/:id (credit request dialog) | The credit amount field is labelled 'סכום (₪) (ILS)' — the currency is printed twice, once as a symbol and once as a code | — | PENDING |
| `PL-03` | medium | /supplier-log | A successful price-list import is recorded in the ledger as "שורת מחירון שנמחקה" with "אין נתוני מחיר", and it is the only row th… | — | PENDING |
| `PL-06` | medium | /products → שמות לאישור | The screen promises "כל אישור נרשם ביומן הביקורת" and no screen in the product can read that entry | — | PENDING |
| `PL-07` | low | /prices → העלאת מחירון | Rounding a price to the currency's minor units is silent, although the parser computes a flag saying it happened | — | PENDING |
| `PL-08` | low | /products → שמות לאישור | The approval queue presents the entire catalogue as pending work; most cards state that approving them changes nothing | — | PENDING |
| `REQ-07` | low | /invoices/:id (blocking my route) · /orders… | Two ordinary business refusals arrive as HTTP 500 with codes no dictionary translates, so the user gets 'contact support' for a r… | — | PENDING |
| `DOC-09` | low | /documents/:documentId/review | A business-rule refusal of a document approval is returned as HTTP 500 | — | PENDING |
| `DOC-11` | low | /documents (upload) | POST functions/v1/interpret-document returned 409 during a three-file upload burst | — | PENDING |
| `PROC-06` | low | /orders/:id | A nonexistent order id renders a blank page saying 'contact support' | — | PENDING |
| `PROC-08` | low | /orders/new | 'הזמנה חדשה' in the nav resumes an old draft on its confirm step, one click from creating a real supplier order | — | PENDING |
| `ASSIST-04` | medium | assistant panel empty state | The accountant is offered a suggested question that only an owner/office tool can answer | — | PENDING |
| `ASSIST-11` | low | /dashboard | OBSERVATION — management_dashboard_snapshot intermittently times out, and the assistant inherits it | — | PENDING |

## Not defects — 9 findings, no work owed

| id | why |
|---|---|
| `ASSIST-V1` | verified working — VERIFIED WORKING — the core contract held across all 15 questions: not one fabricated number |
| `ASSIST-V2` | verified working — VERIFIED WORKING — role projection and refusal: not one owner-only field reached another role |
| `ASSIST-V3` | verified working — VERIFIED WORKING — per-currency honesty, not-measured never becomes zero, and 0308's shaped citation survives… |
| `ASSIST-V4` | verified working — VERIFIED WORKING — the assistant reads no pre-migration key or column, and history does not cross users |
| `EXP-R1` | retraction — RETRACTION of a prior agent's finding: /reports/products does NOT yield nothing, and the export is not droppi… |
| `PERM-R1` | retraction — RETRACTED — the 'לא ניתן לטעון את החשבון' card office saw at /admin was transient, not a defect |
| `OWN-16` | retraction / severity change — RETRACTION / severity change: webhook-verify is reachable from the browser - the earlier no-CORS finding no l… |
| `PL-10` | code-level only, not reproduced — The multi-supplier importer resolves names against an unpaged catalogue read — NOT REPRODUCED, code-level only |
| `DOC-12` | severity unchanged, already known — Nothing in the product links to the goods-receipt detail route (severity unchanged) |

## Gates that are not findings

These are conditions on the work itself, not rows from the sweep.

| gate | oracle | status |
|---|---|---|
| G1 — the sweep's evidence is checkable from the tree | `docs/QA-SWEEP-20260904.md` carries all 146 findings, their SHA-256 hashes and the deployed SHA they were measured against | PENDING |
| G2 — no pre-existing failure is reported as caused by this work | baseline `npm run verify` on an idle machine, recorded before the first change | PENDING |
| G3 — `CLAUDE.md`'s four stale claims are corrected | the four paragraphs re-measured against HEAD and rewritten | PENDING |
| G4 — every number is drawn before it is written | `npm run next-number` output pasted into each PR that claims one | PENDING |
| G5 — no guard is weakened to make a wave pass | `npm run verify` sub-command count never decreases, and no exemption is added without a written reason | PENDING |
| G6 — the QA data left in production is dealt with deliberately | an explicit id list, an authorised domain action per row, owner approval, before/after counts, no hard `DELETE` | BLOCKED — owner decision |
