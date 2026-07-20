# 5 — מנוע חיפוש גלובלי

תוכנית מימוש ברמת שורה לסעיף 5 מתוך `NIR-APP-DOCS/המשך פיתוח.txt`.
כל הפניית `file:line` במסמך נפתחה ואומתה מול המצב הנוכחי של הריפו לפני הכתיבה.

---

## 1. מה ניר ביקש

מתוך המקור, סעיף 5 במלואו:

> **5. מנוע חיפוש גלובלי**
>
> יש להוסיף מנוע חיפוש מהיר וקבוע בראש המערכת.
>
> החיפוש יאפשר איתור מיידי של:
>
> * ספק.
> * מוצר.
> * חשבונית.
> * הזמנה.
> * תשלום.
> * זיכוי.
>
> ללא צורך במעבר בין מסכים.

שלוש דרישות שנגזרות מהניסוח, וכל אחת מהן מכתיבה החלטה טכנית בהמשך:

| הניסוח | המשמעות המימושית |
|---|---|
| "מהיר" | חיפוש חי תוך כדי הקלדה — לא כפתור "חפש". debounce ולא round-trip לכל תו |
| "קבוע בראש המערכת" | רכיב ב-layout, לא דף. נוכח בכל מסך, לא רק בדשבורד |
| "ללא צורך במעבר בין מסכים" | התוצאות מוצגות במקום (overlay/dropdown), והמעבר קורה רק כשבוחרים תוצאה |

שש הישויות הן **רשימה סגורה**. `payment_requests` (דרישות תשלום), `bank_transactions` ו-`exceptions` לא מופיעים בה — הוספת ישות שביעית היא בלוק `UNION` נוסף, אבל היא **מחוץ להיקף** עד שניר יבקש.

---

## 2. מה קיים היום

### אין חיפוש גלובלי. יש 14 חיפושים מקומיים.

החיפוש היחיד במערכת הוא שדה ה-`searchable` של `DataTable` (`src/components/ui.tsx:166-171`):

```
{searchable && (
  <div className="relative flex-1 min-w-44 max-w-xs">
    <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-slate-400" />
    <input className="input ps-9!" placeholder="חיפוש..." value={q} onChange={(e) => setQ(e.target.value)} />
  </div>
)}
```

הוא **client-side בלבד**: מסנן את המערך שכבר נטען לדף (`ui.tsx:143-156`), לא פונה ל-DB. כלומר הוא מוגבל לישות אחת, למסך אחד, ולשורות שכבר בזיכרון.

14 אתרי קריאה משתמשים בו: `Suppliers.tsx:51`, `Products.tsx:62`, `PriceLists.tsx:78`, `Orders.tsx:49`, `Invoices.tsx:83`, `Credits.tsx:48`, `PaymentRequests.tsx:52`, `Payments.tsx:41`, `Bank.tsx:83`, `Exceptions.tsx:50`, `AuditLog.tsx:58`, `SupplierPrices.tsx:64`, `Admin.tsx:117`, `Settings.tsx:231`.

**כולם מעבירים `searchFn`.** אין שדה חיפוש מת במערכת. הצימוד `q && searchFn` ב-`ui.tsx:145` הוא מלכודת API רדומה (שדה שיוצג ולא יסנן אם מישהו ישכח את `searchFn`), **לא באג חי** — ואין לתקן אותו במסגרת העבודה הזאת.

### מצב ה-layout: אין header בדסקטופ

`src/components/Layout.tsx` (159 שורות) מרנדר היום:

| שורה | אלמנט |
|---|---|
| 122 | `<div className="min-h-screen">` — עוטף חיצוני, **ללא `overflow`** |
| 124 | `<aside className="hidden lg:block fixed inset-y-0 start-0 w-60 bg-slate-900 z-40 no-print">` — סרגל צד דסקטופ |
| 127-130 | `<header className="lg:hidden sticky top-0 z-40 ...">` — סרגל עליון **מובייל בלבד**, עם המבורגר בשורה 129 |
| 131-138 | מגירת המובייל (`mobileOpen`) |
| 139-140 | שורה ריקה + `{/* Content */}` |
| **141** | `<main className="lg:ms-60 px-4 sm:px-6 py-5 pb-24 lg:pb-8 max-w-[1400px]">` |
| 146-156 | ניווט תחתון מובייל |

**בדסקטופ אין שום דבר מעל ה-`<main>`.** כל השטח מעל התוכן ריק. זה בדיוק המקום שסעיף 5 מבקש.

> **תיקון להפניה שהתקבלה בבריף:** הבריף ציין "header חדש ב-`Layout.tsx:127`". שורה 127 היא כיום ה-header של המובייל. **נקודת ההזרקה הנכונה היא מיד לפני הערת `{/* Content */}` שבשורה 140** — כלומר אחרי סוף בלוק המגירה (138) ולפני `<main>` (141). היעד `lg:ms-60` ו-`start-0` של הסרגל אומתו ונכונים.

---

## 3. מה לבנות

### 3.1 הממצא שמעצב את התכנון: שומרי המסלול מחמירים יותר מ-RLS

זה לא פרט טכני — זה מה שקובע למי בכלל מוצג תיבת חיפוש.

חוקות ה-RLS ושומרי המסלול ב-`App.tsx` **אינם אותה קבוצה**:

- RLS מרשה ל-`payer` לקרוא חשבוניות מסוימות (`0001_init.sql:556-561`) וספקים מסוימים (`0004_supplier_agents.sql:19-23`) — אבל `/invoices/:id` שמור ל-`READERS` (`App.tsx:121`), ו-`payer` שילחץ על תוצאת חשבונית ייזרק ל-`homeFor()` (`AuthContext.tsx:110-118`, מחזיר `/pay`).
- RLS מרשה ל-`supplier` לקרוא את קטלוג המוצרים (`0004:26-28`) — אבל `/products` שמור ל-`STAFF` (`App.tsx:109`).
- `accountant` חסום מ-`/products` (`STAFF`, `App.tsx:109`); `kitchen` חסום מ-`/payments` (`App.tsx:125`).

**מסקנה:** הלקוח חייב לסנן את **סוגי** התוצאות לפי תפקיד, בעזרת טבלה שמשקפת את `App.tsx`, **מעל** ה-RLS. RLS קובעת אילו שורות קיימות; טבלת השומרים קובעת לאן אפשר להגיע. שתיהן נחוצות.

**וכתוצאה: לא מרנדרים חיפוש כלל ל-`payer` ול-`supplier`.** המסלולים היחידים שלהם הם `/pay` ו-`/my-prices`. תיבת חיפוש עבורם היא תיבה שמייצרת רק מבוי סתום.

