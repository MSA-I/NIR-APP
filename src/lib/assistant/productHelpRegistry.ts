import {
  type AssistantRole,
  type ProductHelpEntry,
  ProductHelpEntrySchema,
  type ProductHelpLocale,
} from './contracts.ts';
import { APP_ROUTE_POLICY, type AppRoutePolicyKey } from '../routePolicy.ts';
import { routePresentationTitle } from '../routePresentation.ts';

/**
 * The authoritative product-help registry (OPEN-DECISIONS #192).
 *
 * #192 rules that a dedicated, versioned registry in the repository is the SINGLE source of truth
 * for "how do I do X in this product", and that a prompt, a design document or an on-screen
 * sentence is not a source on its own. The reason is narrow and practical: those drift, and a
 * drifted instruction about the product is indistinguishable from a correct one until somebody
 * follows it and lands on a screen that does not do what they were told.
 *
 * Three properties make that enforceable rather than aspirational:
 *
 *  1. `route` is a KEY of `APP_ROUTE_POLICY`, never a free path. A screen that is removed, or
 *     whose Guard roles move, breaks this file instead of shipping a dead instruction.
 *  2. `roles` may only NARROW the route's own audience. An entry that describes an action only
 *     `owner`/`office` can perform says so, even when the screen itself is open to everyone —
 *     but no entry can ever hand a role a screen the Guard withholds.
 *  3. Every step was written from code that was read: the page component, its canonical
 *     description in `routePresentation.ts`, or a decision row. An instruction that could not be
 *     sourced was left out rather than guessed.
 *
 * There is NO fallback. A question the registry does not answer is answered `no_capability` by
 * the caller — never by the nearest entry, and never by the model's own knowledge of the product.
 */

export const PRODUCT_HELP_REGISTRY_VERSION = 'product-help-v1';

/**
 * The product is Hebrew-first (`<html dir="rtl">`, Hebrew UI labels), so Hebrew is the original
 * and any other locale is a translation of it. A topic that exists only in translation is a
 * missing locale, and the guard says so — that is #192's "locale חסר".
 */
export const PRODUCT_HELP_BASE_LOCALE: ProductHelpLocale = 'he';

/** At most this many entries answer one question. Help is a pointer, not a manual dump. */
export const PRODUCT_HELP_MATCH_LIMIT = 3;

/* ============================================================================
 * The entries
 * ==========================================================================*/

