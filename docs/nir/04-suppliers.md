# 4 — מסך ספקים: מדדי תמיכה בהחלטות

> תוכנית מימוש ברמת שורה לסעיף 4 מתוך `NIR-APP-DOCS/המשך פיתוח.txt`.
> סעיפים 1-3 ו-5-12 **מחוץ לתחום** של המסמך הזה.

**סטטוס:** תוכנית בלבד. שום קוד לא נכתב, שום מיגרציה לא הורצה.

---

## 1. מה ניר ביקש

ציטוט מלא של הסעיף מהמסמך המקורי:

> **4. מסך ספקים**
>
> יש להוסיף לכל ספק מידע נוסף המסייע בקבלת החלטות.
>
> לדוגמה:
>
> * דירוג ספק.
> * אחוז עמידה בזמני אספקה.
> * שינויי מחירים לאורך זמן.
> * מספר חריגים.
> * מספר זיכויים.
> * יתרת חוב.
> * זמן אספקה ממוצע.
>
> כך ניתן יהיה להעריך את איכות הספק מעבר למחיר בלבד.

שבעה מדדים. המשפט האחרון הוא הדרישה האמיתית: **להעריך ספק מעבר למחיר.** מדד שמוצג בלי נתונים מאחוריו לא משרת את המטרה הזו — הוא פוגע בה.

---

## 2. מה קיים היום

### `src/pages/Suppliers.tsx` (254 שורות)

הקובץ מייצא שני מסכים, שניהם מנותבים ב-`src/App.tsx:107-108` ומוגנים ל-`READERS` (`App.tsx:57` = `owner, office, kitchen, accountant`):

| ייצוא | נתיב | מה מרנדר היום |
|---|---|---|
| `SuppliersList` | `/suppliers` | `DataTable` עם **8 עמודות** (`Suppliers.tsx:31-40`): ספק · קטגוריות · איש קשר · טלפון · ימי אספקה · מינ׳ הזמנה · יתרה פתוחה · סטטוס |
| `SupplierCard` | `/suppliers/:id` | כותרת + שורת מטא (`:180-192`), **4 כרטיסים** (`:194-199`), 4 טאבים (`:203-210`, `:212-245`) |

**השאילתה של הרשימה** (`Suppliers.tsx:22-27`) — שתי קריאות **סדרתיות**: `suppliers` ואז `supplier_balances`, ממוזגות דרך `Map`. זה בדיוק התקדים שכל מדד חדש צריך לחקות.

**השאילתה של הכרטיס** (`Suppliers.tsx:146-163`) — כבר משתמשת ב-`Promise.all` עם 5 קריאות מקבילות.

**ארבעת הכרטיסים הקיימים** (`Suppliers.tsx:194-199`) — `div`-ים ידניים, לא `KpiCard`: יתרה פתוחה · ימי אספקה · מינימום הזמנה · תנאי תשלום. רק הראשון הוא מדד; שלושת האחרים הם **נתוני אב**, לא מדידות.

### כמה מהשבעה יש להם נתונים מאחור

| מדד | נתונים קיימים? |
|---|---|
| יתרת חוב | ✅ **כבר עובד** — `supplier_balances`, מוצג ב-`Suppliers.tsx:38` וב-`:195` |
| מספר זיכויים | ✅ הנתונים קיימים במלואם, לא מוצגים כמדד |
| מספר חריגים | ✅ הנתונים קיימים במלואם, לא מוצגים בכלל בכרטיס הספק |
| שינויי מחירים לאורך זמן | ✅ הנתונים קיימים, דורשים join דו-שלבי |
| זמן אספקה ממוצע | ✅ נגזר מ-`sent_at` → `received_at` |
| אחוז עמידה בזמני אספקה | ⚠️ **עמודה קיימת, נתונים לא** — ראה סעיף 3 |
| דירוג ספק | ❌ **לא קיים בשום מקום** — ראה סעיף 3 |

---

## 3. טבלת היתכנות למדד

מקור אמת: `supabase/migrations/0001_init.sql`, ‏`0005_saas_hardening.sql`, ‏`0008_supplier_balance_role_guard.sql`.

| # | מדד | עמודות מקור (מאומתות) | שאילתה | הכרעה |
|---|---|---|---|---|
| 6 | **יתרת חוב** | `supplier_balances` view (`0008:82-91`) → `open_balance`, `open_invoices` | קיים; נצרך כבר ב-`Suppliers.tsx:24, 153` | ✅ **בר-מימוש — כבר עובד** |
| 5 | **מספר זיכויים** | `credit_requests.supplier_id`, `.status`, `.amount`, `.created_at` (`0001:230-244`) | `count/sum filter (status in ('open','requested','received'))` | ✅ **בר-מימוש** |
| 4 | **מספר חריגים** | `exceptions.supplier_id` (nullable), `.status`, `.severity`, `.created_at` (`0001:339-357`) | `count filter (status in ('open','in_progress'))` | ✅ **בר-מימוש** |
| 3 | **שינויי מחירים לאורך זמן** | `price_history(supplier_product_id, price, effective_date)` (`0001:118-126`) + `supplier_products.current_price/previous_price/price_effective_date` (`0001:102-116`) | join דו-שלבי `supplier_products → price_history`; מונים ב-view, כיוון/חציון בצד הלקוח | ✅ **בר-מימוש** |
| 7 | **זמן אספקה ממוצע** | `purchase_orders.sent_at` (`0001:159`) + `goods_receipts.received_at` (`0001:181`) | `avg(received_at::date − sent_at::date)` | ✅ **בר-מימוש** — כזמן **שליחה→קבלה** |
| 2 | **אחוז עמידה בזמני אספקה** | `purchase_orders.expected_date` (`0001:156`) + `goods_receipts.received_at` | `count filter (received ≤ expected) / count` | ⚠️ **העמודה קיימת, אף נתיב באפליקציה לא כותב אליה** |
| 1 | **דירוג ספק** | — | — | ❌ **דורש עמודה חדשה + הכרעה עסקית** |

---

### 3.א ⚠️ הממצא המרכזי — `expected_date` נקרא ולעולם לא נכתב

**העמודה קיימת בסכימה:**
```
supabase/migrations/0001_init.sql:156     expected_date date,
```
אין צורך במיגרציית סכימה עבור "עמידה בזמנים".

**אבל אף נתיב קוד ב-`src/` לא כותב אליה.** אומת ב-grep ממצה על כל הריפו — **כל** מופע הוא קריאה:

| מופע | סוג |
|---|---|
| `src/lib/types.ts:107` | הגדרת טיפוס בלבד |
| `src/pages/Orders.tsx:37` | עמודה בטבלה — תצוגה |
| `src/pages/Orders.tsx:113` | טקסט הודעת WhatsApp — תצוגה |
| `src/pages/Orders.tsx:198` | כותרת ההזמנה — תצוגה |
| `src/pages/Suppliers.tsx:216` | עמודה בטאב ההזמנות — תצוגה |
| `src/pages/Receiving.tsx:25` | `order(...)` — מיון בלבד |
| `src/pages/Receiving.tsx:47` | תצוגה |
| `src/pages/NewOrder.tsx:112-115` | **ה-insert היחיד ל-`purchase_orders` באפליקציה — משמיט את `expected_date`** |
| `src/pages/Orders.tsx:89-101` `setStatus()` | ה-update היחיד ל-`purchase_orders` — לעולם לא נוגע בעמודה |

**הכותב היחיד בכל הריפו הוא `supabase/demo/demo_seed.sql:299`** — נתוני הדמו.

> **תיקון להפניה מהתוכנית המשוחזרת:** התוכנית ציינה `supabase/seed.sql:232`. זה שגוי בקובץ הנוכחי — `supabase/seed.sql` הוא seed ניטרלי לדייר חדש באורך 72 שורות ואין בו הזמנות רכש כלל. הכותב הוא `supabase/demo/demo_seed.sql:299`.

**המשמעות המדויקת:** המדדים "אחוז עמידה בזמני אספקה" ו-"זמן אספקה ממוצע" ייראו נכונים מול הדמו וייתנו `null` **לצמיתות** בייצור. זו המלכודת: מדד שקורא בשקט `0%` — כלומר "הספק הזה תמיד מאחר" — כשהאמת היא "מעולם לא רשמנו תאריך מובטח".

`CLAUDE.md:31` מכריע את זה חד-משמעית: **מדד שאין לו נתונים מציג `—`, לא `0`. אפס הוא גם טענה על המציאות.**

**זו התפצלות דרכים, לא פרט מימוש** — היא נרשמת בסעיף 5 כהכרעה פתוחה #28, ולא מוכרעת כאן בשקט:

* **מסלול א׳** — מוסיפים נתיב כתיבה ל-`expected_date` (שדה תאריך ב-`NewOrder.tsx` ובמודל "הספק אישר" ב-`Orders.tsx`). שני המדדים הופכים לאמיתיים, אבל רק להזמנות **חדשות**.
* **מסלול ב׳** — לא מוסיפים. שני המדדים מוצגים `—` עם הסבר מרוסן, ולא מוצגים כלל ברשימה.

מסלול ג׳ ("להציג `0%`") אינו קיים.

#### התנגשות סמנטית שצריכה לעלות למשתמש

`Orders.tsx:113` ו-`:198` מתייגים את `expected_date` כ-**"אספקה מבוקשת"** (מה שאנחנו ביקשנו), בעוד `Orders.tsx:37` ו-`Suppliers.tsx:216` מתייגים אותה **"אספקה צפויה"**. מדידת דייקנות של ספק מול תאריך ש**אנחנו** ביקשנו אינה אותו דבר כמו מדידה מול תאריך ש**הוא** התחייב אליו.

**המלצה: לא להוסיף עמודת `promised_date` בשלב הזה.** קודם למלא את `expected_date` ולסגור את הסמנטיקה מול המשתמש. הוספת עמודת תאריך שנייה לפני שהראשונה בכלל מאוכלסת היא הקדמת המאוחר.

#### הסתייגות שנייה — `received_at` הוא זמן הקלטה, לא זמן הגעה

`goods_receipts.received_at` נקבע כשמסך קבלת הסחורה נשמר (`Receiving.tsx:123`), או ב-`default now()` של ה-DB כשנוצרת רשומה חדשה (`Receiving.tsx:127-129`) — לא כשהמשאית הגיעה בפועל. מכיוון שהקבלה מתבצעת ניידת ברציף זה קירוב סביר. **מיטיגציה: להשוות תאריכים, לא חותמות זמן.**

---

### 3.ב ❌ דירוג ספק — לא קיים, ולא ימציא את עצמו

**אומת ב-grep על כל `--include=*.sql --include=*.ts --include=*.tsx`: אין עמודת `rating` בשום מקום** — לא בסכימה, לא בטיפוסים, לא בקוד.

זו לא עבודת תצוגה. זו **עמודה חדשה + הכרעה עסקית**: מי מדרג, באיזה סולם, ידנית או מחושב.

**המלצה: דירוג ידני 1-5 שנשמר ב-`suppliers.rating`, מוצג ליד המדדים המחושבים — לעולם לא ממוזג לתוכם.**

למה ידני מנצח כאן:

* ציון משוקלל דורש **משקלות** (האם אספקה מאחרת אחת שווה שתי בקשות זיכוי?). זה בדיוק סוג ההנחה העסקית ש-`OPEN-DECISIONS.md:3` אוסר להמציא.
* הקלטים המחושבים עדיין לא אמינים: OTD חסום ב-`null`, ועם ~15 ספקים על פני חודשים בודדים המכנים זעירים. ספק עם 2 הזמנות יציג "50%" סמכותי למראה שהוא רעש טהור.
* דירוג ידני קולט מה שנתונים לא יכולים: מהירות תגובה ב-WhatsApp, נכונות לאספקת חירום ביום שישי, איכות התוצרת.
* עלות: עמודה אחת + ווידג׳ט 5 כפתורים ב-`SupplierForm` הקיים. ציון משוקלל הוא "בחינם" ושגוי.

**התמורה, בכנות:** דירוגים ידניים מתיישנים (אף אחד לא מעדכן), סובייקטיביים, ויהיו שונים בין מנהל המטבח למזכירה. שתי מיטיגציות קונקרטיות:

1. לשמור `rating_updated_at` ולרנדר "עודכן {תאריך}" — כך ההתיישנות **גלויה**.
2. למקם את הדירוג פיזית ליד הסקורקארד המחושב, כך שדירוג 5 כוכבים שיושב לצד "4 חריגים פתוחים" הוא סתירה **נראית לעין**, לא סתירה מוסתרת.

**דלת מילוט:** ה-view חושף את **כל** הקלטים הגולמיים. אם המשתמש יגדיר משקלות בהמשך, הציון המשוקלל הוא תוספת SQL טהורה — אפס שינויי לקוח.

---

## 4. מה לבנות

### 4.0 תיקוני הפניות — קרא לפני שאתה כותב SQL