טבלת ההרשאות המלאה, נגזרת שורה-שורה מ-`App.tsx`:

| תפקיד | ספק | מוצר | חשבונית | הזמנה | תשלום | זיכוי | תיבת חיפוש? |
|---|:--:|:--:|:--:|:--:|:--:|:--:|---|
| `owner` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | כן — 6 קבוצות |
| `office` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | כן — 6 קבוצות |
| `kitchen` | ✓ | ✓ | ✓ | ✓ | — | ✓ | כן — 5 קבוצות |
| `accountant` | ✓ | — | ✓ | ✓ | ✓ | ✓ | כן — 5 קבוצות |
| `payer` | — | — | — | — | — | — | **לא מרונדר** |
| `supplier` | — | — | — | — | — | — | **לא מרונדר** |

מקורות השומרים (אומתו): `READERS`/`STAFF`/`FINANCE` ב-`App.tsx:55-57`; `/suppliers/:id`:108 · `/products`:109 · `/orders/:id`:114 · `/invoices/:id`:121 · `/credits`:123 · `/payments`:125.

### 3.2 נקודת עיגון ופריסה

**Header חדש לדסקטופ**, מוזרק ב-`Layout.tsx` **מיד לפני הערת `{/* Content */}` שבשורה 140** — כלומר בין בלוק המגירה (מסתיים 138) ל-`<main>` (141):

```tsx
{/* Global search — desktop */}
{canSearch && (
  <header className="hidden lg:flex sticky top-0 z-30 lg:ms-60 h-14 items-center
                     border-b border-slate-200 bg-white px-6 no-print">
    <GlobalSearch />
  </header>
)}
```

- `lg:ms-60` תואם ל-`<main>` (141) ולכן מתיישר לצד הסרגל הקבוע `w-60`. ב-RTL `ms` נפתר לימין — אותו צד כמו `start-0` של הסרגל (124). **אין `left`/`right` בשום מקום.**
- `sticky top-0` עובד כי העוטף `div.min-h-screen` (122) הוא ללא `overflow`, ולכן ה-viewport הוא ה-containing block. אומת.
- **`bg-white` מלא, ללא `backdrop-blur`** — `CLAUDE.md:49` אוסר glassmorphism.
- `z-30` נמוך מהסרגל (`z-40`, שורה 124). הם לא חופפים אופקית, והסרגל צריך להישאר מעל פאנל תוצאות רחב אם יתווסף.
- `no-print` — להתאמה לסרגל (124), ל-header המובייל (127) ולניווט התחתון (147).
- `<main>` נשאר כמו שהוא. `py-5` בשורה 141 תקין.

**מובייל — לא נוגעים בסרגל התחתון.** עבור `owner`/`office` המערך `mobileItems` (`Layout.tsx:78`) הוא כבר בדיוק 4 פריטים (`/orders/new`:20, `/orders`:21, `/receiving`:22, `/invoices`:37), ו-`slice(0, 4)` היה מפיל בשקט את החשבוניות. במקום זה — עורכים את סרגל המובייל העליון (`Layout.tsx:127-130`): עוטפים את ההמבורגר בקבוצת flex ומוסיפים טריגר חיפוש.

```tsx
<div className="flex items-center gap-1">
  {canSearch && (
    <button onClick={() => setSearchOpen(true)} aria-label="חיפוש"><Search size={21} /></button>
  )}
  <button onClick={() => setMobileOpen(true)} aria-label="תפריט"><Menu size={22} /></button>
</div>
```

הכפתור פותח את `GlobalSearch` במצב overlay מסך-מלא (`role="dialog"`, `aria-modal="true"`) — ממילא הדפוס הנכון במובייל: dropdown מתחת לסרגל בגובה ~44px אינו שמיש בטלפון.

שינויים נלווים ב-`Layout.tsx`: הוספת `Search` ל-import של lucide (שורה 2), `useState` אחד ליד שורה 59, וחישוב `canSearch` מ-`profile?.role` ליד שורה 60.

> **לא לחקות את הפריצות הקיימות.** `ui.tsx:114` ממרכז את ה-toast ידנית עם `-translate-x-1/2 rtl:translate-x-1/2`, ו-`ui.tsx:204,206` הופך ידנית את החצים (`ChevronRight` ל"הקודם"). ל-overlay אין צורך באף אחת מהן: המרכוז נעשה עם flex/grid, וניווט המקלדת אנכי בלבד (ראו 3.5) ולכן אין חצי כיוון להפוך.

### 3.3 אסטרטגיית שאילתה — פונקציית RPC אחת, `SECURITY INVOKER`

נשקלו שלוש דרכים. שתיים נדחו מסיבות קונקרטיות.

**נדחה — N שאילתות `ilike` מקבילות מהלקוח.** שני חסמים, לא רק מספר round-trips. `purchase_orders.number`, `credit_requests.number` ו-`payments.number` הם `int generated always as identity` (`0001_init.sql:152, 233, 274`) — PostgREST אינו יכול להריץ `ilike` על עמודת מספר שלם, ולכן היה צריך ענפי `.eq()` מותנים שנורים רק כשהמונח מתפרש כמספר, משוכפלים בארבעה מקומות ב-TypeScript. בנוסף, "חשבוניות של ספק X" דורש סינון על משאב משובץ (`suppliers.name=ilike.*`) שסמנטיקת שורות ה-null שלו היא מלכודת ידועה ב-PostgREST. שש בקשות לכל טיק debounce, כל אחת מעריכה מחדש את `auth_role()`/`auth_org()` — מצטבר.

**נדחה — materialized view.** materialized views **אינם תומכים ב-RLS**. היה צריך לשכפל לתוך ה-view את כללי הראות של payer/supplier/accountant מ-`0001_init.sql:502-505, 556-561` ומ-`0004:19-45` — בדיוק את לוגיקת ההרשאות שהקודבייס הזה מטפל בה בזהירות (ראו `0003_kitchen_balance_read.sql` ו-`0008_supplier_balance_role_guard.sql`). ומעבר לזה — התיישנות אינה מקובלת: חשבונית שהוקלדה לפני 30 שניות חייבת להימצא. גם view **רגיל** אינו מתאים, כי view אינו יכול לקבל את מונח החיפוש כפרמטר, ולכן Postgres יבנה את כל שישה ענפי ה-`UNION` לפני שהסינון החיצוני חל.

**נבחר — פונקציית `plpgsql` אחת, `SECURITY INVOKER`** (ברירת המחדל — משמיטים את מילת המפתח).

הנימוק המכריע הוא הרשאות: מכיוון שהפונקציה רצה בהקשר הקורא, **חוקת ה-RLS של כל טבלה בסיס חלה אוטומטית**, ולכן ראות לפי תפקיד דורשת **אפס** לוגיקה משוכפלת.

