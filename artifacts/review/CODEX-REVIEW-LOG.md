# Codex review log — nine waves of QA remediation, as built

Started 2026-09-03. MAX_ROUNDS=5. Model: `gpt-5.6-sol`, reasoning `xhigh` (from `~/.codex/config.toml`).

**This is a review of an implementation, not of a plan.** The `codex-review` skill's machinery is
used as-is — Codex read-only, one persistent session, bounded rounds, this log as the artifact —
but the target is `artifacts/review/IMPLEMENTATION-UNDER-REVIEW.md` and the code it points at,
not `PLAN.md`. `PLAN.md` at the repo root is a real project document and is deliberately untouched.

**Read-only is forced on every call.** This machine's `~/.codex/config.toml` sets
`sandbox_mode = "danger-full-access"` and `approval_policy = "never"`, so an unforced resume would
let Codex write files.

## Round 1 — Codex

Thread `01a06740-8692-74f3-ae06-d1cbc8e33972`. Twelve findings, five HIGH.

נמצאו בעיות מהותיות. כמה טענות עומס במסמך שגויות בפועל.

1. **HIGH — תיקון ה־idempotency אינו פעיל כלל ומוסיף oracle בין דיירים.**  
   קבצים: [0295:151](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/supabase/migrations/0295_a_bound_the_screen_cannot_be_asked_to_keep.sql:151>), [Products.tsx:348](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/src/pages/Products.tsx:348>), [Suppliers.tsx:499](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/src/pages/Suppliers.tsx:499>).  
   מה נשבר: המיגרציה מעניקה `INSERT(id)`, אבל אף אחד ממסלולי היצירה המרכזיים אינו שולח `id`. אם ה־INSERT מתחייב והתשובה אובדת, retry מקבל UUID חדש ויוצר כפילות בדיוק כמו קודם. גם `QuickCreateProduct` שומר `pendingProduct` רק אחרי קבלת התשובה; `QuickCreateSupplier` אינו שומר מזהה כלל. בנוסף, משתמש שיודע UUID של מוצר מדייר אחר יכול לנסות להכניס אותו תחת הארגון שלו: הצלחה לעומת `23505` חושפת אם המזהה קיים.  
   תיקון: לבטל את שני grants ולהעביר יצירה ל־RPC עם מפתח idempotency ייחודי לפי `(org_id, request_key)`.

2. **HIGH — burst מקביל עוקף את נעילת הסיסמה.**  
   קובץ: [0296:81](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/supabase/migrations/0296_a_sign_in_attempt_that_can_be_counted.sql:81>).  
   מה נשבר: `SELECT ... FOR UPDATE` לא נועל שורה שאינה קיימת. עשרה ניסיונות ראשונים במקביל רואים “לא נמצא”; הראשון מוסיף `failed_count=1`, וכל היתר נכנסים ל־`ON CONFLICT` ומאפסים שוב ל־1 בשורות 107–108. כולם מחזירים `continue`.  
   רצף שובר: למחוק/לאפס counter, ואז לשלוח מאות ניחושי סיסמה במקביל; כל בדיקות הסיסמה רצות לפני שנבנית ספירה שימושית.  
   תיקון: ליצור את השורה ב־`INSERT ... ON CONFLICT DO NOTHING`, ואז לקרוא אותה `FOR UPDATE` ולעדכן תחת אותה נעילה, או להשתמש ב־advisory lock לפי `user_id`.

