---
name: SupplyFlow
description: מערכת procurement-to-payment עברית RTL — B2B פרימיום, רגוע ואחראי כספית
colors:
  # ניטרלים (המשטח והדיו)
  canvas: "oklch(96.8% 0.007 247.896)"        # slate-100 — רקע הגוף
  surface: "#ffffff"                           # כרטיסים, טבלאות, מודאלים
  line: "oklch(92.9% 0.013 255.508)"           # slate-200 — גבול כרטיס
  line-soft: "oklch(96.8% 0.007 247.896)"      # slate-100 — מפרידי שורות
  ink-strong: "oklch(20.8% 0.042 265.755)"     # slate-900 — כותרות דף, וגם רקע הסרגל הצדי
  ink: "oklch(27.9% 0.041 260.031)"            # slate-800 — טקסט גוף ראשי
  ink-body: "oklch(37.2% 0.044 257.287)"       # slate-700 — טקסט תאי טבלה
  ink-soft: "oklch(44.6% 0.043 257.281)"       # slate-600 — תוויות, כפתורי ghost
  ink-muted: "oklch(55.4% 0.046 257.417)"      # slate-500 — כותרות עמודה, טקסט משני
  ink-faint: "oklch(70.4% 0.04 256.788)"       # slate-400 — placeholder, רמזים
  # פעולה (האקצנט היחיד שאינו סטטוס)
  action: "oklch(45.7% 0.24 277.023)"          # indigo-700 — כפתור ראשי, פוקוס, פריט ניווט פעיל
  action-hover: "oklch(39.8% 0.195 277.366)"   # indigo-800
  # שפת הצבעים הסמנטית — done=הושלם · await=ממתין · alert=חריגה · info=מידע · idle=ניטרלי
  done-wash: "oklch(97.9% 0.021 166.113)"
  done-line: "oklch(90.5% 0.093 164.15)"
  done-soft: "oklch(95% 0.052 163.051)"
  done-on-soft: "oklch(43.2% 0.095 166.913)"
  done-fg: "oklch(50.8% 0.118 165.612)"
  done-solid: "oklch(59.6% 0.145 163.225)"
  await-wash: "oklch(98.7% 0.022 95.277)"
  await-line: "oklch(92.4% 0.12 95.746)"
  await-soft: "oklch(96.2% 0.059 95.617)"
  await-on-soft: "oklch(47.3% 0.137 46.201)"
  await-fg: "oklch(55.5% 0.163 48.998)"
  await-solid: "oklch(66.6% 0.179 58.318)"
  alert-wash: "oklch(96.9% 0.015 12.422)"
  alert-line: "oklch(89.2% 0.058 10.001)"
  alert-soft: "oklch(94.1% 0.03 12.58)"
  alert-on-soft: "oklch(45.5% 0.188 13.697)"
  alert-fg: "oklch(51.4% 0.222 16.935)"
  alert-solid: "oklch(58.6% 0.253 17.585)"
  info-wash: "oklch(97.7% 0.013 236.62)"
  info-line: "oklch(90.1% 0.058 230.902)"
  info-soft: "oklch(95.1% 0.026 236.824)"
  info-on-soft: "oklch(44.3% 0.11 240.79)"
  info-fg: "oklch(50% 0.134 242.749)"
  info-solid: "oklch(58.8% 0.158 241.966)"
  idle-wash: "oklch(98.4% 0.003 247.858)"
  idle-line: "oklch(92.9% 0.013 255.508)"
  idle-soft: "oklch(96.8% 0.007 247.896)"
  idle-on-soft: "oklch(27.9% 0.041 260.031)"
  idle-fg: "oklch(37.2% 0.044 257.287)"
  idle-solid: "oklch(44.6% 0.043 257.281)"
  # מגמה ≠ סטטוס: כיוון שינוי, תמיד עם חץ, לעולם לא "דחוף"
  trend-up: "oklch(64.5% 0.246 16.439)"        # rose-500 — התייקרות
  trend-down: "oklch(69.6% 0.17 162.48)"       # emerald-500 — הוזלה
