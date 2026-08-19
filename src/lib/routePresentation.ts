/**
 * Canonical user-facing names for authenticated routes.
 *
 * Authorization stays in App.tsx and Layout's role-aware navigation. This catalogue owns only
 * presentation, so a route cannot quietly acquire a different name in the drawer, sticky phone
 * header and browser title.
 */
export const STATIC_ROUTE_TITLES = {
  '/admin': 'ניהול פלטפורמה',
  '/dashboard': 'מרכז הבקרה',
  '/suppliers': 'ספקים',
  '/products': 'מוצרים',
  '/inventory': 'מלאי',
  '/prices': 'מחירונים',
  '/orders/new': 'הזמנה חדשה',
  '/orders': 'הזמנות רכש',
  '/receiving': 'קבלת סחורה',
  '/invoices/new': 'חשבונית חדשה',
  '/invoices': 'חשבוניות',
  '/documents': 'תיקיית המסמכים',
  '/documents/operations': 'בקרת מסמכים',
  '/documents/consolidated-invoices': 'חשבוניות מרכזות',
  '/documents/archive': 'ארכיון מסמכים',
  '/credits': 'זיכויים',
  '/payment-requests': 'דרישות תשלום',
  '/payments': 'תשלומים',
  '/pay': 'תשלומים לביצוע',
  '/bank': 'התאמות בנק',
  '/exceptions': 'חריגים',
  '/alerts': 'התראות',
  '/expenses': 'ריכוז הוצאות',
  '/reports': 'דוח לרו״ח',
  '/reports/products': 'סיכום רכישות מוצרים',
  '/analytics': 'ביצועי ספקים',
  '/supplier-log': 'יומן עדכון ספקים',
  '/settings': 'הגדרות מערכת',
  '/onboarding': 'הקמת המערכת',
} as const;

export type StaticRoutePath = keyof typeof STATIC_ROUTE_TITLES;

export function staticRouteTitle(path: StaticRoutePath): string {
  return STATIC_ROUTE_TITLES[path];
}

/**
 * The one-line answer to "what do I do on this screen", per route.
 *
 * A separate map rather than a `{ title, description }` record on purpose: the titles above are
 * already read by the drawer, the sticky phone header and the browser title, and widening that
 * shape would push a sentence into three places that want a name. `Record<StaticRoutePath, string>`
 * is what keeps the two maps honest — adding a route to `STATIC_ROUTE_TITLES` without describing it
 * is a type error here, not a screen that quietly ships without a description.
 *
 * These sentences say what a person DOES here; they do not restate the title, and they are not a
 * status line. A screen with live numbers to report (`/alerts` freshness, `/supplier-log` row
 * count) keeps reporting them through `meta` — the description sits above that, unchanging.
 */
