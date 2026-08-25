# InPlace — חוקת הפרויקט

מערכת procurement-to-payment בעברית RTL. **עוברת ממערכת ללקוח יחיד למוצר SaaS רב-דיירי.**

## העיקרון המנחה (סעיף 12 — מלווה את כל הפיתוח)

> **מטרת המערכת אינה רק לנהל את תהליך הרכש, אלא לספק למנהל העסק תמונת מצב מלאה בזמן אמת ולאפשר קבלת החלטות מהירה, פשוטה ומבוססת נתונים.**

זו לא סיסמה — זה מבחן. בכל תוספת שואלים: **האם היא עוזרת למנהל להבין, בתוך שניות מהכניסה, מה דורש טיפול, מה עלול לגרום להפסד כספי, ומה מצב העסק עכשיו?** מסך שרק *מציג* נתונים בלי לענות על זה הוא מסך תפעולי, לא מסך החלטה. הדשבורד (מרכז בקרה, סעיפים 1–3), רצועת "דורש טיפול", מסך ההתראות (`/alerts`, סעיף 9) והסיכום העסקי (סעיף 10) הם ההגשמה של העיקרון הזה — לא תכונות נפרדות ממנו.

## קרא לפני שאתה נוגע בקוד

| מסמך | מה יש בו |
|---|---|
| `docs/PROGRESS.md` | **קרא ראשון.** איפה עצרנו, מה השלב הנוכחי, מה נדחה ולמה |
| `docs/DEBT-REGISTER.md` | **קרא שני.** כל הדחייה, החוב והמגבלה הידועה במקום אחד — מה, למה נדחה, איפה ההוכחה, ומה הצעד הזול הבא. אל תתחיל עבודה חדשה לפני שבדקת שהיא לא נמצאת שם |
| `docs/ARCHITECTURE.md` | כללי מודל הנתונים — מחייבים |
| `docs/ENTERPRISE-SECURITY-MODEL.md` | גבולות אמון, תפקידים פעילים ו־RLS |
| `docs/INTEGRATION-ARCHITECTURE.md` · `docs/OFFLINE-SYNC-DESIGN.md` | חוזי אינטגרציה ו־offline הפעילים |
| `docs/OPEN-DECISIONS.md` | הנחות עסקיות שנקבעו כברירת מחדל ואיפה משנים אותן |
| `docs/LOCAL-CREDENTIALS-PATH.md` | נתיבי הסודות וחשבונות הבדיקה המקומיים/החיים. לקרוא סודות בזמן ריצה בלבד; לעולם לא להדפיס או להכניס ל-Git |

## כללי ברזל

**מודל נתונים** (`ARCHITECTURE.md:71-77`) — אלה לא המלצות:
- **אין `payment_id` על חשבונית.** טבלאות הקצאה N:M בלבד (`payment_allocations`, `bank_allocations`). חשבונית משולמת בכמה תשלומים, תשלום מכסה כמה חשבוניות, תשלומים חלקיים, קיזוזי זיכוי.
- **יתרות מחושבות, לא מאוחסנות** — העיקרון לא השתנה, המנגנון כן: מ-`0022` ‏`invoice_balances`/`supplier_balances` **אינם views** אלא פונקציות `SECURITY DEFINER` מחזירות־קבוצה — `p0_invoice_balance_rows()` ו-`p0_supplier_balance_rows()` (`ARCHITECTURE.md:116-120`).
- **snapshot מחירים** ב-`purchase_order_items.unit_price` ברגע ההזמנה; `price_history` שומר כל שינוי.
- **מחיקה רכה בלבד** לרשומות כספיות.
- כל פעולה רגישה נרשמת ב-`audit_logs` **עם סיבה**.

**רב-דיירות:**
- לכל טבלה יש `org_id`, ומעליה חוקת RLS שמסננת `org_id = auth_org()`. **אל תעקוף.**
- אחסון קבצים: הנתיב **חייב** להתחיל ב-`{org_id}/` — מדיניות הדלי קוראת אותו.
- **אל תשנה את ה-enum `user_role`.** הוא מוטבע ב-77 חוקות RLS. תוויות תצוגה משנים ב-`src/lib/status.ts`.
- מפתח `service_role` **לעולם לא בדפדפן**. רק ב-Edge Function.

