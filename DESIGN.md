---
name: SupplyFlow
description: מערכת procurement-to-payment עברית RTL — B2B פרימיום, מסגרת פטרול עמוקה + נייר חם + צבע סמנטי
colors:
  # ---- שלד (structural) — "חדר בקרה פטרול" (T6, 21.07.2026) ----
  canvas: "oklch(96.8% 0.01 85)"                # רקע הגוף — נייר חם
  surface: "oklch(99.2% 0.004 85)"              # כרטיסים, טבלאות, מודאלים, שדות
  surface-sunken: "oklch(95.2% 0.012 85)"       # thead, שדות disabled, רצועות שקטות
  line: "oklch(88.5% 0.014 80)"                 # גבול כרטיס, מפריד מול canvas
  line-soft: "oklch(93.2% 0.011 82)"            # מפרידי שורות פנימיים
  line-strong: "oklch(65% 0.016 78)"            # גבול שדות/כפתור משני — 3.16:1
  ink: "oklch(22% 0.025 205)"                   # כותרות דף, הטקסט החזק ביותר
  ink-body: "oklch(29% 0.022 205)"              # טקסט גוף
  ink-mid: "oklch(37% 0.022 205)"               # תאי טבלה
  ink-soft: "oklch(44% 0.022 205)"              # תוויות, כפתורי ghost
  ink-muted: "oklch(50% 0.021 205)"             # כותרות עמודה, טקסט משני
  ink-faint: "oklch(54% 0.019 205)"             # placeholder ורמזים — 4.57:1 על canvas
  ink-ghost: "oklch(75.5% 0.012 85)"            # אייקונים כבויים, סימנים דקורטיביים
  # פעולה = מותג פטרול; היא מבנית בלבד ולעולם אינה מחליפה סטטוס.
  action: "oklch(43.08% 0.0701 211.43)"          # #0f5a66 — כפתור ראשי, לינק, גרף
  action-hover: "oklch(38.06% 0.0625 212.45)"
  action-solid: "oklch(47.64% 0.0772 210.72)"    # צ'יפים מלאים, מילויי בחירה
  action-soft: "oklch(93.41% 0.0182 205.32)"     # badge ספירה
  action-on-soft: "oklch(38.19% 0.0588 211.94)"
  action-wash: "oklch(96.69% 0.0086 188.11)"    # hover שורה
  action-line: "oklch(64.32% 0.0541 205.4)"      # גבול hover על כרטיס לחיץ
  focus: "oklch(52.98% 0.0911 212.98)"           # טבעת פוקוס — 4.98:1
  # shell כהה: המסגרת הממותגת של המוצר; אזור העבודה נשאר נייר חם.
  shell: "oklch(31.81% 0.0517 213.09)"           # #073942
  shell-ink: "oklch(97% 0.009 85)"
  shell-ink-soft: "oklch(88% 0.012 85)"
  shell-ink-dim: "oklch(73% 0.015 85)"
  shell-heading: "oklch(72% 0.016 85)"
  # גרפים — חמישה גוונים מבניים; צבע סמנטי רק כשיש משמעות עסקית.
  chart-1: "{colors.action}"
  chart-2: "oklch(49% 0.09 245)"                # כחול פלדה
  chart-3: "oklch(52% 0.095 275)"               # אינדיגו־צפחה
  chart-4: "oklch(53% 0.09 305)"                # סגול מעושן
  chart-5: "oklch(52% 0.085 335)"               # mauve מעושן / "אחר"
  chart-grid: "oklch(89% 0.014 80)"
  chart-tick: "oklch(50% 0.021 205)"
  chart-label: "oklch(44% 0.022 205)"
  chart-tick-strong: "oklch(37% 0.022 205)"
  star: "amber-400"                             # כוכבי דירוג: קישוט, לא סטטוס
  star-hover: "amber-300"
  # ---- שפת הצבעים הסמנטית — העוגנים ללא שינוי ----
  # done=הושלם (emerald) · await=ממתין (amber) · alert=חריגה (rose) · info=מידע (sky) · idle=ניטרלי (slate)
  # כל משמעות חושפת שישה משטחים: wash/line/soft/on-soft/fg/solid — הערכים ב-@theme ב-src/index.css.
  trend-up: "rose-700"                          # התייקרות — תמיד עם חץ
  trend-down: "emerald-700"                     # הוזלה — תמיד עם חץ
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
  micro:
    fontFamily: "IBM Plex Sans Hebrew, ..."
    fontSize: "0.6875rem"
    fontWeight: 600
    note: "11px שמור לכותרות קבוצות בסרגל ולתוויות ניווט תחתון בלבד; אינו משמש תוכן או מידע עסקי"
  num:
    fontFamily: "IBM Plex Mono, ui-monospace, Consolas, monospace"
    fontFeature: "tabular-nums"
    note: "כל .num — סכומים, כמויות, מספרי מסמכים, ערכי KPI — במונו. חתימת הלדג'ר של המערכת"
