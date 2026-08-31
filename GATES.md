# GATES — חיבור שירותים חיצוניים (email + billing)

ענף: `claude/external-services-integration-7ee6d9` · נפתח 31.08.2026

כל שער כאן נמדד או מסומן `ABANDON:` עם סיבה. „קיים" אינו „עובד".

## A — אודיט (הושלם 31.08.2026)

- [x] A1 — Edge Functions חיים ושמות סודות נקראו מה-Management API (ערכים לא הודפסו)
- [x] A2 — ‏DNS: ‏MX/SPF/DKIM/DMARC של `inplace.digital` ו-`app.inplace.digital` נפתרו מול 8.8.8.8
- [x] A3 — ‏Resend: דומיין, webhooks, מפתחות נקראו דרך ה-API
- [x] A4 — ‏Cloudflare: זון, ‏Email Routing, כללים ויעדים נקראו דרך ה-API
- [x] A5 — ‏Paddle: נבדק קיום חשבון (קובץ מפתח + תיבת דואר) — **אינו קיים**
- [x] A6 — ריפו: ‏billing-adapter, ‏billing-webhook, ‏email-sender, ‏email-webhook, ‏0157/0187/0188/0190, ‏DEBT §25/§57, ‏#213

## B — תצורה חיצונית שבוצעה

- [ ] B1 — ‏Cloudflare Email Routing: ‏`support@`, ‏`billing@`, ‏`security@`, ‏`hello@` נוצרו ומאומתים בקריאה חוזרת
- [ ] B2 — ‏Resend webhook ל-`email-webhook` נוצר; ‏`RESEND_WEBHOOK_SECRET` הוגדר ב-Supabase
- [ ] B3 — ‏`ORDERS_FROM_EMAIL` הופרד ל-`orders@inplace.digital`
- [ ] B4 — הוכחת מסירה חיה: מייל נשלח, אירוע `delivered` נקלט ב-webhook

## C — קוד

- [ ] C1 — ‏Reply-To בשכבת השליחה: מיילי מוצר → `support@`; מייל הזמנה לספק → איש קשר הדייר
- [ ] C2 — כתובת התשובה של הדייר נפתרת בשרת בלבד ומאומתת; fallback מתועד
- [ ] C3 — משטח תמיכה במוצר (הודעות „פנה לתמיכה" מקבלות כתובת)
- [ ] C4 — מתאם Paddle: פעולות חיות מול החוזה המפורסם, נשארות fail-closed בלי חשבון
- [ ] C5 — מייל הפעלת מנוי אידמפוטנטי (‏Resend, ‏no-reply, ‏Reply-To support)
- [ ] C6 — בדיקות לכל אחד מהסעיפים לעיל

## D — שערים

- [ ] D1 — `npm run build`
- [ ] D2 — `npm run verify`
- [ ] D3 — בדיקות Deno של ה-Edge שנגעתי בהן
- [ ] D4 — ‏PR ל-main עם ראיות

## E — חסום (לא ננטש — אין לי דרך לבצע)

- ‏**Workspace**: קונסולת האדמין דורשת כניסה עם סיסמה; אסור לי. בנוסף הדומיין שנרשם הוא
  `app.inplace.digital` ולא `inplace.digital`, והעברת הדואר הנכנס לגוגל דורשת החלפת MX בשורש —
  הכרעת בעלים, לא ניקיון.
- ‏**Paddle**: אין חשבון. יצירת חשבון ו-KYC אסורים לי מפורשות. כל שערי #213 נשארים לא מוכחים.
