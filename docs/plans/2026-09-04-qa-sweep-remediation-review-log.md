# Plan Review Log: remediate the 2026-09-04 live-site QA sweep (146 findings)

**Plan file:** `docs/plans/2026-09-04-qa-sweep-remediation.md`.

**Why it is not `PLAN.md`.** The `codex-review` skill names `PLAN.md` and `PLAN-REVIEW-LOG.md` at the
repository root, and rounds 0 and 1 were written there — over two files that were already committed
and still live: the inbound-intake + billing plan locked with the owner on 31.08.2026 (`1b929e6f`).
Nothing was lost, both were restored byte-identical to `HEAD`, and this campaign moved to dated
files under `docs/plans/`, the convention `docs/MERGE-PLAN-20260901.md` already set. The cause was
taking a skill's default filename as a free name without checking the tree first.
Started 2026-09-04 (session start). MAX_ROUNDS=5. Model: gpt-5.6-sol (xhigh) via ~/.codex/config.toml.
## Round 1 — Codex

התוכנית עדיין אינה בטוחה למימוש.

### שבע ההכרעות

- **D1 — מקור הנתונים שגוי:** `p2_active_payment_request_total_by_currency()` מסכם את כל הארגון לפי מטבע, לא התחייבויות לכל חשבונית, ולכן אינו יכול למנוע over-commitment של חשבונית מסוימת ([0219](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/supabase/migrations/0219_summary_readers_and_tolerances_per_currency.sql:134>)). תיקון: בעת approval, תחת נעילת כל החשבוניות בסדר UUID, סכום `payment_request_invoices` של בקשות אחרות בסטטוסים ששומרים כסף; להגדיר במפורש אילו סטטוסים שומרים ולבדוק concurrency.

- **D1 — סתירה פנימית:** A2 אומר ש־`create_payment_request` יסרב, D1 אומר שרק approval יסרב; הטענה ששתי בקשות שסכומן שווה ליתרה ייחסמו שגויה — בדיקת `cumulative <= balance` מאפשרת אותן. תיקון: creation נותן warning בלבד; approval מבצע first-committer-wins אטומי.

- **D1 — ancestry שגוי:** הפונקציות לא נעצרות ב־`0023/0073`; `0231` שינה אותן לרב־מטבעי והצמיד `minor_units` ו־scope hashes ([0231](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/supabase/migrations/0231_payment_requests_are_single_currency_commands.sql:1>)). תיקון: patch מעוגן נגד הגוף החי ועדכון `scope_definer_enforcements`, לא העתקה מ־`0073`.

- **D2 — ה־REVOKE המוצע אינו עובד:** `REVOKE SELECT (phone, backup_email)` אינו מבטל `SELECT` ברמת הטבלה; התקדים האמיתי מבטל table grant ומעניק מחדש את כל העמודות המותרות ([0112](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/supabase/migrations/0112_kitchen_supplier_read_boundary.sql:51>)). תיקון: revoke מלא, regrant של projection נגזר מהקטלוג, וטענות `has_column_privilege` חיוביות ושליליות.

- **D2 — שני קוראים נשארו שבורים/פתוחים:** `AuthContext` עדיין עושה `profiles.select('*')`, וחשיפת `organizations.settings` שמוזכרת ב־A5 אינה מקבלת תיקון ([AuthContext](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/src/auth/AuthContext.tsx:147>)). תיקון: למפות כל קורא ל־self/team/public projection, לצמצם גם את `organizations`, ולבדוק owner/office/accountant ושלילה חוצת־דיירים.

- **D2 — ה־definer החדש חסר חוזה:** אין רישום exemption, scope proof או מטריצת הרשאות, אף שהחוקה מחייבת זאת לכל definer חדש ([Security Model](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/docs/ENTERPRISE-SECURITY-MODEL.md:155>)). תיקון: חתימה מדויקת, `search_path`, tenant/role checks, רישום מוצמד ובדיקות שליליות.

- **D3 — מטפל בתסמין:** ב־dark mode `--color-action` נהיה נייר בהיר ב־95%, אבל `.app-glow` ממשיך להשתמש בו; לכן מתקבל הפס הבהיר ([CSS](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/src/index.css:703>), [glow](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/src/index.css:1977>)). תיקון: token אטמוספרה ייעודי שאינו מחליף משמעות בין themes, או כיבוי glow ב־dark; לעדכן יחד `DESIGN.md` ולמדוד composited pixels.