rounded:
  control: "0.5rem"    # rounded-lg — כפתורים, שדות
  card: "0.75rem"      # rounded-xl — כרטיסים ומשטחי עבודה
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
  card: { backgroundColor: "{colors.surface}", border: "{colors.line}", rounded: "{rounded.card}", shadow: "petrol-tinted soft" }
  badge-*: { pattern: "bg-{tone}-soft + text-{tone}-on-soft", rounded: "{rounded.pill}" }
  note-*: { pattern: "bg-{tone}-wash + border-{tone}-line + text-{tone}-on-soft" }
---

# Design System: SupplyFlow — "חדר בקרה פטרול"

## 1. Overview

**Creative North Star: "חדר בקרה שקט" עטוף במסגרת פטרול עמוקה.**

SupplyFlow מטפל בכסף, ולכן סביבת העבודה שלו נשארת רגועה: נייר חם, טקסט כהה וספרות מיושרות
במונו. מסגרת הפטרול — סרגל הצד, פעולות, לינקים וגרפים מבניים — נותנת למוצר זהות ברורה בלי לצבוע
כל משטח. **צבע סטטוס עדיין שמור לטענה עסקית בלבד**; הפטרול מזהה את המוצר ואת הפעולה, לא "הצלחה"
או "חריגה". התוצאה צריכה להרגיש כמו כלי מקצועי שנעים לעבוד בו שעות, לא תבנית אדמין ולא מסך סטרילי.

**Key Characteristics:**
- שקט כברירת מחדל; פטרול = מסגרת/פעולה, וצבעי done/await/alert/info = משמעות עסקית בלבד.
- כל מספר במונו (`.num` → IBM Plex Mono): טורי סכומים מתיישרים כמו בפנקס.
- עברית RTL מלאה: properties לוגיים בלבד; אין uppercase.
- עומק רך: צל פטרול עדין בכרטיס במנוחה, והרמה של פיקסל אחד רק בכרטיס לחיץ.
- אין נתון מזויף: מדד בלי נתונים מציג `—`, לא `0`.

## 2. Colors

### עקרון מסגרת הפטרול
**`action` הוא צבע המותג המבני.** כפתור ראשי, לינק (`.link`), צ'יפ נבחר ועמודת הגרף העדכנית משתמשים
בפטרול; שאר עמודות הגרף משתמשות ברמפה המבנית `chart-2`–`chart-5`. ה-shell כהה יותר ומשמש מסגרת;
פריט הניווט הפעיל הופך לגלולת נייר בהירה כדי להישאר
מובחן ונגיש. אסור להשתמש בפטרול כתחליף לסטטוס סמנטי.

### שפת הסטטוס — ללא שינוי
ארבע משמעויות + ניטרלי, כל אחת עם שישה משטחים (wash/line/soft/on-soft/fg/solid):
**done** (emerald) הושלם/תקין/שולם · **await** (amber) ממתין לטיפול מצדנו · **alert** (rose)
חריגה/דחוף/הפסד אפשרי + פעולה הרסנית · **info** (sky) הכדור אצל גורם חיצוני · **idle** (slate)
היעדר טענה. דרגות `solid` ו־trend הוכהו ל־700 כדי להבטיח AA עם טקסט לבן/טקסט קטן; המשמעות והגוון
לא השתנו. **חוק ארבע המשמעויות** ו**חוק האות הכתום** בתוקף: משמעות תמיד מלווה טקסט או אייקון.