התוכנית המקורית נכתבה מול מצב ריפו מוקדם יותר. אלה הפרטים שהשתנו ו**חייבים** להיות מיושמים:

| מה שהתוכנית אמרה | המצב בפועל | ההשלכה |
|---|---|---|
| מיגרציה `0005_supplier_metrics.sql` | `0005`-`0009` **תפוסים** (`0005_saas_hardening` … `0009_audit_allocation_org`) | המיגרציה החדשה היא **`0010_supplier_metrics.sql`** |
| להוסיף `auth_role()` guard ל-`supplier_balances` (סעיף 3 של ה-DDL) | **בוצע כבר** במיגרציה `0008` | **אל תריץ שוב.** `drop view supplier_balances` יפיל גם את ההגנה של `0008` |
| ליצור 5 אינדקסי FK | **כולם קיימים כבר** ב-`0005` | ראה 4.0.ב — יש כאן מלכודת no-op אמיתית |
| שורות 15-18 ב-`OPEN-DECISIONS.md` | המסמך מגיע כבר עד **#24** | השורות החדשות הן **25-28** |

#### 4.0.א למה אסור לגעת ב-`supplier_balances`

`0008` לא רק סגר את הדליפה שהתוכנית זיהתה — הוא הלך רחוק יותר, ובכוונה:

* **`supplier` הוסר** (`0008:23`) — בדיוק התיקון שהתוכנית הציעה. **כבר בוצע.**
* **`payer` הוצא במפורש** (`0008:42-47`), בניגוד למה שהתוכנית הציעה. הנימוק כתוב שם: ה-view מסכם את `invoice_balances`, כך שאגרגט שגלוי ל-`payer` היה מסכם בשקט רק את הפרוסה המוגבלת שלו מהחשבוניות. `open_balance` היה אומר דבר אחד ל-`owner` ודבר קטן יותר ל-`payer`, **תחת אותו שם עמודה, במערכת כספית**.
* **`invoice_balances` הוגן בנפרד** (`0008:60-80`) — כי הגנה על ה-view הפנימי בלבד לא מספיקה: ה-view החיצוני עושה LEFT JOIN, אז תפקיד חסום עדיין היה מקבל שורה לכל ספק עם `open_balance` אפס — הסכומים מוסתרים אבל **רשימת הספקים המלאה של הארגון עדיין ניתנת למניה**.

> **⚠️ `0008:53-55` — אזהרה מפורשת לעריכות עתידיות:** אף אחד מה-views לא חושף עמודת `org_id`, **וזה מה שמשאיר את בלוק ה-self-check של `0005:95-113` עובר**. הבלוק מפיל את המיגרציה עבור כל עמודת `org_id` ציבורית ללא אינדקס מוביל — ו-**view לא ניתן לאינדוקס**.
>
> **המסקנה עבור `supplier_metrics`: ה-view החדש חייב לסנן `org_id = auth_org()` בתוך ה-`where`, ואסור לו לחשוף עמודת `org_id` ב-`select`.** חשיפתה תפיל את המיגרציה הבאה שתריץ את ה-self-check.

#### 4.0.ב מלכודת ה-no-op באינדקסים

`0005` כבר יצר את כל אינדקסי ה-FK הרלוונטיים:

| אינדקס קיים | מיקום | על |
|---|---|---|
| `price_history_sp_idx` | `0005:62` | `price_history (supplier_product_id)` |
| `supplier_products_supplier_idx` | `0005:60` | `supplier_products (supplier_id)` |
| `purchase_orders_supplier_idx` | `0005:65` | `purchase_orders (supplier_id)` |
| `goods_receipts_order_idx` | `0005:69` | `goods_receipts (order_id)` |
| `credit_requests_supplier_idx` | `0005:77` | `credit_requests (supplier_id)` |
| `exceptions_supplier_idx` | `0005:91` | `exceptions (supplier_id)` |

הסכנה הקונקרטית: התוכנית המקורית הציעה
```sql
create index if not exists price_history_sp_idx on price_history (supplier_product_id, effective_date);
```
**זה יהיה no-op שקט.** ‏`if not exists` בודק את **השם**, לא את ההגדרה — האינדקס בעל השם הזה כבר קיים על עמודה אחת בלבד. המיגרציה תעבור בהצלחה והאינדקס הדו-עמודתי לעולם לא ייווצר.

**ההנחיה: לא להוסיף אינדקסים בשלב הזה.** האינדקסים הקיימים מכסים את כל ה-joins של ה-view. אם פרופיילינג יראה צורך באמת באינדקס מורכב — ליצור אותו תחת **שם חדש** (למשל `price_history_sp_date_idx`), אף פעם לא למחזר שם קיים.

---

### 4.1 מיגרציה — `supabase/migrations/0010_supplier_metrics.sql` (חדש)

מריצים עם `scripts/db-query.ps1`.

**עקרון RLS מחייב** (התקדים של `0003`, המנומק ב-`0008:4-7`): views אגרגטיביים כאן הם **SECURITY DEFINER** — כלומר **משמיטים** `security_invoker` — ומגנים על ארגון **ותפקיד** **בתוך** ה-view. הסיבה: הטבלאות שמתחת נושאות RLS צר יותר מהקהל המיועד לאגרגט (משתמש `kitchen` צריך לראות מדדים בלי גישה ל-`payment_allocations`).

> `auth_org()` הוגדרה מחדש ב-`0006:79-86` וכוללת כעת גם דחייה של ארגון `suspended`. השימוש בה נשאר זהה.

