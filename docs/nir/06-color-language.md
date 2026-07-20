# סעיף 6 — שפת צבעים אחידה

> תוכנית מימוש ברמת שורה. מסמך תכנון בלבד — לא נכתב בו קוד אפליקציה.
> כל הפניית `קובץ:שורה` במסמך נפתחה ואומתה מול הקוד ב-20.07.2026.

---

## 1. מה ניר ביקש

מתוך `NIR-APP-DOCS/המשך פיתוח.txt:92-104`, ציטוט מלא:

> **6. שימוש בצבעים**
>
> יש להגדיר שפה אחידה של צבעים במערכת.
>
> ירוק – פעולה הושלמה / תקין.
>
> כתום – ממתין לטיפול.
>
> אדום – חריגה או פעולה דחופה.
>
> כחול – מידע כללי.
>
> אחידות זו תאפשר זיהוי מהיר של מצב הנתונים.

**מה זה אומר בפועל.** הדרישה אינה "להחליף גוונים" אלא **להפוך את הצבע לטענה בעלת משמעות אחת**. כרגע הצבע במערכת הוא תיאור ויזואלי (`green`, `violet`), לא טענה עסקית. אחרי הסעיף הזה, משתמש שרואה כתום צריך לדעת בוודאות: *מישהו צריך לעשות משהו*. אם כתום מופיע גם על מצב שאין בו מה לעשות — השפה נשברה.

**נגזרת ישירה:** ארבעה צבעים = ארבע קטגוריות בלבד. כל גוון חמישי במערכת הוא באג בשפה, לא בקוד.

---

## 2. מה קיים היום

### 2.1 `src/index.css` — 56 שורות, זו כל מערכת העיצוב

