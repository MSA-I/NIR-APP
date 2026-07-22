# SupplyFlow — מערכת ניהול רכש, חשבוניות ותשלומים

פלטפורמת Procurement-to-Payment מלאה: ספקים ← מחירונים ← הזמנות רכש ← קבלת סחורה ← חשבוניות ← זיכויים ← דרישות תשלום ← תשלומים ← התאמות בנק ← דוחות הנהלה ורו״ח.

**Stack:** React 19 + TypeScript + Vite + Tailwind CSS v4 + Supabase (PostgreSQL, Auth, RLS, Storage) + Recharts + SheetJS/PapaParse. עברית מלאה, RTL, ₪.

## הפעלה

```bash
npm install
npm run dev        # http://localhost:5199
```

`.env` (ראה `.env.example`):

```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
```

## משתמשי דמו — קיימים רק לאחר טעינת חבילת הדמו

לכל חשבון דמו נדרשת סיסמה חזקה וייחודית מתוך manifest חיצוני לריפו. הסקריפט אינו
כולל סיסמת ברירת־מחדל ואינו מדפיס סיסמאות; ראו `scripts/create-users.ps1`.

| אימייל | תפקיד | מסך בית |
|---|---|---|
| `owner@demo.supplyflow.local` | בעלים / הנהלה | מרכז הבקרה |
| `kitchen@demo.supplyflow.local` | צוות תפעול (מובייל) | קבלת סחורה |
| `office@demo.supplyflow.local` | מזכירות | מרכז הבקרה |
| `payer@demo.supplyflow.local` | מבצע העברות | תשלומים לביצוע |
| `accountant@demo.supplyflow.local` | רו״ח (קריאה בלבד) | דוח חודשי |
| `meshek@supplier.demo` | סוכן ספק — משק ירוק (מחירון בלבד) | המחירון שלי |

יצירת סוכן ספק נוסף: `scripts\create-supplier-user.ps1` (ראה הערות בסקריפט).

## מסד נתונים

- `supabase/migrations/0001_init.sql` — סכימה מלאה: 30 טבלאות, 15 enums, RLS לכל טבלה, טריגר ביקורת גנרי, views ליתרות, bucket אחסון `documents`.
- `supabase/migrations/0002_payer_execution.sql` — הרשאות ביצוע העברות + RPC לעדכון סטטוס תשלום.
- `supabase/migrations/0003_kitchen_balance_read.sql` — views של יתרות עם סינון ארגון.
- `supabase/migrations/0020_p0_identity_audit.sql`–`0022_p0_security_contract.sql` — גבולות
  זהות/lifecycle, FK רב־דייריים, audit שרתי, מחיקה רכה והרשאת מסמכים/Storage מבוססת שורה.
- `supabase/seed.sql` — seed ניטרלי לדייר חדש: שורת ארגון + קטגוריות התחלתיות בלבד.
- `supabase/demo/` — חבילת הדמו כדייר נפרד ("עסק לדוגמה"): 15 ספקים, 46 מוצרים וכל
  תרחישי הקצה הפיננסיים. נטענת לפי דרישה, ואינה חלק מהתקנה אצל לקוח.

הרצת SQL מול הפרויקט (Management API):

```powershell
$env:SUPABASE_ACCESS_TOKEN = "sbp_..."   # טוקן אישי מ-supabase.com/dashboard/account/tokens
.\scripts\db-query.ps1 -SqlFile supabase\migrations\0001_init.sql -ProjectRef "<project-ref>"
```

טעינת חבילת הדמו: `scripts\create-users.ps1` עם URL ו־manifest מפורשים, ואז
`scripts\seed-demo.ps1 -ProjectRef "<project-ref>"`. היעד הידוע של production נדחה כברירת־מחדל.

## בדיקה ידנית מומלצת (Happy Path)

1. **ניר (מובייל):** קבלת סחורה ← בחר הזמנה ← סמן כמויות/חסר/פגום ← סיום ← צילום חשבונית ← "הזנת חשבונית".
2. **מזכירות:** חשבוניות ← פתח חשבונית ← "הרצת בדיקות" (כפילויות/פערים) ← אישור לתשלום ← יצירת דרישת תשלום ← אישור.
3. **מבצע העברות:** תשלומים לביצוע ← בחר דרישה ← מלא אסמכתא ← "ההעברה בוצעה" (החשבונית תסומן כשולמה אוטומטית).
4. **מזכירות:** התאמות בנק ← ייבוא CSV ← מיפוי עמודות ← אישור הצעות התאמה.
5. **רו״ח / הנהלה:** דוח לרו״ח ← ייצוא Excel ← "סימון כהועבר לרו״ח".

לאחר טעינת חבילת הדמו: חשבונית `7702` של "בשר והבן" מ-03.07 היא כפילות מכוונת — פתח אותה
והרץ בדיקות כדי לראות את מנוע הכפילויות בפעולה.

`npm run build` מריץ בדיקת טיפוסים מלאה + בנייה.

בדיקות P0 הן מקומיות והרסניות למסד `supplyflow-p0` בלבד; כל אחת דורשת opt-in מפורש:

```powershell
.\scripts\check-p0-security.ps1 -ResetLocalDatabase
.\scripts\check-p0-upgrade.ps1 -ResetUpgradeDatabase
```

## תיעוד נוסף

- `docs/ARCHITECTURE.md` — ארכיטקטורה, מפת מסכים, מטריצת הרשאות, דיאגרמות סטטוסים, ה-workflow המלא.
- `docs/OPEN-DECISIONS.md` — הנחות עסקיות פתוחות שדורשות אישור (לא הומצאו תשובות).
- `docs/MVP-CHECKLIST.md` — צ׳קליסט מול דרישות האפיון.