```sql
-- 0010: מדדי תמיכה בהחלטות פר-ספק (סעיף 4 של "המשך פיתוח").
-- דפוס 0003/0008: view אגרגטיבי הוא SECURITY DEFINER (ללא security_invoker)
-- ומגן על org + role בתוך ה-WHERE שלו.
-- אסור לחשוף org_id בעמודות ה-select — ראה 0008:53-55 ובלוק ה-self-check ב-0005:95.

-- ===== 1. דירוג ספק ידני (הכרעה פתוחה #25) =====
alter table suppliers add column rating smallint check (rating between 1 and 5);
alter table suppliers add column rating_updated_at timestamptz;
alter table suppliers add column rating_note text;

comment on column suppliers.rating is
  'דירוג איכות ידני 1-5 שמזין הצוות. במכוון אינו ציון משוקלל מחושב: '
  'קביעת המשקלות היא הכרעה עסקית — docs/OPEN-DECISIONS.md #25.';

-- ===== 2. view המדדים =====
-- חלון: 180 יום (הכרעה פתוחה #26). מונים "אי פעם" נשמרים לצידו.
create view supplier_metrics as
with cfg as (
  select (now() - interval '180 days') as since
),
deliveries as (
  select po.supplier_id,
         po.expected_date,
         po.sent_at,
         (select min(g.received_at)
            from goods_receipts g
           where g.order_id = po.id and g.status = 'completed') as received_at
  from purchase_orders po
  where po.org_id = auth_org()
    and po.status in ('received', 'partial')
),
d as (
  select v.supplier_id,
    count(*) filter (where v.expected_date is not null)                      as otd_samples,
    count(*) filter (where v.expected_date is not null
                       and (v.received_at at time zone 'Asia/Jerusalem')::date
                           <= v.expected_date)                               as otd_on_time,
    count(*) filter (where v.sent_at is not null)                            as lead_samples,
    avg( (v.received_at at time zone 'Asia/Jerusalem')::date
       - (v.sent_at     at time zone 'Asia/Jerusalem')::date )
      filter (where v.sent_at is not null)                                   as avg_lead_days
  from deliveries v, cfg
  where v.received_at is not null
    and v.received_at >= cfg.since
  group by v.supplier_id
),
x as (
  select e.supplier_id,
    count(*) filter (where e.status in ('open','in_progress'))               as open_exceptions,
    count(*) filter (where e.created_at >= (select since from cfg))          as exceptions_window,
    count(*)                                                                 as exceptions_lifetime
  from exceptions e
  where e.org_id = auth_org() and e.supplier_id is not null
  group by e.supplier_id
),
c as (
  select cr.supplier_id,
    count(*) filter (where cr.status in ('open','requested','received'))     as open_credits,
    coalesce(sum(cr.amount) filter (where cr.status in ('open','requested','received')), 0)
                                                                             as open_credits_amount,
    count(*) filter (where cr.created_at >= (select since from cfg))         as credits_window,
    count(*)                                                                 as credits_lifetime
  from credit_requests cr
  where cr.org_id = auth_org()
  group by cr.supplier_id
),
p as (
  select sp.supplier_id,
         count(distinct sp.id)   as priced_items,
         count(h.id)             as price_changes_window,
         max(h.effective_date)   as last_price_change
  from supplier_products sp
  left join price_history h
         on h.supplier_product_id = sp.id
        and h.effective_date >= (select since::date from cfg)
  where sp.org_id = auth_org()
  group by sp.supplier_id
)
select s.id as supplier_id,
  coalesce(d.otd_samples, 0)                                   as otd_samples,
  coalesce(d.otd_on_time, 0)                                   as otd_on_time,
  case when coalesce(d.otd_samples, 0) = 0 then null
       else round(d.otd_on_time::numeric * 100 / d.otd_samples, 0)
  end                                                          as on_time_pct,
  coalesce(d.lead_samples, 0)                                  as lead_samples,
  round(d.avg_lead_days::numeric, 1)                           as avg_lead_days,
  coalesce(x.open_exceptions, 0)                               as open_exceptions,
  coalesce(x.exceptions_window, 0)                             as exceptions_window,
  coalesce(x.exceptions_lifetime, 0)                           as exceptions_lifetime,
  coalesce(c.open_credits, 0)                                  as open_credits,
  coalesce(c.open_credits_amount, 0)::numeric(12,2)            as open_credits_amount,
  coalesce(c.credits_window, 0)                                as credits_window,
  coalesce(c.credits_lifetime, 0)                              as credits_lifetime,
  coalesce(p.priced_items, 0)                                  as priced_items,
  coalesce(p.price_changes_window, 0)                          as price_changes_window,
  p.last_price_change
from suppliers s
left join d on d.supplier_id = s.id
left join x on x.supplier_id = s.id
left join c on c.supplier_id = s.id
left join p on p.supplier_id = s.id
where s.org_id = auth_org()
  and s.deleted_at is null
  and auth_role() in ('owner','office','kitchen','accountant');
```

הערות מחייבות על ה-DDL:

* **רשימת התפקידים תואמת בדיוק את `0008:90`** ואת ה-`READERS` של `App.tsx:57`. ‏`supplier` מוחרג (סוכן ספק אסור לו לראות מדדים של מתחרים — הנחת היסוד של `0004`). ‏`payer` מוחרג מאותו נימוק שנוסח ב-`0008:42-47`.
* **`on_time_pct` הוא `null`, לא `0`, כשאין דגימות.** ה-`case` קיים בדיוק בשביל זה. זהו יישום `CLAUDE.md:31` ברמת ה-DB — לא רק ברמת התצוגה.
* **אזור זמן:** ‏`sent_at`/`received_at` הם `timestamptz`, וסשן Supabase הוא UTC כברירת מחדל. ההמרה המפורשת `at time zone 'Asia/Jerusalem'` לפני `::date` היא הכרחית — בלעדיה הזמנות שנשלחו בערב יקבלו תאריך שגוי.
* **קבלות חלקיות:** הזמנה עם כמה `goods_receipts` משתמשת ב-`min(received_at)` (ההגעה הראשונה). נרשם כהכרעה פתוחה #27, לא מונח בשקט.
* **אין `org_id` ב-select.** ראה 4.0.א.

**אימות מיד אחרי ההרצה:**
```sql
select supplier_id, on_time_pct, otd_samples, avg_lead_days, open_exceptions, open_credits
from supplier_metrics order by on_time_pct nulls last limit 10;
```
מצופה: ‏`on_time_pct` **לא-null רק** עבור הזמנות ה-seed (`demo/demo_seed.sql:299`). הפיצול הזה בין null ללא-null הוא **ההוכחה הישירה** לפער שתואר ב-3.א.

---

### 4.2 `src/lib/types.ts`

* **שורות 66-74** — ל-`Supplier` להוסיף: `rating: number | null; rating_updated_at: string | null; rating_note: string | null;`
  > תיקון: התוכנית ציינה `types.ts:25-33`. `Supplier` נמצא כיום ב-**66-74**; שורות 25-33 הן `Organization.settings`.
* **אחרי שורה 137** (ליד `InvoiceBalance`, לפי מוסכמת טיפוסי-view הקיימת) — להוסיף `interface SupplierMetrics` שמשקף את 16 עמודות הפלט של ה-view. שדות ה-`null`-ability חייבים להיות מדויקים: `on_time_pct: number | null`, `avg_lead_days: number | null`, `last_price_change: string | null`; כל השאר `number`.
  > תיקון: התוכנית ציינה "אחרי שורה 96". `InvoiceBalance` נמצא ב-**137**.

### 4.3 `src/lib/format.ts` (נספח אחרי שורה 27)