export const STATIC_ROUTE_DESCRIPTIONS: Record<StaticRoutePath, string> = {
  '/admin': 'צפייה בארגונים הרשומים בפלטפורמה, ניהול סיום שירות וייצוא דיירים וקריאת הערות שהגיעו מהמשתמשים.',
  '/dashboard': 'פותחים כאן את היום: מה דורש טיפול עכשיו, מה עלול לעלות כסף ומה מצב העסק ברגע זה.',
  '/suppliers': 'ניהול רשימת הספקים ופרטיהם, וכניסה לכרטיס ספק לצפייה בהזמנות, בחשבוניות ובזיכויים שלו.',
  '/products': 'ניהול קטלוג המוצרים שמהם נבנות ההזמנות, והעלאת מחירוני ספקים עבורם.',
  '/inventory': 'מעקב אחר היתרות שנספרו ואחר תנועות המלאי, וזיהוי מוצרים שירדו מתחת למינימום.',
  '/prices': 'השוואת מחירי הספקים לכל מוצר, איתור התייקרויות וייבוא מחירונים חדשים.',
  '/orders/new': 'בניית הזמנת רכש: בוחרים מוצרים תחילה, ואז מפצלים בין ספקים ומאשרים מחירים לפני השליחה.',
  '/orders': 'מעקב אחר הזמנות הרכש שנשלחו לספקים ואחר מצב הביצוע של כל אחת מהן.',
  '/receiving': 'רישום מה הגיע בפועל מול ההזמנה — כמויות, חוסרים ופערים — כבסיס לבדיקת החשבונית.',
  '/invoices/new': 'הזנת חשבונית ספק חדשה וקישורה להזמנה ולקבלת הסחורה שלה.',
  '/invoices': 'מעקב אחר חשבוניות הספקים: מצב הבדיקה, מצב התשלום והיתרה הפתוחה בכל חשבונית.',
  '/documents': 'איתור כל מסמך שנקלט למערכת ושיוכו לרשומה העסקית שלו.',
  '/documents/operations': 'בקרה על קליטת המסמכים: מה נתקע בעיבוד, מה נכשל ומה ממתין להחלטה אנושית.',
  '/documents/consolidated-invoices': 'קליטת חשבונית מרכזת של ספק והתאמת מסמכי אותו חודש אליה כעוגן חוב אחד.',
  '/documents/archive': 'טיפול במסמכים שהמערכת לא הצליחה לשייך — החזרתם לתיקייה לשיוך ידני או הסרתם.',
  '/credits': 'מעקב אחר דרישות הזיכוי מול הספקים, מרגע הפתיחה ועד המעבר בפועל.',
  '/payment-requests': 'פתיחת דרישת תשלום מול ספק, קישורה לחשבוניות הפתוחות שלו והעברתה לאישור.',
  '/payments': 'צפייה בתשלומים שכבר נרשמו, באסמכתאות שלהם ובחשבוניות שהם כיסו.',
  '/pay': 'ביצוע ההעברות שאושרו: פרטי הבנק של הספק, רישום התשלום שבוצע והעלאת אסמכתה.',
  '/bank': 'ייבוא תדפיס הבנק והתאמת התנועות שבו לתשלומים ולחשבוניות שבמערכת.',
  '/exceptions': 'טיפול בפערים שהמערכת סימנה — הפרשי כמות, מחיר או סכום — עד לסגירתם מול הספק.',
  '/alerts': 'התור המלא של כל מה שדורש טיפול, מהדחוף ועד המידע. מרכז הבקרה מסכם ומפנה לכאן.',
  '/expenses': 'ריכוז ההוצאות לפי ספק ולפי קטגוריה בטווח תאריכים נבחר, לצפייה, להדפסה ולייצוא.',
  '/reports': 'החבילה החודשית לרואת החשבון: חשבוניות, תשלומים וזיכויים של החודש, לבדיקה ולייצוא.',
  '/reports/products': 'בדיקת הכמות והעלות שנרכשו בכל מוצר, לצד שלושת מקורות הנתונים שמאחורי המספר.',
  '/analytics': 'השוואת הספקים זה מול זה: זמן אספקה, עמידה בזמנים, תנודתיות מחיר וחריגים פתוחים.',
  '/supplier-log': 'בדיקה מי שינה פרט של ספק או מחיר של מוצר, מתי, ומאיזו סיבה.',
  '/settings': 'הגדרת פרטי העסק, המשתמשים והרשאותיהם, ומדיניות העבודה של המערכת.',
  '/onboarding': 'רשימת ההקמה של הבעלים: ארבעה שלבים שממלאים את המערכת בנתוני העסק, ואפשר לחזור אליהם בכל עת.',
};

export const DYNAMIC_ROUTE_TITLES: readonly [RegExp, string][] = [
  [/^\/finance\/suppliers\/[^/]+$/, 'כרטיס ספק פיננסי'],
  [/^\/suppliers\/[^/]+$/, 'כרטיס ספק'],
  [/^\/orders\/[^/]+$/, 'פרטי הזמנה'],
  [/^\/receiving\/[^/]+$/, 'קבלת סחורה'],
  [/^\/receipts\/[^/]+$/, 'פרטי קבלה'],
  [/^\/invoices\/[^/]+$/, 'פרטי חשבונית'],
  [/^\/documents\/[^/]+\/review$/, 'בדיקת מסמך'],
];

