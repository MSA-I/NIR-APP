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