| מיקום | תוכן | ממצא |
|---|---|---|
| `index.css:3-5` | בלוק `@theme` | מכיל **טוקן אחד בלבד** — `--font-sans`. **אפס טוקני צבע סמנטיים.** זהו הפער המרכזי של הסעיף. |
| `index.css:13-14` | הערה | מסבירה למה `btn`/`badge` הם `@utility` ולא `@layer components`: ב-Tailwind v4 `@apply` יכול להפנות רק ל-utilities אמיתיים. **אין `tailwind.config.js`** (`CLAUDE.md:41`) — טוקנים חיים ב-`@theme` בתוך `index.css`. |
| `index.css:15-17` | `@utility btn` | בסיס חסר-צבע |
| `index.css:18-20` | `@utility badge` | בסיס חסר-צבע |
| `index.css:22-46` | `@layer components` | אוצר-המילים האמיתי: `.card` `.card-pad` `.btn-primary` (indigo-700) `.btn-secondary` `.btn-danger` (rose-600) `.btn-ghost` `.input` `.label` `.th` `.td` `.page-title` `.section-title` |
| `index.css:34-39` | שש וריאנטות badge | `badge-green` (emerald-100/800) · `badge-amber` (amber-100/800) · `badge-red` (rose-100/800) · `badge-blue` (sky-100/800) · `badge-slate` (slate-100/**700**) · `badge-violet` (violet-100/800) |
| `index.css:49` | `.num` | utility מספרי ל-RTL |

**חריגה בתוך הקובץ עצמו:** `index.css:38` — `badge-slate` משתמש ב-`text-slate-700` בעוד שכל חמש האחרות משתמשות ב-`-800`. חוסר-אחידות בשש שורות רצופות.

### 2.2 `src/lib/status.ts` — 167 שורות

- `Tone` — union בן שישה ערכים, `status.ts:2`
- `StatusMeta { label, tone }`, `status.ts:3`
- קונסטרקטור `m()`, `status.ts:5`
- **14 מילוני סטטוס** (לא 13): `ORG_STATUS:7` · `INVITATION_STATUS:13` · `SUPPLIER_STATUS:20` · `PO_STATUS:27` · `REQUEST_STATUS:37` · `RECEIPT_LINE_STATUS:43` · `INVOICE_REVIEW_STATUS:51` · `INVOICE_PAYMENT_STATUS:59` · `INVOICE_EXPORT_STATUS:65` · `CREDIT_STATUS:79` · `PAYMENT_REQUEST_STATUS:87` · `BANK_TX_STATUS:99` · `EXCEPTION_STATUS:118` · `SEVERITY:125`
- מפות תווית-בלבד (ללא tone): `CREDIT_REASON:70` · `EXCEPTION_TYPE:106` · `ROLE_LABEL:137` · `resolveRoleLabels():156`

### 2.3 מדידות — נמדדו מחדש

| מדד | מספר | הערה |
|---|---|---|
| אתרי רינדור `<StatusBadge` | **33** ב-14 קבצים | עוברים דרך `status.ts` |
| `badge-*` מקודדים ידנית ב-JSX | **10 אלמנטים על 7 שורות** ב-7 קבצים | עוקפים את `status.ts` |
| `<ErrorNote` | **32** ב-22 קבצים | |
| `<KpiCard` | **10** — כולם ב-`Dashboard.tsx:141-155` | |
| מחלקות גוון סמנטי גולמיות | **146 מופעים** על 79 שורות ב-24 קבצים | `(bg\|text\|border\|ring\|from\|to\|via\|divide\|hover:*)-(emerald\|green\|amber\|yellow\|orange\|rose\|red\|sky\|blue\|violet\|purple\|teal\|lime)-\d+` |
| כולל chrome (slate/indigo/gray) | **509 מופעים** | |

שבע השורות שעוקפות את `status.ts`:

| מיקום | מה |
|---|---|
| `Dashboard.tsx:229` | `badge-red` על **מדד** (אחוז התייקרות), לא על סטטוס |
| `PaymentRequests.tsx:197` | `badge-amber` — "טרם אושרה" |
| `Onboarding.tsx:472` | `badge-blue` — "חדשה" |
| `PriceLists.tsx:58` | `badge-green`/`badge-red` — זמינות |
| `SupplierPrices.tsx:38` | **מחרוזת זהה לחלוטין** ל-`PriceLists.tsx:58` — לוגיקת זמינות משוכפלת |
| `Reports.tsx:114` | `badge-green` — "הועבר לרו״ח" |
| `Settings.tsx:188` | `badge-green`/`badge-slate` — פעיל/מושבת |

### 2.4 בעיית השמות

ערכי `Tone` הם **גוונים, לא סמנטיקה**: `green | amber | red | blue | slate | violet`. הדרישה של ניר סמנטית: הושלם / ממתין / חריגה / מידע. כל עוד השם הוא "green", אין שום דבר שמונע ממפתח לצבוע ירוק משהו שלא הושלם — ואכן זה קרה (ראו §3.4 ו-§5).

### 2.5 המלכודת שהופכת שינוי-שם למסוכן

`src/components/ui.tsx:6-9`:

```tsx
export function StatusBadge({ meta }: { meta: StatusMeta | undefined }) {
  if (!meta) return null;
  return <span className={`badge-${meta.tone}`}>{meta.label}</span>;
}
```

שם המחלקה נבנה ב-**template literal** בשורה `ui.tsx:8`. **Tailwind אינו רואה את השמות האלה סטטית.** הם שורדים אך ורק משום ש-`badge-green`…`badge-violet` כתובים במפורש ב-`index.css:34-39`.

> **⚠️ אזהרה מרכזית של הסעיף.** כל שינוי-שם חייב לשנות את שני הצדדים — `status.ts` ו-`index.css` — **באופן אטומי, או בסדר שמבטיח שכל שם שנפלט מה-TSX כבר קיים ב-CSS**. אחרת התגים מאבדים את כל הצבע שלהם **בשקט**: אין שגיאת TypeScript, אין שגיאת build, אין אזהרה בקונסולה. רק תגית לבנה. `npm run build` יעבור בהצלחה. סדר המיגרציה ב-§4.7 הוא לכן חלק מהמפרט, לא המלצה.

---

## 3. הפערים

### 3.1 ארבע מימושים עצמאיים של "תיבת התראה", ללא קומפוננטה משותפת

| מימוש | מיקום | מחלקות |
|---|---|---|
| `ErrorNote` | `ui.tsx:30-32` | `bg-rose-50 border-rose-200 text-rose-`**`700`** |
| כפילות של `ErrorNote` | `NewOrder.tsx:225` | `bg-rose-50 border-rose-200 text-rose-700` — **זהה, מועתק ידנית** |
| מפת `CheckList` | `Invoices.tsx:21-25` | critical/warning/info, טקסט `-`**`800`** |
| הצלחה ad-hoc | ראו למטה | **שלושה גוונים שונים של טקסט ירוק** |
| אזהרה ad-hoc | ראו למטה | **שלושה גוונים שונים של מסגרת כתומה** |

**תיבות ירוקות — שלושה גוונים ושתי מסגרות:**

| מיקום | טקסט | מסגרת |
|---|---|---|
| `Invoices.tsx:18` | emerald-700 | emerald-200 |
| `Orders.tsx:181` | emerald-800 | emerald-200 |
| `Bank.tsx:190` | emerald-800 | emerald-200 |
| `SupplierPrices.tsx:181` | emerald-800 | emerald-200 |
| `PriceLists.tsx:240` | emerald-800 | emerald-200 |
| `Exceptions.tsx:135` | emerald-800 | emerald-**100** |
| `Onboarding.tsx:566` | emerald-**900** | emerald-200 |

**תיבות כתומות — שלוש מסגרות ושני גוונים:**

| מיקום | מסגרת | טקסט |
|---|---|---|
| `AuditLog.tsx:76` | amber-**100** | amber-800 |
| `PayerQueue.tsx:155` | amber-**100** | amber-800 |
| `Orders.tsx:189` | amber-200 | amber-800 |
| `Onboarding.tsx:678` | amber-200 | amber-900 (`:679`) / amber-800 (`:682`) |
| `Onboarding.tsx:1024` | amber-200 | amber-900 |
| `Reports.tsx:136` | amber-200 | amber-800 (`:137`) / amber-900 (`:138`) |
| `NewOrder.tsx:233` | amber-**300** | — |

**תיבת מידע (כחול) — יש רק שתיים, והן דווקא עקביות:** `Invoices.tsx:24` ו-`SupplierPrices.tsx:60`, שתיהן `sky-50/200/800`.

**סה״כ: ~8 וריאציות של מסגרת/טקסט עבור 4 סוגי תיבה סמנטיים, ב-14 מקומות, ללא קומפוננטה אחת.**

### 3.2 `Receiving.tsx` מממש מחדש את כל מערכת הטונים, מקומית

`src/pages/Receiving.tsx:210-220` — שתי מפות מקבילות:

```
statusTone (:210-216)   full/partial/missing/damaged/returned → bg-*-600 text-white border-*-600
cardTone   (:217-220)   full/partial/missing/damaged/returned → border-*-200 / -300
```

מיושמות ב-`Receiving.tsx:235` (`cardTone`) וב-`:262` (`statusTone`). זאת **למרות** ש-`RECEIPT_LINE_STATUS` (`status.ts:43-49`) כבר נושא את הטונים עבור בדיוק חמשת המצבים האלה — והקובץ אף משתמש בו ב-`Receiving.tsx:244` דרך `<StatusBadge>`. שלוש מערכות טונים לאותם חמישה מצבים, באותו קובץ.

> **תיקון לממצא קודם:** נטען ש-`statusTone` חסר ערך `returned` בעוד ש-`cardTone` כולל אותו. **זה לא נכון** — `Receiving.tsx:215` מכיל `returned: 'bg-violet-600 text-white border-violet-600'`. שתי המפות מלאות. אין פער סמוי.
>
> **אבל יש חוסר-אחידות אמיתי אחר באותה מפה:** `Receiving.tsx:212` משתמש ב-`bg-amber-`**`500`** בעוד ששאר הערכים משתמשים ב-`-600`.

### 3.3 `KpiCard` נושא אוצר-מילים רביעי ונפרד

`src/components/ui.tsx:35-47`:
- prop מטופס ידנית ב-`ui.tsx:36`: `tone?: 'slate' | 'green' | 'amber' | 'red' | 'blue'`
- מפה משלו ב-`ui.tsx:38`: `{ slate: 'text-slate-900', green: 'text-emerald-700', amber: 'text-amber-600', red: 'text-rose-600', blue: 'text-sky-700' }`

זהו union **מקביל מבנית** ל-`Tone` (`status.ts:2`), חסר את `violet`, ו-**אינו קשור אליו טיפולוגית בשום צורה**. שינוי ב-`Tone` לא ייצור שגיאת קומפילציה כאן. אתרי הקריאה: `Dashboard.tsx:141-155` (10 מופעים, כולם באותו קובץ).

הבדל מהותי נוסף: `KpiCard` משתמש ב-**צבע חזית בלבד** (`text-emerald-700`), בעוד ש-`badge-*` משתמש בזוג רקע+חזית. כלומר טוקן סמנטי חייב לחשוף **יותר ממשטח אחד** — ראו §4.1.

### 3.4 אדום פירושו כרגע שני דברים הפוכים

| מיקום | אדום פירושו | תואם לדרישה? |
|---|---|---|
| `EXCEPTION_STATUS.open` (`status.ts:119`) | חריגה פתוחה | ✅ |
| `SEVERITY.high` (`status.ts:128`) | חומרה גבוהה | ✅ |
| `Dashboard.tsx:163` | שינוי חודש-מול-חודש **חיובי** בהוצאות | ❌ מגמה, לא חריגה |
| `Dashboard.tsx:218` | אייקון `TrendingUp` ליד "מוצרים שהתייקרו" | ❌ מגמה |
| `Dashboard.tsx:229` | `badge-red` על אחוז ההתייקרות | ❌ מגמה, ובנוסף מדד ולא סטטוס |
| `PriceLists.tsx:53-54` | rose = מחיר עלה, emerald = מחיר ירד | ❌ מגמה |

**`Dashboard.tsx:163` הוא המקרה החד ביותר:** הוא צובע באדום עלייה חיובית בהוצאות רכש. תחת השפה החדשה, המשתמש יקרא "חריגה דחופה" על נתון שהוא בסך הכול כיוון.

> **מסקנה מחייבת:** לא ניתן לקיים את "אדום = חריגה" בלי **להפריד פלטת-מגמה מפלטת-סטטוס**. אחרת הכלל של ניר נשבר בדשבורד עצמו — בדיוק במסך שהוא הכי רוצה שיהיה קריא.

### 3.5 שלושה אוצרות-מילים של חומרה, ללא קשר טיפולוגי ביניהם

| טיפוס | מיקום | ערכים |
|---|---|---|
| `Tone` | `status.ts:2` | green, amber, red, blue, slate, violet (6) |
| `CheckSeverity` | `checks.ts:4` | info, warning, critical (3) |
| `SEVERITY` | `status.ts:125` | low, medium, high (3) |

`CheckSeverity` נצרך ב-`Invoices.tsx:20-25` דרך שתי מפות מקבילות (`icon`, `cls`) ומרונדר ב-`Invoices.tsx:31`. `CheckList` עצמו נקרא מארבעה מקומות: `InvoiceNew.tsx:137`, `InvoiceDetail.tsx:159`, `PaymentRequests.tsx:219`, `PaymentRequests.tsx:296`.

### 3.6 ממצאים נוספים שלא היו במיפוי המקורי

| # | מיקום | ממצא |
|---|---|---|
| א | `Bank.tsx:442` | **תג חמישי מאולתר** — משתמש ב-`badge` הבסיסי עם גוונים גולמיים ובסף מספרי (`>= 0.85` ירוק, `>= 0.7` כתום, אחרת אפור). זהו **סולם ביטחון**, לא סטטוס. תחת השפה החדשה "ביטחון גבוה" ≠ "הושלם". |
| ב | `Bank.tsx:494` | `btn-secondary text-amber-700` — כפתור בגוון אזהרה, וריאציה שביעית של סגנון כפתור-פעולה |
| ג | `NewOrder.tsx:225` | שכפול מילולי של `ErrorNote` (`ui.tsx:31`) |
| ד | `index.css:38` | `badge-slate` ב-`text-slate-700` בעוד שכל השאר ב-`-800` |
| ה | `Receiving.tsx:212` | `bg-amber-500` בעוד שכל השאר במפה `-600` |
| ו | `CREDIT_STATUS.received` | ירוק ב-`status.ts:82`, אך `checks.ts:110` ו-`checks.ts:179` **סופרים אותו כזיכוי פתוח שטרם קוזז**. הצבע סותר את הלוגיקה העסקית באותו ריפו. |
| ז | `PAYMENT_REQUEST_STATUS` | **שני ירוקים באותו מילון** — `approved` (`:90`) ו-`matched` (`:93`). אחד מהם באמצע התהליך. |

### 3.7 חוסר-אחידות נוספת (רקע לתכנון)

- **`REQUEST_STATUS` (`status.ts:37-41`) הוא קוד מת.** אומת ב-grep על כל `src/` — המופע היחיד של המזהה הוא ההגדרה עצמה. (המופעים האחרים ב-grep הם `PAYMENT_REQUEST_STATUS`, טיפוס אחר.)
- **כפתור WhatsApp** — `Orders.tsx:161`: `btn text-white bg-emerald-600 hover:bg-emerald-700`. ירוק-מותג שייקרא כ"הושלם". אין `.btn-success` במערכת.
- **פעולות מסוכנות מסוגננות בארבע דרכים:** `.btn-danger` (מוגדר `index.css:28`, בשימוש ב-`InvoiceNew.tsx:146`, `PaymentRequests.tsx:224`, `PaymentRequests.tsx:305`, `ui.tsx:90`) · `btn-ghost text-rose-600` (`PaymentRequests.tsx:313`, `Orders.tsx:175`, `Settings.tsx:152`, `Admin.tsx:98`) · `btn-secondary text-rose-600` (`InvoiceDetail.tsx:94`) · `btn-secondary text-amber-700` (`Bank.tsx:494`).
- **`useToast`** — `ToastProvider` ב-`ui.tsx:104-123`; `ui.tsx:116` מרנדר הצלחה כ-`bg-slate-800`, **לא ירוק**. סותר ישירות "ירוק = פעולה הושלמה".
- **ניב "יתרה כספית" חוזר ב-10 מקומות** עם מחלקות נודדות: `Invoices.tsx:68` (amber-700 / emerald-600) · `InvoiceDetail.tsx:112` (emerald-700) · `InvoiceDetail.tsx:114` (amber-700 / emerald-700) · `Suppliers.tsx:38` (amber-700) · `Suppliers.tsx:195` (amber-700 / emerald-700) · `Dashboard.tsx:270` (amber-700) · `Reports.tsx:130` (emerald-700) · `Reports.tsx:131` (amber-600) · `Reports.tsx:132` (rose-600) · `Bank.tsx:482` (amber-600 / emerald-600).

---

## 4. מה לבנות

### 4.1 טוקנים סמנטיים ב-`@theme`

**ההרחבה של `index.css:3-5`.** ב-Tailwind v4, כל טוקן ב-namespace של `--color-*` מייצר אוטומטית utilities מסוג `bg-*`, `text-*`, `border-*`, `ring-*`. הטוקנים מפנים לצבעי ברירת-המחדל של Tailwind שכבר טעונים — כך שהמעבר לא משנה אף פיקסל.

חמישה משטחים לכל סמנטיקה — נגזרים ישירות מהשימושים שנמדדו ב-§2-3, לא מטעם:

| משטח | לאן משמש | ראיה בקוד |
|---|---|---|
| `soft` + `on-soft` | רקע+טקסט של תג | `index.css:34-39` |
| `fg` | טקסט/אייקון עומד על לבן | `KpiCard` `ui.tsx:38`, ניב היתרה, `Exceptions.tsx:49` |
| `solid` | פקד ממולא | `Receiving.tsx:211-215`, toast `ui.tsx:116` |
| `wash` + `line` | רקע+מסגרת של תיבת התראה | `ui.tsx:31`, `Invoices.tsx:22-24` |

```
@theme {
  --font-sans: ...;                        /* קיים, לא נוגעים */

  /* done — פעולה הושלמה / תקין */
  --color-done-wash / -line / -soft / -on-soft / -fg / -solid
      → emerald-50 / 200 / 100 / 800 / 700 / 600

  /* await — ממתין לטיפול */
  --color-await-*  → amber-50 / 200 / 100 / 800 / 700 / 600

  /* alert — חריגה או פעולה דחופה */
  --color-alert-*  → rose-50 / 200 / 100 / 800 / 700 / 600

  /* info — מידע כללי */
  --color-info-*   → sky-50 / 200 / 100 / 800 / 700 / 600

  /* idle — ניטרלי (ראו הכרעה פ-1) */
  --color-idle-*   → slate-50 / 200 / 100 / 800 / 700 / 600
}
```

**שלוש הערות מחייבות:**

1. **הערכים זהים לקיים** — `emerald-100/800`, `amber-100/800`, `rose-100/800`, `sky-100/800`. הצעד הזה הוא **חסר-השפעה ויזואלית לחלוטין** בכוונה. הוא רק נותן שם. כל סטייה ויזואלית בצילום המסך אחרי שלב 2 (§4.7) היא באג מיפוי, לא שיפור.
2. **`idle` תוקן ל-`-800`** ולא `-700` (כיום `index.css:38`), ליישור עם חמש האחרות. זהו שינוי ויזואלי קטן ומכוון — יש לתעד אותו בצילום המסך.
3. **`idle` הוא צבע חמישי ולכן דורש הצדקה מפורשת.** ניר נתן ארבעה. אבל תג חייב לרנדר *משהו*, ו-11 סטטוסים במערכת אינם אף אחת מארבע הקטגוריות (טיוטה, בוטל, פג תוקף, לא רלוונטי…). אפור אינו "צבע חמישי בשפה" — הוא **היעדר טענה**, ולכן אינו מפר את "ארבעה צבעים". זה עדיין הכרעה — ראו פ-1.

### 4.2 שינוי-שם `Tone`: כן, ובסדר קפדני

**ההכרעה: לשנות את השם.**

הנימוק אינו אסתטי. כל עוד הערך נקרא `'green'`, אין שום דבר במערכת שמונע ממפתח לסמן ירוק מצב שלא הושלם — ובדיוק זה קרה: `CREDIT_STATUS.received` ירוק בעוד ש-`checks.ts:110` סופר אותו כפתוח (§3.6ו), ו-`PAYMENT_REQUEST_STATUS` מחזיק שני ירוקים שונים במהותם (§3.6ז). שם סמנטי הופך כל הצבה כזאת לשאלה גלויה בזמן כתיבת הקוד. שם-גוון לא.

```
'green'  → 'done'
'amber'  → 'await'
'red'    → 'alert'
'blue'   → 'info'
'slate'  → 'idle'
'violet' → נמחק (ראו §5 והכרעה פ-2)
```

- `status.ts:2` — ה-union
- `status.ts:5` — `m()` נשאר כפי שהוא, החתימה נגזרת מ-`Tone`
- 14 המילונים — TypeScript יסמן **כל** הצבה שלא עודכנה. זהו שער הטיפוסים.
- `ui.tsx:8` — ה-template literal **לא משתנה כלל**. הוא ימשיך לעבוד; אבל בדיוק בגלל זה הוא לא ייתן שום אזהרה אם הצד של ה-CSS פיגר. ראו §4.7.

### 4.3 קומפוננטת תיבת-התראה משותפת

**ב-`index.css`, בעקבות הדפוס הקיים של `btn`/`badge` (`index.css:13-20`):**

```
@utility note { … flex items-start gap-2 rounded-lg border px-4 py-3 text-sm … }