> שימו לב שזה **בכוונה ההפך** מ-`refresh_invoice_payment_status` (`0002_payer_execution.sql:13`) שהוא `security definer`. אל תעתיקו משם את הדפוס.

**רב-דיירות — במפורש:** לכל טבלה יש `org_id` ומעליה חוקת RLS שמסננת `org_id = auth_org()` (`CLAUDE.md:24`). לכן החיפוש הגלובלי **אינו זקוק לסינון org מפורש** — ה-RLS מבודדת אותו. הסינון `org_id = auth_org()` שכן מופיע בשאילתה למטה הוא **הגנה בעומק ורמז לתכנן** בלבד — אותה רוח כמו `0003_kitchen_balance_read.sql:20` — ואינו תחליף ל-RLS ואינו רשאי לעקוף אותה. **אין להוסיף שום סינון `org_id` שמקורו בפרמטר מהלקוח.**

עלות, בכנות: מיגרציה אחת ופונקציית DB שצריך לתחזק לצד הסכימה. שווה את זה עבור round-trip אחד והרשאות בחינם.

### 3.4 חיפוש טקסט בעברית — הבחירה המשעממת היא הנכונה

ל-`to_tsvector` **אין מילון עברית**. תצורת `simple` נותנת טוקניזציה לפי רווחים ללא stemming — כלומר היא לא קונה דבר מעל `ILIKE`, בתמורה לעמודת tsvector שצריך לתחזק ולעדכן בטריגר.

**התשובה הכנה היא `ILIKE '%term%'` מואץ באינדקסי `pg_trgm` GIN.** אינדקסי טריגרם הם מבוססי-תווים וחסרי-מילון, ולכן הם עובדים על עברית.

שני סייגים שיש לקבל במפורש ולתעד:

1. **אינדקס טריגרם מסייע רק מ-3 תווים ומעלה.** שאילתה של 2 תווים מתדרדרת לסריקה סדרתית. בקנה המידה הנוכחי (עסק בודד) זה תקין. המינימום בלקוח נקבע ל-2 תווים; יש לבחון מחדש אם מספר החשבוניות עובר ~100k.
2. **`ILIKE` לא יגשר על הפרש רווח** — "סופרמרקט" מול "סופר מרקט" לא יימצאו זה את זה. לא שווה לפתור עכשיו.

### 3.5 המיגרציה — `supabase/migrations/0010_global_search.sql`

> **תיקון מספור:** התוכנית המקורית קראה לקובץ `0005_global_search.sql`. המספר תפוס — `0005_saas_hardening.sql`. המיגרציות בריפו מגיעות כיום עד `0009_audit_allocation_org.sql`, ולכן **המספר הנכון הוא `0010`**. אם סעיפים אחרים מהמסמך של ניר נכנסים במקביל, יש לתאם מספור לפני היישום.

```sql
-- Global search (spec §5): one round trip across the six searchable entities.
-- SECURITY INVOKER on purpose (note: the opposite of refresh_invoice_payment_status,
-- 0002_payer_execution.sql:13) -- every underlying table's RLS applies to the caller, so
-- payer/supplier/accountant/kitchen visibility needs no duplicated logic here.

create extension if not exists pg_trgm with schema extensions;

-- Hebrew has no Postgres text-search dictionary, so matching is ILIKE '%term%'.
-- Trigram indexes are character-based (dictionary-free) and accelerate that at 3+ chars.
create index if not exists suppliers_name_trgm    on suppliers using gin (name extensions.gin_trgm_ops);
create index if not exists suppliers_contact_trgm on suppliers using gin (contact_name extensions.gin_trgm_ops);
create index if not exists products_name_trgm     on products  using gin (name extensions.gin_trgm_ops);
create index if not exists products_sku_trgm      on products  using gin (sku extensions.gin_trgm_ops);
create index if not exists invoices_number_trgm   on invoices  using gin (invoice_number extensions.gin_trgm_ops);
create index if not exists payments_ref_trgm      on payments  using gin (reference extensions.gin_trgm_ops);

-- identity numbers are int; prefix-match them as text so "12" finds #12, #120, #121
create index if not exists po_number_txt       on purchase_orders (((number)::text) text_pattern_ops);
create index if not exists credits_number_txt  on credit_requests (((number)::text) text_pattern_ops);
create index if not exists payments_number_txt on payments        (((number)::text) text_pattern_ops);

create or replace function global_search(q text, per_type int default 5)
returns table (
  entity text, id uuid, title text, subtitle text,
  status text, amount numeric(12,2), occurred_at date, rank int
)
language plpgsql stable set search_path = public as $$
#variable_conflict use_column
declare
  term text; like_any text; like_pre text;
begin
  -- '#123' is how users actually type document numbers
  term := btrim(regexp_replace(coalesce(q, ''), '^#', ''));
  if length(term) < 2 then return; end if;
  -- neutralise LIKE wildcards typed by the user
  term := replace(replace(replace(term, '\', '\\'), '%', '\%'), '_', '\_');
  like_any := '%' || term || '%';
  like_pre := term || '%';

  return query
  select * from (
    -- ספקים  (aliases here name the whole derived table: first UNION branch wins)
    (select 'supplier'::text as entity, s.id as id, s.name as title,
            nullif(concat_ws(' · ', s.contact_name, s.phone), '') as subtitle,
            s.status::text as status, null::numeric(12,2) as amount,
            null::date as occurred_at,
            (case when s.name ilike like_pre then 1 else 2 end)::int as rank
     from suppliers s
     where s.org_id = auth_org() and s.deleted_at is null
       and (s.name ilike like_any or s.contact_name ilike like_any
            or s.phone ilike like_any or s.tax_id ilike like_any or s.email ilike like_any)
     order by (case when s.name ilike like_pre then 1 else 2 end), s.name
     limit per_type)
  union all
    -- מוצרים
    (select 'product'::text, p.id, p.name,
            nullif(concat_ws(' · ', c.name, p.sku), ''),
            (case when p.active then 'active' else 'inactive' end)::text,
            null::numeric(12,2), null::date,
            (case when p.name ilike like_pre then 1 else 2 end)::int
     from products p left join categories c on c.id = p.category_id
     where p.org_id = auth_org()
       and (p.name ilike like_any or p.sku ilike like_any or p.barcode ilike like_any)
     order by (case when p.name ilike like_pre then 1 else 2 end), p.name
     limit per_type)
  union all
    -- חשבוניות  (joining suppliers lets "שופרסל" surface that supplier's invoices)
    (select 'invoice'::text, i.id, i.invoice_number, s.name,
            i.payment_status::text, i.total_amount, i.invoice_date,
            (case when i.invoice_number ilike like_pre then 1 else 2 end)::int
     from invoices i join suppliers s on s.id = i.supplier_id
     where i.org_id = auth_org() and i.deleted_at is null
       and (i.invoice_number ilike like_any or s.name ilike like_any or i.notes ilike like_any)
     order by (case when i.invoice_number ilike like_pre then 1 else 2 end), i.invoice_date desc
     limit per_type)
  union all
    -- הזמנות
    (select 'order'::text, o.id, '#' || o.number::text, s.name,
            o.status::text, null::numeric(12,2), o.created_at::date,
            (case when o.number::text like like_pre then 1 else 2 end)::int
     from purchase_orders o join suppliers s on s.id = o.supplier_id
     where o.org_id = auth_org()
       and (o.number::text like like_pre or s.name ilike like_any or o.notes ilike like_any)
     order by (case when o.number::text like like_pre then 1 else 2 end), o.created_at desc
     limit per_type)
  union all
    -- תשלומים  (payments has no status column -> null; StatusBadge renders nothing, ui.tsx:7)
    (select 'payment'::text, pm.id, '#' || pm.number::text,
            nullif(concat_ws(' · ', s.name, pm.method, pm.reference), ''),
            null::text, pm.amount, pm.paid_date,
            (case when pm.number::text like like_pre then 1 else 2 end)::int
     from payments pm join suppliers s on s.id = pm.supplier_id
     where pm.org_id = auth_org()
       and (pm.number::text like like_pre or s.name ilike like_any
            or pm.reference ilike like_any or pm.notes ilike like_any)
     order by (case when pm.number::text like like_pre then 1 else 2 end), pm.paid_date desc
     limit per_type)
  union all
    -- זיכויים
    (select 'credit'::text, cr.id, '#' || cr.number::text, s.name,
            cr.status::text, cr.amount, cr.created_at::date,
            (case when cr.number::text like like_pre then 1 else 2 end)::int
     from credit_requests cr join suppliers s on s.id = cr.supplier_id
     where cr.org_id = auth_org()
       and (cr.number::text like like_pre or s.name ilike like_any or cr.notes ilike like_any)
     order by (case when cr.number::text like like_pre then 1 else 2 end), cr.created_at desc
     limit per_type)
  ) hits
  order by hits.rank, hits.occurred_at desc nulls last, hits.title
  limit 30;
end $$;

grant execute on function global_search(text, int) to authenticated;
```