**חשבונות בדיקת האתר החי — הרשאת בעלים מפורשת (13.08.2026):** סביבת הפריסה עדיין ללא לקוחות,
ושלוש הזהויות `owner@gamos.demo`, ‏`office@gamos.demo`, ‏`accountant@gamos.demo` הן חשבונות בדיקה
בשליטת בעל הפרויקט. סוכנים **רשאים להיכנס אליהן אוטומטית ולהשתמש בהן לצורך אימות ובדיקות**, כולל
תרחישי UI/הרשאות וזרימות הבדיקה שבתוכנית המאושרת. את הסיסמה קוראים בזמן ריצה בלבד מהקובץ החיצוני
המוגדר ב-`docs/LOCAL-CREDENTIALS-PATH.md`; אסור להדפיס סיסמה, token או מפתח בלוגים/תשובה ואסור
להכניסם לריפו. ההרשאה הזו גוברת על ניסוחים היסטוריים שלפיהם אימות מחובר הוא "לבעלים בלבד".
הזהויות שפרשו (`kitchen`, ‏`payer`, ‏`supplier`) נשארות חסומות ואין להפעילן מחדש.

**חשבונות הדמו המקומיים — חובת שחזור אחרי כל איפוס מקומי (24.08.2026):**
`supplyflow-p0` הוא stack משותף. כל סוכן שמריץ `supabase db reset`, מריץ SQL suite שמכיל
`Reset-LocalDatabase`, בונה מחדש את מסד הנתונים או מחליף סיסמאות fixture — **אחראי להחזיר
את סביבת הדמו לפני handoff**. ממתינים לאיפוס האחרון ולשחרור מנעול ה-QA; אין לשחזר באמצע gate.
קוראים בזמן ריצה את המניפסט החיצוני שמוגדר ב-`docs/LOCAL-CREDENTIALS-PATH.md`, מריצים
`scripts/create-users.ps1` מול `http://127.0.0.1:55431`, ואם ארגון/פרופילי הדמו חסרים טוענים
את `supabase/demo/demo_seed.sql` **מגרסה שתואמת ל-migration head החי** — לעולם לא seed ישן.
לפני סיום מוכיחים password grant אמיתי לשלושת `owner`/`office`/`accountant`, שלושה profiles
פעילים בתפקיד הנכון, זהויות retired חסומות, וכניסה בלחיצה דרך `localhost:5200`. ‏HTTP 200 או
עצם הופעת הכפתורים אינם הוכחה. אין להדפיס או לשמור סיסמה, token או service key. ‏Production מחוץ
לתחום. לבדיקת parser בלבד של `scripts/ci-sql-suites.mjs` משתמשים ב-`--list`; ללא הדגל הסקריפט
מבצע את הסוויטה ועלול לאפס את ה-stack.

**אין להמציא תשובות עסקיות** (`OPEN-DECISIONS.md:3`). שאלה עסקית פתוחה → ברירת מחדל מתועדת בטבלה שם, לא ניחוש שקט בקוד.

**אין ערכים סטטיים מזויפים בדשבורד.** כל מספר נגזר מנתוני האפליקציה. מדד שאין לו נתונים מציג `—`, **לא `0`** — אפס הוא גם טענה על המציאות.

## סטאק ופקודות

Vite 6 · React 19 · **React Router 8** · TypeScript strict · Supabase · **Tailwind v4 CSS-first** · recharts · lucide-react