const ENTRIES: readonly ProductHelpEntry[] = [
  {
    id: 'see_business_state_now',
    version: 1,
    owner: 'product',
    locale: 'he',
    // The management snapshot is computed server-side for owner/office only and returns NULL for
    // every other role (docs/ASSISTANT.md §7), so the entry narrows a route the Guard opens wider.
    roles: ['owner', 'office'],
    route: 'dashboard',
    label: 'מרכז הבקרה — מצב העסק עכשיו',
    steps: [
      'פותחים את מרכז הבקרה: מה דורש טיפול עכשיו, מה עלול לעלות כסף ומה מצב העסק ברגע זה.',
      'לתור המלא של כל מה שדורש טיפול ממשיכים למסך ההתראות — מרכז הבקרה מסכם ומפנה אליו.',
    ],
    source: 'src/lib/routePresentation.ts · src/pages/Alerts.tsx · docs/ASSISTANT.md §7',
    updated_at: '2026-08-24',
  },
  {
    id: 'see_what_needs_attention',
    version: 1,
    owner: 'product',
    locale: 'he',
    roles: ['owner', 'office'],
    route: 'alerts',
    label: 'התור של מה שדורש טיפול',
    steps: [
      'נכנסים למסך ההתראות — התור המלא של מה שדורש טיפול, מהדחוף ועד המידע.',
      'כשקיימות כמה רמות חומרה, מסננים בשורת הצ׳יפים: דחוף, לטיפול או מידע.',
      'לוחצים על שורה כדי לעבור ישירות למסך שבו מטפלים בה.',
      'כשהסריקה חלקית מוצגת הודעה בראש המסך: הממצאים שנטענו מוצגים, ואי אפשר לקבוע שהכול תקין.',
      'בתחתית המסך רשום מה אינו נבדק — מלאי נמוך וחריגה מתקציב — ושמועדי פירעון נבדקים רק על דרישות תשלום שהוזן להן תאריך.',
    ],
    source: 'src/pages/Alerts.tsx',
    updated_at: '2026-08-24',
  },
  {
    id: 'compare_supplier_prices',
    version: 1,
    owner: 'product',
    locale: 'he',
    roles: ['owner', 'office'],
    route: 'prices',
    label: 'השוואת מחירי ספקים',
    steps: [
      'נכנסים למסך המחירונים ומחפשים מוצר, או בוחרים ספק במסנן הספקים.',
      'מסמנים "רק התייקרויות" כדי להשאיר בטבלה רק מחירים שעלו מול המחיר הקודם.',
      'בכרטיס ההשוואה של המוצר מוצג הספק הזול ביותר והפער מהמחיר הבא אחריו; מוצר שאין לו הצעה זמינה מספק פעיל מוצג ככזה במפורש.',
      'בתפריט השורה נפתחות היסטוריית המחירים ו"מי עדכן", ולבעלים ולמנהל הרכש גם עדכון מחיר.',
    ],
    source: 'src/pages/PriceLists.tsx',
    updated_at: '2026-08-24',
  },
  {
    id: 'upload_price_list',
    version: 1,
    owner: 'product',
    locale: 'he',
    roles: ['owner', 'office'],
    route: 'prices',
    label: 'העלאת מחירון ספק',
    steps: [
      'במסך המחירונים לוחצים "העלאת מחירון" כדי לקלוט מחירון של ספק אחד.',
      'לקובץ Excel שמכיל כמה ספקים יחד משתמשים ב"ייבוא רב־ספקים מ־Excel", עוברים על התצוגה המקדימה ואז "אישור וייבוא".',
      'העלאת מחירונים זמינה לבעלים ולמנהל הרכש בלבד.',
    ],
    source: 'src/pages/PriceLists.tsx',
    updated_at: '2026-08-24',
  },
  {
    id: 'manage_product_catalogue',
    version: 1,
    owner: 'product',
    locale: 'he',
    roles: ['owner', 'office'],
    route: 'products',
    label: 'ניהול קטלוג המוצרים',
    steps: [
      'במסך המוצרים מנהלים את הקטלוג שממנו נבנות ההזמנות; מסננים לפי קטגוריה ומחפשים בשורת החיפוש.',
      'לוחצים "מוצר חדש" להוספה ידנית, או "העלאת מחירון ספק" — מחירון יוצר את המוצרים ואת המחירים יחד.',
      'בתצוגות "שמות לאישור" ו"תיקון ממקור" מאשרים או מתקנים שם תצוגה למוצר, אחד־אחד.',
    ],
    source: 'src/pages/Products.tsx',
    updated_at: '2026-08-24',
  },
  {
    id: 'find_products_below_minimum',
    version: 1,
    owner: 'product',
    locale: 'he',
    roles: ['owner', 'office'],
    route: 'inventory',
    label: 'מוצרים מתחת למינימום',
    steps: [
      'במסך המלאי לוחצים על הכרטיסון "מתחת למינימום" כדי לסנן את הטבלה לאותם מוצרים.',
      'מוצר שלא נספר מוצג כמקף — יתרה לא ידועה, לא אפס.',
      'תחת "איך המספרים כאן מחושבים" מוסבר שהצריכה היומית נמדדת מהספירה האחרונה ועד 30 יום, ושצפי האזילה מתבסס על היתרה שנספרה בלבד.',
      'הצעת הרכש שמוצגת בטבלה אינה יוצרת הזמנה.',
    ],
    source: 'src/pages/Inventory.tsx',
    updated_at: '2026-08-24',
  },
  {
    id: 'check_invoice_status',
    version: 1,
    owner: 'product',
    locale: 'he',
    roles: ['owner', 'office', 'accountant'],
    route: 'invoices',
    label: 'מצב חשבונית ספק',
    steps: [
      'במסך החשבוניות מסננים לפי שלב הבדיקה בשורת הצ׳יפים שמעל הטבלה.',
      'המסנן "צורך בטיפול" מציג חשד לכפילות או חשבוניות ללא הזמנת רכש.',
      'מסנן סטטוס התשלום מציג חשבוניות פתוחות לתשלום, ומסנן החודש מגביל לחודש אחד.',
      'לוחצים על שורה כדי לפתוח את החשבונית עצמה ולבדוק אותה מול ההזמנה ומול הקבלה.',
    ],
    source: 'src/pages/Invoices.tsx · src/lib/routePresentation.ts',
    updated_at: '2026-08-24',
  },
  {
    id: 'resolve_an_exception',
    version: 1,
    owner: 'product',
    locale: 'he',
    // `/exceptions` is open to all three roles, but only owner/office may transition one
    // (src/pages/Exceptions.tsx: `canWrite`), and these steps describe the transition.
    roles: ['owner', 'office'],
    route: 'exceptions',
    label: 'סגירת חריג',
    steps: [
      'נכנסים למסך החריגים ומסננים לפי סטטוס, סוג וחומרה; ברירת המחדל היא "פתוחים ובטיפול".',
      'לוחצים על שורה כדי לפתוח את פרטי החריג ואת הקישורים לחשבונית, לדרישת התשלום, לתנועת הבנק או לספק.',
      'כותבים הערת טיפול — היא תנאי לסגירה — ואז "סימון בטיפול", "דחייה (לא רלוונטי)" או "סימון כטופל".',
      'חריגים נפתחים אוטומטית מבדיקות חשבוניות, תשלומים והתאמות בנק; אין פתיחה ידנית מהמסך.',
    ],
    source: 'src/pages/Exceptions.tsx',
    updated_at: '2026-08-24',
  },
  {
    id: 'track_a_credit',
    version: 1,
    owner: 'product',
    locale: 'he',
    // Same narrowing as the exceptions entry: accountant sees /credits, but
    // `transition_credit_request` refuses the role outright, so the lifecycle steps are not theirs.
    roles: ['owner', 'office'],
    route: 'credits',
    label: 'מעקב אחרי דרישת זיכוי',
    steps: [
      'נכנסים למסך הזיכויים; ברירת המחדל מציגה זיכויים פעילים, ואפשר לעבור ל"הכל" או לסנן לפי חודש.',
      'לוחצים על שורה כדי לראות את הסיבה, הסכום, הסטטוס והחשבונית שאליה הזיכוי קשור.',
      'מקדמים את הזיכוי בשלבים: "נדרש מהספק", "הזיכוי התקבל", "קוזז בתשלום" ואז "סגירה".',
      'זיכוי על חוסר בכמות, על פריט פגום ועל החזרה נפתח אוטומטית בקבלת הסחורה; מחיר שגוי או חיוב כפול נפתחים מתוך החשבונית של הספק.',
    ],
    source: 'src/pages/Credits.tsx',
    updated_at: '2026-08-24',
  },
  {
    id: 'open_a_payment_request',
    version: 1,
    owner: 'product',
    locale: 'he',
    roles: ['owner', 'office'],
    route: 'paymentRequests',
    label: 'פתיחת דרישת תשלום',
    steps: [
      'במסך דרישות התשלום לוחצים "דרישה חדשה".',
      'דרישת תשלום נפתחת מול ספק שיש לו חשבוניות פתוחות ונקשרת אליהן.',
      'משם "שליחה לאישור", ואחרי האישור "העברה לגורם המבצע".',
      'למעקב מסננים לפי דרישות פעילות ולפי מועד יעד: יעד היום, באיחור, או עד 7 ימים כולל איחורים.',
    ],
    source: 'src/pages/PaymentRequests.tsx',
    updated_at: '2026-08-24',
  },
  {
    id: 'see_recorded_payments',
    version: 1,
    owner: 'product',
    locale: 'he',
    roles: ['owner', 'accountant'],
    route: 'payments',
    label: 'תשלומים שכבר נרשמו',
    steps: [
      'במסך התשלומים רואים את יומן התשלומים שבוצעו.',
      'לכל תשלום מוצגים האסמכתה שלו והחשבוניות שהוא כיסה.',
    ],
    source: 'src/lib/routePresentation.ts · src/pages/Payments.tsx',
    updated_at: '2026-08-24',
  },
  {
    id: 'reconcile_bank_statement',
    version: 1,
    owner: 'product',
    locale: 'he',
    roles: ['owner', 'accountant'],
    route: 'bank',
    label: 'התאמת תדפיס בנק',
    steps: [
      'במסך התאמות הבנק לוחצים "ייבוא תדפיס בנק" ובוחרים קובץ XLSX בתבנית הקנונית — אין מיפוי עמודות ואין ניחוש מבנה.',
      'מסננים "דורשות התאמה" כדי לראות רק תנועות שעדיין לא הותאמו.',
      'פותחים תנועה ומאשרים אחת מהצעות ההתאמה, או מבצעים התאמה ידנית בפיצול בין חשבוניות פתוחות.',
      'הסרת התאמה דורשת סיבה, מחזירה את התנועה לטיפול ואינה מבטלת את התשלום ואת הקצאותיו.',
    ],
    source: 'src/pages/Bank.tsx',
    updated_at: '2026-08-24',
  },
  {
    id: 'export_expense_summary',
    version: 1,
    owner: 'product',
    locale: 'he',
    roles: ['owner', 'accountant'],
    route: 'expenses',
    label: 'ריכוז הוצאות לייצוא ולהדפסה',
    steps: [
      'במסך ריכוז ההוצאות בוחרים טווח: צ׳יפ של טווח מהיר, או תאריכי "מ־" ו"עד" ידניים.',
      'ההוצאות מרוכזות לפי ספק ולפי קטגוריה בטווח שנבחר.',
      'לוחצים "ייצוא Excel" להורדת הריכוז, או "הדפסה / PDF" לשמירה.',
      'טווח תאריכים הפוך, או טווח שאין בו חשבוניות, חוסם את הייצוא — והסיבה מוצגת על הכפתור עצמו.',
    ],
    source: 'src/pages/Expenses.tsx',
    updated_at: '2026-08-24',
  },
  {
    id: 'compare_supplier_performance',
    version: 1,
    owner: 'product',
    locale: 'he',
    roles: ['owner', 'office'],
    route: 'analytics',
    label: 'השוואת ביצועי ספקים',
    steps: [
      'במסך ביצועי הספקים כל הספקים הפעילים מוצגים בטבלה אחת: זמן אספקה, עמידה בזמנים, שינויי מחיר, חריגים פתוחים וזיכויים פתוחים.',
      'ממיינים לפי העמודה שמעניינת, ומחפשים ספק בשורת החיפוש.',
      'עמידה בזמנים מוצגת רק לספק שיש לו 5 קבלות לפחות; מתחת לזה אין מדגם, ולכן אין אחוז.',
      'מדד שלא נמדד מוצג כמקף ולא כאפס.',
    ],
    source: 'src/pages/Analytics.tsx',
    updated_at: '2026-08-24',
  },
  {
    id: 'check_product_purchases',
    version: 1,
    owner: 'product',
    locale: 'he',
    roles: ['owner', 'office', 'accountant'],
    route: 'productReport',
    label: 'כמה נרכש מכל מוצר',
    steps: [
      'במסך סיכום רכישות המוצרים בודקים את הכמות ואת העלות שנרכשו בכל מוצר בטווח שנבחר.',
      'לצד כל מספר מוצגים שלושת מקורות הנתונים שמאחוריו.',
      'בסיכום מופיעות הזמנות שאינן טיוטה בטווח התאריכים, עם מה שהתקבל ומה שחויב מולן.',
    ],
    source: 'src/lib/routePresentation.ts · src/pages/ProductPurchaseSummary.tsx',
    updated_at: '2026-08-24',
  },

  /* --------------------------------------------------------------------------
   * English translations.
   *
   * The UI itself is Hebrew, so a translated step still quotes the Hebrew control it tells you to
   * press — an English sentence naming an English button that does not exist would be exactly the
   * kind of unfollowable instruction #192 exists to prevent. Route and roles are pinned to the
   * Hebrew original by the guard.
   * ------------------------------------------------------------------------*/
  {
    id: 'see_what_needs_attention',
    version: 1,
    owner: 'product',
    locale: 'en',
    roles: ['owner', 'office'],
    route: 'alerts',
    label: 'The queue of what needs attention',
    steps: [
      'Open the alerts screen — the full queue of everything that needs handling, urgent first.',
      'When several severities are present, filter with the chips: דחוף, לטיפול or מידע.',
      'Click a row to go straight to the screen where that item is handled.',
      'A partial scan is announced at the top: what was found is shown, and nothing can be declared clear.',
      'The foot of the screen names what is NOT checked — low stock and budget overrun — and that due dates are checked only on payment requests that were given a date.',
    ],
    source: 'src/pages/Alerts.tsx',
    updated_at: '2026-08-24',
  },
  {
    id: 'compare_supplier_prices',
    version: 1,
    owner: 'product',
    locale: 'en',
    roles: ['owner', 'office'],
    route: 'prices',
    label: 'Comparing supplier prices',
    steps: [
      'Open the price-lists screen and search for a product, or pick a supplier in the supplier filter.',
      'Tick "רק התייקרויות" to leave only prices that rose against their previous price.',
      'The product comparison card names the cheapest supplier and the gap to the next price; a product with no available offer from an active supplier says so explicitly.',
      'The row menu opens price history and "מי עדכן", and — for owner and procurement manager — a price update.',
    ],
    source: 'src/pages/PriceLists.tsx',
    updated_at: '2026-08-24',
  },
  {
    id: 'check_invoice_status',
    version: 1,
    owner: 'product',
    locale: 'en',
    roles: ['owner', 'office', 'accountant'],
    route: 'invoices',
    label: 'The state of a supplier invoice',
    steps: [
      'On the invoices screen, filter by review stage using the chips above the table.',
      'The attention filter shows suspected duplicates or invoices with no purchase order.',
      'The payment-status filter shows invoices still open for payment, and the month filter narrows to one month.',
      'Click a row to open the invoice itself and check it against its order and its receipt.',
    ],
    source: 'src/pages/Invoices.tsx · src/lib/routePresentation.ts',
    updated_at: '2026-08-24',
  },
];