- **D3 — סותר חוזה עיצוב:** ‏17% הוא ערך בעלים מתועד, לא רק תקרה טכנית ([DESIGN](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/DESIGN.md:259>)). תיקון: כל cap חדש דורש הכרעה מתועדת; אין לשנות רק CSS.

- **D4 — מחליש את השער:** החלפת source scan בבדיקה מרונדרת מאבדת כיסוי של כל אתרי הצגת filename; הבדיקה עצמה מודה שהיא סורקת כיסוי ולא פיקסלים ([spec](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/src/lib/fileNameIsolation.spec.ts:26>)). תיקון: להשאיר את הסריקה, לצמצם את הצורה המותרת ל־`<bdi dir="ltr">`/LTR isolate, ולהוסיף בדיקת דפדפן עם שמות mixed-script.

- **D5 — “לא תיקון קוד” אינו disposition:** ‏`ENTRY-09` נוגע גם למדיניות cleanup שב־`0289/#332`, לא רק ל־GoTrue; שלושת פריטי הנתונים ו־`ENTRY-04` נשארים ללא owner, פקודה, ראיה או מצב סיום ([#332](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/docs/OPEN-DECISIONS.md:824>)). תיקון: רשומת החלטה נפרדת לכל אחד עם exact action, rollback, evidence ו־`BLOCKED` עד ביצוע.

- **D6 — padding בצד הלקוח הוא security theater:** התוקף עדיין רואה את זמן וקוד HTTP של `signInWithPassword`/`resetPasswordForEmail`; floor חזותי אינו מסתיר 429 או network timing ([ForgotPassword](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/src/pages/ForgotPassword.tsx:34>)). תיקון: proxy שרתי rate-limited שמאחד status וזמן כולל, או קבלת הסיכון במפורש; לא sleep ב־React.

- **D7 — הנימוק המרכזי כבר לא נכון:** שני workflows מפעילים כל PR ללא base filter, ו־`check:workflow-triggers` עבר כעת; §65 סגור ([build.yml](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.github/workflows/build.yml:23>)). תיקון: למחוק את “branch-base trap” מהשיקול ולחלק לפי root cause ותלות, לא לפי הבחירה הכוזבת “אחד או שמונה”.

- **D7 — שמונה PRs עדיין גדולים מדי ובסדר שגוי:** Wave C/H הן רשימות של עשרות ממצאים ללא שינוי מוגדר, בעוד auth enumeration נדחה לאחר dashboard. תיקון: PR אחד לכל קבוצת root-cause עם traceability; להעלות את Wave D לפני עבודת UI לא־אבטחתית.

### כשלים נוספים

- **מקור האמת אינו קיים:** גם `qa/out` וגם `fix/all-findings.json` חסרים בעץ, ולכן אי אפשר לאמת חומרה, ראיה או retraction מול מה שהתוכנית מגדירה כמקור הסמכות ([PLAN](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/PLAN.md:6>)). תיקון: לצרף manifest immutable של 146 הממצאים, artifact hashes ו־deployment/SHA שנבדק.

- **שלושה ממצאים נעלמו:** החשבון של מזהי הסריקה מגיע ל־146 רק עם `ASSIST-02`, ‏`FIN-04`, ‏`MON-07`; הם אינם בתוכנית ואינם ברשימת ה־retractions. תיקון: להוסיף disposition מפורש לכל השלושה ולהחליף `~137` במספר מדויק.

- **A1 סותר הכרעת בעלים ובדיקה קיימת:** ‏#140 קובע במפורש שאין סיבה בבקשת או ביטול offboarding, וה־spec מקבע זאת ([decision](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/docs/OPEN-DECISIONS.md:397>), [spec](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/src/pages/offboardingContract.spec.ts:28>)). תיקון: להוסיף confirmation/details בלבד; אם רוצים סיבה, לעצור להכרעה חדשה לפני migration.

- **A1 יוצר שבירת rollout:** מחיקת החתימות הישנות לפני frontend חדש שוברת טאבים ו־service workers ישנים. תיקון: wrapper תואם לאחור או optional parameter עד migration מאוחרת להסרת החתימה.

- **A3 לא פותר את מרוץ הכסף החיצוני:** live balance לפני לחיצה אינו אטומי עם העברה שכבר נעשתה בבנק. תיקון: reserve/preflight server-side לפני ההעברה ואז recording אידמפוטנטי, או תמיד לקבל recording ולפתוח exception במקום לאבד אמת חשבונאית.

- **A4 אינו “constraint” רגיל:** PostgreSQL CHECK אינו יכול לאכוף aggregate חוצה־שורות, והכלל לא מגדיר `confirmed` בלבד, tolerance או concurrency. תיקון: constraint trigger/פקודה תחת נעילת `bank_transactions`, סכימת confirmed allocations בלבד, ובדיקת two-session race.

- **A6 כנראה מאבחן פעולה תקינה כבאג:** הסוויטה כבר מוכיחה mutation אחד מול audit אחד, ויומן הרולאאוט מתעד שורה אחת לשינוי ועוד אחת להחזרת הסיסמה ([test](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/supabase/tests/p4_flags_identity.sql:1025>), [rollout](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/docs/ROLLOUT-0291-0314-20260904.md:123>)); בנוסף כבר קיים index ל־cross-scope. תיקון: לקשור כל שורה לבקשת Auth ולרוץ עם `EXPLAIN (ANALYZE, BUFFERS)` לפני שינוי trigger או index.

- **Wave C מציע להרחיב query מעבר לסקופ:** accountant מוגבל במכוון לישות משפטית; widening עלול להיות דליפת הרשאה ([Security Model](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/docs/ENTERPRISE-SECURITY-MODEL.md:94>)). תיקון: לשמר scope שרתי ולכתוב אותו בתווית ובקישור; לא להרחיב אוכלוסייה כדי להשוות מספרים.

- **Wave E אינו מצמיד את invariant הרב־מטבעי:** אין שום היתר לחבר ILS ו־USD באותו סכום ([CLAUDE](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/CLAUDE.md:33>)). תיקון: sheet/section נפרד לכל מטבע, עם period ו־`—` עקביים ובלי total מאוחד.

- **מכניקת CI מיושנת:** `verify` כולל כעת 32 שלבים, ה־13/14 guards החסרים חוברו ל־CI, ו־`check:contrast` עבר טרי; ההפניות ל־§97 שגויות — החוב ההיסטורי הוא §105 ([package.json](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/package.json:45>), [build.yml](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.github/workflows/build.yml:252>)). תיקון: למדוד מחדש את מטריצת השערים מול HEAD ולא להעתיק מצב מ־01.09.

- **הוראת ledger מסוכנת:** התוכנית אומרת להוסיף שורה “by hand”, בעוד הכלי הקנוני עושה apply, ledger ו־verification ברצף ועוצר על כשל ([rollout-apply.ps1](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/scripts/rollout-apply.ps1:89>)). תיקון: להשתמש ב־`rollout-apply.ps1`; repair ידני רק לאחר אבחון והוכחת schema/ledger.

- **ניקוי נתוני QA אינו החלטה:** “Decide per wave whether to clean first” משאיר מחיקות כספיות פתוחות וסותר soft-delete-only ([PLAN](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/PLAN.md:165>)). תיקון: רשימת IDs מדויקת, פעולת domain מורשית לכל שורה, owner approval ו־before/after counts; ללא DELETE קשיח.

- **אין acceptance ledger ל־137 פריטים:** `npm run verify`, CI ו־smoke מסלולי אינם מוכיחים שכל finding נסגר. תיקון: טבלה מחייבת לכל ID עם cause, files, regression oracle, positive control, role/viewport/currency, rollout evidence וסטטוס `MET/BLOCKED/ABANDON`.

VERDICT: REVISE

### Claude's response — round 1

**Verified before accepting.** Codex advises; the repository decides. Six claims were checked
against HEAD and every one held:

- **#140 says no reason.** `docs/OPEN-DECISIONS.md:397` — "לא נדרשת סיבה" for the request, "ללא
  סיבה" for the cancellation — and `src/pages/offboardingContract.spec.ts:28` is titled "lets an
  owner request, cancel and download **without inventing a reason**". Round 0's `p_reason`
  migration would have overturned an owner ruling inside a bug-fix PR. Removed. What survives, and
  is now the whole of A1, is the half of #140 that IS broken: the ruling says "לאחר אימות מחדש",
  and `skipWhenFresh`'s default skips exactly that.
- **§65 is closed.** `.github/workflows/build.yml:23` carries a bare `pull_request:`, guarded by
  `check:workflow-triggers`. The eight-PR argument rested on a trap that no longer exists.
- **The guard matrix moved.** `npm run verify` is 32 sub-commands and `build.yml:265-278` runs the
  thirteen that were unwired. `DEBT §97` is `my_entitlements()`; the guards debt is `§105`.
  `CLAUDE.md` states both incorrectly and is corrected as part of this work.
- **`scripts/rollout-apply.ps1` exists** and applies + writes the ledger + verifies in one
  sequence. "Add the ledger row by hand" was a recipe for a half-applied rollout.
- **`0231` owns those functions now.** `0231:8,175,256-266` rewrote `create_payment_request` and
  `p1_transition_payment_request` by anchored replacement and registered them in
  `private.scope_definer_enforcements`. Re-declaring from `0073` would have silently reverted the
  multi-currency work — the failure mode `docs` already names.
- **`--color-action` flips to near-white in dark.** `src/index.css:703` — `oklch(95% 0.006 80)`.
  The glow mixes 17% of *that* over the dark canvas, which is why the band is light. Codex's
  diagnosis is better than round 0's "the dark theme has no measured ceiling", and it makes the fix
  a token change rather than an owner-value change.

Also accepted without needing a check, because they are correct as stated: `REVOKE SELECT (col)`
does not cancel a table grant; a `CHECK` cannot enforce a cross-row aggregate; client-side timing
padding is theatre; `AuthContext.tsx:147` is a second unmapped reader; a new definer needs an
exemption record and negative tests; widening the accountant's population would be a privilege leak
rather than a §12 fix; Wave E must not produce a combined ILS+USD total; QA data cleanup is
soft-delete-only and needs an id list and owner approval; and the 137 items need an acceptance
ledger, which is now `docs/GATES.md` with one row per finding id.

**Rejected, with reason.** Codex said three findings "vanished" and named `ASSIST-02`, `FIN-04` and
`MON-07`. Measured against the aggregate: `ASSIST-02` **was never issued** — the assistant agent's
ids run 01, 03-12, V1-V4, and the total is exactly 146 with no gap. `FIN-04` was already placed in
Wave C. Only `MON-07` was genuinely unplaced, and it moves into Wave B. One of three.

**Also fixed:** the plan now says where its source of truth actually lives (outside the repo, in
the QA session's scratchpad) and commits a hashed manifest plus the tested SHA to
`docs/QA-SWEEP-20260904.md` before Wave A opens, so a reviewer with only the tree can verify a
severity or a retraction. A6 now diagnoses `PERM-05` before touching a trigger, since
`supabase/tests/p4_flags_identity.sql:1025` and `docs/ROLLOUT-0291-0314-20260904.md:123` between
them may already explain the two rows as correct behaviour.

Ordering changed on Codex's argument: **A → D → B → C → E → F → G → H**, and PRs are cut per root
cause rather than per wave. An enumeration oracle outranks a dashboard tile.

### Measurement, not claim — baseline on the clean tree

`npm run verify` on `ccdfe4c0` with nothing modified: **3 failed, 222 passed (225 files) ·
2413 of 2416 tests**. All three failures are `Test timed out in 5000ms` in
`exportTemplateWorkbook.spec.ts:114`, `monthlyReport.spec.ts:175` and `p2Reliability.spec.ts:39` —
they ran while a `gpt-5.6-sol` review at `xhigh` was saturating the machine, which is the known
environmental fork-timeout, not a defect in those three files. They are re-measured on an idle
machine before any of this work is judged against them.

Because `npm run test` sits ahead of the last four sub-commands, `check:contrast` never ran in that
pass. Run alone on the same clean tree it **passes**:

    check:contrast passed: 53 text pair(s) at 4.5:1, 7 non-text pair(s) at 3:1, 1 direction
    contract(s), 2 text and 14 non-text exemption(s) each carrying a reason …

So `CLAUDE.md`'s "‏`check:contrast` נכשל על `main` היום … ומעולם לא עבר שם" is a **fourth** stale
claim, alongside §65, the guard matrix with its wrong section number, and the manual ledger step.
`DEBT §105` is stale in the same direction. Correcting all four is part of this work.

### A note on running this loop

Round 2's first two attempts produced nothing and looked like a duplicate verdict. `-o` writes the
verdict file **before** the process exits, so the file appearing is not the thread being released:
`codex exec resume` answered `thread-store conflict: … already has an active writer` and wrote a
zero-byte stream, while the stale `codex-verdict.txt` from round 1 sat there reading like a fresh
identical critique. Round 2 therefore runs on a **fresh thread** that is pointed at this log —
which carries round 1's critique verbatim — rather than by killing the process holding the lock.