הערות מימוש על ה-SQL:

- **`#variable_conflict use_column` הכרחי**: `RETURNS TABLE` הופך את `id`, `status`, `rank` למשתני OUT שאחרת היו מסתירים את הפניות העמודות.
- **`LIMIT per_type` בתוך כל ענף** מונע מסוג ישות אחד לדחוק את השאר; `LIMIT 30` החיצוני הוא החיתוך הסופי.
- **מחיקה רכה נשמרת**: `deleted_at is null` על `suppliers` (`0001:76`) ועל `invoices` (`0001:211`). ל-`products`, `purchase_orders`, `payments` ו-`credit_requests` אין עמודת `deleted_at` בסכימה — אומת — ולכן אין תנאי כזה בענפים שלהם.
- **כינויי עמודות מופיעים רק בענף הראשון**, כי Postgres לוקח את שמות הפלט של `UNION` ממנו; ה-`order by hits.rank` החיצוני תלוי בזה.
- **סכום ההזמנה הושמט בכוונה** — הוא היה דורש `sum` על `purchase_order_items`. סטטוס + ספק מספיקים לזיהוי הזמנה בתוצאת חיפוש.
- **חשבוניות מחזירות `payment_status`** ולא `review_status` — "שולמה / לא שולמה" הוא האות הפעולתי יותר בתוצאת חיפוש. אם ניר חושב אחרת, זו החלפה של ביטוי אחד.
- **תשלומים מחזירים `null` בסטטוס** כי לטבלה אין עמודת `status` (`0001_init.sql:271-284`, אומת). `StatusBadge` מחזיר `null` עבור `meta` לא מוגדר (`ui.tsx:7`), כך שלא מוצג כלום — לא באדג׳ ריק ולא `0`.
- **`suppliers.status`** הוא enum עם 4 ערכים (`SUPPLIER_STATUS`, `status.ts:20-25`) — מתמפה ישירות.

קריאה מהלקוח: `supabase.rpc('global_search', { q: term, per_type: 5 })`.

### 3.6 הישויות, שדות החיפוש ויעדי הניווט

| ישות | טבלה | שדות שנסרקים | כותרת | תת-כותרת | יעד ניווט | מצב היעד |
|---|---|---|---|---|---|---|
| **ספק** | `suppliers` | `name`, `contact_name`, `phone`, `tax_id`, `email` | שם הספק | איש קשר · טלפון | `/suppliers/:id` | קיים — `App.tsx:108` |
| **מוצר** | `products` | `name`, `sku`, `barcode` | שם המוצר | קטגוריה · מק״ט | `/products?id=` | **רשימה בלבד** — `App.tsx:109`, דרוש `?id=` |
| **חשבונית** | `invoices` ⋈ `suppliers` | `invoice_number`, `suppliers.name`, `notes` | מס׳ החשבונית | שם הספק | `/invoices/:id` | קיים — `App.tsx:121` |
| **הזמנה** | `purchase_orders` ⋈ `suppliers` | `number::text` (prefix), `suppliers.name`, `notes` | `#מספר` | שם הספק | `/orders/:id` | קיים — `App.tsx:114` |
| **תשלום** | `payments` ⋈ `suppliers` | `number::text` (prefix), `suppliers.name`, `reference`, `notes` | `#מספר` | ספק · אמצעי · אסמכתא | `/payments?id=` | **רשימה בלבד** — `App.tsx:125`, דרוש `?id=` |
| **זיכוי** | `credit_requests` ⋈ `suppliers` | `number::text` (prefix), `suppliers.name`, `notes` | `#מספר` | שם הספק | `/credits?id=` | **רשימה בלבד** — `App.tsx:123`, דרוש `?id=` |

שלושה דפים צריכים תוספת קצרה, לפי התקדים הקיים של `useSearchParams` (`Invoices.tsx:43`, `Exceptions.tsx:17`, `PaymentRequests.tsx:18`, `Bank.tsx:43`):