### Named Rules
**חוק המסגרת הממותגת:** פטרול מותר רק בשלד, בפעולה ובגרפים מבניים; הוא לעולם אינו מקודד מצב עסקי.
**חוק הטוקנים:** אפס מחלקות פלטה גולמיות (`slate-*`, `indigo-*`...) ב-tsx — נאכף בגרפ שב־Runbook להלן.
צבע או צל חדש = טוקן חדש ב־@theme + עדכון המסמך הזה יחד.
**חוק החשיפה המדורגת:** בדשבורד הפעולה הבאה, הסכומים הראשיים והמגמות המרכזיות גלויים מיד; פירוט
תפעולי משני נשאר זמין ב־disclosure. אין למחוק נתון כדי להפחית עומס, ואין להסתיר פעולה קריטית מאחורי
hover או בורר תצוגה.

## 3. Typography

**UI:** IBM Plex Sans Hebrew (400/500/600/700) — עברית ולטינית באיכות זהה, אופי טכני-מקצועי.
**מספרים:** IBM Plex Mono (400/500/600) דרך `--font-num`, מוחל אוטומטית על כל `.num` —
סכומים, כמויות, מספרי מסמכים, ערכי KPI. זו חתימת המערכת: מערכת כספית שמספריה מיושרים כמו טרמינל.

### Hierarchy
Headline ‏700 / ‏1.25rem מובייל / ‏1.5rem רחב (`page-title`) · Title ‏600/1rem (`section-title`) ·
Body ‏400/0.875rem · Label ‏500/0.875rem ‏ink-soft · Table header ‏600/0.75rem ‏ink-muted —
**בלי uppercase, בלי tracking** (שריד לטיני שהוסר) · Micro ‏600/0.6875rem שמור רק לכותרות קבוצות
בסרגל ולניווט התחתון · ערכי KPI ‏600–700/1.25rem במונו.

**חוק הספרות המיושרות:** כל תא מספרי עטוף `class="num"` ‏(LTR + ‏tabular-nums + מונו + יישור לסוף).

## 4. Elevation

העומק רך, צבוע ועקבי; אין צל שחור גנרי:
- **מונח:** `shadow-card` + ‏hairline חם — מורגש מול canvas בלי להפוך כל אזור לאריח.
- **חריג עומק בשם — dashboard-depth:** בתוך מרכז הבקרה בלבד, כרטיסים מקבלים
  `shadow-dashboard`, צל פטרול מעט עמוק יותר שמפריד בין אזורי ההחלטה. הסלקטור חייב להישאר
  ממוסגר תחת `.dashboard-depth`; אין להחיל את הטוקן על כרטיסים תפעוליים בשאר המערכת.
- **מוזמן:** ‏`.card-link-hover` — גבול `action-line`, ‏`shadow-card-hover` והרמה של 1px בלבד.
- **מרחף:** ‏shadow-xl למודאל (rounded-2xl), ‏shadow-lg לטוסט — תמיד עם backdrop ‏`shell/50` במודאל.
- **צף קבוע:** ‏`--shadow-fab` — פטרול מעט חזק מ־`--shadow-menu`; שמור ל־FAB הגלובלי בלבד.

**רישום z-index:** בר קבלה 30 · סרגל צד/ניווט תחתון/כותרות/FAB ‏40 · מגירה/מודאל 50 · טוסט 60.

## 5. Components

### Navigation — מסגרת פטרול
סרגל צדי, טופ־בר ומגירת מובייל משתמשים ב־`bg-shell` (`#073942`) עם קווים `shell-ink/10`.
**פריט פעיל = גלולת נייר (`bg-shell-ink text-shell`)**; פריט רגיל `shell-ink-soft` עם hover של
`shell-ink/10`. בר הניווט התחתון נשאר משטח נייר והפריט הפעיל בו `text-action`.
‏theme-color ב־index.html = ‏`#073942`.

