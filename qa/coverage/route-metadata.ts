import type { CoverageState } from './types.ts';

/**
 * The part of the manifest a parser cannot produce.
 *
 * `purpose` answers "why does this screen exist", and `kind` decides which of the 21 coverage
 * states are even applicable to it. Both are editorial statements about the product, so they are
 * written here by hand and reviewed, rather than inferred from JSX and presented as fact. A route
 * missing from this table still reaches the manifest — it is marked as lacking curated metadata,
 * which is a gap the report prints instead of hiding.
 */

export type RouteKind =
  | 'public'
  | 'redirect'
  | 'dashboard'
  | 'list'
  | 'detail'
  | 'form'
  | 'upload'
  | 'export'
  | 'console';

export interface RouteMetadata {
  readonly kind: RouteKind;
  readonly title: string;
  readonly purpose: string;
  /** States that apply on top of the ones implied by `kind`. */
  readonly extraStates?: readonly CoverageState[];
}

const LIST_STATES: CoverageState[] = [
  'loading',
  'empty',
  'populated',
  'no_search_results',
  'filtered_results',
  'large_table',
  'long_text',
  'stale_data',
  'permission_denied',
  'server_error',
];

const FORM_STATES: CoverageState[] = [
  'loading',
  'validation_error',
  'success',
  'server_error',
  'duplicate_submission',
  'disabled',
  'dialog_open',
  'dialog_closed',
  'permission_denied',
  'long_text',
];

const DETAIL_STATES: CoverageState[] = [
  'loading',
  'populated',
  'empty',
  'server_error',
  'stale_data',
  'permission_denied',
  'dialog_open',
  'dialog_closed',
  'long_text',
];

const DASHBOARD_STATES: CoverageState[] = [
  'loading',
  'empty',
  'populated',
  'server_error',
  'stale_data',
  'permission_denied',
];

const UPLOAD_STATES: CoverageState[] = [
  'loading',
  'empty',
  'populated',
  'upload_in_progress',
  'upload_failed',
  'validation_error',
  'success',
  'duplicate_submission',
  'server_error',
  'permission_denied',
];

const EXPORT_STATES: CoverageState[] = [
  'loading',
  'empty',
  'populated',
  'download_completed',
  'disabled',
  'validation_error',
  'server_error',
  'permission_denied',
  'filtered_results',
];

const PUBLIC_STATES: CoverageState[] = ['loading', 'validation_error', 'success', 'server_error', 'disabled'];

const BY_KIND: Readonly<Record<RouteKind, readonly CoverageState[]>> = {
  public: PUBLIC_STATES,
  redirect: ['loading'],
  dashboard: DASHBOARD_STATES,
  list: LIST_STATES,
  detail: DETAIL_STATES,
  form: FORM_STATES,
  upload: UPLOAD_STATES,
  export: EXPORT_STATES,
  console: DASHBOARD_STATES,
};

/** Every authenticated route can lose its session mid-use; that is not a per-screen decision. */
const UNIVERSAL_AUTHENTICATED_STATES: CoverageState[] = ['expired_session', 'offline_or_failed_request'];