/**
 * How a question reaches an entry.
 *
 * Deliberately a separate table rather than a field on the entry: `ProductHelpEntrySchema` is
 * strict and is the contract two runtimes share, and lookup hints are a property of this registry,
 * not of the entry shape. Keyed by entry id, so a topic's Hebrew and English rows are reachable by
 * the same set of phrases; the caller picks which locale it wants back.
 *
 * Matching is whole-phrase containment and nothing else — no stemming, no edit distance, no
 * scoring. A near-miss returns nothing, because #192 forbids a fallback guess and a wrong product
 * instruction costs more than an honest "no answer".
 */
export const PRODUCT_HELP_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  see_business_state_now: ['מרכז הבקרה', 'מצב העסק', 'דשבורד', 'תמונת מצב', 'dashboard'],
  see_what_needs_attention: ['דורש טיפול', 'התראות', 'מסך ההתראות', 'מה דחוף', 'alerts'],
  compare_supplier_prices: ['השוואת מחירים', 'מחירי ספקים', 'התייקרות', 'התייקרויות', 'מחירונים', 'price list'],
  upload_price_list: ['העלאת מחירון', 'לייבא מחירון', 'ייבוא מחירון', 'מחירון חדש', 'upload a price list'],
  manage_product_catalogue: ['קטלוג המוצרים', 'מוצר חדש', 'מסך המוצרים', 'product catalogue'],
  find_products_below_minimum: ['מתחת למינימום', 'מלאי נמוך', 'יתרת מלאי', 'ספירת מלאי', 'low stock'],
  check_invoice_status: ['מצב חשבונית', 'סטטוס חשבונית', 'מסך החשבוניות', 'חשבוניות כפולות', 'invoice status'],
  resolve_an_exception: ['לסגור חריג', 'סגירת חריג', 'חריגים', 'מסך החריגים', 'exception'],
  track_a_credit: ['דרישת זיכוי', 'זיכויים', 'מעקב זיכוי', 'לקזז זיכוי', 'credit request'],
  open_a_payment_request: ['דרישת תשלום', 'דרישה חדשה', 'לשלוח לאישור', 'payment request'],
  see_recorded_payments: ['תשלומים שבוצעו', 'מסך התשלומים', 'אסמכתה', 'payments screen'],
  reconcile_bank_statement: ['התאמת בנק', 'התאמות בנק', 'תדפיס בנק', 'ייבוא בנק', 'bank reconciliation'],
  export_expense_summary: ['ריכוז הוצאות', 'ייצוא הוצאות', 'דוח הוצאות', 'expense summary'],
  compare_supplier_performance: ['ביצועי ספקים', 'עמידה בזמנים', 'זמן אספקה', 'supplier performance'],
  check_product_purchases: ['כמה נרכש', 'סיכום רכישות', 'רכישות מוצרים', 'product purchases'],
};