שני פורמטרים בלבד, בדיוק לפי הקונבנציה הקיימת (`fmtMoney` ב-`:8` מחזיר `'—'` על `null`):

* `fmtPct(v: number | null)` → `'—'` או `` `${Math.round(v)}%` ``
* `fmtLeadDays(v: number | null)` → `'—'` או `` `${v.toFixed(1)} ימים` ``

### 4.4 `src/components/ui.tsx` — למה **לא** `KpiCard`

**המלצה: קומפוננטת `Scorecard` חדשה. לא `KpiCard`.**

`KpiCard` (`ui.tsx:35-47`) שגוי כאן משלוש סיבות, כולן מאומתות בקוד:

1. **נפח.** הוא `text-xl font-bold` (`ui.tsx:43`) בתוך `card card-pad` (`ui.tsx:41`). שמונה כאלה = רשת שתי-שורות של כרטיסים שמנים ששולטת בכל מה שמעל הטאבים — בדיוק **"הפיכת כל דף לרשת כרטיסים מנופחת"** ש-`CLAUDE.md:49` אוסר. ארבעת הכרטיסים הנוכחיים כבר אוכלים שורה מלאה; הכפלה לשמונה מכפילה אותה.
2. **סמנטיקה.** הוא `<button onClick disabled={!onClick}>` עם `hover:border-indigo-300` (`ui.tsx:40-41`). זה נכון ב-`Dashboard` שם כל כרטיס מנווט; בכרטיס הספק רוב המדדים האלה לא מנווטים לשום מקום, ו-affordance של לחיצה שלא מובילה לכלום הוא שקר ויזואלי.
3. **טיפוסים.** ה-union הפנימי שלו (`ui.tsx:36`) הוא `'slate' | 'green' | 'amber' | 'red' | 'blue'` — **חסר `violet`** לעומת `Tone` הקנוני ב-`status.ts:2`, ואין בו מצב "אין נתונים עדיין", שהוא בדיוק מה ש-OTD צריך מהיום הראשון.

**העיצוב:** `card card-pad` **אחד** שמכיל `grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-x-6 gap-y-4` של תאים קומפקטיים.
תווית `text-xs font-medium text-slate-500`, ערך `text-base font-semibold text-slate-900 num`, ותת-שורה אופציונלית `text-xs text-slate-400`.
זה נקרא כ**אובייקט אחד — גיליון מפרט** — במקום שמונה אריחי דשבורד מתחרים, והנפח האנכי שלו בערך זהה לשורת ארבעת הכרטיסים הקיימת.

שני פרטים קריטיים:

* **להימנע מ-`divide-x`.** ‏`divide-x` של Tailwind קובע גבולות left/right פיזיים ודורש `divide-x-reverse` תחת RTL — מלכודת ידועה, ומנוגד ל-`CLAUDE.md:43` (properties לוגיים בלבד). להשתמש בהפרדה מבוססת `gap`, שהיא agnostic לכיוון.
* **ניגודיות.** ‏`CLAUDE.md:49` אוסר טקסט זעיר בניגודיות נמוכה. תוויות ב-`text-xs text-slate-500` תואמות למוסכמה הקיימת (`.th` ב-`index.css:41`, ושורה `195` היום), אבל **ערכים** חייבים להיות `text-base`/`text-slate-900` לכל הפחות — לעולם לא `text-xs`.

**הדירוג לא נכנס לרצועה.** מקומו בכותרת, ליד `StatusBadge` (`Suppliers.tsx:182`) — הוא **תכונה** של הספק, לא **מדידה**.

**כלל ריקנות (לא נתון למשא ומתן):** כל מדד עם מכנה 0 מרנדר `—` בתוספת הסבר מרוסן. לעולם לא `0%`.

**קומפוננטות להוסיף:**

* **`Scorecard` + `ScoreItem`** — מיד אחרי `KpiCard` (אחרי `ui.tsx:47`), כדי שההבחנה בין השתיים תהיה גלויה לקורא הבא. ‏`ScoreItem = { label: string; value: string; sub?: string; tone?: Tone }`. לייבא `Tone` מ-`../lib/status` (`status.ts:2`) ולא לשכפל את ה-union הצר של `KpiCard`. ‏~25 שורות.
* **`RatingStars`** — `{ value: number | null; onChange?: (n: number) => void }`. קריאה-בלבד כש-`onChange` מושמט. ‏`Star` מ-`lucide-react` עם `fill-amber-400 text-amber-400` למלא ו-`text-slate-300` לריק. הווריאנט האינטראקטיבי משתמש בכפתורים עם סמנטיקת `radiogroup` (`aria-checked`) כדי שיהיה נגיש במקלדת. ‏~20 שורות.

### 4.5 `src/components/PriceSparkline.tsx` (קובץ חדש, ~30 שורות)

מופרד ולא inline, כי `PriceLists.tsx` ירצה אותו גם.
`LineChart width={96} height={28}`, ללא צירים/רשת/tooltip/legend, `dot={false}`. משיכה: `rose-500` בעלייה / `emerald-500` בירידה / `slate-400` בשטוח.

אילוצי מימוש מחייבים:

* **`isAnimationActive={false}`** — 15 sparklines שמונפשות בפתיחת טאב הן בדיוק "אנימציות מוגזמות" ש-`CLAUDE.md:49` אוסר.
* **ללא `ResponsiveContainer`** ב-96px — מידות קבועות. ‏`DataTable` ממילא מעמד 15 שורות (`ui.tsx:134`), אז רק 15 מרונדרות בו-זמנית.
* **`type="stepAfter"`** — ‏`price_history` רושם רק **שינויים**, כך שהסדרה היא פונקציית מדרגות ולא קו רציף. להחזיר `null` מתחת ל-2 נקודות.
* **לעטוף ב-`dir="ltr"`**, בהתאמה ל-`Dashboard.tsx:168, 185, 202`.
* `recharts@^2.15.0` כבר תלות (`package.json:20`) וכבר בשימוש ב-`Dashboard.tsx`. אפס משקל חדש ל-bundle.

### 4.6 `src/pages/Suppliers.tsx` — עיקר העבודה

> כל מספרי השורות בסעיף הזה **אומתו** מול הקובץ הנוכחי (254 שורות).

#### רשימה — `SuppliersList`

הרשימה עונה על "**מי דורש את תשומת ליבי**"; הכרטיס עונה על "**למה**". 8 עמודות היום; הוספת 7 הופכת אותה לבלתי שמישה ב-RTL על לפטופ.

**להוסיף שתיים, להסיר אחת — נטו 9 עמודות:**