typography:
  headline:
    fontFamily: "Heebo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.33
  title:
    fontFamily: "Heebo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: "Heebo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  label:
    fontFamily: "Heebo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.43
  table-header:
    fontFamily: "Heebo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    letterSpacing: "0.025em"
  kpi-value:
    fontFamily: "Heebo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    fontFeature: "tabular-nums"
rounded:
  control: "0.5rem"    # rounded-lg — כפתורים, שדות, שורות hover
  card: "0.75rem"      # rounded-xl — כרטיסים
  modal: "1rem"        # rounded-2xl — מודאלים
  pill: "9999px"       # rounded-full — badges
spacing:
  xs: "8px"            # ריווח פנימי אנכי של כפתור/שדה
  sm: "10px"           # ריווח אנכי של תא טבלה
  md: "12px"           # ריווח אופקי של תא, gap של grid כרטיסים
  lg: "16px"           # card-pad, מרווח בין אזורי דף
  xl: "20px"           # card-pad במסכים רחבים
components:
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    padding: "8px 14px"
  button-primary-hover:
    backgroundColor: "{colors.action-hover}"
  button-secondary:
    backgroundColor: "#ffffff"
    textColor: "{colors.ink-body}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
  button-danger:
    backgroundColor: "{colors.alert-solid}"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    padding: "8px 14px"
  button-danger-hover:
    backgroundColor: "{colors.alert-fg}"
  button-ghost:
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
  input:
    backgroundColor: "#ffffff"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.card}"
  badge-done:
    backgroundColor: "{colors.done-soft}"
    textColor: "{colors.done-on-soft}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
  badge-await:
    backgroundColor: "{colors.await-soft}"
    textColor: "{colors.await-on-soft}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
  badge-alert:
    backgroundColor: "{colors.alert-soft}"
    textColor: "{colors.alert-on-soft}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
  badge-info:
    backgroundColor: "{colors.info-soft}"
    textColor: "{colors.info-on-soft}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
  badge-idle:
    backgroundColor: "{colors.idle-soft}"
    textColor: "{colors.idle-on-soft}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
---

# Design System: SupplyFlow

## 1. Overview

**Creative North Star: "חדר בקרה שקט"**

SupplyFlow היא חדר הבקרה של מנהל עסק שמטפל בכסף של עצמו ושל אחרים. הכול נראה במבט אחד; אזעקה נשמעת רק כשהיא אמיתית. המערכת שקטה כברירת מחדל — רקע slate מאופק, משטחים לבנים, דיו כהה — וצבע מופיע אך ורק כשהוא נושא טענה: הושלם, ממתין, חריגה, מידע. מסך שכולו תקין הוא מסך כמעט מונוכרומטי, וזו התכונה, לא באג: כשמשהו צבוע, מסתכלים עליו.

זו מערכת product במלוא מובן המילה — העיצוב משרת את המשימה ונעלם לתוכה. הצפיפות גבוהה במקומות העבודה (טבלאות, תורים) ונדיבה במקומות ההחלטה (דשבורד). המערכת דוחה במפורש את מה שהחוקה אוסרת: אנימציות מוגזמות, glassmorphism, שטחים דקורטיביים ריקים, גרפים מיותרים, מראה תבנית-אדמין גנרית, ורשתות כרטיסים מנופחות.

**Key Characteristics:**
- שקט כברירת מחדל; צבע = טענה סמנטית, לעולם לא קישוט
- עברית RTL מלאה: properties לוגיים בלבד, ספרות לטיניות מיושרות ב-`num`
- צפוף היכן שעובדים, מרווח היכן שמחליטים
- שטוח-בעיקרו: גבול דק וצל עדין; צל אמיתי רק למרחפים
- אין נתון מזויף: מדד בלי נתונים מציג `—`, לא `0`

## 2. Colors

פלטה מאופקת (Restrained): ניטרלי slate + אקצנט פעולה אחד (אינדיגו), ומעליהם שפת סטטוס סמנטית בת ארבע משמעויות.