3. **HIGH — סקריפט ההפעלה מכוון לסוג hook שלא נבנה ועלול להפיל את כל הכניסות.**  
   קובץ: [auth-hardening.mjs:41](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/scripts/auth-hardening.mjs:41>).  
   מה נשבר: ההוראה היא `--with-lockout https://<host>/functions/v1/<fn>`, והסקריפט מקבל כל URI ומפעיל אותו. המימוש בפועל הוא פונקציית Postgres, לא Edge Function. לפי [Supabase Auth Hooks](https://supabase.com/docs/guides/self-hosting/self-hosted-auth-hooks), ה־URI הנכון הוא `pg-functions://postgres/public/password_verification_attempt`. בעקבות הדוגמה הקיימת GoTrue יקרא endpoint שאינו קיים וכל כניסה תיכשל.  
   תיקון: להסיר את הארגומנט החופשי, לקבע את ה־URI המדויק של פונקציית Postgres ולסרב לכל ערך אחר.

4. **MEDIUM — `supabase_auth_admin` מקבל גישה מיותרת לכל סכמת `private`.**  
   קבצים: [0296:145](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/supabase/migrations/0296_a_sign_in_attempt_that_can_be_counted.sql:145>), [0105:33](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/supabase/migrations/0105_supplier_price_baseline.sql:33>).  
   מה נשבר: ה־hook הוא `SECURITY DEFINER`, ולכן אינו צריך `USAGE` עבור הקורא על `private`. ה־grant החדש הופך פונקציות `private` ששמרו את ברירת המחדל `EXECUTE TO PUBLIC` לנגישות ל־Auth role. דוגמה מוכחת: `private.supplier_price_effective_on(...)` היא `SECURITY DEFINER`, מקבלת `org_id` שרירותי ואין עליה revoke; כעת Auth יכול לקרוא מחירי ספק של כל דייר.  
   תיקון: להסיר `GRANT USAGE ON SCHEMA private`; ה־hook הציבורי צריך רק `EXECUTE` ל־`supabase_auth_admin`.

5. **HIGH — גלאי ה־OCR הופך מסמך תקין בגלל סוגר סגירה בודד.**  
   קובץ: [parsers.py:139](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/worker/ocr/src/parsers.py:139>).  
   מה נשבר: התיעוד אומר ש־`unbalanced` “לא מחליט”, אבל סוגר `)` ללא פותח מגדיל גם `inverted` בשורות 145–154, וזה כן מפעיל `line_applied` בשורה 255. בדיקה ישירה על `קמח לבן 5 ק״ג)` החזירה `(judged=1, leading=0, inverted=1, unbalanced=1)` והפכה את השורה. בגלל ההכרעה ברמת המסמך, typo/OCR יחיד הופך את כל השורות וכל העמודים.  
   תיקון: לא לספור `closer_before_opener` בשורה שאינה מאוזנת; לדרוש זוג מאוזן הפוך וראיה מצטברת נוספת לפני היפוך מסמך שלם.

6. **HIGH — שלבי 0299/0300 אינם שומרים parity בזמן המעבר.**  
   קבצים: [0299:89](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/supabase/migrations/0299_the_derived_answer_gets_a_name.sql:89>), [0300:3](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/supabase/migrations/0300_every_reader_moves_to_the_derived_answer.sql:3>).  
   מה נשבר: הטענה שהעמודה הכתובה “still agrees” פרט לשורה 3377 נכונה רק לצילום הנתונים הנוכחי. ה־writer הישן נשאר על `<= 1`, בעוד הנגזרת משתמשת ב־100 minor units. חשבונית JPY עם יתרה 50 תיכתב `partial` אך תיקרא `paid`; חשבונית KWD עם יתרה 0.5 תיכתב `paid` אך תיקרא `partial`. גם credit חלקי ללא cash ייכתב `unpaid`, בעוד שורה 95 מחזירה `partial`. אחד־עשר המסכים והפונקציות שכבר הועברו יחלקו תשובות חדשות מיד.  
   תיקון: לפני העברת קוראים, לשנות את ה־writer כך שיכתוב `private.invoice_payment_state(i)`; רק לאחר parity ורמדיאציה להעביר קוראים ולהסיר את העמודה.

7. **MEDIUM — parser המחירים מחבר ספרות משני צדי סימון מטבע.**  
   קבצים: [0298:140](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/supabase/migrations/0298_one_parser_for_a_price.sql:140>), [price.ts:123](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/src/lib/price.ts:123>).  
   מה נשבר: `1 USD 2` או `1USD2` מזוהה כ־USD, הסימון מוחלף ברווח, ואז כל הרווחים נמחקים; התוצאה התקינה כביכול היא `12`. זה מספר שגוי, לא refusal.  
   תיקון: לאפשר סימון מטבע אחד בלבד בקצה השמאלי או הימני של התא ולסרב לסימון שמופיע בין שתי ספרות.

8. **MEDIUM — שני ה־parsers ה“זהים” מעגלים אחרת.**  
   קבצים: [price.ts:165](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/src/lib/price.ts:165>), [0298:212](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/supabase/migrations/0298_one_parser_for_a_price.sql:212>).  
   מה נשבר: עבור `1.005 ILS`, JavaScript מחשב `1.005 * 100` כ־`100.49999999999999` ומציג/שומר 1.00 במסלול Excel; PostgreSQL `numeric round(...,2)` מחזיר 1.01 במסלול OCR. הטענה על contract זהה שגויה.  
   תיקון: לעגל בצד הלקוח באמצעות arithmetic עשרוני מבוסס־מחרוזת/decimal library, או לקבל את תוצאת ה־parser מהשרת.

9. **MEDIUM — shaped route אינו קשור לחלון של העובדה.**  
   קובץ: [routeAccess.ts:100](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/src/lib/assistant/routeAccess.ts:100>).  
   מה נשבר: הבדיקה מאמתת רק `YYYY-MM-DD`. מקור לעובדת שבעה ימים עם `/expenses?from=0001-01-01&to=9999-12-31` עובר כ־`allowed` ומציג את כל ההיסטוריה. שום נתון מה־Fact או מה־filters אינו מגיע ל־validator, ולכן הטענה שאי אפשר להרחיב חלון שגויה.  
   תיקון: לשמור את פרמטרי הראיה הצפויים ב־SourceReference ולהשוות אותם לערכי החלון של ה־Fact באופן מדויק.

10. **MEDIUM — תיקון המטבע בדשבורד עדיין מייצר סדרת אפסים למטבע בלי נתונים.**  
    קובץ: [Dashboard.tsx:755](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/src/pages/Dashboard.tsx:755>).  
    מה נשבר: `byMonth` מסונן לפי המטבע, אך תנאי הנוכחות משתמש ב־`invoices.length` הגלובלי. אם קיימות רק חשבוניות ILS והמשתמש בוחר USD, מתקבלת סדרה בת ארבע נקודות אפס; `SpendBarChart` רואה array לא ריק ומציג axes במקום הודעת “אין נתונים”. זהו “החמישי” שהטענה אומרת שלא נוצר.  
    תיקון: להשתמש ב־`byMonth.size` או במספר החשבוניות המסוננות.

11. **MEDIUM — קטלוג ריק עדיין מוצג כמדד 0 בניגוד לחוקה.**  
    קובץ: [Inventory.tsx:109](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/src/pages/Inventory.tsx:109>).  
    מה נשבר: ארגון חדש עם אפס מוצרים מקבל “מתחת למינימום: 0”. לפי `CLAUDE.md`, מדד ללא נתונים חייב להיות `—`; אפס הוא טענה מדודה.  
    תיקון: להחזיר `null` גם עבור `rows.length === 0`, ולהשאיר את הסבר “הקטלוג ריק” ל־empty state.

12. **HIGH — rollback של tenant אינו קשור לניסיון provisioning שנכשל.**  
    קובץ: [0297:66](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/supabase/migrations/0297_a_failed_signup_leaves_nothing_behind.sql:66>).  
    מה נשבר: כל מחזיק `service_role` יכול למחוק tenant לגיטימי שנוצר לפני פחות מ־15 דקות ועדיין לא ביצע פעילות עסקית. אין state של `provisioning_pending`, attempt id או nonce שמוכיח שהקריאה היא compensation לכישלון. ה־service role יכול גם לקרוא את מזהי הארגונים, לכן UUID אינו הגנה.  
    תיקון: ליצור attempt/nonce פרטי יחד עם הארגון, לדרוש אותו ב־RPC, לצרוך אותו אטומית, ולסגור אותו עם הצלחת provisioning.

בדיקות read-only: שני `git diff --check` נקיים. במהלך הביקורת ה־WIP שבתחום הפך לקומיט `25a62211`; התוכן שנבדק נשאר אותו תוכן. לא שיניתי קבצים.

VERDICT: REVISE
### Claude's response — round 1

Ten of twelve findings acted on, one declined with an argument, one deferred with its cost
recorded. Every finding was verified against the code before it was touched; two of my own
claims turned out to be false and are corrected in `d782dc8b`.

| # | verdict | what changed |
|---|---|---|
| 1 | **confirmed, my claim was false** | no client sends an id, so `0295`'s grant bought nothing and opened a cross-tenant existence oracle. `0303` revokes both grants; the triple-submit is left OPEN and recorded |
| 2 | **confirmed** | `for update` cannot lock a missing row, so a burst all reset the count to 1. `0303` moves the whole count into one upsert — proved with 12 parallel sessions: count 12, locked |
| 3 | **confirmed** | the script's own example would have pointed GoTrue at a non-existent endpoint and refused every sign-in. URI pinned to `pg-functions://…`, flag takes no argument |
| 4 | **confirmed** | the hook is DEFINER and never needed `usage on schema private`; the grant opened four private definers to the Auth role. Revoked |
| 5 | **confirmed** | an unbalanced closer voted for inversion, and the restorer reverses letters, so one artefact corrupted a whole document. Closer no longer votes; self-check now 0/13 false positives and `one_line_inverts_a_document: no` |
| 6 | **confirmed, my claim was false** | writer and readers computed different answers (tolerance, and cash-only vs cash-or-credit). `0304` takes the reviewer's ordering: the writer now computes the derived expression |
| 7 | **confirmed** | `parse_price('1 USD 2')` returned 12.00. A marker is now allowed only at one end of the cell, on both sides |
| 8 | **confirmed** | float rounding disagreed with `numeric` on `1.005`, `1.015`, `0.145`. Client now rounds on the digits; eight cases asserted against the database's own answers |
| 9 | **confirmed** | the shaped rule checked a shape, not the window. The window travels on the SourceReference and the link must equal it |
| 10 | **confirmed** | the presence test counted every currency's invoices while the buckets held one. Measured before and after |
| 11 | **declined, with the argument in the code** | an em dash marks a question that could not be answered; over an empty set every member was inspected. The original defect was a three-valued predicate hiding uncounted products, not the size of the set |
| 12 | **confirmed; narrower fix taken** | `0305` fences on NO PROFILE, which is what a failed provision actually is. The per-attempt nonce is stronger and its cost is recorded in the migration: the token cannot live where `service_role` reads, so it needs a digest column, a registry move and a change to the one path never exercised end to end |

Two assertions I wrote were wrong on first run and are noted in their migrations: `0303`'s
tested `has_function_privilege` where the gate is `has_schema_privilege`, and `0304`'s searched
for a literal that its own explanatory comment quotes.

`npm run verify`: 225 test files, 2414 tests, all 27 guards, green.

## Round 2 — Codex

Eight findings, four HIGH, and most of them attack the round-1 fixes rather than the original code.

לא מאושר. נמצאו שבע בעיות מהותיות ועוד הפרת חוזה אחת.

1. **HIGH — ה־pre-check המקביל אינו “harmless” כשאחד הניסיונות תקין.**  
   קובץ: [0303:96](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/supabase/migrations/0303_a_counter_that_cannot_be_outrun.sql:96>).  
   רצף שובר: החשבון על 9 כישלונות; בקשה עם סיסמה שגויה ובקשה עם הסיסמה הנכונה רצות יחד. שתיהן קוראות `locked_until = null`. השגויה מעלה ל־10 ונועלת; התקינה מגיעה לשורות 105–109, מוחקת את אותה שורה — גם אם נאלצה להמתין לעדכון — ומחזירה `continue`. כלומר סיסמה נכונה מתוך burst שעבר את הסף עדיין נכנסת ומוחקת את הנעילה.  
   תיקון: לסדר גם את בדיקת הנעילה וגם את ענף `valid` תחת אותה נעילת שורה/advisory lock; ההחלטה והמחיקה חייבות לקרוא state נעול ועדכני.

2. **HIGH — החלון עדיין fixed-window, לא rolling כפי שהוכרעה הדרישה.**  
   קובץ: [0303:121](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/supabase/migrations/0303_a_counter_that_cannot_be_outrun.sql:121>).  
   רצף שובר: כישלון ראשון ב־00:00; עוד שמונה ב־00:14:59; ב־00:15:01 הכישלון הבא מאפס את הספירה ל־1 בגלל `window_started`; שמונה נוספים מיד אחריו מגיעים רק ל־9. כך 17 כישלונות בתוך שניות עוברים ללא נעילה. הטענה על “rolling window” שגויה.  
   תיקון: לשמור ולגזום timestamps של הניסיונות שב־15 הדקות האחרונות, או להשתמש במנגנון sliding-window/token-bucket אמיתי.

3. **HIGH — 0304 מבטיח agreement רק ברגע הכתיבה; שינוי tolerance מפריד שוב בין ה־writer לקוראים.**  
   קבצים: [0304:70](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/supabase/migrations/0304_the_writer_and_the_reader_answer_the_same_question.sql:70>), [CurrencyTolerancesPanel.tsx:164](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/src/components/CurrencyTolerancesPanel.tsx:164>).  
   רצף שובר: חשבונית עם יתרה 0.75 ILS נכתבת `paid` תחת tolerance של 1.00. הבעלים משנה בהגדרות את הסף ל־0.50. הקוראים הנגזרים מחזירים מיד `partial`, אבל העמודה השמורה נשארת `paid`, ואחד־עשר מסכי הלקוח עדיין קוראים ומסננים לפיה. הטענה “cannot drift apart” שגויה.  
   תיקון: שינוי `invoice_payment_settled_tolerance` חייב לרענן באותה טרנזקציה את כל חשבוניות הארגון/המטבע, או להשלים קודם את step 3 ולהפסיק לקרוא את העמודה.

4. **HIGH — גדר no-profile שוברת rollback של מסלול federated אחרי כשל מאוחר.**  
   קבצים: [0305:61](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/supabase/migrations/0305_a_rollback_that_only_reaches_a_tenant_with_nobody_in_it.sql:61>), [provision.ts:518](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/supabase/functions/_shared/provision.ts:518>).  
   רצף שובר: `adoptExistingUserAsOwner` יוצר ארגון ו־profile עבור חשבון Google קיים; הכנסת הקטגוריות בשורה 532 נכשלת; ה־catch קורא `rollbackTenant`, אך `created.userId` נשאר ריק בכוונה ולכן ה־profile אינו נמחק. 0305 רואה profile ומסרב לנקות. נשארים ארגון ו־profile למרות שהפונקציה החזירה failure, והניסיון הבא נתקע על ה־profile הקיים. הטענה ש“Every failure ... happens at or before that user step” שגויה.  
   תיקון: לעקוב אחרי profile שנוצר בניסיון federated ולמחוק אותו לפני teardown, או להשתמש ב־attempt state/nonce שמאפשר לנקות רק את הרשומות של אותו ניסיון.

5. **MEDIUM — `route_params` אינו נשמר בהיסטוריה, ולכן התיקון נעלם אחרי refresh.**  
   קבצים: [contracts.ts:317](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/src/lib/assistant/contracts.ts:317>), [0164:836](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/supabase/migrations/0164_assistant_foundations.sql:836>), [0170:113](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/supabase/migrations/0170_assistant_history_ui_handoff.sql:113>), [history.ts:148](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/supabase/functions/assistant/history.ts:148>).  
   רצף שובר: משתמש עם history פעיל מבקש purchase metrics; המקור הטרי כולל `route_params`; `assistant_record_run` שומר רק `route`; ה־snapshot מחזיר רק `route`; `parseSources` גם אינו מעתיק את השדה. בטעינה חוזרת shaped route מגיע ללא declaration, `routeAccess` מסרב לו, `validateAnswer` נכשל וכל הריצה מושמטת מההיסטוריה.  
   תיקון: להוסיף `route_params` ל־`assistant_source_references`, לכותב, ל־snapshot ול־`parseSources`, עם patch מעוגן ועדכון ה־body pins.

6. **MEDIUM — shaped route עדיין מאשר תאריכים שאינם תאריכים וטווח הפוך.**  
   קבצים: [routeAccess.ts:116](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/src/lib/assistant/routeAccess.ts:116>), [Expenses.tsx:125](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/src/pages/Expenses.tsx:125>).  
   קלט שובר: route ו־`route_params` זהים עם `from=2026-02-31&to=2026-02-31` עוברים כ־`allowed`, ואז `addCalendarDays` זורק `Invalid calendar date`. גם `from=2026-09-10&to=2026-09-01` עובר ומוביל למסך invalid במקום לראיה.  
   תיקון: לאמת יום קלנדרי אמיתי וגם `from <= to`, לא רק regex צורני.

7. **HIGH — גלאי ה־OCR עדיין הופך מסמך לוגי תקין בגלל שהוא מאפס bracket depth בכל שורה.**  
   קובץ: [parsers.py:155](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/worker/ocr/src/parsers.py:155>).  
   קלט שובר:
   ```text
   (תנאים
   ) המשך
   א) מוצר
   ```
   הסוגר בתחילת השורה השנייה סוגר opener מהשורה הקודמת; `א)` בשורה השלישית הוא סימון רשימה תקין. הקוד סופר `(strong=1, evidence=2)`, שורה 304 מפעילה את ההיפוך, וכל המסמך משתנה. פרוב קריאה בלבד החזיר `(3, 1, 2, 3, 1, 2)` ו־`applied=true`. לכן הטענה ש־strong order “cannot occur in logical text” שגויה.  
   תיקון: לעקוב אחרי עומק סוגריים בין שורות ולהחריג list markers; אין להכריע לפי כל שורה כאילו היא פסקה עצמאית.

8. **MEDIUM — ערך המחיר תוקן, אך חוזה `rounded` עדיין שונה בין JS ל־Postgres.**  
   קובץ: [price.ts:205](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/src/lib/price.ts:205>).  
   קלט שובר: `1.000000000000000001 ILS`. `Number(...)` כבר הופך אותו ל־1; גם התוצאה המעוגלת היא 1 ולכן שורה 222 מחזירה `rounded:false`. PostgreSQL `numeric` רואה שינוי מ־`1.000000000000000001` ל־`1.00` ומחזיר `rounded:true`. אותה בעיה קיימת ב־`999999.999999999999`.  
   תיקון: לחשב את `rounded` מהספרות שנחתכו — האם החלק שנזרק מכיל ספרה שאינה אפס — ולא מהשוואת שני `number` שכבר איבדו דיוק.

לא שיניתי קבצים. ה־WIP הקיים ב־`CODEX-REVIEW-LOG.md` וב־`.claude/settings.local.json` נשמר.

VERDICT: REVISE
### Claude's response — round 2

All eight acted on. **Six of the eight were defects in round 1's own fixes, and four claims of mine were false** — the burst being "harmless", the window being "rolling", `0304`'s "cannot drift apart", and `0305`'s "every failure happens at or before the user step".

| # | verdict | what changed |
|---|---|---|
| 1 | **confirmed, my claim was false** | the whole decision is now behind one advisory lock (`0306`). A row lock cannot cover a row that does not exist. Proved: a correct password racing the tenth failure now rejects, count 10, lockout intact |
| 2 | **confirmed, my claim was false** | the run is measured from the LAST failure, so there is no window edge to wait for. Proved with `window_started` 16 minutes old: the tenth failure rejects instead of resetting |
| 3 | **confirmed, my claim was false** | `0307` — a trigger scoped to that one settings key relabels the invoices the new threshold moves. Proved with the reviewer's 0.75/1.00→0.50 sequence |
| 4 | **confirmed, my claim was false** | the rollback deletes the profile THIS attempt wrote, by id. A blanket org-scoped sweep was the first version and it re-opened finding 12 through a side door |
| 5 | **confirmed, and the worst of the eight** | `0308` persists `route_params`. Round 1's fix made a reload drop the WHOLE RUN from history, silently — worse than the hole it closed |
| 6 | **confirmed** | both ends must round-trip as real calendar days and be in order. A leap day in a leap year still passes; one in a non-leap year does not |
| 7 | **confirmed** | bracket depth is carried across lines and list markers are stripped. `readable_false_positives 0/15`, plus `wrapped_parenthetical_survives: yes` |
| 8 | **confirmed** | `rounded` is read off the discarded digits, not off two floats that already lost the distinction |

`npm run verify`: 225 test files, 2416 tests, all 27 guards, green.

## Round 3 — Codex

Eight findings, five HIGH, and it named four more of my claims as false. Two of them were about my own PROOFS rather than my code.

לא מאושר. שמונה כשלים נשארו; ארבע טענות בתגובה אינן נכונות.

1. **HIGH — `0306` אינו חלון rolling ומפר את הכרעה #347.**  
   קבצים: [0306:109](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/supabase/migrations/0306_the_whole_decision_under_one_lock.sql:109>), [OPEN-DECISIONS.md:848](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/docs/OPEN-DECISIONS.md:848>).  
   רצף שובר: כישלונות בדקות 0, 14, 28, …, 126. אף חלון בן 15 דקות אינו מכיל יותר משני כישלונות, אך העשירי נועל משום שהקוד מאפס רק אחרי פער של 15 דקות. תוקף אטי משאיר ספירה ישנה בחיים ונועל חשבון אחרי יותר משעתיים. הטענה ש“מספרי הכרעה #347 לא השתנו” שגויה; ההכרעה דורשת במפורש חלון מתגלגל.  
   תיקון: לשמור ולגזום timestamps של כישלונות ב־15 הדקות האחרונות, או לממש sliding-window אמיתי.

2. **HIGH — trigger של `0307` מגלגל לאחור שמירה אמיתית מהדפדפן.**  
   קבצים: [0307:62](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/supabase/migrations/0307_a_tolerance_change_carries_the_labels_with_it.sql:62>), [0033:13](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/supabase/migrations/0033_p1_financial_guard_table_safety.sql:13>), [CurrencyTolerancesPanel.tsx:164](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/src/components/CurrencyTolerancesPanel.tsx:164>).  
   קלט שובר: חשבונית עם יתרה 0.75 מסומנת `paid` תחת סף 1.00; owner שומר 0.50. ה־trigger קורא ל־`p1_refresh_invoice_payment_statuses`, אך לא קובע `app.p1_financial_writer`. ‏`auth.uid()` אינו null, guard החשבוניות זורק `financial_command_rpc_required`, וכל שינוי ההגדרות מתבטל. ההוכחה כ־postgres עקפה בדיוק את המסלול האמיתי.  
   תיקון: לקבוע את GUC בתוך ה־trigger/refresh המורשה לפני עדכון החשבוניות.

3. **HIGH — גם אחרי תיקון ה־GUC, `0307` משאיר race שמפריד שוב writer ו־reader.**  
   קובץ: [0307:54](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/supabase/migrations/0307_a_tolerance_change_carries_the_labels_with_it.sql:54>).  
   רצף שובר: T1 מכניס allocation לא־מחויב שמשאיר 0.75; T2 משנה 1.00 ל־0.50 וה־trigger אינו רואה את allocation ולכן מוצא אפס drift; בעוד T2 פתוחה, T1 קורא את גרסת ההגדרות הישנה ב־MVCC וכותב `paid`; שתי הטרנזקציות מתחייבות. התוצאה הסופית היא stored=`paid`, derived=`partial`. הטענה ש“השינוי והתיוג הם מעשה אחד” שגויה תחת concurrency.  
   תיקון: לקחת lock משותף פר־ארגון בכל כותבי התשלום ובשינוי הסף, או להסיר את העמודה הנגזרת.

4. **HIGH — תיקון ה־profile sweep אינו יכול לרוץ.**  
   קובץ: [provision.ts:563](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/supabase/functions/_shared/provision.ts:563>).  
   רצף שובר: `adoptExistingUserAsOwner` מכניס profile בהצלחה ואז הכנסת categories נכשלת. `created.profileUserId = input.ownerUserId` נמצא אחרי `throw` ובתוך `if (profileInsert.error)`, ולכן בענף הצלחה הוא מדולג ובענף כשל הוא unreachable. ‏`rollbackTenant` אינו מוחק profile, ו־`0305` מסרב למחוק את הארגון. הטענה שה־profile של הניסיון נמחק לפי id שגויה. אותו פגם קיים בשורות 480–486 במסלול הרגיל.  
   תיקון: לסגור את ענף השגיאה מיד אחרי ה־`throw` ולהעביר את שתי ההשמות אחריו.

5. **HIGH — עומק הסוגריים אינו באמת משתתף בסריקת הסדר.**  
   קובץ: [parsers.py:198](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/worker/ocr/src/parsers.py:198>).  
   קלט שובר:
   ```text
   (סעיף ראשון
   ) המשך (סעיף שני
   ) המשך (סעיף שלישי
   ) סוף
   ```
   הטקסט מאוזן ולוגי גלובלית. הסריקה מאפסת `depth = 0` בכל שורה, ולכן שתי שורות ההמשך נחשבות `balanced` אך הפוכות. פרוב החזיר `(4, 0, 2, 2, 2, 2)`, ‏`applied=true`, והטקסט השתנה. הטענה ש־bracket depth נישא בין שורות נכונה רק לחלק מהבדיקות, לא להכרעה עצמה.  
   תיקון: להתחיל את הסריקה המסודרת מהעומק התלוי ולעדכן stack/depth תו־אחר־תו בין שורות.

6. **MEDIUM — סמן רשימה בלי רווח עדיין נספר כראיית היפוך.**  
   קובץ: [parsers.py:116](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/worker/ocr/src/parsers.py:116>).  
   קלט שובר:
   ```text
   (סעיף ראשון
   ) המשך (סעיף שני
   ) סוף
   א)קמח
   ```
   OCR שמסיר את הרווח אחרי הסמן אינו מתאים ל־`\s+`. פרוב החזיר `(4, 0, 2, 3, 1, 2)`, ‏`applied=true`; אותו קלט עם `א) קמח` החזיר `applied=false`.  
   תיקון: לזהות גם marker צמוד לתוכן, עם lookahead מוגבל לתחילת טקסט עברי/מספרי.

7. **MEDIUM — `isRealCalendarRange` מאשר שנה 0000 שהיעד מסרב לה.**  
   קבצים: [routeAccess.ts:132](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/src/lib/assistant/routeAccess.ts:132>), [format.ts:358](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/src/lib/format.ts:358>).  
   קלט שובר: route ו־`route_params` שניהם `from=0000-01-01&to=0000-01-01`. ‏`Date.parse` round-trips אותו כ־`0000-01-01`, ולכן המקור מאושר; `Expenses` קורא `addCalendarDays`, וה־parser הקנוני זורק `Invalid calendar date` בגלל `year < 1`. הטענה ששני הקצוות הם ימים אמיתיים שגויה.  
   תיקון: לדרוש year ‏1–9999 או להשתמש באותו parser קלנדרי קנוני בשני המקומות.

8. **MEDIUM — `0308` מתקן רק ריצות חדשות ומעלים היסטוריה קיימת.**  
   קבצים: [0308:39](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/supabase/migrations/0308_a_citation_keeps_its_window_after_a_refresh.sql:39>), [routeAccess.ts:211](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/src/lib/assistant/routeAccess.ts:211>), [history.ts:252](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.claude/worktrees/implementation-prompt-review-a91515/supabase/functions/assistant/history.ts:252>).  
   רצף שובר: ריצת `get_purchase_metrics` שנשמרה לפני השינוי נושאת `route='/expenses'` ואין לה `route_params`. ‏`0308` מוסיף עמודה nullable אך אינו מבצע backfill. לאחר הפריסה, shaped rule דורש בדיוק `from` ו־`to`, מחזיר `not_allowlisted`, ו־history משמיט את כל הריצה.  
   תיקון: במיגרציה להפוך routes ישנים כאלה ל־`null` כדי לשמר את הריצה בלי קישור מטעה, או לבצע backfill מאומת כשקיים חלון בר־שחזור.

`discardedDigits` וה־advisory-lock primitive עצמם שרדו את מקרי הקצה שנבדקו. לא שונו קבצים; HEAD הוא `50d71b54`, וה־WIP היחיד נשאר `.claude/settings.local.json`.

VERDICT: REVISE
### Claude's response — round 3

Seven of eight fixed and proved; one recorded as open with the argument for the better answer.

| # | verdict | what changed |
|---|---|---|
| 1 | **confirmed, my claim was false** | `0310` stores the failure timestamps and prunes them. A rolling window cannot be derived from a counter and one date — anchored to the first it resets on its own edge, anchored to the last it never resets for a patient attacker. Proved both ways: nine failures 14 minutes apart no longer lock, ten inside the window still do |
| 2 | **confirmed, and my PROOF was worthless** | the trigger raised `financial_command_rpc_required` and rolled back the whole settings save. My verification ran as `postgres` with no JWT — the one context where the guard does not apply. `0309` declares the writer; re-proved through an authenticated owner |
| 3 | **confirmed, left open with its argument** | a genuine MVCC race between a payment writer and a tolerance change. Closing it needs a per-org lock across every payment writer, or step 3 — the column removed and nothing left to disagree. Step 3 is the better answer and is recorded in `0309`'s header rather than implied |
| 4 | **confirmed, my fix was dead code** | both `created.profileUserId` assignments landed INSIDE the error branch, after the `throw`. Unreachable. The brace is moved and both sites verified by reading the control flow, not the diff |
| 5 | **confirmed** | the ordered scan restarted at depth zero per line, so carrying the depth into the skip test alone decided nothing. It now starts from what earlier lines left open |
| 6 | **confirmed** | a list marker whose trailing space OCR dropped missed `\s+`. The separator is a lookahead now |
| 7 | **confirmed** | year 0000 round-trips through `Date` and is still refused by the calendar parser the destination screen uses. Bounded to 0001–9999 |
| 8 | **confirmed** | `0308` fixed the future and left the past holding the same defect. `0309` strips the query string from the 23 citations that predate it: weaker, honest, and the run survives |

The OCR self-check now reports `logical_documents_survive: 3/3` — the wrapped parenthetical, the chained continuations and the space-less list marker are permanent fixtures.

`npm run verify`: 225 test files, 2416 tests, all 27 guards, green.

