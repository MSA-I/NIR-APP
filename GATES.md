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
  EVIDENCE: partial — `.tmp/shots/p2/orders-he.png` and `orders-en.png` read the live badges: `טיוטה` / `מוכנה לשליחה לספק` against `Draft` / `Ready to send to the supplier`, with `dir` flipping `rtl`/`ltr`. Remaining surfaces pending.

- [ ] P2-G6: extraction is FINISHED — zero Hebrew outside the dictionaries and the documented exceptions
  CHECK: node scripts/gate-i18n.mjs zero
  EXPECT: GATE_I18N_ZERO_OK
  EVIDENCE: pending — `exit=1`, `gate-i18n: extraction is not finished — 3634 Hebrew line(s) across 138 file(s)` (measured 28.08.2026 after PaymentRequests, Settings, Onboarding and InvoiceDetail; 4,982 at the start of the phase). **This oracle was replaced after the ledger's first run, and the ledger is what caught it.** It originally ran `ratchet`, which passes while thousands of lines remain, so the gate reported MET on its first day with 5,311 lines still hardcoded — the gate's English title and its command were measuring different things. `zero` fails until the count is actually zero.

  One thing this oracle cannot see, recorded so a later reader does not over-trust it: a file listed in `__reason` is exempted **entirely**, whatever its count. What closes that door is not this gate but `ratchet`, which pins every exempt file at the exact number it was exempted at, so an exemption cannot quietly grow. The pair is the guarantee; neither half is.

- [ ] P2-G8: the assistant answers a product question in the language it was asked in
  CHECK: node scripts/gate-i18n.mjs help-registry-paired
  EXPECT: GATE_I18N_HELP_PAIRED_OK
  EVIDENCE: half met, and the half that is met is the runnable one. exit=0; output=gate-i18n: 15 product-help topic(s), each in both locales | GATE_I18N_HELP_PAIRED_OK. Positive control: deleting the English row for `check_product_purchases` ⇒ `gate-i18n: the product-help registry is not paired. no English row: check_product_purchases`, exit 1; restored ⇒ pass. It fails in the other direction too, on an English row with no Hebrew original — that is #192's missing-locale rule read backwards, a translation of nothing. Every one of the 15 product-help topics now has both an `he` and an `en` row, built from the Hebrew row's own `route`, `roles`, `version` and `source` rather than retyped — those are contract fields the registry guard checks, and a retyped `roles` could hand somebody a screen the Guard withholds.

  **What is NOT met, and cannot be from this branch:** `get_product_help` takes `locale` as a TOOL ARGUMENT the model chooses, defaulting to `he` — it is never told the reader's actual locale, and `profiles.locale` does not reach the Edge Function at all. So an English speaker gets an English answer only when the model happens to pass `en`. The parameter's description now says to follow the language of the question, which raises the odds and is not a guarantee; wiring the caller's real locale through is an Edge change with its own deploy, outside this branch's surface.

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

- [ ] P3-G2: units read `kg` in English instead of `ק״ג`
  EVIDENCE: pending

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
