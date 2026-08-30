# PLAN — הוספת אנגלית ל-InPlace

עודכן: 27.08.2026 · מצב: `PLAN_ONLY / NOT_STARTED / OWNER_DECISIONS_RECORDED`
ענף ביצוע: `claude/add-english-language-system-f43d1e` (worktree קיים; לא לעבוד על `main`).

**הכרעות בעלים שנרשמו 27.08.2026 — הן חלק מהתוכנית, לא הצעות:**
1. **זיהוי השפה לפי הדפדפן** (`navigator.language`), עם החלפה ידנית שגוברת ונשמרת.
2. **קונסולת התפעול אינה מתורגמת** — ‏`ABANDON:` (משימה 2.10).
3. **שמות מוצרים מוצגים כפי שהתקבלו במסמך הייבוא. אין תרגום אוטומטי.** תרגום הוא אופציה
   שנדלקת ברמת הארגון, ואז מוצעת ומאושרת **פר-פריט** (‏§3 והפאזה הרביעית).

> **לסוכן המבצע:** התוכנית מחולקת לשש פאזות עם שער בסוף כל אחת. **אין לעבור פאזה בלי הראיה
> שהשער דורש.** שער שננטש נרשם ב-`GATES.md` עם `ABANDON:` וסיבה — לא נמחק בשקט.

**המטרה במשפט אחד:** משתמש שהדפדפן שלו באנגלית רואה את InPlace באנגלית ובכיוון LTR, יכול
להחליף שפה ידנית בהגדרות, וההחלפה נשמרת לו — בלי לגעת בשקל, בראיות או בשם שהספק מזהה.

**הארכיטקטורה בשלושה משפטים:** אין ספריית i18n חדשה — מרחיבים את הדפוס ש**כבר קיים ועובד
בריפו**, ‏`src/portal/i18n.ts` + `src/portal/PortalApp.tsx:59-70`: מילון מוקלד, זיהוי מ-
`navigator.language`, והחלפת `documentElement.lang/dir` ב-runtime. השכבה שנוספת מעליו היא
Context של React שמזרים `t()` ופורמטרים תלויי-לוקאל, ועמודה `profiles.locale` ששומרת בחירה
ידנית. ‏95% מהעבודה אינה מנוע התרגום — היא **חילוץ המחרוזות**, ולכן השער המרכזי הוא סקריפט
שומר שמונע נסיגה.

**הסטאק:** ללא תלות חדשה. ‏`Intl.DateTimeFormat` · `Intl.NumberFormat` · `Intl.PluralRules` ·
`navigator.language` · React 19 Context · `import()` דינמי לטעינת מילון עצלה.

---

## §1 — מה נמדד לפני התכנון (לא הונח)

כל שורה כאן נמדדה בעץ העובד ב-27.08.2026. המספרים הם היקף העבודה האמיתי.

| מה | מדידה | ראיה |
|---|---|---|
| קבצי מקור לא-spec | ‏224 | `find src -name '*.ts*' \| grep -v spec` |
| מהם נושאים עברית | ‏**205** | `grep -rlE '[א-ת]'` |
| שורות נושאות עברית (לא-spec) | ‏**7,843** | ספירה ישירה |
| ליטרלים במרכאות בודדות עם עברית | ‏3,444 | `grep -oE "'[^']*[א-ת][^']*'"` |
| ליטרלים במרכאות כפולות עם עברית | ‏1,148 | `grep -oE '"[^"]*[א-ת][^"]*"'` |
| טקסט JSX חשוף (בין `>` ל-`<`) | ‏1,341 | `grep -oE '>[^<>{}]*[א-ת][^<>{}]*<'` |
| **אתרי תרגום, אומדן מאוחד** | ‏**~5,900** (מפתחות ייחודיים צפויים 3,000–4,000 אחרי איחוד כפילויות) | סכום שלושת הקודמים, עם חפיפה |
| קבצי spec שנושאים עברית | ‏**151 קבצים · 3,974 שורות** | `grep -rlE '[א-ת]' --include=*.spec.*` |

**מה כבר קיים ומקל — אלה נכסים, לא הנחות:**

- **הפורטל כבר דו-לשוני ומוכיח את הדפוס.** ‏`src/portal/i18n.ts` (‏127 שורות) מחזיק מילון
  `he`/`en`, ‏`portalLocaleFromLocation()` מזהה לפי `?lang=` ואז `navigator.language`, ו-
  `PortalApp.tsx:69-70` מחליף `documentElement.lang` ו-`dir`. יש לו טסטים חיים —
  `src/portal/i18n.spec.ts` ו-`portalApp.spec.tsx:142-156`.
- **‏RTL כמעט מוכן.** ‏`src/index.css` הוא 75KB ובו **התאמה פיזית אחת** (`left|right:`).
  המחקר מדד 179 שימושים ב-properties לוגיים ואפס פיזיים.
- **תוויות סטטוס במקום אחד.** ‏`src/lib/status.ts` — ‏156 שורות עברית, מפה אחת לכל enum.
- **הודעות שגיאה במקום אחד.** ‏`src/lib/errors.ts` — ‏161 שורות, ‏`toHebrewError()`.
- **פורמטרים במקום אחד.** ‏`src/lib/format.ts`, שמור על ידי `check:money`.
- **הטיפוס `'he' | 'en'` כבר קיים פעמיים** — `CommunicationLocale` (`src/lib/orderEmail.ts:11`)
  ו-`PRODUCT_HELP_LOCALES` (`src/lib/assistant/contracts.ts:518`).
- **הגופן כבר נושא לטינית.** ‏`NotoSansHebrew-Latin.woff2` מוגדר ב-`index.css:14-19`. ‏**רק
  התת-קבוצה העברית מקודמת ב-preload** (`index.html:18`) — זה תיקון של שורה אחת.

**מה חוסם ונמדד:**

- **‏`index.html:2`, ‏`operator.html:2`, ‏`portal.html:2`** נעולים על `<html lang="he" dir="rtl">`.
  ‏`vite.config.ts:20` מבצע **החלפת מחרוזת מדויקת** על הליטרל הזה עבור מצב הגופן `almoni` —
  שינוי ה-HTML בלי לעדכן את הפלאגין שובר את `build:almoni` בשקט.
- **בלוק ה-safe-area מתהפך ב-LTR.** ‏`src/index.css:748-802` ממפה `env(safe-area-inset-right)`
  ל-`padding-inline-start` — נכון תחת RTL, **הפוך תחת LTR**. שישה כללים.
- **‏`drawer-enter` פיזי בכוונה.** ‏`index.css:1091-1096` מתעד: „`translate` הוא PHYSICAL והערך
  נבחר לכיוון היחיד של האפליקציה". ב-LTR המגירה תיכנס מהצד הלא נכון.
- **‏`.tech-id` נועל `direction: ltr`** (`index.css:1074`) — זה **נכון ונשאר**, מזהה מכונה הוא
  LTR בכל שפה.
- **יחידות המידה עבריות בתוך ה-DB.** ‏`products.unit text default 'יח''` (`0001_init.sql:92`)
  ו-`UNIT_FORMS` ב-`format.ts` הן מפת מילים עברית בת 45 ערכים. **הפורטל האנגלי מציג היום
  `ק״ג`** — ‏`portal/i18n.ts:125` נופל ל-`unit?.trim()` הגולמי. זה כשל קיים, לא חדש.
- **ל-`profiles` אין עמודת שפה.** ‏`0001_init.sql:31-39`.
- **‏`check:money` מעריך לפי שורה** (`scripts/check-money.ts:88-90`) — מעצב מטבע שנשבר לשתי
  שורות חומק ממנו. הפורמטרים החדשים חייבים להישאר בשורה אחת, אחרת השומר עיוור להם.

---

## §2 — ההכרעה הטכנית: בלי ספריית i18n

**ההכרעה:** לא מתקינים `i18next`, ‏`react-i18next` או `next-intl`.

**למה:**
1. **הדפוס כבר בריפו, כתוב, מוקלד ומכוסה בטסטים** — ‏`src/portal/i18n.ts`. הרחבה שלו היא
   העתקה של מה שעובד; ספרייה היא דפוס שני לאותו דבר.
2. **‏95% מהעבודה היא חילוץ המחרוזות** ולא מנוע התרגום. ספרייה אינה מחלצת ולו מחרוזת אחת.
3. **שומרי הריפו אינם מכסים runtime של צד שלישי.** ‏`check:tokens`, ‏`check:money`,
   ‏`check:typography` סורקים את המקור. ‏`i18next` מביא קונפיגורציה, plugins ו-detector
   שאיש מהם לא רואה.
4. ‏`Intl.PluralRules` נותן ריבוי לעברית ולאנגלית מהפלטפורמה, בלי ICU.

**התקרה שההכרעה הזאת מייצרת, ומתי משדרגים:** מילון של שתי שפות × ~3,500 מפתחות הוא ~250-350KB
JSON. **אסור לשלוח את שתיהן ב-bundle הראשי.** הפתרון בתוכנית הוא `import()` דינמי לפי לוקאל
(פאזה 1, משימה 1.2). אם יום אחד יידרשו namespaces עצלים לפי מסך, interpolation מורכב, או שפה
שלישית עם דקדוק שאינו he/en — **אז** לשקול ספרייה, לא לפני.

