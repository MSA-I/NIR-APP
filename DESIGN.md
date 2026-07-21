---
name: SupplyFlow
description: מערכת procurement-to-payment עברית RTL — B2B פרימיום, "פנקס הדיו": מונוכרום שקט + צבע סמנטי בלבד
colors:
  # ---- שלד (structural) — "פנקס הדיו" (T5, 21.07.2026) ----
  canvas: "oklch(97.8% 0.003 255)"             # רקע הגוף — נייר שקט
  surface: "#ffffff"                            # כרטיסים, טבלאות, מודאלים, שדות
  surface-sunken: "oklch(98.6% 0.002 255)"      # thead, שדות disabled, רצועות שקטות
  line: "oklch(90% 0.006 255)"                  # גבול כרטיס, מפריד מול canvas
  line-soft: "oklch(94.5% 0.004 255)"           # מפרידי שורות פנימיים
  line-strong: "oklch(84% 0.008 255)"           # גבול שדות וכפתור משני
  ink: "oklch(16% 0.015 260)"                   # כותרות דף, הטקסט החזק ביותר
  ink-body: "oklch(24% 0.015 260)"              # טקסט גוף
  ink-mid: "oklch(32% 0.02 258)"                # תאי טבלה
  ink-soft: "oklch(42% 0.02 258)"               # תוויות, כפתורי ghost
  ink-muted: "oklch(50% 0.02 257)"              # כותרות עמודה, טקסט משני — AA על לבן
  ink-faint: "oklch(56% 0.02 257)"              # placeholder ורמזים בלבד — 4.65:1 על לבן
  ink-ghost: "oklch(78% 0.012 256)"             # אייקונים כבויים, סימנים דקורטיביים
  # פעולה = דיו, לא גוון מותג. הצבע הרווי הפונקציונלי היחיד הוא טבעת הפוקוס.
  action: "oklch(21% 0.02 260)"                 # כפתור ראשי, גלולת ניווט פעילה
  action-hover: "oklch(31% 0.025 260)"          # משטח כהה מבהיר ב-hover
  action-solid: "oklch(28% 0.02 260)"           # צ'יפים מלאים, מילויי בחירה
  action-soft: "oklch(94% 0.008 257)"           # badge ספירה
  action-on-soft: "oklch(24% 0.015 260)"
  action-wash: "oklch(96.5% 0.006 256)"         # hover שורה (בשימוש עם /40)
  action-line: "oklch(60% 0.02 257)"            # גבול hover על כרטיס לחיץ
  focus: "oklch(55% 0.19 255)"                  # טבעת פוקוס — כחול פונקציונלי, 4.9:1
  # ה-shell בהיר: סרגל לבן + hairline, טקסט דיו. פס ה-slate-900 הכהה איננו.
  shell: "#ffffff"
  shell-ink: "oklch(16% 0.015 260)"
  shell-ink-soft: "oklch(35% 0.02 258)"
  shell-ink-dim: "oklch(50% 0.02 257)"
  shell-heading: "oklch(55% 0.02 257)"
  # גרפים — דיו, לא קישוט
  chart-1: "oklch(35% 0.02 258)"
  chart-grid: "oklch(92% 0.005 255)"
  chart-tick: "oklch(50% 0.02 257)"
  chart-label: "oklch(42% 0.02 258)"
  chart-tick-strong: "oklch(32% 0.02 258)"
  star: "amber-400"                             # כוכבי דירוג: קישוט, לא סטטוס
  star-hover: "amber-300"
  # ---- שפת הצבעים הסמנטית — העוגנים ללא שינוי ----
  # done=הושלם (emerald) · await=ממתין (amber) · alert=חריגה (rose) · info=מידע (sky) · idle=ניטרלי (slate)
  # כל משמעות חושפת שישה משטחים: wash/line/soft/on-soft/fg/solid — הערכים ב-@theme ב-src/index.css.
  trend-up: "rose-500"                          # התייקרות — תמיד עם חץ
  trend-down: "emerald-500"                     # הוזלה — תמיד עם חץ
typography:
  # IBM Plex Sans Hebrew נושאת את ה-UI; IBM Plex Mono נושאת כל מספר (.num).
  # שתיהן מ-Google Fonts (index.html) — Sans ב-400/500/600/700, Mono ב-400/500/600.
  headline:
    fontFamily: "IBM Plex Sans Hebrew, Heebo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.33
  title:
    fontFamily: "IBM Plex Sans Hebrew, ..."
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: "IBM Plex Sans Hebrew, ..."
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  label:
    fontFamily: "IBM Plex Sans Hebrew, ..."
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.43
  table-header:
    fontFamily: "IBM Plex Sans Hebrew, ..."
    fontSize: "0.75rem"
    fontWeight: 600
    note: "ללא uppercase וללא tracking — לעברית אין רישיות; היררכיה מגודל/משקל/צבע בלבד"
  num:
    fontFamily: "IBM Plex Mono, ui-monospace, Consolas, monospace"
    fontFeature: "tabular-nums"
    note: "כל .num — סכומים, כמויות, מספרי מסמכים, ערכי KPI — במונו. חתימת הלדג'ר של המערכת"
