# SupplyFlow — ארכיטקטורת אינטגרציה

> אירועי דומיין · transactional outbox · מתאמים ניטרליים לספק · מזהי קורלציה.
> **אין העתקת קוד של Odoo, ERPNext או כל ERP אחר.** מתאמים ומיפויי מזהים חיצוניים בלבד.

---

## 1. מה כבר קיים — לחקות, לא להמציא

| נכס קיים | מה ללמוד ממנו |
|---|---|
| `notifications` (`0017`, ‏`0024`) | **‏outbox עמיד שכבר עובד.** שורת התראה נוצרת ונתבעת באותה עסקה; כשל Push משאיר `push_sent_at` ריק לניסיון חוזר. `notification_event_states` מגדיר מחזור מסירה אחד, הסלמה, ומחזור חדש אחרי פתרון |
| `0028`/`0029` (WhatsApp) | **מרוצי המסירה כבר נפתרו כאן** — snapshot נמען בלתי-משתנה, עיבוד webhook אטומי, claims של תזכורות הניתנים לתביעה מחדש. דפוסי ה-retry וסטטוס המסירה של ה-outbox הגנרי נלקחים מכאן |
| `pg_cron` + `pg_net` → Edge Function | **הדפוס לעובד רקע.** קיים פעמיים: `0016:91` (‏`send-push` יומי) ו-`0028:1034` (תזכורות כל 15 דק׳) |
| `document-processing` Edge Function | **הדפוס לעובד חיצוני.** העובד מחזיק רק `SUPABASE_URL` ו-`OCR_WORKER_TOKEN` — ללא `service_role`, ללא JWT, ללא גישת DB. השוואת טוקן בזמן קבוע, lease fencing, ו-URL חתום מוגבל ל-`min(120s, lease)` |
| פקודות P1 | **אידמפוטנטיות כבר קיימת** — UUID מהלקוח, נעילה בסדר קבוע, השוואת payload קנוני ב-retry |

**מסקנה: ה-outbox הגנרי אינו תשתית חדשה.** הוא Edge Function שלישית + עבודת `pg_cron` שלישית,
בדפוס שכבר הוכח פעמיים בריפו.

---

## 2. אירועי דומיין

טבלאות: `domain_events` · `integration_outbox` · `integration_deliveries` · `external_references` ·
`integration_failures` · `webhook_subscriptions` · `idempotency_keys` · `dead_letter_records`.

**כל אירוע נושא:** מזהה אירוע · סוג · **גרסת סכימה** · `org_id` · מזהי סקופ רלוונטיים · מזהה ישות ·
מזהה שחקן (כשקיים) · **מזהה קורלציה** · **מזהה סיבתיות** · חותמת התרחשות · payload · מטא-דאטה.

**אירועים מגורסים:** `supplier.created` · `supplier.updated` · `product.created` ·
`supplier_price.updated` · `supplier_price_list.submitted` · `purchase_order.created` ·
`purchase_order.approved` · `purchase_order.sent` · `goods_receipt.completed` · `invoice.created` ·
`invoice.review_required` · `invoice.approved` · `credit.created` · `payment_request.created` ·
`payment_request.approved` · `payment.executed` · `bank_transaction.imported` ·
`reconciliation.completed` · `document.uploaded` · `document.processing_completed` ·
`document.processing_failed` · `user.access_changed`.

### 2.1 אטומיות — ההכרעה

**כתיבת האירוע נכנסת לתוך פקודות ה-RPC הקיימות, לא לטריגר.** שלוש סיבות:

1. **‏`p1_financial_command_guard` הוא כבר BEFORE trigger על 18 טבלאות** (`0023:53`) ומותנה ב-GUC
   `app.p1_financial_writer`. הוספת טריגר אירועים שני על אותן טבלאות מכניסה תלות סדר טריגרים לנתיב
   הרגיש ביותר במערכת.
2. **טריגר אינו יודע *למה*.** הפקודות כבר מקבלות `reason` וכותבות אותו ל-`audit_logs`. אירוע דומיין
   ללא כוונה עסקית הוא diff שורה, לא אירוע.
3. **אותה עסקה ממילא.** הפקודות כבר נועלות, מאמתות, כותבות audit ומחזירות — הוספת שורת `domain_events`
   שם היא **אטומית בהגדרה**, בלי מנגנון חדש.

טריגר גנרי נשאר מתאים ל-`audit_logs` (מה השתנה), ולא לאירועי דומיין (מה קרה עסקית). **שתי שכבות, שתי
שאלות.**

## 3. עובד ה-outbox

Edge Function ייעודית, מופעלת ב-`pg_cron` דרך `pg_net`, עם: ניסיונות חוזרים · השהיה מעריכה · מסירה
אידמפוטנטית · רישום כשלים · dead-letter · סטטוס מסירה · מזהי קורלציה · תצפיתיות.

**עסקאות עסקיות אינן נצמדות לשירותים חיצוניים** — הפקודה כותבת ל-outbox ומסתיימת; המסירה היא צעד
נפרד שיכול להיכשל בלי להחזיר את הכסף אחורה.

⚠️ **הוספת Edge Function שוברת את השער בשלושה מקומות מקודדים** — מפת `$functionJwt`
(`check-quality-gates.ps1:630-642`), הקודים `400/401/401` ב-`Wait-LocalEdgeReady` (`:404`), ורשימת
24 הנתיבים ב-`Assert-OcrPrerequisites` (`:599-624`). זה חלק מהמשימה, לא הפתעה.