/* ============================================================================
 * The guard (#192)
 * ==========================================================================*/

interface GuardRouteEntry {
  readonly path: string;
  readonly roles: readonly string[];
}

export interface ProductHelpRegistrySnapshot {
  entries: readonly unknown[];
  keywords: Readonly<Record<string, readonly string[]>>;
  /**
   * Defaults to the real `APP_ROUTE_POLICY`. Injectable ONLY so the guard's own failure paths can
   * be falsified: every live policy key still has a canonical screen name — which is the property
   * the check defends — so proving the check fires needs a route the catalogue never named.
   */
  routes?: Readonly<Record<string, GuardRouteEntry>>;
  /** Defaults to `routePresentationTitle`, for the same reason. */
  screenName?: (path: string) => string | null;
}

/**
 * Every structural defect in a registry snapshot, as stable machine-readable codes.
 *
 * An empty array is the only healthy result. The codes are strings rather than an enum so a
 * failure names the entry and the offending value in one line of test output.
 */
export function productHelpRegistryDefects(
  snapshot: ProductHelpRegistrySnapshot,
): readonly string[] {
  const routes = snapshot.routes ?? (APP_ROUTE_POLICY as Readonly<Record<string, GuardRouteEntry>>);
  const screenName = snapshot.screenName ?? routePresentationTitle;
  const defects: string[] = [];
  const parsed: ProductHelpEntry[] = [];
  const seen = new Set<string>();

  snapshot.entries.forEach((raw, index) => {
    const result = ProductHelpEntrySchema.safeParse(raw);
    if (!result.success) {
      for (const issue of result.error.issues) {
        defects.push(`entry[${index}]:schema:${issue.path.join('.') || '_'}:${issue.message}`);
      }
      return;
    }
    const entry = result.data;
    parsed.push(entry);

    const localeId = `${entry.locale}:${entry.id}`;
    if (seen.has(localeId)) defects.push(`entry[${index}]:duplicate_locale_id:${localeId}`);
    seen.add(localeId);

    const route = routes[entry.route];
    if (!route) {
      defects.push(`entry[${index}]:route_not_in_policy:${entry.route}`);
      return;
    }
    // routePresentation.ts is the second half of #192's comparison. A route whose path no longer
    // has a canonical screen name is a screen that was removed or renamed out from under this file.
    if (screenName(route.path) === null) {
      defects.push(`entry[${index}]:route_has_no_screen_name:${route.path}`);
    }
    for (const role of entry.roles) {
      if (!route.roles.includes(role)) {
        // An entry may narrow a route's audience. Widening it would grant a permission from a
        // help file, which is exactly the drift #192 names.
        defects.push(`entry[${index}]:roles_exceed_route:${role}`);
      }
    }
  });

  const byId = new Map<string, ProductHelpEntry[]>();
  for (const entry of parsed) {
    byId.set(entry.id, [...(byId.get(entry.id) ?? []), entry]);
  }
  for (const [id, entries] of byId) {
    const base = entries.find((entry) => entry.locale === PRODUCT_HELP_BASE_LOCALE);
    if (!base) {
      defects.push(`id:${id}:missing_base_locale`);
      continue;
    }
    for (const entry of entries) {
      if (entry.route !== base.route) defects.push(`id:${id}:locale_disagrees_on_route`);
      const sameRoles = entry.roles.length === base.roles.length &&
        entry.roles.every((role) => base.roles.includes(role));
      if (!sameRoles) defects.push(`id:${id}:locale_disagrees_on_roles`);
    }
    const keywords = snapshot.keywords[id] ?? [];
    if (keywords.length === 0) defects.push(`id:${id}:no_keywords`);
    for (const keyword of keywords) {
      if (normalizeForMatch(keyword).trim() === '') defects.push(`id:${id}:blank_keyword`);
    }
  }
  for (const id of Object.keys(snapshot.keywords)) {
    if (!byId.has(id)) defects.push(`keywords:${id}:unknown_entry`);
  }
  return [...new Set(defects)];
}

