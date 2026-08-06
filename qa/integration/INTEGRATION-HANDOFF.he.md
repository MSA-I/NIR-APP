# מסירת אינטגרציית QA על קו Enterprise

תאריך: 06.08.2026

## מצב Git

- ענף: `codex/qa-enterprise-integration-20260806`.
- בסיס Enterprise מקומי עדכני: `main` ב-`eaab58235ec6b18a59233959850c1e0fc8c9784e`.
- `origin/main` עדיין ב-`01ca87cf6a88163b61a040d33a54f46527ec0e68`; ‏`main` המקומי מקדים אותו ב-88 commits.
- תשתית ה-QA ושני התיקונים הקטנים הועברו ב-19 commits אטומיים; עדכון הסגירה של Wave 9 מוזג ללא שכתוב היסטוריה.
- תיקון חריגת הזיכוי משולב ב-`e916dec`; snapshot הדוח החודשי משולב ב-`20c2edd`.
- לא הורצו בסשן האינטגרציה build, tests, SQL/RLS, Playwright, `quality` או `qa:full`.

## מה משולב

1. תשתית QA רב-סוכנית, שמירת ראיות, redaction, mutex ו-cleanup.
2. הקשר הזמנה/קבלה מאומת במסך יצירת חשבונית ותיקון הטקסט `העברה בוצעה`.
3. Job Object ב-Windows: יצירת child מושהה, שיוך לפני resume, ‏`KILL_ON_JOB_CLOSE`, וחזרה רק לאחר `JOB_EMPTY`; כשל הוכחה משאיר containment hold.
4. `0073_payment_credit_override.sql`: שיוך דרישת תשלום לישות משפטית, חישוב זיכויים פתוחים מסוקף, override מפורש עם סיבה, audit ו-replay idempotent, ללא קיזוז או שינוי סכומים.
5. `0074_monthly_report_snapshots.sql`: גרסאות snapshot בלתי-משתנות לפי ארגון/ישות/חודש, RLS, נעילת allocation של גרסה, audit/event וייצוא XLSX מנתוני snapshot שמורים בלבד.

## migrations

| טווח | מצב |
|---|---|
| `0053`–`0070` | קיימות ב-`main` המקומי. |
| `0071`–`0072` | מוקצות אך לא נוצלו במכוון ב-Wave 9. |
| `0073` | משולבת בענף זה; בדיקת runtime טרם בוצעה. |
| `0074` | משולבת בענף זה; בדיקת runtime טרם בוצעה. |

המספור תואם ל-`02-MIGRATION-ALLOCATION.md`: ‏`0073`–`0074` רשאיות לבוא אחרי `0070`; אין migrations ריקות ואין שינוי של היסטוריה שכבר הוחלה.

## הכרעות scope

- snapshot סופי לרו״ח הוא פר-`legal_entity`; ‏`org_id` נשאר גבול הדייר.
- `credit_requests` נשארת ישות scope נגזרת ואינה מקבלת `unit_id`.
- זיכוי פתוח נגזר מחשבונית או מקבלה→מחסן→ישות משפטית; ייחוס חסר או דו-משמעי נכשל סגור.
- override דורש סיבה כתובה ונרשם בשרת; הוא אינו מקזז, סוגר או מקצה זיכוי ואינו משנה את סכום הדרישה.

ההכרעות מתועדות ב-`docs/OPEN-DECISIONS.md` ‏#106–#107.

## ראיות קיימות בלבד

- ראיות ה-QA וה-triage ההיסטוריות נשמרו תחת `qa/triage` ובתיקיית הריצה המקורית; הן מתייחסות לקומיטים הישנים שעליהם נוצרו.
- Wave 9 תועד ב-`docs/PROGRESS.md` כ-PASS היסטורי לריצה `20260806-092150`: ‏42/42 preflight, ‏25/25 תרחישי דפדפן ו-build עם 232 בדיקות.
- ל-Job Object ול-`0073`–`0074` קיימות סקירות ו/או בדיקות שנוספו, אך הן לא הורצו מול ענף האינטגרציה הזה.
- לכן הראיות ההיסטוריות אינן מוכיחות שהשילוב מול `main` הנוכחי עבר.

## שער עתידי

`scripts/check-quality-gates.ps1` מחבר את בדיקות SQL של `0073`, ‏`0074` ואת בדיקת ה-concurrency של snapshots. בסשן בדיקות נפרד יש להריץ, לפי הסדר המוסכם:

1. `npm.cmd ci`
2. `npm.cmd run build`
3. `npm.cmd run qa:typecheck`
4. `npm.cmd run qa:test`
5. `npm.cmd run quality`
6. `npm.cmd run qa:full`

אין להריץ `quality` ו-`qa:full` במקביל.

## Gate

`READY_WITH_MANUAL_CHECKS`

הקוד משולב סטטית וללא conflicts, אך אין validation עדכני ל-`0073`–`0074` או לשילוב המלא. בנוסף, PR אל `origin/main` יכלול גם את 88 קומיטי ה-Enterprise שעדיין אינם ב-remote. לכן לא בוצעו push, פתיחת PR, merge או סגירת Issues.