@layer components {
  .note-done  { @apply note bg-done-wash  border-done-line  text-done-on-soft; }
  .note-await { @apply note bg-await-wash border-await-line text-await-on-soft; }
  .note-alert { @apply note bg-alert-wash border-alert-line text-alert-on-soft; }
  .note-info  { @apply note bg-info-wash  border-info-line  text-info-on-soft; }
}
```

**ב-`ui.tsx`, קומפוננטה חדשה `Note`,** המקבלת `tone: Tone` ו-`children`.

**קריטי — `ErrorNote` נשאר, כעטיפה דקה.** `ui.tsx:30-32` הופך ל-`<Note tone="alert">{message}</Note>`. **32 אתרי הקריאה ב-22 קבצים לא נוגעים.** אין שום ערך בהחלפת 32 קריאות תקינות; הרווח הוא בכך שכולן מקבלות את הצבע מנקודה אחת.

**מה מוחלף בפועל:**

| מוחלף | ל- |
|---|---|
| `ui.tsx:31` | גוף `ErrorNote` בלבד |
| `NewOrder.tsx:225` | `<ErrorNote>` (כפילות — נמחקת) |
| `Invoices.tsx:18` | `<Note tone="done">` |
| `Invoices.tsx:21-25` (מפת `cls`) | מפה מ-`CheckSeverity` ל-`Tone` (§4.6) |
| `Orders.tsx:181` · `Bank.tsx:190` · `SupplierPrices.tsx:181` · `PriceLists.tsx:240` · `Exceptions.tsx:135` · `Onboarding.tsx:566` | `<Note tone="done">` |
| `AuditLog.tsx:76` · `PayerQueue.tsx:155` · `Orders.tsx:189` · `Onboarding.tsx:678` · `Onboarding.tsx:1024` · `Reports.tsx:136-138` · `NewOrder.tsx:233` | `<Note tone="await">` |
| `SupplierPrices.tsx:60` | `<Note tone="info">` |

**מחוץ לתחום סעיף 6:** האייקון בכל תיבה, וניסוח ההודעות. `Invoices.tsx:20` כבר מחזיק מפת אייקונים; איחוד ערכת האייקונים לכל המערכת שייך לסעיף 11. כאן מתקנים **צבע בלבד**.

### 4.4 איחוד `KpiCard` עם `Tone`

`ui.tsx:36` — ה-prop הופך ל-`tone?: Tone`, מיובא מ-`../lib/status`. ברירת המחדל `'slate'` הופכת ל-`'idle'`.

`ui.tsx:38` — המפה הידנית נמחקת ומוחלפת במפה אחת משותפת מ-`Tone` ל-`text-*-fg`. `idle` נשאר `text-slate-900` (ולא `-fg`) — זהו המספר הרגיל, הוא צריך להיות הכי כהה.

`Dashboard.tsx:141-155` — 10 אתרי הקריאה עוברים טיפוס אוטומטית. `tsc --noEmit` יסמן כל אחד מהם. אחרי השינוי, `Tone` הוא **מקור אמת יחיד** לכל טון במערכת.

### 4.5 מחיקת המערכת המקומית ב-`Receiving.tsx`

- `Receiving.tsx:210-216` (`statusTone`) — **נמחק.** מוחלף במפה מ-`Tone` ל-`bg-*-solid text-white border-*-solid`, נגזרת מ-`RECEIPT_LINE_STATUS[b.key].tone`. תוך כדי מתוקן `bg-amber-500` → `-solid` (§3.6ה).
- `Receiving.tsx:217-220` (`cardTone`) — **נמחק.** מוחלף במפה מ-`Tone` ל-`border-*-line`, נגזרת מאותו מקור.
- `Receiving.tsx:235` — צורך את מפת ה-border החדשה
- `Receiving.tsx:262` — צורך את מפת ה-solid החדשה
- `Receiving.tsx:244` — `<StatusBadge>` כבר תקין, לא נוגעים

התוצאה: מצב `returned` (או כל מצב חדש) משנה צבע **בשלוש התצוגות בבת אחת** משורה אחת ב-`status.ts:48`.

### 4.6 הפרדת פלטת המגמה מפלטת הסטטוס

זהו התיקון שבלעדיו הכלל של ניר נשבר בדשבורד (§3.4).

**טוקנים נפרדים ב-`@theme`:** `--color-trend-up-fg` / `--color-trend-down-fg`. **הם חייבים להיראות שונה מ-`alert-fg` ו-`done-fg`** — אחרת ההפרדה קיימת רק בשמות. הצעה: rose-500/emerald-500 מדולל, בלי רקע, ותמיד **בליווי חץ** (`↑`/`↓` או `TrendingUp`/`TrendingDown`). כך המשמעות אינה נשענת על הגוון בלבד — מה שגם משרת נגישות.

**מה משתנה:**

| מיקום | היום | אחרי |
|---|---|---|
| `Dashboard.tsx:229` | `badge-red` על אחוז | **צ׳יפ מגמה, לא תג סטטוס.** תג = מצב ישות; אחוז = מדידה. |
| `Dashboard.tsx:163` | rose-600 / emerald-600 על שינוי חודשי | `trend-up-fg` / `trend-down-fg` |
| `Dashboard.tsx:218` | `TrendingUp` ב-`text-rose-500` | `text-trend-up-fg` |
| `PriceLists.tsx:53-54` | rose-600 / emerald-600 | `trend-up-fg` / `trend-down-fg` |

**ניב היתרה הכספית ממופה לפלטת הסטטוס — לא למגמה.** יתרה פתוחה = `await` (יש מה לעשות), יתרה מאופסת = `done`. זהו מיפוי נקי ואינו דורש אוצר-מילים חדש. עשרה האתרים מ-§3.7 מקבלים `text-await-fg` / `text-done-fg`. שני חריגים: `Reports.tsx:132` (תנועות בנק ללא התאמה, rose-600) — זו ספירת עבודה פתוחה, לא חריגה; אמור להיות `await` ולא `alert`. `Reports.tsx:131` (amber-600) → `await-fg`.

**`CheckSeverity` נקשר לטוקנים:** מפה מפורשת ב-`Invoices.tsx` — `critical → alert`, `warning → await`, `info → info`. `CheckSeverity` עצמו (`checks.ts:4`) **לא משתנה** — זו סמנטיקת בדיקה, לא סמנטיקת תצוגה, והיא נצרכת ב-`checks.ts` בעשרות מקומות. רק ההמרה-לתצוגה מתאחדת.

### 4.7 סדר המיגרציה — נושא-משקל

> ⚠️ הסדר כאן אינו סגנוני. הוא מה שמונע מהתגים לאבד צבע בשקט (§2.5). **בשום שלב אין שם מחלקה שנפלט מ-TSX ואין לו כלל ב-CSS.**

| # | פעולה | שער |
|---|---|---|
| **0** | צילומי מסך בסיס (לפני), פורט 5199: `/dashboard`, `/invoices`, `/orders/:id`, `/payment-requests/:id`, `/receiving/:id`, `/bank`, `/exceptions`, `/credits` | הצילומים הם ההשוואה לכל השלבים הבאים |
| **1** | הוספת טוקני `@theme` (§4.1) + הוספת **מחלקות חדשות** `.badge-done`…`.badge-idle` ב-`index.css`, **לצד הישנות**. שום דבר לא נמחק. | `npm run build` · אין שינוי ויזואלי (הישנות עדיין בשימוש) |
| **2** | הפניית המחלקות **הישנות** לטוקנים החדשים: `.badge-green { @apply badge bg-done-soft text-done-on-soft; }` וכו׳ | **נקודת בדיקת זהות ויזואלית.** צילומים חייבים להיות זהים לשלב 0, למעט `badge-slate` (§4.1 הערה 2). כל סטייה = באג מיפוי, מתקנים כאן — לפני שהשמות משתנים. |
| **3** | שינוי-שם `Tone` ב-`status.ts:2` + עדכון כל 14 המילונים לפי טבלת §5 | `tsc --noEmit` נכשל על כל הצבה שלא עודכנה. התגים פולטים כעת `badge-done`… שכבר קיימות משלב 1. |
| **4** | המרת 10 ה-`badge-*` המקודדים ידנית (7 שורות, §2.3). `PriceLists.tsx:58` + `SupplierPrices.tsx:38` → מילון `PRODUCT_AVAILABILITY` יחיד ב-`status.ts` דרך `<StatusBadge>`. `Dashboard.tsx:229` מטופל בשלב 6. | `npm run build` |
| **5** | **שער grep, ואז מחיקה.** `rg 'badge-(green\|amber\|red\|blue\|slate\|violet)' src` **חייב להחזיר אפס תוצאות.** רק אז מוחקים את `index.css:34-39`. | זהו השלב שאסור לו להקדים. מחיקה לפני הריקנות של ה-grep = תגים לבנים, build ירוק. |
| **6** | פלטת מגמה (§4.6): `Dashboard.tsx:163`, `:218`, `:229`, `PriceLists.tsx:53-54` | צילום מסך של `/dashboard` ו-`/prices` |
| **7** | קומפוננטת `Note` (§4.3) + פרישה של 14 התיבות | `npm run build` · צילום של כל תיבה |
| **8** | `KpiCard` ← `Tone` (§4.4), `ui.tsx:36`, `:38` | `tsc --noEmit` על `Dashboard.tsx:141-155` |
| **9** | מחיקת המערכת המקומית ב-`Receiving.tsx:210-220` (§4.5) | צילום של `/receiving/:id` בכל חמשת המצבים |
| **10** | ניב היתרה (10 אתרים) · toast `ui.tsx:116` · כפתורי סכנה · `Orders.tsx:161` · `Bank.tsx:442` — **תלוי בהכרעות פ-8…פ-11** | `npm run build` |

**מדוע שלב 2 קיים בנפרד משלב 1:** הוא מפריד את *"האם הטוקנים ממופים נכון"* מ-*"האם שינוי-השם עבד"*. אם שני אלה קורים יחד ומשהו נשבר, אין דרך לדעת מי מהם. עלות: שלב אחד נוסף. תמורה: כשל אפשרי אחד במקום שניים משולבים.

---

## 5. מיפוי סטטוס → צבע חדש

`✓` = מיפוי ישיר, אין שינוי משמעות · **הכרעה נדרשת** = שאלה עסקית, נשארת פתוחה (`CLAUDE.md:29`, `OPEN-DECISIONS.md:3`)

| מילון | סטטוס | טון היום | טון מוצע | נימוק |
|---|---|---|---|---|
| **ORG_STATUS** `:7` | `trial` | amber | `info` | לא ממתין לפעולה של אף אחד. `OPEN-DECISIONS #15`: `trial_ends_at` אינו נאכף בשום מקום — זו עובדה על החשבון, לא משימה |
| | `active` | green | `done` ✓ | |
| | `suspended` | red | `alert` ✓ | |
| **INVITATION_STATUS** `:13` | `pending` | amber | `await` ✓ | |
| | `accepted` | green | `done` ✓ | |
| | `expired` | slate | **הכרעה נדרשת** | `idle` (הסתיים מעצמו) או `await` (דורש שליחה מחדש)? `OPEN-DECISIONS #16` — 7 ימים, שליחה מחדש מנפיקה טוקן חדש |
| | `revoked` | red | `idle` | ביטול מכוון אינו חריגה. אדום כאן מרעיש ללא סיבה |
| **SUPPLIER_STATUS** `:20` | `active` | green | `done` ✓ | |
| | `inactive` | slate | `idle` ✓ | |
| | `problematic` | red | `alert` ✓ | |
| | `pending` | amber | `await` ✓ | |
| **PO_STATUS** `:27` | `draft` | slate | `idle` ✓ | |
| | `ready` | blue | **הכרעה נדרשת** | "מוכנה" = מוכנה לשליחה. `await` (מישהו צריך לשלוח) או `info`? |
| | `sent` | **violet** | **הכרעה נדרשת** | סגול נמחק. ממתין לספק: `await` (יש מה לעקוב) או `info` (הכדור אצל הספק)? ראו פ-2 |
| | `confirmed` | blue | **הכרעה נדרשת** | הספק אישר — האם זה `done` (השלב הסתיים) או `await` (הסחורה עדיין לא הגיעה)? |
| | `partial` | amber | `await` ✓ | |
| | `received` | green | `done` ✓ | |
| | `cancelled` | slate | `idle` ✓ | |
| **REQUEST_STATUS** `:37` | `draft` | slate | `idle` | **קוד מת** — ראו פ-3 |
| | `split` | green | `done` | |
| | `cancelled` | slate | `idle` | |
| **RECEIPT_LINE_STATUS** `:43` | `full` | green | `done` ✓ | |
| | `partial` | amber | `await` ✓ | |
| | `missing` | red | `alert` ✓ | |
| | `damaged` | red | `alert` ✓ | |
| | `returned` | **violet** | **הכרעה נדרשת** | סגול נמחק. החזרה מטופלת (`done`), פתוחה (`await`), או חריגה (`alert`)? `OPEN-DECISIONS #6` פותח זיכוי אוטומטית — מה שרומז ש"טופל", אך זו הכרעה עסקית |
| **INVOICE_REVIEW_STATUS** `:51` | `received` | slate | `await` | חשבונית שהגיעה ואיש לא נגע בה **היא בדיוק** "ממתין לטיפול". אפור מסתיר אותה. זהו פריט מפורש בדשבורד שניר ביקש (`המשך פיתוח.txt:9`) |
| | `in_review` | blue | **הכרעה נדרשת** | ראו פ-4 — זו ההכרעה הגדולה של הסעיף |
| | `pending_approval` | amber | `await` ✓ | |
| | `approved` | green | `done` ✓ | |
| | `investigation` | red | `alert` ✓ | |
| **INVOICE_PAYMENT_STATUS** `:59` | `unpaid` | amber | `await` ✓ | |
| | `partial` | blue | `await` | יתרה פתוחה = עבודה פתוחה. מיישר עם ניב היתרה הכספית (§4.6), שכבר צובע יתרה חיובית בכתום ב-10 מקומות |
| | `paid` | green | `done` ✓ | |
| **INVOICE_EXPORT_STATUS** `:65` | `not_sent` | slate | **הכרעה נדרשת** | `await` נכון פורמלית, אבל יצבע כתום **כל** חשבונית ברוב החודש ויטביע את הצבע. `idle` שומר על כתום כאות אמיתי. ראו פ-5 |
| | `sent` | green | `done` ✓ | |
| **CREDIT_STATUS** `:79` | `open` | amber | `await` ✓ | |
| | `requested` | blue | `await` | ממתין לספק — `checks.ts:110` ו-`:179` סופרים אותו כזיכוי פתוח שדורש קיזוז |
| | `received` | **green** | **הכרעה נדרשת** | **סתירה בקוד:** ירוק ב-`status.ts:82`, אך `checks.ts:110` ו-`checks.ts:179` כוללים אותו ברשימת הזיכויים הפתוחים שטרם קוזזו. הצבע והלוגיקה חלוקים. ראו פ-6 |
| | `offset` | **violet** | `done` | סגול נמחק. `checks.ts:110`/`:179` **אינם** כוללים `offset` — כלומר הקוד כבר מתייחס אליו כמצב סופי מוצלח |
| | `closed` | slate | `idle` ✓ | |
| **PAYMENT_REQUEST_STATUS** `:87` | `draft` | slate | `idle` ✓ | |
| | `pending_approval` | amber | `await` ✓ | |
| | `approved` | **green** | **הכרעה נדרשת** | אושרה אך **הכסף עוד לא זז**. ירוק על תשלום שלא בוצע נוגד את "אחראי כספית" (`CLAUDE.md:47`). כמו כן — שני ירוקים במילון אחד (עם `matched`) |
| | `sent_for_execution` | **violet** | **הכרעה נדרשת** | סגול נמחק. ממתין למבצע ההעברות → `await`, או `info`? |
| | `executed` | blue | **הכרעה נדרשת** | ההעברה בוצעה אך טרם הותאמה לבנק. `done` או `await`? |
| | `matched` | green | `done` ✓ | ההצלחה הסופית האמיתית — הותאמה מול הבנק |
| | `investigation` | red | `alert` ✓ | |
| | `suspected_duplicate` | red | `alert` ✓ | |
| | `cancelled` | slate | `idle` ✓ | |
| **BANK_TX_STATUS** `:99` | `unmatched` | amber | `await` ✓ | |
| | `suggested` | blue | `await` | "הצעת התאמה" דורשת אישור אנושי — זו משימה, לא מידע. חלק מפ-4 |
| | `matched` | green | `done` ✓ | |
| | `ignored` | slate | `idle` ✓ | |
| **EXCEPTION_STATUS** `:118` | `open` | red | `alert` ✓ | הגדרת "אדום = חריגה" של ניר, מילולית |
| | `in_progress` | amber | `await` ✓ | |
| | `resolved` | green | `done` ✓ | |
| | `dismissed` | slate | `idle` ✓ | |
| **SEVERITY** `:125` | `low` | slate | `idle` ✓ | |
| | `medium` | amber | `await` ✓ | |
| | `high` | red | `alert` ✓ | |