/* ============================================================================
 * Lookup
 * ==========================================================================*/

/**
 * Word-boundary containment on a padded, punctuation-free rendering of the text.
 *
 * Padding is what makes it whole-phrase rather than substring: " מחירון " matches "איך מעלים
 * מחירון" and does not match a longer word that merely contains those letters.
 */
const NON_WORD = /[^\p{L}\p{N}]+/gu;

function normalizeForMatch(value: string): string {
  return ` ${value.normalize('NFKC').toLocaleLowerCase('he').replace(NON_WORD, ' ').trim()} `;
}

/** The canonical in-app path of the screen an entry describes. */
export function productHelpPath(entry: ProductHelpEntry): string {
  return APP_ROUTE_POLICY[entry.route as AppRoutePolicyKey].path;
}

/** Everything this role may be shown, in one locale. Never widened by anything the caller sends. */
export function productHelpForRole(
  role: AssistantRole,
  locale: ProductHelpLocale = PRODUCT_HELP_BASE_LOCALE,
): readonly ProductHelpEntry[] {
  return PRODUCT_HELP_ENTRIES.filter((entry) =>
    entry.locale === locale && entry.roles.includes(role));
}

/**
 * The entries that answer this question for this role — or nothing.
 *
 * "Nothing" is a real answer here and the caller must report it as `no_capability`. There is no
 * nearest-entry, no default entry and no partial credit: an instruction about the product that
 * was not written for the question is worse than an admission that the question is unanswered.
 */
