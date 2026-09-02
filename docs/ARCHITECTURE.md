# InPlace — ארכיטקטורה (`SupplyFlow` הוא alias מכונה/היסטורי)

## תמצית

SPA ב-React 19 + TypeScript (Vite) מול Supabase כ-backend יחיד: PostgreSQL עם Row-Level Security,
Supabase Auth, ‏Storage פרטי ו־Edge Functions תחומות. בפעולות כספיות הלקוח מחשב preview ותצוגה בלבד;
פקודות כסף, אישור 3-way, lifecycle, idempotency, audit וגבולות דייר/יחידה נאכפים ב־DB.
‏`service_role` נשאר רק בשרת.

**חריגה מכוונת מ"אין שרת ביניים" (שלב 2, אירועי Push וקליטת קבצים לא־מהימנים).** פעולות מערכת שחוצות RLS מחזיקות את
מפתח ה־`service_role` רק ב־Supabase Edge Functions — לעולם לא בדפדפן. `admin-provision` ו־
`send-invite` מאמתות JWT והרשאה לפני פעולה; `send-push` נקראת רק מטריגרי DB/cron ומאמתת
`x-push-secret` מול secret סביבתי לפני יצירת התראות, קריאת מנויים או ניקוי endpoint מת.
`submit-price-list` מאמתת את JWT הקורא, נועלת אובייקט פרטי, מורידה את הבייטים בפועל ומפיקה
מהם hash ושורות קנוניות בצד השרת; רק אז היא מפעילה את פקודת ה־DB הסופית עם ה־JWT המקורי.
זו הרחבה תחומה של אותו עיקרון, לא שרת יישום עצמאי.

```
src/
  auth/AuthContext.tsx     סשן + פרופיל + ניתוב לפי תפקיד
  lib/
    supabase.ts            לקוח יחיד
    types.ts               טיפוסי שורות (תואם למיגרציה)
    status.ts              תוויות עברית + צבעים לכל enum
    format.ts              ₪ / תאריכים he-IL
    checks.ts              מנוע בדיקות: חשבוניות, דרישות תשלום, רענון סטטוס תשלום (RPC)
    audit.ts               sentinel תאימות: אינו כותב audit מהדפדפן ומסמן callers ישנים
    useQuery.ts            hook איחזור מינימלי
    alerts.ts              סריקת ממצאים חיה למסך ההתראות
    notifications.ts       מונה unread, סימון נקרא ו-Realtime לפעמון
  components/
    Layout.tsx             סרגל צד RTL + מגירת מובייל מאותו מקור ניווט
    ui.tsx                 DataTable, StatusBadge, Modal, ConfirmDialog(+סיבה), Toast, KPI
    FileUpload.tsx         העלאה ל-Storage + טבלת documents (כולל צילום מצלמה)
    NotificationBell.tsx   פעמון התראות חדשות בלבד
  pages/                   מסך לכל מודול (ראה מפת מסכים)
supabase/
  migrations/              0001 סכימה+RLS · 0002 ביצוע העברות · 0003 views יתרות
                           0004 סוכני ספק · 0005 בידוד אחסון+אינדקסים · 0006 מפעילי פלטפורמה
                           0007 הזמנות עובדים · 0008 הגנת תפקיד על views היתרות
                           0009–0014 הקשחות, חיפוש, מדדי ספקים ותיבת מסמכים
                           0015 מנויי Push · 0016 טריגרים/cron · 0017 התראות ומחזורי מסירה
                           0018 טיוטות הזמנה אטומיות · 0019 מטא־דאטה לגלריית מסמכים
                           0020 זהות/lifecycle/audit · 0021 שלמות דייר · 0022 חוזה P0/Storage
                           0023 פקודות פיננסיות P1 · 0024 אמינות נתונים והתראות P2
                           0025 פורטל מחירוני ספק · 0026 יומן מלאי · 0027 snapshot חיסכון
                           0028 הודעות WhatsApp להזמנה · 0029 הגנות מסירה · 0030 גשר יישור סכימה
                           0031 חוזה תפקידים · 0032 הגשות מחירון חודשיות · 0033 בטיחות trigger פיננסי
                           0034 תיקוני גבול פיננסי P0 · 0035 intake מהימן להגשות מחירון
                           0036 allowlist כתיבה ופקודות מנומקות · 0037 ניקוי orphan של uploader
                           0038 qualification למדיניות Storage · 0039 שחזור CRUD ל-service_role
                           0040 מצב מסירת התראות server-only · 0041 מעברי סטטוס הזמנה מנומקים
                           0042 ACL פרופיל · 0043 פיצול הזמנה · 0044 פריטים להזמנה הבאה
                           0045–0085 עיבוד/פרשנות מסמכים, review, אוטונומיה וקליטת מחירון
                           0093–0096 reprocess, rollback, calibration, shadow והקשחת scope
                           0097–0103 גבול ספק פיננסי, מיתוג, 3-way, dashboard, lifecycle, portal, מלאי ו־offboarding/export
                           0104–0128 מסמך ספק שהתקבל, הסרת מסמך, צילום פידבק, תבניות ייצוא,
                                     פרישת פרסונות ותיקון העלאות Storage בדפדפן
                           0134–0135 הסרת Trial ו־read-models מצומצמים לבקרת מסמכים
  functions/               admin-provision · send-invite · send-push · send-feedback · submit-price-list
                           interpret-document · outbox-worker · upload-organization-logo · tenant-export
                           service_role נשאר בשרת בלבד
  seed.sql                 seed ניטרלי לדייר חדש (ארגון + קטגוריות)
  demo/                    חבילת הדמו כדייר נפרד + reset + audit בידוד
scripts/                   כלי admin + בדיקות P0–P4 למסד מקומי, Edge runtime ולוגיקה בדפדפן
```

## מפת מסכים ונתיבים

| נתיב | מסך | תפקידים |
|---|---|---|
| `/login` | התחברות | כולם |
| `/dashboard` | מרכז הבקרה (KPI + גרפים + משימות) | `owner`, `office`, `accountant` |
| `/suppliers`, `/suppliers/:id` | ספקים + כרטיס רכש | `owner`, `office`; `accountant` אינו מקבל את כרטיס הרכש |
| `/products` | מוצרים | `owner`, `office` |
| `/prices` | מחירונים + היסטוריה + ייבוא Excel | `owner`, `office` |
| `/orders/new` | הזמנה מרוכזת ← השוואת ספקים ← פיצול | `owner`, `office` |
| `/orders`, `/orders/:id` | הזמנות + תצוגת הדפסה | `owner`, `office` |
| `/receiving`, `/receiving/:orderId` | קבלת סחורה (מובייל) | `owner`, `office` |
| `/invoices`, `/invoices/new`, `/invoices/:id` | חשבוניות + בדיקות אוטומטיות; יצירה מקושרת מציגה מראש הקשר הזמנה/קבלה אנושי שנקרא תחת RLS ושולחת ל־`create_invoice` רק מזהים שנפתרו ואומתו | קוראים / כותבים |
| `/documents` | גלריית מסמכים + סינון + שיוך לחשבונית/קבלת סחורה | `owner`, `office` |
| `/documents/operations` | בקרת מסמכים — דורש טיפול, עיבוד, תקלות, שחזור ותור מחירונים; ללא טלמטריית מודל | `owner` |
| `/inbox` | הפניה ל־`/documents?filing=unfiled` | משתמשים מורשים |
| `/credits` | זיכויים | קוראים |
| `/payment-requests` | דרישות תשלום + אישורים | `owner`, `office` |
| `/pay` | תור ביצוע העברות | `accountant` בלבד |
| `/payments` | תשלומים | `owner`, `accountant` |
| `/bank` | ייבוא תדפיס + התאמות | `owner`, `accountant` |
| `/exceptions` | חריגים | `owner`, `office`, `accountant` |
| `/alerts` | מרכז התראות חי + סימון התראות פעמון כנקראו | `owner`, `office` |
| `/expenses` | ריכוז הוצאות לפי ספק + פירוט קטגוריות משני | `owner`, `accountant` |
| `/reports` | דוח חודשי חי + גרסאות snapshot סופיות ונעולות לפי ישות משפטית | `owner`, `accountant` |
| `/finance/suppliers/:id` | כרטיס ספק פיננסי מצומצם ללא קטלוג/מחירון/דירוג רכש | `owner`, `accountant` |
| `/inventory` | יתרה מדודה, תנועות והצעות רכש read-only | `owner`, `office` |
| `/forgot-password`, `/reset-password` | שחזור עצמי דרך המייל המאומת | משתמש Auth |
| `/settings` | משתמשים + הגדרות עסק | `owner` |
| `/admin` | lifecycle של ארגונים | מפעיל פלטפורמה בלבד |