### Buttons
Primary פטרול · Secondary נייר + ‏`line-strong` ביחס 3:1 · Danger ‏`alert-solid` (תמיד מאחורי
ConfirmDialog עם סיבה כשנרשם ביומן) · Ghost ‏`ink-soft`. לכל btn טבעת focus, מעבר 150ms ומשוב
לחיצה של 1px; ‏disabled אינו זז ו־busy נשאר עם ספינר בתוך הכפתור.

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

### ActionMenu — תפריט פעולות שורה
טריגר `MoreVertical` בכפתור ghost (‏40px+), נפתח כ־portal ל־body כדי שלא ייחתך ע״י ה־overflow של
DataTable, וממוקם מהקצה הלוגי של הטריגר (RTL-aware). משטח: `bg-surface + border-line` עם טוקן
הצללה ייעודי `--shadow-menu` — פטרול עדין בין `shadow-card-hover` לרובד הטוסט/מודאל. ניווט מקלדת
מלא (roles menu/menuitem, חיצים/Home/End/Escape), סגירה בגלילה ובלחיצה בחוץ. פעולה הרסנית =
`text-alert-fg`, גלויה תמיד בתפריט — לעולם לא מוסתרת מאחורי hover (חוק החשיפה המדורגת).
מחובר ל־DataTable דרך `rowActions` — עמודת קצה בדסקטופ, קצה לוגי של הכרטיס במובייל.

### FAB — פעולות מהירות גלובליות
כפתור צף 56px ‏(`h-14 w-14`, ‏`bg-action`, ‏`--shadow-fab`) בפינה הלוגית: ‏`end-4 bottom-20` במובייל
(מעל הניווט התחתון, עם safe-area כמוהו) ו־`lg:end-8 lg:bottom-8` בדסקטופ. פתיחה = speed-dial של
גלולות `bg-surface + border-line + shadow-menu` מעל הכפתור, ללא scrim (חדר שקט); הפריטים מגיעים
מ־`quickActionsFor(role)` — אותו אוצר מילים כמו שורת הפעולות בדשבורד. מוסתר ב־`/receiving/:orderId`
(יש לו בר פעולות קבוע משלו) וב־`/orders/new`, ‏`/invoices/new` (מסכי היצירה שהוא עצמו מוביל אליהם).
‏Escape / לחיצה בחוץ / ניווט סוגרים; ‏`aria-haspopup="menu"` עם roles menu/menuitem, פריטים ב-Tab.

### Dashboard — פס הכסף
שלושת מדדי הכסף = **BandStat בתוך `.card` אחד** — מקטעים עם מפרידים לוגיים (`border-s`/`border-t`,
לעולם לא divide-x הפיזי), לא שלושה אריחים זהים. האנטומיה הקבועה של כל BandStat היא:
אייקון סמנטי בתוך chip שקט · תווית · ערך סופי מיידי במונו · הקשר תקופה · delta אופציונלי מול אותם
ימים בחודש הקודם. ל־"נרכש" ול־"שולם" בלבד נוסף ספארקליין קומפקטי של שמונה שבועות, ורק כשהערך
הראשי קיים ולפחות שני שבועות מכילים פעילות אמיתית. "יתרת חשבוניות" מציגה את מספר החשבוניות הפתוחות
בלבד — לעולם לא ספארקליין או מגמה מומצאים. אין טקסט הסבר ארוך בפס; במובייל כל BandStat הוא שורה
קומפקטית וההשוואה נשארת גלויה.

### Dashboard — טיפול ופירוט תפעולי
ב־AttentionZone פעולות `alert`/`await` גלויות תמיד, בשתי עמודות מדסקטופ ובעמודה אחת במובייל. שורות
לידיעה, מדדים ללא נתונים ומצבים תקינים מאוחדות תחת `<details>` טבעי וסגור. כל קישור ושורת summary הם
יעד מגע של 44px לפחות, עם focus-visible ו־active גלויים.

ארבעת אזורי הפירוט — חריגים, התייקרויות, יתרות ספקים ומשימות — חיים בכרטיס אחד בשם "תמונת מצב
תפעולית". כל אזור הוא disclosure עם count והנתון העסקי המרכזי בשורת ה־summary; פתיחת אחד סוגרת את
האחרים באמצעות `name="dashboard-operations"`. אזור ריק מוצג כשורת all-clear שאינה אינטראקטיבית,
והרשומות והקישורים נשמרים בתוך האזור הפתוח.

