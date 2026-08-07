# Document Intelligence & Navigation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give the existing OCR→OpenAI interpretation pipeline the authority to act — file documents to their category, archive what matches nothing, and create the invoice above a confidence threshold — while removing the machine internals from the user's screen and closing the dead-end flows that force a round trip.

**Architecture:** The interpretation pipeline (`document-processing` → `interpret-document`) already produces a typed `document_type`, a validated `supplier.suggested_id`, `fields[]` and `line_items[]`. Nothing consumes those conclusions. This plan adds a **decision layer** in Postgres (`apply_document_interpretation`) that consumes them inside one transaction — audit row, business write and idempotency key together — plus a display layer that maps seven engineering stages onto three human ones.

**Tech Stack:** Vite 6 · React 19 · React Router 8 · TS strict · Supabase (RLS multi-tenant) · Tailwind v4 CSS-first · Deno Edge Functions · OpenAI Responses API with `strict: true` structured outputs.

---

## החלטת הבעלים (06.08.2026)

נשאלה שאלת שער אחת: **מה המערכת רשאית לעשות בלי אישור אדם.** משה בחר **אפשרות ב' — אוטומציה מלאה מעל סף ביטחון.** הסיכון (מודל שכותב רשומות כספיות) הוצג לפני הבחירה ואושרר. התוכנית מממשת את התכולה המלאה.

**מה שנגזר מכך, ומה שאינו נתון לפרשנות המבצע:**

| מעקה | למה הוא לא "החמרה" אלא חלק מהתכולה |
|---|---|
| ברירת מחדל **כבויה** פר-ארגון | ‏#ב' נותן סמכות; הוא לא אומר "לכל דייר קיים, מהיום למחר, בלי שידע" |
| סף מוצהר ב-`OPEN-DECISIONS` | החוקה אוסרת המצאת תשובות עסקיות. ‏0.90 הוא ברירת מחדל מתועדת, לא קבוע חבוי |
| ‏`audit_logs` עם סיבה שמזהה את המודל | חוק ברזל קיים. הסיבה נושאת model + prompt_version + interpretation_id + confidence |
| מפתח אידמפוטנטיות | בלעדיו retry אחד = שתי חשבוניות. זו לא זהירות, זו נכונות |
| ביטול בפעולה אחת מנומקת | מחיקה רכה בלבד (חוק ברזל). כתיבה אוטומטית בלי חזרה היא מלכודת |
| חמישה תנאי עצירה קשיחים | ראה משימה C3. מעליהם המודל כותב; מתחתם — לתור |

### הסטייה היחידה מניסוח הבקשה, מוצהרת בקול

משה כתב: *"אם חסר פריט הוא מעדכן"*. התוכנית **אינה** נותנת למודל לשנות `purchase_order_items`.

**למה:** `CLAUDE.md` קובע ש-`purchase_order_items.unit_price` הוא **snapshot מחירים ברגע ההזמנה**, ו-`price_history` נגזר ממנו. הוספת שורה להזמנה בדיעבד אינה "עדכון" — היא **שכתוב היסטוריה** שגוזרת מחדש ניתוחי מחיר וחיסכון שכבר הוצגו למנהל.

**מה כן נעשה:** הפריט החסר נכנס **לחשבונית שנוצרת** (זו הרשומה החדשה — כתיבה, לא שכתוב), ובמקביל נפתח **חריג** מול ההזמנה שמופיע ב-`/exceptions` ומצביע על הפער. המנהל רואה "התקבל פריט שלא הוזמן" כפעולה שדורשת הכרעה — במקום הזמנה שהשתנתה בשקט.

**אם משה רוצה גם את שכתוב ההזמנה:** זה דגל נוסף (`document_autonomy_mutates_orders`) ומיגרציה אחת. **לא לממש בלי אמירה מפורשת שלו.**

---

## מפת השטח — מה קיים לפני שנוגעים