## מטריצת הרשאות (RLS — נאכף בשרת)

> **חוזה החשבון הפעיל (12.08.2026):** רק `owner`, ‏`office`, ‏`accountant` הם חשבונות מוצר.
> `kitchen`, ‏`payer`, ‏`supplier` נשארים ב־enum ובהיסטוריה בלבד. `0127` משבית וחוסם זהויות
> קיימות, מבטל הזמנות ממתינות ומונע הזמנה/הפעלה מחדש. הרו״ח הוא מבצע ההעברות היחיד; תשלום החירום
> של owner הוסר. ‏`0128` מתקן את מדיניות העלאת Storage בלי להסתמך על שדות שהשירות ממלא רק אחרי INSERT.

| ישות/פעולה | `owner` מנהל/בעלים | `office` מנהל רכש | `accountant` רואה חשבון ומבצע |
|---|---|---|---|
| ספקים, מוצרים, מחירונים | צפייה/ניהול | צפייה/ניהול | ספק פיננסי בלבד, ללא קטלוג/מחירון |
| הזמנות, קבלות ומסמכי רכש | צפייה/ניהול | צפייה/יצירה/שינוי | ללא מסך רכש; הקשר מינימלי דרך חשבונית מאושרת |
| חשבוניות | צפייה/יצירה/אישור | צפייה/יצירה/אישור | צפייה במאושרות בלבד |
| זיכויים | צפייה ומעברי סטטוס | צפייה בסטטוס בהקשר רכש בלבד | צפייה ומעברי סטטוס חשבונאיים |
| דרישות תשלום | צפייה/יצירה/אישור | צפייה/יצירה/אישור | ביצוע של דרישות שאושרו דרך `/pay` |
| ביצוע תשלום | חסום | חסום | רגיל על דרישה מאושרת, כולל אסמכתה |
| בנק | צפייה ופקודות | חסום | צפייה, ייבוא, התאמה והסרת התאמה |
| דוחות/export | צפייה/ייצוא | חסום | צפייה/ייצוא |
| משתמשים/הגדרות | ניהול | — | — |

החוזה נאכף יחד ב־Auth, ב־RLS, ב־RPC, ב־Storage, בנתיבים ובניווט. הסתרת UI לבדה אינה הרשאה.
enum ‏`user_role` נשאר ללא שינוי; תוויות התצוגה נמצאות ב־`src/lib/status.ts`.

### חוזה אבטחת P0

- `profiles.id`, ‏`profiles.org_id` ועמודות הזהות הדיירית אינן ניתנות לשינוי דרך JWT. משתמש
  משנה בעצמו רק שם/טלפון; owner מנהל `role`/`active` של חשבונות `owner`/`office`/`accountant`
  דרך `manage_profile_access`, עם סיבה ו־audit באותה טרנזקציה. `supplier_id` נשמר לקשרים
  היסטוריים בלבד ואינו ניתן להגדרה על חשבון מוצר פעיל.
- owner משנה רק שדות ארגון שהחוזה מתיר. ארגון חדש מתחיל `active`; ‏`set_organization_lifecycle`
  מאפשר ל־platform admin, עם step-up, נעילה וסיבה, רק מעבר בין `active` ל־`suspended`.
  `trial_ends_at` נשארת עמודת תאימות ותמיד `null`; constraint ו־RPC חוסמים Trial עתידי.
  השעיה נשארת מסלול מנהלי נפרד שמאפס בפועל את `auth_org()` לחברי הארגון.
- כל קשר עסקי דיירי נאכף באמצעות `org_id` ו־FK מורכב אל `(org_id,id)` או guard פולימורפי
  מפורש. שבע טבלאות ילד/קישור שלא נשאו דייר קיבלו `org_id`; ‏`audit_logs.user_id` הוא החריג
  המתועד, מפני שפעולת platform יכולה להירשם בדייר שהמפעיל אינו חבר בו.
- טיוטת `purchase_requests` ופריטיה פרטיות ל־`created_by` גם לקריאה בתוך אותו דייר. יתרות
  ומדדי ספק נשארים **מחושבים ולא מאוחסנים**, וכל join/aggregate שלהם כולל `org_id`.
  **עדכון רב־מטבעי `0218`:** השמות הישנים `p0_invoice_balance_rows()`/
  `p0_supplier_balance_rows()` וה־views הישנים נמחקו. המשטח החי הוא פונקציות
  `SECURITY DEFINER` ‏`p0_invoice_balance_rows_by_currency()`/
  `p0_supplier_balance_rows_by_currency()` ומעליהן views ‏`security_invoker`
  `invoice_balances_by_currency`/`supplier_balances_by_currency`. הגרעין הוא חשבונית×מטבע
  וספק×מטבע; שורה אחת לעולם אינה מחברת ILS ו־USD. העיקרון "יתרה מחושבת, לעולם לא מאוחסנת"
  לא השתנה.
- `audit_logs` הוא server-authored: אין INSERT/UPDATE/DELETE ל־JWT, ה־triggers גוזרים actor,
  tenant ו־old/new מן המוטציה האמיתית, וסיבת פעולת P0 רגישה נכתבת בתוך פקודת ה־RPC שלה.