### Primary
- **אינדיגו פעולה** (`action`, oklch(45.7% 0.24 277.023) = indigo-700): הצבע היחיד שמותר לו להופיע בלי טענת סטטוס. כפתור ראשי, טבעת פוקוס, פריט ניווט פעיל, hover של כרטיס לחיץ (`hover:border-indigo-300`). זה צבע "עשה", לא צבע "מצב".

### Secondary
- **שפת הסטטוס** — ארבע משמעויות + ניטרלי, כל אחת חושפת שש משטחים (`wash`/`line`/`soft`/`on-soft`/`fg`/`solid`):
  - **הושלם** (`done-*`, emerald): הושלם / תקין / שולם.
  - **ממתין** (`await-*`, amber): ממתין לטיפול — יש פעולה מצדנו.
  - **חריגה** (`alert-*`, rose): חריגה / דחוף / הפסד כספי אפשרי. גם צבע פעולה הרסנית.
  - **מידע** (`info-*`, sky): מידע — הכדור אצל גורם חיצוני (למשל הזמנה שנשלחה לספק).
  - **ניטרלי** (`idle-*`, slate): היעדר טענה — טיוטה, בוטל, לא פעיל. לא משמעות חמישית.
- **מגמה** (`trend-up` rose-500 / `trend-down` emerald-500): כיוון שינוי מחיר, לא סטטוס. תמיד מלווה בחץ, בהיר מספיק כדי לא להתבלבל עם alert/done.

### Neutral
- **קנבס** (`canvas`, slate-100): רקע הגוף. **משטח** (`surface`, לבן): כל מה שמכיל תוכן.
- **דיו** בסולם: `ink-strong` (כותרות) → `ink` (גוף) → `ink-body` (תאים) → `ink-soft` (תוויות) → `ink-muted` (משני) → `ink-faint` (placeholder בלבד — לעולם לא טקסט מהותי).
- **שכבה ניטרלית שנייה:** הסרגל הצדי הוא slate-900 כהה — עוגן קבוע שמפריד ניווט מתוכן בלי אף פיקסל דקורטיבי.

### Named Rules
**חוק ארבע המשמעויות.** לכל צבע סטטוס יש משמעות אחת קבועה בכל המערכת. אסור להשתמש ב-emerald/amber/rose/sky מחוץ למשמעות שלהם, ואסור להמציא משמעות שישית. משמעות לעולם אינה מועברת בגוון בלבד — תמיד טקסט או אייקון לצידה.

**חוק האות הכתום.** `await` הוא אות עבודה — הוא חייב להישאר נדיר כדי להישמע. סטטוס שגרתי שאינו דורש פעולה מיידית (כמו "טרם הועברה לרו״ח") נשאר `idle`, אחרת רוב המסך כתום והאות מתדלדל.

## 3. Typography

**Body Font:** Heebo (עם ui-sans-serif, system-ui) — משקלים 300–800 נטענים מ-Google Fonts.

**Character:** משפחה אחת לכל המערכת — Heebo נבחרה כי היא נושאת עברית ולטינית באותה איכות. ההיררכיה נבנית ממשקל וגודל בסולם צמוד (יחס ~1.14–1.25), לא ממשפחות מתחרות. אין פונט תצוגה: זו מערכת עבודה, לא פוסטר.

### Hierarchy
- **Headline** (700, ‏1.25rem במובייל / 1.5rem במסך רחב): כותרת דף (`page-title`), אחת לדף.
- **Title** (600, ‏1rem): כותרת אזור (`section-title`), כותרת מודאל.
- **Body** (400, ‏0.875rem): טקסט עבודה — תאים, טפסים, הודעות.
- **Label** (500, ‏0.875rem): תוויות טפסים, בצבע `ink-soft`.
- **Table header** (600, ‏0.75rem, uppercase ללטינית, tracking 0.025em): כותרות עמודה בצבע `ink-muted`.
- **KPI value** (700, ‏1.25rem, tabular-nums): המספר הגדול בכרטיסי הדשבורד.