export const ROUTE_METADATA: Readonly<Record<string, RouteMetadata>> = {
  '/login': {
    kind: 'public',
    title: 'כניסה למערכת',
    purpose: 'מסך הכניסה היחיד. כל תפקיד מגיע דרכו, וממנו נגזרת הפניית הבית לפי התפקיד.',
  },
  '/accept-invite': {
    kind: 'public',
    title: 'קבלת הזמנה',
    purpose: 'משתמש חדש הופך לחשבון פעיל בארגון המזמין. יוצר משתמש חדש ולכן אינו תלוי בסשן קיים.',
  },
  '/': {
    kind: 'redirect',
    title: 'שורש',
    purpose: 'מפנה לבית של התפקיד. אינו מרנדר תוכן משלו.',
  },
  '/dashboard': {
    kind: 'dashboard',
    title: 'מרכז הבקרה',
    purpose:
      'תמונת המצב שבה מנהל מבין בשניות מה דורש טיפול ומה עלול לגרום להפסד. owner/office מקבלים את הדשבורד המלא, שאר התפקידים דשבורד ייעודי.',
  },
  '/suppliers': { kind: 'list', title: 'ספקים', purpose: 'רשימת הספקים של הארגון ונקודת הכניסה לכרטיס ספק.' },
  '/suppliers/:id': {
    kind: 'detail',
    title: 'כרטיס ספק',
    purpose: 'כל מה שידוע על ספק אחד: פרטים, פרטי בנק, מחירונים והיסטוריית הגשות.',
    extraStates: ['dialog_open', 'dialog_closed'],
  },
  '/products': { kind: 'list', title: 'מוצרים', purpose: 'קטלוג המוצרים של הארגון וקישורי המחירונים אליהם.' },
  '/prices': {
    kind: 'upload',
    title: 'מחירונים',
    purpose: 'ניהול מחירוני הספקים והעלאת מחירון חדש מכל פורמט נתמך.',
  },
  '/orders/new': {
    kind: 'form',
    title: 'הזמנה חדשה',
    purpose: 'בניית הזמנת רכש: בחירת מוצרים, השוואת ספקים, פיצול הזמנה ואישור.',
    extraStates: ['stale_data', 'populated'],
  },
  '/orders': { kind: 'list', title: 'הזמנות רכש', purpose: 'רשימת ההזמנות והסטטוס שלהן.' },
  '/orders/:id': { kind: 'detail', title: 'פרטי הזמנה', purpose: 'הזמנה אחת: שורות, סטטוס, קבלות וחשבוניות מקושרות.' },
  '/receiving': { kind: 'list', title: 'קבלת סחורה', purpose: 'ההזמנות הממתינות לקבלה בפועל במטבח.' },
  '/receiving/:orderId': {
    kind: 'form',
    title: 'קבלת הזמנה',
    purpose: 'רישום מה הגיע בפועל מול מה שהוזמן, כולל חוסרים, פגמים ותיעוד מסמך.',
    extraStates: ['upload_in_progress', 'upload_failed', 'populated'],
  },
  '/invoices': { kind: 'list', title: 'חשבוניות', purpose: 'רשימת החשבוניות עם מסנני כפילות וחוסר הזמנה.' },
  '/invoices/new': {
    kind: 'form',
    title: 'חשבונית חדשה',
    purpose: 'קליטת חשבונית ספק, כולל בדיקות אוטומטיות לפני שמירה.',
    extraStates: ['populated'],
  },
  '/invoices/:id': {
    kind: 'detail',
    title: 'פרטי חשבונית',
    purpose: 'חשבונית אחת: בדיקות, פערים, זיכויים, אישור לתשלום ודרישת תשלום.',
  },
  '/documents': { kind: 'list', title: 'גלריית מסמכים', purpose: 'כל המסמכים הסרוקים, כולל אלה שטרם תויקו.' },
  '/documents/:documentId/review': {
    kind: 'form',
    title: 'בדיקת מסמך',
    purpose: 'אדם מאשר או מתקן את פירוש ה-OCR לפני שהמסמך הופך לרשומה עסקית.',
    extraStates: ['populated'],
  },
  '/inbox': { kind: 'redirect', title: 'תיבת מסמכים', purpose: 'קיצור היסטורי; מפנה לגלריה עם מסנן "לא תויק".' },
  '/credits': { kind: 'list', title: 'זיכויים', purpose: 'דרישות הזיכוי מהספקים והסטטוס שלהן.' },
  '/payment-requests': {
    kind: 'list',
    title: 'דרישות תשלום',
    purpose: 'יצירת דרישות תשלום ואישורן — הצד שמחליט, לא הצד שמעביר כסף.',
    extraStates: ['dialog_open', 'dialog_closed', 'duplicate_submission', 'success', 'validation_error'],
  },
  '/payments': { kind: 'list', title: 'תשלומים', purpose: 'התשלומים שבוצעו וההקצאות שלהם לחשבוניות.' },
  '/pay': {
    kind: 'list',
    title: 'תשלומים לביצוע',
    purpose: 'תור הביצוע: דרישות מאושרות בלבד, עם פרטי בנק ואסמכתה. כאן הכסף זז.',
    extraStates: ['dialog_open', 'dialog_closed', 'duplicate_submission', 'success', 'validation_error', 'disabled'],
  },
  '/pay/emergency': {
    kind: 'list',
    title: 'תשלום חירום',
    purpose: 'מסלול חירום של הבעלים לביצוע תשלום כשאין פייר זמין.',
    extraStates: ['dialog_open', 'duplicate_submission', 'validation_error'],
  },
  '/bank': {
    kind: 'upload',
    title: 'התאמות בנק',
    purpose: 'ייבוא דף בנק, מיפוי עמודות והתאמת תנועות לתשלומים.',
    extraStates: ['no_search_results', 'filtered_results'],
  },
  '/exceptions': { kind: 'list', title: 'חריגים', purpose: 'הפערים שדורשים הכרעה אנושית לפני שהם הופכים להפסד.' },
  '/alerts': { kind: 'list', title: 'התראות', purpose: 'מה דורש טיפול עכשיו, לפי כללי ההתראות של המערכת.' },
  '/expenses': { kind: 'export', title: 'ריכוז הוצאות', purpose: 'תמונת ההוצאות לפי טווח תאריכים, וייצוא שלה.' },
  '/reports': {
    kind: 'export',
    title: 'דוח חודשי לרואת חשבון',
    purpose: 'הדוח החודשי לרו״ח: ייצוא Excel, הדפסה ותיעוד שליחה.',
  },
  '/analytics': { kind: 'dashboard', title: 'ביצועי ספקים', purpose: 'השוואת ספקים לאורך זמן לצורך החלטות רכש.' },
  '/audit': { kind: 'list', title: 'יומן ביקורת', purpose: 'מי עשה מה ולמה. הראיה שהמערכת אחראית כספית.' },
  '/settings': {
    kind: 'form',
    title: 'הגדרות מערכת',
    purpose: 'הגדרות הארגון, משתמשים והזמנות. פעולות רגישות דורשות אימות מחדש.',
    extraStates: ['populated'],
  },
  '/my-prices': {
    kind: 'upload',
    title: 'המחירון שלי',
    purpose: 'פורטל הספק: המחירון הנוכחי, הגשת מחירון חודשי והיסטוריית הגשות.',
    extraStates: ['no_search_results'],
  },
  '/onboarding': { kind: 'form', title: 'הקמת ארגון', purpose: 'אשף ההקמה הראשוני של הבעלים.' },
  '/admin': {
    kind: 'console',
    title: 'ניהול לקוחות',
    purpose: 'קונסולת מפעיל הפלטפורמה. ציר נפרד מתפקידי הדייר ולכן מחוץ למודל התפקידים.',
  },
};

export function statesForRoute(route: string): CoverageState[] {
  const metadata = ROUTE_METADATA[route];
  if (!metadata) return [];
  const base = new Set<CoverageState>(BY_KIND[metadata.kind]);
  for (const state of metadata.extraStates ?? []) base.add(state);
  if (metadata.kind !== 'public' && metadata.kind !== 'redirect') {
    for (const state of UNIVERSAL_AUTHENTICATED_STATES) base.add(state);
  }
  return [...base];
}