rounded:
  control: "0.5rem"    # rounded-lg — כפתורים, שדות
  card: "0.5rem"       # rounded-lg — כרטיסים (הוקטן מ-0.75rem; שטוח וחד יותר)
  modal: "1rem"        # rounded-2xl — מודאלים (מרחפים — נשארים רכים)
  pill: "9999px"       # badges
spacing:
  xs: "8px"
  sm: "10px"
  md: "12px"
  lg: "16px"
  xl: "20px"
components:
  button-primary: { backgroundColor: "{colors.action}", textColor: "#ffffff", rounded: "{rounded.control}", padding: "8px 14px" }
  button-primary-hover: { backgroundColor: "{colors.action-hover}" }
  button-secondary: { backgroundColor: "{colors.surface}", textColor: "{colors.ink-mid}", border: "{colors.line-strong}", rounded: "{rounded.control}" }
  button-danger: { backgroundColor: "alert-solid", textColor: "#ffffff" }
  button-ghost: { textColor: "{colors.ink-soft}", hoverBackground: "{colors.canvas}" }
  input: { backgroundColor: "{colors.surface}", border: "{colors.line-strong}", focusRing: "{colors.focus}", rounded: "{rounded.control}" }
  card: { backgroundColor: "{colors.surface}", border: "{colors.line}", rounded: "{rounded.card}", shadow: "none" }
  badge-*: { pattern: "bg-{tone}-soft + text-{tone}-on-soft", rounded: "{rounded.pill}" }
  note-*: { pattern: "bg-{tone}-wash + border-{tone}-line + text-{tone}-on-soft" }
---

# Design System: SupplyFlow — "פנקס הדיו" (Ink Ledger)

## 1. Overview

**Creative North Star: "חדר בקרה שקט" שנכתב בדיו.**

SupplyFlow הוא ספר החשבונות של מנהל שסומך על הכלים שלו: דיו כהה על נייר לבן, ספרות מיושרות
במונו, וחותמת צבע רק היכן שיש טענה עסקית. השלד כולו מונוכרום קריר — canvas כמעט-לבן, משטחים
לבנים עם hairline, כפתור ראשי בדיו כמעט-שחור. **צבע במסך = אך ורק שפת הסטטוס הסמנטית** (או
מגמת מחיר עם חץ). מסך שכולו תקין הוא מסך כמעט מונוכרומטי — וזו התכונה: כשמשהו צבוע, מסתכלים עליו.

מה שנזנח במעבר (21.07.2026): סרגל slate-900 כהה עם גלולות אינדיגו, אקצנט אינדיגו מפוזר,
כותרות טבלה uppercase, אריחי KPI זהים עם צל — כל סממני "תבנית האדמין הגנרית".

**Key Characteristics:**
- שקט כברירת מחדל; צבע = טענה סמנטית, לעולם לא קישוט. האקצנט הראשי הוא *דיו*, לא גוון מותג.
- כל מספר במונו (`.num` → IBM Plex Mono): טורי סכומים מתיישרים כמו בפנקס.
- עברית RTL מלאה: properties לוגיים בלבד; אין uppercase.
- שטוח: hairline הוא כל סיפור הגובה של כרטיס במנוחה; צל שמור למרחפים ולהזמנת hover.
- אין נתון מזויף: מדד בלי נתונים מציג `—`, לא `0`.

## 2. Colors

### The Ink Principle
**`action` הוא דיו, לא מותג.** כפתור ראשי, לינק (`.link`), גלולת ניווט פעילה וצ'יפ נבחר — כולם
דיו כמעט-שחור. משטח כהה מבהיר ב-hover (`action-hover`). הצבע הרווי הפונקציונלי היחיד בשלד הוא
טבעת הפוקוס (`focus`, כחול 4.9:1) — נגישות, לא מיתוג.

### שפת הסטטוס — ללא שינוי
ארבע משמעויות + ניטרלי, כל אחת עם שישה משטחים (wash/line/soft/on-soft/fg/solid):
**done** (emerald) הושלם/תקין/שולם · **await** (amber) ממתין לטיפול מצדנו · **alert** (rose)
חריגה/דחוף/הפסד אפשרי + פעולה הרסנית · **info** (sky) הכדור אצל גורם חיצוני · **idle** (slate)
היעדר טענה. **חוק ארבע המשמעויות** ו**חוק האות הכתום** בתוקף מלא: אסור emerald/amber/rose/sky
מחוץ למשמעותם; await חייב להישאר נדיר כדי להישמע; משמעות לעולם לא בגוון בלבד — תמיד טקסט/אייקון.