| רכיב | קובץ | מצב |
|---|---|---|
| חילוץ OCR | `supabase/functions/document-processing/index.ts` | עובד |
| פירוש OpenAI | `supabase/functions/interpret-document/{index,core}.ts` | עובד, ‏`strict: true` |
| חוזה הפירוש | `core.ts:123-174` | ‏`document_type` (7 ערכים), ‏`supplier.suggested_id`, ‏`fields[]`, ‏`line_items[]` |
| תבניות ייצוא | `src/lib/documentExport.ts` | xlsx/csv/json לפי סוג וספק |
| גלריית מסמכים | `src/pages/DocumentsInbox.tsx` | ‏547 שורות |
| מסך סקירה | `src/components/document-review/` | ‏10 קבצים |
| ניווט | `src/components/Layout.tsx:27-70` | ‏4 קבוצות |
| שבעת שלבי העיבוד | `src/lib/useDocumentProcessing.ts:15-38` | חשופים כתוויות וכמסננים |

**נקודת ההדק היום:** ‏`DocumentReview.tsx:31-36` — הפירוש נקרא **מהדפדפן**, כשמישהו פותח את מסך הסקירה. אין הפעלה אוטומטית בשרת.

## כללים שיפילו את השער אם יופרו

1. **מספרי מיגרציה: הבא הוא `0075`.** ‏`0072` נשארת ריקה במכוון — `DEBT-REGISTER` "מה אין כאן": *מספר מיגרציה אינו מכסה שיש למלא*. **אל תמלא אותה.**
2. **כל מיגרציה מעל `0057` חייבת את בלוק ה-re-assert** של `private.scope_enforcement_violations()` (‏`DEBT-REGISTER` §9). ‏`0067` שכחה. אתה לא תשכח.
3. **כל טבלה חדשה חייבת `org_id` + ‏RLS + רישום ב-`private.scope_registry`.** טענה A1 מפילה את המיגרציה על טבלה לא-רשומה.
4. **`check:tokens`** — אפס מחלקות פלטה גולמיות ואפס הקסים ב-`.tsx`.
5. **RTL** — ‏`start`/`end`/`ms`/`me`/`ps`/`pe` בלבד. אף פעם לא `left`/`right`.
6. **‏`data-testid` ו-`data-*` קיימים לא משתנים.** ‏25 תרחישי דפדפן ו-20 סוויטות SQL נשענים עליהם. משנים **תוויות**, לא חוזי-בדיקה.
7. **מפתח `service_role` לעולם לא בדפדפן.**

---

# שלב A — ניווט וקטגוריית מסמכים

*אפס סיכון, נראה מיד. מתחילים כאן כדי שמשה יראה תוצאה לפני שנוגעים בכסף.*

### Task A1: מרכז הבקרה בראש הניווט

**Files:**
- Modify: `src/components/Layout.tsx:27-70`
- Test: `src/components/layout.spec.tsx` (create)

**Step 1: כתוב את הבדיקה הנכשלת**

```tsx
// src/components/layout.spec.tsx
import { describe, expect, it } from 'vitest';
import { NAV_SECTIONS } from './Layout';

describe('סדר הניווט', () => {
  it('מרכז הבקרה הוא הפריט הראשון', () => {
    const first = NAV_SECTIONS.flatMap((s) => s.items)[0];
    expect(first.to).toBe('/dashboard');
  });

  it('קיימת קבוצת מסמכים ייעודית', () => {
    const documents = NAV_SECTIONS.find((s) => s.section === 'מסמכים');
    expect(documents?.items.map((i) => i.to)).toEqual(['/documents', '/documents/archive']);
  });

  it('גלריית המסמכים אינה יושבת עוד תחת כספים', () => {
    const finance = NAV_SECTIONS.find((s) => s.section === 'כספים');
    expect(finance?.items.some((i) => i.to.startsWith('/documents'))).toBe(false);
  });
});
```