**סיכום:** 61 שורות · 45 מיפוי ישיר · 5 שיפורים מבוססי-קוד (`revoked`, `trial`, `received` בבדיקה, `partial` בתשלום, `offset`) · **11 הכרעות נדרשות** · 4 מופעי `violet` מפורקים.

---

## 6. הכרעות פתוחות

`CLAUDE.md:29` ו-`OPEN-DECISIONS.md:3` אוסרים להמציא תשובות עסקיות. הטבלה הבאה היא הרשימה המלאה של מה שאסור להכריע בשקט בקוד.

| # | שאלה | האפשרויות | היכן זה נופל | השפעה |
|---|---|---|---|---|
| **פ-1** | האם מותר צבע חמישי ניטרלי (`idle`)? | (א) כן — אפור אינו טענה אלא היעדרה · (ב) לא — למפות הכול לארבעה | `status.ts:2`, `index.css` | 11 סטטוסים. אם (ב) — כולם הופכים ל-`info`, ו"כחול = מידע" מתרחב מאוד |
| **פ-2** | מה מחליף את `violet` בכל אחד מארבעת מופעיו? | לכל מופע בנפרד | `status.ts:30, 48, 83, 91` | `PO_STATUS.sent`, `RECEIPT_LINE_STATUS.returned`, `CREDIT_STATUS.offset`, `PAYMENT_REQUEST_STATUS.sent_for_execution` |
| **פ-3** | למחוק את `REQUEST_STATUS` (קוד מת)? | (א) למחוק · (ב) להשאיר לתכונה מתוכננת | `status.ts:37-41` | ניקיון בלבד. שאלה עסקית: האם "דרישות רכש" מתוכננות לחזור? |
| **פ-4** | **ההכרעה הגדולה של הסעיף.** ניר: כחול = *מידע כללי*. במערכת כחול = *בתהליך*. | (א) "בתהליך" → `await` (כל תהליך פתוח הוא משימה) · (ב) "בתהליך" → `info` (מידע על היכן הדבר עומד) · (ג) הכרעה פרטנית לכל מצב | `in_review`, `partial`, `suggested`, `executed`, `ready`, `confirmed`, `requested` | **השינוי הגדול ביותר בסעיף.** (א) מרחיב מאוד את הכתום; (ב) עלול להסתיר עבודה פתוחה |
| **פ-5** | האם "טרם הועברה לרו״ח" הוא ממתין-לטיפול? | (א) `await` — נכון פורמלית · (ב) `idle` עד סוף החודש | `status.ts:66` | (א) יצבע כתום כמעט כל חשבונית ברוב החודש. **סיכון ישיר להצפת אות** — הצבע מאבד ערך |
| **פ-6** | `CREDIT_STATUS.received` — האם זיכוי שהתקבל אך טרם קוזז הוא "הושלם"? | (א) `done` (כמו היום) · (ב) `await` (עד קיזוז) | `status.ts:82` מול `checks.ts:110`, `checks.ts:179` | **סתירה קיימת בקוד.** אחת משתי המערכות טועה היום, יהיה מה שיהיה |
| **פ-7** | `PAYMENT_REQUEST_STATUS.approved` — ירוק לפני שהכסף זז? | (א) `done` (כמו היום) · (ב) `await` עד `matched` | `status.ts:90` | "אחראי כספית" (`CLAUDE.md:47`) נוטה ל-(ב) |
| **פ-8** | האם התייקרות מחיר היא **חריגה**? | (א) מגמה בלבד (§4.6) · (ב) גם חריגה | `Dashboard.tsx:163, 218, 229`, `PriceLists.tsx:53-54` | **מתח בין סעיפים:** סעיף 6 אומר אדום=חריגה; `המשך פיתוח.txt:150` (סעיף 9) מונה "עליית מחיר אצל ספק" כאירוע התראה. ייתכן ששניהם נכונים בהקשרים שונים |
| **פ-9** | toast הצלחה — ירוק או ניטרלי כהה? | (א) `done-solid` — נאמן לניר · (ב) `slate-800` — נאמן ל"רגוע" (`CLAUDE.md:47`) | `ui.tsx:116` | סותר את "ירוק = הושלם" היום |
| **פ-10** | כפתור WhatsApp ירוק-מותג | (א) `btn-secondary` — פעולה אינה סטטוס · (ב) להשאיר, זיהוי מותג | `Orders.tsx:161` | ירוק על כפתור ייקרא "הושלם". אין `.btn-success` — ואין להוסיף כזה |
| **פ-11** | סולם הביטחון בהתאמת בנק (0.85 / 0.7) | (א) `info` בדרגות · (ב) בלי צבע, אחוז בלבד · (ג) להשאיר | `Bank.tsx:442` | ירוק על "ביטחון גבוה" אינו "פעולה הושלמה" — ההתאמה עדיין לא אושרה |