| פעולה | עמודה | נימוק |
|---|---|---|
| ➕ | `rating` (דירוג) | ניתנת למיון — כל הפואנטה היא "הראה לי את הספקים הגרועים שלי". לרנדר `★ 4` (גליף אחד + מספר), **לא** 5 אייקוני כוכב: 5 × 15 שורות = 75 גליפים, הפרה של דרישת ה"רגוע" ב-`CLAUDE.md:47` |
| ➕ | `risk` (התראות) | תא ממוזג אחד: חריגים פתוחים + זיכויים פתוחים כשני badges קטנים לכל היותר, `—` כשנקי. ברובו ריק ⇒ רגוע כברירת מחדל, רועש רק על בעיה אמיתית. **זו** עמודת התמיכה-בהחלטות |
| ➖ | `days` (ימי אספקה), **שורה 36** | נתון ייחוס, לא נתון החלטה. העמודה הרחבה ביותר בעלת הערך הנמוך ביותר. מועברת לשורת המטא בכרטיס |
| ❌ לא ברשימה | עמידה בזמנים · זמן אספקה ממוצע · מגמת מחיר · פירוט זיכויים/חריגים | OTD היה קורא `—` בכל שורה ביום הראשון. עמודה שמקוּוקוות לצמיתות גרועה מהיעדר עמודה |

שינויים ברמת השורה:

* **שורות 12-15** — ל-`SupplierWithBalance` להוסיף `metrics?: SupplierMetrics`.
* **שורות 22-27** — להוסיף fetch שלישי ל-`supplier_metrics`, לבנות `metMap`, ולמזג בשורה 26. **תוך כדי:** להמיר את שתי ה-`await` הסדרתיות (`:23`, `:24`) ל-`Promise.all` אחד — אותה צורה כמו שאילתת הכרטיס ב-`:148-154`.
* **שורות 31-40** — טבלת העמודות לפי הטבלה למעלה. ‏`rating` אחרי `name` (`:32`) עם `className: 'num'` (`CLAUDE.md:43`) ו-`sortValue: (r) => r.rating ?? 0` (ספק לא מדורג ממוין ליד הגרועים — חשיפת פער הדירוג היא כשלעצמה מועילה). ‏`risk` לפני `status` (`:39`), משתמש ב-`badge-red` (`index.css:36`) לחריגים ו-`badge-amber` (`index.css:35`) לזיכויים.
* **שורה 52** — `searchFn`: אופציונלי להרחיב ל-`tax_id` (זול, ניצחון לא קשור).

#### `SupplierForm`

* **שורות 63-71** (state) — להוסיף `rating`, `rating_note`.
* **שורות 78-84** (payload) — להוסיף `rating`, `rating_note`, וכן
  `rating_updated_at: f.rating !== (supplier?.rating ?? null) ? new Date().toISOString() : supplier?.rating_updated_at ?? null`
  (חותמת זמן מתעדכנת רק כשהדירוג עצמו השתנה — אחרת "עודכן" משקר).
* **ליד שורות 122-127** (הצמוד ל-select הסטטוס) — שדה `דירוג ספק` עם `RatingStars` אינטראקטיבי, ובנוסף שדה `rating_note` ב-`sm:col-span-2` עם `placeholder="למה הדירוג הזה?"`.

#### `SupplierCard`

* **שורה 143** — ל-union הטאבים להוסיף `| 'prices'`.
* **שורות 146-163** (השאילתה) — להוסיף ל-`Promise.all` הקיים: ‏`supplier_metrics` (‏`.eq('supplier_id', id).maybeSingle()` — **`maybeSingle` ולא `single`**, כי ספק ללא פעילות עלול לא להחזיר שורה) ו-`supplier_products` (‏`select('*, product:products(id,name,unit)')`). אחריהן fetch נוסף ל-`price_history` עם `.in('supplier_product_id', spIds)`, מוגן ב-`spIds.length > 0`.
* **שורה 182** (הכותרת) — לצרף `<RatingStars value={s.rating} />` אחרי `StatusBadge`, עם `עודכן {fmtDate(s.rating_updated_at)}` מרוסן ו-`title={s.rating_note}`.
* **שורות 183-189** (שורת המטא) — **להוסיף כאן `ימי אספקה`** (`fmtDays(s.delivery_days)`). מקומו עם עובדות הקשר/הלוגיסטיקה, וזה מפצה על הסרתו מהרשימה.
* **שורות 194-199 — להחליף** את 4 הכרטיסים הידניים ב-`<Scorecard items={[...]} />` אחד עם 8 תאים:

  | # | תווית | ערך | גוון |
  |---|---|---|---|
  | 1 | יתרה פתוחה | `fmtMoneyExact(data.balance)` | `>0 ? amber : green` |
  | 2 | עמידה בזמנים | `fmtPct(m.on_time_pct)`, תת-שורה `${m.otd_samples} אספקות` — או **`אין תאריך אספקה מוזן`** כש-`otd_samples === 0` | כלל ה-N-הקטן למטה |
  | 3 | זמן אספקה ממוצע | `fmtLeadDays(m.avg_lead_days)`, תת-שורה `מהשליחה ועד קבלה` | `slate` |
  | 4 | חריגים פתוחים | `m.open_exceptions`, תת-שורה `${m.exceptions_lifetime} בסה״כ` | `>0 ? red : slate` |
  | 5 | זיכויים פתוחים | `m.open_credits`, תת-שורה `fmtMoney(m.open_credits_amount)` | `>0 ? amber : slate` |
  | 6 | שינויי מחיר (180 יום) | `m.price_changes_window`, תת-שורה `${m.priced_items} פריטים` | `slate` |
  | 7 | מינימום הזמנה | `fmtMoney(s.min_order_amount)` | `slate` |
  | 8 | תנאי תשלום | `s.payment_terms ?? '—'` | `slate` |

  **כלל ה-N-הקטן לתא 2:** הגוון הוא `green ≥90 / amber ≥75 / red <75`, **אבל נכפה `slate` כש-`otd_samples < 5`**. תג אדום שנגזר מ-3 אספקות הוא שקר בטון בטוח. התת-שורה **תמיד** נושאת את המכנה.

* **שורות 167-172** (הטאבים) — להוסיף `{ key: 'prices', label: \`מחירים (${data.prices.length})\` }`.
* **אחרי שורה 245** — `{tab === 'prices' && <SupplierPricesTab rows={data.prices} history={data.history} />}`, קומפוננטה מקומית חדשה (~70 שורות) שנשמרת **בתוך** `Suppliers.tsx` (היא לא בשימוש בשום מקום אחר). הקובץ יגיע ל-~400 שורות, בתוך נורמות הקודבייס (`Dashboard.tsx` 300, `Receiving.tsx` 297, `PriceLists.tsx` 270).