### Named Rules
**חוק הספרות המיושרות.** כל תא מספרי — סכום, כמות, מספר מסמך — עטוף ב-`class="num"`‏ (LTR + ‏tabular-nums + יישור לסוף). ספרות שלא מתיישרות בטור הן שגיאה, לא סגנון.

## 4. Elevation

שטוח-בעיקרו. משטח מונח (`card`) נבדל מהקנבס בגבול דק (`line`, ‏1px) ובצל עדין מאוד (`shadow-sm`) — רמז לחומריות, לא הצהרת גובה. עומק אמיתי שמור אך ורק למה שבאמת מרחף מעל הדף.

### Shadow Vocabulary
- **מונח** (`box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05)` = shadow-sm): כרטיסים במנוחה.
- **מוזמן** (`box-shadow` ברמת shadow + ‏`border-indigo-300`): כרטיס לחיץ ב-hover — ההזמנה לפעולה היחידה שמותר לה להרים משטח.
- **מרחף** (`shadow-xl` למודאל, `shadow-lg` לטוסט): שכבות מעל הדף, תמיד עם backdrop (`bg-slate-900/50`) במודאל.

### Named Rules
**חוק המרחפים.** צל בולט מופיע רק על אלמנט שנמצא מעל הדף (מודאל, טוסט, תפריט). כרטיס שצועק בצל כבד במנוחה — שגיאה.

## 5. Components

אוצר מילים אחיד: אותו כפתור, אותו שדה, אותו badge בכל 24 המסכים. רכיב שנראה אחרת בשני מקומות — אחד מהם שגוי.

### Buttons
- **Shape:** פינות מעוגלות עדינות (0.5rem), padding ‏8px 14px, טקסט 0.875rem/500.
- **Primary:** `action` עם טקסט לבן; hover מעמיק ל-`action-hover`. פעולה ראשית אחת לאזור.
- **Secondary:** לבן עם גבול `slate-300` וטקסט `ink-body`; hover ל-slate-50.
- **Danger:** `alert-solid` עם טקסט לבן — פעולות הרסניות בלבד, תמיד מאחורי `ConfirmDialog` (עם שדה סיבה כשנרשם ביומן ביקורת).
- **Ghost:** טקסט בלבד `ink-soft`, ‏hover רקע slate-100 — פעולות משנה וסגירה.
- **States:** `disabled:opacity-50` + ‏cursor-not-allowed; מצב busy מציג ספינר בתוך הכפתור.

### Chips
- **StatusBadge** (`badge-*`): גלולה (radius מלא, ‏2px 10px, ‏0.75rem/500) בצבעי `soft`/`on-soft` של הטון. נבנה מ-`Tone` ב-`lib/status.ts` — כל טון חייב מחלקה ב-index.css, אחרת ה-badge מאבד עיצוב בלי שגיאת build.

### Cards / Containers
- **Corner Style:** ‏0.75rem (כרטיס), ‏1rem (מודאל).
- **Background:** `surface` לבן על `canvas`.
- **Shadow Strategy:** מונח (ראה Elevation); לחיץ מקבל hover של גבול אינדיגו + צל.
- **Border:** ‏1px ‏`line` תמיד; מפרידים פנימיים ב-`line-soft`.
- **Internal Padding:** ‏16px, ‏20px במסכים רחבים (`card-pad`).

### Inputs / Fields
- **Style:** לבן, גבול `slate-300`, ‏0.5rem, ‏8px 12px, טקסט 0.875rem.
- **Focus:** טבעת אינדיגו כפולה (`ring-2 ring-indigo-500` + גבול אינדיגו) — עקבית עם צבע הפעולה.
- **Error / Disabled:** שגיאה מוצגת ב-`ErrorNote` (קופסת `note-alert`) מתחת לטופס; disabled מקבל רקע slate-50.

