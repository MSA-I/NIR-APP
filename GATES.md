# GATES — חיבור שירותים חיצוניים (צד המייל)

ענף: `claude/external-services-integration-7ee6d9` · 31.08.2026

**היקף הענף צומצם בהכרעת בעלים.** ‏Paddle התגלה כמשימה של סוכן מקביל
(`feat/paddle-sandbox-integration-20260831`), והוכרע ששני PR נפרדים עדיפים על תיאום בזמן אמת על
אותם קבצים. הענף הזה מוסר את **המייל בלבד**; ‏`billing-adapter.ts` הוחזר למצבו ב-`main`.

התצורה החיצונית שכן בוצעה כאן (סודות ויעד webhook) נשארת — היא נחוצה לשני הענפים.

## A — אודיט (הושלם)

- [x] A1 — ‏Edge Functions ושמות סודות מה-Management API (ערכים לא הודפסו מעולם)
- [x] A2 — ‏MX/SPF/DKIM/DMARC של `inplace.digital` ו-`app.inplace.digital` מול 8.8.8.8
- [x] A3 — ‏Resend: דומיין `verified`, ‏**אפס** webhooks, שני מפתחות
- [x] A4 — ‏Cloudflare: ‏Email Routing `ready` עם **שני** כללים בלבד
- [x] A5 — ‏Paddle: בתחילת הקמפיין לא היה חשבון; הבעלים פתח sandbox ב-31.08 ומסר מפתחות
- [x] A6 — נמצא: ‏Workspace קיים אך על `app.inplace.digital`, לא על השורש

## B — תצורה חיצונית שבוצעה

- [x] B1 — ‏`ORDERS_FROM_EMAIL` הופרד ל-`InPlace <orders@inplace.digital>` · נקרא חזרה
- [x] B2 — ‏Resend webhook נוצר ומופעל אל `email-webhook`, ארבעה אירועי מסירה · נקרא חזרה
- [x] B3 — ‏`RESEND_WEBHOOK_SECRET` הותקן · **נמדד:** הנקודה עברה מ-`500 misconfigured` ל-`403`
      על חתימה חסרה, כלומר אימות אמיתי
- [x] B4 — יעד התראות ב-Paddle (`ntfset_01m1c484…`) אל `billing-webhook` בייצור, 11 אירועים
- [x] B5 — ‏`PADDLE_WEBHOOK_SECRET` · `PADDLE_API_KEY` · `PADDLE_ENVIRONMENT=sandbox` ·
      ‏`BILLING_PROVIDER=paddle` · **נמדד:** `billing-webhook` עבר מ-`503` ל-`403`
- [x] B6 — הוכחת מסירה חיה: מייל אחד יצא ו-Resend החזיר `delivered`, עם ה-`Reply-To` נשמר
- [ ] B7 — `BLOCKED:` ארבעת כללי הניתוב (`support@` וחבריו) — ה-harness חסם. ‏`§86`

## C — קוד (מייל בלבד)

- [x] C1 — ‏Reply-To: מייל מוצר → `support@`; הזמנה לספק → הדייר
- [x] C2 — הכתובת נפתרת מזהות מאומתת בשרת, מאומתת מול header injection, ‏fallback מתועד (`#309`)
- [x] C3 — משטח תמיכה במוצר (`/settings`, `/settings/subscription`)
- [x] C4 — מייל הפעלת מנוי אידמפוטנטי (`0268` + `billing-webhook`)
- [x] C5 — בדיקות לכל אחד מהסעיפים
- [~] **הוסר מהענף:** פעולות Paddle החיות ב-`billing-adapter.ts` ובדיקותיהן. הן קיימות בענף
      המקביל, ביחד עם מיפוי המחירים ו-`billing-checkout`.

## D — שערים

- [x] D1 — `npm run typecheck` — נקי
- [x] D2 — חוזי Deno בקונפיג של השער ובנעילה קפואה — **182 עברו / 0 נכשלו**
- [x] D3 — ‏`p94` מול Postgres מקומי — **שבעה מקרים**; עבר גם ב-CI
- [x] D4 — ‏CI על ‏PR #180: ‏`build`, ‏`verify`, ‏`Deno contracts` עברו
- [x] D5 — השוואה מול הבסיס (‏`§85`): כשלי SQL והדפדפן **זהים** לאלה של `main`
- [ ] D6 — `BLOCKED:` ‏`npm run quality` המלא לא רץ מקומית (בלעדיות על stack משותף); רץ ב-CI

## E — חסום מחוץ לקוד

- **Workspace** — קונסולת אדמין = סיסמה, ואסור לי; והדומיין הרשום הוא `app.inplace.digital`.
  ‏`§88` · `#310`
- **‏`support@` אינה מקבלת דואר** — והמוצר כבר מפרסם אותה. ‏`§86`
- **‏Paddle live** — ‏sandbox פעיל, אבל KYC, payout ישראלי וקטלוג ILS לא הוכחו. ‏`#213` נשאר.
- **פריסת Edge** — לא נפרסה מהענף הזה: זרימת העבודה היא PR → main → פריסה
