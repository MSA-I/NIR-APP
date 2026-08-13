# SupplyFlow — רכש, חשבוניות ותשלומים

SupplyFlow היא מערכת Procurement-to-Payment רב־דיירית בעברית וב־RTL. הזרימה הפעילה היא:
ספקים ומחירונים → הזמנות רכש → קבלת סחורה → חשבוניות וזיכויים → דרישות תשלום → ביצוע
תשלום → התאמות בנק → דוחות.

חשבונות המוצר הפעילים הם `owner`, ‏`office` ו־`accountant` בלבד. הערכים `kitchen`, ‏`payer`
ו־`supplier` נשמרים ב־DB לצורכי היסטוריה ו־audit, אך אינם ניתנים להזמנה, הפעלה או כניסה.
המונח `supplier` ממשיך לשמש לישות העסקית ספק.

## סביבת פיתוח

ה־stack הוא React 19, TypeScript strict, Vite 6, React Router 8, Tailwind CSS v4 ו־Supabase
(PostgreSQL, Auth, RLS ו־Storage).

```powershell
npm.cmd ci
npm.cmd run dev     # http://localhost:5199
```

המשתנים הנדרשים מתועדים ב־`.env.example`:

```text
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
```

אין לשמור סודות בריפו. נתיבי credentials מקומיים וחיים מתועדים ב־
`docs/LOCAL-CREDENTIALS-PATH.md`; קוראים אותם רק בזמן ריצה ולעולם לא מדפיסים אותם.

## חשבונות דמו

`scripts/create-users.ps1` יוצר רק את שלושת התפקידים הפעילים מתוך manifest חיצוני בעל סיסמאות
ייחודיות. הסקריפט אינו כולל ברירת מחדל ואינו מדפיס סיסמאות.

| תפקיד | מסך בית | אחריות עיקרית |
|---|---|---|
| `owner` | `/dashboard` | ניהול, אישורים, רכש ובקרה |
| `office` | `/dashboard` | רכש, קבלה, מסמכים ומחירונים |
| `accountant` | `/dashboard` | קריאה פיננסית, `/pay`, ביצוע תשלום והעלאת אסמכתה |

`supabase/seed.sql` יוצר seed ניטרלי לדייר חדש. `supabase/demo/` היא חבילת דמו נפרדת ואינה
חלק מהתקנת לקוח.

## מסד נתונים ומיגרציות

המיגרציות ב־`supabase/migrations/` הן forward-only. אין לערוך או למחוק מיגרציה היסטורית.
המיגרציה `0133_remove_retired_persona_surfaces.sql` מסירה APIs ופוליסות של פרסונות ההתחברות
שפרשו, מצרה את המשטח הפעיל לשלושת התפקידים ושומרת enum values, פרופילים לא־פעילים, קשרי ספק
היסטוריים ו־audit.

הכנסת `0133` לריפו אינה הוכחת rollout. לפני החלה בסביבה מרוחקת נדרשים גיבוי, אימות ledger,
dry-run, החלה מבוקרת ו־postflight לפי תהליך השחרור. העבודה הזו אינה מריצה Supabase Production
ואינה פורסת Cloudflare Pages.

## שערים

```powershell
npm.cmd run check:dead-code
npm.cmd run build
```

`npm run build` מריץ TypeScript, שנים־עשר סקריפטי `check:*`, ‏Vitest ו־Vite. ‏Knip מוגדר דרך
`knip.json` עם entrypoints מפורשים ל־SPA, בדיקות, סקריפטי שער ו־Edge Functions.

`npm run quality` אינו רץ מקומית במכונה זו. השער הכבד מופעל ב־GitHub Actions על PR או באמצעות:

```powershell
gh workflow run quality-gate.yml
gh run watch
```

PASS תקף רק ל־SHA המדויק שעליו רצו build, חוזי Deno/OCR, סוויטות SQL ו־browser/RTL/accessibility.

## תיעוד קנוני

- `CLAUDE.md` — חוקת הריפו, שערים וספירות.
- `PRODUCT.md` ו־`DESIGN.md` — חוזה המוצר והשפה הוויזואלית.
- `docs/PROGRESS.md` — המצב הנוכחי והצעד הבא בלבד.
- `docs/DEBT-REGISTER.md` — חוב פתוח ומגבלות ידועות.
- `docs/ARCHITECTURE.md` ו־`docs/ENTERPRISE-SECURITY-MODEL.md` — מודל נתונים, הרשאות וגבולות אמון.
- `docs/INTEGRATION-ARCHITECTURE.md` ו־`docs/OFFLINE-SYNC-DESIGN.md` — אינטגרציות ו־offline.
- `docs/OPEN-DECISIONS.md` — הכרעות פעילות וברירות מחדל עסקיות.
- `docs/adr/` — החלטות ארכיטקטורה.

מסמכי קמפיינים, handoffs, תכניות וצילומי golden שהושלמו אינם נשמרים בתיקיית העבודה. Git history
הוא הארכיון שלהם.