### Navigation
- **סרגל צדי (דסקטופ):** ‏15rem קבוע, slate-900 כהה. שלוש קבוצות (רכש / כספים / בקרה) והדשבורד מוצמד לראש; כותרות קבוצה מוסתרות כשלמשתמש פריט יחיד. פריט פעיל: `bg-indigo-600/20` + טקסט לבן; לא פעיל: slate-300 עם hover עדין (`white/5`).
- **בר תחתון (מובייל):** לבן עם גבול עליון, 4–5 פריטי הליבה של התפקיד; פעיל = `action`, לא פעיל = `ink-muted`. ‏safe-area-inset נשמר.

### AttentionZone (רכיב חתימה)
רצועת "דורש טיפול היום" בראש הדשבורד — ההגשמה של העיקרון המנחה. כרטיס אחד, שורות דחוסות בסדר עסקי: מונה ב-badge צבעוני, תווית, סכום ₪, וחץ. שתי שכבות: פריטים פעילים כשורות מלאות; פריטים ב-0 קורסים לרצועת "‏✓ אין…" אפורה אחת, כדי ששמונה דברים תקינים לא יצעקו כמו דבר אחד שדורש טיפול. פריט שאינו מדיד (null) לא מוצג כלל — לא כ-0. כל שורה היא `<Link>` אמיתי.

### Loading / Empty
- **Skeletons** שמשקפים את צורת התוכן (`SkeletonTable`/`SkeletonCards`/`SkeletonList`), ברוחבי שורה מגוונים כדי שלא ייראו כברקוד; עטופים ב-`role="status"` עם "טוען" יחיד לקורא מסך. ספינר מרכזי רק בשערי auth.
- **EmptyState:** אייקון Inbox‏ + כותרת + משפט הכוונה. מצב ריק מלמד את המסך, לא רק "אין נתונים".

## 6. Do's and Don'ts

### Do:
- **Do** להצמיד לכל סטטוס טקסט או אייקון — צבע לעולם אינו הערוץ היחיד (WCAG 2.1 AA).
- **Do** ‏`—` למדד שאין לו נתונים. אפס הוא טענה נמדדת על המציאות; `—` הוא היעדר מדידה.
- **Do** ‏properties לוגיים בלבד (`start`/`end`, `ms`/`me`, `ps`/`pe`) — לעולם לא `left`/`right`.
- **Do** ‏`class="num"` על כל תא מספרי.
- **Do** ניגודיות טקסט ≥4.5:1; ‏`ink-faint` (slate-400) מותר רק ל-placeholder ורמזים, לא לטקסט מהותי.
- **Do** מעברים 150–250ms עם ease-out, מכבדים `prefers-reduced-motion` (כמו `page-fade` הקיים).
- **Do** ‏`ConfirmDialog` עם סיבה על כל פעולה הרסנית או כזו שנרשמת ביומן ביקורת.

### Don't:
- **Don't** אנימציות מוגזמות או תנועה שאינה משדרת מצב — אסור בחוקה.
- **Don't** ‏glassmorphism, blur דקורטיבי, שטחים דקורטיביים ריקים — אסור בחוקה.
- **Don't** טקסט זעיר בניגודיות נמוכה — אסור בחוקה.
- **Don't** גרפים מיותרים: גרף שאינו עוזר להחלטה הוא רעש — אסור בחוקה.
- **Don't** הסתרת פעולות קריטיות מאחורי hover — אסור בחוקה.
- **Don't** מראה תבנית-אדמין גנרית או הפיכת כל דף לרשת כרטיסים מנופחת — אסור בחוקה.
- **Don't** ערכים סטטיים מזויפים בדשבורד; כל מספר נגזר מנתוני האפליקציה.
- **Don't** ‏`border-left`/`border-right` צבעוני עבה כפס-סימון על כרטיסים — משתמשים ב-`note-*` (רקע wash + גבול line מלא).
- **Don't** להשתמש ב-emerald/amber/rose/sky מחוץ למשמעות הסמנטית שלהם, או להוסיף גוון סטטוס חדש בלי לעדכן את `Tone`, ‏`index.css` ואת המסמך הזה יחד.
