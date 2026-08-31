# GATES — חיבור שירותים חיצוניים (email + billing)

ענף: `claude/external-services-integration-7ee6d9` · 31.08.2026

כל שער כאן נמדד. „קיים" אינו „עובד". שער שלא נסגר מופיע עם `BLOCKED:` והסיבה המדויקת.

## A — אודיט (הושלם)

- [x] A1 — ‏Edge Functions ושמות סודות מה-Management API (ערכים לא הודפסו מעולם)
- [x] A2 — ‏MX/SPF/DKIM/DMARC של `inplace.digital` ו-`app.inplace.digital` מול 8.8.8.8
- [x] A3 — ‏Resend: דומיין `verified`, ‏**אפס** webhooks, שני מפתחות
- [x] A4 — ‏Cloudflare: ‏Email Routing `ready` עם **שני** כללים בלבד
- [x] A5 — ‏Paddle: **אין חשבון** — אין מפתח, ואין ולו מייל אחד מ-Paddle בתיבה
- [x] A6 — ריפו: ‏billing-adapter · billing-webhook · email-sender · email-webhook · `0157`/`0187`/`0188`/`0190` · ‏DEBT §25/§57 · ‏#213
- [x] A7 — נמצא: ‏Workspace קיים אך על `app.inplace.digital`, לא על השורש

## B — תצורה חיצונית

- [x] B1 — ‏`ORDERS_FROM_EMAIL` הופרד ל-`InPlace <orders@inplace.digital>` · נקרא חזרה מה-API
- [x] B2 — ‏Resend webhook נוצר ומופעל אל `email-webhook` עם ארבעת אירועי המסירה · נקרא חזרה
- [ ] B3 — `BLOCKED:` ‏`RESEND_WEBHOOK_SECRET` — ה-harness חסם קריאת סוד חתימה וכתיבתו. ‏`§87`
- [ ] B4 — `BLOCKED:` ארבעת כללי הניתוב (`support@`/`billing@`/`security@`/`hello@`) — ה-harness חסם יצירת כלל העברת דואר, כפי שחסם ב-24.08. ‏`§86`
- [ ] B5 — `BLOCKED:` הוכחת מסירה חיה — תלויה ב-B3

## C — קוד

- [x] C1 — ‏Reply-To בשכבת השליחה: מייל מוצר → `support@`; הזמנה לספק → הדייר
- [x] C2 — הכתובת נפתרת מזהות מאומתת בצד שרת, מאומתת מול header injection, ‏fallback מתועד (`#309`)
- [x] C3 — משטח תמיכה במוצר (`/settings`, `/settings/subscription`)
- [x] C4 — מתאם Paddle: ארבע פעולות חיות מול החוזה המפורסם, נשארות fail-closed בלי מפתח
- [x] C5 — מייל הפעלת מנוי אידמפוטנטי (`0268` + `billing-webhook`)
- [x] C6 — בדיקות לכל אחד מהסעיפים

## D — שערים שהורצו

- [x] D1 — `npm run typecheck` — נקי
- [x] D2 — `npm run verify` — נקי
- [x] D3 — חוזי Deno בקונפיג של השער ובנעילה קפואה — **198 עברו / 0 נכשלו**
- [x] D4 — ‏`p94` מול Postgres מקומי — **שבעה מקרים עברו**
- [x] D5 — ‏`ci-sql-suites.mjs --list` רואה את `p94`
- [x] D6 — השער המלא רץ ב-CI על ‏PR #180: ‏`build`, ‏`verify` ו-`Deno contracts` עברו;
      ‏`p94 passed: seven cases` בתוך ריצת ה-SQL
- [x] D7 — השוואה מול הבסיס (‏`§85`): שני כשלי ה-SQL ושלושת כשלי הדפדפן **זהים** לאלה של `main`;
      הדיף הזה אינו מוסיף אף כשל

## E — חסום מחוץ לקוד

- **Workspace** — קונסולת אדמין = סיסמה, ואסור לי. בנוסף הדומיין שנרשם הוא `app.inplace.digital`. ‏`§88` · `#310`
- **Paddle** — אין חשבון; יצירת חשבון ו-KYC אסורים לי. ‏`#213` נשאר במלואו. ‏`§57`
- **פריסת Edge** — לא נפרסה מהענף הזה בכוונה: זרימת העבודה היא PR → main → פריסה