- **`Credits.tsx`** — הנקי מבין השלושה. כבר קיים state בשם `selected` (שורה 19) שמניע מודאל `CreditDetail` (מרונדר בשורות 59-64). קוראים `params.get('id')` ומאתחלים ממנו את `selected` מתוך השורות שנטענו — כך שתוצאת זיכוי פותחת ישירות את כרטיס הזיכוי.
- **`Payments.tsx`** — הקובץ כולו 47 שורות ואין בו מודאל. מסננים את `rows` לשורה היחידה המתאימה כש-`?id=` נוכח, עם צ׳יפ בר-ביטול ב-`toolbar`. זול, כן, ומשאיר את `DataTable` ללא שינוי.
- **`Products.tsx`** — מאתחלים את `editing` (שורה 17) מ-`?id=` כדי לפתוח את `ProductForm` הקיים (מרונדר בשורות 71-74). מגנים ב-`canWrite` (שורה 38); עבור תפקיד קריאה-בלבד זה מתדרדר לרשימה רגילה — וזו ההתנהגות הנכונה.

> **תיאום:** ההצעות לסעיפים אחרים מהמסמך של ניר נוגעות באותם שלושה דפים לצורך פרמטרי סינון (`?status=`, `?month=`). הפרמטרים תואמים אבל חופפים באותן שורות — יש לממש אותם יחד ולא ברצף.

### 3.7 אינטראקציה

**קיצור המקלדת — `Ctrl/Cmd+K`, מזוהה לפי `e.code === 'KeyK'`. לעולם לא `e.key`.**

זה הסעיף הכי קל לאבד בתרגום, והכי גרוע לאבד. תחת **פריסת מקלדת עברית** המקש הפיזי K מפיק `e.key === 'ל'`. בדיקה של `e.key === 'k'` **פשוט לא תירה אף פעם** אצל המשתמשים של המערכת הזאת — מערכת שכל ממשקה עברי. הבאג הזה עולה לאוויר ולא מדווח, כי המשתמש פשוט מסיק שאין קיצור.

`e.code` מתאר את **המיקום הפיזי** של המקש ואינו מושפע מפריסה, ולכן הוא הבדיקה הנכונה:

```tsx
useEffect(() => {
  const h = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') {   // NOT e.key — Hebrew layout yields 'ל'
      e.preventDefault();                                   // Firefox binds Ctrl+K to its search bar
      inputRef.current?.focus();
    }
  };
  window.addEventListener('keydown', h);
  return () => window.removeEventListener('keydown', h);
}, []);
```

`preventDefault()` חובה — Firefox תופס את Ctrl+K לשורת החיפוש שלו.

שאר ההתנהגות:

- **Debounce 200ms, מינימום 2 תווים**, דרך `useEffect` + `setTimeout` עם cleanup. **ללא ספרייה.** התקדים קיים בקודבייס: `InvoiceNew.tsx:50-61` (שם 500ms — כאן קצר יותר כי המשתמש ממתין לתוצאה, לא מקבל אזהרה).
- **מגן מרוץ (race guard)**: מספר סידורי ב-`useRef` שמושווה לפני `setState`. debounce לבדו **אינו** מונע מתשובה ישנה ואיטית לדרוס תשובה חדשה ומהירה.
- **ArrowDown / ArrowUp** מזיזים `activeIndex` שטוח על פני כל התוצאות (מקובצות ויזואלית, מנווטות ליניארית), עם גלישה מעגלית בשני הקצוות.
- **בכוונה אין Left/Right** — הם מתהפכים ב-RTL והיו מקור באגים ללא שום תועלת. ניווט אנכי בלבד עוקף את הבעיה לגמרי.
- **Enter** פותח את `activeIndex`, או את התוצאה הראשונה אם אין פעילה. **Esc** סוגר ומחזיר מיקוד לשדה.
- **טעינה**: `<Loader2 className="animate-spin" size={15} />` מוחלף במקום `end-3` של השדה. **ללא שורות skeleton** — זו תנועה לשם תנועה, ו-`CLAUDE.md:49` אוסר אנימציות מוגזמות.
- **ריק**: שורה קומפקטית אחת, `py-6`: "לא נמצאו תוצאות עבור «term»". **לא לעשות שימוש חוזר ב-`EmptyState`** (`ui.tsx:20-28`) — ה-`py-16` שלו (שורה 22) הוא שטח דקורטיבי ריק בתוך dropdown, בדיוק מה ש-`CLAUDE.md:49` אוסר.
- **רמז במצב סרק** לפני 2 תווים: שורה מושתקת אחת שמונה מה ניתן לחפש.
- **כותרות קבוצה** משתמשות באייקונים שכבר קשורים למסלולים ב-`NAV` (`Layout.tsx:2`): `Truck` (ספקים, 28), `Package` (מוצרים, 29), `FileText` (חשבוניות, 37), `ClipboardList` (הזמנות, 21), `CreditCard` (תשלומים, 40), `RotateCcw` (זיכויים, 38). סדר הקבוצות לפי סדר סעיף 5.
- **כל שורה**: אייקון · כותרת (`font-medium`) · תת-כותרת (`text-slate-500`) · `<StatusBadge>` · סכום ב-`.num` עם `fmtMoneyExact` (`format.ts:9`). מספרי חשבונית נעטפים ב-`dir="ltr"` — בהתאם ל-`Invoices.tsx:64` ו-`Credits.tsx:34`.

### 3.8 נגישות

- **שדה**: `role="combobox"`, `aria-expanded`, `aria-controls="gs-listbox"`, `aria-autocomplete="list"`, `aria-activedescendant={`gs-opt-${activeIndex}`}` (מושמט כשאין פעיל), `aria-label="חיפוש כללי"`.
- **פאנל**: `<ul id="gs-listbox" role="listbox">`; כל קבוצה `role="group"` עם `aria-label` (ספקים/מוצרים/…); כל שורה `role="option"` עם `id="gs-opt-N"` ו-`aria-selected`.
- שורות חייבות להיות `<li role="option">` — **לא** `<button>` ולא `<a>`. אלמנטים אינטראקטיביים מקוננים בתוך listbox שוברים את הדפוס. הניווט דרך `onMouseDown` (נורה לפני blur) בתוספת מטפל המקלדת על השדה.
- `<div aria-live="polite" className="sr-only">` שמכריז `נמצאו N תוצאות` אחרי כל שאילתה שהתייצבה, מושהה יחד עם התוצאות.
- האפשרות הפעילה חייבת להיות גלויה: `scrollIntoView({ block: 'nearest' })` בכל שינוי של `activeIndex`.
- **ניהול מיקוד**: Esc → סגירה, המיקוד נשאר בשדה. ניווט → סגירה, ניקוי המונח, `blur()` כדי שתוכן המסלול יקבל את המיקוד. overlay מובייל → מיקוד לשדה בפתיחה, החזרת מיקוד לכפתור הטריגר בסגירה.
- **RTL**: properties לוגיים בלבד — `ps-9` על השדה עם האייקון ב-`start-3` (בדיוק כמו `ui.tsx:168-169`), `end-3` לספינר. אין `left`/`right`, אין `ml`/`mr` (`CLAUDE.md:43`).
- הפעולה הקריטית — פתיחת התוצאה — **גלויה תמיד**, לא מוסתרת מאחורי hover (`CLAUDE.md:49`).