> ⚠️ **התנגשות שמות שצריך להימנע ממנה:** כבר קיים `src/pages/SupplierPrices.tsx` — פורטל **סוכן הספק** ב-`/my-prices`, מוגן ל-`['supplier']` (`App.tsx:133`), ה-**מסך היחיד** שהתחברות של ספק יכולה להשתמש בו (`SupplierPrices.tsx:13-15`). הקומפוננטה החדשה חייבת להישאר מקומית ל-`Suppliers.tsx` ולא ליצור קובץ בשם דומה.

#### תוכן טאב "מחירים"

**המלצה: טאב חמישי לצד ארבעת הקיימים** (`Suppliers.tsx:203-210`), לא גרף על הסקורקארד. רצועת הטאבים היא הדפוס המבוסס, מוסכמת המונה בתווית עובדת (`מחירים (24)`), והוא עולה אפס מקום אנכי כשהוא סגור. גרף שמוברג לסקורקארד יהיה "גרף מיותר" (`CLAUDE.md:49`) עבור ~90% מהביקורים, שעוסקים ביתרה ובחשבוניות.

לפי הסדר:

1. **שורת סיכום בת 3 מספרים** — פריטים שעלו / ירדו / חציון שינוי ב-% (180 יום אחרונים). זו תשובת ההחלטה בפועל; מחושבת בצד הלקוח.
2. **`DataTable`** של `supplier_products` של הספק מצורף ל-`products`. עמודות: מוצר · מחיר נוכחי · מחיר קודם · שינוי % · מגמה (sparkline) · בתוקף מ־ · היסטוריה. **לשכפל בדיוק את טיפול ה-`TrendingUp`/`TrendingDown` מ-`PriceLists.tsx:47-56`** — הוא כבר קיים והוא טוב.
3. **Sparkline in-row** לפי המפרט ב-4.5.

**הושמט במכוון:** גרף קו "מדד מחירים" ברמת הספק. הוא דורש הכרעת שקלול (לפי היקף רכש? משקל שווה?) — עוד הנחה עסקית מומצאת — ועם היסטוריה דלילה הוא יהיה קו כמעט שטוח. מציין את ההשמטה במקום לשלוח גרף חסר משמעות.

#### למה view ב-Postgres ולא חישוב בצד הלקוח

לחקות את תקדים `supplier_balances` בדיוק (`Suppliers.tsx:24-26` — למשוך אגרגטים ולמזג ל-`Map`). למשוך כל שורת הזמנה + קבלה + חריג + זיכוי לדפדפן רק כדי לעשות עליהן `.length` הוא O(כל ההיסטוריה) בכל טעינת דף, ו**הרשימה צריכה את זה לכל 15 הספקים בבת אחת**.

### 4.7 `NewOrder.tsx` + `Orders.tsx` — שלב ד׳ (מותנה בהכרעה #28)

**רק אם ההכרעה הפתוחה #28 נענית "כן, מוסיפים נתיב כתיבה".**

* **`NewOrder.tsx:112-115`** — להוסיף `expected_date` ל-insert של `purchase_orders`. שדה תאריך ליד שדה ההערות, **עם ברירת מחדל ליום האספקה הבא של הספק** הנגזר מ-`supplier.delivery_days` — נתון שכבר קיים, שהופך את השדה לכמעט חסר חיכוך.
* **`Orders.tsx:239-255`** — להוסיף שדה תאריך למודל "אישור קבלת הזמנה ע״י הספק" הקיים, ולכתוב אותו לצד `confirmed_at`/`confirmation_note` דרך פרמטר `extra` הקיים של `setStatus()` (`Orders.tsx:89`). זה כמעט בחינם: המודל, נתיב הכתיבה, ורישום ה-audit — כולם כבר קיימים.
  > תיקון: התוכנית ציינה `Orders.tsx:236-252` למודל ו-`:86` ל-`setStatus`. בקובץ הנוכחי המודל הוא **239-255** ו-`setStatus` מוגדרת ב-**89** (גוף 89-101).
* הזמנות שקדמו לשינוי יישארו `null` — וזה **נכון**: מכנה `otd_samples` ב-view מחריג אותן במפורש, כך שהאחוז לא ידולל.

### 4.8 מסמכים

* **`docs/OPEN-DECISIONS.md`** — שורות **25-28** (סעיף 5 להלן). לא 15-18: המסמך מגיע כבר עד #24 (`OPEN-DECISIONS.md:35`).
* **`docs/ARCHITECTURE.md:31-33`** — להוסיף `0010 מדדי ספקים` לרשימת המיגרציות.
  > תיקון: התוכנית ציינה `ARCHITECTURE.md:24`. רשימת המיגרציות היא **31-33**.
  > הערה צדדית: הרשימה שם מסתיימת ב-`0008` ואינה מזכירה את `0009_audit_allocation_org` — פער תיעוד שקדם לעבודה הזו.
* **`docs/ARCHITECTURE.md:46`** — שורת `/suppliers` במפת המסכים; להזכיר סקורקארד + טאב מחירים.
  > תיקון: התוכנית ציינה `:35`. השורה היא **46**.
* **`docs/PROGRESS.md`** — לעדכן לפי המוסכמה הקיימת של הקובץ.

### 4.9 סדר ביצוע

**שלב א׳ — שחרור חסימה (ללא סיכון UI)**
1. לכתוב ולהריץ `0010_supplier_metrics.sql`; לאמת עם שאילתת האימות.
2. תוספות `types.ts`.

**שלב ב׳ — מדדים כנים (ניתן למשלוח עצמאי)**
`format.ts` ⟶ `ui.tsx` (`Scorecard` + `RatingStars`) ⟶ מיזוג שאילתת הרשימה + 2 עמודות + הסרת `days` ⟶ סקורקארד בכרטיס במקום 194-199 + דירוג בכותרת ⟶ שדות הדירוג ב-`SupplierForm`.

**שלב ג׳ — מגמת מחירים**
`PriceSparkline.tsx` ⟶ הרחבת שאילתת הכרטיס ⟶ טאב + `SupplierPricesTab`.