---

## §3 — היקף: מה מתורגם ומה לא

הבעלים בחר גם ממשק וגם נתוני עסק. **נתוני עסק אינם גוש אחד** — הם נחלקים לשלוש מחלקות
שהתשובה שונה לכל אחת:

| מחלקה | מה בפנים | מה קורה | למה |
|---|---|---|---|
| **1 — ממשק המערכת** | תפריטים, כפתורים, כותרות, טפסים, סטטוסים, הודעות שגיאה, עוזר | **מתורגם מלא** | זו הבקשה |
| **2 — אוצר המילים של הארגון** | ‏`categories.name`, ‏`products.display_name`, יחידות מידה, ‏`role_labels` | **תרגום כבוי כברירת מחדל; נדלק בבחירה מפורשת, מוצע ומאושר פר-פריט** | הכרעת בעלים 27.08.2026 — ראה למטה |
| **3 — זהות הצד השני וראיות** | ‏`suppliers.name`, ‏`suppliers.address`, ‏`products.name` הגולמי, טקסט OCR, ‏`audit_logs`, ‏`comments`, מסמכי מקור | **לא מתורגם. לעולם.** | ראה למטה |

**מחלקה 3, בשתי שורות:** שם ספק על הזמנת רכש שמגיעה אליו חייב להיות השם שהוא מזהה — הקוד
עצמו כבר קובע את זה ב-`src/lib/format.ts` („‏SUPPLIER-FACING … the supplier recognises THEIR
name for the item"). ‏`audit_logs` ומסמכי מקור הם **ראיה**, ושכתוב ראיה בשפה אחרת הורס אותה.
לכן מחלקה 3 מוצגת תמיד כפי שנשמרה, עטופה ב-`<bdi>`/`bidiIsolate()` כדי שלא תתהפך בתוך משפט
אנגלי — זה מנגנון קיים (`format.ts`, „חוק בידוד השמות" ב-`DESIGN.md`).

### הכרעת הבעלים על שמות מוצרים (27.08.2026)

> „המוצרים צריכים להופיע כמו שהם מופיעים במסמך הייבוא, ותהיה אופציה שתשאל את המשתמש האם
> לתרגם את שמות המוצרים."

**מה זה אומר בקוד — שלוש קביעות:**

1. **אין תרגום אוטומטי. אף פעם.** מעבר לאנגלית **אינו** משנה שם מוצר. פריט בלי שם אנגלי
   מאושר מוצג בעברית, כפי שהוא — נאמנות למסמך המקור.
2. **התרגום הוא אופציה שנדלקת מפורשות**, ברמת הארגון, כבויה כברירת מחדל.
3. **פר-פריט: הצעה ואישור, לא החלה גורפת.** ‏אין backfill.

**זה אינו מנגנון חדש — זו נסיעה שנייה בכביש שכבר סלול.** ‏`0149` בנה בדיוק את הדרך הזאת
לשם העברי הקנוני: `productDisplayName.ts` **מציע ואינו מחיל** („It does not apply it"),
‏`set_product_display_name` הוא `SECURITY DEFINER` המוגבל ל-owner/office, **דורש סיבה**,
נרשם ב-`audit_logs`, ו-`display_name IS NULL` פירושו „רנדר את `name`". השם האנגלי נוסע
באותה דרך, עם אותם שומרים.

**החוק שנגרר מ-`0149` וחייב להיאכף גם כאן:** שם שנשמר ב**סדר ויזואלי** (יובא מגיליון עברי
או OCR בלי המרת bidi, קורא כ-`)ב12- אר30*30מטליות מיקרופייבר`) הוא `blocked` — לא מוצע
ולא מתורגם. ‏`productDisplayName.ts` **מסרב** לפרסר אותו, מפני שפרסור שלו מייצר תשובה
שגויה שנראית סבירה. **תרגום של שם הפוך הוא בדיוק אותו כשל, חמור יותר** — הוא מייצר אנגלית
תקינה לגמרי שמתארת מוצר אחר.

> **נקודה אחת שראוי שתאשר, ואינה חוסמת:** ברירת המחדל שכתובה בתוכנית היא ש**החלפת השפה
> לעולם אינה משנה איזה שם עברי מוצג** — פריט בלי תרגום מאושר מציג באנגלית בדיוק את מה שהוא
> מציג בעברית (כלומר `display_name` אם אושר, אחרת `name`). הקריאה החלופית — „באנגלית תמיד
> מציגים את השם הגולמי `products.name`" — הייתה גורמת לשם להשתנות בעצם ההחלפה, וזה מפתיע.
> אם התכוונת לקריאה החלופית, זה שינוי של שורה אחת ב-4.3.

**מחוץ להיקף התוכנית הזאת במפורש:** מטבע שאינו שקל, אזור זמן פר-ארגון, מודל מס לא-ישראלי,
כתובת/מדינה, נרמול טלפון, חשבונית מובנית EN 16931. כולם מתועדים ב-
`docs/RESEARCH-INTERNATIONAL-READINESS-20260824.md §3` כפערים 3, 5, 6, 8, 9, 4. **אנגלית אינה
השקה בינלאומית**, והתוכנית הזאת אינה מתיימרת לפתוח שוק — היא פותחת שפה.

---

## §4 — מפת הפאזות והשערים

| פאזה | מה נבנה | השער — הראיה שנדרשת כדי לעבור |
|---|---|---|
| **0** | תשתית מילון + שומר `check:i18n` עם מונה מוצמד | `npm run verify` ירוק · השומר נכשל על מחרוזת עברית חדשה שנשתלה בכוונה |
| **1** | Context, זיהוי שפה, החלפת `dir`/`lang`, מתג בהגדרות, `profiles.locale` | צילום: החלפה בהגדרות מעבירה את כל המסך ל-LTR ונשמרת אחרי refresh · טסטים לזיהוי |
| **2** | חילוץ מחרוזות — לפי משטח, מסך אחר מסך | מונה `check:i18n` יורד לאפס · צילומי מסך he+en לכל מסך ברשימה |
| **3** | פורמטרים תלויי-לוקאל + תיקוני LTR ב-CSS | צילום מובייל ב-LTR עם safe-area נכון · טסט פורמט לשתי השפות |
| **4** | נתוני עסק — תרגום קטלוג + יחידות | מיגרציה + preflight ירוקים · מסך קטגוריה/מוצר מציג אנגלית ונופל לעברית כשריק |
| **5** | ראיות, תיעוד, רולאאוט | `quality-gate.yml` ירוק על ה-SHA · `PROGRESS.md`/`DESIGN.md`/`DEBT` מעודכנים |

**כלל חוצה-פאזות:** אחרי כל משימה — קומיט. הודעות קומיט באנגלית בפורמט הריפו
(`feat(i18n): …`, ‏`chore(i18n): …`).

---

## פאזה 0 — תשתית ושומר

### משימה 0.1 — מודול הלוקאל הליבתי

**קבצים:**
- ליצור: `src/lib/i18n/locale.ts`
- ליצור: `src/lib/i18n/locale.spec.ts`

**שלב 1 — לכתוב את הטסט שנכשל.** ‏`src/lib/i18n/locale.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { LOCALES, INTL_LOCALE, dirFor, resolveLocale } from './locale';

describe('resolveLocale', () => {
  it('prefers an explicit stored choice over everything else', () => {
    expect(resolveLocale({ stored: 'en', query: '?lang=he', browser: 'he-IL' })).toBe('en');
  });
  it('falls back to the query parameter when nothing is stored', () => {
    expect(resolveLocale({ stored: null, query: '?lang=en', browser: 'he-IL' })).toBe('en');
  });
  it('detects from the browser when nothing was chosen', () => {
    expect(resolveLocale({ stored: null, query: '', browser: 'en-GB' })).toBe('en');
    expect(resolveLocale({ stored: null, query: '', browser: 'en' })).toBe('en');
  });
  it('defaults to Hebrew for any language that is not English', () => {
    expect(resolveLocale({ stored: null, query: '', browser: 'fr-FR' })).toBe('he');
    expect(resolveLocale({ stored: null, query: '', browser: '' })).toBe('he');
  });
  it('ignores a stored or requested value that is not a supported locale', () => {
    expect(resolveLocale({ stored: 'de', query: '', browser: 'en-US' })).toBe('en');
    expect(resolveLocale({ stored: null, query: '?lang=de', browser: 'he-IL' })).toBe('he');
  });
  it('maps direction and Intl tags without a second source of truth', () => {
    expect(LOCALES).toEqual(['he', 'en']);
    expect(dirFor('he')).toBe('rtl');
    expect(dirFor('en')).toBe('ltr');
    expect(INTL_LOCALE).toEqual({ he: 'he-IL', en: 'en-US' });
  });
});
```

**שלב 2 — להריץ ולוודא כישלון.**
`npx vitest run src/lib/i18n/locale.spec.ts` — צפוי: `Cannot find module './locale'`.

**שלב 3 — המימוש המינימלי.** ‏`src/lib/i18n/locale.ts`:

```ts
/**
 * The one source of truth for "which language is this session in".
 *
 * The precedence chain is deliberate and each rung answers a real case:
 *   stored  — the person went to Settings and chose. Nothing overrides a choice.
 *   query   — `?lang=` — how the supplier portal has always worked (src/portal/i18n.ts:99),
 *             and how a support link can pin a language for a screenshot.
 *   browser — `navigator.language`. The automatic detection this feature was asked for.
 *   he      — the product's base language. An unknown language is not a reason to guess.
 *
 * `stored` is read from localStorage BEFORE auth resolves and from `profiles.locale` after,
 * because /login renders before there is a profile to ask — without the local copy an English
 * speaker meets a Hebrew login screen on every cold start.
 */
export const LOCALES = ['he', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

const isLocale = (v: unknown): v is Locale => LOCALES.includes(v as Locale);

export const INTL_LOCALE: Record<Locale, string> = { he: 'he-IL', en: 'en-US' };
export const dirFor = (locale: Locale): 'rtl' | 'ltr' => (locale === 'he' ? 'rtl' : 'ltr');

export function resolveLocale(input: {
  stored: string | null;
  query: string;
  browser: string;
}): Locale {
  if (isLocale(input.stored)) return input.stored;
  const requested = new URLSearchParams(input.query).get('lang')?.toLowerCase();
  if (isLocale(requested)) return requested;
  return input.browser.toLowerCase().startsWith('en') ? 'en' : 'he';
}
```

**שלב 4 — להריץ ולוודא מעבר.** `npx vitest run src/lib/i18n/locale.spec.ts` — צפוי: ‏6 עוברים.

**שלב 5 — קומיט.** ‏`feat(i18n): resolve the session locale from choice, query, then browser`

---

### משימה 0.2 — שלד המילון וטיפוס המפתחות

**קבצים:**
- ליצור: `src/lib/i18n/dictionaries/he.ts` · `src/lib/i18n/dictionaries/en.ts`
- ליצור: `src/lib/i18n/t.ts` · `src/lib/i18n/t.spec.ts`

**המבנה — namespaces שטוחים לפי משטח, לא לפי קובץ.** עברית היא **בסיס**: המפתחות נגזרים
ממנה, ואנגלית חייבת לכסות אותה במלואה. זה בדיוק הכלל שכבר אוכף `productHelpRegistry` —
„topic that exists only in translation" נדחה שם (`src/lib/assistant/productHelpRegistry.spec.ts:144`).

```ts
// src/lib/i18n/dictionaries/he.ts — the BASE. Keys are born here.
export const he = {
  common: { save: 'שמירה', cancel: 'ביטול', delete: 'מחיקה', close: 'סגירה', search: 'חיפוש' },
  nav:    { dashboard: 'מרכז בקרה', orders: 'הזמנות', suppliers: 'ספקים', settings: 'הגדרות' },
  settings: {
    title: 'הגדרות מערכת',
    languageTitle: 'שפת הממשק',
    languageHint: 'השפה נבחרת אוטומטית לפי הדפדפן. בחירה כאן גוברת ונשמרת לחשבון שלך.',
    languageHe: 'עברית',
    languageEn: 'English',
  },
} as const;

export type Dictionary = typeof he;
```

```ts
// src/lib/i18n/dictionaries/en.ts — must satisfy Dictionary. A missing key fails typecheck.
import type { Dictionary } from './he';

export const en: Dictionary = {
  common: { save: 'Save', cancel: 'Cancel', delete: 'Delete', close: 'Close', search: 'Search' },
  nav:    { dashboard: 'Control centre', orders: 'Orders', suppliers: 'Suppliers', settings: 'Settings' },
  settings: {
    title: 'System settings',
    languageTitle: 'Interface language',
    languageHint: 'The language follows your browser. A choice here overrides it and is saved to your account.',
    languageHe: 'עברית',
    languageEn: 'English',
  },
};
```

> **זה השומר החזק ביותר בתוכנית, והוא חינם:** ‏`en: Dictionary` הופך מפתח חסר או מיותר
> ל**כשל `npm run typecheck`**, לא ל-`undefined` בזמן ריצה. אין צורך בסקריפט שמשווה מילונים.

**‏`t.ts` — הרזולוציה, עם interpolation מינימלי ו-`Intl.PluralRules`:**

```ts
import { INTL_LOCALE, type Locale } from './locale';
import type { Dictionary } from './dictionaries/he';

/** `settings.languageTitle` → the string. Dot paths only; no arrays, no nesting beyond two. */
export type TKey = {
  [N in keyof Dictionary]: `${N & string}.${keyof Dictionary[N] & string}`
}[keyof Dictionary];

/**
 * ponytail: interpolation is `{name}` and nothing else — no ICU, no formatters inside the
 * string. A message that needs a formatted number receives it already formatted, so money and
 * dates keep going through src/lib/format.ts and stay visible to check:money.
 */
export function translate(
  dict: Dictionary, key: TKey, vars?: Record<string, string | number>,
): string {
  const [ns, k] = key.split('.') as [keyof Dictionary, string];
  const raw = (dict[ns] as Record<string, string>)?.[k];
  if (raw == null) return key; // the key itself, never an empty cell — a miss must be visible
  return vars ? raw.replace(/\{(\w+)\}/g, (m, name) => String(vars[name] ?? m)) : raw;
}

const pluralRules = new Map<Locale, Intl.PluralRules>();
/** Hebrew has one/two/many/other; English has one/other. Intl knows both — we do not hardcode. */
export function pluralCategory(locale: Locale, n: number): Intl.LDMLPluralRule {
  let rules = pluralRules.get(locale);
  if (!rules) { rules = new Intl.PluralRules(INTL_LOCALE[locale]); pluralRules.set(locale, rules); }
  return rules.select(n);
}
```

**הטסט (`t.spec.ts`) חייב לכסות:** מפתח קיים · מפתח חסר מחזיר את המפתח עצמו · interpolation ·
משתנה חסר משאיר את ה-placeholder · `pluralCategory('he', 2) === 'two'` מול
`pluralCategory('en', 2) === 'other'`.

**קומיט:** `feat(i18n): typed he/en dictionaries with a compile-time completeness contract`

---

### משימה 0.3 — השומר `check:i18n` עם מונה מוצמד

**קבצים:**
- ליצור: `scripts/check-i18n.ts` · `scripts/i18n-baseline.json`
- לשנות: `package.json` — ‏`scripts["check:i18n"]`, והוספה לשרשרת `verify`

**למה מונה מוצמד ולא איסור מוחלט:** החילוץ יימשך פאזה שלמה. שומר שאוסר עברית לגמרי יהיה
אדום לאורך כל פאזה 2 ולכן ייכובה. מונה מוצמד שיורד — הדפוס של `scripts/check-exemption-pin.ts`
שכבר בריפו — **נכשל גם כשהמספר עולה וגם כשהוא יורד בלי לעדכן את הקו**, ולכן הוא ratchet אמיתי.

**מה הסקריפט עושה:**
1. סורק `src/**/*.{ts,tsx}`.
2. **מדלג** על `src/lib/i18n/dictionaries/**` (שם עברית היא התוכן), על `*.spec.*`
   (פאזה 2 מטפלת בהם בנפרד), ועל `src/portal/i18n.ts` (מילון קיים).
3. **מסיר הערות** — `//…` ו-`/*…*/` — כי הערות בריפו הזה נכתבות באנגלית, ועברית בהערה אינה
   מחרוזת ממשק. בלי הצעד הזה השומר סופר תיעוד ומאבד אמון.
4. סופר שורות שנותרו עם `[֐-׿]`, **פר קובץ**.
5. משווה ל-`i18n-baseline.json`. עלייה בקובץ = כישלון. ירידה בלי עדכון הקו = כישלון עם ההוראה
   `node scripts/check-i18n.ts --update`.

**שלב 1 — הדגמת הכישלון (לא unit test — מדידה):**
```bash
node scripts/check-i18n.ts
```
צפוי: `PASS — 205 files, 7843 Hebrew lines, baseline matches`

```bash
printf "\nconst planted = 'מחרוזת שנשתלה';\n" >> src/lib/format.ts && node scripts/check-i18n.ts
```
צפוי: `FAIL src/lib/format.ts: baseline 156 → found 157`

```bash
git checkout src/lib/format.ts && node scripts/check-i18n.ts
```
צפוי: חזרה ל-`PASS`.

**את שלושת הפלטים האלה מדביקים ב-`GATES.md` כראיית שער פאזה 0.** שומר שלא הודגם שהוא נכשל
אינו שומר.

**שלב 2 — לחבר ל-`verify`** ב-`package.json`, בשרשרת אחרי `check:typography`:
```
"check:i18n": "node scripts/check-i18n.ts",
```

**קומיט:** `chore(i18n): pin the Hebrew-literal count per file so extraction can only ratchet down`

### 🚦 שער פאזה 0
- [ ] `npm run verify` ירוק
- [ ] שלושת פלטי הדגמת הכישלון מודבקים ב-`GATES.md`
- [ ] `npm run typecheck` **נכשל** כשמוחקים מפתח מ-`en.ts` — הדגמה מודבקת
- [ ] אפס שינוי ויזואלי: המערכת עדיין עברית בלבד

---

## פאזה 1 — המנוע: זיהוי, החלפה, שמירה

### משימה 1.1 — מיגרציה: `profiles.locale`

**קבצים:**
- ליצור: `supabase/migrations/0212_profile_locale.sql` (‏**לאמת את המספר הפנוי** —
  `PROGRESS.md` מציין ש-`main` וייצור על `0211`)

```sql
-- 0212 — the interface language a person chose, per person and not per organization.
--
-- Per PERSON, deliberately: one tenant can employ a Hebrew-speaking buyer and an
-- English-speaking accountant, and a language forced from the org would be wrong for one of
-- them every time. `null` is not "Hebrew" — it is "never chose", which lets the browser keep
-- deciding. Collapsing those two states would freeze the first detection forever.
--
-- No new enum: the product's role enum is embedded in 77 RLS policies and this file must not
-- teach anyone that adding enums here is normal. A check constraint carries the same contract
-- and is alterable.
alter table profiles
  add column locale text
    constraint profiles_locale_supported check (locale is null or locale in ('he', 'en'));

comment on column profiles.locale is
  'Interface language explicitly chosen by this person. NULL = never chose; the client detects.';
```

**‏RLS — לבדוק, לא להניח:** ‏`profiles` כבר תחת חוקת `org_id = auth_org()`. נדרש לוודא
שקיימת מדיניות שמאפשרת ל**משתמש לעדכן את השורה של עצמו** בעמודה הזאת ובה בלבד. אם אין —
מוסיפים מדיניות ממוקדת `using (id = auth.uid())` על `update`, ולא מרחיבים הרשאה קיימת.
**זו הכרעת אבטחה: שינוי שפה אינו עילה לאפשר עדכון שדות אחרים בפרופיל.**

**אימות המיגרציה מקומית** (הדפוס של `Invoke-SqlTest`):
```bash
docker exec supabase_db_supplyflow-p0 psql -U postgres -d postgres -c "\d profiles"
```
צפוי: העמודה `locale` וה-constraint מופיעים.

**קומיט:** `feat(db): store the interface language a person chose on their profile`

---

### משימה 1.2 — ‏`LocaleProvider` + טעינה עצלה של המילון

**קבצים:**
- ליצור: `src/lib/i18n/LocaleProvider.tsx` · `src/lib/i18n/localeProvider.spec.tsx`
- לשנות: `src/main.tsx` (עטיפת האפליקציה) · `src/App.tsx`

**החוזה:**

```tsx
// ponytail: the active dictionary is imported statically for `he` and dynamically for `en`.
// Hebrew is the base and every cold start needs it; shipping ~150KB of English JSON to a
// Hebrew-only tenant is the cost this split exists to refuse. Ceiling: at a third language,
// split both sides dynamically and drop the static import.
const dictionaries = {
  he: () => import('./dictionaries/he').then((m) => m.he),
  en: () => import('./dictionaries/en').then((m) => m.en),
};

export function useT(): { t: (key: TKey, vars?: Record<string, string | number>) => string;
                          locale: Locale; setLocale: (next: Locale) => Promise<void> }
```

**מה ה-provider חייב לעשות, וכל אחד מהם הוא טסט:**

1. **הרזולוציה בעלייה** — `resolveLocale({ stored: localStorage.getItem('inplace.locale'),
   query: window.location.search, browser: navigator.language })`.
2. **סנכרון `documentElement`** — בדיוק כמו `PortalApp.tsx:69-70`:
   `document.documentElement.lang = locale;` ו-`document.documentElement.dir = dirFor(locale);`
3. **אחרי שה-auth נפתר** — אם `profiles.locale` אינו `null` והוא שונה מהמצב הנוכחי, הוא **גובר**
   וגם נכתב ל-localStorage. פרופיל הוא הבחירה שהאדם עשה; localStorage הוא רק העותק המהיר.
4. **‏`setLocale`** — כותב לשלושה מקומות בסדר הזה: state, ‏localStorage, ואז `profiles`.
   **כישלון הכתיבה ל-DB אינו מבטל את החלפת המסך** — הוא מציג toast „השפה הוחלפה אך לא נשמרה
   לחשבון". החלפה שנראית כאילו לא קרתה גרועה יותר מהחלפה שלא נשמרה.
5. **מצב טעינה** — עד שהמילון נטען, מרנדרים את המסך בעברית (המילון הסטטי). ‏**אין מסך ריק
   ואין flash של מפתחות.**

**טסטים נדרשים ב-`localeProvider.spec.tsx`:**
- `navigator.language = 'en-US'`, ‏localStorage ריק, אין פרופיל ⇒ `documentElement.dir === 'ltr'`
- ‏localStorage `'he'` מול `navigator.language = 'en-US'` ⇒ עברית ו-`dir === 'rtl'`
- ‏`setLocale('en')` ⇒ `dir` מתחלף, ‏localStorage מתעדכן, ו-`profiles` נכתב פעם אחת
- כתיבה ל-DB שנכשלת ⇒ המסך עדיין באנגלית, ו-toast הופיע

**קומיט:** `feat(i18n): a locale provider that detects, swaps direction, and persists the choice`

---

### משימה 1.3 — שלוש נקודות ה-HTML ופלאגין הגופן

**קבצים:** `index.html:2` · `operator.html:2` · `portal.html:2` · `vite.config.ts:20`

**המלכודת, במפורש:** ‏`vite.config.ts:20` מריץ
`.replace('<html lang="he" dir="rtl">', '<html lang="he" dir="rtl" data-font-mode="almoni">')`.
**זו החלפת מחרוזת מדויקת.** שינוי ה-HTML בלי לעדכן אותה מפיל את `build:almoni` **בשקט** —
הבנייה מצליחה והמצב פשוט לא מוחל.

**ההכרעה:** ‏`index.html` **נשאר** `lang="he" dir="rtl"` — הוא ערך התחלה, וה-provider מחליף
אותו לפני הצביעה הראשונה. לא נוגעים בפלאגין. אם בכל זאת משנים — משנים את שני הצדדים באותו
קומיט ומריצים `npm run build:almoni` כראיה.

**מה כן משתנה ב-`index.html`:** ‏`preload` לגופן. שורה 18 מקדמת רק את
`NotoSansHebrew-Hebrew.woff2`; משתמש אנגלי מקבל FOUT על כל טקסט. להוסיף preload מותנה
ל-`NotoSansHebrew-Latin.woff2`, או — ‏**הפתרון העצל והנכון** — לקדם את שתיהן. שתי התת-קבוצות
יחד קטנות מ-woff2 בודד לא-מפוצל, וזה חוסך ענף לוגיקה ב-HTML סטטי.

**קומיט:** `perf(i18n): preload the Latin subset so an English session does not flash unstyled`

---

### משימה 1.4 — מתג השפה ב-`/settings`

**קבצים:** לשנות `src/pages/Settings.tsx` — קבוצה חדשה מתחת ל-„הגדרות עסק" (`:488`)

```tsx
<section className="card">
  <h2 className="section-title flex items-center gap-2">
    <Languages size={ICON.md} aria-hidden="true" /> {t('settings.languageTitle')}
  </h2>
  <p className="text-ink-muted">{t('settings.languageHint')}</p>
  <label className="label" htmlFor="ui-locale">{t('settings.languageTitle')}</label>
  <select id="ui-locale" className="input" value={locale}
          onChange={(e) => setLocale(e.target.value as Locale)}>
    <option value="he">{t('settings.languageHe')}</option>
    <option value="en">{t('settings.languageEn')}</option>
  </select>
</section>
```

**‏`<select>` ולא מתג דו-מצבי:** ‏`SupplierCommunicationCard.tsx:127-130` כבר משתמש בדיוק בדפוס
הזה לשפת ההודעות לספק. שני מנגנוני בחירת שפה במוצר אחד שנראים שונה הם בלבול, לא גיוון.
**שים לב שאלה שני דברים שונים** — שפת הממשק שלי מול השפה שבה אנחנו כותבים לספק — והתווית
חייבת להבהיר את זה בשתי השפות.

**ראיה נדרשת:** צילום מסך `/settings` בעברית, החלפה, וצילום שני באנגלית — **אחרי refresh**,
כדי להוכיח שמירה ולא רק state.

**קומיט:** `feat(settings): let a person choose the interface language`

### 🚦 שער פאזה 1
- [ ] `npm run check` ירוק
- [ ] צילומי לפני/אחרי של `/settings` **אחרי refresh**
- [ ] ‏`document.documentElement.dir === 'ltr'` נמדד בדפדפן, לא הונח
- [ ] דפדפן באנגלית, חשבון חדש ⇒ הממשק עולה LTR **לפני** כניסה (מסך `/login`)
- [ ] המיגרציה הוחלה מקומית ו-`\d profiles` מראה את העמודה
- [ ] ‏`npm run build:almoni` עדיין מייצר `data-font-mode="almoni"` ב-HTML

---

## פאזה 2 — חילוץ המחרוזות (הפאזה הכבדה)

**~5,900 אתרי תרגום ב-205 קבצים.** זו הפאזה שקובעת אם התוכנית מסתיימת. שלושה כללים:

1. **לפי משטח, לא לפי קובץ.** מסך שלם עובר יחד — כולל המודלים שלו וההודעות שלו — כדי שכל
   קומיט יהיה בר-צילום. חילוץ „כל הכפתורים בכל המערכת" מייצר commit שאי אפשר לאמת.
2. **מפתחות באנגלית, סמנטיים, לא תרגום.** ‏`orders.emptyTitle` ולא `orders.noOrdersYet` ולא
   `orders.אין_הזמנות`. המפתח מתאר **מיקום ותפקיד**, לא תוכן — תוכן משתנה, תפקיד לא.
3. **בסוף כל משטח: `node scripts/check-i18n.ts --update` + קומיט.** הקו יורד, ולא יעלה שוב.

### הסדר, לפי צפיפות נמדדת ותלות

| # | משטח | קבצים · שורות עברית | למה כאן |
|---|---|---|---|
| 2.1 | **‏`src/lib/status.ts`** | ‏1 · 156 | מפה טהורה. אין JSX. הכי זול, ומזין את כל המסכים |
| 2.2 | **‏`src/lib/errors.ts`** | ‏1 · 161 | `toHebrewError()` הופך ל-`toLocalizedError(locale, …)`. חוזה אחד |
| 2.3 | **‏`src/components/ui.tsx` + `Layout.tsx`** | ‏2 · 348 | פרימיטיבים וניווט — כל מסך יורש מהם |
| 2.4 | **‏Dashboard** | ‏1 · 192 | סעיף 12: המסך שהמנהל רואה ראשון |
| 2.5 | **הזמנות · קבלה · ספקים** | ‏~6 · ~530 | ליבת התפעול |
| 2.6 | **חשבוניות · תשלומים · בנק · חשבוניות מרכזות** | ‏~8 · ~570 | המשטח הכספי. **כאן `check:money` רגיש** |
| 2.7 | **סקירת מסמכים ו-OCR** | ‏~5 · ~420 | ‏`model.ts` (182) הוא מפת שדות, לא JSX |
| 2.8 | **הגדרות · הקמה · מנוי · הזמנת עובד** | ‏~5 · ~530 | |
| 2.9 | **דוחות · מלאי · מחירונים · התראות** | ‏~6 · ~430 | |
| 2.10 | ~~**‏`src/operator/**`**~~ | ‏~4 · ~250 | ‏**`ABANDON:` — הוכרע 27.08.2026** |
| 2.11 | **העוזר (`src/lib/assistant/**`)** | ‏~4 · ~200 | ‏`PRODUCT_HELP_LOCALES` כבר תומך ב-`en`; זה מילוי תוכן |

**‏2.10 — הוכרע: מדלגים.** קונסולת התפעול (`src/operator/**`) היא **פנימית**, משמשת את צוות
InPlace בלבד ואינה נמכרת ללקוח, ולכן תרגומה אינו משרת אף משתמש קצה.

**מה המבצע חייב לעשות בפועל, אחרת ה„דילוג" הופך לחוב שקט:**
1. לרשום ב-`GATES.md`: ‏`ABANDON: src/operator/** — internal console, no external user (owner, 27.08.2026)`
2. להשאיר את שורות ה-baseline של הקבצים האלה ב-`scripts/i18n-baseline.json` **גבוהות במכוון**,
   עם המפתח `"__reason"` בקובץ שמסביר למה — כדי ששער פאזה 2 („‏0 בכל קובץ") לא ייקרא ככישלון.
3. לרשום סעיף ב-`docs/DEBT-REGISTER.md`: מה לא תורגם, למה, ומה הצעד הזול הבא אם יום אחד
   הקונסולה תיפתח לגורם חיצוני.

**דילוג שאינו רשום בשלושת המקומות האלה אינו דילוג — הוא שכחה.**

### דפוס החילוץ למשטח יחיד — הדוגמה: `src/lib/status.ts`

**שלב 1 — טסט שנכשל:**
```ts
it('gives every status a label in both languages', () => {
  for (const locale of LOCALES) {
    expect(statusLabel(locale, 'INVOICE_STATUS', 'approved')).not.toBe('');
    expect(statusLabel(locale, 'INVOICE_STATUS', 'approved')).not.toMatch(/^[A-Z_]+\./);
  }
});
it('keeps the tone with the label — a tone is a claim, not a hue', () => {
  expect(statusMeta('INVOICE_STATUS', 'approved').tone).toBe('done');
});
```

**שלב 2 — הפרדת המבנה מהטקסט.** ‏`status.ts` מחזיק היום `{ label, tone }` יחד. אחרי החילוץ
**ה-tone נשאר ב-`status.ts`** (הוא טענה עסקית, לא תרגום) ו**ה-label עובר למילון** תחת
`status.invoice_approved`. ‏`statusMeta()` מחזיר tone; ‏`statusLabel(locale, …)` מחזיר טקסט.

> זו ההפרדה החשובה ביותר בפאזה כולה. ‏`status.ts` מתעד ש„הגוון הוא **טענה**, לא צבע" —
> טענה אינה מתורגמת, היא נכונה בכל שפה. ערבוב השניים בתוך המילון היה מאבד את החוזה הזה.

**שלב 3 — להריץ:** `npx vitest run src/lib/status.spec.ts`
**שלב 4 — לעדכן קו:** `node scripts/check-i18n.ts --update` ⇒ צפוי `src/lib/status.ts: 156 → 0`
**שלב 5 — קומיט:** `refactor(i18n): move status labels into the dictionary, keep tone in code`

### הטסטים — 151 קבצים · 3,974 שורות עברית

**זו עלות אמיתית שאסור לגלות באמצע.** טסטים כמו
`expect(screen.getByText('שמור'))` נשברים ברגע שהמחרוזת עוברת למילון.

**ההכרעה: הטסטים ממשיכים לחפש עברית.** ‏`LocaleProvider` בסביבת הטסט נעול ל-`he` בברירת מחדל
(`src/test/setup.ts`), ולכן `getByText('שמור')` ממשיך לעבוד ללא שינוי. ‏**רק הטסטים שבודקים
את התנהגות ה-i18n עצמה** מרנדרים ב-`en`.

**למה כך ולא `getByText(t('common.save'))`:** טסט שקורא את המילון מאבד את כוח האבחון שלו —
הוא עובר גם כשהמילון פגום, כי שני הצדדים קוראים מאותו מקור. ‏**טסט שמחפש טקסט מילולי הוא
הטענה החזקה יותר**, ולכן הוא נשאר.

**‏ponytail: אפס שינוי ב-151 קובצי הטסט.** מוסיפים כ-6 טסטים חדשים שמרנדרים באנגלית עבור
המסכים הקריטיים (‏dashboard, ‏orders, ‏invoice detail, ‏settings, ‏login) ומאמתים ש**אין מפתח
גולמי על המסך** — `expect(container.textContent).not.toMatch(/\b[a-z]+\.[a-zA-Z]+\b/)` על
אזורי טקסט, ושה-`dir` הוא `ltr`.

### 🚦 שער פאזה 2
- [ ] `node scripts/check-i18n.ts` מדווח **0** בכל קובץ שאינו במילון ואינו `ABANDON:`
- [ ] `npm run verify` ירוק — **כל 151 קובצי הטסט הקיימים עוברים ללא שינוי**
- [ ] צילום מסך זוגי (he/en) לכל משטח 2.4–2.9 — **לא צילום אחד לכל המערכת**
- [ ] אפס מפתח גולמי (`orders.emptyTitle`) גלוי בצילומים
- [ ] כל `ABANDON:` רשום ב-`GATES.md` עם סיבה

---

## פאזה 3 — פורמט וכיוון

### משימה 3.1 — פורמטרים תלויי-לוקאל

**קובץ:** `src/lib/format.ts` — **הקובץ הרגיש ביותר בתוכנית.**

**מה משתנה ומה לא — ההפרדה קריטית:**

| | מה קורה | למה |
|---|---|---|
| **מטבע** | ‏**לא משתנה.** ‏`ILS` נשאר `ILS` בשתי השפות | ‏`OPEN-DECISIONS #14`: „הכסף של המוצר הוא שקלים". אנגלית אינה מטבע. ‏`0108:228-233` **דוחה אקטיבית** מסמך שאינו שקלי |
| **סמל ומיקום** | ‏`Intl` עם `en-US` ייתן `₪1,650.60`; עם `he-IL` ייתן `1,650.60 ₪` | זה **נכון** — זו קונבנציית השפה, לא שינוי מטבע |
| **תאריך** | משתנה: `he-IL` ⇒ `27.08.2026` · `en-GB` ⇒ `27/08/2026` | |
| **‏`BUSINESS_TIME_ZONE`** | ‏**לא משתנה.** ‏`Asia/Jerusalem` נשאר | היום העסקי הוא של העסק, לא של הצופה. אזור זמן פר-ארגון הוא פער #5 ומחוץ להיקף |
| **תחילת שבוע** | ‏**לא משתנה** — ראשון | `delivery_days` ‏`0=Sunday` ב-DB (`0001:69`). שינוי תצוגה בלי הנתון הוא שקר |
| **מספרים** | משתנה: מפריד אלפים לפי לוקאל | |

**המלכודת ב-`check:money`:** השומר מעריך **לפי שורה** (`scripts/check-money.ts:88-90`).
`src/portal/i18n.ts:113-115` הוא `Intl.NumberFormat` שני וחי עם `currency: 'ILS'` **שהשומר
אינו רואה** — כי הוא נשבר לשורות. הפורמטרים החדשים חייבים להיכתב **בשורה אחת**, אחרת
נוצר חור שני באותו שומר.

**המימוש — מפה של פורמטרים, לא בנייה מחדש בכל קריאה:**
```ts
// ponytail: two frozen tables, not a factory. Intl formatter construction is the expensive
// part; with exactly two locales, building both at module load costs less than one lazy
// branch evaluated on every cell of a 500-row table.
const ilsExactBy: Record<Locale, Intl.NumberFormat> = { he: new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', minimumFractionDigits: 2 }), en: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'ILS', minimumFractionDigits: 2 }) };
```

**‏`fmtMoneyExact()` מקבל `locale` כארגומנט ראשון.** ‏~200 אתרי קריאה יעברו codemod. ‏**חלופה
עצלה שנשקלה ונדחתה:** משתנה מודול `currentLocale` שהפרובידר מעדכן — פחות שינויים, אבל state
גלובלי נסתר שהופך את הפורמטרים לתלויי-סדר בטסטים. ‏**ארגומנט מפורש. זה כסף.**

**טסט:** אותו סכום, שני לוקאלים, שתי תוצאות צפויות מדויקות — כולל אישור ש**הספרות זהות**
ורק המפריד והמיקום שונים.

**קומיט:** `refactor(format): thread the locale through the formatters, keep the shekel`

### משימה 3.2 — יחידות מידה באנגלית

**קובץ:** `src/lib/format.ts` — ‏`UNIT_FORMS` (45 ערכים עבריים)

**הבעיה, כפי שהיא קיימת היום:** ‏`products.unit` שומר **עברית ב-DB** (`0001:92`,
`default 'יח''`). ‏`portal/i18n.ts:125` נופל ל-`unit?.trim()` הגולמי, ולכן **הפורטל האנגלי
מציג היום `ק״ג`.** זה כשל קיים ומתועד ב-`RESEARCH-INTERNATIONAL-READINESS §1`.

**הפתרון העצל:** ‏`UNIT_FORMS` כבר ממפה 45 איותים ל-**צורה קנונית** (`'יח'`, `"יח'"`, `'יחידה'`
כולם ⇒ `יחידה`). מוסיפים טבלה שנייה מהצורה הקנונית לאנגלית:
```ts
const UNIT_EN: Record<string, { one: string; other: string }> = {
  'יחידה': { one: 'unit', other: 'units' },
  'ארגז':  { one: 'box',  other: 'boxes' },
  'ק״ג':   { one: 'kg',   other: 'kg' },
  'ל׳':    { one: 'L',    other: 'L' },
};
```
**‏`Intl.PluralRules('en')` בוחר בין `one` ל-`other`.** יחידה שאין לה מיפוי **מוצגת גולמית
ומבודדת ב-`bidiIsolate()`** — לא ריקה, לא מנוחשת. יחידה חסרה היא נתון של הארגון, לא באג.

**‏אין מיגרציית נתונים.** הערכים בעברית ב-DB **נשארים** — הם המפתח, לא התצוגה. שינויָם היה
נוגע ב-`name_match_key`, ב-`invoice_unit_factor` (`0099:424-437`) ובהתאמה המשולשת. ‏**היקף
שלא נדרש כאן.**

**קומיט:** `fix(i18n): give units an English form instead of showing Hebrew to English readers`

### משימה 3.3 — תיקוני LTR ב-CSS

**קובץ:** `src/index.css` — **שלוש נקודות בלבד. אין יותר.**

1. **בלוק ה-safe-area, `:748-802`, שישה כללים.** ממפה `env(safe-area-inset-right)` ל-
   `padding-inline-start` — נכון ב-RTL, **הפוך ב-LTR**. התיקון:
   ```css
   /* safe-area insets are PHYSICAL; the logical property they feed flips with dir, so the
      mapping must flip with it too. Two `:dir()` blocks, not a media query. */
   :dir(rtl) .phone-shell { padding-inline-start: max(1rem, env(safe-area-inset-right)); }
   :dir(ltr) .phone-shell { padding-inline-start: max(1rem, env(safe-area-inset-left)); }
   ```
2. **‏`drawer-enter`, `:1091-1096`.** ההערה בקוד קובעת במפורש: „An LTR host would need the sign
   flipped — there is none". **עכשיו יש.** מוסיפים `@keyframes drawer-enter-ltr` עם `-100%`
   ובוחרים ב-`:dir()`. **ההערה חייבת להתעדכן באותו קומיט** — הערה שמצהירה על מצב שכבר אינו
   נכון גרועה מהיעדר הערה.
3. **‏`.tech-id`, `:1074` — לא נוגעים.** ‏`direction: ltr` על מזהה מכונה נכון בכל שפה.

**‏`.num`, `:1065-1070` — לא נוגעים.** ‏`check:typography` אוכף במפורש שהכלל לא יקבל
`direction: ltr` או monospace (`scripts/check-typography.ts:41-44`). ‏**כל ניסיון „לתקן" אותו
לאנגלית מפיל את השער.**

**‏`DESIGN.md` מתעדכן באותו קומיט** — חוקת הפרויקט מחייבת את השניים יחד.

**הראיה:** צילום מובייל אמיתי ב-LTR עם notch — לא דסקטופ מוקטן. ‏`resize_window` עם
`preset: 'mobile'`, ‏reload, צילום.

**קומיט:** `fix(css): flip the safe-area and drawer mappings for an LTR session`

### 🚦 שער פאזה 3
- [ ] `npm run verify` ירוק — כולל `check:money` ו-`check:typography`
- [ ] טסט פורמט: אותו סכום, שני לוקאלים, שתי תוצאות מדויקות
- [ ] צילום מובייל LTR עם safe-area נכון בשני הקצוות
- [ ] המגירה נכנסת מהצד הנכון ב-LTR — **וידאו או שני פריימים**, לא צילום סטטי
- [ ] `DESIGN.md` עודכן יחד עם `index.css`

---

## פאזה 4 — נתוני העסק (מחלקה 2 בלבד)

> **תזכורת ההיקף מ-§3:** מתורגמים רק **אוצר המילים של הארגון**. שם ספק, שם מוצר גולמי, טקסט
> OCR, ‏`audit_logs` ו-`comments` — **לא**, לעולם. הם זהות הצד השני וראיה.

### משימה 4.1 — ההכרעה נרשמת לפני שנוגעים בסכימה

**קובץ:** `docs/OPEN-DECISIONS.md` — רשומה חדשה, **הכרעת בעלים 27.08.2026**.

| שאלה | ההכרעה |
|---|---|
| האם שמות מוצרים מתורגמים אוטומטית? | **לא. לעולם.** ברירת המחדל היא נאמנות למסמך הייבוא |
| איך בכל זאת מתרגמים? | **אופציה שנדלקת מפורשות ברמת הארגון**, ואז הצעה ואישור **פר-פריט** |
| מה קורה כשאין תרגום מאושר? | מוצג השם העברי כפי שהוא. **לא מפתח, לא `—`, לא ניחוש** |
| האם ההזמנה לספק מושפעת? | **לא.** משטחי הספק ממשיכים ב-`products.name` הגולמי (`format.ts`) |
| שם שנשמר בסדר ויזואלי? | ‏**`blocked`** — לא מוצע ולא מתורגם, בדיוק כמו ב-`productDisplayName.ts` |

**‏קומיט לפני קוד:** `docs(decisions): catalogue translation is opt-in, proposed and approved per item`

### משימה 4.2 — מיגרציה: תרגומי קטלוג

**קובץ:** ליצור `supabase/migrations/0213_catalogue_translations.sql`

**ההכרעה במבנה — עמודה, לא טבלת תרגומים:**
```sql
-- Two languages, and the product's base language is not going away. A general
-- `translations(entity, entity_id, locale, field, value)` table would be the textbook answer
-- and the wrong one here: it costs a join on every catalogue read, an RLS policy of its own,
-- and a soft-delete story — to hold at most one extra string per row. ponytail: a nullable
-- column per translated field. Ceiling: at a third language this stops scaling and becomes
-- the general table; that is the point to pay for it, not before.
--
-- Nothing is backfilled and nothing is proposed by this migration — the same stance 0149 took
-- for display_name, and for the same reason: a name nobody approved must not become the name
-- twenty-five screens show.
alter table categories add column name_en text
  constraint categories_name_en_shape check (name_en is null or length(btrim(name_en)) > 0);
alter table products   add column display_name_en text
  constraint products_display_name_en_shape
    check (display_name_en is null or (btrim(display_name_en) <> '' and length(display_name_en) <= 120));

comment on column products.display_name_en is
  'English name a person APPROVED for this product. NULL = no approved translation, and the '
  'Hebrew name renders unchanged — never a guess, never a machine result nobody signed off. '
  'Written only through set_product_display_name_en. NEVER reaches the supplier: supplier-facing '
  'surfaces use products.name (the raw name), and adding a language did not add an exception.';

-- The write door, mirroring set_product_display_name (0149) rather than inventing a second
-- shape: owner/office only, a reason is mandatory, one row at a time, audited.
create or replace function public.set_product_display_name_en(
  p_product_id uuid,
  p_display_name_en text,
  p_reason text
) returns void
language plpgsql security definer set search_path = public as $$ ... $$;
```

**‏`length(btrim(…)) > 0` ו-`<= 120`** הם בדיוק הדפוס של `products_display_name_shape` הקיים
(`0149:73-75`) — מחרוזת ריקה **בלתי ניתנת לייצוג**, ולכן `null` הוא האיות היחיד ל„אין תרגום".

**‏הדגל שמפעיל את האופציה — ברמת הארגון:**
```sql
-- The option the owner asked for, stored where the org's other switches already live rather
-- than as a new table. Default false: translation is off until someone turns it on.
-- `organizations.settings` is the documented extension point (RESEARCH §1) and role_labels is
-- the precedent for a per-tenant override living there.
-- settings->>'catalogue_translation_enabled'
```

**‏A5 ושומר החריגים:** ‏`set_product_display_name_en` הוא `SECURITY DEFINER` ונוגע ב-`products`
ו-`audit_logs` — **בדיוק המצב שבו A5 יורה** (`0149:57`). המיגרציה חייבת להריץ מחדש את
`private.scope_enforcement_violations()` ולהצמיד את החריג, אחרת `check:exemptions` נכשל.
‏`DEBT §9` מתעד שהצעד הזה תלוי בזיכרון המחבר — **כאן הוא כתוב.**

**‏RLS:** אין מדיניות חדשה; העמודות יורשות את חוקת `org_id = auth_org()`. **לוודא, לא להניח:**
```bash
docker exec supabase_db_supplyflow-p0 psql -U postgres -d postgres -c "select polname, polcmd from pg_policy where polrelid = 'products'::regclass;"
```

**קומיט:** `feat(db): an approved English catalogue name, written only through an audited door`

### משימה 4.3 — הרזולוציה בתצוגה

**קובץ:** לשנות `src/lib/format.ts` — ‏`productLabel()`

```ts
/**
 * Adds ONE rung to the chain this function already documented: an APPROVED English name, when
 * the reader is reading English and someone approved one. Everything the original comment said
 * about who must NOT call this is unchanged — SUPPLIER-FACING, AUDIT and the proposal screen
 * still take products.name, and adding a language did not add an exception to that.
 *
 * The fallback is the Hebrew label, NOT the key and NOT an em dash: switching language must
 * never blank out a catalogue. A product with no approved translation reads in English exactly
 * as it reads in Hebrew — the name stays what the import document said it was.
 */
export function productLabel(
  locale: Locale,
  product: { name: string; display_name: string | null; display_name_en: string | null },
): string {
  const hebrew = product.display_name?.trim() || product.name;
  if (locale === 'en') return product.display_name_en?.trim() || hebrew;
  return hebrew;
}
```

**הטסטים — ארבעה, וכל אחד מהם טענה שונה:**
- אנגלית + תרגום מאושר ⇒ התרגום
- אנגלית **בלי** תרגום ⇒ **בדיוק מה שעברית מציגה**. לא מפתח, לא `—`, לא ריק
- עברית + תרגום קיים ⇒ **עברית**. תרגום אינו „טוב יותר"
- ‏`share.ts` ו-`orderImage.ts` (המשטחים לספק) **אינם קוראים לפונקציה כלל** — טסט שסורק
  את הקבצים ומאשר זאת, כי זו טענה שקל לשבור בעריכה תמימה

### משימה 4.4 — האופציה שנדלקת, וההצעה שנשאלת

**קבצים:** `src/pages/Settings.tsx` · `src/pages/Inventory.tsx` · מסך הקטגוריות

**‏(א) המתג, ב-`/settings`, כבוי כברירת מחדל:**
„תרגום שמות מוצרים לאנגלית" · תת-כותרת: „כבוי — שמות המוצרים מוצגים כפי שהתקבלו במסמך
הייבוא. הדלקה מאפשרת לאשר שם אנגלי לכל מוצר בנפרד." ‏owner בלבד.

**‏(ב) השאלה, במסך המוצר, רק כשהמתג דלוק והלוקאל `en`:**
שורה שקטה מתחת לשם — „למוצר הזה אין שם באנגלית. להוסיף?" — ולחיצה פותחת שדה טקסט **עם
השם העברי מוצג לצדו**, כדי שהמאשר יראה את מה שהוא מתרגם. שמירה עוברת דרך
`set_product_display_name_en` עם סיבה, ונרשמת ב-`audit_logs`.

**‏(ג) שם שנשמר בסדר ויזואלי — לא נשאלת עליו שאלה בכלל.** במקום זה מוצגת ההפניה הקיימת
לתיקון השם (`product-name-repair`). ‏**לתרגם שם הפוך פירושו לייצר אנגלית תקינה לחלוטין
שמתארת מוצר אחר** — הכשל הגרוע ביותר בפאזה הזאת, כי הוא בלתי-נראה לקורא האנגלי.

**‏ponytail — מה במפורש לא נבנה:** אין מסך ניהול תרגומים, אין ייצוא/ייבוא CSV, אין תור
אישור המוני, אין תרגום אצווה. שדה טקסט על מסך קיים. מסך ייעודי נבנה **רק** אם לקוח אמיתי
מבקש לתרגם קטלוג שלם, ואז זה ייבוא XLSX דרך `importSheet.ts` הקיים.

**קומיט:** `feat(catalogue): offer an English name per product, off until the org turns it on`

### משימה 4.5 — הצעת תרגום ממוכנת: **מחוץ להיקף, והסיבה אינה טכנית**

תוספת טבעית ל-4.4 היא כפתור „הצע תרגום" שממלא את השדה מראש, בדיוק כפי ש-
`productDisplayName.ts` מציע שם עברי קנוני. ‏**היא אינה בתוכנית הזאת, ולא מפני שהיא קשה.**

- ספק ה-LLM היחיד בריפו הוא של העוזר — ‏`AI_ASSISTANT_PROVIDER = openai`
  (`supabase/functions/assistant/config.ts:120`).
- ‏**‏`DEBT §63`: שורת ה-`dpa` בממשל הספק היא `MISSING` בהכרעת בעלים, וההיתר פג ב-31.12.2026.**
  הדגלים דלוקים **לארגון הבעלים בלבד**.
- שליחת קטלוג של דייר לספק חיצוני היא **הרחבת גבול אמון**, לא תכונה. ‏`config.ts:55` קובע
  במפורש שהוספת ספק היא הכרעה, לא knob.

**המצב הנכון:** ‏4.4 נשלחת בלי תלות בספק חיצוני — משתמש מקליד, נשמר, נרשם. ‏4.5 היא
increment על **אותו מסך ואותו door**, וייבנה כשה-DPA ייסגר. **נרשם ב-`DEBT-REGISTER.md`.**

### 🚦 שער פאזה 4
- [ ] ההכרעה רשומה ב-`OPEN-DECISIONS.md` **לפני** המיגרציה
- [ ] מיגרציה הוחלה מקומית · `\d products` מראה עמודה + constraint
- [ ] ‏`check:exemptions` ירוק — ‏A5 והצמדת החריג בוצעו באותה מיגרציה
- [ ] סוויטות SQL ו-preflight ירוקות
- [ ] **המתג כבוי:** מסך מוצר באנגלית מציג **בדיוק** את השם העברי — צילום זוגי he/en
- [ ] **המתג דלוק, בלי תרגום:** מוצג השם העברי + השאלה — צילום
- [ ] **המתג דלוק, עם תרגום מאושר:** מוצג האנגלי — צילום + שורת `audit_logs` תואמת
- [ ] **שם בסדר ויזואלי:** לא נשאלת שאלה, מוצגת הפניה לתיקון — צילום
- [ ] הזמנה לספק מציגה את `products.name` הגולמי — **צילום של ההזמנה עצמה**

---

## פאזה 5 — ראיות, תיעוד ורולאאוט

### משימה 5.1 — השער המלא

**‏`CLAUDE.md` אוסר להריץ `npm run quality` מקומית כחלק מעבודה רגילה.** השער רץ ב-CI:

```bash
gh workflow run quality-gate.yml --ref claude/add-english-language-system-f43d1e
```
```bash
gh run watch
```

**‏`DEBT §65` — המלכודת שחייבים להכיר:** שני ה-workflows מופעלים על
`pull_request: branches: [main]` **בלבד**. ‏PR שהבסיס שלו אינו `main` מקבל **אפס בדיקות
וזה נראה כמו הצלחה**. אם ה-PR הזה יושב על ענף אחר — מריצים `workflow_dispatch` במפורש
וקושרים לתוצאה בהערה על ה-PR, כי `workflow_dispatch` אינו מופיע ברשימת ה-checks.

**מה השער יריץ, לפי סיווג הנתיבים:** ‏`build` (‏bundle השתנה) · `verify` (‏src, ‏tests,
scripts, ‏migrations) · `sql` (שתי מיגרציות) · `browser` (‏`0212` נוגעת ב-`profiles`,
טבלה שה-auth של ה-scope קורא — **ולכן browser כן קם**).

**מה השער **לא** יריץ, ואסור להציג אותו כאילו כן:** `check-p0-security.ps1`,
‏`check-p0-upgrade.ps1`, ‏`Invoke-PriceListEdgeSmoke`, ‏`Invoke-OcrEdgeSmoke`,
`check-p4-integrated-journey.cjs`. **תיק ירוק אינו טענה שהם עברו.**

### משימה 5.2 — ראיות ויזואליות

**‏`CLAUDE.md`: „אין 'בוצע' בלי אימות ויזואלי."** ‏HTTP 200 אינו ראיה.

מטריצת הצילומים — **‏`he` ו-`en` לכל שורה**:

| מסך | דסקטופ | מובייל | למה |
|---|---|---|---|
| `/login` | ✓ | ✓ | לפני auth — מוכיח זיהוי מהדפדפן |
| `/` (מרכז בקרה) | ✓ | ✓ | סעיף 12; ‏recharts דורש scroll-into-view + `reducedMotion: 'reduce'` |
| `/orders` · `/suppliers` | ✓ | | טבלאות — יישור המספרים ב-LTR |
| `/invoices/:id` | ✓ | | המשטח הכספי; ‏₪ בשני הצדדים |
| `/settings` | ✓ | ✓ | המתג עצמו, **אחרי refresh** |
| מגירת המובייל | | ✓ | כיוון הכניסה |

**מדידה, לא הרשמה:** הדשבורד לוקח כמה שניות להתייצב — צילום מוקדם תופס spinner
(`PROGRESS.md`, מדידה מ-26.08). ממתינים ל-`networkidle` ואז לצילום.

### משימה 5.3 — תיעוד

| קובץ | מה נכתב |
|---|---|
| `docs/PROGRESS.md` | מה נבנה, מה **נמדד**, מה `ABANDON:` |
| `docs/DEBT-REGISTER.md` | **שלושה** סעיפים: (א) קונסולת התפעול לא תורגמה — ‏`ABANDON:` בהכרעת בעלים; (ב) ‏4.5 הצעת תרגום ממוכנת חסומה על `DEBT §63`; (ג) כל משטח Edge/מייל שנמצא ב-5.5 ולא נסגר |
| `docs/OPEN-DECISIONS.md` | הכרעת התרגום מ-4.1 |
| `DESIGN.md` | חוק ה-`:dir()` והמצב הדו-כיווני |
| `CLAUDE.md` | שורה אחת: „‏`<html dir>` דינמי — ‏`LocaleProvider` הוא הבעלים" — הקובץ אומר היום „פעם אחת" וזה **יפסיק להיות נכון** |
| `GATES.md` | ‏ledger השערים, כולל כל `ABANDON:` |

### משימה 5.4 — רולאאוט לייצור

**האיחוד של שתי שורות במטריצת `CLAUDE.md`: Frontend + Migration.**

| שלב | מה | ראיה |
|---|---|---|
| 1 | גיבוי schema/data/roles | קובץ גיבוי + חותמת |
| 2 | dry-run ב-`begin/rollback` ל-`0212` ו-`0253` | פלט מודבק |
| 3 | ‏apply forward-only דרך `db-query.ps1 -ProjectRef` | |
| 4 | **שורת `schema_migrations` ידנית לכל מיגרציה** | ‏`max(version)` = `0253` · ‏208 שורות |
| 5 | postflight + ספירות דיירים לפני/אחרי | ‏3 ארגונים, ‏8 פרופילים — **לא זזו** |
| 6 | build עם env ייצור, בלי `.env.local` | סריקת סודות: ‏`anon` בלבד |
| 7 | פריסת Pages + התאמת hashes בשני הדומיינים | ‏**בלולאת polling** — הכתובת הקנונית מגישה build קודם עוד דקה |
| 8 | smoke חי מחובר, `he` ו-`en` | דשבורד עם נתונים אמיתיים בשתי השפות |

**‏`db-query.ps1` אינו כותב ל-`schema_migrations`.** שלב 4 ידני. דילוג עליו משאיר את הייצור
בסטייה שקטה מהריפו.

**מה **לא** נוגעים בו, במפורש:** ‏OCR worker (`worker/ocr/**` לא השתנה, שתי גרסאות חוזי
ה-gateway לא זזו ⇒ אין פער חוזה, אין פריסה מחדש) · ‏Edge Functions (אלא אם 5.5 מוצאת אחרת).

### משימה 5.5 — הבדיקה שאסור לדלג עליה: מיילים ו-Edge

**זו נקודה שלא נמדדה בתכנון הזה ולכן אינה טענה — היא משימה.**

```bash
grep -rlE "[א-ת]" supabase/functions/
```

**ההכרעה מראש:** מיילים לספק כבר נשלטים על ידי `CommunicationLocale` הקיים
(`src/lib/orderEmail.ts:11`) — **אלה שפת הספק, לא שפת המשתמש, ואין לחבר ביניהן.** מייל
הזמנת עובד (`send-invite`) הוא **כן** שפת המשתמש, ואם הוא עברי-קשיח זהו פער.
**נמדד ⇒ נסגר או נרשם ב-`DEBT` — לא נשכח.**

### 🚦 שער פאזה 5 (השער הסופי)
- [ ] `quality-gate.yml` ירוק **על ה-SHA הזה** — לא ריצה היסטורית
- [ ] מטריצת הצילומים מלאה, `he` ו-`en`
- [ ] שישה קובצי התיעוד עודכנו
- [ ] רולאאוט לייצור בוצע ואומת חי, כולל שורות ה-ledger
- [ ] כל `ABANDON:` רשום עם סיבה

---

## §5 — הערכת מאמץ ונקודות הכישלון

| פאזה | היקף יחסי | הסיכון האמיתי |
|---|---|---|
| 0 | קטן | אין. תשתית טהורה |
| 1 | קטן-בינוני | ‏`vite.config.ts:20` נשבר **בשקט**; ‏flash של עברית לפני auth |
| **2** | **‏~70% מהתוכנית** | **נטישה באמצע.** מונה ה-baseline קיים בדיוק בשביל זה |
| 3 | בינוני | ‏`check:money` העיוור לרב-שורות; ‏`.num` שמפיל את `check:typography` |
| 4 | בינוני | הכרעה עסקית שנעשית בשקט בקוד במקום ב-`OPEN-DECISIONS.md` |
| 5 | קטן | ‏`DEBT §65` — ‏PR בלי בסיס `main` מחזיר „ירוק" מזויף |

**שלוש נקודות הכישלון, לפי סבירות:**

1. **פאזה 2 נעצרת ב-60%.** התוצאה גרועה משתי החלופות: ממשק חצי-מתורגם. ‏**המיטיגציה היא
   הסדר** — כל משטח מסתיים בקומיט צביל וב-baseline מעודכן, ולכן עצירה משאירה מצב עקבי ולא
   הריסות. ‏ומשטח שנזנח **נרשם `ABANDON:`**, לא נשכח.
2. **הטסטים.** ‏3,974 שורות עברית ב-151 קבצים. ‏**נפתר מראש** בהחלטה לנעול את סביבת הטסט
   ל-`he` — אפס שינוי בטסטים קיימים. אם ההחלטה תתהפך באמצע, זו פאזה שלמה נוספת.
3. **‏„זה עובד" בלי מדידה.** מסך שנראה אנגלי עדיין יכול להציג `ק״ג`, ₪ בצד הלא נכון, או מגירה
   שנכנסת הפוך. ‏**מטריצת הצילומים היא השער, לא נספח.**

## §6 — מה התוכנית הזאת אינה עושה

- **אינה פותחת שוק.** מטבע, אזור זמן, מס, כתובת, טלפון וחשבונית מובנית נשארים ישראליים
  (`RESEARCH-INTERNATIONAL-READINESS §3`, פערים 3, 5, 6, 8, 9, 4).
- **אינה מתרגמת ראיות.** ‏OCR, ‏`audit_logs`, ‏`comments`, מסמכי מקור — כפי שנשמרו.
- **אינה מתרגמת שם מוצר אוטומטית.** ברירת המחדל היא נאמנות למסמך הייבוא; תרגום הוא אופציה
  שנדלקת, מוצעת ומאושרת פר-פריט (הכרעת בעלים 27.08.2026).
- **אינה שולחת קטלוג של דייר לספק LLM.** ‏4.5 מחוץ להיקף כל עוד `DEBT §63` פתוח.
- **אינה מתרגמת את קונסולת התפעול** (`ABANDON:`, הכרעת בעלים 27.08.2026).
- **אינה משנה את שם הספק** בשום משטח, ובוודאי לא במה שמגיע אליו.
- **אינה מוסיפה שפה שלישית.** המבנה מרחיב, אבל ערבית או רוסית מחייבות דקדוק, מילון והכרעה
  חדשה — לא „עוד קובץ".
- **אינה נוגעת ב-OCR worker.**
