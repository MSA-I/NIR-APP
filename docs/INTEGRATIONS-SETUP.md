# INTEGRATIONS-SETUP — הקמה, סודות ותפעול של משטחי האינטגרציה

עודכן: 20.08.2026. המסמך הזה הוא מקום ההקמה היחיד לכל משטח אינטגרציה חיצוני: אילו משתני סביבה
נדרשים, איך מסובבים סוד, איך מנתקים ספק בלי לשבור עבודה ידנית, ומה עדיין חסר כדי לחבר ספק אמיתי.
עקרונות-העל: סודות רק ב-`supabase secrets` / ‏Vault, לעולם לא בריפו; אין fake-success כשתצורה
חסרה — משטח לא מוגדר עונה `misconfigured`/נופל-סגור.

## 1. פורטל ספק (0167) — מועמד לפריסה; טרם חי

**Edge Function:** ‏`supplier-portal` ‏(`verify_jwt=false`; ‏POST בלבד).

| משתנה | תפקיד |
|---|---|
| `ALLOWED_ORIGINS` | ‏allowlist ל-CORS, מופרד בפסיקים; ברירת מחדל `APP_BASE_URL`. חייב לכלול את origin הייצור, ול-dev את `http://localhost:5199` |
| `APP_BASE_URL` | ‏fallback ל-allowlist; אותו ערך שכבר משמש את `send-invite` |
| `SUPPLIER_PORTAL_RATE_LIMIT_PEPPER` | סוד אקראי שרתי, 32 תווים לפחות. משמש HMAC חד-כיווני לכתובת הלקוח לפני מונה קצב מתמיד; אסור `VITE_` ואסור לוג |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | מוזרקים על ידי הפלטפורמה |

**פריסה:** ליצור pepper במנהל סודות (`supabase secrets set SUPPLIER_PORTAL_RATE_LIMIT_PEPPER=...`),
ואז ‏`supabase functions deploy supplier-portal --no-verify-jwt` אחרי החלת `0167` (הפונקציה קוראת
RPCs שהמיגרציה יוצרת — סדר: מסד ואז סוד ואז Edge ואז frontend). בלי pepper או בלי כתובת שה-gateway
סיפק, הדלת מסרבת; אין fallback למונה בזיכרון.

**סיבוב pepper:** זהות המונה נגזרת מהסוד, ולכן סיבוב מאפס בפועל את חלון הקצב לכל כתובת. מסובבים רק
באירוע אבטחה או rollout מתוכנן, מעלים את הסוד ואת Edge באותו חלון, ומתעדים שהשורות הישנות נשארות
אטומות ונמחקות על ידי `supplyflow-supplier-portal-rate-prune` אחרי 30 יום.

**‏smoke לפריסת frontend:** ‏`/portal` חייב שורה בבדיקת הנתיבים של סקריפט הפריסה (הלקח של
`/operator`, ‏19.08.2026): ‏GET ‏`/portal` מגיש את ‏`assets/portal-*.js` ואינו את קליפת הדייר;
‏`/portal.html` עונה 308 אל `/portal` — זו התנהגות Pages תקינה; **אסור** להוסיף לו כלל
`_redirects`.

**סיבוב/ביטול קישורים:** אין סוד גלובלי לסובב — כל קישור הוא סוד עצמאי. ביטול קישור בודד: כפתור
"ביטול הקישור" במסך ההזמנה (או `revoke_supplier_order_link`). ביטול גורף לארגון:
`update supplier_order_links set revoked_at = now(), revoked_by = null, revoked_reason = 'bulk revoke' where org_id = :org and revoked_at is null;`
‏(דרך פקודת SQL מנומקת של המפעיל; אין ממשק לכך בכוונה).

**לוקאל:** ‏`?lang=en` פותח אנגלית/LTR, ‏`?lang=he` עברית/RTL; בלי פרמטר נבחרת שפת הדפדפן עם
fallback לעברית, ובדף יש מתג שפה. הטוקן נשאר ב-fragment ואינו עובר לפרמטר query.

**תצפית:** מוני IP אטומים נמצאים ב-`private.supplier_portal_rate_limits` (‏30 בקשות בדקה,
חסימה לעשר דקות; אין IP קריא); כשלי lookup ב-`private.supplier_portal_lookup_failures`;
נעילות קישור ב-`supplier_order_links.locked_until`. משטח קריאה מורשה יתווסף בפאזת התצפיות.

## 2. מייל יוצא — Resend (send-invite פעיל; שליחת הזמנות בפאזה הבאה)

קיים היום: ‏`send-invite` שולח דרך `https://api.resend.com/emails` עם `RESEND_API_KEY`,
‏`INVITE_FROM_EMAIL`, ‏idempotency ו-egress lease. **חסם תפעולי מתועד (DEBT §25):** בלי דומיין
מאומת ב-Resend המסירה מוגבלת לכתובת בעל החשבון. אימות הדומיין הוא פעולת בעלים בלוח של Resend
(‏DNS: ‏SPF+DKIM) ואינו כרוך בקוד.

שדות שיידרשו לחיבור שליחת ההזמנות (פאזה B): זהות שולח פר-מוצר (`ORDERS_FROM_EMAIL`), סוד חתימת
‏webhook של Resend ‏(`RESEND_WEBHOOK_SECRET`, חתימות בפורמט svix), ו-URL ה-webhook שירשם אצל
הספק אל פונקציית `email-webhook` (טרם קיימת).

## 3. ‏WhatsApp — תשתית DB קיימת (0028/0029), ספק לא מחובר

שכבת המסד המלאה קיימת ורדומה: ‏`whatsapp_connections` ‏(טוקן ב-Vault), ‏`whatsapp_order_messages`
‏(סולם סטטוסים מלא), ‏`process_whatsapp_webhook_event`, ‏cron תזכורות. **אין בריפו חוזה API של
ספק WhatsApp** — לא הומצא. כדי לחבר ספק אמיתי נדרש מהבעלים, לכל ספק שייבחר:

| שדה חסר | דוגמה (Meta Cloud API) / (ספק אחר) |
|---|---|
| ‏API base URL | ‏`https://graph.facebook.com/v21.0` / כתובת הספק |
| אישור גישה | ‏permanent access token / ‏api key |
| מזהה שולח | ‏`phone_number_id` + ‏`waba_id` / ‏instance id |
| סוד חתימת webhook | ‏app secret ‏(X-Hub-Signature-256) / סוד HMAC של הספק |
| פורמט אירועי סטטוס | מיפוי אל `queued→accepted→sent→delivered→read/failed` |
| פורמט מדיה נכנסת | איך מורידים קובץ שהספק קיבל |
| שמות תבניות מאושרות | ‏template names + locales |

עד אז: זרימת השיתוף הידני (wa.me + תמונה) נשארת המסלול הראשי, וכל קוד provider חדש חייב להיכשל
סגור עם `misconfigured` כשהשדות האלה ריקים.

## 4. חיבור הנהלת חשבונות — boundary קיים, ספק לא הוכרע

‏`AccountingAdapter` ‏(7 מתודות), ‏`external_references`, ‏outbox ו-mocks קיימים. **אין הכרעת ספק**
‏(OPEN-DECISIONS — החלטה פתוחה). אין לממש חיבור עד שהבעלים בוחר ספק ומספק חוזה API.