**נוסף — הכרעת עיצוב, לא עסקית (ניתן להכריע בקוד):** רמות כפתור-סכנה. הצעה: `.btn-danger` הממולא נשמר ללחיצה הבלתי-הפיכה **בתוך דיאלוג** (`ui.tsx:90`, `InvoiceNew.tsx:146`, `PaymentRequests.tsx:224`, `:305`), ו-`.btn-danger-quiet` חדש (ghost + `text-alert-fg`) לטריגר **בתוך הדף** שפותח את הדיאלוג (`PaymentRequests.tsx:313`, `Orders.tsx:175`, `Settings.tsx:152`, `Admin.tsx:98`, `InvoiceDetail.tsx:94`). כלל: **אדום ממולא = הלחיצה שאין ממנה חזרה.**

---

## 7. תלויות והשקה עם סעיפים אחרים

סעיפים 7 ו-11 **אינם מאושרים ואינם מתוכננים כאן.** להלן התפר בלבד.

**סעיף 7 — Skeleton Loading** (`המשך פיתוח.txt:108-112`). התפר: `PageLoader` (`ui.tsx:12-18`) הוא בדיוק מה שסעיף 7 מחליף, ושלדי-טעינה יצרכו את משטחי `idle` (`--color-idle-wash` / `-line`) שנקבעים כאן ב-§4.1. **המשמעות המעשית:** מתן שם למשטח הניטרלי עכשיו מונע מסעיף 7 להמציא פלטת-אפור שביעית. **אין לבנות שלדים בסעיף זה.**