### 3.9 מה נעשה בו שימוש חוזר ומה נכתב מחדש

**שימוש חוזר ללא שינוי:** `StatusBadge` (`ui.tsx:6-9`) וכל המפות ב-`status.ts` (`SUPPLIER_STATUS`:20, `PO_STATUS`:27, `INVOICE_PAYMENT_STATUS`:59, `CREDIT_STATUS`:79); `fmtMoneyExact`/`fmtDate` (`format.ts:9,11`); `unwrap` (`useQuery.ts:32`); לקוח `supabase`; אייקוני lucide מ-`NAV`; `.input`/`.card`/`.badge-*`/`.num`/`.th` מ-`index.css` (`.input`:31, `.num`:49, `.no-print`:52). **`DataTable` ו-`ui.tsx` אינם משתנים כלל.**

**נכתב חדש:** `supabase/migrations/0010_global_search.sql`; `src/components/GlobalSearch.tsx` (~220 שורות, עצמאי); ממשק `SearchHit` ב-`src/lib/types.ts` (הקובץ מתוחזק ידנית מול המיגרציות — כך כתוב בכותרת שלו, `types.ts:1` — ולכן טיפוס חדש שייך שם); מפת `PRODUCT_STATUS` בת 4 שורות ב-`status.ts` (`active`/`inactive` → `פעיל`/`לא פעיל` — שימוש חוזר ב-`SUPPLIER_STATUS` היה מרנדר נכון במקרה, אבל הוא שגוי סמנטית וישבר ברגע שסטטוסי הספק ישתנו).

**Debounce: `useEffect` + `setTimeout` מקומי, ~5 שורות. לא להוסיף `use-debounce` ולא lodash.** תלות עבור `setTimeout` עם פונקציית ניקוי אינה עסקה משתלמת, ואת מגן המרוץ צריך לכתוב ידנית בכל מקרה.

**בכוונה לא נעשה בהם שימוש חוזר:**
- **`useQuery`** (`useQuery.ts:4`) — הוא מבצע `setLoading(true)` בכל קריאה (`useQuery.ts:12`), מה שיגרום להבהוב של הפאנל בכל הקשה; ואין בו debounce ולא מגן מרוץ. כיפוף שלו היה מחמיר אותו עבור 20 הקוראים הקיימים. hook מקומי `useGlobalSearch` בתוך `GlobalSearch.tsx` הוא השינוי הקטן יותר.
- **`Modal`** (`ui.tsx:50-71`) — יש בו כבר מטפל Escape (54) ופריסת bottom-sheet למובייל (60-61), ושקלנו לעטוף בו את ה-overlay. אבל הוא מרנדר כותרת עם כפתור X (63-66) ו-`p-5 overflow-y-auto` (67) — כרומה שגויה לחיפוש, ואין בו את סמנטיקת ה-combobox. עדיף `<div role="dialog" aria-modal="true">` ייעודי.
- **`EmptyState`** — מידות שגויות ל-dropdown, כמפורט למעלה.

---

## 4. ביצועים ואינדקסים

### מה השאילתה עולה

round-trip **אחד** לכל טיק debounce (200ms), לא שישה. הפונקציה מריצה שישה ענפי `UNION ALL`, כל אחד עם `LIMIT per_type` פנימי, כלומר התכנן יכול לעצור מוקדם בכל ענף. `auth_org()`/`auth_role()` מוערכות פעם אחת לבקשה במקום שש.

הצירופים ל-`suppliers` (בענפי חשבונית/הזמנה/תשלום/זיכוי) רוכבים על אינדקסי FK שכבר קיימים מ-`0005_saas_hardening.sql`: `invoices_supplier_idx`:72, `purchase_orders_supplier_idx`:65, `payments_supplier_idx`:82, `credit_requests_supplier_idx`:77. **אין צורך באינדקס FK חדש.**

הסינון `org_id` נתמך על ידי אינדקסי ה-org הקיימים (`0005_saas_hardening.sql:37-56`).

### מה כן דרוש — 9 אינדקסים חדשים

הם מפורטים בגוף המיגרציה בסעיף 3.5:

- **6 אינדקסי `gin_trgm_ops`** — על עמודות טקסט חופשי שנסרקות ב-`ILIKE '%…%'`: `suppliers.name`, `suppliers.contact_name`, `products.name`, `products.sku`, `invoices.invoice_number`, `payments.reference`. בלעדיהם כל הקשה היא סריקה סדרתית מלאה על כל טבלה.
- **3 אינדקסי `text_pattern_ops`** על `(number)::text` — עבור `purchase_orders`, `credit_requests`, `payments`. אלה עמודות `int generated always as identity` (`0001_init.sql:152, 233, 274`), והחיפוש עליהן הוא **התאמת תחילית** (`like '12%'` מוצא `#12`, `#120`, `#121`) — ולכן `text_pattern_ops` ולא טריגרם.

`invoices_dup_idx` הקיים (`0001_init.sql:215`) הוא על `(supplier_id, invoice_number)` — הוא משרת בדיקת כפילויות, לא חיפוש חופשי. `invoice_number` אינה העמודה המובילה בשילוב שאנחנו צריכים, וממילא `ILIKE '%…%'` אינו יכול להשתמש ב-btree. **לכן `invoices_number_trgm` נחוץ בנפרד ואינו כפילות.**

### זו מיגרציה חדשה, אחרי 0009

כל אינדקס חדש הוא מיגרציה. הריפו מגיע כיום עד `0009_audit_allocation_org.sql`, ולכן הקובץ הוא **`0010_global_search.sql`**. יישום דרך `scripts/db-query.ps1` (`CLAUDE.md:39`).

שתי בדיקות שהמיגרציה חייבת לעבור:

1. **בלוק הבדיקה העצמית ב-`0005_saas_hardening.sql:97-114`** מפיל כל מיגרציה שמשאירה עמודת `org_id` ציבורית ללא אינדקס מוביל. המיגרציה שלנו **אינה מוסיפה טבלאות ואינה מוסיפה עמודות `org_id`**, ולכן אינה מפירה אותו. אם ישות שביעית תתווסף בעתיד עם טבלה חדשה — הכלל הזה חל עליה.
2. **הפונקציה אינה נוגעת ב-`user_role`.** ה-enum מוטבע ב-77 חוקות RLS ואסור לשנותו (`CLAUDE.md:26`). התוכנית קוראת תפקידים, אינה מוסיפה ואינה משנה ערכים.

