# Handoff — the English language system, third round

**Branch** `claude/add-english-language-system-371a49` · **100 commits above `main`** ·
measured 28.08.2026 at `bd594c7`.

This is the third handoff on this feature. The two before it are
`docs/HANDOFF-english-language-20260827.md` (the design and the iron rules) and
`docs/HANDOFF-english-language-20260828.md` (the pipeline). **Read those first — this one
only says what moved and what is left.**

---

## Where the number stands

| | at the start of round 3 | now |
|---|---|---|
| Hebrew lines outside the dictionaries | 2,135 in 129 files | **1,113 in 99 files** |
| of which, documented exceptions (`__reason`) | 23 files | **30 files, 530 lines** |
| **actually left to extract** | ~1,586 | **583 lines in 69 files** |
| surfaces locked at zero (`gate-i18n extracted`) | 28 | **58** |
| dictionary keys, each language | 3,621 | **4,757** |
| tests | 1,713 | **1,714** |

`npx tsc --noEmit` clean · `npm run -s test` green · `check:jsx-space` green ·
`gate-i18n extracted` / `dictionaries` / `abandon` / `currency-untouched` all green.

The working tree is clean. Nothing is half-applied.

---

## What round 3 extracted

Thirty surfaces, in descending size. Named here because the next agent should not re-open them:

`DocumentReviewWorkspace` · `SupplierLog` + `supplierLogChanges` · `Invoices` (as `invoiceList`) ·
`PriceListAutomationReadiness` · `DocumentScanPreview` · `DocumentPacketReview` ·
`assistant/AnswerView` · `WhatsAppConnectionCard` · `ProductPurchaseSummary` · `Receiving` ·
`InvoiceLineReviewModal` · `ProductNameReview` · `FinancialSupplier` · `Credits` ·
`EmailOrderCard` + `orderEmail` · `Suppliers` · `SupplierPortalCard` ·
`exportTemplates` + `ExportTemplatesPanel` + `monthlyReport` · `Payments` · `Login` · `Orders` ·
`Dashboard` · `AccountantDashboard` · `PushSettings` · `SupplierCommunicationCard` ·
`AttachmentsPanel` · `Alerts` · `MinimumFixPanel` · `AcceptInvite` · `ReceiptDetail` · `Signup` ·
`DocumentRemovalDialog` · `QuickCreateProduct`.

### Seven product defects found and fixed on the way

Each one was found by the rename, not by looking for it. This is the argument for iron rule #7.

1. **`monthlyReport.ts` matched fields BY LABEL.** It built the accountant's summary rows from
   `field.label` and then looked each field back up by comparing that label. Translated, two
   fields that read alike would have taken each other's number format on the workbook an
   accountant files. It indexes the field list directly now.
2. **`ProductPurchaseSummary` had broken Excel headers.** The extractor had rewritten object KEYS
   into `t('…'): value` — a syntax error that had been committed. They are computed properties now.
3. **`Receiving`'s breadcrumb** read `order.number` — nullable — straight into a template, so an
   order with no number rendered `הזמנה #undefined`.
4. **`AcceptInvite`'s heading** read `lookup.org_name` — nullable — the same way.
5. **`PageHeader` rendered the route-description KEY** (fixed earlier in the round).
6. **The assistant Edge function did not compile** — four errors, 227 Deno tests never ran.
7. **`QuickCreateProduct` and `DocumentPacketReview`** had had audit reasons and a stored unit
   value rewritten by the extractor; both restored by PLACE, from HEAD.

### Three patterns that repeat, and are now precedents

- **A table of sentences keyed by a server code → `Record<K, TKey>`.** Done for scan failures,
  bounce reasons, assistant tools, no-answer reasons, push states, alert severities, invitation
  states, order lifecycle, packet attention and supplier-log actions. The KEY never moves; the
  sentence follows the reader.
- **A refusal the screen raises and then COMPARES against** (`aria-invalid`, `reasonInvalid`)
  needs two pieces of state: the sentence on screen and the key it can reason about. Comparing
  resolved sentences breaks the moment the reader changes language. Done in
  `WhatsAppConnectionCard` and `QuickCreateProduct`.
- **A pure module takes the translator as an argument** — `model.ts`, `supplierLogChanges.ts`,
  `PriceListAutomationReadiness`'s `sampleLabel`, `QuickCreateProduct`'s `describeExisting`.

---

## What is left — 583 lines in 69 files