**Step 2: הרץ את הבדיקה כדי לוודא שהיא נכשלת**

Run: `npx vitest run src/components/layout.spec.tsx`
Expected: FAIL — `NAV_SECTIONS is not exported`

**Step 3: מימוש מינימלי**

ב-`Layout.tsx`, שנה `const NAV` ל-`export const NAV_SECTIONS` (והחלף את שני אתרי השימוש: `pageTitleFor` שורה 84 ו-`roleSections` שורה 108). סדר חדש:

```tsx
export const NAV_SECTIONS: { section: string; items: NavItem[] }[] = [
  {
    // מרכז הבקרה ראשון: הוא התשובה לסעיף 12 — מה דורש טיפול, עכשיו. הזמנה חדשה
    // יורדת למקום שני; היא הפעולה התכופה, אבל לא זו שפותחים איתה את היום.
    section: '',
    items: [
      { to: '/dashboard', label: 'מרכז הבקרה', icon: LayoutDashboard, roles: ['owner', 'office', 'kitchen', 'payer', 'accountant', 'supplier'] },
      { to: '/orders/new', label: 'הזמנה חדשה', icon: ShoppingCart, roles: ['owner', 'office', 'kitchen'] },
    ],
  },
  {
    section: 'מסמכים',
    items: [
      { to: '/documents', label: 'תיקיית המסמכים', icon: FolderOpen, roles: ['owner', 'office', 'kitchen'] },
      { to: '/documents/archive', label: 'ארכיון', icon: Archive, roles: ['owner', 'office', 'kitchen'] },
    ],
  },
  // רכש — ללא שינוי
  // כספים — ללא /documents
  // בקרה — ללא /dashboard
];
```

ייבא `FolderOpen, Archive` מ-`lucide-react` (שורה 2), והסר את `Inbox` אם לא נותר לו שימוש.

**Step 4: הרץ ואמת מעבר**

Run: `npx vitest run src/components/layout.spec.tsx`
Expected: PASS (3 בדיקות)

**Step 5: commit**

```bash
git add src/components/Layout.tsx src/components/layout.spec.tsx
git commit -m "Put the control centre first, and give documents their own group"
```

---

### Task A2: מסלול הארכיון

**Files:**
- Modify: `src/App.tsx:244-246`
- Modify: `src/pages/DocumentsInbox.tsx` (מסנן `filing`)

**Step 1:** הוסף מסלול ב-`App.tsx` מיד אחרי שורה 244:

```tsx
<Route path="/documents/archive" element={<Guard roles={STAFF}><DocumentsGallery archive /></Guard>} />
```

**Step 2:** ב-`DocumentsInbox.tsx` קבל `archive?: boolean` והוסף לשאילתה `.eq('entity_type', 'archive')` כשהוא דולק. הכותרת: `ארכיון מסמכים`. מצב ריק: `"אין מסמכים בארכיון. מסמכים שהמערכת לא הצליחה לשייך לאף קטגוריה יופיעו כאן."`

**Step 3:** `npm run test` → ירוק. **Step 4:** commit.

```bash
git commit -m "Add the archive route above the gallery it reuses"
```

---

# שלב B — סכימת הקטגוריה והארכיון

### Task B1: מיגרציה `0075` — יעד `archive` ורשומת השיוך

**Files:**
- Create: `supabase/migrations/0075_document_filing_and_archive.sql`
- Create: `supabase/tests/p11_document_filing.sql`

**מה המיגרציה עושה:**