### הסיכון היחיד ביישום

אם `pg_trgm` נוחת בסכימה שאינה ב-`search_path` של התפקיד, ההפניה ל-opclass `extensions.gin_trgm_ops` תיכשל ב-`CREATE INDEX`.

**התקדים קיים ועובד בפרויקט**: `0007_invitations.sql:31` עושה בדיוק `create extension if not exists pgcrypto with schema extensions;`. לכן `with schema extensions` הוא הדפוס הנכון כאן.

**הפונקציה עצמה אינה מושפעת בשני המקרים** — `ILIKE` הוא Postgres ליבה, ו-opclass של אינדקס נפתר בזמן יצירה ולא בזמן שאילתה. כלומר: גם אם האינדקסים נכשלים, החיפוש יעבוד — רק לאט.

### רף לבחינה מחדש

טריגרם עוזר מ-3 תווים. המינימום בלקוח הוא 2 תווים, כלומר שאילתת 2 תווים היא סריקה סדרתית. בקנה מידה של עסק בודד — תקין. **יש לבחון מחדש כשמספר החשבוניות עובר ~100k**, ואז השאלה היא העלאת המינימום ל-3 תווים או מעבר לעמודת `tsvector` מתוחזקת בטריגר.

---

## 5. הכרעות פתוחות

`CLAUDE.md:29` ו-`OPEN-DECISIONS.md:3` אוסרים להמציא תשובות עסקיות. השאלות הבאות הוכרעו כברירת מחדל מתועדת — **לא כניחוש שקט בקוד**. כל אחת ניתנת לשינוי בשורה אחת עד שתי שורות.

| # | השאלה | ברירת המחדל שנבחרה | הנימוק | היכן משנים |
|---|---|---|---|---|
| 1 | האם `payer` ו-`supplier` מקבלים חיפוש? | **לא מרונדר כלל** | כל ששת סוגי התוצאות מובילים למסלולים שהם חסומים מהם (`App.tsx:108,109,114,121,123,125`). תיבה שמייצרת רק מבוי סתום גרועה מהיעדר תיבה | טבלת `canSearch` ב-`GlobalSearch.tsx` |
| 2 | האם רשומות שנמחקו רכות מופיעות? | **לא** | `deleted_at is null` על ספקים וחשבוניות. חיפוש הוא כלי תפעולי, לא ארכיון | תנאי `deleted_at` בשני ענפי ה-`UNION` |
| 3 | האם מוצר לא-פעיל (`active = false`) מופיע? | **כן, עם באדג׳ "לא פעיל"** | הוא עדיין קיים בקטלוג ובחשבוניות היסטוריות; הסתרתו הופכת חיפוש כושל לתעלומה | תנאי בענף `product` |
| 4 | מה מוצג לחשבונית — סטטוס בדיקה או סטטוס תשלום? | **`payment_status`** | "שולמה / לא שולמה" פעולתי יותר בשורת תוצאה. אינו טענה על נכונות החשבונית | ביטוי אחד בענף `invoice` |
| 5 | כמה תוצאות לכל סוג ובסך הכול? | **5 לסוג, 30 בסך הכול** | 6 סוגים × 5 = 30; הפאנל נשאר בגובה מסך אחד ללא גלילה ארוכה | פרמטר `per_type` ו-`limit 30` |
| 6 | מינימום תווים להתחלת חיפוש | **2** | טריגרם מסייע מ-3, אבל מק״ט וקיצורי ספקים בני 2 תווים נפוצים. עלות הביצועים מקובלת בקנה המידה הנוכחי | קבוע בלקוח + `length(term) < 2` בפונקציה |
| 7 | האם מחפשים גם בשדה `notes` החופשי? | **כן** בחשבוניות/הזמנות/תשלומים/זיכויים | זה המקום שבו מוקלד "מס׳ תעודת משלוח" ופרטים שאין להם עמודה. **`notes` עלול להכיל מידע רגיש** — יש לאשר מול ניר | תנאי `notes ilike` בארבעה ענפים |
| 8 | דירוג התוצאות | **התאמת תחילית לפני התאמה באמצע**, ואז לפי תאריך יורד | הכי צפוי למשתמש; ללא ציון רלוונטיות מלאכותי שאין לו בסיס | ביטוי `rank` |
| 9 | האם להוסיף ישות שביעית (דרישות תשלום / חריגים)? | **לא** — מחוץ להיקף | סעיף 5 מונה שש ישויות במפורש. הוספה = בלוק `UNION` נוסף כשיתבקש | מיגרציה חדשה |

---

## 6. אימות

### השער האוטומטי — אחד בלבד

```
npm run build     # = tsc --noEmit && vite build
```

**זה השער האוטומטי היחיד. אין linter, אין טסטים** (`CLAUDE.md:38`). כלומר אין רשת ביטחון אוטומטית לשום דבר שאינו טיפוסי TypeScript — כל הבדיקות ההתנהגותיות למטה הן ידניות, וחובה לבצע אותן בפועל.

שרת פיתוח: `npm run dev` — פורט **5199** (`CLAUDE.md:37`).

### אימות ויזואלי — חובה

`CLAUDE.md:53` — שינוי ויזואלי **אינו מדווח כגמור בלי צילום מסך של התוצאה בפועל**, לא הסתמכות על הזיכרון. נדרשים צילומי מסך של:

1. ה-header בדסקטופ, מיושר לצד הסרגל (בדיקה שאין חפיפה ואין פער ב-`lg:ms-60`).
2. פאנל התוצאות פתוח עם תוצאות משש הקבוצות.
3. ה-overlay במובייל.
4. מצב "לא נמצאו תוצאות".

### ⚠️ בדיקת חובה: `Ctrl+K` תחת פריסת מקלדת עברית

**זו הבדיקה שהכי סביר שתידלג עליה, והבאג שהיא תופסת לא ידווח לעולם על ידי משתמש.**

הבדיקה:

1. הפעל את המערכת: `npm run dev`, `http://localhost:5199`.
2. התחבר כ-`owner` או `office`.
3. **החלף את פריסת המקלדת של Windows לעברית** (`Alt+Shift`, או `Win+Space`). ודא שהפריסה אכן עברית — הקלד תו כלשהו בשדה ובדוק שמופיעה אות עברית.
4. ודא שהמיקוד **אינו** בשדה קלט כלשהו.
5. הקש **`Ctrl` + המקש הפיזי K** (המקש שמסומן `ל` בעברית).
6. **צפוי: שדה החיפוש מקבל מיקוד.**
7. חזור על 3-6 עם פריסה **אנגלית** — התוצאה חייבת להיות זהה.
8. חזור על שני המקרים ב-**Firefox** במיוחד — כדי לוודא ש-`preventDefault()` חוסם את שורת החיפוש המובנית של הדפדפן.