### Named Rules
**חוק הדיו:** אסור להכניס גוון מותג חדש לשלד. משהו "רוצה לבלוט"? או שהוא טענת סטטוס (badge/note)
או שהוא דיו. **חוק הטוקנים:** אפס מחלקות פלטה גולמיות (`slate-*`, `indigo-*`...) ב-tsx — נאכף
בגרפ (§7). צבע חדש = טוקן חדש ב-@theme + עדכון המסמך הזה יחד.

## 3. Typography

**UI:** IBM Plex Sans Hebrew (400/500/600/700) — עברית ולטינית באיכות זהה, אופי טכני-מקצועי.
**מספרים:** IBM Plex Mono (400/500/600) דרך `--font-num`, מוחל אוטומטית על כל `.num` —
סכומים, כמויות, מספרי מסמכים, ערכי KPI. זו חתימת המערכת: מערכת כספית שמספריה מיושרים כמו טרמינל.

### Hierarchy
Headline ‏700 / ‏1.25rem מובייל / ‏1.5rem רחב (`page-title`) · Title ‏600/1rem (`section-title`) ·
Body ‏400/0.875rem · Label ‏500/0.875rem ‏ink-soft · Table header ‏600/0.75rem ‏ink-muted —
**בלי uppercase, בלי tracking** (שריד לטיני שהוסר) · ערכי KPI ‏600–700/1.25rem במונו.

**חוק הספרות המיושרות:** כל תא מספרי עטוף `class="num"` ‏(LTR + ‏tabular-nums + מונו + יישור לסוף).

## 4. Elevation

שטוח באמת. כרטיס במנוחה = `bg-surface` + ‏hairline ‏(`line`) — **בלי צל**. ההיררכיה:
- **מונח:** hairline בלבד.
- **מוזמן:** ‏`.card-link-hover` — גבול מתכהה (`action-line`) + צל קל. ההזמנה לפעולה היא היחידה שמרימה משטח.
- **מרחף:** ‏shadow-xl למודאל (rounded-2xl), ‏shadow-lg לטוסט — תמיד עם backdrop ‏`shell/50` במודאל.

## 5. Components

