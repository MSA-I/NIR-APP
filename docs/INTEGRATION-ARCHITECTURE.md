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

טבלאות, משויכות לסעיף שמגדיר אותן (תיקון ציטוט גל 7 — הרשימה כאן שימשה בעבר כאילו כולן
"טבלאות אירועים" של הסעיף הזה, וטבלאות ה-outbox של §3 וטבלאות המתאמים של §4 צוטטו זו כזו):

| מישור | טבלאות | היכן |
|---|---|---|
| אירועים (סעיף זה) | `domain_events` | ‏`0063`, ‏public |
| ‏outbox (‏§3) | `integration_outbox` · `integration_deliveries` · `idempotency_keys` · `dead_letter_records` | ‏`0064`, ‏**private** |
| מתאמים (‏§4) | `external_references` · `webhook_subscriptions` · `integration_failures` | ‏`0066`, ‏public |

**כל אירוע נושא:** מזהה אירוע · סוג · **גרסת סכימה** · `org_id` · מזהי סקופ רלוונטיים · מזהה ישות ·
מזהה שחקן (כשקיים) · **מזהה קורלציה** · **מזהה סיבתיות** · חותמת התרחשות · payload · מטא-דאטה.

**אירועים מגורסים:** `supplier.created` · `supplier.updated` · `product.created` ·
`supplier_price.updated` · `supplier_price_list.submitted` · `purchase_order.created` ·
`purchase_order.approved` · `purchase_order.sent` · `goods_receipt.completed` · `invoice.created` ·
`invoice.review_required` · `invoice.approved` · `credit.created` · `payment_request.created` ·
`payment_request.approved` · `payment.executed` · `bank_transaction.imported` ·
`reconciliation.completed` · `document.uploaded` · `document.processing_completed` ·
`document.processing_failed` · `user.access_changed` · `month_export.sent` ·
`supplier.bank_details_changed` (שני האחרונים — הרחבת גל 5 מטבלת הגזירה; המיפוי המלא
‏action→event נזרע ב-`private.domain_event_map`, ‏`0063`, והכרעות שמות ללא מקבילה חיה מדויקת
מתועדות ב-OPEN-DECISIONS ‏#94).

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

> **מומש בגל 5 (‏ADR-0009, מיגרציה `0063`):** הכלל קדימה בעינו — פקודה חדשה פולטת inline.
> ה-**retrofit** ל-71 הפקודות הקיימות מומש כ-fan-out מ-`audit_logs` דרך
> ‏`private.domain_event_map` (allowlist; ‏action לא ממופה ⇒ אפס אירועים), משום ששמונה גופי
> פקודה חיים קיימים רק ב-pg_proc (הזרקות `0031`/`0061`) ואסור לגעת בהם. שורת ה-audit נושאת
> את הכוונה — ולכן הטריגר על audit_logs אינו "טריגר על טבלה עסקית" שסעיף זה פוסל.

## 3. עובד ה-outbox

Edge Function ייעודית, מופעלת ב-`pg_cron` דרך `pg_net`, עם: ניסיונות חוזרים · השהיה מעריכה · מסירה
אידמפוטנטית · רישום כשלים · dead-letter · סטטוס מסירה · מזהי קורלציה · תצפיתיות.

**עסקאות עסקיות אינן נצמדות לשירותים חיצוניים** — הפקודה כותבת ל-outbox ומסתיימת; המסירה היא צעד
נפרד שיכול להיכשל בלי להחזיר את הכסף אחורה.

⚠️ **הוספת Edge Function נבחנת מול שלושה מקומות מקודדים בשער** — מפת `$functionJwt`
(`check-quality-gates.ps1:696-709`), הקודים `400/401/401` ב-`Wait-LocalEdgeReady` (`:441`), ורשימת
24 הנתיבים ב-`Assert-OcrPrerequisites` (`:665-689`). פונקציה cron-ית (תקדים `send-push`, וכמוה
`outbox-worker` של גל 5) נכנסת **רק** למפת `$functionJwt` — לא ל-`Wait-LocalEdgeReady` ולא
לרשימת ה-OCR.

> **מומש:** גל 5 (‏`0064`) — הטבלאות, ארבעת ה-RPCs של ה-worker (‏claim/complete/fail/replay),
> ‏Edge Function ‏`outbox-worker` ו-cron דקתי במתכונת ה-vault של `0028`. **גל 7 (‏`0066`) הרחיב
> את ה-claim בלבד:** כל שורה נתבעת נושאת גם ‏url, ‏body דטרמיניסטי, ‏timestamp וחתימת
> ‏HMAC-SHA256 שנחתמה **בתוך Postgres** בסוד ה-Vault של המנוי (‏OPEN-DECISIONS ‏#97);
> ה-worker שולח את ה-body מילולית עם `x-supplyflow-signature`/`x-supplyflow-timestamp`
> ולעולם אינו רואה סוד. הלוגיקה הנבדקת חולצה ל-`outbox-worker/core.ts` (תקדים
> ‏interpret-document) עם צעד deno ייעודי בשער.

---

## 4. המתאמים

`src/lib/adapters/` — ממשקים ניטרליים לספק, **ולכל אחד מימוש mock** כדי שהארכיטקטורה נבדקת בלי ספק
חיצוני:

`AccountingAdapter` (‏`syncSupplier`, ‏`postVendorInvoice`, ‏`postCreditNote`, ‏`postPayment`,
`updatePaymentStatus`, ‏`retrieveAccountMapping`, ‏`retrieveSyncStatus`) · `ErpAdapter` · `WmsAdapter`
(סנכרון ספקים, מוצרים, סניפים ומחסנים, הזמנות, קבלות, אירועי מלאי; מזהים חיצוניים; טיפול בקונפליקט;
סטטוס ייבוא/ייצוא) · `IdentityProviderAdapter` · `NotificationProvider` · `SearchProvider` ·
`RulesEngine` · `DocumentExtractionProvider` · `FileStorageProvider` ·
`FeatureFlagProvider`.

**‏`external_references`** מחזיקה את המיפוי בין ישות פנימית לישות אצל ספק חיצוני — `(org_id, provider,
entity_type, internal_id, external_id)`. זה הגבול. אין עמודות `odoo_id` על טבלאות עסקיות.

**מסך מצב אינטגרציות** (מפעילים בלבד): ספק · מצב חיבור · סנכרון מוצלח אחרון · רשומות ממתינות ·
רשומות שנכשלו · ניסיון חוזר · בעיות מיפוי · מצב אישורים · מצב webhook · עקבות ביקורת.
**אין מסכי תצורה ספציפיים לספק עד שספק ממומש בפועל.**

> **מומש בגל 7 (‏`0066` + ‏`src/lib/adapters/`):** שלוש טבלאות המתאמים — ‏`webhook_subscriptions`
> (רישום יעדי ה-outbox; ‏target נגזר מבנית `'webhook:'||id`; הפעלה = פקודת בעלים עם step-up,
> ‏#98), ‏`external_references` (הטופל שלמעלה, מילולית, עם זוג uniques דו-כיווני), ו-
> ‏`integration_failures` (כשלי מתאם/נכנס — הגבול מול `integration_deliveries` הוכרע ב-#99).
> מהממשקים שברשימה מומשו **שלושה** עם mock ו-spec לכל אחד: ‏`AccountingAdapter` (שבע המתודות
> שלמעלה), ‏`ErpAdapter` ו-`WmsAdapter` — אפס יבואנים בעיצוב עד שספק אמיתי נבחר. יתר השמות
> (‏Identity/Notification/Search/DocumentExtraction/FileStorage/FeatureFlag) נשארים עתידיים.
> Rules Engine אושר לתכנון ב־#258, אך אינו מתאם ספק ואינו ממומש. Workflow Engine הוסר מהיעד
> לפי #257. **מסך האינטגרציות
> נדחה (‏#98)** — ‏`read_webhook_subscriptions()` ו-`read_integration_failures()` הם המשטח
> שהמסך העתידי יקרא.

---

## 5. מזהה קורלציה

**מומש בגל 4b (מיגרציה `0062`):** הלקוח מייצר מזהה **פר-בקשה** (`crypto.randomUUID()` בעטיפת
ה-`fetch` של `src/lib/supabase.ts`, בקשות `/rest/v1` **בלבד** — auth/storage/functions אינם
מקבלים את הכותרת, כדי שההתנהגות המקומית מול Kong תהיה זהה להתנהגות בענן, שבו ה-preflight של
פונקציות נענה מרשימות Allow-Headers סגורות) → נשלח כ-`x-correlation-id` → נקלט ב-Postgres דרך
`current_setting('request.headers', true)` → נרשם ל-`audit_logs.correlation_id` באמצעות **DEFAULT
עמודתי** (`public.request_correlation_id()`). קיבוץ מפורש של פעולה מרובת-בקשות: ‏
`withCorrelationId(id, fn)` (‏OPEN-DECISIONS ‏#89). כותרת פגומה **לעולם אינה מפילה כתיבה** —
ה-helper הוא fail-to-NULL.

**המסלול הוא header/GUC, לא ארגומנט RPC.** גרסה קודמת של הסעיף הציעה "מועבר גם כארגומנט מפורש
לפקודות ה-RPC" — ההצעה צומצמה: ארגומנט היה דורש שינוי 28+ חתימות, וה-header משיג את אותה תוצאה
בלי לגעת באף אחת מהן. ‏`domain_events` (גל 5), ‏Edge Functions, עובד ה-OCR ו-Sentry הם המשך עתידי
של אותו מסלול — הכותרת כבר מותרת ב-CORS של ארבע הפונקציות כהכנה.

✅ **הכותרת כן מגיעה ל-Postgres.** ‏PostgREST חושף כל כותרת בקשה דרך
`current_setting('request.headers', true)::json`, קריא בתוך פונקציית `SECURITY DEFINER`. לכן
`emit_domain_event()` העתידי יוכל לקרוא את המזהה **בלי לשנות אף חתימת RPC**. ‏GUC מפורש —
`set_config('app.correlation_id', <uuid>, true)` — **גובר על הכותרת** ומשמש שרת מהימן לטביעת
מזהה שורש (למשל בגוף job של ‏cron; ‏`cron.schedule` הוא upsert לפי שם — `0028:1032` — כך
שהוספת הטבעה מתכנסת בלי לשכפל תזמונים).

⚠️ **מגבלות אמיתיות:**
1. **המסלול אינו מכסה** Realtime, חיבורי DB ישירים ו-`pg_cron`→`pg_net`→Edge. עבודה שמקורה
   ב-cron מנפיקה **מזהה שורש** דרך ה-GUC ומשרשרת אליו דרך `causation_id` (גל 5).
2. **התנגשות עתידית — ‏`traceparent`:** ‏supabase-js ‏2.110 (המותקן) כולל תמיכת W3C trace
   propagation, כבויה כברירת מחדל. אם תופעל אי-פעם, שני מנגנוני מעקב ירוצו זה לצד זה — נקודת
   ההחלטה תהיה איחוד על traceparent או השארת `x-correlation-id` כמזהה העסקי הצר.

**העמדה הפרטית הקיימת נשמרת ללא שינוי:** `tracesSampleRate: 0`, ללא session replay, ו-`beforeBreadcrumb`
ממשיך למחוק כל breadcrumb של console — כי `toHebrewError` מדפיס הודעת שרת גולמית שעלולה לנקוב בשם ספק
או בסכום (`observability.ts:21-25`).

**לעולם לא נרשם:** סיסמאות · access tokens · refresh tokens · מפתחות `service_role` · אישורי בנק
מלאים · תוכן מסמך רגיש במלואו.

---

## 6. מה לא נפרס, ולמה

הסעיף מתעד את ההכרעות הנוכחיות; הפניות היסטוריות למספרי שורה אינן מקור אמת מפני שהמסמך משתנה.

**גל 9 פעל לפי הטבלה הזו ולא נגדה:** שלוש מהשורות נגעו בו, ואף אחת מהן לא נפרסה. מה שכן
נמסר בגל 9 מתועד ב-OPEN-DECISIONS ‏#103 (התכולה שנדחתה ולמה), ‏#104 (מדיניות מצרה בלבד)
ו-#105 (מטריצת המצב בשרת היא הסמכות).

| כלי | הכרעה |
|---|---|
| Temporal | לא נפרס ולא מתוכנן. #257 דוחה Workflow Engine כללי; מכונות המצב והפקודות בעלות־השם נשארות מקור האמת. מטריצת הדפדפן המשוכפלת כבר נסגרה ב־`read_allowed_transitions()` (`0070`) |
| Novu | לא נפרס. `NotificationProvider` מעל מערכת ההתראות הקיימת. **גל 9 הוסיף העדפות פר-משתמש** (`notification_preferences`, ‏`0068`) — מסננות מסירה, לעולם לא יוצרות אותה, ולעולם לא מרחיבות קהל |
| Meilisearch | לא נפרס, **וגם לא נמדד** — החלפת pg_trgm נשארה אסורה בגל 9 במפורש. `SearchProvider` מעל `global_search()` הקיימת (`0011:113`) — pg_trgm + ILIKE, כי לעברית אין מילון PostgreSQL. שער סוגי-התוצאה נמצא בשרת ובדפדפן לפי `owner`/`office`/`accountant`; תפקיד היסטורי אינו פותר `auth_role()` ולכן אינו מקבל תוצאה — תיקון הרשאה, לא מנוע חיפוש חדש |
| json-rules-engine בדפדפן | **אסור.** #258 מאשר Rules Engine לתכנון שרתי בלבד: owner יוצר מתוך allowlist; ‏Platform Admin מגדיר בסיס גלובלי; rule מתריע, מנתב לבדיקה או מחמיר דרישה, ולעולם אינו מבצע פקודה עסקית, כותב כסף, מרחיב הרשאה או מחליף state machine. עדיין `NOT_DESIGNED / NOT_IMPLEMENTED` |
| Report Jobs | אושרו לתכנון ב־#259 עבור דוחות קיימים וכבדים בלבד. נדרשים worker/storage/retention/permissions; אין תור jobs פעיל ואין סמכות להמציא דוח או שדה |
| read replica | לא מופעל "למראית עין". הפשטת ניתוב בלבד, ותיעוד מפורש אילו שאילתות דורשות read-after-write ונשארות על הראשי |