- אין DELETE קשיח דרך JWT לרשומות פיננסיות. ב־Storage קריאה ניתנת רק כאשר קיימת שורת
  `documents` מורשית לאותו path. מחיקה מותרת רק ל־orphan חדש
  של אותו uploader שאין אליו שורת מסמך. bucket המסמכים פרטי; ה־allowlist חוסם
  SVG וקובצי executable, ומ־`0288` חוסם גם `text/html` — **HTML אינו טיפוס מסמך**
  (הכרעת בעלים 02.09.2026, ‏`OPEN-DECISIONS #346`): עמוד שהועלה רץ ב־origin של האחסון
  כשעמית פותח את המקור, וספק עם מחירון HTML ממיר אותו ל-PDF או ל-XLSX. הרשימה נאכפת בשלוש
  נקודות שחייבות להסכים — שני ה־allowlist בלקוח, ‏`public.smart_document_mime_allowed`
  (‏`p0_documents_mime_check` ומדיניות ה־Storage), ו־`allowed_mime_types` של הדלי.
  ‏**`p0_documents_mime_check` מוותר על הבדיקה כששורה כבר פרשה** (`deleted_at is not null`),
  ובכוונה: ‏CHECK נבדק בכל UPDATE, ולכן בלי הוויתור הזה שורה שאוחסנה לפני `0288` הייתה קופאת —
  אי־אפשר למחוק אותה רכה, אי־אפשר לתייק אותה, ואי־אפשר לערוך את `mime_type` (‏`documents_guard_columns`).
  הוויתור מצומצם לשורות שכבר יצאו מהמוצר; כל כותב בודק את הפרדיקט לפני ה־INSERT, כשה־`deleted_at`
  עדיין ריק, ולכן הוא אינו דלת כניסה.
- ה־cutover של P1 הושלם ב־`0023`: מדיניות הכתיבה הישירה הישנה לדרישה, תשלום והקצאה
  הוסרה, והפעולה עוברת רק דרך `execute_payment_request`; מ־`0133` רק `accountant` מבצע אותה.
- `0031` הפרידה היסטורית את תפקידי `office` ו־`accountant`; `0111` ביטלה את מסלול החירום של
  `owner`, ו־`0127` משאירה רק את `accountant` כחשבון פעיל שמורשה להפעיל את
  `execute_payment_request`. הפקודה ממשיכה לדרוש step-up, סיבה ו־audit. ‏`unmatch_bank_transaction`
  מסירה רק התאמה לתשלום קיים; התאמה ישירה לחשבונית דורשת תיקון כספי נפרד ואינה מוחקת תשלום.
- `0034` סוגרת את פערי ההמשך של אותו חוזה: מחיקת חשבונית רכה עוברת רק דרך
  `soft_delete_invoice` האטומי ונחסמת כשקיים קשר כספי; אותות בדיקה אינם חושפים בנק או
  יתרה מחוץ למשטחים הפיננסיים המצומצמים; תור `accountant` כולל דרישה רק כל עוד כל חשבוניותיה מאושרות
  ולא מחוקות; והסרת התאמה מרובת תשלומים מחזירה את כל הדרישות המקושרות ל־`executed`.
- `0036` מחליפה DML משתמע ב־allowlist עמודות מפורש לכתיבות הדפדפן הלא־רגישות. שינוי
  `suppliers.deleted_at`, שינוי `products.active` וביטול הזמנה עוברים רק דרך
  `soft_delete_supplier`, ‏`set_product_active` ו־`cancel_purchase_order`; כל פקודה נועלת
  את הרשומה, דורשת סיבה וכותבת audit באותה עסקה, ו־trigger חוסם מסלול ישיר ישן.
- ל־`purchase_requests` ולפריטיה אין DML ישיר ל־`authenticated`. פקודות השמירה והביטול
  הוותיקות פועלות כ־`SECURITY DEFINER` עם `search_path = public, pg_temp`; רק overload
  ה־finalize בעל שלושת הארגומנטים, הכולל `reason`, ניתן לביצוע מן ה־API.
- `0035`, ‏`0037`–`0039` משלימות את גבול הקליטה בלי לפתוח אותו מחדש: uploader יכול לנקות רק staging
  orphan שלו, מדיניות Storage מפנה במפורש ל־`storage.objects.name`, ו־`service_role` מקבל
  מחדש CRUD על טבלאות `public` לצורכי Edge Functions. ה־grants של משתמשי הדפדפן נשארים
  allowlist מצומצם ונבדקים בנפרד.
- `0040` נועלת את `notification_event_states` ל־`service_role`. ‏`0041` מסירה מן הדפדפן
  UPDATE ישיר של `purchase_orders.status/sent_at/confirmed_at/confirmation_note/expected_date`.
  המעברים `draft→ready/sent`, ‏`ready→sent` ו־`sent→confirmed` עוברים דרך
  `transition_purchase_order_status`, שנועלת את ההזמנה, גוזרת דייר ושחקן מן ה־JWT, דורשת
  סיבה, בודקת retry מול אותו payload וכותבת `purchase_order_status_changed` באותה עסקה.

## מודל נתונים — עקרונות

- **אין payment_id על חשבונית.** `payment_allocations` (תשלום↔חשבונית/זיכוי, N:M) ו-`bank_allocations` (תנועת בנק↔חשבונית/תשלום, N:M) — תומך בחשבונית המשולמת בכמה תשלומים, תשלום המכסה כמה חשבוניות, תשלומים חלקיים, קיזוזי זיכוי, והעברה בסכום שונה מהחשבונית.
- **יתרות מחושבות, לא מאוחסנות, ובתוך מטבע:** יתרת חשבונית = סה״כ − הקצאות תשלום −
  זיכויים באותו מטבע; יתרת ספק נגזרת כשורה לכל מטבע. `invoices.payment_status` מרוענן ע״י RPC
  בטוח. המשטח הוא פונקציות `_by_currency` ומעליהן views `_by_currency`; שם ישן נכשל ברעש.
- **מטבע הוא חלק מהאמת העסקית:** ראש מסמך/עסקה נושא `currency`; שורות יורשות ממנו;
  הקצאות נאכפות בזהות מטבע באמצעות FK מורכב. אין סכום כללי על שני מטבעות ואין המרה. תשלום
  חוצה־מטבע חשבון שומר `settlement_*` כעובדת בנק נפרדת, ו־`payments.bank_currency` הוא generated
  לצורך FK של התאמת הבנק בלבד.
- **סובלנות היא סכום, ולכן נושאת מטבע ואין לה ברירת מחדל חוצת־מטבעות:** ארבעת מפתחות הסובלנות
  ב־`organizations.settings` הם מספר (נקרא כ־`ILS` **בלבד**) או מפה לפי ISO; קוראים דרך
  `private.money_tolerance` בשרת ו־`src/lib/tolerances.ts` בלקוח, לעולם לא ביד. **בהיעדר ערך
  שנקבע הסף נגזר מ־`currencies.minor_units`**: 100 יחידות מינוריות, ו־5 לשורת חשבונית (`#294`,
  `0245`). אלה בדיוק `1` ו־`0.05` של השקל, שמעולם לא היו מספרים שקליים אלא מופע של הכלל.
  **אין המרה ואין שער** — סף דולרי של 1.00 הוא מאה סנט (`#287`, `#290`). ערך שנקבע גובר, למטבע
  שהוא נוקב בו; שדה ריק נשמר כהיעדר ולא כאפס. ‏**`null` שורד** למטבע שהמסד אינו מזהה או שהושבת,
  ושם תנועת בנק **נעצרת** וקליטת מסמך **נכנסת ומפיקה ממצא `warning`** (`#293`).
- **snapshot חודשי v3:** כל שורת כסף נושאת currency ו־`totals.by_currency` הוא מקור הסיכום.
  v1/v2 נקראים כ־ILS בלי כתיבה מחדש ובלי שינוי `content_hash`. חודש מעורב מתפצל לגיליונות לפי
  מטבע; חודש יחיד שומר את שמות הגיליונות ומוסיף עמודת `מטבע`.