- `npm run dev` — פורט **5199**
- `npm run build` — typecheck ובניית bundle בלבד. Build אינו מריץ בדיקות.
- `npm run test` — כל בדיקות היחידה והרכיבים תחת Vitest אחד.
- `npm run verify` — Knip, שומרי הטוקנים/כסף/חריגי definer/עמודות ספק, ואז Vitest.
- `npm run check` — build ו־verify יחד לשימוש מקומי לפני מסירה.
  ‏`check:money` שומר מקור אמת אחד לצורת כסף; `check:tokens` שומר על טוקני העיצוב;
  `check:exemptions` מונע הרחבה שקטה של `SECURITY DEFINER`; `check:supplier-columns` מונע
  `select('*')` שנחסם בגלל `bank_details`. בדיקות עסקיות רגילות אינן סקריפטי gate עצמאיים.
  **אין ESLint ואין Prettier** בריפו; TypeScript ו־Knip מכסים את השכבה הסטטית הנוכחית.
- `npm run quality` — שער האינטגרציה הכבד: SQL ו־preflight מול Supabase מבודד, חוזי Deno,
  OCR worker ותרחישי דפדפן. השער רץ ב־CI; אין להריץ אותו מקומית כחלק מעבודה רגילה.
  ב־CI כל job מופעל רק כאשר הנתיבים הרלוונטיים השתנו. `workflow_dispatch` מריץ את כולם.

  **איך מריצים את השער עכשיו:**
  ```
  gh workflow run quality-gate.yml    # או פשוט לפתוח PR / לדחוף ל-main
  gh run watch
  ```
  הראיות (צילומים, PDF, ‏`p4-browser-report.json`) עולות כארטיפקט **`browser-evidence`**.

  **מה `.github/workflows/quality-gate.yml` מריץ** — מסווג נתיבים לעבודה עצמאית ומקבילית:
  ‏`contracts` מפעיל חוזי Deno רק בשינוי Edge ואת build/self-check של OCR רק בשינוי worker;
  ‏`audit` רץ רק בשינוי `package*.json`; ‏`sql` מריץ סוויטות DB + preflight, כולל P46 של
  חשבונית מרכזת ב־`0137`; ‏`browser` מריץ תרחישי UI + fixtures + preview. שינוי קובץ
  `*.spec.*` בלבד אינו מקים את סביבת הדפדפן.

  **רשימת הסוויטות אינה מועתקת ל-YAML.** ‏`scripts/ci-sql-suites.mjs` **מפרסר אותה מתוך
  `check-quality-gates.ps1`** בזמן ריצה — אותה רשימה, אותו סדר, אותם תפקידי DB. עותק שני היה
  מקור סטייה; כאן אין עותק שני. איפוסי DB שמופיעים בסוף השער הידני לפני Edge/browser אינם
  מבוצעים במריץ ה־SQL של CI, מפני שאין אחריהם צרכן SQL.

  **מה ה-CI עדיין לא מכסה, במפורש:** ‏`check-p0-security.ps1` (‏862 שורות) ו-`check-p0-upgrade.ps1`
  (‏88), ‏`Invoke-PriceListEdgeSmoke`, ‏`Invoke-OcrEdgeSmoke` ו-`check-p4-integrated-journey.cjs`.
  אלה קשורים ל-PowerShell של Windows ורצים רק בריצה הידנית. **תיק ירוק אינו טענה שהם עברו.**

  ‏`.github/workflows/build.yml` יוצר תמיד את שמות ה־checks שהגנת הענף מצפה להם, אבל מקצה runner
  רק לצרכן הרלוונטי: `build` לקלטי bundle/typecheck; ‏`verify` לקוד, tests, scripts, migrations,
  Edge ו־Knip. שינוי test בלבד אינו בונה bundle; שינוי SQL suite/fixture בלבד אינו מריץ אף אחד
  משניהם. קובץ test בלבד מריץ Knip ו־Vitest בלי guards שסורקים קוד מוצר. גם בתוך check
  ‏`verify` מופעלים רק תתי־הפקודות שנפגעו: migration בלבד מריץ את guard
  ה־exemptions ללא `npm ci` או Vitest; ‏Edge מריץ Knip ללא Vitest; שינוי `src`
  מריץ את Knip, guards הרלוונטיים ו־Vitest. `quality-gate.yml` הוא שער האינטגרציה הכבד
  והמסונן לפי נתיבים. migration בלבד אינו מפעיל browser, אלא אם תוכנו משנה policy/RLS,
  ‏`user_role`, פונקציות ה־auth של ה־scope או grant/revoke ל־`authenticated`/`anon`.

  **ריצה מקומית — רק כמוצא אחרון**, לניפוי כשל ש-CI כבר דיווח עליו או לעבודה על הסקריפט עצמו:
  ‏`$env:SUPPLYFLOW_ALLOW_LOCAL_QUALITY = '1'; npm run quality`. לפני כן: לעצור `npm run dev`
  (תופס את פורט 5199 וחיבור כותב ל-DB) ולוודא שאין סוכן אחר באמצע ריצה. **ריצה אחת בכל רגע במכונה.**

  הגנת ענף (‏required status) היא הגדרת GitHub של הבעלים.

  **מטריצת rollout לייצור — מריצים את האיחוד של השורות שהשתנו, לא checklist אוניברסלי:**

  | משטח שהשתנה | מה נדרש לפני merge | מה נדרש בייצור | מה לא מריצים |
  |---|---|---|---|
  | תיעוד / CI בלבד | classifier וה־checks של קובצי ה־workflow שנגעו בהם | אין deploy | אין build מוצר, DB, Edge או smoke חי |
  | Frontend / נכס ציבורי | `build`; ‏`verify` כשקוד/בדיקות/guards השתנו; browser רק לשינוי מוצר | build עם env ייצור, סריקת סודות/localhost, Pages, התאמת hashes, smoke קנוני בנתיבים שהשתנו + `/`/`login` בדסקטופ ובמובייל; ב־URL הייחודי די ב־hash parity ובדיקת זמינות אחת | אין גיבוי/ledger/SQL/Edge ללא תלות מפורשת |
  | Migration / חוזה DB | `verify` guards + ‏SQL/preflight; browser רק אם חוזה נצרך בלקוח | גיבוי schema/data/roles, dry-run+ledger, apply forward-only, postflight וספירות רלוונטיות | אין Pages או asset parity אם ה־bundle לא השתנה |
  | Edge Function | חוזי Deno של Edge; OCR Docker רק בשינוי worker | deploy רק לפונקציה שהשתנתה, אימות secrets/JWT וקריאה חיה ממוקדת | אין Pages, גיבוי DB או OCR עבור Edge שאינו OCR |
  | Auth / תפקידים / RLS | האיחוד של DB/Edge/browser הנוגעים לחוזה | smoke מחובר וקריאה בלבד לתפקידים שנפגעו, בדיקת חסימה לתפקידים שפרשו והוכחת אפס כתיבות עסקיות | אין מטריצת כל התפקידים לשינוי שאינו הרשאה |
  | Dependencies | `build` + ‏`verify` + ‏`audit`; browser כי קוד runtime שנפתר השתנה | deploy frontend רק אם החבילה נכנסת ל־bundle | אין SQL או OCR אלא אם קבצי המשטח שלהם השתנו |
  | ‏`worker/ocr/**` או גרסת חוזה gateway | build ו־self-check של OCR ב־`contracts` | **פריסה מחדש של ה־VPS באותו רולאאוט**, והוכחת `job_claimed`+`job_completed` ביומן | אין Pages, DB או Edge שאינם קשורים |

  **ה־worker אינו נפרס עם כלום.** הוא רץ על VPS נפרד ואף שער ואף שלב רולאאוט אינו נוגע בו, ולכן
  merge ל־`main` לעולם אינו מגיע אליו. לשני חוזי ה־gateway יש מספר גרסה **בשני צדדים** —
  ‏`GATEWAY_CONTRACT_VERSION` ב־`worker/ocr/src/gateway.py` מול
  ‏`supabase/functions/document-processing/contract.ts`, ו־`SCAN_GATEWAY_CONTRACT_VERSION` ב־
  ‏`worker/ocr/src/scan_gateway.py` מול `supabase/functions/document-preprocessing/contract.ts`.
  העלאת מספר בצד אחד בלבד **משביתה את עיבוד המסמכים בייצור בשקט**: העובד ממשיך לרוץ, מדווח
  ‏`Up`, ונכשל ב־`gateway_contract_mismatch` בכל poll — והמסך מציג „ממתין בתור", כלומר הכשל
  נראה למשתמש כהמתנה. כך זה קרה ב־`a3603c0` (24.08.2026): ה־Edge עלה ל־`3`, העובד נשאר על `2`,
  ואפס מסמכים עובדו במשך חמישה ימים. ‏`Up` אינו ראיה — הראיה היא `job_claimed` ביומן.

  שינוי חוצה־משטחים מחבר את הדרישות; הוא אינו מחזיר אוטומטית את השער הידני המלא. ריצת
  `workflow_dispatch` היא חריג מפורש שמריץ הכול. PASS היסטורי לעולם אינו מחליף check טרי על ה־SHA.