**סעיף 11 — ליטוש UX** (`המשך פיתוח.txt:178-187`). שלושה תפרים:
1. קומפוננטת `Note` (§4.3) היא המקום שבו סעיף 11 יוסיף slot של הסבר/פעולה עבור "הודעות שגיאה ברורות עם הסבר כיצד לפתור את הבעיה".
2. ה-toast (`ui.tsx:104-123`) — סעיף 6 קובע את **הצבע** (פ-9); הניסוח והתזמון של "הודעות הצלחה ברורות" הם סעיף 11.
3. "אייקונים אחידים" — `Invoices.tsx:20` כבר מחזיק מפת אייקונים לפי חומרה. **סעיף 6 לא נוגע באייקונים.**

**סעיפים 1-3 — הדשבורד כמרכז בקרה.** טבלת §5 קובעת אילו מונים בדשבורד ייקראו כתום מול אדום. סעיף 1 יצרוך את המיפוי; לא מתוכנן כאן. שימו לב במיוחד ל-`INVOICE_REVIEW_STATUS.received` → `await`: זה בדיוק "מספר חשבוניות חדשות שהתקבלו" מ-`המשך פיתוח.txt:9`.

---

## 8. אימות

**השער האוטומטי היחיד** (`CLAUDE.md:38`): `npm run build` = `tsc --noEmit && vite build`. **אין linter. אין טסטים.** שרת פיתוח: `npm run dev`, פורט **5199**.