- **snapshot מחירים:** `purchase_order_items.unit_price` נקבע ברגע ההזמנה; `price_history` שומר כל שינוי.
- **הגשת מחירון היא ledger immutable:** ‏`supplier_price_submissions` שומר חודש, revision,
  checksum, נתיב קובץ, סטטוס ומוני נקלט/נדחה/ללא־שינוי. תיקון אינו דורס קבלה קודמת. intake
  אוטומטי רשאי ליצור מוצר רק כאשר יש שם **וגם** מק״ט או ברקוד חזק; שם לבדו לעולם אינו זהות התאמה.
- **טיוטת הזמנה היא אישית ועמידה:** `purchase_requests.created_by` קובע בעלות; RPC אטומי מחליף את
  פריטי הטיוטה, ובסיום נועל אותה, מאמת מחיר נוכחי ויוצר את כל הזמנות הספק או אף אחת.
- **מסמך ותוכן עסקי הם שני צירים:** `documents.entity_type/entity_id` קובעים תיוק, ואילו
  `document_kind/supplier_id/document_date` מאפשרים גלריה וסינון בלי לנחש את סוגו של מסמך היסטורי.
- **מקור, חילוץ ואמת עסקית הם שלושה צירים:** `documents` שומר את המקור; תור העיבוד מנהל
  עבודה ו-retry; ‏`document_extractions` שומר ראיית חילוץ immutable. פלט OCR/parser נשאר ראיה
  בלתי־משתנה. mutation אוטומטי מותר רק דרך מדיניות מפורשת ופקודת שרת ייעודית עם ledger, סף,
  idempotency וביטול; יתרה ותשלום אינם נכתבים ישירות מפלט מודל.
- **סריקת תמונה היא שלב נפרד לפני חילוץ:** ‏`0136` משאיר את אובייקט המקור ב־`documents`
  ללא שינוי, ומייצר נגזרת PNG פרטית ב־`document-scans`. עובד הסריקה מחזיק רק token צר,
  וה־Edge Function שומר lease, checksum וראיית egress. ‏OCR אינו יכול לתבוע עבודת תמונה
  במצב `awaiting_scan`; רק אישור אנושי immutable ב־`document_scan_decisions` יוצר עבודת OCR
  הקשורה ל־`scan_output_id`. כשל בזיהוי גבולות עובר לתיקון ארבע פינות, לא לחילוץ שקט מהמקור.
- **מחיקה רכה בלבד** לרשומות כספיות (`deleted_at` / סטטוס בוטל).
- **ביקורת server-authored:** טריגרי DB על כל היישויות הרגישות גוזרים old/new, משתמש ודייר
  מן המוטציה. פעולות פקודה אטומיות כותבות סיבה באותו RPC; הדפדפן אינו רשאי להוסיף שורת audit.
- **אישור מול זיכוי פתוח אינו קיזוז:** דרישת תשלום קשורה לישות המשפטית של כל החשבוניות שלה.
  אישור רגיל נחסם כשיש לספק זיכוי פתוח באותה ישות; override שרתי דורש סיבה ושומר את סכום
  הזיכוי שנצפה, אך אינו משנה את סכום הדרישה, מקצה זיכוי או משנה את סטטוס הזיכוי. עד שיוגדר
  scope לבנק, בדיקת העברה דומה מחזירה `unavailable` כללי ואינה חושפת bit ארגוני.
- **דוח סופי הוא snapshot מובנה ובלתי־משתנה:** כל גרסה נשמרת לפי ארגון, ישות משפטית וחודש,
  יחד עם rows, totals, תוויות תצוגה, metadata ו-hash. ‏XLSX סופי נבנה רק מה-JSONB השמור;
  יצירה ומסירה דורשות step-up, ומסירה נרשמת ב-ledger immutable שמפנה לגרסת snapshot מדויקת.
  הדוח החי ו-ledger ‏`monthly_exports` ההיסטורי נשארים נפרדים.
- **התראות נשמרות פר־נמען:** `notifications` מסוננת ב־RLS לפי `org_id` ו־`auth.uid()`; לקוח רשאי
  לעדכן רק `read_at`. ‏`notification_event_states` היא server-only ומגדירה מחזור מסירה אחד,
  הסלמת warning→critical ומחזור חדש לאחר פתרון. מ־`0024` ה־claim ויצירת שורות הנמענים הם
  עסקה אחת; שורת notification היא outbox עמיד, וכשל Push משאיר `push_sent_at` ריק לניסיון חוזר.

## חוזים שנוספו בקמפיין 09.08.2026

### התאמת חשבונית תלת־צדדית

`0099` שומרת ראיית שורות חשבונית immutable ומקשרת שורה במפורש לפריטי הזמנה/קבלה. זיהוי מוצר
מעדיף מזהה מוצר, מק״ט ספק/מוצר וברקוד; שם אינו סמכות. חשבונית יכולה להיקשר למספר הזמנות, אך שתי
התאמות אפשריות אינן נפתרות לפי סדר. המרות אוטומטיות מוגבלות ל־g↔kg ול־ml↔liter; אריזה דורשת יחס
מוצר מאושר. יחידה שלמה דורשת התאמה מלאה, משקל/נפח מאפשרים ±2%, מחיר עד 1% הוא warning, שיעור
מע״מ חייב להתאים, ועיגול מוגבל ל־₪0.05 לשורה/₪1 לחשבונית. החשבון והאחוז נשמרים גם בתוך tolerance.

`get_invoice_three_way_match` מחזירה assessment שרתי עם reasons וחומרה. אישור חשבונית נחסם
בממצאים שהכרעת #134 מגדירה. כל אישור נועל טרנזקציונית את מרחב ארגון+ספק ושומר snapshot immutable
של ה-assessment; בדיקת overbilling מצטברת קוראת snapshots קודמים ולא זהות מוצר חיה שניתנת לעריכה.
כך שני אישורים מקבילים אינם יכולים לעבור יחד מעל הכמות שהתקבלה. רק owner עם password AMR טרי
וסיבה יכול ליצור override immutable; כפילות חשבונית ודאית אינה ניתנת לעקיפה. office רשאי לתקן
ראיית שורה/שיוך אך לא לעקוף חסימה. match set מפורש מחליף רק שורות שהוזכרו בו ושומר התאמה
דטרמיניסטית של שורות אחרות.

### Dashboard read model

`management_dashboard_snapshot(date)` הוא `SECURITY INVOKER` ושומר tenant/RLS. `unmatched` ו־
`suggested` נפרדים; חשבוניות ודרישות תשלום ממתינות נפרדות; overdue נגזר רק מ־payment request פעילה
עם `due_date`. אם קיימת דרישה פעילה כלשהי ללא `due_date`, הכיסוי חלקי וכל משפחת מדדי האיחור
מוחזרת `null`, ולכן הלקוח מציג `—` והסבר ולא אפס חלקי. תור פעיל ריק שנקרא בהצלחה הוא מדידה מלאה
ומחזיר אפס אמיתי; כשל קריאה נשאר `null`.

### Offline, SaaS, ספקים ומלאי

- Service Worker שומר app shell ונכסים סטטיים בלבד; API/נתונים פיננסיים אינם נשמרים. טיוטת קבלה,
  מפתח idempotency ותמונה נשמרים ב־IndexedDB; קונפליקט עוצר לאדם והצלחה אינה מוצגת לפני RPC.