1. **מרחיבה את `file_document`** לקבל `p_entity_type = 'archive'` עם `p_entity_id = null`. שאר היעדים ללא שינוי.
2. **מרחיבה את מדיניות ה-Storage** ‏(`0022_p0_security_contract.sql:662`) — ‏`entity_type in ('inbox','invoice','goods_receipt','payment','archive')`. **קרא את ההגדרה החיה ב-`pg_policy` והזרק לתוכה** — אל תצהיר מחדש מהטקסט של `0022`. זה בדיוק מוקש ה-silent-revert של גל 4 (`PROGRESS` — "תמיד מול ההגדרה החיה").
3. **טבלה חדשה `document_filings`** — למה טבלה ולא עמודה: טריגר `0019` מקפיא את רוב עמודות `documents`, והחלטת שיוך היא **אירוע** (מי, מתי, לפי איזה פירוש, באיזה ביטחון) ולא תכונה.

```sql
create table public.document_filings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  document_id uuid not null references documents(id),
  category text not null,           -- ערך מתוך document_type של חוזה הפירוש
  supplier_id uuid references suppliers(id),
  interpretation_id uuid references document_interpretations(id),
  confidence numeric,               -- null = לא ידוע. לעולם לא 0 כשאין נתון.
  decided_by text not null check (decided_by in ('system','user')),
  decided_at timestamptz not null default now(),
  reverted_at timestamptz,          -- מחיקה רכה: היסטוריה נשמרת
  reverted_reason text
);
create unique index document_filings_active_one
  on document_filings (org_id, document_id) where reverted_at is null;
```

4. **`org_id` + RLS + רישום ב-`private.scope_registry`** — ‏A1 תפיל את המיגרציה בלעדיו.
5. **בלוק ה-re-assert** של `scope_enforcement_violations()` — חובה (`DEBT-REGISTER` §9).

**Step 1: כתוב את סוויטת הבדיקה תחילה** — `p11_document_filing.sql`, לפחות חמש טענות:
- ‏`file_document(..., 'archive', null, סיבה)` מצליח וכותב `audit_logs` עם הסיבה
- ‏`file_document(..., 'archive', <uuid>, ...)` **נדחה** בשם — ארכיון אינו נושא ישות
- דייר ב' אינו רואה שיוך של דייר א'
- ‏האינדקס החלקי דוחה שיוך פעיל שני לאותו מסמך
- **הוכחת מוטציה:** הסרת האינדקס ⇒ הטענה נכשלת

**Step 2:** `powershell -File scripts/db-query.ps1 -File supabase/tests/p11_document_filing.sql` → FAIL (הטבלה לא קיימת)

**Step 3:** כתוב את המיגרציה. **Step 4:** החל והרץ → PASS. **Step 5:** רשום את הסוויטה ב-`check-quality-gates.ps1` (‏`Invoke-SqlTest` העשרים-ואחת) ועדכן את המספר ב-`CLAUDE.md`.

```bash
git commit -m "Let a document be filed to the archive, and record who decided"
```

---

# שלב C — שכבת ההחלטה (ליבת אפשרות ב')

### Task C1: הגדרות האוטונומיה