Descending. Run `node scripts/extract.mjs <file> <ns>` on each first; the number in brackets is
how many of its lines the extractor can take by itself.

**Twenty-line surfaces, all hand work:**
- `src/components/UploadCenter.tsx` (10 of 20) — `OFFLINE_ANNOUNCEMENT`, `defaultDescribe`,
  `defaultClassify` are module-scope helpers. **`defaultClassify` cannot hold a hook** — it is the
  gap the second handoff already recorded.
- `src/pages/Bank.tsx` (0 of 20) — every line is a sentence with a number or a supplier in it.
  Six of them are `aria-label`s built around `transactionLabel`, which is itself composed. Start by
  making `transactionLabel` a parameterised key, then the six that embed it fall out.
- `src/pages/neworder/ProductStep.tsx` (?) · `src/pages/ProductNameRepairReview.tsx` (19) ·
  `src/App.tsx` (18).

**Then:** `GlobalSearch` (17) · `lib/checks.ts` (17) · `DocumentReview` (16) · `BarcodeScanner` (15) ·
`DocumentExportPreview` (15) · `FeedbackButton` (15) · `DocumentsInbox` (15) · `SummaryStep` (15) ·
`reportTemplateExport` (14) · `share.ts` (14) · `PriceLists` (14) · `WhatsAppSendDialog` (13) ·
`imageQuality` (13) · `Analytics` (13) · `SupplierGroupCard` (13) · `Pricing` (13) ·
`DocumentProcessingProgress` (12) · `importSheet` (12) · `productDisplayName` (12) · `push.ts` (12) ·
then a long tail of 11 down to 1.

**Two of these need care rather than speed:**
- **`src/lib/checks.ts` (17)** — these are the automatic-check sentences an invoice screen shows.
  They are the same class as `errors.ts`: a condition detected now and read later. Expect
  `Record<CheckCode, TKey>`.
- **`src/pages/Analytics.tsx` (13)** — `supplierMetricsWindow.spec.ts` pins the owner-approved
  90-day phrase on BOTH this screen and `Suppliers`. `Suppliers` already reads it from the
  dictionary; when Analytics moves, update that spec's Analytics half the same way (the comment in
  the spec says how).

---

## The three gates that are NOT closed, and why

- **P2-G6 — extraction is finished.** `node scripts/gate-i18n.mjs zero`. Fails until the 583 is 0.
  This is the gate the work above closes.
- **P2-G8 — the assistant answers in the language it was asked in.** BUILT, not deployed. The Edge
  function `assistant` carries `reader-locale.ts`, `ANSWER_LANGUAGE` and
  `ASSISTANT_PROMPT_VERSION = 'assistant-v3'`. **It needs a deploy to be true in production.**
- **P2-G9 — the consent documents.** BUILT, awaiting a lawyer. `DEBT §70` records it. Do not mark
  it met.

---

## When Moshe asks for the PR

The merge agent must be told to deploy **two things**, per the `CLAUDE.md` rollout matrix:

1. **Frontend** — every screen in this branch changed. Build with production env, Pages, hash
   parity, canonical smoke on the changed paths plus `/` and `/login`, desktop and mobile.
2. **The `assistant` Edge Function** — and only that one. This is what makes P2-G8 true.
   `ASSISTANT_PROMPT_VERSION` is `assistant-v3`.

**No migrations in this branch. The OCR worker is untouched** — do not redeploy the VPS.

---

## Rules that cost this round time, so they are written down

- **`apply()` fails on whitespace.** The scratchpad helper matches exactly; indentation from a
  `sed -n` printout is not the file's indentation. Read the line with `cat -A` when a match fails.
- **The extractor runs BEFORE the hand-edits.** So a hand-edit written against the ORIGINAL text
  will not match — the extractor has already replaced part of the line with `t('ns.text_N')`.
  Always re-read the line after `--write`.
- **`check:jsx-space` catches the split-sentence bug every time.** Two `{t()}` on consecutive lines
  render glued. Fix by merging the keys when it is ONE sentence, and by `{' '}` when it is two.
- **Heredocs eat backslashes and break on apostrophes inside single-quoted JS.** Use the Write tool
  for any script with a regex, an escape or an apostrophe.
- **`node -e` with `=>` creates a zero-byte junk file in the repo root.** One (`string)`) was
  committed and amended out this round. Check `git status` AFTER `git add`, not before.
