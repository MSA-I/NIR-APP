# INTEGRATIONS-SETUP — הקמה, סודות ותפעול של משטחי האינטגרציה

עודכן: 22.08.2026. המסמך הזה הוא מקום ההקמה היחיד לכל משטח אינטגרציה חיצוני: אילו משתני סביבה
נדרשים, איך מסובבים סוד, איך מנתקים ספק בלי לשבור עבודה ידנית, ומה עדיין חסר כדי לחבר ספק אמיתי.
עקרונות-העל: סודות רק ב-`supabase secrets` / ‏Vault, לעולם לא בריפו; אין fake-success כשתצורה
חסרה — משטח לא מוגדר עונה `misconfigured`/נופל-סגור.

## 1. פורטל ספק (0167) — ממומש, מוזג וחי

**מצב:** PR #86 מוזג ונפרס. Production ledger הגיע ל־`0167`; ‏Edge ‏`supplier-portal` פעיל,
Pages מגיש את entry הפורטל, ו־live E2E מלא הוכיח issue→redeem→submit→review→revision. הפרטים
וה־SHA נמצאים ב־`PROGRESS.md`. ההוראות להלן הן חוזה תחזוקה/שחזור, לא רשימת פעולות שטרם בוצעו.

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

## 2. מייל יוצא — Resend; ‏B1 ממומש ומוזג, לא נפרס

**מצב קוד ומיזוג:** ‏PR #87 ו־`0168` מוזגו. ‏`email-sender` (`verify_jwt=true`) כולל preferences
fail-closed, claim/lease, חמש ניסיונות, קפיאת `unknown`, תבניות he/en ויישוב provider-accepted.
זהו `IMPLEMENTED / MERGED / NOT_DEPLOYED`: Production ledger נשאר ב־`0167`, ורק
`supplier-portal` מבין משטחי ה־Edge החדשים הוכח פעיל. accepted אינו delivered.

| משתנה | תפקיד ומצב |
|---|---|
| `RESEND_API_KEY` | משמש את `send-invite`; עצם קיומו אינו הוכחת דומיין, SMTP או מסירה חיצונית |
| `INVITE_FROM_EMAIL` | זהות שולח להזמנות עובד; היעד המוכרע הוא `no-reply@inplace.digital` |
| `ORDERS_FROM_EMAIL` | זהות שולח להזמנות ספק; היעד המוכרע הוא אותה כתובת. טרם הוכח כמוגדר |
| `APP_BASE_URL` | בסיס לקישורי הפורטל בגוף המייל |
| `ALLOWED_ORIGINS` | allowlist ל־CORS |
| `RESEND_WEBHOOK_SECRET` | סוד Svix לאירועי delivered/bounced; טרם הוכח כמוגדר |

**מה חסר להפעלה:** ‏`inplace.digital` נבחר אך לא נרכש ולא אומת. נדרשים רכישה, SPF/DKIM/DMARC,
אימות Resend, הגדרת השולחים, SMTP Auth ל־Supabase, החלת `0168`, פריסת `email-sender` ו־smoke
חיצוני. בלי תצורה הפונקציה עונה `misconfigured`; העבודה הידנית והפורטל נשארים זמינים.

**Webhook bounce הוא שלב עתידי נפרד:** ‏`email-webhook` אינו קיים. #238 קובע ש־bounce מאוחר
אינו מחזיר את lifecycle ההזמנה אחורה: ההזמנה נשארת `sent`, מצב ערוץ המייל הופך
`delivery_failed`, ו־retry מנפיק קישור חדש ומבטל את הקודם. אין לטעון delivered לפני webhook
חתום, de-dup ו־smoke חי.

## 3. ‏WhatsApp — Twilio נבחר; אינטגרציה עדיין לא קיימת

שכבת המסד קיימת ורדומה: ‏`whatsapp_connections`, ‏`whatsapp_order_messages`,
‏`process_whatsapp_webhook_event` ו־cron תזכורות. הבעלים בחר Twilio, וכל ארגון יחבר מספר/WABA
משלו; אין מספר InPlace מרכזי. ההשקה המתוכננת היא outbound בלבד עם מעקב
delivery/read/failed. inbound text/media אינם נקלטים או מתויקים.

| חוזה שנדרש לאמת | יעד Twilio המתוכנן |
|---|---|
| API ושליחה | חוזה Messages API חי וממוסמך; אין URL מומצא בקוד |
| אישור גישה | credentials פר־ארגון ב־Vault; לעולם לא בדפדפן או בריפו |
| מזהה שולח | מספר WhatsApp/WABA של הארגון, עם scope ו־revocation פר־דייר |
| חתימת webhook | אימות חתימת Twilio לפי החוזה החי לפני כל שינוי סטטוס |
| אירועי סטטוס | מיפוי אל `queued→accepted→sent→delivered→read/failed` עם de-dup |
| inbound | נדחה/נזנח במפורש; אסור להציג כאילו טופל |

עד חיבור חשבון, credentials, חוזה API ו־sandbox proof, ‏`wa.me` + תמונה נשאר המסלול הפעיל וכל
provider חדש חייב להיכשל סגור עם `misconfigured`. ‏DEBT §61 מתעד את יישור שער `sent` מול B1.

## 4. חיוב ומסמכי מס — Paddle ראשי; Stripe + Morning הם fallback בלבד

Paddle נבחר כ־Merchant of Record ראשי. Stripe direct יופעל רק אם Paddle אינו יכול לשרת את ישראל,
ובמקרה זה Morning / חשבונית ירוקה נבחרה למסמכי מס, קבלות וזיכויים בישראל — לא לסליקה.
‏`AccountingAdapter` ‏(7 מתודות), ‏`external_references`, ‏outbox ו־mocks קיימים, אך אין חיבור
Morning או חיוב Paddle/Stripe פעיל. לפני הפעלה נדרשים חשבונות מאומתים, חוזי API חיים, sandbox,
מספור/ביטול/זיכוי, webhooks חתומים ו־reconciliation. מצב:
`SELECTED / ACCOUNT_NOT_PROVEN / NOT_CONFIGURED / NOT_INTEGRATED / NOT_LIVE`.

## 5. דומיין ו־origins — נבחרו; טרם נרכשו או הוגדרו

- אתר שיווקי: `https://inplace.digital`
- אפליקציה: `https://app.inplace.digital`
- מפעיל: `https://app.inplace.digital/operator`
- `https://www.inplace.digital` מפנה קנונית ל־`https://inplace.digital`

האפליקציה והמפעיל חולקים origin/session, אך הרשאת המפעיל נשארת שרתית. מצב:
`SELECTED / NOT_PURCHASED / DNS_NOT_CONFIGURED / AUTH_ALLOWLIST_NOT_CONFIGURED / NOT_DEPLOYED`.
לפני טענת זמינות נדרשים רכישה, DNS, redirect, ‏Cloudflare Pages custom domains, ‏Supabase Auth
redirect allowlist, התאמת origins וסשן, ואז smoke אנונימי ומחובר.