- `0134` מוציאה את Trial מחוזה המוצר: ארגונים קיימים מומרים ל־`active`, ברירת המחדל היא
  `active`, וכתיבה מותרת רק ב־`active`. ‏`organization_access_state` שומר על צורת התשובה לתאימות
  אך מחזיר רק `active`/`offboarding`/`suspended` ושדות המועדים בו תמיד `null`. מטמון offline ישן
  עם Trial/Grace נכשל סגור עד רענון שרתי. ה־runtime עדיין משתמש בשלושת המסלולים הישנים; חוזה
  חמשת המסלולים, המחירים והמכסות החדשות ב־`OPEN-DECISIONS.md` #194–#230 הוא יעד מתוכנן בלבד,
  ואינו פעיל עד מיגרציה forward-only, חיבור חי ואימות rollout.
- `0135` היא הדלת של „בקרת מסמכים”: שלושה read-models owner-only, מסוננים לפי דייר ויחידות גישה,
  ללא provider/model/prompt/schema/tokens/cost/confidence/drift. הרשאת דפדפן הוסרה מה־RPC-ים
  הטכניים הישנים שאינם נצרכים עוד בממשק.
- `0137` מוסיפה תיק חשבונית מרכזת לכל ארגון + ישות משפטית + ספק + חודש קודם. העוגן הוא
  `invoices.financial_role='payable'` היחיד; חשבוניות ביניים הן `supporting_evidence`, מסמכים
  שטרם תויקו נשארים מועמדי ראיה, וקבלות שאינן `completed` מוצגות אך אינן מוכיחות כמות. הקליטה
  שומרת כל עמוד כבייטים מקוריים תחת intake אחד; ההקשר נגזר מטבלאות intake ולא מסוג OCR חדש.
  שלושת הערוצים — עוגן מול ביניים, עוגן מול קבלות, ביניים מול קבלות — נשמרים בנפרד ב־snapshot
  immutable. מסמך מאוחר מוסיף revision ואינו משנה את החוב בשקט. כל קוראי הכסף סופרים רק
  `payable`, ויעדי תשלום/זיכוי מוגנים גם בטריגר.
- `0139` מוסיפה גבול recovery למסלול המרכזת: OCR חסר או ספק שלא זוהה עוברים ל־
  `needs_review` בלי יצירת חוב וניתנים להרצה חוזרת; סתירת ספק קנוני וחסימות עסקיות נשארות
  terminal. תאריך עם שנה דו־ספרתית מתקבל רק מול חודש היעד. לכל עמוד נבחרים רק ה־job
  וה־interpretation העדכניים, ורק עמודי `invoice` תורמים שורות לעוגן; שאר העמודים נשמרים
  כ־`supporting_document`. ה־workspace מחזיר intake, reason מדויק ורשימת עמודים לתיקון.
  אותה migration גם מיישרת forward-only התקנות `0137` מוקדמות שחסרו policies, grants,
  indexes, readers וטריגרי late-arrival מהגוף הקנוני.
- `0094` חוסמת פעילות מסחרית חדשה עם ספק inactive ומשאירה היסטוריה וסגירה פיננסית. `0097` חושפת
  projection פיננסי נפרד, ו־`0133` מצרה אותו ל־`owner`/`office`/`accountant`. משטח אישור
  ההזמנה של פרסונת הספק מ־`0101` וה־helper ‏`auth_supplier()` הוסרו; מעברי הזמנה פעילים הם
  של `owner`/`office` בלבד.
- `0102` הוא read model על ledger המלאי. בלי ספירה פיזית יתרה וצפי הם unknown; הצעת reorder ומחיר
  ספק הן read-only ואינן יוצרות הזמנה.
- `0103` מוסיפה בקשת offboarding שמחילה read-only מיידי, ביטול owner עד 30 יום, הפעלה מחדש בידי
  Platform Admin עד 120 יום, ו־export מלא עמיד בדפי CSV/JSON ומסמכי מקור. חלקים נכתבים לאחסון
  פרטי עם hash ו־manifest; broker מנפיק קישור בר־ביטול ל־7 ימים ומאמת אותו מחדש בכל הורדה.
  אין purge אוטומטי: retention ו־legal hold נשארים fail-closed עד executor ציות ייעודי.

### אינטגרציות ואבטחת scope

Domain events ו־transactional outbox שומרים את העסקה בלתי־תלויה ביעד, עם correlation,
idempotency, HMAC, retries ו־dead-letter. **Live Integration Proof הוא DEFERRED** עד יעד ו־credentials
מפורשים. `0095` מחליפה marker טקסטואלי ב־lexer של SQL, קריאה executable ו־body hash; רשם החריגים
נשאר גלוי וריקונו נשאר עבודה פונקציה־פונקציה.

## חוזה פורטל הספק — `0167` (**מוזג ב־PR #86 ונפרס עם live E2E**)

