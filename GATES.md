# Gates: English joins the product — detection, a manual switch, and an opt-in catalogue

OWNS: src/lib/i18n/**, scripts/check-i18n.ts, scripts/i18n-baseline.json, scripts/gate-i18n.mjs, src/lib/status.ts, src/lib/errors.ts, src/lib/format.ts, src/index.css, index.html, operator.html, portal.html, src/pages/**, src/components/**, src/operator/**, src/auth/AuthContext.tsx, src/main.tsx, supabase/migrations/0213_profile_locale.sql, docs/PLAN-english-language-20260827.md, GATES.md

Scope: the product reads in English for a person whose browser is English, in Hebrew for everyone else, either can be overridden by hand and the choice is remembered per person, and an organisation may give its catalogue an English name it approves item by item.

Branch: `claude/add-english-language-system-f43d1e`, based on `main` (`c04d37a`).
Plan: `docs/PLAN-english-language-20260827.md`.

## What the owner asked for (verbatim intent)

1. Add English. The system detects the country of origin and the language switches accordingly;
   the language can also be switched manually in settings.
2. Translate both the interface **and** business data.
3. Detection is by **browser language**.
4. The internal operator console is **not** translated — skip it.
5. Product names appear **as they appear in the import document**. No automatic translation.
   There is an **option that asks the user** whether to translate product names.

---

## Phase 0 — foundation and the ratchet

- [x] P0-G1: the locale decision is pure, ordered and testable
  CHECK: npx vitest run src/lib/i18n/locale.spec.ts
  EXPECT: /Tests\s+6 passed/
  EVIDENCE: 6 tests. `src/lib/i18n/locale.ts` has no React, no storage, no DOM — stored > query > browser > `he`, and an unsupported value is rejected in either position.

- [x] P0-G2: a missing English key is a compile error, not a blank screen
  EVIDENCE: deleted `common.close` from `en.ts` ⇒ `src/lib/i18n/dictionaries/en.ts(13,3): error TS2741: Property 'close' is missing in type … but required in type …`. Restored ⇒ `tsc --noEmit` exit 0. The negative control is the deletion itself.

- [x] P0-G3: the dictionaries agree and the English one holds no Hebrew
  CHECK: node scripts/gate-i18n.mjs dictionaries
  EXPECT: GATE_I18N_DICTIONARIES_OK
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=D:\משה פרוייקטים\פיתוח אתרים\NIR-APP\.claude\worktrees\add-english-language-system-f43d1e; path=e3341b211784/69 entries; output=gate-i18n: 172 key(s) in both dictionaries, no Hebrew left in the English one | GATE_I18N_DICTIONARIES_OK

- [x] P0-G4: plural category comes from the language, not from `n === 1`
  CHECK: npx vitest run src/lib/i18n/t.spec.ts
  EXPECT: /Tests\s+9 passed/
  EVIDENCE: `pluralCategory('en', 2)` = `other`, `pluralCategory('he', 2)` = **`two`** — the asymmetry a hand-rolled ternary gets wrong.

- [x] P0-G5: the ratchet refuses new hardcoded Hebrew
  CHECK: node scripts/gate-i18n.mjs ratchet
  EXPECT: GATE_I18N_RATCHET_OK
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=D:\משה פרוייקטים\פיתוח אתרים\NIR-APP\.claude\worktrees\add-english-language-system-f43d1e; path=e3341b211784/69 entries; output=check:i18n passed: 160 file(s) still carry 5311 Hebrew line(s), all at their pinned counts (12 documented exception(s)). | GATE_I18N_RATCHET_OK

- [x] P0-G6: the ratchet actually fails — demonstrated in both directions
  EVIDENCE: positive control, added: planted `const planted = 'מחרוזת שנשתלה';` in `src/lib/format.ts` ⇒ `check:i18n FAILED … src/lib/format.ts: 45 → 46 (+1) — Hebrew was ADDED`, exit 1. Positive control, removed: deleted one `UNIT_FORMS` row ⇒ `check:i18n FAILED … 45 → 44 (-1) — extracted, baseline is stale`, exit 1. Both reverted ⇒ pass.

---

## Phase 1 — detection, the switch, persistence

- [x] P1-G1: an English browser reaches an LTR login screen before auth resolves
  EVIDENCE: real Chrome, `locale: en-GB`, no session, no stored choice ⇒ `html lang=en dir=ltr`, and the first `<label>` computes `direction: ltr`. It computed `rtl` before the fix: `Login.tsx` pinned `dir="rtl"` on both panels, so the one screen that renders before auth was the one screen that could not follow the language. `.tmp/shots/p1/login-en-browser.png`, `login-en-mobile.png`, `login-he.png`. Zero console errors, zero responses ≥400.

- [x] P1-G2: the manual switch beats detection and survives a refresh
  EVIDENCE: six-step live flow on a **Hebrew** browser, so the switch had to beat detection rather than agree with it. (1) login `he/rtl` → (2) signed in `he/rtl` → (3) /settings `he/rtl` → (4) choose English `en/ltr`, stored `en` → (5) full reload `en/ltr` → (6) **localStorage cleared, reload** `en/ltr`. Step 6 can only come from `profiles.locale`. `.tmp/shots/p1/settings-he.png`, `settings-en.png`, `settings-en-after-reload.png`.

- [x] P1-G3: `profiles.locale` is per-person, and `NULL` still means "let the browser decide"
  EVIDENCE: `text` + `profiles_locale_supported CHECK (locale IS NULL OR locale = ANY (ARRAY['he','en']))`, read from `\d profiles`. After the flow exactly one row carried `en` and the other four stayed `NULL`. `adoptLocale(null)` is a no-op, covered by a test.

- [x] P1-G4: both gates on a new profile column are open, and only by one column
  CHECK: npx vitest run src/lib/i18n/languageSetting.spec.tsx
  EXPECT: /Tests\s+4 passed/
  EVIDENCE: 0213 argued 0020's trigger allow-list and forgot 0042's column ACL. It looked like it worked — screen switched, reload held from localStorage, `profiles.locale` NULL for every row, PostgREST answering `42501 permission denied` the whole time. Fixed; the migration now asserts both gates separately and pins the self-service surface at exactly six columns.

- [x] P1-G5: the licensed-font build's anchor still matches
  EVIDENCE: `npm run build:almoni` **cannot run on this machine** — it exits with `SUPPLYFLOW_ALMONI_FONT_DIR is required for a licensed Almoni build` and the licensed files are absent. Proved the available way instead: `vite.config.ts:20` replaces the exact literal `<html lang="he" dir="rtl">`, and it is present verbatim exactly once in all three entry points after the edit. `npm run build` green.

---

## Phase 2 — extraction

- [x] P2-G1: no Hebrew is ever added back to product source
  CHECK: node scripts/gate-i18n.mjs ratchet
  EXPECT: GATE_I18N_RATCHET_OK
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=D:\משה פרוייקטים\פיתוח אתרים\NIR-APP\.claude\worktrees\add-english-language-system-f43d1e; path=e3341b211784/69 entries; output=check:i18n passed: 160 file(s) still carry 5311 Hebrew line(s), all at their pinned counts (12 documented exception(s)). | GATE_I18N_RATCHET_OK

- [x] P2-G2: every surface listed as extracted really carries zero Hebrew
  CHECK: node scripts/gate-i18n.mjs extracted
  EXPECT: GATE_I18N_EXTRACTED_OK
  EVIDENCE: exit=0; output=gate-i18n: 6 extracted surface(s) at zero; 3996 Hebrew line(s) remain elsewhere | GATE_I18N_EXTRACTED_OK. Re-measured 28.08.2026 after `src/pages/Settings.tsx` reached zero and joined the list. A surface is added to `EXTRACTED` only once it reads zero, so the list growing IS the evidence — the gate fails the moment any listed file takes Hebrew back.

- [x] P2-G3: the whole suite passes, including the specs that had to follow the shape change
  CHECK: npm run -s test
  EXPECT: /Tests\s+\d+ passed \(\d+\)/
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=D:\משה פרוייקטים\פיתוח אתרים\NIR-APP\.claude\worktrees\add-english-language-system-f43d1e; path=e3341b211784/69 entries; output=Start at  19:43:13 | Duration  67.02s (transform 14.52s, setup 184.64s, import 92.98s, tests 138.17s, environment 501.35s)

- [ ] P2-G4: the internal operator console is translated
  EVIDENCE: pending

- [ ] P2-G5: paired he/en screenshots per extracted surface, with no raw dictionary key on screen
  EVIDENCE: partial — `.tmp/shots/p2/orders-he.png` and `orders-en.png` read the live badges: `טיוטה` / `מוכנה לשליחה לספק` against `Draft` / `Ready to send to the supplier`, with `dir` flipping `rtl`/`ltr`. `.tmp/shots/p3/inventory-he.png` and `inventory-en.png` add the
  inventory pair (P3-G2). Remaining surfaces pending: invoices, receipt, documents, price lists,
  and mobile LTR with the safe area.

  **The inventory pair earned its cost on the first shot, which is the argument for this gate.**
  Both screenshots showed `nav.routeDesc_inventory` — a raw dictionary key — under the page title,
  in Hebrew as well as English. `routePresentationDescription` returns a `TKey`, `PageHeader`’s
  `description` prop is a `ReactNode`, and a `TKey` IS a string: `tsc` was clean, 1,704 tests were
  green, and every catalogued screen in the product was printing its own key. Every existing
  `PageHeader` test renders at `/`, which is not in the route catalogue, so no test could reach
  the branch. Fixed in `8fafbc6` with a test pinned to `/inventory`; positive control on the one
  expression reverted ⇒ 1 failed, restored ⇒ 11 passed. This is iron rule 7 arriving a second
  time, and the only thing that caught it was looking at the screen.

- [ ] P2-G6: extraction is FINISHED — zero Hebrew outside the dictionaries and the documented exceptions
  CHECK: node scripts/gate-i18n.mjs zero
  EXPECT: GATE_I18N_ZERO_OK
  EVIDENCE: pending — `exit=1`, `gate-i18n: extraction is not finished — 3634 Hebrew line(s) across 138 file(s)` (measured 28.08.2026 after PaymentRequests, Settings, Onboarding and InvoiceDetail; 4,982 at the start of the phase). **This oracle was replaced after the ledger's first run, and the ledger is what caught it.** It originally ran `ratchet`, which passes while thousands of lines remain, so the gate reported MET on its first day with 5,311 lines still hardcoded — the gate's English title and its command were measuring different things. `zero` fails until the count is actually zero.

  **PROGRESS, measured 28.08.2026 at `bd594c7` (100 commits above `main`).** The count is
  1,113 Hebrew line(s) across 99 file(s), of which 530 in 30 files are documented exceptions —
  so what is actually left to extract is **583 lines in 69 files**. 58 surfaces are locked at
  zero. The phase began this branch at 3,131 and round 3 alone took 2,135 to 1,113. The file
  list, in descending order and with what the extractor can and cannot take from each, is in
  `docs/HANDOFF-english-language-20260828-session3.md`. Nothing here is blocked; it is work.

  **PROGRESS, 28.08.2026 — `UploadCenter` batch in this commit.** The pinned count is now 1,093
  Hebrew line(s) across 98 files; the documented exceptions remain 530 lines in 30 files, so
  **563 lines in 68 files** remain to extract. `UploadCenter.tsx` is the 59th surface locked at
  zero. Evidence: its stale-baseline negative control failed on that file alone; `gate-i18n
  extracted` reported 59 zero surfaces; targeted tests passed 32/32; the full suite passed
  1,715/1,715; `npx tsc --noEmit` and `check:jsx-space` passed. `zero` still exits 1 on 563/68,
  so this gate remains open.

  **PROGRESS, 28.08.2026 — `Bank` batch in this commit.** The pinned count is now 1,081 Hebrew
  line(s) across 98 files. The protected set is now 538 lines in 31 files: `Bank.tsx` keeps one
  Hebrew supplier-name normalization pattern and seven fixed `audit_logs` defaults. Those seven
  were restored by their `p_reason` write sites after an earlier extraction had made audit wording
  depend on the reader locale. Everything the screen reads moved to paired keys, while candidate
  labels and import results store keys/raw facts instead of resolved sentences. The real remainder
  is now **543 lines in 67 files**. Evidence: the stale-baseline negative control named `Bank.tsx`
  alone; the new boundary spec passed 3/3; the full suite passed 1,718/1,718; `npx tsc --noEmit`
  and `check:jsx-space` passed. `zero` still exits 1 on 543/67, so this gate remains open.

  **PROGRESS, 28.08.2026 — `ProductStep` batch in this commit.** The pinned count is now 1,061
  Hebrew line(s) across 97 files; the protected set remains 538 lines in 31 files, so the real
  remainder is **523 lines in 66 files**. `ProductStep.tsx` is the 60th surface locked at zero.
  The English component test keeps the product name as catalogue data while translating the
  action around it. Evidence: the stale-baseline negative control failed on that file alone;
  the focused suite passed 8/8; the full suite passed 1,719/1,719; `npx tsc --noEmit` and
  `check:jsx-space` passed. `zero` still exits 1 on 523/66, so this gate remains open.

  **PROGRESS, 28.08.2026 — `ProductNameRepairReview` batch in this commit.** The pinned count is
  now 1,042 Hebrew line(s) across 96 files; the protected set remains 538 lines in 31 files, so
  the real remainder is **504 lines in 65 files**. This is the 61st surface locked at zero. Its
  server reason-code table now carries `TKey` values under the renamed `REASON_KEY`, while old and
  proposed product names, source filename and source evidence remain untranslated source data.
  Evidence: the stale-baseline negative control failed on this file alone; the focused suite
  passed 5/5; the full suite passed 1,720/1,720; `npx tsc --noEmit` and `check:jsx-space` passed.
  `zero` still exits 1 on 504/65, so this gate remains open.

  **PROGRESS, 28.08.2026 — `App.tsx` batch in this commit.** The pinned count is now 1,024 Hebrew
  line(s) across 95 files; the protected set remains 538 lines in 31 files, so the real remainder
  is **486 lines in 64 files**. `App.tsx` is the 62nd surface locked at zero. The class-based lazy
  error boundary delegates its translated fallback to a hook-safe function component; the two
  account-unavailable sentences are one key rather than adjacent expressions, and bootstrap copy
  uses an explicit JSX space after the raw error. Evidence: the stale-baseline negative control
  failed on this file alone; focused root/access suites passed 8/8; the full suite passed
  1,723/1,723; `npx tsc --noEmit` and `check:jsx-space` passed. `zero` still exits 1 on 486/64,
  so this gate remains open.

  **PROGRESS, 28.08.2026 — `GlobalSearch` batch in this commit.** The pinned count is now 1,007
  Hebrew line(s) across 94 files; the protected set remains 538 lines in 31 files, so the real
  remainder is **469 lines in 63 files**. This is the 63rd surface locked at zero. `GROUPS.label`
  became `labelKey: TKey`, the local timeout variable was renamed from `t` to `timer` before
  extraction, and search failure state now stores a boolean rather than a locale-resolved sentence.
  English tests prove that group/status interface copy moves while raw server titles and subtitles
  do not. Evidence: the stale-baseline negative control failed on this file alone; the focused
  suite passed 7/7; the full suite passed 1,725/1,725; `npx tsc --noEmit` and `check:jsx-space`
  passed. `zero` still exits 1 on 469/63, so this gate remains open.

  **PROGRESS, 28.08.2026 — `checks.ts` + `checkSummary.ts` batch in this commit.** The pinned
  count is now 989 Hebrew line(s) across 92 files; the protected set remains 538 lines in 31
  files, so the real remainder is **451 lines in 61 files**. These are the 64th and 65th surfaces
  locked at zero. `CheckResult.message` was removed: checks now carry an exhaustive `CheckCode`
  plus raw variables, `CHECK_MESSAGE_KEY: Record<CheckCode, TKey>` resolves at render time, and
  payment-request decisions compare codes rather than searching a translated sentence. Singular
  and plural financial findings use distinct codes. Evidence: the stale-baseline negative control
  named these two files alone; focused mapping/summary/allocation suites passed 12/12; the full
  suite passed 1,729/1,729; `npx tsc --noEmit` and `check:jsx-space` passed. `zero` still exits 1
  on 451/61, so this gate remains open.

  **PROGRESS, 28.08.2026 — `DocumentReview.tsx` batch in this commit.** The pinned count is now
  974 Hebrew line(s) across 92 files. The protected set is now 539 lines in 32 files: this screen
  keeps one fixed `p_reason` for `reprocess_document`, restored by its write site because it lands
  in `audit_logs`. The real remainder is **435 lines in 60 files**. All interface copy moved to
  paired keys. Nineteen known `interpret-document` Edge codes resolve in the reader language;
  unknown server text stays raw. Enqueue/reprocess failures are stored as raw failures and resolved
  only while rendering. Evidence: the stale-baseline negative control measured 16→1 on this file;
  focused screen/source-contract suites passed 10/10, including parity against all 19 canonical
  Edge error codes; the full suite passed 1,731/1,731;
  `npx tsc --noEmit` and `check:jsx-space` passed. This file is protected by `__reason`+ratchet,
  not listed as zero in `EXTRACTED`; `zero` still exits 1 on 435/60, so this gate remains open.

  **PROGRESS, 28.08.2026 — `BarcodeScanner.tsx` batch in this commit.** The pinned count is now
  959 Hebrew line(s) across 91 files; the protected set remains 539 lines in 32 files, so the real
  remainder is **420 lines in 59 files**. This is the 66th surface locked at zero. Camera failures
  now store a `CameraFailureCode`, result descriptions store `TKey`+variables, and both resolve at
  render time. Scanned codes and catalogue product names remain untouched input data. Evidence:
  the stale-baseline negative control failed on this file alone; the focused scanner suite passed
  9/9, including an English camera/manual-code flow with a Hebrew catalogue name; the full suite
  passed 1,732/1,732; `npx tsc --noEmit` and `check:jsx-space` passed. `zero` still exits 1 on
  420/59, so this gate remains open.

  **PROGRESS, 28.08.2026 — `DocumentExportPreview.tsx` batch in this commit.** The pinned count
  is now 944 Hebrew line(s) across 90 files; the protected set remains 539 lines in 32 files, so
  the real remainder is **405 lines in 58 files**. This is the 67th surface locked at zero.
  `formatLabel` became `formatLabelKey: Record<format, TKey>`, preview failure state stores a
  boolean, and row-count copy distinguishes one from many. Stored template names, stored column
  labels and interpreted row values remain raw data. Evidence: the stale-baseline negative control
  failed on this file alone; the focused English preview/failure suite passed 2/2; the full suite
  passed 1,734/1,734; `npx tsc --noEmit` and `check:jsx-space` passed. `zero` still exits 1 on
  405/58, so this gate remains open.

  **PROGRESS, 28.08.2026 — `FeedbackButton.tsx` + `feedback.ts` batch in this commit.** The pinned
  count is now 924 Hebrew line(s) across 88 files; the protected set remains 539 lines in 32 files,
  so the real remainder is **385 lines in 56 files**. These are the 68th and 69th surfaces locked
  at zero. `FeedbackOutcome.message` was replaced with `FeedbackOutcomeCode` plus a raw insert
  error; the component resolves outcome and screenshot status in the reader language. Note text,
  route/query/hash, page title and other submitted context remain unmodified input. Evidence: the
  stale-baseline negative control named these two files alone; the focused Hebrew/English wire
  suite passed 5/5; the full suite passed 1,735/1,735; `npx tsc --noEmit` and `check:jsx-space`
  passed. `zero` still exits 1 on 385/56, so this gate remains open.

  **PROGRESS, 28.08.2026 — `DocumentsInbox.tsx` batch in this commit.** The pinned count is now
  909 Hebrew line(s) across 87 files; the protected set remains 539 lines in 32 files, so the real
  remainder is **370 lines in 55 files**. This is the 70th surface locked at zero. Refile options
  store raw kind/number/supplier facts instead of translated titles; interpretation failure state
  stores a code instead of a message; unknown automation confidence resolves at render time.
  Uploaded filenames, supplier names, source values and user-entered reasons remain untouched.
  Evidence: the stale-baseline negative control failed on this file alone; focused automation,
  archive and source-contract suites passed 32/32; the full suite passed 1,736/1,736;
  `npx tsc --noEmit` and `check:jsx-space` passed. `zero` still exits 1 on 370/55, so this gate
  remains open.

  **PROGRESS, 28.08.2026 — `SummaryStep.tsx` batch in this commit.** The pinned count is now
  894 Hebrew line(s) across 86 files; the protected set remains 539 lines in 32 files, so the real
  remainder is **355 lines in 54 files**. This is the 71st surface locked at zero. Minimum-order
  copy distinguishes one from many; supplier names are isolated with `bdi`; all supplier/product
  names and user notes remain raw order data. Evidence: the stale-baseline negative control failed
  on this file alone; the focused English summary test passed 1/1; the full suite passed
  1,737/1,737; `npx tsc --noEmit` and `check:jsx-space` passed. `zero` still exits 1 on 355/54,
  so this gate remains open.

  **PROGRESS, 28.08.2026 — `reportTemplateExport.ts` batch in this commit.** The pinned count is
  now 880 Hebrew line(s) across 85 files; the protected set remains 539 lines in 32 files, so the
  real remainder is **341 lines in 53 files**. This is the 72nd surface locked at zero. Fourteen
  reader-facing throws became thirteen exhaustive `ReportTemplateErrorCode` values mapped to
  paired `TKey`s; Expenses, Reports and ProductPurchaseSummary resolve them at their reader-facing
  catch boundary. Organization, supplier and template names plus report values remain unmodified
  export data. Evidence: the stale-baseline negative control failed on this file alone; the focused
  value/error-mapping suite passed 6/6; the full suite passed 1,738/1,738; `npx tsc --noEmit` and
  `check:jsx-space` passed. `zero` still exits 1 on 341/53, so this gate remains open.

  **PROGRESS, 28.08.2026 — `share.ts` batch in this commit.** The pinned count is now 874 Hebrew
  line(s) across 85 files. The protected set is now 547 lines in 33 files: seven lines build the
  deliberately Hebrew supplier-facing WhatsApp order and one fixed `p_reason` lands in
  `audit_logs`. The real remainder is **327 lines in 52 files**. Reader-facing WhatsApp-open
  failures now carry `OpenOrderWhatsAppErrorCode`; invoice share copy receives the reader
  translator while preserving supplier/invoice data and bidi isolation. Evidence: the stale-
  baseline negative control measured 14→8 on this file; focused share/dialog suites passed 13/13;
  the full suite passed 1,739/1,739; `npx tsc --noEmit` and `check:jsx-space` passed. This file is
  protected by `__reason`+ratchet, not listed as zero in `EXTRACTED`; `zero` still exits 1 on
  327/52, so this gate remains open.

  **PROGRESS, 28.08.2026 — `PriceLists.tsx` batch in this commit.** The pinned count is now 865
  Hebrew line(s) across 85 files. The protected set is now 552 lines in 34 files: three parser
  aliases continue to recognise Hebrew supplier-sheet headers regardless of reader locale, and
  two fixed `p_reason` defaults continue to land in `audit_logs`. The real remainder is **313
  lines in 51 files**. Import results now store `{ updated, created, unchanged }` facts and resolve
  their sentence only while rendering; unresolved row numbers are translated directly without
  wrapping translated copy in an `Error`; monthly submission labels use the active locale. The
  stale-baseline negative control measured 14→5 on this file alone. Focused comparison, boundary
  and reason suites passed 27/27; the full suite passed 1,744/1,744; `npx tsc --noEmit` and
  `check:jsx-space` passed. Dictionary parity passed at 5,057 keys per locale and the 72 zero
  surfaces remained locked. This file is protected by `__reason`+ratchet, not listed in
  `EXTRACTED`; `zero` still exits 1 on 313/51, so this gate remains open.

  **PROGRESS, 28.08.2026 — `WhatsAppSendDialog.tsx` batch in this commit.** The pinned count is
  now 852 Hebrew line(s) across 84 files; the protected set remains 552 lines in 34 files, so the
  real remainder is **300 lines in 50 files**. This is the 73rd surface locked at zero. All dialog
  copy now follows the reader locale, including the manual-channel warning, both explicit steps,
  render failure, fallback instructions and preview alternative text. The supplier-facing order
  message remains deliberately Hebrew in `share.ts`; this screen translates only what the product
  reader sees. The stale-baseline negative control measured 13→0 on this file alone. Focused
  dialog/share suites passed 14/14; the full suite passed 1,745/1,745; `npx tsc --noEmit` and
  `check:jsx-space` passed. Dictionary parity passed at 5,070 keys per locale; `zero` still exits
  1 on 300/50, so this gate remains open.

  **PROGRESS, 28.08.2026 — `imageQuality.ts` batch in this commit.** The pinned count is now 839
  Hebrew line(s) across 83 files; the protected set remains 552 lines in 34 files, so the real
  remainder is **287 lines in 49 files**. This is the 74th surface locked at zero. The pure image
  measurement module now returns typed copy keys for verdicts, titles, source-aware hints and
  actions; `FileUpload` resolves those keys in the reader locale. Capture thresholds, source bytes,
  HEIC routing and the warn-never-block decision are unchanged. The stale-baseline negative control
  measured 13→0 on this file alone. Focused metric and quick-capture suites passed 60/60, including
  the rendered English decision; the full suite passed 1,747/1,747; `npx tsc --noEmit` and
  `check:jsx-space` passed. Dictionary parity passed at 5,087 keys per locale; `zero` still exits
  1 on 287/49, so this gate remains open.

  **PROGRESS, 28.08.2026 — `Analytics.tsx` + shared `ui.tsx` tail in this commit.** The pinned
  count is now 817 Hebrew line(s) across 81 files; the protected set remains 552 lines in 34 files,
  so the real remainder is **265 lines in 47 files**. These are the 75th and 76th surfaces locked
  at zero. Analytics renders its full leaderboard contract in English while preserving supplier
  names, and the owner-approved 90-day claim is pinned as a source key plus exact dictionary value.
  The rendered English test found two shared leaks outside Analytics: DataTable's scroll-region
  label and record count. Closing all nine remaining `ui.tsx` sites also translated row actions,
  open-row labels, column/filter triggers and quantity-stepper fallbacks; record singular/plural now
  comes from `Intl.PluralRules`. The stale-baseline negative control named only Analytics 13→0 and
  ui 9→0. Focused analytics/DataTable/control suites passed 53/53; the full suite passed
  1,748/1,748; `npx tsc --noEmit` and `check:jsx-space` passed. Dictionary parity passed at 5,108
  keys per locale; `zero` still exits 1 on 265/47, so this gate remains open.

  **PROGRESS, 28.08.2026 — `SupplierGroupCard`, `Pricing` and
  `DocumentProcessingProgress` batch in this commit.** The pinned count is now 779 Hebrew line(s)
  across 78 files; the protected set remains 552 lines in 34 files, so the real remainder is
  **227 lines in 44 files**. These are surfaces 77–79 locked at zero. Supplier-group decisions and
  minimum-order facts now follow the reader locale while supplier/product names remain raw;
  item count uses `Intl.PluralRules`. Public-plan fixed promises moved as whole sentences rather
  than glued fragments, while server catalogue labels and figures remain server facts. Processing
  steps, measured page/segment progress and every unknown/waiting detail now resolve per reader.
  The stale-baseline negative control named exactly the three files at 13→0, 13→0 and 12→0.
  Focused suites passed 27/27; the full suite passed 1,751/1,751; `npx tsc --noEmit` and
  `check:jsx-space` passed. Dictionary parity passed at 5,146 keys per locale; `zero` still exits
  1 on 227/44, so this gate remains open.

  **PROGRESS, 28.08.2026 — `importSheet`, `productDisplayName` and `push` boundary batch in this
  commit.** The pinned count is now 756 Hebrew line(s) across 77 files. The protected set is now
  565 lines in 36 files: one spreadsheet-header normalisation regex plus twelve Hebrew catalogue
  recognition rows are parser input, not copy. The real remainder is **191 lines in 41 files**.
  `push.ts` is the 80th surface locked at zero: subscription and sign-out cleanup return typed keys,
  resolved only by PushSettings/AuthContext in the reader locale. `readSheet` takes the caller
  translator and every actionable refusal moves with it; `mapRows` receives the caller's unknown-row
  fallback. `productDisplayName` deliberately stays pinned because its Hebrew units/company marker
  parse stored catalogue names before a human approves a proposal. The stale-baseline negative
  control named only push 12→0 and importSheet 12→1. Focused importer/push/catalogue suites passed
  39/39; the full suite passed 1,754/1,754; `npx tsc --noEmit` and `check:jsx-space` passed.
  Dictionary parity passed at 5,170 keys per locale; `zero` still exits 1 on 191/41, so this gate
  remains open.

  **PROGRESS, 28.08.2026 — quick supplier + password recovery + step-up auth batch in this
  commit.** The pinned count is now 715 Hebrew line(s) across 73 files; the protected set remains
  565 lines in 36 files, so the real remainder is **150 lines in 37 files**. These are surfaces
  81–84 locked at zero. Quick supplier creation translates duplicate evidence while keeping the
  supplier name and tax id raw. Forgot/reset-password fixed copy follows the reader locale without
  weakening the anti-enumeration or global-session-revocation contracts. Reauth uses internal error
  codes mapped at the render boundary, never `Error(t(...))`. The stale-baseline negative control
  named exactly the four files at 11→0, 10→0, 9→0 and 11→0. Focused suites passed 43/43. The first
  full run caught `accountRecovery.spec.ts` pinning a sentence in source; the assertion was split
  into screen key plus exact paired dictionary values, then the full suite passed 1,758/1,758.
  `npx tsc --noEmit` and `check:jsx-space` passed; dictionary parity passed at 5,212 keys per
  locale. `zero` still exits 1 on 150/37, so this gate remains open.

  **PROGRESS, 28.08.2026 — `Layout` + supplier metrics + supplier order-image boundary in this
  commit.** The pinned count is now 697 Hebrew line(s) across 71 files. The protected set is now
  575 lines in 37 files: `orderImage.ts` is the deliberately Hebrew supplier-facing PNG, paired
  with raw catalogue names/units and the protected WhatsApp order text. The real remainder is
  **122 lines in 34 files**. Layout navigation sections now carry typed keys and resolve in both
  drawer and desktop disclosure; sign-out, home/account aria labels and pending-offline counts also
  follow the reader locale. Supplier rating, lead days and price-trend accessibility copy moved to
  paired keys; raw supplier metrics remain facts. Layout and supplier metrics are surfaces 85–86
  locked at zero. The stale-baseline negative controls measured Layout 9→0 and supplier metrics
  9→0. Focused suites passed 47/47; the full suite passed 1,760/1,760; `npx tsc --noEmit` and
  `check:jsx-space` passed. Dictionary parity passed at 5,231 keys per locale; `zero` still exits
  1 on 122/34, so this gate remains open. The design hook's pre-existing bounce easing in Layout
  stayed outside the translation diff and was neither changed nor suppressed.

  **PROGRESS, 29.08.2026 — notifications + WhatsApp connection + source viewer + workbook
  refusals in this commit.** The pinned count is now 667 Hebrew line(s) across 68 files. The
  protected set is now 576 lines in 38 files: one workbook-placeholder regex stays as Hebrew input
  recognition. The real remainder is **91 lines in 30 files**. Notification event rows carry paired
  label/detail keys; WhatsApp connection summaries receive the reader translator while provider,
  masked sender and language-code facts stay raw; DocumentSourceViewer moved every control/status/
  aria sentence; workbook refusals carry typed rejection reasons and resolve in the panel. These
  are surfaces 87–89 locked at zero; exportTemplateWorkbook stays protected at one line. The stale-
  baseline negative control measured 8→1, 8→0, 8→0 and 7→0. Focused suites passed 33/33; the full
  suite passed 1,760/1,760; `npx tsc --noEmit` and `check:jsx-space` passed. Dictionary parity
  passed at 5,261 keys per locale; `zero` still exits 1 on 91/30, so this gate remains open.

  **PROGRESS, 30.08.2026 — plan-limit note + inventory tail + quick supplier picker in this
  commit.** The pinned count is now 649 Hebrew line(s) across 65 files; the protected set remains
  576 lines in 38 files, so the real remainder is **73 lines in 27 files**. These are surfaces
  90-92 locked at zero. `PlanLimitNote` resolves its unmeasured-quota sentence around the em dash
  as a prefix/suffix pair rather than two glued expressions, and the metric label, used, limit and
  period end ride in as variables instead of being concatenated. `Inventory`'s remaining tail
  copy - nearest incoming date, price-advantage line, refresh control, row aria-label and the
  stock-adjustment description - moved to paired keys while quantities keep going through
  `formatQuantity(_, _, locale)`. `QuickSupplierPicker`'s three exported hint constants were
  renamed to `*_KEY` and now carry `TKey` values, which is iron rule 7 applied before a screen
  could print a key: the compiler listed every consumer, and the wiring spec resolves them through
  `translateIn('he', ...)` so its assertions still pin the exact Hebrew sentence rather than
  comparing a key to itself. Evidence: the stale-baseline negative control named exactly these
  three files at 7 -> 0, 6 -> 0 and 5 -> 0 and no others; focused suites passed 34/34; the full
  suite passed 1,760/1,760; `npx tsc --noEmit` exit 0 and `check:jsx-space` passed on 126 TSX
  files. Dictionary parity passed at 5,280 keys per locale, and `extracted` reported 92 surfaces
  at zero. `zero` still exits 1 on 73/27, so this gate remains open.

  One thing this oracle cannot see, recorded so a later reader does not over-trust it: a file listed in `__reason` is exempted **entirely**, whatever its count. What closes that door is not this gate but `ratchet`, which pins every exempt file at the exact number it was exempted at, so an exemption cannot quietly grow. The pair is the guarantee; neither half is.

- [ ] P2-G9: the consent documents read in the reader's language — BUILT 28.08.2026, AWAITING A LAWYER
  CHECK: npx vitest run src/pages/legal.spec.tsx
  EXPECT: /Tests\s+9 passed/
  EVIDENCE, and it is deliberately not enough to close this gate. Both documents exist in both
  languages, `TERMS_VERSION` is `2026-08-28`, and no sentence in either claims the other governs.
  Live pages: `.tmp/shots/p2-legal/{terms,privacy}-{he,en}.png`, `<html>` flipping `he/rtl` ↔
  `en/ltr`, zero console errors, no `legal.*` key in the rendered body. `check:i18n` 3,131 → 3,052,
  the file's whole pinned count, its `__reason` exemption dropped and the file added to the
  surfaces `extracted` locks at zero — 12 now.

  **The Hebrew document did not move, and that is measured rather than asserted.** The rendered
  text of both pages was captured before the change and compared after: 4,469 characters,
  identical except for the version string. The wording was lifted out of the JSX BY SCRIPT rather
  than retyped — including the invisible RLM marks in the sub-processor list, which a hand
  transcription loses without anyone seeing it. On a consent document that is the difference
  between a translation and an amendment.

  Four pins keep the two versions the same document: `apply-ns.mjs` refuses a namespace with a key
  on one side only, `en.ts` is type-checked against `he.ts`, a test counts the keys, and a test
  asserts every English disclosure the Hebrew makes — the 30-day window, the third-party
  contractors, the unsupported region, `store: false`, and the promise deliberately not made. A
  fifth asserts neither version claims the other governs, with narrow patterns rather than the bare
  words: clause 7 legitimately says "governing law", and a test that forbade the word would be
  deleted by the next person rather than obeyed.

  **WHY IT STAYS OPEN.** Everything above is a green test run, and this is the one gate in this
  ledger where a green test run is not the question. There are now TWO legal documents, neither
  read by a lawyer, and the file's own header has recorded from the start that the drafting is not
  legal advice and that the review is the owner's decision. It closes when the owner says the
  translation was reviewed — not before. Recorded as a standing debt in `DEBT §70` on the owner's
  instruction of 28.08.2026, so it does not live only in this ledger.

  **A SECOND REPOSITORY IS INVOLVED, and it currently disagrees with the decision.** The marketing
  site (`LANDING-PAGE-NIR`, `src/content/pages.ts`) publishes both documents verbatim, cites
  `TERMS_VERSION 2026-08-24`, and its lede says the Hebrew version governs — the sentence `#280`
  retired. Somebody reading the terms there before signing up is reading a different document from
  the one they will consent to. Both repositories have to move together; `DEBT §70` carries it.

  **The look changed on 28.08.2026 on a separate owner instruction** — the two pages now read like
  the marketing site's. Only the shell was ported, never the lede: copying the copy with the look
  would have reinstated the "Hebrew governs" reading in the app itself. `DESIGN.md` §5 carries the
  decision table, and the evidence screenshots were re-taken after it.

  **THIS BRANCH DEPLOYS NOTHING.** Owner instruction, 28.08.2026: the rollout is the merge agent's
  step, and the PR must say so explicitly — the Frontend row of the `CLAUDE.md` matrix for these
  pages, plus the Edge Function row for `assistant` (P2-G8).

  DECISION: **the owner chose TWO BINDING VERSIONS, one per language** (`OPEN-DECISIONS #280`) — picked over both cheaper readings after all three were spelled out. So: translate `Legal.tsx` in full, BUMP `TERMS_VERSION`, and write NO sentence claiming the Hebrew governs — such a sentence contradicts the decision. Someone who signed in English agreed to the English text.

  **The price the owner accepted explicitly:** every future amendment is TWO legal amendments, each needing review. A gap between the versions is not a wording slip — it is two different undertakings.

  **This gate must not be marked met on a green test run.** The file's own header records that its drafting is not legal advice and that a lawyer's review is the owner's call; two binding versions raise the stakes of that review rather than removing it. Passing technically is not the same as being right here, and this is the one gate in this ledger where that distinction decides.

  Not started, and deliberately not started by an agent before the decision existed. `src/pages/Legal.tsx` (79 Hebrew lines) is the terms of service and the privacy policy. It is not screen copy: **it is a document people agree to.** `AcceptInvite.tsx` sends `TERMS_VERSION` into `acceptInvitation`, `0089` refuses to create a profile without it and stamps it into `audit_logs`, and the file's own header states the rule — changing the text in a way that matters legally must bump the version, because "an unchanged version over changed terms would make every stored consent a lie".

  **The question extraction cannot answer:** an English reader consents to the English text. When the two texts differ — and a translated legal clause differs from its original more often than a button label does — which one did that person agree to? That is a legal decision about a document drafted against תיקון 13 לחוק הגנת הפרטיות, whose own header already records that it is not legal advice and that a lawyer's review is the owner's call.

  **Three readings, for whoever decides.** (a) Serve the Hebrew document to everyone and say so plainly on the English screen — no ambiguity, and an English reader agrees to a text they may not read. (b) Translate, bump `TERMS_VERSION`, and state in both that the Hebrew governs — the ordinary practice, and the one that keeps a single authority. (c) Two binding versions, one per language — the most respectful and by far the most expensive, because every future edit becomes two legal edits.

  Until it is decided, the file stays Hebrew and pinned, with the reason on its baseline row. **Nothing about this blocks the rest of the extraction**; it is the one surface where being fast is the wrong instinct.

- [ ] P2-G8: the assistant answers a product question in the language it was asked in — **owner decision 28.08.2026 (`OPEN-DECISIONS #283`): wire the real locale through to the server.** The half below that is not met is now a decided task, not an open question.
  CHECK: node scripts/gate-i18n.mjs help-registry-paired
  EXPECT: GATE_I18N_HELP_PAIRED_OK
  EVIDENCE: half met, and the half that is met is the runnable one. exit=0; output=gate-i18n: 15 product-help topic(s), each in both locales | GATE_I18N_HELP_PAIRED_OK. Positive control: deleting the English row for `check_product_purchases` ⇒ `gate-i18n: the product-help registry is not paired. no English row: check_product_purchases`, exit 1; restored ⇒ pass. It fails in the other direction too, on an English row with no Hebrew original — that is #192's missing-locale rule read backwards, a translation of nothing. Every one of the 15 product-help topics now has both an `he` and an `en` row, built from the Hebrew row's own `route`, `roles`, `version` and `source` rather than retyped — those are contract fields the registry guard checks, and a retyped `roles` could hand somebody a screen the Guard withholds.

  **BUILT 28.08.2026, NOT YET DEPLOYED.** The half that was a guess is now wiring. The reader's
  language rides the ask request beside `route`, is read once per run, and is handed to BOTH
  halves of it: `buildInstructions(locale)` says "Answer in English" instead of "Answer in
  Hebrew", and `ToolContext.locale` resolves every sentence a person reads. Splitting those two
  would let an English answer arrive over Hebrew help steps. `get_product_help` keeps `locale` as
  a tool argument — a Hebrew reader asking in English should get the English steps — but SILENCE
  now means the reader's own language instead of Hebrew. `ASSISTANT_PROMPT_VERSION` is
  `assistant-v3`, stamped on every recorded run.

  Evidence so far, all of it offline: `deno test` 230 passed | 0 failed, up from 227. Three of
  those are new — an English reader gets the English entry with NO `locale` in the tool
  arguments; an explicit `locale` from the model still beats it; and exactly ONE line of the
  system prompt differs between the two languages, so nobody is handed a weaker assistant by
  choosing English. `parseAssistantRequest` refuses `fr` rather than falling back silently, and
  a caller that never heard of the field still parses to `null`.

  Two things a PERSON reads were Hebrew regardless of any of this, and are now resolved per
  reader: the price-rise scope-limit warning, and a source's screen label. The label came from
  `routePresentationTitle`, which returns a dictionary KEY since the interface was extracted,
  into a `SourceReference.label` typed `string` — so `nav.routeTitle_prices` was reaching people
  with `tsc` perfectly happy. That is iron rule 7 a third time, and the test now asserts no
  source label may start with `nav.`.

  **WHAT KEEPS THIS GATE OPEN:** nothing above is deployed, and the gate asks for a live English
  answer. The Edge rollout is its own step under the `CLAUDE.md` matrix — deploy only the
  function that changed, verify secrets/JWT, then one targeted live call. It is an owner
  decision to make, not an agent's, and until it is made this stays unmet.

  One thing found on the way, recorded because it explains why none of this was caught earlier:
  **the assistant function did not type-check on this branch at all.** Four errors, 227 contract
  tests not running, and a deploy that would have failed. Repaired in `4d02c0a`. The CI job that
  runs them is `pull_request: branches: [main]`, and this branch has no such PR — `DEBT §65`, in
  the flesh.

  The English steps deliberately name NO on-screen control by its words. The three that already existed quoted Hebrew button labels, on a premise the file stated outright — "the UI itself is Hebrew" — which this very feature retires. Naming the action and the place survives both languages, and survives every screen still mid-extraction.

- [ ] P2-G7: an English session shows no Hebrew word anywhere on screen, except what a document put there
  CHECK: node scripts/check-english-screens.mjs
  EXPECT: ENGLISH_SCREENS_OK
  EVIDENCE: pending — the oracle does not exist yet. **Owner instruction, 28.08.2026, verbatim: "כשהמשתמש מחליף שפה לאנגלית אסור שיהיה ולו מילה אחת בעברית במערכת, רק חוץ מאם הוא העלה מסמך בעברית — אז רק מה שיוצא מהמסמך ונכנס למערכת נשאר אותו דבר."**

  This is the gate the whole phase exists to satisfy, and it is deliberately not the same measurement as P2-G6. `zero` reads SOURCE; this reads the rendered DOM of a live English session. The two can disagree in both directions, and each disagreement is a real finding: source Hebrew that never reaches a screen (`PaymentRequests.tsx`'s seven audit reasons) passes here and fails there, and a Hebrew string arriving from the database at runtime fails here and passes there. Only the second kind is a bug this feature owns.

  The exception the owner named is a data class, not a screen: supplier names, raw OCR text, `audit_logs`, comments, and source documents keep the words they arrived with. The oracle must therefore ignore Hebrew inside those surfaces and fail on Hebrew anywhere else — an allow-list of DOM regions, not a global word count, or it will report the supplier list as a failure forever and be switched off.

ABANDON: P2-G4 Owner decision, 27.08.2026 — `src/operator/**` is internal, used by the InPlace team only and not sold to a tenant, so translating it serves no end user. Recorded in three places and checked by `node scripts/gate-i18n.mjs abandon`: this ledger, `docs/DEBT-REGISTER.md §68`, and `__reason` on 12 pinned files in `scripts/i18n-baseline.json`. Handoff: if the console is ever opened to an outside operator it becomes the only unextracted surface and the debt falls due in full.

---

## Phase 3 — format and direction

- [ ] P3-G1: the same amount reads correctly in both locales, and stays a shekel in both
  EVIDENCE: pending

- [x] P3-G2: units read `kg` in English instead of `ק״ג`
  CHECK: npx vitest run src/lib/formatQuantity.spec.ts src/portal/i18n.spec.ts
  EXPECT: /Tests\s+24 passed/
  EVIDENCE: live, on one screen, in both languages. `/inventory` signed in as the demo owner, the
  same eight rows, switched only by the control in /settings: `0 sacks` · `12 kg` · `0 containers` ·
  `0 units` · `15 trays` · `0 barrels` against `0 שקים` · `12 ק״ג` · `0 מיכלים` · `0 יחידות` ·
  `15 תבניות` · `0 חביות`, with `<html>` on `lang=en dir=ltr` and `lang=he dir=rtl`.
  `.tmp/shots/p3/inventory-en.png`, `inventory-he.png`. What is STORED did not move: the same 47
  products still read `ק"ג`, `מיכל`, `יח'`, `ארגז` in `public.products.unit`, and no migration was written.

  The English word lives on the CANONICAL row of `UNIT_FORMS` rather than in a second map beside
  it, so an alias cannot drift from the word its canonical form carries — and, not incidentally,
  that adds no LINE to the file, so `ratchet` still pins `format.ts` at 45 without a baseline bump.
  The decision below says "a second map ABOVE `UNIT_FORMS`"; this is that map, folded into the row
  it belongs to. Same 17 canonical forms, one place to read, and no way to add an alias without one.

  `locale` is a REQUIRED parameter of `formatUnit`/`formatQuantity`, deliberately not defaulted to
  `he`: a default would have let all 43 call sites keep compiling while quietly staying Hebrew on
  an English screen. The compile errors WERE the list of screens that show a unit. Two of them
  pass `'he'` on purpose — `share.ts` and `orderImage.ts` are read by the supplier, like the raw
  product name beside them.

  Positive control: removed `en` from the `ארגז` row ⇒ two failures,
  `expected '0 ארגז' to be '0 crates'` and `אין אנגלית לצורה ארגז`; restored ⇒ pass. The plural
  category comes from `Intl.PluralRules`, which is why English reads `0 crates` where `n === 1`
  would have said `0 crate`.

  One constraint found the hard way, recorded so it is not re-broken: `p2Reliability.spec.ts`
  imports `format.ts` into a BARE Node process to prove the calendar does not depend on the
  machine time zone. A value import of `./i18n/t` cannot be resolved there — extensionless
  TypeScript specifier — and the whole suite went red. The plural rules are built inside
  `format.ts` instead; only the `Locale` TYPE crosses, because a type import is erased.

  DECISION, unchanged — **owner decision 28.08.2026 (`OPEN-DECISIONS #282`): a display translation table only. The database does not change.** `products.unit` stays Hebrew (`0001:92`, default `יח׳`), the Hebrew value remains the key, and there is NO data migration — changing it would move `name_match_key` and the three-way match with it, which the plan forbids outright. What gets added is a second map from the canonical Hebrew form to English, ABOVE the existing 45-entry `UNIT_FORMS` in `src/lib/format.ts:104`, plus `Intl.PluralRules` for the English plural. `formatUnit(unit, quantity)` is the entry point. Required result: an English reader sees `3 kg`, `12 units`, `2 crates`; what is stored is `ק״ג`. **This failure exists today** — `portal/i18n.ts:125` already falls through to the raw `unit?.trim()`. Trap: `check:money` evaluates PER LINE (`scripts/check-money.ts:88-90`), so a formatter broken across two lines is invisible to it.

- [ ] P3-G3: the safe-area and drawer mappings flip with `dir`
  EVIDENCE: pending

- [ ] P3-G4: a currency can be chosen in settings, beside the language, and the choice is remembered
  EVIDENCE: abandoned — see below.

ABANDON: P3-G4 The scope question was put to the owner on 28.08.2026 with three readings spelled out, and the answer was the deepest one: **"מערכת שעובדת באמת בדולר"** — a supplier's dollar invoice is received, stored, paid and balanced in dollars, not a shekel amount displayed through a rate. Recorded as `OPEN-DECISIONS #277`, which supersedes `#14`.

That is not a switch in settings, and a gate in this ledger promising one would be a gate whose English title and whose real work measured different things — the mistake P2-G6 already made once here. It touches `0001` (no currency column exists anywhere), `0108:228-233` (which today REJECTS a non-shekel document on purpose, `currency_not_ils`, severity `error`), both balance functions, `payment_allocations`, `bank_allocations`, bank matching, the monthly report, and all 52 currency sites in `src`. It needs its own plan, its own migrations and its own ledger.

**Nothing about it is abandoned except its place in THIS ledger.** The decision is recorded in `OPEN-DECISIONS #277`, which is where a business decision lives; this file only tracks what this branch proves. Handoff: a partial version is worse than none — a balance that adds a shekel to a dollar is a false number on a decision screen, which is the §12 failure the constitution exists to prevent.

- [x] P3-G5: this branch leaves the shekel assumption exactly where it found it
  CHECK: node scripts/gate-i18n.mjs currency-untouched
  EXPECT: GATE_I18N_CURRENCY_UNTOUCHED_OK
  EVIDENCE: with P3-G4 moved out to its own project, the thing this branch must prove about money is the opposite of what the gate first said: that translating the interface changed **nothing** about currency. The oracle diffs the currency-bearing surfaces against `main` — `src/lib/format.ts`, and `0108`'s `currency_not_ils` rejection — and fails if either moved. A guard that only passed today would be worthless; this one keeps passing while the extraction continues, and turns red the moment a later surface quietly formats an amount somewhere other than `format.ts`. exit=0; output=gate-i18n: money still has one formatter, and 0108 still blocks a non-shekel document | GATE_I18N_CURRENCY_UNTOUCHED_OK.

  Positive control on BOTH halves, because a two-part gate can rot in one part while the other keeps it green. (a) Planted a literal `new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })` in `src/lib/checks.ts` ⇒ `check:money FAILED — 1 hand-rolled money format(s) … src\\lib\\checks.ts:234`, exit 1. (b) Replaced the `currency_not_ils` finding in `0108` ⇒ `gate-i18n: … no longer refuses a non-shekel document`, exit 1. Both reverted ⇒ pass.

  One limit found while writing that control, recorded rather than left for a later reader to trip over: `check:money`'s third rule is `/new Intl\.NumberFormat\([^)]*currency/`, and `[^)]*` stops at the first closing bracket — so a formatter whose first argument is itself a call, `new Intl.NumberFormat(localeFor(x), { currency: … })`, is invisible to it. The first planted control was written that way and PASSED; it had to be rewritten as the literal shape before it could fail honestly. The guard is narrower than its own header claims, and this gate inherits that narrowness.

---

## Phase 4 — the catalogue

- [ ] P4-G1: switch OFF — an English session shows exactly the Hebrew name
  EVIDENCE: pending

- [ ] P4-G2: switch ON, no approved translation — the Hebrew name plus the offer
  EVIDENCE: pending

- [ ] P4-G3: switch ON, approved translation — the English name and a matching `audit_logs` row
  EVIDENCE: pending

- [ ] P4-G4: a visually-ordered name is never offered for translation
  EVIDENCE: pending

- [ ] P4-G5: the supplier still receives `products.name`
  EVIDENCE: pending

---

## Phase 5 — rollout

- [ ] P5-G1: `quality-gate.yml` green on this SHA
  EVIDENCE: pending

---

## Measured, not assumed: one pre-existing local test flake

`src/pages/supplierBankDetails.spec.tsx > renders international fields and sends IBAN/BIC without
Israel-only columns` failed on this machine with `Test timed out in 5000ms` during the first full
run. It is **not** caused by this branch — nothing here is in that file's import graph — and it is
**not** a logic fault:

| run | result |
|---|---|
| first full `npm run verify` | FAIL, timeout at 5,000ms |
| the file alone, default timeout | FAIL, same test, same timeout |
| that one test alone (`-t`) | **PASS** in 2.5s |
| the whole file at `--testTimeout=30000` | **PASS**, 9/9 |
| later full runs | **PASS** |

It is the ninth `userEvent` flow in one accumulating jsdom document and crosses 5s only after the
previous eight have run. **Deliberately not "fixed" here:** raising the global timeout would hide
real slowness across 162 files to accommodate one. Recorded so a later reader does not mistake it
for i18n fallout.

## The second abandonment, recorded outside the gate list

Task 4.5 — the "suggest a translation" button that pre-fills the English name — is **not built**,
and the reason is not technical. The only LLM provider in the repo is the assistant's
(`AI_ASSISTANT_PROVIDER=openai`), and `DEBT §63` records that the provider-governance `dpa` row is
`MISSING` by owner decision with the entitlement expiring 31.12.2026. Sending a tenant's catalogue
to an outside provider is a trust-boundary change, not a feature. Task 4.4 ships without it: a
person types, and it is saved through an audited door. Recorded in `docs/DEBT-REGISTER.md §68`.