**שלב ד׳ — הופך את OTD לאמיתי** *(מותנה בהכרעה #28)*
שדה תאריך ב-`NewOrder.tsx` ⟶ תאריך במודל האישור ב-`Orders.tsx`.

> **משלוח ב׳ בלי ד׳ פירושו ש"עמידה בזמנים" תקרא `—` לנצח.** שלב ד׳ קטן — שני שדות תאריך על טפסים קיימים — והוא מה שהופך את מדד #2 ומחצית ממדד #7 מקישוט לאות. אבל **הוא לא מוכרע כאן** — הוא הכרעה עסקית של המשתמש (‏#28), לא בחירת מימוש.

שלבים ב׳, ג׳, ד׳ בלתי-תלויים אחרי א׳ וניתנים להרצה במקביל.

---

## 5. הכרעות פתוחות

`CLAUDE.md:29` ו-`OPEN-DECISIONS.md:3` אוסרים להמציא תשובות עסקיות. **אף אחת מהשורות האלה אינה מוכרעת בקוד לפני שהמשתמש עונה.** המספור ממשיך מ-#24, הרשומה האחרונה הקיימת.

| # | שאלה | ברירת המחדל המוצעת | איפה משנים |
|---|---|---|---|
| 25 | **דירוג ספק — ידני או מחושב?** | ידני 1-5 ע״י הצוות. **ציון משוקלל לא הומצא** — נוסחת המשקלות היא הכרעה עסקית. ה-view חושף את כל הקלטים הגולמיים, כך שמעבר לציון מחושב יהיה תוספת SQL בלבד | `suppliers.rating` · `0010` |
| 26 | **חלון מדידת המדדים** | 180 יום אחרונים; מונים "אי פעם" מוצגים לצידם בתת-שורה | `supplier_metrics` (‏CTE ‏`cfg`) |
| 27 | **מה נחשב "בזמן"** | תאריך הקבלה **המושלמת הראשונה** ≤ `expected_date`, ללא ימי חסד. אספקה חלקית בזמן אינה נספרת כאיחור — הפער נמדד דרך זיכויים/חריגים | `supplier_metrics` (‏CTE ‏`deliveries`) |
| 28 | **`expected_date` אינו נקלט כיום — האם מוסיפים נתיב כתיבה?** | **⚠️ טעונה הכרעה, אין ברירת מחדל.** מסלול א׳: להוסיף שדה תאריך ב-`NewOrder.tsx` ובמודל האישור ב-`Orders.tsx` — שני המדדים הופכים לאמיתיים, אך רק להזמנות חדשות. מסלול ב׳: לא להוסיף — "עמידה בזמנים" ו"זמן אספקה" מציגים `—` לצמיתות ולא מופיעים ברשימה. **בשני המסלולים לעולם לא `0%`** (`CLAUDE.md:31`) | `NewOrder.tsx:112-115` · `Orders.tsx:239-255` |
| 29 | **סמנטיקת התאריך** | האם `expected_date` הוא "אספקה מבוקשת" (מה שאנחנו ביקשנו, `Orders.tsx:113, 198`) או "אספקה צפויה" (מה שהספק התחייב, `Orders.tsx:37` · `Suppliers.tsx:216`)? המערכת מתייגת אותו **בשתי הצורות היום.** ברירת מחדל מוצעת: לאחד את התוויות **לפני** שמודדים דייקנות. עמודת `promised_date` נפרדת נדחית עד שהראשונה מאוכלסת | `status.ts` + תוויות ב-`Orders.tsx` |

---

## 6. אימות

**`npm run build` הוא השער האוטומטי היחיד** (`CLAUDE.md:38`, `package.json:8`):
```
npm run build     # = tsc --noEmit && vite build
```
**אין linter. אין טסטים.** אין רשת ביטחון אוטומטית שנייה — מה ש-`tsc` לא תופס, תופס רק אדם.

לפי `CLAUDE.md`, את הפקודה הזו **אין לשרשר** עם פקודות ברמת הרשאה אחרת (`git add`/`commit`) — קריאות נפרדות.

### מה `tsc` יתפוס וממה להיזהר

* `strict` פועל ⟹ `on_time_pct: number | null` יאלץ טיפול בכל אתר צריכה. זו תכונה, לא מטרד: זה מה שמונע `0%` שקרי.
* `tsc` **לא** יתפוס: `supplier_metrics` שמחזיר צורה שונה מ-`SupplierMetrics`. טיפוסי ה-view נכתבים ידנית (`types.ts:137`), לא נגזרים. **חובה לוודא מול פלט שאילתת האימות** בסעיף 4.1.

### אימות DB

לפני נגיעה כלשהי בלקוח, להריץ את שאילתת האימות מסעיף 4.1 דרך `scripts/db-query.ps1`. הקריטריון המפורש: **`on_time_pct` לא-null רק עבור שורות ה-seed.** ‏`0%` גורף או ערך לא-null גורף = באג ב-view.

**לוודא במפורש שבלוק ה-self-check של `0005:95-113` עדיין עובר** אחרי הרצת `0010` — כלומר ש-`supplier_metrics` אינו חושף עמודת `org_id` (‏`0008:53-55`).

### אימות ויזואלי — חובה

`CLAUDE.md:53`: **שינוי ויזואלי — צילום מסך של התוצאה, לא הסתמכות על הזיכרון.** אין להכריז "בוצע" על אף פריט למטה בלי צילום מסך:

```
npm run dev       # פורט 5199
```

| מה לצלם | מה חייב להיראות |
|---|---|
| `/suppliers` — 9 העמודות | עמודת `risk` **ריקה** ברוב השורות; ‏`rating` כ-`★ 4` יחיד; ‏`days` נעלמה |
| `/suppliers/:id` — הסקורקארד | `card` **אחד**, לא רשת של 8 כרטיסים (`CLAUDE.md:49`) |
| **ספק ללא נתונים** | "עמידה בזמנים" = `—` עם הסבר, **לא `0%`** — זה תרחיש האימות היחיד הכי חשוב במסמך |
| ספק עם `otd_samples < 5` | הגוון `slate`, לא אדום/ירוק |
| טאב מחירים | Sparklines סטטיות (ללא אנימציה), מדרגות, ללא צירים |
| RTL | הסקורקארד ללא `divide-x`; כל התאים המספריים `.num` (`index.css:49`) |
| מובייל (‏`grid-cols-2`) | הסקורקארד לא גולש |

**בדיקת RTL/הרשאות אחרונה:** לוודא ש-`accountant` (‏`READERS`, `App.tsx:57`) רואה את הסקורקארד, ושמשתמש `supplier` — שהמסך היחיד שלו הוא `/my-prices` (‏`App.tsx:133`) — לא מקבל שום גישה. ה-`auth_role()` guard ב-view הוא שכבת ההגנה השנייה מאחורי ה-`Guard` של הנתב.