export function findProductHelp(
  query: string,
  role: AssistantRole,
  options: { id?: string; locale?: ProductHelpLocale } = {},
): readonly ProductHelpEntry[] {
  const visible = productHelpForRole(role, options.locale ?? PRODUCT_HELP_BASE_LOCALE);
  if (options.id !== undefined) {
    // An explicit id is an exact lookup, not a hint: it either resolves for this role or it does not.
    return visible.filter((entry) => entry.id === options.id);
  }
  const haystack = normalizeForMatch(query);
  if (haystack.trim() === '') return [];

  const matched: { entry: ProductHelpEntry; weight: number }[] = [];
  for (const entry of visible) {
    let weight = 0;
    for (const needle of [...(PRODUCT_HELP_KEYWORDS[entry.id] ?? []), entry.label]) {
      const normalized = normalizeForMatch(needle);
      if (normalized.trim() !== '' && haystack.includes(normalized)) {
        weight = Math.max(weight, normalized.trim().length);
      }
    }
    if (weight > 0) matched.push({ entry, weight });
  }
  // Longest matched phrase first — a longer phrase is a more specific question — then by id, so
  // the same question always produces the same list in the same order.
  matched.sort((a, b) => b.weight - a.weight || a.entry.id.localeCompare(b.entry.id));
  return matched.slice(0, PRODUCT_HELP_MATCH_LIMIT).map((match) => match.entry);
}

/* ============================================================================
 * Load-time enforcement
 * ==========================================================================*/

const LOAD_DEFECTS = productHelpRegistryDefects({ entries: ENTRIES, keywords: PRODUCT_HELP_KEYWORDS });
if (LOAD_DEFECTS.length > 0) {
  // Failing at import is the point. A registry that drifted away from the route policy must not
  // be servable at all: the alternative is an Edge function cheerfully answering with an
  // instruction that sends a manager to a screen their role cannot open, or that no longer exists.
  throw new Error(`product help registry defects: ${LOAD_DEFECTS.join(', ')}`);
}

export const PRODUCT_HELP_ENTRIES: readonly ProductHelpEntry[] = ENTRIES;