### Chips / Notes / Skeletons / EmptyState
badge = ‏soft/on-soft · ‏note = ‏wash/line/on-soft ‏(+idle לניטרלי) · ‏skeleton = ‏`bg-line`,
משקף את צורת התוכן · ‏EmptyState מלמד את המסך.

### Charts
recharts לא קורא CSS vars מ-attributes — ‏`src/lib/theme.ts` ‏(`chartTheme()`) קורא את הטוקנים
פעם אחת ב-getComputedStyle ומזרים מחרוזות צבע אמיתיות (`bar`, ‏`bars`, ‏grid/tick/label/tickStrong/
trendUp/trendDown/flat). ‏`bars` הוא מערך `chart-1`–`chart-5`; אפס הקסים ב-tsx וצבע סמנטי בגרף רק
כשהוא נושא משמעות עסקית.

כל המגמות חיות בלוח חזותי יחיד וללא tabs: שלוש תצוגות גלויות יחד — הוצאות חודשיות בעמודות, תמהיל
קטגוריות בחודש הנוכחי כ־donut, והשוואת רכש מול תשלומים בשמונה השבועות האחרונים בקווים. בגרף החודשי
העמודה העדכנית תמיד `chart-1`, ועמודות סמוכות מקבלות גוונים שונים. בקטגוריות מוצגות ארבע הגדולות
ו־"אחר" שמסכם במדויק את היתר ומקבל תמיד `chart-5`; donut מוצג רק כשהסכום הכולל חיובי, ואחרת מוצג
empty state. קווי הרכש והתשלומים מובחנים גם בדפוס קו או בסמן נקודה, לא בצבע בלבד. התוויות, הסכומים,
רשימת הקטגוריות ו־ARIA נושאים את המשמעות; אין מקרא מיותר. ‏Tooltip משתמש ב־`cursor={false}` כדי לא
להציג overlay אפור.

buckets שבועיים נושאים `label`, סכום ומספר רשומות. bucket חסר מיוצג ב־`total: null`, בעוד אפס מדוד
מותר רק כשקיימות מאחוריו רשומות; נקודה חסרה אינה מקבלת עמודה, נקודה או תווית צבעונית. כל תרשים מספק
שם נגיש ותיאור מלא של הסדרה והערכים. שלושת הגרפים נכנסים פעם אחת בלבד בחשיפה הראשונה של לוח המגמות
ל־viewport; רענון נתונים אינו מפעיל את האנימציה מחדש. אם `IntersectionObserver` חסר, או תחת
`prefers-reduced-motion`, כל הגרפים מוצגים סטטיים מיד. סדרה ללא פעילות אמיתית מוחלפת ב־empty state.

### Motion budget — דשבורד
אזורי ההחלטה נכנסים פעם אחת כשהשלד מוחלף בנתונים: 350ms, תזוזה של 7px ו־60ms בין אזורים.
חותמת "עודכן ב־" מתחלפת ב־fade של 180ms עם `aria-live="polite"`. אנימציית שלושת הגרפים מוגבלת
לכניסה הראשונה של לוח המגמות ל־viewport. אין count-up לסכומים, אין נורית LIVE, אין הבהוב מחזורי ואין אנימציית hover
שמשנה מידע. תחת reduced-motion מבוטלים stagger, draw-in, lift ותנועת מעבר; מצב טעינה פונקציונלי
יכול להישאר כספינר איטי.

## 6. Do's and Don'ts

### Do:
- **Do** כל צבע דרך טוקן; מחלקות המשמעות (`badge-*`, `note-*`, `text-*-fg`) הן ה-API.
- **Do** ‏`class="num"` על כל תא מספרי — המונו הוא חלק מהשפה, לא קישוט.
- **Do** ‏properties לוגיים בלבד; ‏`—` למדד ללא נתונים; ניגודיות ≥4.5:1 (ledger ב־Runbook להלן).
- **Do** מעברים 150–250ms ‏ease-out מכבדי reduced-motion; ‏`active:` לצד `hover:` ברכיבים משותפים.