### 8.1 מה ה-build כן תופס

- שינוי-שם `Tone` (`status.ts:2`) → כל 14 המילונים
- `KpiCard` אחרי §4.4 → 10 אתרי הקריאה ב-`Dashboard.tsx:141-155`
- מפת `CheckSeverity` → `Tone` ב-`Invoices.tsx`

### 8.2 מה ה-build **לא** תופס — כשל שקט

> `ui.tsx:8` בונה את שם המחלקה ב-template literal. אם `Tone` פולט שם שאין לו כלל ב-`index.css`, **התג מרונדר לבן ו-`npm run build` עובר בהצלחה.** זהו מצב הכשל של הסעיף כולו, והוא בלתי-נראה בכל שער אוטומטי קיים.

**שתי בדיקות חובה, אחרי כל שלב מ-§4.7:**

**(א) בדיקה סטטית — קדם-תנאי למחיקה בשלב 5:**
```
rg -o 'badge-[a-z]+' src | sort -u
```
כל שם שמופיע חייב להיות מוגדר ב-`index.css`. לפני שמוחקים את `index.css:34-39` (שלב 5), הפקודה הבאה **חייבת** להחזיר אפס תוצאות:
```
rg 'badge-(green|amber|red|blue|slate|violet)' src
```

**(ב) בדיקה בזמן ריצה — הישירה ביותר.** בדפדפן, על `/invoices` (הצפוף ביותר — שלוש עמודות תגים) ועל `/payment-requests`:
```js
[...document.querySelectorAll('[class*="badge-"]')].filter(el => {
  const bg = getComputedStyle(el).backgroundColor;
  return bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent';
})
```
**חייב להחזיר `[]`.** מערך לא-ריק = הופעל שינוי-שם שהצד של ה-CSS פיגר אחריו. זו הבדיקה היחידה שתופסת את המלכודת ישירות.