**Files:**
- Create: `supabase/migrations/0076_document_autonomy_config.sql`
- Modify: `docs/OPEN-DECISIONS.md` (הכרעה חדשה **#109**)

שתי הגדרות פר-ארגון על תשתית ה-flags של `0059`, נכתבות **רק** דרך `platform_set_org_flag` (סיבה + audit):

| מפתח | ברירת מחדל | משמעות |
|---|---|---|
| `document_autonomy` | **false** | האם המערכת רשאית לכתוב רשומה כספית בלי אישור |
| `document_autonomy_threshold` | **0.90** | סף `document_type_confidence` **וגם** `supplier.confidence` |

**רשום `#109` ב-`OPEN-DECISIONS.md`** — הנוסח: *"סף האוטונומיה נקבע ל-0.90 כברירת מחדל מתועדת. לא נמדד מול קורפוס אמיתי; הצעד הזול לכיול הוא 50 מסמכים אמיתיים והשוואת ההחלטה האוטומטית להכרעת אדם."* **אל תכתוב שהסף מכויל. הוא לא.**

```bash
git commit -m "Give document autonomy an operator switch and a written threshold"
```

---

### Task C2: `apply_document_interpretation` — ההחלטה, בעסקה אחת

**Files:**
- Create: `supabase/migrations/0077_apply_document_interpretation.sql`
- Create: `supabase/tests/p12_document_autonomy.sql`

`SECURITY DEFINER`, מוענקת ל-`service_role` בלבד. שלושה מוצאים אפשריים:

```
                 ┌─ ביטחון ≥ סף  AND  אף תנאי עצירה  ──→ auto_applied
interpretation ──┼─ document_type = 'other'  ────────────→ archived
                 └─ אחרת  ────────────────────────────────→ queued_for_review
```

**ההשלכות של כל מוצא:**

| מוצא | מה נכתב |
|---|---|
| `auto_applied` | ‏`document_filings` + החשבונית עצמה + `audit_logs` עם הסיבה המלאה + שורת `document_auto_actions` (מפתח הביטול) |
| `archived` | ‏`file_document(..., 'archive', ...)` + `document_filings` בלבד. **אפס כתיבה כספית.** |
| `queued_for_review` | ‏`document_filings` עם `decided_by='system'` ותו לא. המסמך ממתין לאדם. |

**נוסח הסיבה — היא לא קישוט, היא חוזה:**

```
'שיוך אוטומטי לפי פירוש מסמך. מודל: %s, גרסת פרומפט: %s, פירוש: %s, ביטחון: %s'
```

**Step 1: הסוויטה קודמת.** ‏`p12_document_autonomy.sql` — לפחות תשע טענות:

1. הדגל כבוי ⇒ **אפס** כתיבה אוטומטית, גם בביטחון 0.99
2. מתחת לסף ⇒ `queued_for_review`, אפס חשבונית
3. מעל הסף עם כל התנאים ⇒ חשבונית אחת + audit עם סיבה **שמכילה את מזהה הפירוש**
4. **קריאה שנייה על אותו מסמך ⇒ אפס חשבונית שנייה** (אידמפוטנטיות)
5. `document_type='other'` ⇒ ארכיון, אפס כתיבה כספית
6. ‏`supplier.suggested_id` ‏null ⇒ לתור, לא לניחוש
7. בידוד דיירים: הפעלה בדייר א' לא נוגעת בדייר ב'
8. `revert_document_auto_action` מחזיר את המצב ומשאיר את שתי שורות ה-audit
9. **הוכחת מוטציה:** הסרת בדיקת הדגל ⇒ טענה 1 נכשלת

**Step 2:** הרץ → FAIL. **Step 3:** כתוב את המיגרציה (כולל re-assert + scope_registry). **Step 4:** הרץ → PASS.

```bash
git commit -m "Let the interpretation act, inside one transaction that can be undone"
```

---

### Task C3: חמשת תנאי העצירה

**Files:** Modify: `supabase/migrations/0077_...` · Modify: `supabase/tests/p12_document_autonomy.sql`

אפילו מעל הסף, **אין כתיבה אוטומטית** אם מתקיים אחד מאלה. כל אחד מנתב ל-`queued_for_review` עם סיבה בשם:

| # | תנאי | למה זו לא זהירות-יתר |
|---|---|---|
| 1 | `supplier.suggested_id is null` | ספק לא מזוהה = אין למה לשייך כסף |
| 2 | ‏`total` חסר / לא-מספרי | חשבונית בלי סכום היא לא חשבונית |
| 3 | **כפילות**: אותו `(org_id, supplier_id, lower(trim(invoice_number)))` על שורה חיה | ההגדרה הקיימת מ-`0053`. תשלום כפול הוא הנזק הגרוע ביותר במערכת הזאת |
| 4 | סכום המסמך סותר הקצאה קיימת על אותה חשבונית | ‏`payment_allocations` כבר נגעו בה. שכתוב = פגיעה ביתרה מחושבת |
| 5 | הארגון אינו `trial`/`active` | תקדים `interpret-document:356-361` |

**כל תנאי מקבל טענה משלו בסוויטה.** הוסף גם טענה שסופרת שכל החמישה מכוסים — כדי שהוספת תנאי שישי בלי בדיקה תיפול.

```bash
git commit -m "Name the five cases where confidence is not enough"
```

---

### Task C4: חיבור לצינור + פריט חסר כחריג

**Files:**
- Modify: `supabase/functions/interpret-document/index.ts` (אחרי שורה 568)
- Create: `supabase/functions/interpret-document/apply.test.ts`

אחרי `save_document_interpretation` המצליח, קריאה אחת:

```ts
// The interpretation is saved and immutable. Acting on it is a separate, auditable decision:
// a failure here must never lose the interpretation the tenant already paid for.
const applied = await admin.rpc("apply_document_interpretation", {
  p_job_id: job.id,
  p_interpretation_id: String(saved.data),
  p_actor_id: actorId,
});
if (applied.error) console.error("apply_document_interpretation failed", applied.error.message);
```

**שים לב לסדר:** כשל בהחלטה **אינו** מפיל את הפירוש. הפירוש נשמר; ההחלטה תרוץ שוב.

**הפריט החסר:** בתוך `apply_document_interpretation`, כאשר `line_items` מכיל פריט שאין לו התאמה ב-`purchase_order_items` של ההזמנה המקושרת — הפריט נכנס לחשבונית, ונפתח חריג. **`purchase_orders` ו-`purchase_order_items` אינן נכתבות.** ראה "הסטייה היחידה" בראש המסמך.

הוסף טענה עשירית ל-`p12`: פריט שלא הוזמן ⇒ חשבונית נוצרת **וגם** חריג נפתח **וגם** ‏`purchase_order_items` ללא שינוי (‏count לפני = count אחרי).

```bash
git commit -m "Wire the decision after the interpretation it can never destroy"
```

---

### Task C5: הביטול — פעולה אחת מנומקת

**Files:** Modify: `supabase/migrations/0077_...` · Modify: `src/pages/DocumentsInbox.tsx`

`revert_document_auto_action(p_action_id uuid, p_reason text)` — ‏`p_reason` **חובה**, ריק נדחה בשם. מחיקה רכה של החשבונית שנוצרה, ‏`reverted_at` על השיוך, ושתי שורות `audit_logs` (היצירה **נשארת**).

בממשק: על כל מסמך שטופל אוטומטית, פעולה **"ביטול השיוך האוטומטי"** ב-`ActionMenu` הקיים, עם `ConfirmDialog` ושדה סיבה. אף פעם לא `confirm()`.

```bash
git commit -m "Make every automatic write undoable in one reasoned action"
```

---

# שלב D — להוריד את המכונה מהמסך

### Task D1: שלושה מצבים במקום שבעה

**Files:**
- Modify: `src/lib/useDocumentProcessing.ts:24-38`
- Modify: `src/pages/DocumentsInbox.tsx:43-57`
- Test: `src/lib/documentStage.spec.ts` (create)

שבעת השלבים **נשארים** במסד, ב-`data-*` ובסוויטות. משתנה **התווית בלבד**:

| שלב פנימי | מה המשתמש רואה |
|---|---|
| `unprocessed`, `queued`, `processing`, `extracted` | **נקלט** — "המערכת קוראת את המסמך" |
| `review` | **בבדיקה** — "ממתין לאישורך" |
| `completed` | **שויך** + שם היעד ("שויך לחשבונית 1042 — ספק X") |
| `failed` | **לא נקרא** — "לא הצלחנו לקרוא את המסמך. אפשר לשייך ידנית." |

**קריטי לשער:** ‏`data-testid="document-processing-status"` ו-`data-document-id` **לא משתנים**, ומתווסף `data-stage={stage}` עם הערך הגולמי. כך `check-browser-smoke.cjs` ממשיך למדוד את המצב האמיתי בזמן שהאדם רואה עברית.

```bash
git commit -m "Say what happened to the document, not what the machine is doing"
```

---

### Task D2: אחוזי הביטחון יורדים מהמסכים היומיומיים

**Files:**
- Modify: `src/components/document-review/model.ts:143-144`
- Modify: `DocumentReviewProposals.tsx` (‏6 אתרי קריאה), `DocumentSourceViewer.tsx:250,279`

`confidenceLabel()` מחזירה היום `רמת ביטחון 87%`. החלף בשלוש דרגות מילוליות — `זוהה בבירור` / `זוהה חלקית` / `לא ודאי` / `לא ידוע` (עבור `null`).

**האחוז לא נמחק — הוא עובר לגילוי מדורג.** ב-`DocumentReviewWorkspace` הוסף `<details>` בשם **"פרטים טכניים"**, סגור כברירת מחדל, ובתוכו האחוזים, תיבות התיחום ומזהי הראיות. הסוקר שצריך אותם מקבל אותם בקליק; מי שלא — לא רואה אותם בכלל.

עדכן את `model.test.ts` (‏16 בדיקות `node --test` דרך `check:review`).

```bash
git commit -m "Move the percentages behind a disclosure the reviewer opens on purpose"
```

---

# שלב E — מבואות סתומים

### Task E1: יצירת ספק מהירה, משותפת

**Files:**
- Create: `src/components/QuickCreateSupplier.tsx`
- Test: `src/components/quickCreateSupplier.spec.tsx`

**שדות: שם (חובה) + ח.פ/עוסק (רשות). זהו.**

> **‏`bank_details` אינו בטופס הזה, ואסור להוסיף אותו.** ‏`DEBT-REGISTER` §11: ‏`INSERT` על `suppliers.bank_details` שורד **בלי step-up ובלי סיבה** (#106 — נרשם, לא הוכרע). טופס יצירה מהירה שיכיל את השדה הזה מרחיב את דפוס הונאת-החשבוניות הקנוני לשלושה מסכים נוספים. השדה נשאר במסך הספקים המלא בלבד. **אם מבצע עתידי "משלים" את הטופס — הוא פותח פרצה.** נוסף כהערה בראש הקובץ.

בדיקות: שם ריק נדחה · הצלחה מחזירה id ובוחרת אותו · כשל מציג שגיאה בעברית ולא סוגר · ‏`bank_details` **אינו** בטופס (טענה מבנית שנכשלת אם מישהו יוסיף).

```bash
git commit -m "Let a supplier be created where the supplier is needed"
```

### Task E2: חיווט לשלושת המסכים

**Files:** `PriceListUpload.tsx:435-440` · `InvoiceNew.tsx:316-322` · `PaymentRequests.tsx:362-367`

ליד כל `<select>` של ספק: `+ ספק חדש`. אותו רכיב, אותה התנהגות, שלוש שורות לכל מסך.

**התחל ב-`PriceListUpload`** — שם הסתירה החדה ביותר: אותו דיאלוג יוצר **מוצרים** חדשים (`PriceListUpload.tsx:322`) ולא ספק.

```bash
git commit -m "Close the three supplier dead ends with the same door"
```

### Task E3: סבב איתור שיטתי — מונחה-משימה

**Files:** Create: `docs/DEAD-ENDS-AUDIT.md`

**זו המשימה שמשה ביקש שסבב הסוכנים יעשה ולא עשה.**

הסבב הקודם (`docs/persona-ux-audit/final/`) בדק העלאת מחירון **מצד הספק** — שם הזהות ידועה מהסשן — ונתן **4/5 ב"קלות תפעול"**. הוא בדק **מסלולים שקיימים**, לא **משימות שמשתמש צריך**. כשמודדים רק את המסלול התקין, כל מבוי סתום נראה כמו 4/5.

**השיטה, ולא "לעבור על המסכים":** נסח 15–20 משימות בניסוח של אדם — *"קיבלתי מחירון מספק שעדיין לא במערכת"*, *"הגיעה סחורה עם פריט שלא הזמנתי"*, *"ספק שינה מספר חשבון"* — והרץ כל אחת מקצה לקצה. לכל משימה תעד: כמה מסכים · כמה יציאות מההקשר · האם היא ניתנת להשלמה בכלל.

**קריטריון סיום:** כל משימה מסווגת `ישיר` / `סיבוב` / `חסום`, וכל `סיבוב`/`חסום` נושא נתיב `קובץ:שורה`.

**אל תתקן תוך כדי.** הפרדת האיתור מהתיקון היא הסיבה שהסבב הקודם החמיץ — מי שמתקן תוך כדי מפסיק לחפש.

```bash
git commit -m "Audit the app by the tasks people have, not the screens we built"
```

---

# שלב F — שער ואימות

### Task F1: השער האוטומטי
Run: `npm run build` → יציאה 0.

### Task F2: תרחישי דפדפן
הוסף ל-`scripts/check-browser-smoke.cjs` (‏25 → **28**):
1. מרכז הבקרה הוא הקישור הראשון בניווט, וקבוצת "מסמכים" קיימת
2. יצירת ספק מתוך דיאלוג המחירון — בלי לעזוב את המסך
3. גלריית המסמכים אינה מציגה אף `%` ואף מונח פנימי (טענה שלילית על טקסט המסך)

### Task F3: השער המלא
Run: `npm run quality` (‏PowerShell + Docker, ריצה אחת במכונה) → ‏`PASS`/`all_gates_passed`, אפס דילוגים.

### Task F4: אימות ויזואלי
צילומי מסך של הניווט החדש בשני viewports (‏1440 ו-390) ושל הגלריה נטולת-האחוזים. **בלי צילום — לא מדווח כבוצע** (`CLAUDE.md`, "דיווח").

### Task F5: תיעוד
- `docs/PROGRESS.md` — רשומה חדשה: מה נבנה, מה נמדד, **ומה לא** (הסף לא מכויל; שכתוב ההזמנה לא מומש)
- `docs/OPEN-DECISIONS.md` — ‏#109
- `docs/DEBT-REGISTER.md` — שורה חדשה: *"סף האוטונומיה 0.90 לא נמדד מול קורפוס אמיתי"*
- `CLAUDE.md` — מספרי הסוויטות והתרחישים המעודכנים

```bash
git commit -m "Record what the autonomy wave built, and what it left unmeasured"
```

---

## סיכום סיכונים

| סיכון | חומרה | המעקה |
|---|---|---|
| כתיבה אוטומטית שגויה על רשומה כספית | **גבוהה** | דגל כבוי כברירת מחדל · 5 תנאי עצירה · ביטול מנומק · audit מלא |
| כפילות חשבונית מ-retry | גבוהה | אינדקס ייחודי חלקי + טענה 4 ב-`p12` |
| סף 0.90 לא מכויל | **בינונית-גבוהה** | מוצהר ב-#109 וב-`DEBT-REGISTER`. **הסיכון היחיד שנשאר פתוח במכוון** |
| הצהרה-מחדש של מדיניות Storage מהטקסט הישן | גבוהה | ‏B1 מזריק להגדרה החיה מ-`pg_policy` |
| שינוי תווית ששובר תרחיש דפדפן | בינונית | ‏`data-testid` נשמר; `data-stage` נוסף |
| טופס הספק המהיר "יושלם" עם `bank_details` | בינונית | הערה בראש הקובץ + טענה מבנית ב-E1 |

## סדר עבודה מומלץ

**A → B → C → D → E → F.** ‏A ו-E1/E2 עצמאיים ואפשר להקדים אותם אם רוצים תוצאה נראית מוקדם. **C אינו מתחיל לפני ש-B עבר שער** — שכבת ההחלטה כותבת אל הסכימה שהוא מקים.