### Don't:
- **Don't** להשתמש בפטרול כסטטוס או לפזר גוון מותג נוסף; מעטפת המותג נשענת על גוון אחד.
- **Don't** ‏uppercase/tracking על טקסט עברי.
- **Don't** צל שחור/כבד; ‏glassmorphism; אנימציה שאינה מצב — אסור בחוקה.
- **Don't** להציג count-up, נורית LIVE או מגמה שאין מאחוריה רשומות אמיתיות.
- **Don't** מחלקת פלטה גולמית או הקס ב-tsx — גרפ האכיפה שלהלן חייב להישאר ריק.
- **Don't** ‏emerald/amber/rose/sky מחוץ למשמעותם; אין להמציא משמעות שישית.
- **Don't** ‏`border-left/right` צבעוני כפס-סימון — ‏`note-*` בלבד.

### Retheme Runbook + אכיפה

**רה-תמה סטטית עתידית = שלושה קבצים:** ‏(1) בלוק ה־@theme ב־`src/index.css` · ‏(2) ‏`index.html`
ל־theme-color/פונטים · ‏(3) המסמך הזה. מעבר שמשנה את *קוטביות* ה־shell (בהיר↔כהה) מחייב בנוסף audit
לצרכני `bg-shell` כדי לוודא שהם משתמשים ב־`shell-ink-*`, כפי שנעשה ב־Login/AcceptInvite בסבב T6.

**גרפ האכיפה** (חייב להחזיר אפס שורות על `src --include='*.tsx'`):
```
\b(bg|text|border|ring|fill|stroke|divide|outline|decoration|placeholder|accent|caret|shadow)-(slate|gray|zinc|indigo|violet|blue|emerald|green|amber|yellow|orange|rose|red|sky|cyan|teal)-[0-9]{2,3}\b
```
וכן `#[0-9a-fA-F]{6}` — אפס הקסים ב-tsx (הגרפים דרך chartTheme).

**Contrast ledger (נמדד 21.07.2026, סקריפט OKLCH→sRGB):**
סדרת הגרפים מול surface (`#fefcf9`), לאחר המרה ל־sRGB: chart-1 ‏`#0f5a66` — ‏7.67:1 ·
chart-2 ‏`#2f6590` — ‏6.07:1 · chart-3 ‏`#59649f` — ‏5.49:1 · chart-4 ‏`#785e96` — ‏5.36:1 ·
chart-5 ‏`#87567c` — ‏5.63:1. כל חמשת הצבעים בתוך gamut של sRGB ועוברים את רף 3:1.
ink/canvas ‏15.68 · ‏ink-body/surface ‏13.68 · ‏ink-mid ‏10.10 · ‏ink-soft ‏7.51 · ‏ink-muted ‏5.81 ·
‏ink-faint/surface ‏4.90 · ‏ink-faint/canvas ‏4.57 · לבן על action ‏7.85 · על action-hover ‏9.75 ·
על action-solid ‏6.43 · ‏focus/surface ‏4.98 · ‏line-strong/surface ‏3.16 · ‏action-line/surface ‏3.17 ·
‏shell-ink/shell ‏11.51 · ‏shell-soft ‏8.74 · ‏shell-dim ‏5.25 · ‏shell-heading ‏5.06.
מילויי הסטטוס בדרגת 700 עם לבן: המינימום הוא await ‏5.05; trend-up/down בדרגת 700 עוברים 5.2.

**סיכוני תחזוקה:** ‏`badge-${tone}`/`note-${tone}` נבנות דינמית — כל ערך Tone חייב מחלקה ב-index.css
(אין שגיאת build אם חסרה). ‏Tailwind v4: מחלקה מותאמת = ‏@apply על utilities אמיתיים בלבד; קומפוזיציה
דרך ‏@utility (כמו btn/badge/note). טוקני `shadow-card*` חייבים להישאר צבועי פטרול ועדינים.
‏chartTheme() ממוטמן ברמת מודול — theme switch עתידי חייב invalidation.