**אם שלב 6 נכשל תחת פריסה עברית ומצליח באנגלית — הבדיקה היא `e.key` ולא `e.code`. זה בדיוק הבאג שהסעיף הזה קיים כדי למנוע.**

בדיקת עזר בקונסולה, שמראה את ההבדל בעין:

```js
addEventListener('keydown', e => console.log({ key: e.key, code: e.code }));
// פריסה עברית, המקש הפיזי K:  { key: "ל",  code: "KeyK" }   ← code יציב
// פריסה אנגלית, אותו מקש:      { key: "k",  code: "KeyK" }
```

### בדיקות לפי תפקיד

יש להתחבר בכל תפקיד ולוודא בפועל (הקבוצות נגזרות מטבלת 3.1):

| תפקיד | צפוי |
|---|---|
| `owner` | תיבת חיפוש; שש קבוצות |
| `office` | תיבת חיפוש; שש קבוצות |
| `kitchen` | תיבת חיפוש; **ללא קבוצת תשלומים** |
| `accountant` | תיבת חיפוש; **ללא קבוצת מוצרים** |
| `payer` | **אין תיבת חיפוש כלל** (וגם לא כפתור במובייל) |
| `supplier` | **אין תיבת חיפוש כלל** |

### בדיקות בידוד רב-דיירי — קריטי

זו מערכת SaaS רב-דיירית. חיפוש גלובלי הוא בדיוק סוג התכונה שדולפת בין דיירים אם ה-RLS נעקפת.

1. בעורך ה-SQL של Supabase, הרץ `global_search` עם `set role authenticated` ו-JWT של דייר א׳ — ודא ש**שום** תוצאה אינה שייכת לדייר ב׳.
2. חזור עם JWT של `payer` — ודא שקבוצת התוצאות מצטמצמת (ה-RLS מגבילה אותו לחשבוניות של דרישות תשלום מאושרות בלבד, `0001_init.sql:556-561`).
3. חזור עם JWT של `supplier` — ודא שאינו מקבל שורות של ספקים אחרים (`0004:19-23`).
4. ודא שהפונקציה **אינה** `security definer`. אם היא כן — כל הבידוד נופל.

### בדיקות התנהגות

- הקלדה מהירה של מונח ארוך: התוצאה הסופית תואמת את המונח המלא (מגן המרוץ עובד).
- `#123` ו-`123` מחזירים את אותה הזמנה.
- הקלדת `%` או `_` אינה מחזירה את כל הרשומות (בריחת wildcards).
- מונח בן תו אחד: אין קריאת רשת כלל.
- לחיצה על תוצאה מכל אחת משש הקבוצות מגיעה לרשומה הנכונה — כולל שלושת המסלולים עם `?id=`.
- Esc סוגר ומחזיר מיקוד; ArrowDown/Up מקיפים בשני הכיוונים.
- **RTL**: אין גלישה אופקית, האייקון ב-`start`, הספינר ב-`end`, מספרי חשבונית ב-`dir="ltr"`, סכומים ב-`.num`.

---

## נספח — תיקוני הפניות שבוצעו

התוכנית המקורית נכתבה מול מצב מוקדם יותר של הריפו. כל ההפניות נפתחו ואומתו; אלה שזזו תוקנו:

| הפניה מקורית | מתוקן | הערה |
|---|---|---|
| `0005_global_search.sql` | **`0010_global_search.sql`** | `0005` תפוס (`0005_saas_hardening.sql`); הריפו מגיע ל-`0009` |
| `Layout.tsx:127` (`<main>`) | **`Layout.tsx:141`** | נקודת ההזרקה של ה-header: לפני הערת `{/* Content */}` בשורה **140** |
| `Layout.tsx:110` (סרגל צד) | **`Layout.tsx:124`** | עדיין `no-print`, `start-0`, `z-40` |
| `Layout.tsx:113-116` (סרגל מובייל) | **`Layout.tsx:127-130`** | המבורגר בשורה 129 |
| `Layout.tsx:124` (סוף המגירה) | **`Layout.tsx:138`** | |
| `Layout.tsx:108` (`min-h-screen`) | **`Layout.tsx:122`** | ללא `overflow` — `sticky` תקף |
| `Layout.tsx:64` (`mobileItems`) | **`Layout.tsx:78`** | `slice(0,4)` — הטענה על 4 פריטים אומתה |
| `App.tsx:54,55,60,67,69,71` (מסלולים) | **`App.tsx:108,109,114,121,123,125`** | `STAFF`/`FINANCE`/`READERS` ב-55-57 ללא שינוי |
| `0001_init.sql:273` (`payments.number`) | **`0001_init.sql:274`** | |
| `InvoiceNew.tsx:57-61` (debounce) | **`InvoiceNew.tsx:50-61`** | `setTimeout` בשורה 52, השהיה 500ms |
| `Products.tsx:68` (`ProductForm`) | **`Products.tsx:71-74`** | `editing`:17, `canWrite`:38 |
| `SupplierPrices.tsx:63` | **`SupplierPrices.tsx:64`** | |
| "12 אתרי `searchable`" | **14** | נוספו `Admin.tsx:117` ו-`Settings.tsx:231` — שניהם מעבירים `searchFn`, הטענה "אין שדה חיפוש מת" עדיין נכונה |

הפניות שאומתו ונמצאו **מדויקות ללא שינוי**: `ui.tsx:7,20-28,50-71,114,145,167-171,204,206` · `useQuery.ts:12,32` · `format.ts:9,11` · `types.ts:1` · `Invoices.tsx:43,64,83` · `Exceptions.tsx:17,50` · `PaymentRequests.tsx:18,52` · `Credits.tsx:19,48` · `Payments.tsx:41` · `Products.tsx:38,62` · `AuthContext.tsx:110-118` · `0001_init.sql:152,215,233,502-505,556-561` · `0003:20` · `0004:19-23,26-28,31` · `0008:42-47` · `0002:13`.

**הפניות חדשות שנוספו** (לא היו בתוכנית המקורית): `0005_saas_hardening.sql:37-56` (אינדקסי org), `:58-93` (אינדקסי FK), `:95-114` (בלוק הבדיקה העצמית) · `0007_invitations.sql:31` (תקדים `with schema extensions` — מוריד את הסיכון היחיד ביישום) · `index.css:31,49,52`.
