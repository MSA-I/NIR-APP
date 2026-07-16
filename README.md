# SupplyFlow — מערכת ניהול רכש, חשבוניות ותשלומים | אולמי גאמוס

פלטפורמת Procurement-to-Payment מלאה: ספקים ← מחירונים ← הזמנות רכש ← קבלת סחורה ← חשבוניות ← זיכויים ← דרישות תשלום ← תשלומים ← התאמות בנק ← דוחות הנהלה ורו״ח.

**Stack:** React 19 + TypeScript + Vite + Tailwind CSS v4 + Supabase (PostgreSQL, Auth, RLS, Storage) + Recharts + SheetJS/PapaParse. עברית מלאה, RTL, ₪.

## הפעלה

```bash
npm install
npm run dev        # http://localhost:5199
```

`.env` (ראה `.env.example`):

```
VITE_SUPABASE_URL=https://rkftlbctohswhbbiaqin.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
```

## משתמשי דמו (סיסמה לכולם: `Gamos2026!`)

| אימייל | תפקיד | מסך בית |
|---|---|---|
| `owner@gamos.demo` | בעלים / הנהלה | דשבורד |
| `nir@gamos.demo` | ניר — מנהל מטבח (מובייל) | קבלת סחורה |
| `office@gamos.demo` | מזכירות | דשבורד |
| `payer@gamos.demo` | מבצע העברות | תשלומים לביצוע |
| `accountant@gamos.demo` | רו״ח (קריאה בלבד) | דוח חודשי |
| `meshek@supplier.demo` | סוכן ספק — משק ירוק (מחירון בלבד) | המחירון שלי |

יצירת סוכן ספק נוסף: `scripts\create-supplier-user.ps1` (ראה הערות בסקריפט).

## מסד נתונים

- `supabase/migrations/0001_init.sql` — סכימה מלאה: 30 טבלאות, 15 enums, RLS לכל טבלה, טריגר ביקורת גנרי, views ליתרות, bucket אחסון `documents`.
- `supabase/migrations/0002_payer_execution.sql` — הרשאות ביצוע העברות + RPC לעדכון סטטוס תשלום.
- `supabase/migrations/0003_kitchen_balance_read.sql` — views של יתרות עם סינון ארגון.
- `supabase/seed.sql` — נתוני דמו ריאליסטיים בעברית (15 ספקים, 46 מוצרים, כל תרחישי הקצה הפיננסיים).

הרצת SQL מול הפרויקט (Management API):

```powershell
$env:SUPABASE_ACCESS_TOKEN = "sbp_..."   # טוקן אישי מ-supabase.com/dashboard/account/tokens
.\scripts\db-query.ps1 -SqlFile supabase\migrations\0001_init.sql
```

יצירת משתמשי הדמו: `scripts\create-users.ps1` (דורש `SUPABASE_SERVICE_KEY`).

## בדיקה ידנית מומלצת (Happy Path)

1. **ניר (מובייל):** קבלת סחורה ← בחר הזמנה ← סמן כמויות/חסר/פגום ← סיום ← צילום חשבונית ← "הזנת חשבונית".
2. **מזכירות:** חשבוניות ← פתח חשבונית ← "הרצת בדיקות" (כפילויות/פערים) ← אישור לתשלום ← יצירת דרישת תשלום ← אישור.
3. **מבצע העברות:** תשלומים לביצוע ← בחר דרישה ← מלא אסמכתא ← "ההעברה בוצעה" (החשבונית תסומן כשולמה אוטומטית).
4. **מזכירות:** התאמות בנק ← ייבוא CSV ← מיפוי עמודות ← אישור הצעות התאמה.
5. **רו״ח / הנהלה:** דוח לרו״ח ← ייצוא Excel ← "סימון כהועבר לרו״ח".

חשבונית `7702` של "בשר והבן" מ-03.07 היא כפילות מכוונת — פתח אותה והרץ בדיקות כדי לראות את מנוע הכפילויות בפעולה.

`npm run build` מריץ בדיקת טיפוסים מלאה + בנייה.

## תיעוד נוסף

- `docs/ARCHITECTURE.md` — ארכיטקטורה, מפת מסכים, מטריצת הרשאות, דיאגרמות סטטוסים, ה-workflow המלא.
- `docs/OPEN-DECISIONS.md` — הנחות עסקיות פתוחות שדורשות אישור (לא הומצאו תשובות).
- `docs/MVP-CHECKLIST.md` — צ׳קליסט מול דרישות האפיון.
