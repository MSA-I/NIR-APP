# PLAN — STRIX Security Remediation (2026-08-19)

סריקה: `strix_runs/nir-app_29f7` (white-box, אפר' 2026-08-19).
4 ממצאים (1 קריטי, 3 נמוך) + 6 תצפיות. מקור: `penetration_test_report.md` / `vulnerabilities.json`.

---

## עדיפויות

| # | ממצא | חומרה | מאמץ | מתי |
|---|------|-------|-------|-----|
| 1 | מפתח OpenAI חשוף ב-`.env` | קריטי 9.1 | טריוויאלי | 🚨 עכשיו (24 שעות) |
| 2 | זיכויים בלי סינון ישות משפטית (`checks.ts`) | נמוך 3.1 | נמוך | ספירנט הבא |
| 3 | תפקיד `kitchen` עדיין ב-RPCs פיננסיים | נמוך 2.2 | נמוך | ספירנט הבא |
| 4 | אין חסימת UPDATE מפורשת על `storage.objects` | נמוך 2.2 | טריוויאלי | 2–4 שבועות |
| 5..11 | תצפיות (SHA-pinning וכו') | — | בינוני | 2–4 שבועות |

---

## 🚨 שלב 1 — קריטי, בתוך 24 שעות

### 1.1 סובב את מפתח ה-OpenAI
1. כנס ל-OpenAI dashboard → צור מפתח חדש.
2. בטל (revoke) את המפתח הישן מ-`supabase/functions/.env`.
3. עדכן את כל מקומות השימוש במפתח החדש (Edge Function OCR + worker).

### 1.2 העבר סודות ל-Supabase Secrets (לא קבצים)
```bash
supabase secrets set OPENAI_API_KEY=sk-... \
  OCR_WORKER_TOKEN=... \
  INTERPRET_DOCUMENT_CRON_SECRET=...
```
- `supabase/functions/.env` יישאר רק עם משתנים לא-רגישים.
- בפיתוח מקומי: השתמש ב-`.env.local` (כבר מכוסה ע"י `*.local`).

### 1.3 חסום את הקובץ מ-Git
`.gitignore` — להוסיף שורה ייעודית ל-`.env` של פונקציות:
```
# edge function secrets
supabase/functions/.env
```
(אני ממליץ על `**/.env` מלבד `!.env.example` — אבל המינימום הוא השורה למעלה.)

### 1.4 אימות
- `git log --all --oneline -- supabase/functions/.env` → חייב להיות ריק.
- (אם היה אי-פעם ב-commit — נדרש ניקוי היסטוריה מלא + סיבוב מפתח נוסף.)
- הריץ `gitleaks detect` ו-`trufflehog` על היסטוריית git כדי לוודא שאין סודות נוספים.
- שקול להוסיף pre-commit hook של `gitleaks` למניעת הישנות.

---

## שלב 2 — ספירנט הבא (High)

### 2.1 סינון ישות משפטית בזיכויים (`src/lib/checks.ts:118-121`)
היום:
```ts
const credits = await fetchAll<...>((from, to) => supabase.from('credit_requests')
  .select('id, amount, status').eq('supplier_id', inv.supplier_id)
  .in('status', ['open', 'requested', 'received'])
  .order('id').range(from, to));
```
תיקון: הוסף `.eq('unit_id', inv.unit_id)` (או הסתמך על RPC חדש שמראה `credit_request_legal_entity()` כמו `payment_request_financial_check_signals`).

**להחליט:** להוסיף `unit_id` לטיפוס החשבונית בפרונטאנד, או RPC צד-שרת שמחזיר רק זיכויים תואמי-ישות. עדיף RPC — שומר את הסמנטיקה במקום אחד.

אימות: טסט יחידה ל-`runInvoiceChecks` עם שתי ישויות תחת אותו ספק → אזהרת הזיכוי חייבת להופיע רק בישות הנכונה.

### 2.2 הסרת תפקיד `kitchen` מ-RPCs פיננסיים (migration 0023)
מigration חדש שיסיר את `kitchen` מרשימות התפקידים המקובלים ב:
- `create_invoice` (0023:1702)
- `create_invoice_credit_request` (0023:1983)
- `finalize_purchase_request_draft` (0023:2488)

**וגם:** סרוק את *כל* פונקציות SECURITY DEFINER ל-references של `kitchen`/`payer`/`supplier` והסר מהן גישה פיננסית.
```sql
SELECT proname FROM pg_proc
WHERE prosecdef AND prosrc ILIKE ANY(ARRAY['%kitchen%','%payer%','%supplier%']);
```

אימות: profile של kitchen חסום בכניסה *וגם* RPC מחזיר שגיאה גם אם מנסים לעקוף את חסימת ה-login.

---

## שלב 3 — שבועיים–4 שבועות (Medium)

### 3.1 חסימת UPDATE מפורשת על `storage.objects` (migration 0031 / 0022)
```sql
CREATE POLICY storage_objects_update_deny
  ON storage.objects FOR UPDATE TO authenticated USING (false);
```
מטרה: להפוך את חוסר-השינוי למפורש, שרדני לשינויי פלטפורמה.

### 3.2 SHA-pinning ל-GitHub Actions
נעל את כל 18 ה-actions עם `@v4`/`@v5` ל-commit SHA מלא (למשל דרך dependabot + `pin-github-action`).

### 3.3 סקירת קבוע `FINANCE` (`src/App.tsx:125`)
`FINANCE` === `STAFF` === `['owner','office']`. להחליט מול מוצר: האם `accountant` צריך גישה ל-`/payment-requests` ול-`/alerts`. לתעד ב-CLAUDE.md/AGENTS.md.

### 3.4 ולידצית סכום חשבונית בצד-שרת
ב-`create_invoice`: להוסיף בדיקה שסכום החשבונית תואם לסכום ההזמנות המקושרות (כרגע יש רק אזהרת לקוח). מונע כניסת פערים ל-ledger.

### 3.5 ניקוי `search_path` בפונקציות SECURITY DEFINER
הסר `pg_temp` מה-`search_path` ב-15+ פונקציות → השתמש ב-`search_path = public` באופן עקבי.

### 3.6 (המשך) draining של scope-exemption registry
6/55 טבלאות עם RESTRICTIVE riders לסקאופ. המשך ההשקה המדורגת — המגן ה-preflight עוצר ארגונים רב-יחידות כל עוד יש exempts.

### 3.7 Content Security Policy
הוסף CSP header (meta tag או vite-plugin) לשכבת הגנה נוספת מול XSS — ה-HTML ב-`orderImage.ts` מאושר כבר, אבל CSP מוסיף שכבה.

---

## סדר ביצוע מומלץ
1. **עכשיו:** שלב 1 (מפתח + secrets + gitignore) — לא מחכה לכלום.
2. **ספירנט הבא:** 2.1 + 2.2 (שני הקוד-תיקונים הקלים עם טסטים).
3. **המשך:** 3.x לפי סדר הרשימה.

## הערות
- שני agents במקביל עורכים את הריפו — `git status` לפני כל commit (כתוב ב-memory).
- כל שינוי migration דורש: `supabase db push` + הרצת טסטים + הפעלת quality gates (CI: `build.yml` + `quality-gate.yml`).
- אל תריץ `check-quality-gates.ps1` מקומית — הוא מסרב (quality gate רץ רק ב-CI).