---

## 4. המתאמים

`src/lib/adapters/` — ממשקים ניטרליים לספק, **ולכל אחד מימוש mock** כדי שהארכיטקטורה נבדקת בלי ספק
חיצוני:

`AccountingAdapter` (‏`syncSupplier`, ‏`postVendorInvoice`, ‏`postCreditNote`, ‏`postPayment`,
`updatePaymentStatus`, ‏`retrieveAccountMapping`, ‏`retrieveSyncStatus`) · `ErpAdapter` · `WmsAdapter`
(סנכרון ספקים, מוצרים, סניפים ומחסנים, הזמנות, קבלות, אירועי מלאי; מזהים חיצוניים; טיפול בקונפליקט;
סטטוס ייבוא/ייצוא) · `IdentityProviderAdapter` · `NotificationProvider` · `SearchProvider` ·
`WorkflowEngine` · `RulesEngine` · `DocumentExtractionProvider` · `FileStorageProvider` ·
`FeatureFlagProvider`.

**‏`external_references`** מחזיקה את המיפוי בין ישות פנימית לישות אצל ספק חיצוני — `(org_id, provider,
entity_type, internal_id, external_id)`. זה הגבול. אין עמודות `odoo_id` על טבלאות עסקיות.

**מסך מצב אינטגרציות** (מפעילים בלבד): ספק · מצב חיבור · סנכרון מוצלח אחרון · רשומות ממתינות ·
רשומות שנכשלו · ניסיון חוזר · בעיות מיפוי · מצב אישורים · מצב webhook · עקבות ביקורת.
**אין מסכי תצורה ספציפיים לספק עד שספק ממומש בפועל.**

---

## 5. מזהה קורלציה

**היום אינו קיים כלל** — לא נוצר, לא נשלח בכותרות, לא מועבר ל-RPC, לא נרשם. `src/lib/supabase.ts`
הוא 10 שורות בלי שום `global.headers`.

**המסלול:** הלקוח מייצר מזהה לכל פעולת משתמש → נשלח כ-header גלובלי → **מועבר גם כארגומנט מפורש
לפקודות ה-RPC** → נכתב ל-`audit_logs` ול-`domain_events` → מועבר ל-Edge Functions ולעובד ה-OCR →
נקשר ל-Sentry.

✅ **הכותרת כן מגיעה ל-Postgres.** ‏PostgREST חושף כל כותרת בקשה דרך
`current_setting('request.headers', true)::json`, קריא בתוך פונקציית `SECURITY DEFINER`. לכן
`emit_domain_event()` יכול לקרוא `->>'x-correlation-id'` **בלי לשנות אף חתימת RPC** — מה שמוזיל
מהותית את הוספת האירועים ל-28 הפקודות. בנוסף `set_config('app.correlation_id', …, true)` כדי
שטריגרים יראו אותו.

⚠️ **שתי מגבלות אמיתיות:**
1. **‏`global.headers` נקבע פעם אחת ב-`createClient`** (`src/lib/supabase.ts:10`), ולכן ערך סטטי אינו
   יכול לשאת מזהה **פר-פעולה**. נדרשת עטיפת `global.fetch` שמזריקה את הכותרת לכל בקשה.
2. **המסלול אינו מכסה** Realtime, חיבורי DB ישירים ו-`pg_cron`→`pg_net`→Edge. עבודה שמקורה ב-cron
   מנפיקה **מזהה שורש** ומשרשרת אליו דרך `causation_id`.

**העמדה הפרטית הקיימת נשמרת ללא שינוי:** `tracesSampleRate: 0`, ללא session replay, ו-`beforeBreadcrumb`
ממשיך למחוק כל breadcrumb של console — כי `toHebrewError` מדפיס הודעת שרת גולמית שעלולה לנקוב בשם ספק
או בסכום (`observability.ts:21-25`).

**לעולם לא נרשם:** סיסמאות · access tokens · refresh tokens · מפתחות `service_role` · אישורי בנק
מלאים · תוכן מסמך רגיש במלואו.

---

## 6. מה לא נפרס, ולמה

| כלי | הכרעה |
|---|---|
| Temporal | לא נפרס. `WorkflowEngine` עם מימוש PostgreSQL+תור; מתאם Temporal עתידי ללא שינוי במודולים העסקיים |
| Novu | לא נפרס. `NotificationProvider` מעל מערכת ההתראות הקיימת |
| Meilisearch | לא נפרס. `SearchProvider` מעל `global_search()` הקיימת (`0011:113`) — pg_trgm + ILIKE, כי לעברית אין מילון PostgreSQL. החלפה רק על סמך מדידה |
| json-rules-engine בדפדפן | **אסור.** מנוע חוקים סמכותי בדפדפן אינו גבול אבטחה. מימוש ראשוני בפונקציות PostgreSQL ורשומות חוק מובנות; אם ירוץ מנוע JS בעתיד — בסביבת שרת מהימנה בלבד, וההכרעה נרשמת |
| read replica | לא מופעל "למראית עין". הפשטת ניתוב בלבד, ותיעוד מפורש אילו שאילתות דורשות read-after-write ונשארות על הראשי |