- מיגרציות: `scripts/db-query.ps1` (Windows) / `scripts/db-query.sh` (Linux/Mac) — שניהם רצים מול
  **הפרויקט המרוחק** דרך Management API (`-SqlFile` + `-ProjectRef` חובה). ריצה מקומית של סוויטה או
  מיגרציה היא `docker exec … psql` על `supabase_db_supplyflow-p0`, הדפוס של `Invoke-SqlTest`.

**Tailwind v4: אין `tailwind.config.js`.** טוקנים ב-`@theme` בתוך `src/index.css`. מחלקות מותאמות יכולות `@apply` רק utilities אמיתיים — לכן `btn`/`badge` רשומים כ-`@utility`.

**RTL:** `<html dir="rtl">` פעם אחת. השתמש ב-properties לוגיים בלבד (`start`/`end`, `ms`/`me`, `ps`/`pe`) — אף פעם לא `left`/`right`. מספרים בתאים: `class="num"`.

## עיצוב

ממשק B2B פרימיום: ברור, אמין, מהיר, מקצועי, **רגוע**, אחראי כספית.

אסור: אנימציות מוגזמות · glassmorphism · שטחים דקורטיביים ריקים · טקסט זעיר בניגודיות נמוכה · גרפים מיותרים · הסתרת פעולות קריטיות מאחורי hover · מראה תבנית-אדמין גנרית · הפיכת כל דף לרשת כרטיסים מנופחת.