### 8.3 אימות ויזואלי

`CLAUDE.md:53`: **שינוי ויזואלי מחייב צילום מסך של התוצאה בפועל, לא הסתמכות על הזיכרון.**

- **שלב 0** — צילומי בסיס: `/dashboard`, `/invoices`, `/orders/:id`, `/payment-requests/:id`, `/receiving/:id`, `/bank`, `/exceptions`, `/credits`
- **שלב 2** — צילומים **חייבים להיות זהים** לשלב 0, למעט `badge-slate` (`text-slate-700` → `-800`, §4.1). כל סטייה אחרת היא באג מיפוי.
- **שלב 9** — `/receiving/:id` **בכל חמשת המצבים** (`full`/`partial`/`missing`/`damaged`/`returned`), כי שם קורסות שלוש מערכות טונים לאחת
- **שלב 7** — צילום של כל אחת מ-14 התיבות

### 8.4 בדיקות נוספות

- **ניגודיות** — `CLAUDE.md:49` אוסר "טקסט זעיר בניגודיות נמוכה", והתגים הם `text-xs` (`index.css:19`). לוודא ≥4.5:1 לכל זוג `soft`/`on-soft`, ובמיוחד למשטח `idle` המתוקן ל-`-800`.
- **RTL** — `CLAUDE.md:43`: מאפיינים לוגיים בלבד (`start`/`end`, `ms`/`me`, `ps`/`pe`). ה-`@utility note` ב-§4.3 חייב `gap` ו-`items-start`, **לעולם לא** `left`/`right`.
- **מתח עיצובי לנטר** — `CLAUDE.md:47` דורש ממשק **רגוע**. הרחבת `await` (פ-4, פ-5) עלולה להפוך מסכים שלמים לכתומים. הבדיקה אינה טכנית: **בצילום של `/invoices`, האם הכתום עדיין מצביע על משהו?** אם רוב השורות כתומות, ההכרעה שגויה — גם אם היא נכונה פורמלית.