### Navigation — הסרגל הבהיר
סרגל צדי `bg-shell` (לבן) + ‏`border-e border-line`; טקסט דיו. **פריט פעיל = גלולת דיו מלאה
(`bg-action text-white`)** — היפוך מלא, סימן הזיהוי של המערכת. פריט רגיל `shell-ink-soft` עם
hover עדין `shell-ink/5`. טופ-בר מובייל ובר תחתון לבנים עם hairline; פעיל בבר התחתון = `text-action`.
‏theme-color ב-index.html = ‏`#ffffff` (מתואם ל-shell — פריט צ'קליסט ברה-תמה).

### Buttons
Primary דיו · Secondary לבן + ‏`line-strong` · Danger ‏`alert-solid` (תמיד מאחורי ConfirmDialog
עם סיבה כשנרשם ביומן) · Ghost ‏`ink-soft`. ‏disabled:opacity-50; ‏busy עם ספינר בתוך הכפתור.

### DataTable — כולל מובייל
שולחן העבודה של המערכת. דסקטופ: thead ‏`surface-sunken`, שורות `divide-line-soft`, ‏hover
‏`.row-hover` (כולל `active:` כאפורדנס מגע), מיון בכפתורים אמיתיים עם aria-sort.
**מובייל (`mobile="cards"`):** מתחת ל-md הטבלה מוסתרת ובמקומה רשימת כרטיסים נגישים:
- ‏`Column.priority`: ‏1 כותרת · 2 פרטים (ברירת מחדל) · 3 מוסתר במובייל.
- ‏`Column.mobileLabel`: תווית לפני הערך; ‏`null` = ערך מדבר-בעד-עצמו (badge, כסף).
- ‏`mobileTitle(row)` — שורת כותרת; ‏`mobileTrailing(row)` — ‏badge בקצה; שורה לחיצה = ‏button ‏44px+.
- חיפוש/סינון/עימוד משותפים לשתי התצוגות; מיון אינו נגיש במובייל (v1, מתועד).
- ברירת מחדל `mobile="scroll"` — טבלאות שלא הצטרפו מתגלגלות אופקית כמו קודם.
מופעל ב: Invoices, Orders, Suppliers, Payments, PaymentRequests.

### Dashboard — פס הכסף
שלושת מדדי הכסף = **BandStat בתוך `.card` אחד** — מקטעים עם מפרידים לוגיים (`border-s`/`border-t`,
לעולם לא divide-x הפיזי), לא שלושה אריחים זהים. ‏AttentionZone נשאר רכיב החתימה — ללא שינוי מבני.

### Chips / Notes / Skeletons / EmptyState
badge = ‏soft/on-soft · ‏note = ‏wash/line/on-soft ‏(+idle לניטרלי) · ‏skeleton = ‏`bg-line`,
משקף את צורת התוכן · ‏EmptyState מלמד את המסך.

### Charts
recharts לא קורא CSS vars מ-attributes — ‏`src/lib/theme.ts` ‏(`chartTheme()`) קורא את הטוקנים
פעם אחת ב-getComputedStyle ומזרים מחרוזות צבע אמיתיות (bar/grid/tick/label/tickStrong/trendUp/
trendDown/flat). עמודות בדיו; צבע סמנטי בגרף רק כשהוא נושא משמעות. אפס הקסים ב-tsx.

## 6. Do's and Don'ts

### Do:
- **Do** כל צבע דרך טוקן; מחלקות המשמעות (`badge-*`, `note-*`, `text-*-fg`) הן ה-API.
- **Do** ‏`class="num"` על כל תא מספרי — המונו הוא חלק מהשפה, לא קישוט.
- **Do** ‏properties לוגיים בלבד; ‏`—` למדד ללא נתונים; ניגודיות ≥4.5:1 (ledger ב-§7).
- **Do** מעברים 150–250ms ‏ease-out מכבדי reduced-motion; ‏`active:` לצד `hover:` ברכיבים משותפים.

### Don't:
- **Don't** גוון מותג בשלד — הדיו הוא המותג. אין להחזיר אינדיגו/כחול דקורטיבי.
- **Don't** ‏uppercase/tracking על טקסט עברי.
- **Don't** צל על כרטיס במנוחה; ‏glassmorphism; אנימציה שאינה מצב — אסור בחוקה.
- **Don't** מחלקת פלטה גולמית או הקס ב-tsx — הגרפ ב-§7 חייב להישאר ריק.
- **Don't** ‏emerald/amber/rose/sky מחוץ למשמעותם; אין להמציא משמעות שישית.
- **Don't** ‏`border-left/right` צבעוני כפס-סימון — ‏`note-*` בלבד.

## 7. Retheme Runbook + אכיפה

**רה-תמה מלאה = שלושה קבצים בלבד:** ‏(1) בלוק ה-@theme ב-`src/index.css` · ‏(2) ‏`index.html` —
קישור הפונטים + ‏meta ‏theme-color · ‏(3) המסמך הזה. שום דף לא נערך. זו התוצאה של סבב הטוקניזציה
(21.07.2026, ‏490 מופעים קשיחים → 0).

**גרפ האכיפה** (חייב להחזיר אפס שורות על `src --include='*.tsx'`):
```
\b(bg|text|border|ring|fill|stroke|divide|outline|decoration|placeholder|accent|caret|shadow)-(slate|gray|zinc|indigo|violet|blue|emerald|green|amber|yellow|orange|rose|red|sky|cyan|teal)-[0-9]{2,3}\b
```
וכן `#[0-9a-fA-F]{6}` — אפס הקסים ב-tsx (הגרפים דרך chartTheme).

**Contrast ledger (נמדד 21.07.2026, סקריפט OKLCH→sRGB):**
ink/canvas ‏18.2 · ‏ink-body/surface ‏16.5 · ‏ink-mid ‏12.7 · ‏ink-soft ‏8.5 · ‏ink-muted ‏6.0 ·
‏ink-faint ‏4.65 (placeholder, AA) · לבן על action ‏17.7 · על action-hover ‏13.2 · על action-solid
‏14.6 · ‏focus ‏4.9 ‏(≥3 non-text) · ‏chart-tick ‏6.0 · ‏shell-ink-soft ‏11.3 · ‏shell-heading ‏4.85.
הסטטוסים (soft/on-soft, wash/on-soft) — צירופי 100↔800 המקוריים, AA מוכח.

**סיכוני תחזוקה:** ‏`badge-${tone}`/`note-${tone}` נבנות דינמית — כל ערך Tone חייב מחלקה ב-index.css
(אין שגיאת build אם חסרה). ‏Tailwind v4: מחלקה מותאמת = ‏@apply על utilities אמיתיים בלבד; קומפוזיציה
דרך ‏@utility (כמו btn/badge/note). ‏chartTheme() ממוטמן ברמת מודול — theme switch עתידי חייב invalidation.