ספק ניגש ל**הזמנה אחת** דרך טוקן bearer, לא דרך זהות: ‏`supplier_order_links` שומרת sha256 בלבד,
עם תפוגה, ביטול, הנפקה-מחדש שממיתה את הקודם, מונה כשלים ונעילה. שלושה כללים מחייבים:
- **‏snapshot, לא שאילתה.** הפורטל מרנדר את `order_snapshot` שנחתך בהנפקה (שם גולמי בלבד — חוק
  ‏#163). שינוי מאוחר בהזמנה אינו משנה את מה שהספק רואה, וספק לעולם לא שואל את המסד.
- **הצעה היא ראיה.** ‏`supplier_order_proposals`/`_lines` הן append-only בטריגר; רק שדות ההחלטה
  ‏(סטטוס/מחליט/סיבה/תאריך) ניתנים לעדכון, דרך `decide_supplier_order_proposal` המנומקת בלבד.
  הגשה כפולה זהה נענית אידמפוטנטית; שונה — conflict. כשלי ולידציה **נענים ולא נזרקים**, כדי
  שמונה הכשלים ורישום הכשל ישרדו את הטרנזקציה.
- **רוויזיה היא הזמנה חדשה.** ‏`create_purchase_order_revision_from_proposal` כותבת purchase_order
  חדש (`revision_number`+1, ‏`revised_from_order_id`) מהשורות שאושרו, מבטלת את המקורית דרך
  ‏`cancel_purchase_order`, ואינה נוגעת בשורות היסטוריות. אין עריכת שורות הזמנה במקום — לא קיים
  מסלול כתיבה כזה, בכוונה.
המימוש service_role בתבנית 0103 (‏Edge ‏`supplier-portal`, ‏verify_jwt=false, ‏POST בלבד); ‏A5 —
self-enforcement עם `assert_unit_in_scope`; ‏A6 — ‏`token_hash` מוחרג מייצוא ההתנתקות. מודל
האיומים: `docs/SUPPLIER-PORTAL-THREAT-MODEL.md`.

## חוזה "מסמך ספק שהתקבל" — `0104`–`0117` (**פרוס בייצור**)

הזרימה החדשה היא **שרשרת קריאה ואז פקודה אחת שכותבת**. כל מה שלפני האישור **קורא בלבד**, וכל אחת
מהפונקציות אומרת זאת בגוף שלה:

| שלב | פונקציה | מה מכריע |
|---|---|---|
| מי שלח | `private.resolve_document_supplier` (`0106`) | ח.פ → ספק שעל המסמך → מק"ט/ברקוד → שם מנורמל. **יותר ממועמד אחד ⇒ לא מוכרע** |
| איזו הזמנה | `private.resolve_document_order` (`0107`) | דרגות **לפי תת-סוג**; קרבת תאריך **מסדרת** מועמדות ולא מכריעה |
| מה נמצא | `private.document_reconciliation_assessment` (`0108`) | ארבעה מקורות; סובלנויות של `0099`, מעוגנות מול הטקסט שלה |
| מה הדפדפן רואה | `public.get_document_review_assessment` (`0109`) | הדלת היחידה; מצמצם `auth_scopes()` בעצמו |
| מה נכתב | `public.apply_reviewed_document` (`0110`) | **מחשב מחדש את ה-assessment** ומסרב למה שעדיין חסום |

**שלוש טענות מבניות שלא ניתן להסיק מהקוד בלי לקרוא אותו כולו:**

1. **חשבונית אינה מקבלת סחורה.** ‏`apply_reviewed_document` אינו נוגע ב-`received_qty` ואינו מזיז
   סטטוס הזמנה — מעוגן בטקסט. אחרת ספק סוגר הזמנה בשליחת נייר.
2. **תעודת משלוח יוצרת טיוטה בלבד.** רק אישור אנושי נפרד שהסחורה התקבלה משלים קבלה, ורק ההשלמה
   מזיזה מלאי וסטטוס. זהו כלל `0090`, מנוסח מחדש למסלול המאושר ולא מוחלף.
3. **קבלה היא ראיה ולעולם לא חוב** (‏`OPEN-DECISIONS #141`). לא ניתן לקשר ⇒ מסרבת.

**ההצעה שהמשתמש אישר היא קלט, לא פסק דין.** הפקודה בונה מחדש payload בצורת החוזה מתוך ההצעה
ומריצה את `0108` שוב בשרת. מה שהלקוח טוען על ממצאים **אינו נקרא**. אומת במוטציה.

**מדדים ומחיקה:** ‏`0113` מגדיר את ארבעת מדדי הכסף פעם אחת (‏**היום העסקי**, מחירי snapshot,
חשבוניות מאושרות, זיכויים `offset|closed` — ‏`OPEN-DECISIONS #147`); ‏`0114` סופר משלוח **פעם אחת**
דרך `purchase_order_items.id`, מפתח הניכוי היחיד שקיים; ‏`0116` מחשב מה מחיקת מסמך תיקח **לפני**
שהיא לוקחת, וחוסם את האפשרות ההרסנית כשרשימת החוסמים אינה ריקה.

**גבול שאינו RLS:** ‏`0112` הוציא את `suppliers.bank_details` מהטבלה הגולמית דרך **הרשאת עמודה**,
שיושבת *מתחת* ל-RLS. ‏`0133` הסיר את ענף `kitchen` לאחר פרישת הפרסונה, אך שמר את גבול העמודה
ואת ה־projection הפיננסי המצומצם לשלושת התפקידים הפעילים.

## חוזה עיבוד מסמכים ואוטומציה — מצב נוכחי

מיגרציה `0045_smart_document_processing.sql` יצרה את `document_processing_jobs` ואת
`document_extractions` לצד רשם המקור הקיים. לכל שורה `org_id`, קשרים דייריים מורכבים ו-RLS;
תוצאה שנשמרה אינה נערכת או נמחקת. עיבוד חוזר יוצר job חדש ושומר את הראיות הקודמות.

מחזור חיי job הוא `queued → leased → extracted → interpreting → review → completed`, עם
`failed` לכשל סופי. lease שפג ניתן לתביעה מחדש; claim, heartbeat, complete ו-fail הם פקודות
שרת בלבד ואינם granted ל-`authenticated`. ‏`enqueue_document_processing` אידמפוטנטית לפי
מסמך, checksum וגרסת חוזה פעילה. ה-checksum נגזר server-side מ-`eTag` מנורמל של אובייקט
Storage; אובייקט בלי `eTag` אינו נכנס לתור.
`reprocess_document` דורשת owner/office, סיבה ו-audit.

`ExtractionContract` גרסה `1` שומר טקסט, blocks, tables וסימונים. עמוד הוא 1-based,
ו-bbox הוא `[xMin, yMin, xMax, yMax]` מנורמל ל-`0..1`; ‏confidence לא ידוע הוא `null`,
לא אפס. מקור הסמכות
לסוג הקובץ הוא bytes שנבדקו; extension היא רמז בלבד. גבולות ברירת המחדל הם 10MB למקור,
100 עמודי PDF, ‏5,000 שורות spreadsheet, ‏2 מיליון תווי טקסט ו-100MB לאחר decompression.
קובץ מוצפן, פגום או לא נתמך נכשל בקוד מפורש ללא fallback שקט.

**הערת היסטוריה:** ב־`0045` מנוע החילוץ, הפרשנות, review וה־bridge למחירון עוד לא היו קיימים.
מאז נמסרו `extract-document`/`interpret-document`, ראיות חילוץ ופירוש immutable, מסך review,
סיווג אוטומטי וקליטת מחירון פר־שורה דרך פקודת המחיר הסמכותית. `0093` מוסיפה reprocess מנומק
ו־rollback לפעולה אוטומטית; `0096` מוסיפה Shadow predictions, החלטות אדם בגרסאות, calibration
metrics, drift read models ומרכז תפעול. שינוי fingerprint מבני לא־מוכר מעביר ל־Shadow; מדדי drift
מספריים נשמרים אך אינם מפעילים threshold אוטומטי.

Shadow Mode קורא את אותה ראיית פירוש ומחשב `apply_existing_price`/`create_product`/`review`/
`rejected_by_policy`, אך אינו קורא לכותב קטלוג או מחיר. שינוי סף נשאר פעולה אנושית מפורשת לאחר
corpus; המערכת אינה "לומדת" או משנה policy מעצמה.

מיגרציה `0049_document_review_mutations.sql` מוסיפה שכבת review בלבד מעל הראיות הבלתי־משתנות.
`add_document_annotation` ממחזרת את `document_annotations` ל־annotation חד־פעמי ואישי;
`add_document_review_correction` מוסיפה revisions ל־`document_review_corrections` עבור block או
תא טבלה. הטקסט המקורי, checksum וגרסת החוזה נגזרים ונבדקים בשרת; revision וטקסט צפויים חוסמים
lost update, ושינוי ב־Storage חוסם שמירה. המסמך ננעל לפני ה־interpretation/job כדי לחסום מחיקה
או השלמה מקבילה בלי להפוך את סדר הנעילות של `0048`. רק owner/office רשאים לערוך בדייר שלהם.
אין DML מהדפדפן, אין שינוי ל־payload של
`document_extractions`/`document_interpretations`, וכל הצלחה נכתבת ל־audit עם סיבה.

מיגרציה `0050_document_type_review_decisions.sql` מפרידה בין הצעת `document_type` הבלתי־משתנה
שב־interpretation לבין הכרעת review. ‏`review_document_type` מוסיפה revision ל־
`document_type_review_decisions` עם `approved_document_type` נפרד (או `null` בדחייה), נועלת document
ואז interpretation/job, ודוחה job שאינו ב־`review`, ‏suggestion/checksum/contract/revision ישנים או
Storage שהשתנה. retry זהה מוחזר כאידמפוטנטי; שינוי ללא שינוי ערך נדחה. Owner/office בלבד
רשאים להכריע; suggested supplier/fields נשארים display-only עד שיוגדר עבורם חוזה סמכותי נפרד.

## גבול פקודות פיננסי P1 — ממומש מקומית

> מיגרציות P0 הן `0020`–`0022`, מיגרציית P1 היא `0023`, וכולן משולבות בענף P2 המקומי.
> מסלול שדרוג מ־`0019`, התקנה נקייה ומטריצת שני דיירים נבדקו לאחר השילוב. הערת ה־"לא נפרסו"
> המקורית הייתה snapshot היסטורי ונמחקה; מצב הפריסה הנוכחי נרשם רק ב־`PROGRESS.md`; ראיות שחרור נשמרות ב־CI וב־Git history.

כל שינוי כספי בתחום P1 עובר דרך RPC אחד. הלקוח רשאי לחשב preview, אך אינו קובע `org_id`,
משתמש מבצע, מאשר, יתרה, סטטוס נגזר או audit. ‏`p1_financial_command_guard` משתמש בסמן
transaction-local שרק ה־RPC מגדיר; grants ו־policies ישירים מוסרים מהטבלאות שבבעלות מלאה.

| משפחה | פקודת שרת | נקודת הסריאליזציה והאידמפוטנטיות |
|---|---|---|
| ביצוע תשלום | `execute_payment_request` | נעילת הדרישה והיעדים בסדר UUID; unique על דרישה; retry משווה payload קנוני |
| דרישת תשלום | `create_payment_request`, ‏`transition_payment_request` | UUID לקוח יציב, נעילת חשבוניות/דרישה ומעברי סטטוס שרתיים |
| אישור דרישה מול זיכוי פתוח | `approve_payment_request_with_credit_override` | נעילת דרישה/חשבוניות/זיכויים, בדיקת supplier+scope+total צפוי, סיבה ו-audit אטומי; retry זהה אינו מוסיף audit |
| תדפיס בנק | `import_bank_transactions`, ‏`match_bank_transaction` ופקודות assign/ignore/exception | hash קובץ ושורה, נעילת תנועה, תשלום/הקצאה יחידים |
| קבלת סחורה | `save_goods_receipt` | UUID קבלה יציב, נעילת הזמנה ופריטים; כמות תקינה נצברת פעם אחת |
| חשבונית | `create_invoice`, ‏`set_invoice_review_status`, ‏`soft_delete_invoice` | UUID לקוח יציב, בדיקות DB חוזרות, ומחיקה רכה עם נעילה, בדיקת קשרים וסיבת audit באותה עסקה |
| זיכוי מחשבונית | `create_invoice_credit_request`, ‏`transition_credit_request` | UUID לקוח יציב, נעילת חשבונית לפני זיכוי, מעברי סטטוס שרתיים ורענון יתרה באותה עסקה |
| מחיר מנהל/ידני | `set_supplier_product_price`, ‏`import_supplier_prices` | נעילת `supplier_products`; מחיר נוכחי ו־`price_history` נכתבים יחד; batch legacy הוא `owner`/`office` בלבד |
| קליטת מחירון ספק עסקי | `submit-price-list` → `submit_supplier_price_list` | owner/office מעלים; Edge נועל ומאמת את גרסת אובייקט ה־Storage, גוזר hash ושורות מהבייטים; נעילת ספק מסדרת revision; ‏checksum חודשי מחזיר אותה קבלה; intake, מחיר, היסטוריה, קבלה ו־audit נסגרים באותה עסקת DB |
| חודש לרו״ח | `mark_month_export_sent` | נעילת ארגון/export/חשבוניות ו־snapshot ממוין של `invoice_ids` |
| snapshot חודשי סופי | `create_monthly_report_snapshot` | advisory lock לפי ארגון/ישות/חודש, גרסה עולה immutable, ייחוס מקורות fail-closed ו-audit/event באותה עסקה |
| מסירת snapshot לרו״ח | `mark_monthly_report_snapshot_sent` | step-up, נעילת snapshot מסוננת-scope, recheck הרשאה לאחר המתנה ו-delivery immutable/idempotent לגרסה מדויקת |
| אישור טיוטת הזמנה | `finalize_purchase_request_draft` | נעילת טיוטה, פריטים ומחירים בסדר קבוע; שינוי מחיר מחזיר `draft_price_changed` |
| מעבר סטטוס הזמנה | `transition_purchase_order_status` | נעילת הזמנה דיירית; allowlist מעברים; חותמות זמן ו־audit מנומק נכתבים אטומית; retry זהה אידמפוטנטי |

שובר השוויון בהמלצת מחיר הוא `(current_price, supplier_id)` הן ב־`save_purchase_request_draft`
והן בדפדפן. בחירה ידנית של משתמש נשמרת, אבל המחיר והזמינות שלה נבדקים שוב תחת נעילה.
`purchase_order_items.unit_price` נשאר snapshot ואינו משתנה לאחר יצירת ההזמנה.

### חוזה הגשת מחירון P1B

הדלי `price-submissions` פרטי ומקבל רק CSV/XLS/XLSX עד 10MB. נתיב חדש הוא בדיוק
`{org_id}/price-submissions/{supplier_id}/{submission_id}/{file}` וללא overwrite: ניתן למחוק
רק orphan של אותו uploader שלא נרשם ב־ledger; staging לא־רשום נקרא רק בידי אותו uploader
ובתנאי שהדייר, התפקיד והספק בנתיב תואמים. לאחר רישום הקובץ הוא immutable ונקרא רק בידי
`owner`/`office`. intake פעיל חוסם מחיקה גם עבור ה־uploader, ואין מדיניות UPDATE.

הדפדפן רשאי לבצע preview מקומי, אך אינו שולח hash או שורות לפקודת המחירים. הוא מעלה אובייקט
פרטי ושולח ל־`submit-price-list` רק מזהי הגשה/ספק/חודש, שם ונתיב קובץ וסיבה. פונקציית הקצה
מאמתת מחדש את המשתמש, התפקיד, הדייר והספק, יוצרת claim קצר־חיים בטבלת
`supplier_price_submission_intakes` שהיא `service_role` בלבד, ומקבעת `object_id` ו־
`updated_at` של אובייקט בבעלות המעלה. כל עוד ה־claim פעיל מדיניות Storage חוסמת מחיקה;
אין מדיניות UPDATE/overwrite לאובייקט. הפונקציה מורידה את הקובץ הפרטי, מאמתת עד 10MB,
חותמת CSV UTF-8 או XLS/XLSX אמיתי, מפענחת עד 5,000 שורות בצד השרת ומחשבת SHA-256 מהבייטים
שהורדו. לפני staging היא מאמתת שוב שזה אותו object/version.

ה־RPC הציבורי מקבל רק `intake_id`, פועל עם ה־JWT המקורי וצורך intake מוכן של אותו actor/dייר.
הפקודה הישנה בעלת שמונת הארגומנטים נשארת מימוש פנימי ללא grant ל־API. כל שורה מקבלת תוצאת
קבלה או דחייה, ולכן שילוב שורות תקינות ושגויות מקבל `accepted_with_rejections`; מוצר לא מוכר
אינו יוצר מוצר. צריכת ה־intake, עדכון המחירים, `price_history`, ה־ledger וה־audit מתבצעים באותה
עסקת DB, כך שכשל משאיר את ה־intake מוכן לניקוי שרתי ואינו משאיר כתיבת DB חלקית. לאחר שחרור
claim הלקוח קורא ומנקה את ה־orphan הלא־רשום שלו; מדיניות הקריאה אינה חושפת אותו למשתמש אחר,
לספק מתחרה או לדייר אחר גם אם הניקוי נכשל.

### חוזה ראיות P3/P4 המקומי

`scripts/check-quality-gates.ps1` נכשל סגור: הוא מבצע reset/upgrade דרך כל המיגרציות,
מריץ מטריצות RLS/RPC ו־concurrency, מפעיל Edge אמיתי, מתקין fixture חדש ורק אז מריץ את
הדפדפן. reset מקומי ממחזר במפורש את PostgREST וממתין מחדש ל־Auth/REST, כדי שלא להשתמש
בחיבור pool שנשאר ממופע PostgreSQL שהוחלף; כשל בשלב הזה הוא `BLOCKED` תשתיתי ולא PASS.
לאחר ה־fixture, `check-p4-integrated-journey.cjs` מבצע מסע אחד על אותן ישויות עם
JWT נפרד ל־owner/office/accountant. ‏`service_role` משמש בו לקריאת projection של
ראיות בלבד; כל מוטציה עסקית נעשית דרך JWT משתמש או Edge מהימן.

המסע שומר `p4-integrated-before.json`, ‏`p4-integrated-after.json`,
`p4-integrated-audit.json` ו־`p4-integrated-journey.json` בתיקיית ה־artifact. כל כתיבה
עוברת סריקה שחוסמת token, סיסמה, Authorization, מפתח, אימייל ו־raw payload. ה־after מאמת
את snapshot המחיר בהזמנה, N:M allocations, יתרה מחושבת, התאמה/הסרה/התאמה מחדש וזיכוי
שאינו מקוזז פעמיים. דוח הדפדפן שומר PASS/FAIL/BLOCKED, זמן, צעדים, backtracks, viewports,
נגישות, console, screenshots ו־exports מוצלבים. gate מקומי אינו אישור deploy.

ל־`bank_allocations` אין עדיין constraint היסטורי של יעד יחיד: preflight מצא שבע שורות ישנות
עם שני יעדים. כתיבה חדשה דרך ה־RPC מחייבת יעד אחד וה־guard חוסם כתיבה ישירה; תיקון הרשומות
הישנות מחייב החלטת נתונים מפורשת. באופן דומה, export ישן ב־`sent` ללא `invoice_ids` אינו מקבל
snapshot מומצא ב־retry אלא נכשל ב־`month_export_legacy_snapshot_missing`.

## שכבת אמינות נתונים P2 — ממומשת מקומית

- כל טווחי החודש/יום מחושבים לפי `Asia/Jerusalem`; תשובת בקשה ישנה או תשובה לאחר unmount
  אינה מחליפה מצב חדש. רשימות וייצוא מלא נטענים בדפים ולא נעצרים ב־1,000 שורות.
- סריקות alerts נשארות עצמאיות: aggregate שרתי אחד שנכשל אינו מוחק ממצאים מסריקות אחרות,
  והמסך מצהיר במפורש שהסריקה חלקית. מדדי סכום/ספירה עברו ל־RPCs `security invoker`.
- מסלול הזיכוי הרגיל הוא `open → requested → received → offset → closed`; ה־RPC מקבל גם
  `open → received` כשהקבלה כבר תועדה. ‏`received` אינו מסמן פתרון ואינו משפיע על יתרה,
  ואינו יכול לדלג ל־`closed`; `resolved_at` נקבע רק ב־`offset`/`closed`.
- ה־FKs המורכבים של P0 הם הקשר הקנוני היחיד. `0024` מסירה רק FK ישן וחלש שיש לו מקבילה
  מורכבת ומאומתת, כדי למנוע `300 Multiple Choices` ב־PostgREST בלי להחליש בידוד דיירים.
- ייבוא בנק, התאמות, יצירת חשבונית/דרישת תשלום, מעברי זיכוי וסימון export צורכים את פקודות
  P1; אין מסלול כתיבה ישיר חלופי ואין מיגרציה כפולה.

## זרימת העבודה העסקית המלאה (ממומשת; לא Workflow Engine)

```
מחירון (ידני/Excel) ─► שמירת מחיר + היסטוריה
       │
רשימת רכש מרוכזת ─► Auto Save לטיוטה אישית ─► המלצת ספק לפי מחיר ─► עקיפה ידנית
       │
סיכום חיסכון מול ספק מלא זול ─► פיצול אטומי (snapshot מחיר) ─► מוכנה→נשלחה→אושרה
       │
קבלת סחורה בנייד: מלא/חלקי/חסר/פגום/הוחזר + צילום ─► עדכון סטטוס הזמנה
       │                                              └─► דרישות זיכוי אוטומטיות
חשבונית + שורות immutable ─► קישור למספר הזמנות וקבלות ─► true 3-way שורה־מול־שורה
       │                        כמות/יחידה/מחיר/מע״מ/אריתמטיקה/כפילות/קבלה בפועל
       │                        └─► warning  או  חסימת אישור; owner override עם step-up+סיבה+audit
דרישת תשלום ─► בדיקות טרום-אישור ─► אישור ─► העברה לגורם המבצע
       │
ביצוע העברה (מסך ממוקד: פרטי בנק, סכום, אסמכתא, אישור העברה)
       │        └─► תשלום + הקצאות ─► חשבוניות מסומנות שולם/חלקי
תדפיס בנק runtime נוכחי (CSV/Excel + מיפוי עמודות) ─► מניעת ייבוא כפול (hash קובץ+שורה)
יעד מוכרע, טרם מומש (#9/#232): תבנית XLSX קנונית אחת, בלי CSV ובלי מיפוי הסתברותי
       │        ─► זיהוי ספק מהתיאור ─► הצעות התאמה עם ביטחון ─► אישור/ידני/חריג
דוח חודשי לרו״ח ─► חריגים לפני סגירה ─► ייצוא Excel/PDF ─► "הועבר לרו״ח"
דשבורד ─► KPI לחיצים ─► מסכים מסוננים
```

## דיאגרמות סטטוסים

**הזמנת רכש:** `טיוטה → מוכנה → נשלחה → אושרה → התקבלה חלקית ⇄ התקבלה` · `בוטלה` מכל שלב פתוח (עם סיבה).

**חשבונית — 3 צירים בלתי-תלויים:**
- בדיקה: `התקבלה → בבדיקה → ממתינה לאישור → מאושרת` · `דורשת בירור` מכל שלב (אוטומטי בממצא קריטי).
- תשלום (מחושב): `לא שולמה → שולמה חלקית → שולמה`.
- רו״ח: `טרם הועברה → הועברה`.

**דרישת תשלום:** `טיוטה → ממתינה לאישור → מאושרת → הועברה לביצוע → בוצעה → הותאמה לבנק` · `חשד לכפילות` (אוטומטי) · `דורשת בירור` · `בוטלה`.

**זיכוי:** `פתוח → נדרש מהספק → התקבל → קוזז בתשלום → נסגר` (קיזוז משפיע על יתרה רק מ-offset/closed).

**תנועת בנק:** `לא מותאמת → הצעת התאמה → מותאמת` · `לא רלוונטית`.

**חריג:** `פתוח → בטיפול → טופל/נדחה` (סגירה מחייבת הערת סיכום, מתועדת בביקורת).