/**
 * Same patterns, same order as `DYNAMIC_ROUTE_TITLES`. The type system cannot enforce that for a
 * tuple list the way `Record<StaticRoutePath, string>` does above, so the spec compares the two
 * pattern sources directly — a pattern added to one list and not the other fails the suite.
 */
export const DYNAMIC_ROUTE_DESCRIPTIONS: readonly [RegExp, string][] = [
  [/^\/finance\/suppliers\/[^/]+$/, 'בדיקת החשיפה הכספית מול ספק אחד: יתרה פתוחה, חשבוניות, זיכויים, דרישות תשלום ותנועות בנק.'],
  [/^\/suppliers\/[^/]+$/, 'כל מה שקשור לספק אחד במקום אחד: פרטים, מחירון, הזמנות, חשבוניות וזיכויים.'],
  [/^\/orders\/[^/]+$/, 'בדיקת שורות ההזמנה, מצבה מול הספק והמסמכים שנקשרו אליה.'],
  [/^\/receiving\/[^/]+$/, 'עדכון הכמויות שהתקבלו בפועל בהזמנה זו, שורה אחר שורה, וסימון חוסרים.'],
  [/^\/receipts\/[^/]+$/, 'צפייה במה שנרשם בקבלת סחורה זו ובפערים שנמצאו מול ההזמנה.'],
  [/^\/invoices\/[^/]+$/, 'בדיקת החשבונית מול ההזמנה והקבלה, אישורה, והמשך ממנה לדרישת תשלום.'],
  [/^\/documents\/[^/]+\/review$/, 'אישור או תיקון של מה שהמערכת קראה מהמסמך, לפני שהוא הופך לרשומה עסקית.'],
];

export function routePresentationTitle(pathname: string): string | null {
  const exact = STATIC_ROUTE_TITLES[pathname as StaticRoutePath];
  return exact ?? DYNAMIC_ROUTE_TITLES.find(([pattern]) => pattern.test(pathname))?.[1] ?? null;
}

export function routePresentationDescription(pathname: string): string | null {
  const exact = STATIC_ROUTE_DESCRIPTIONS[pathname as StaticRoutePath];
  return exact ?? DYNAMIC_ROUTE_DESCRIPTIONS.find(([pattern]) => pattern.test(pathname))?.[1] ?? null;
}

const STATIC_ROUTE_BACK: Partial<Record<StaticRoutePath, { to: string; label: string }>> = {
  '/orders/new': { to: '/orders', label: 'חזרה להזמנות רכש' },
  '/invoices/new': { to: '/invoices', label: 'חזרה לחשבוניות' },
  '/reports/products': { to: '/reports', label: 'חזרה לדוח לרו״ח' },
};

const DYNAMIC_ROUTE_BACK: readonly [RegExp, { to: string; label: string }][] = [
  [/^\/suppliers\/[^/]+$/, { to: '/suppliers', label: 'חזרה לספקים' }],
  [/^\/finance\/suppliers\/[^/]+$/, { to: '/dashboard', label: 'חזרה למרכז הבקרה' }],
  [/^\/orders\/[^/]+$/, { to: '/orders', label: 'חזרה להזמנות רכש' }],
  [/^\/receiving\/[^/]+$/, { to: '/receiving', label: 'חזרה לקבלת סחורה' }],
  [/^\/receipts\/[^/]+$/, { to: '/receiving', label: 'חזרה לקבלת סחורה' }],
  [/^\/invoices\/[^/]+$/, { to: '/invoices', label: 'חזרה לחשבוניות' }],
  [/^\/documents\/[^/]+\/review$/, { to: '/documents', label: 'חזרה למסמכים' }],
];

export function routeBackPresentation(pathname: string): { to: string; label: string } | null {
  return STATIC_ROUTE_BACK[pathname as StaticRoutePath]
    ?? DYNAMIC_ROUTE_BACK.find(([pattern]) => pattern.test(pathname))?.[1]
    ?? null;
}