### Design Context

לפני כל עבודת UI קרא: **`PRODUCT.md`** (register, משתמשים, עקרונות אסטרטגיים, יעד WCAG 2.1 AA) ו-**`DESIGN.md`** (North Star: "חדר בקרה שקט"; טוקנים קנוניים, שפת הצבעים הסמנטית, חוקים בעלי-שם). שינוי בשפה הוויזואלית מחייב עדכון `src/index.css` + ‏`DESIGN.md` יחד — ‏DESIGN.md מתעד את הקוד, לא להפך.

## אבחון כישלונות — אין לולאת ניסיונות

שער או בדיקה שנכשלו הם **מדידה, לא דעה**. לפני שממהרים לתקן:

1. **קרא את ההודעה המלאה.** הבן *למה* זה נכשל, לא רק *מה*. אבחון קודם לתיקון — אל תנחש.
2. **הרץ מקומית את הבדיקה הספציפית** שנכשלה לפני push — משוב של שניות, לא דקות של CI.
3. **כל ניסיון חוזר חייב השערה חדשה.** אין "להריץ שוב בתקווה". לפני retry: מה הסיבה המשוערת, מה משתנה, למה שונה מהניסיון הקודם.
4. **גבול:** 2 כשלים רצופים באותו שער (3 לכשל סביבתי) — עצור ודווח: השגיאה המלאה, מה נוסה, למה כל ניסיון נכשל.
5. **אין לחזור על אותו ניסיון.** ניסוי שכבר נכשל לא יצליח בלי שינוי. נהל רשימה של מה שנוסה.

## דיווח

אל תכריז שתכונה עובדת בלי שמומשה ואומתה בפועל. שינוי ויזואלי — צילום מסך של התוצאה, לא הסתמכות על הזיכרון.
