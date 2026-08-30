import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const OWNER_CHOICE_DEBTS = new Set(['20', '66', '76', '79']);
// A heading that records a closing date is a resolved item, not open debt.
const CLOSED_DEBT_HEADING = /נסגר(?:ה)?\s+\d{2}\.\d{2}\.\d{4}/u;
const PLAN_NOW_DEBTS = new Set([
  '7', '8', '9', '10', '19', '17', '31', '32', '35', '41', '42', '45', '46', '47', '49', '50', '53',
  '25', '29', '30', '34', '52', '56', '57', '58', '59', '61', '62', '64', '65', '67',
  '68', '70', '72', '76', '77', '78', '79',
]);

const TERM_DEFINITIONS = [
  ['DPA', 'הסכם כתוב שמגדיר כיצד ספק חיצוני שומר ומעבד מידע'],
  ['MFA', 'אימות כניסה בשני שלבים, למשל סיסמה וקוד נוסף'],
  ['webhook', 'הודעה אוטומטית שמערכת אחת שולחת למערכת אחרת'],
  ['RLS', 'כללים במסד הנתונים שמגבילים איזה מידע כל משתמש רשאי לראות או לשנות'],
  ['SECURITY DEFINER', 'פעולת מסד שרצה בהרשאה מוגברת ולכן דורשת הגנות נוספות'],
  ['RPC', 'פעולה מאובטחת שהשרת מבצע עבור המסך'],
  ['CI', 'בדיקות אוטומטיות שרצות לפני שילוב קוד'],
  ['OCR', 'קריאה אוטומטית של טקסט מתוך מסמך או צילום'],
  ['Storage', 'אזור אחסון הקבצים של המערכת'],
  ['Supabase', 'שירות הנתונים וההרשאות שעליו המוצר נשען'],
  ['Paddle', 'ספק הגבייה שנבחר עבור תשלומי המנוי'],
];

const PLAIN_REPLACEMENTS = [
  [/`([^`]+)`/g, '$1'],
  [/DPA/gi, 'הסכם הגנת מידע'],
  [/MFA/gi, 'אימות בשני שלבים'],
  [/\bwebhooks?\b/gi, 'הודעות אוטומטיות בין מערכות'],
  [/RLS/g, 'הגבלות גישה לנתונים'],
  [/SECURITY DEFINER/gi, 'פעולה בעלת הרשאה מוגברת'],
  [/RPCs?/gi, 'פעולות שרת מאובטחות'],
  [/\bCI\b/g, 'בדיקות אוטומטיות'],
  [/OCR/gi, 'קריאת מסמכים אוטומטית'],
  [/Storage/gi, 'אחסון קבצים'],
  [/Supabase/gi, 'שירות הנתונים'],
  [/Paddle/gi, 'ספק הגבייה'],
  [/PostgREST/gi, 'שירות הגישה לנתונים'],
  [/pg_cron/gi, 'מתזמן המשימות'],
  [/\borg_id\b/gi, 'מזהה הארגון'],
  [/\baccountant\b/gi, 'רואה החשבון'],
  [/\boffice\b/gi, 'מנהל הרכש'],
  [/\bowner\b/gi, 'בעל העסק'],
  [/expected_date/gi, 'תאריך האספקה המבוקש'],
  [/\/expenses/gi, 'מסך ההוצאות'],
  [/\/?inbox\b/gi, 'תיבת המסמכים'],
  [/\?from=\s*/gi, ''],
  [/\bpush\b/gi, 'התראות לטלפון'],
  [/rollout/gi, 'שחרור גרסה'],
  [/increase_qty/gi, 'הגדלת כמות'],
  [/metadata/gi, 'פרטי הקובץ'],
  [/\bledger\b/gi, 'יומן השינויים במסד'],
  [/\bpipeline\b/gi, 'תהליך הקליטה'],
  [/checksum/gi, 'טביעת אימות'],
  [/\bworker\b/gi, 'מעבד המסמכים'],
  [/\bA5\b/g, 'בדיקת הבטיחות'],
  [/\bdefiner\b/gi, 'בעלות הרשאה מוגברת'],
  [/טבלאות מסוקפות/g, 'טבלאות המוגבלות לארגון'],
  [/\bbytes\b/gi, 'תוכן הקובץ'],
  [/\bbbox\b/gi, 'גבולות האזור בתמונה'],
  [/\boffline\b/gi, 'ללא חיבור לאינטרנט'],
  [/unit_id/gi, 'שיוך ליחידה עסקית'],
  [/step-up/gi, 'אימות חוזר של זהות המשתמש'],
  [/feature flags?/gi, 'מתגי יכולת'],
  [/\bflag\b/gi, 'מתג'],
  [/security_events/gi, 'יומן אירועי האבטחה'],
  [/\boutbox\b/gi, 'תור ההודעות היוצאות'],
  [/idempotency_keys/gi, 'הגנה מפני ביצוע כפול'],
  [/idempotency/gi, 'מניעת ביצוע כפול'],
  [/audit_logs/gi, 'יומן הפעילות'],
  [/\baudit\b/gi, 'יומן פעילות'],
  [/\brenew\b/gi, 'חידוש'],
  [/integration_failures/gi, 'כשלי חיבור למערכת חיצונית'],
  [/integration_deliveries/gi, 'מסירות למערכת חיצונית'],
  [/integration/gi, 'חיבור למערכת חיצונית'],
  [/precache/gi, 'שמירה מוקדמת לשימוש ללא רשת'],
  [/snapshot/gi, 'תמונת מצב שמורה'],
  [/apply_document_interpretation/gi, 'הפעולה שמאשרת תוצאת קריאת מסמך'],
  [/suppliers\.status\s*=\s*'inactive'/gi, 'ספק שמסומן כלא פעיל'],
  [/3-way match/gi, 'התאמה בין הזמנה, קבלה וחשבונית'],
  [/\bTrial\b/gi, 'תקופת ניסיון'],
  [/\bdraft\b/gi, 'טיוטה'],
  [/\bCAPTCHA\b/g, 'בדיקת אנוש נגד הרשמה אוטומטית'],
  [/\bDrift\b/gi, 'סטייה מההתנהגות הצפויה'],
  [/Shadow Mode/gi, 'מצב תצפית ללא ביצוע'],
  [/\bShadow\b/gi, 'מצב תצפית'],
  [/\binvestigation\b/gi, 'בדיקה מעמיקה'],
  [/\bBusiness\b/g, 'מסלול עסקי מותאם'],
  [/\bFree\b/g, 'המסלול החינמי'],
  [/capabilities/gi, 'יכולות'],
  [/read tools/gi, 'כלי קריאה'],
  [/external messages/gi, 'הודעות חיצוניות'],
  [/live-model evaluation/gi, 'בדיקת מודל חיה'],
  [/merchant of record/gi, 'ספק שגובה מהלקוח ומטפל בחובות המס'],
  [/\bMoR\b/g, 'ספק שגובה מהלקוח ומטפל בחובות המס'],
  [/\bruntime\b/gi, 'המערכת בזמן שימוש'],
  [/Stripe fallback/gi, 'ספק הגבייה החלופי Stripe'],
  [/\bDashboard\b/gi, 'מרכז הבקרה'],
  [/\bpurge\b/gi, 'מחיקה פיזית'],
  [/\boffboarding\b/gi, 'עזיבת לקוח'],
  [/retention executor/gi, 'מנגנון שמירת ומחיקת המידע'],
  [/unit economics/gi, 'הכדאיות הכלכלית לכל שימוש'],
  [/\bpayouts\b/gi, 'העברת הכסף לעסק'],
  [/self-referral/gi, 'הפניה עצמית לתוכנית חבר מביא חבר'],
  [/\breferrer\b/gi, 'הגורם המפנה'],
  [/\breferral\b/gi, 'הפניה בתוכנית חבר מביא חבר'],
  [/entity→document kind/gi, 'סוג המסמך לכל רשומה עסקית'],
  [/reply-to/gi, 'כתובת שאליה משיבים'],
  [/\baccepted\b/gi, 'התקבל אצל ספק הדוא״ל'],
  [/\bbounced\b/gi, 'חזר ולא נמסר'],
  [/\bHEIC\b/g, 'צילום iPhone'],
  [/full-frame fallback/gi, 'שימוש בתמונה המלאה כשלא נמצאו גבולות'],
  [/\bscope\b/gi, 'היקף הרשאה'],
  [/\bPDF\b/g, 'קובץ מסמך מרובה עמודים'],
  [/\bmodality\b/gi, 'אופן השימוש'],
  [/domain events/gi, 'אירועים עסקיים שנרשמים במערכת'],
  [/re-assert/gi, 'בדיקה חוזרת של כללי הבטיחות'],
  [/InitPlan/gi, 'תוכנית הביצוע של מסד הנתונים'],
  [/global_search/gi, 'החיפוש הכללי'],
  [/p2_invoice_without_order_count\(\)/gi, 'ספירת החשבוניות ללא הזמנה'],
  [/\brider\b/gi, 'כלל הגבלת הארגון'],
  [/\bresume\b/gi, 'חידוש העלאה'],
  [/pg_trgm/gi, 'מנגנון האצת החיפוש'],
  [/\bOR\b/g, 'חיפוש בין כמה תנאים'],
  [/invoice_has_duplicate/gi, 'מסנן החשבוניות החשודות ככפולות'],
  [/count:\s*'exact'/gi, 'ספירה מדויקת'],
  [/FileStore/gi, 'שמירת קבצים מקומית'],
  [/single_open_order/gi, 'בחירת ההזמנה הפתוחה היחידה'],
  [/\bheuristic\b/gi, 'כלל הערכה'],
  [/\blease\b/gi, 'חלון הזמן שהוקצה לעיבוד'],
  [/\bupload\b/gi, 'העלאת קובץ'],
  [/\bbootstrap\b/gi, 'טעינת הכניסה למערכת'],
  [/\bassessment\b/gi, 'הערכת המסמך'],
  [/source_partial/gi, 'סימון שהקריאה הייתה חלקית'],
  [/corners_source/gi, 'מקור זיהוי גבולות התמונה'],
  [/zz_organization_write_guard/gi, 'שומר הכתיבה בין ארגונים'],
  [/PriceSparkline/gi, 'גרף שינוי המחיר'],
  [/Rules Engine/gi, 'מנגנון כללים אוטומטי'],
  [/Report Jobs/gi, 'הפקת דוחות ברקע'],
  [/Workflow Engine/gi, 'מנגנון תהליכים כללי'],
  [/management_dashboard_snapshot/gi, 'נתוני תמונת המצב של מרכז הבקרה'],
  [/management_dashboard_/gi, 'נתוני מרכז הבקרה — '],
  [/quickCreateProduct\.spec\.tsx/gi, 'בדיקת יצירת מוצר מהירה'],
  [/\bPR\b/g, 'בקשת שילוב קוד'],
  [/\bmain\b/g, 'ענף הקוד הראשי'],
  [/\bsent\b/gi, 'נשלחה'],
  [/רשם חריגי/g, 'רשימת הפעולות החריגות'],
  [/ריקון פונקציה־פונקציה/g, 'בדיקה ותיקון של כל פעולה בנפרד'],
  [/\bactor\b/gi, 'מי ביצע את הפעולה'],
  [/\btenant\b/gi, 'הארגון'],
  [/\bunit\b/gi, 'היחידה העסקית'],
  [/\btables\b/gi, 'הטבלאות המושפעות'],
  [/\breason\b/gi, 'הסיבה'],
  [/latency/gi, 'זמן תגובה'],
  [/\bprompt\b/gi, 'ההוראות למודל'],
  [/\bmodel\b/gi, 'המודל'],
  [/\bversion\b/gi, 'הגרסה'],
  [/\bcommit\b/gi, 'שינוי קוד אחד'],
  [/\bguard\b/gi, 'שומר בטיחות'],
  [/auth-js/gi, 'רכיב ההתחברות'],
  [/\bsmoke\b/gi, 'בדיקה חיה ממוקדת'],
  [/false-positive\s*\/\s*false-negative/gi, 'טעויות שבהן המערכת אישרה או פסלה בטעות'],
  [/false-positive/gi, 'אישור שגוי'],
  [/false-negative/gi, 'פסילה שגויה'],
  [/getSession/gi, 'בדיקת מצב הכניסה'],
  [/navigator\.locks/gi, 'נעילת הדפדפן'],
  [/\bclient\b/gi, 'רכיב החיבור בדפדפן'],
  [/round trip/gi, 'פתיחה, שמירה ופתיחה מחדש'],
  [/\bsubtype\b/gi, 'סוג המסמך המדויק'],
  [/provenance/gi, 'תיעוד מקור הראיה'],
  [/duplicate guard/gi, 'מניעת כפילות'],
  [/\bbalance\b/gi, 'יתרה מחושבת'],
  [/concurrency/gi, 'פעולות מקבילות'],
  [/second_pass/gi, 'סבב הקריאה השני'],
  [/createImageBitmap/gi, 'יכולת הדפדפן לקרוא את התמונה'],
  [/\benqueue\b/gi, 'שליחה לעיבוד'],
  [/\bEdge\b/gi, 'שירות השרת'],
  [/\bDB\b/g, 'מסד הנתונים'],
  [/TypeScript/gi, 'קוד האפליקציה'],
  [/backfill/gi, 'תיקון רשומות קיימות'],
  [/completeness proof/gi, 'הוכחה שכל השורות טופלו'],
  [/Platform Admin/gi, 'מנהל הפלטפורמה'],
  [/assertion/gi, 'בדיקת שער'],
  [/usage(?:\.[a-z0-9_.]+)?/gi, 'נתוני השימוש'],
  [/SSRF\/DNS\/IP guards/gi, 'חסימה של כתובות רשת מסוכנות'],
  [/\bSSRF\b/gi, 'גישה אסורה לכתובת פנימית'],
  [/\bDNS\b/gi, 'רישום הכתובת ברשת'],
  [/\bIP\b/g, 'כתובת רשת'],
  [/\bVault\b/gi, 'כספת סודות'],
  [/verification handshake/gi, 'אימות שהיעד נשלט בידי הלקוח'],
  [/INVITE_FROM_EMAIL\/ORDERS_FROM_EMAIL/gi, 'כתובות השולח למיילים'],
  [/SMTP Auth/gi, 'אימות שירות הדוא״ל'],
  [/\breversal\b/gi, 'ביטול מבוקר'],
  [/candidate report/gi, 'דוח מועמדים למחיקה'],
  [/legal hold/gi, 'חובת שימור חוקית'],
  [/\bexport\b/gi, 'ייצוא הנתונים'],
  [/PowerShell/gi, 'סקריפט Windows'],
  [/\bSQL\b/g, 'בדיקת מסד נתונים'],
  [/\bNode\b/g, 'סקריפט נייד'],
  [/\brunner\b/gi, 'סביבת הרצה'],
  [/\bKYC\b/g, 'אימות זהות העסק אצל ספק הגבייה'],
  [/\bsandbox\b/gi, 'סביבת בדיקה של הספק'],
  [/report-only/gi, 'דוח בלבד ללא מחיקה'],
  [/quarantine/gi, 'העברה לבדיקה ידנית'],
  [/read model/gi, 'נתוני הקריאה של המסך'],
  [/findByText/gi, 'בדיקה שמחפשת טקסט'],
  [/userEvent\.setup\(\)/gi, 'הדמיית פעולות משתמש'],
  [/fake timers/gi, 'שעון בדיקה מדומה'],
  [/docker logs/gi, 'יומני שירותי המסד'],
  [/workflow_dispatch/gi, 'הרצה ידנית של שער הבדיקות'],
  [/\bMFA\b/g, 'אימות בשני שלבים'],
  [/Twilio sender/gi, 'חיבור שולח ה־WhatsApp'],
];

const IMPACTS_BY_CATEGORY = new Map([
  ['P0 — גבולות אמון ושלמות', [
    'בחירה לא נכונה עלולה לאפשר למידע של ארגון אחד להיחשף או להשתנות בהקשר של ארגון אחר.',
    'השלמה דורשת בדיקות הרשאה שמוכיחות גם מה מותר וגם מה חייב להיחסם.',
    'אין השפעה מיידית על המסכים עד שהשינוי יעבור בדיקה ופריסה נפרדת.',
  ]],
  ['ביצועים וקנה מידה', [
    'הפער אינו משנה בדרך כלל את התוצאה היום, אך עלול להאט את המערכת כשהיקף הנתונים יגדל.',
    'טיפול מוקדם מפחית סיכון לזמני המתנה ועלויות תשתית בעתיד.',
    'אין צורך לעצור שימוש רגיל כל עוד המדידה הנוכחית נשארת תקינה.',
  ]],
  ['מסמכים, OCR ו־Storage', [
    'הבחירה משפיעה על דיוק קליטת המסמכים ועל כמות הבדיקות הידניות שיידרשו מהצוות.',
    'אוטומציה רחבה יותר חוסכת זמן אך מגדילה את הצורך בראיות, בקרה ודרך תיקון.',
    'המסמך המקורי נשמר; החלטה כאן אינה מוחקת קובץ או מאשרת תשלום בעצמה.',
  ]],
  ['דשבורד ורפרנס T7.1', [
    'השינוי משפיע על בהירות המסך ועל היכולת להבין מגמה בלי להסתמך על צבע בלבד.',
    'הוא אינו משנה סכומים, הרשאות או נתונים עסקיים.',
  ]],
  ['תהליכים חיצוניים וציות', [
    'הנושא משפיע על שירותים חיצוניים, פרטיות, מסירה או יכולת לעמוד בהתחייבות ללקוח.',
    'הפעלה אמיתית דורשת הגדרה ובדיקה מול השירות החיצוני, לא רק שינוי במסך.',
    'בחירה במסמך הזה אינה שולחת הודעה, גובה כסף או מפעילה ספק חיצוני.',
  ]],
]);

const DECISION_IMPACTS = [
  'ההחלטה קובעת את התנהגות המוצר או את הכלל העסקי שהצוות יממש ויבדוק.',
  'אם תרצה לשנות החלטה שכבר יושמה, תיפתח בקשת שינוי חדשה כדי לשמור את ההיסטוריה.',
  'בחירה בדף אינה משנה מיד את המוצר או את סביבת הייצור.',
];

const OVERRIDES = {
  'decision:270': {
    plainQuestion: 'מה נעשה כש-Apple מסתירה את כתובת הדוא״ל האמיתית של בעל העסק?',
    plainContext: 'Apple יכולה למסור למערכת כתובת זמנית שמעבירה דואר לכתובת האמיתית. אם המשתמש מבטל את החיבור, הכתובת הזמנית עלולה להפסיק לעבוד.',
    whyItMatters: 'ללא כתובת פעילה לא נוכל למסור התראות חשובות או לסייע באיפוס סיסמה לבעל הארגון.',
    whatItDoesNotDo: 'הבחירה לא מפעילה את ההתחברות עם Apple; היא רק קובעת את הכלל שניישם לפני ההפעלה.',
    currentDecisionPlain: 'טרם התקבלה החלטה.',
    options: [
      { id: 'accept-relay', label: 'לקבל את הכתובת של Apple', implication: 'ההרשמה תהיה קצרה ופשוטה, אך קיים סיכון שבעתיד יאבד ערוץ הדוא״ל של בעל הארגון.' },
      { id: 'require-backup-email', label: 'לדרוש כתובת חלופית מאומתת', implication: 'נוסיף שלב הרשמה, אך נבטיח שלארגון יישאר ערוץ דוא״ל שאינו תלוי ב-Apple.' },
      { id: 'reject-relay', label: 'לא לאפשר הרשמה עם כתובת מוסתרת', implication: 'נמנע את סיכון אובדן הדוא״ל, אך חלק ממשתמשי Apple לא יוכלו להירשם בדרך זו.' },
    ],
    recommendation: 'require-backup-email',
  },
  // #300 surfaced once the open marker was read from the register instead of a pinned id.
  // No recommendation: #299 argues one way and `0249` the other, and the register does not rule.
  'decision:300': {
    plainQuestion: 'האם הכלל „תיבת סיבה לא תחסום פעולה" חל גם על מסכי צוות הפלטפורמה?',
    plainContext: 'הכרעת 30.08 קבעה שתיבת סיבה לא תחסום פעולה לגיטימית בשום מסך. בקונסולת התפעול המצב שונה: שם הסיבה אינה רק שדה במסך אלא נדרשת על ידי השרת עצמו, ופעולה בלעדיה נדחית. לכן הסרת החסימה במסך בלבד לא הייתה משחררת פעולה אלא יוצרת כפתור שנכשל תמיד.',
    whyItMatters: 'שתי ההכרעות נכתבו באותו שבוע בשני ענפים שלא ראו זה את זה. אם לא תוכרע, המסך והשרת ימשיכו להתנהג לפי שני כללים שונים.',
    whatItDoesNotDo: 'הבחירה אינה משנה מסך או הרשאה היום. היא קובעת אם נדרש שינוי בשרת.',
    currentDecisionPlain: 'טרם התקבלה החלטה. ברירת המחדל הממומשת: הכלל אינו חל על מסכי צוות הפלטפורמה.',
    options: [
      { id: 'keep-operator-required', label: 'לא — מסכי הצוות ימשיכו לדרוש סיבה', implication: 'אפס עבודה; זה המצב היום. הדרישה נשארת מוצדקת בכתב, אך המוצר מחזיק שני כללים שונים לשני סוגי מסכים.' },
      { id: 'apply-299-to-operator', label: 'כן — להחיל את הכלל גם שם', implication: 'השינוי אינו במסך אלא בשרת: להסיר את דרישת הסיבה מהפקודות חוצות-הדיירים, והמסך נגרר אחריה. זו מיגרציה חדשה על משטח רגיש.' },
    ],
  },
  'debt:20': {
    plainQuestion: 'האם לשמור טקסט ממסמך בדיוק כפי שנקרא, או לתקן אותו אוטומטית?',
    plainContext: 'תיקון אוטומטי יכול להפוך טקסט לקריא יותר, אך גם לשנות בטעות את מה שהיה במסמך המקורי.',
    whyItMatters: 'במסמכים כספיים חשוב לדעת אם הערך המוצג הגיע מהמקור או מתיקון של המערכת.',
    whatItDoesNotDo: 'הבחירה אינה משנה מסמכים קיימים לפני שנבנה מסלול בדיקה ושחזור.',
    options: [
      { id: 'preserve-source', label: 'לשמור את המקור כפי שנקרא', implication: 'נאמנות המקור נשמרת, אך חלק מהטקסט עלול להישאר פחות נוח לקריאה.' },
      { id: 'normalize-with-evidence', label: 'לתקן ולשמור גם את המקור', implication: 'נקבל טקסט נוח יותר בלי לאבד ראיה, אך המימוש והבדיקות מורכבים יותר.' },
      { id: 'defer', label: 'לא לשנות כרגע', implication: 'אין סיכון חדש, אך הפער בקריאות הטקסט נשאר.' },
    ],
    recommendation: 'normalize-with-evidence',
  },
  'debt:37': {
    plainQuestion: 'האם להשקיע בכלי שמאפשר קובצי Excel מעוצבים בצבעי המותג?',
    plainContext: 'הכלי החינמי הקיים שומר נתונים, עברית וכיוון תקינים, אך אינו שומר את עיצוב הצבעים הנדרש.',
    whyItMatters: 'זו החלטת עלות ורישוי, לא תקלה בחישובים או בנתונים שבקובץ.',
    whatItDoesNotDo: 'גם רכישת כלי אינה משנה קובצי עבר; נצטרך מימוש ובדיקת שימור נפרדים.',
    options: [
      { id: 'licensed-writer', label: 'לרכוש כלי כתיבה מתאים', implication: 'נקבל עיצוב מלא ואמין יותר, בתוספת עלות רישיון ותלות בספק.' },
      { id: 'designed-template', label: 'להשתמש בתבנית Excel מוכנה', implication: 'נוכל לקבל עיצוב בלי רישיון מלא, אך חייבים להוכיח שהפתיחה והשמירה אינן פוגעות בקובץ.' },
      { id: 'keep-functional', label: 'להישאר עם קובץ תקין ללא צבעי מותג', implication: 'אין עלות או סיכון חדש; הקובץ יישאר שימושי אך פחות ממותג.' },
    ],
    recommendation: 'keep-functional',
  },
  'debt:66': {
    plainQuestion: 'האם לאפשר מחיקה מבוקרת של כל נתוני ארגון שסיים את השירות?',
    plainContext: 'כיום שכבות ההגנה שומרות ראיות כספיות היטב, אך גם חוסמות מחיקה מלאה של ארגון שבאמת השתמש במוצר.',
    whyItMatters: 'בלי מסלול מחיקה מוכח לא ניתן להשלים בקשת עזיבה ומחיקה בהתאם למדיניות שנקבעה.',
    whatItDoesNotDo: 'הבחירה לא מוחקת שום ארגון. המימוש יחייב ייצוא, בדיקת שמירה חוקית, אישור מפורש ויומן מחיקה.',
    options: [
      { id: 'controlled-purge', label: 'לבנות מסלול מחיקה מבוקר', implication: 'נוכל להשלים עזיבה, אך נפתח חלון הרשאה רגיש שחייב להיות קצר, מתועד ומוגן בבדיקות.' },
      { id: 'keep-blocked', label: 'להשאיר מחיקה מלאה חסומה', implication: 'הראיות נשארות מוגנות, אך לא נוכל להבטיח מחיקה מלאה ללקוח שעזב.' },
      { id: 'manual-case-review', label: 'להחליט ידנית בכל מקרה', implication: 'נקבל שליטה גבוהה בכל מחיקה, במחיר תהליך תפעולי איטי וסיכון לחוסר אחידות.' },
    ],
    recommendation: 'controlled-purge',
  },
  // §76 and §79 each state their own alternatives in the register; the options below are those,
  // not new ones. Both were raised to owner questions on 30.08.2026 at the owner's instruction.
  'debt:76': {
    plainQuestion: 'האם ניהול צוות הפלטפורמה יחייב אימות בשני שלבים, ומתי?',
    plainContext: 'הפעולה שמוסיפה או מסירה אנשי צוות כבר צומצמה: רק בעל ההרשאה הגבוהה ביותר מבצע אותה, אי אפשר לשנות את עצמך, אי אפשר להסיר את האחרון, והיומן אינו ניתן לעריכה. מה שנשאר הוא שהאישור החוזר לפני הפעולה הוא סיסמה בלבד.',
    whyItMatters: 'זו הפעולה היחידה שיכולה ליצור הרשאה חדשה. חשבון צוות שנגנב יכול להוסיף שותף נוסף בהרשאה הגבוהה ביותר, והמגבלות הקיימות מקטינות את הנזק אך אינן מונעות אותו.',
    whatItDoesNotDo: 'הבחירה אינה מפעילה אימות בשני שלבים ואינה משנה היום אף הרשאה. היא קובעת רק מה יקרה כשהיכולת תהיה זמינה.',
    options: [
      { id: 'mfa-first-when-available', label: 'לחייב אימות בשני שלבים ברגע שהיכולת קיימת', implication: 'זו תהיה היכולת הראשונה שתדרוש אותו ולא האחרונה. עד אז שום דבר לא משתנה, אבל ברגע שהאימות נבנה הפעולה מתחברת אליו מיד.' },
      { id: 'keep-password-until-rollout', label: 'להשאיר סיסמה עד להשקה כללית', implication: 'אפס עבודה עכשיו, והחשיפה נשארת פתוחה: חשבון צוות שנגנב יכול להעניק הרשאה גבוהה נוספת.' },
    ],
    recommendation: 'mfa-first-when-available',
  },
  'debt:79': {
    plainQuestion: 'האם מספיק שמסך הניתוח מוסתר בתפריט, או שצריך לחסום אותו גם בשרת?',
    plainContext: 'שאר סולם המסלולים כבר נאכף בשרת ולא רק במסך. מה שנשאר פתוח הוא מסך הניתוח בלבד: הוא מציג את אותם נתוני ספקים שמסך הספקים — שאינו נעול — מציג ממילא, ולכן חסימה בשרת הייתה לוקחת מספרים שהלקוח רואה מסך אחד משמאל.',
    whyItMatters: 'לקוח במסלול שאינו כולל את הלוח ויקליד את הכתובת יראה אותו. השאלה היא אם זה מקובל, או שווה עבודה נפרדת.',
    whatItDoesNotDo: 'הבחירה אינה משנה את המסלול של אף לקוח ואינה פותחת או סוגרת מסך היום.',
    options: [
      { id: 'accept-menu-only', label: 'לקבל — הסתרה בתפריט בלבד', implication: 'אפס עבודה, וזה המצב היום. מי שיקליד את הכתובת יראה את הלוח, אך לא נתונים שאינו רשאי לראות ממילא.' },
      { id: 'separate-data', label: 'להפריד את נתוני הלוח ואז לחסום', implication: 'המסך ייחסם באמת, במחיר עבודה נפרדת: להפריד את הנתונים שהלוח מציג מאלה שמסך הספקים מציג. חסימה בשרת בלבד אינה מספיקה כאן.' },
    ],
    recommendation: 'accept-menu-only',
  },
};

const NEXT_ACTION_OVERRIDES = {
  'debt:8': 'להרחיב את בדיקת הבטיחות כך שתכסה את כל הפקודות העסקיות המבוקרות, בלי לשנות את דרך רישום האירועים.',
  'debt:9': 'להוסיף בדיקה אוטומטית שמונעת הוספת שינוי למסד אם הוא אינו מריץ מחדש את בדיקות הבטיחות.',
  'debt:10': 'להחליט בצוות הפיתוח אם להגביל את הספירה לפי תפקיד או להריץ אותה במסלול מוגן, ואז להוכיח שכל התפקידים מקבלים תוצאה נכונה.',
  'debt:14': 'לפני שמציגים את מסנן הכפילויות במסך נוסף, למדוד את העלות ולבחור אינדקס מתאים, ספירה מתוכננת או ויתור על המסנן.',
  'debt:15': 'לקבוע רף כמות שורות. מעליו לעבור לאומדן מהיר ולכתוב למשתמש “כ־N” במקום להציג מספר מדויק שאיטי לחשב.',
  'debt:31': 'לחדש אוטומטית את חלון הזמן בזמן העלאת צילום ארוכה, ולבדוק שאותה תמונה אינה נלקחת לעיבוד פעמיים.',
  'debt:37': 'לבחור בין רכישת כלי שיודע לשמור עיצוב Excel, שימוש בתבנית מעוצבת שנבדקה, או הישארות עם קובץ תקין ללא צבעי מותג.',
  'debt:47': 'להפעיל את המתג עבור ארגון בדיקה אחד, להעלות חבילת מסמכים אחת ולוודא שכל מסמך שנוצר ממנה סווג ונקלט נכון.',
  'debt:49': 'להוסיף מסלול שבו מסמך זיכוי שאדם אישר יוצר זיכוי אמיתי במערכת, עם מקור, מניעת כפילות ורישום ביומן.',
  'debt:50': 'להוסיף במסך התשלום בחירת זיכוי וקיזוז חלקי, ולבדוק ששתי פעולות מקבילות אינן מקזזות את אותו סכום פעמיים.',
  'debt:45': 'לבדוק צילום iPhone אמיתי. אם הדפדפן אינו מצליח לקרוא אותו, ליצור עותק שרתי בטוח למדידת איכות ולקריאת המסמך.',
  'debt:42': 'לבנות לבעל העסק מסך לאישור תוצאות הכיול; רק לאחר שכל השורות אושרו, מנהל הפלטפורמה יוכל להפעיל את האוטומציה.',
  'debt:41': 'להוסיף את שומר הכתיבה החסר לשתי הטבלאות, ובאותו שינוי להוסיף בדיקה שמונעת מטבלה חדשה להישאר בלי השומר בעתיד.',
  'debt:53': 'להוסיף חץ קטן ליד גרף שינוי המחיר, כך שכיוון העלייה או הירידה יהיה ברור גם למי שאינו מבחין בין אדום לירוק.',
  'debt:3': 'לממש רק את מנגנון כללי ההתראות שכבר אושר. לא לבנות מנגנון תהליכים כללי או מערכת דוחות ברקע עד שיופיע צורך אמיתי.',
  'debt:5': 'לפני פתיחת חיבור לכתובת שהלקוח מזין, לחסום כתובות פנימיות ומסוכנות, לאמת שהלקוח שולט ביעד ולבצע מסירה חיה ליעד בדיקה.',
  'debt:22': 'כאשר יצטרף ארגון נוסף, להוסיף למנהל הפלטפורמה תצוגה מוגנת של מדיניות האוטומציה בכל ארגון.',
  'debt:25': 'לאמת בעלות על הדומיין, להגדיר את רשומות הדואר וכתובות השולח, ואז לבצע בדיקת מסירה אמיתית לפני הפעלת מייל ללקוחות.',
  'debt:29': 'לבנות פעולה מבוקרת שמבטלת את צריכת הכמות של אישור קודם, עם סיבה, מניעת ביצוע כפול ונעילה מתאימה.',
  'debt:30': 'לבנות תהליך מחיקה מדורג: דוח מועמדים, בדיקת חובת שמירה, ייצוא וגיבוי, אישור מנהל הפלטפורמה ורישום מלא של המחיקה.',
  'debt:34': 'להעביר את חמש הבדיקות שאינן רצות בענן לצורה שמערכת הבדיקות האוטומטית יכולה להריץ, או להוסיף להן סביבת Windows ייעודית.',
  'debt:56': 'להתחיל בספירת משתמשים וספקים פעילים לכל ארגון. לאחר מכן להוסיף מדידת נפח אחסון, שהיא המדידה היקרה יותר.',
  'debt:57': 'לאמת חשבון וסביבת בדיקה אצל ספק הגבייה, ואז לחבר אירועי תשלום חתומים לפקודות שינוי המנוי הקיימות.',
  'debt:58': 'להתחיל בדוח של ארגונים שלא אימתו דוא״ל, אחר כך לבנות תור בדיקה ומחיקה מבוקרת לארגון ריק בלבד.',
  'debt:59': 'לתקן את נתוני מרכז הבקרה כך שיבדילו בין אפס אמיתי, מידע חסר וסירוב הרשאה, ולבדוק את שלושת התפקידים הפעילים.',
  'debt:52': 'לבודד את שתי הבדיקות התנודתיות, להריץ אותן עשר פעמים על מכונה שקטה ולתקן את גורם התזמון המשותף אם הכשל חוזר.',
  'debt:67': 'כאשר שער הדפדפן נכשל, לשמור אוטומטית את יומני שירותי הנתונים כדי שהכשל הבא יאובחן לפי ראיה ולא באמצעות הרצה חוזרת.',
  'debt:66': 'להחליט אם לאשר מסלול מחיקה מבוקר. אם יאושר, לפתוח חלון מחיקה צר בכל שומר רלוונטי ולהוכיח שארגון מלא נמחק עד הסוף.',
  // §84 arrived with the 30.08 merge; its raw step is a shell command, which the plain layer must not carry.
  'debt:84': 'להעביר את המסכים החדשים לתרגום קובץ אחר קובץ בעזרת הכלי שכבר קיים, ואז לעבור על הטקסט האנגלי לפני שהוא נכנס. הכלי משאיר בעברית כל דבר שאינו בטוח להעברה, וזה הרצוי במסכי כספים.',
  'debt:76': 'להחליט אם ניהול צוות הפלטפורמה יחייב אימות בשני שלבים. אם כן — לחבר את הפעולה ליכולת הזאת ברגע שהיא קיימת, ולהוכיח שפעולה בלעדיה נדחית.',
  'debt:79': 'להחליט אם מסך הניתוח יכול להישאר מוסתר בתפריט בלבד. אם לא — להפריד את הנתונים שהוא מציג מאלה שמסך הספקים מציג, ורק אז לחסום אותו בשרת.',
  'debt:65': 'להוסיף בדיקה קטנה לכל בקשת שילוב קוד, שמכשילה אותה בגלוי כאשר בסיס הבקשה אינו ענף הקוד הראשי.',
  'debt:64': 'להוסיף בדיקת פריסה שמסרבת להמשיך כאשר משימת הפירוש מתוזמנת אך הגדרת ההפעלה הסודית חסרה, ולתעד את ההגדרה הידנית.',
  'debt:63': 'בעת רישום החברה, לחתום על הסכם הגנת המידע מול OpenAI, לשמור את האישור ולהסיר את היתר הטרום־השקה הזמני.',
  'debt:61': 'בעת חיבור WhatsApp, לעדכן את שער שליחת ההזמנה כך שיכיר גם במסירה מאושרת דרך מייל ולא יחסום אותה.',
};

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function splitMarkdownRow(line) {
  const cells = [];
  let current = '';
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '|' && line[index - 1] !== '\\') {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells.filter((cell, index) => !(cell === '' && (index === 0 || index === cells.length - 1)));
}

function stripMarkdown(value) {
  return value
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|~~/g, '')
    .replace(/\\\|/g, ' / ')
    .replace(/\s+/g, ' ')
    .trim();
}

function simplify(value) {
  let result = stripMarkdown(value);
  for (const [pattern, replacement] of PLAIN_REPLACEMENTS) result = result.replace(pattern, replacement);
  return result.replace(/\s+/g, ' ').trim();
}

function truncate(value, max = 360) {
  if (value.length <= max) return value;
  const sliced = value.slice(0, max);
  const boundary = sliced.lastIndexOf(' ');
  return `${sliced.slice(0, boundary > 100 ? boundary : max).trim()}…`;
}

function currentDecisionSummary(value) {
  const plain = simplify(value);
  const sentences = plain.split(/(?<=[.!?])\s+/u).filter(Boolean);
  const first = sentences[0] || plain;
  const summary = first.length < 55 && sentences[1] ? `${first} ${sentences[1]}` : first;
  return truncate(summary, 220);
}

function extractNextAction(body) {
  const lines = body.split(/\r?\n/);
  const candidates = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(?:-\s*)?\*\*((?:הצעד|מה עושים|שתי הדרכים)[^*]*)\*\*\s*(.*)$/u);
    if (!match) continue;
    const content = [match[2]];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const continuation = lines[cursor];
      if (!continuation.trim() || /^#{2,3}\s|^(?:-\s*)?\*\*[^*]+\*\*/u.test(continuation)) break;
      content.push(continuation.replace(/^\s+/, ''));
    }
    const labelDetail = match[1].replace(/^(?:הצעד(?: הזול)? הבא(?: הזול)?|מה עושים בינתיים|שתי הדרכים החוצה, ורק הן)\s*[:—-]?\s*/u, '').trim();
    candidates.push(simplify([labelDetail, ...content].filter(Boolean).join(' ')));
  }
  return candidates.at(-1) || '';
}

function debtResponsibility(nextAction, requiresOwnerDecision) {
  if (requiresOwnerDecision) return 'אתה בוחר את הכיוון; צוות הפיתוח מתכנן ומממש רק לאחר הבחירה.';
  if (/הבעלים|רכיש|חתימ|מפעיל את המתג|מאשר/u.test(nextAction)) return 'אתה מבצע או מאשר את הצעד העסקי; צוות הפיתוח מודד ומאמת את התוצאה.';
  return 'צוות הפיתוח מטפל בצעד הטכני. ממך נדרשת רק קביעת עדיפות.';
}

function debtCompletionProof(nextAction) {
  if (/למדוד|להשוות|smoke|בדיק|טסט|סוויט/u.test(nextAction)) return 'החוב נסגר רק כשהפעולה בוצעה והמדידה או הבדיקה המתוארת עברה עם ראיה.';
  if (/אין שינוי|אין\.|לא לכתוב/u.test(nextAction)) return 'החוב נשאר במעקב עד שתתקבל הכרעה או תופיע ראיה שמצדיקה שינוי.';
  return 'החוב נסגר רק אחרי מימוש, בדיקה מתאימה ועדכון רשם החובות עם הראיה.';
}

function debtRecommendation(ids, requiresOwnerDecision) {
  const planNow = ids.some((id) => PLAN_NOW_DEBTS.has(id));
  if (requiresOwnerDecision) {
    return {
      priority: planNow ? 'plan_now' : 'keep_backlog',
      reason: 'החוב דורש קודם בחירת כיוון שלך; לאחר הבחירה אפשר לקבוע את מועד המימוש.',
    };
  }
  return planNow ? {
    priority: 'plan_now',
    reason: 'החוב משפיע על דיוק, אבטחה, כסף, מחיקה או אמינות הבדיקות. מומלץ להכניס אותו לתוכנית הקרובה.',
  } : {
    priority: 'keep_backlog',
    reason: 'החוב תלוי קודם במדידה, בנפח שימוש או בשירות עתידי. מומלץ להשאיר אותו בתור עד שתהיה הראיה המתאימה.',
  };
}

function glossaryFor(source) {
  return TERM_DEFINITIONS
    .filter(([term]) => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(source))
    .map(([term, explanation]) => ({ term, explanation }));
}

function impactAreas(type, section, implications) {
  const isTrust = section.includes('אמון') || section.includes('ציות');
  const isExternal = section.includes('חיצוניים');
  const isPerformance = section.includes('ביצועים');
  return {
    customer: implications[0],
    money: isExternal ? 'ייתכנו עלות ספק או עבודת תפעול; שום חיוב לא יופעל מתוך מסמך ההחלטות.' : 'אין חיוב או שינוי כספי אוטומטי בעקבות הבחירה בדף.',
    privacy: isTrust || isExternal ? 'נדרשת בדיקה שהמידע נשאר בגבולות שנקבעו ושאין הבטחה שאינה מגובה בראיה.' : 'לא צפויה חשיפה חדשה של מידע; שינוי עתידי עדיין יעבור בדיקת הרשאות.',
    security: isTrust ? 'זהו נושא רגיש: המימוש חייב להוכיח מה נחסם, לא רק מה מצליח.' : 'השינוי אינו עוקף הרשאות קיימות וייבדק לפני חיבור למוצר.',
    effort: isPerformance ? 'עבודה בינונית שתתחיל במדידה לפני שינוי.' : type === 'debt' ? 'עבודה נפרדת שדורשת תכנון, בדיקות וקבלה.' : 'היקף העבודה ייקבע בתוכנית המימוש לאחר אישור ההחלטה.',
  };
}

// The register states an unsettled row as "**פתוח — טרם הוכרע**". Read that instead of
// pinning an id: a decision added later is open on its own words, not by being listed here.
const UNSETTLED_DECISION = /\*\*\s*פתוח\s*[—–-]\s*טרם\s+הוכרע/u;

function decisionStatus(id, source) {
  if (UNSETTLED_DECISION.test(source)) return 'needs-owner-decision';
  if (id === 68) return 'implementation-gap';
  if (/NOT_IMPLEMENTED|טרם מומש|לא מומש|פער מימוש/.test(source)) return 'decided-pending';
  return 'decided-history';
}

function decisionItem({ id, line, lineNumber, section }) {
  const cells = splitMarkdownRow(line);
  const sourceTitle = simplify(cells[1] || `החלטה ${id}`);
  const currentDecisionPlain = currentDecisionSummary(cells[2] || 'ההחלטה מתועדת במסמך המקור.');
  const key = `decision:${id}`;
  const override = OVERRIDES[key] || {};
  const status = decisionStatus(id, line);
  const implications = DECISION_IMPACTS;
  return {
    key,
    type: 'decision',
    sourceId: String(id),
    sourceIds: [String(id)],
    sourceLine: lineNumber,
    sourceHash: sha256(line),
    section,
    sourceTitle,
    sourceDetails: line,
    plainQuestion: override.plainQuestion || sourceTitle,
    plainContext: override.plainContext || `הנושא “${sourceTitle}” מתועד במאגר ההחלטות. הבחירה הקיימת מוצגת כאן כדי שתוכל להבין אותה ולבקש שינוי בלי למחוק את ההיסטוריה.`,
    currentDecisionPlain: override.currentDecisionPlain || currentDecisionPlain,
    whyItMatters: override.whyItMatters || 'ההחלטה קובעת כלל עסקי או התנהגות שהמערכת והצוות צריכים לפעול לפיהם באופן עקבי.',
    implications,
    impactAreas: impactAreas('decision', section, implications),
    whatItDoesNotDo: override.whatItDoesNotDo || 'הצגה או בחירה בדף הזה אינה משנה מיד קוד, נתונים, הרשאות או סביבת ייצור.',
    status,
    requiresOwnerDecision: status === 'needs-owner-decision',
    changeMode: status === 'needs-owner-decision' ? 'direct-answer' : 'reconsideration-only',
    options: override.options || [],
    recommendation: override.recommendation || null,
    glossary: glossaryFor(line),
  };
}

function debtItem({ heading, body, lineNumber, section }) {
  const identifierMatch = heading.match(/^§(\d+)(?:\s*\/\s*§(\d+))?/);
  const ids = identifierMatch ? identifierMatch.slice(1).filter(Boolean) : [];
  const keySuffix = ids.join('-');
  const key = `debt:${keySuffix}`;
  const sourceTitle = simplify(heading.replace(/^§\s*/, '').replace(/^\d+(?:\s*\/\s*§?\d+)?\s*[—-]?\s*/, ''));
  const override = OVERRIDES[key] || {};
  const closed = CLOSED_DEBT_HEADING.test(heading);
  const requiresOwnerDecision = !closed && ids.some((id) => OWNER_CHOICE_DEBTS.has(id));
  const nextAction = NEXT_ACTION_OVERRIDES[key] || extractNextAction(body);
  const responsibility = debtResponsibility(nextAction, requiresOwnerDecision);
  const recommendation = debtRecommendation(ids, requiresOwnerDecision);
  const implications = IMPACTS_BY_CATEGORY.get(section) || [
    'הפער מתועד כדי שלא ייעלם בין משימות אחרות.',
    'טיפול בו דורש מימוש ובדיקה נפרדים לפני שינוי במוצר.',
  ];
  return {
    key,
    type: 'debt',
    sourceId: keySuffix,
    sourceIds: ids,
    sourceLine: lineNumber,
    sourceHash: sha256(body),
    section,
    sourceTitle,
    sourceDetails: body,
    plainQuestion: override.plainQuestion || `מה צריך לעשות לגבי ${sourceTitle}?`,
    plainContext: closed
      ? `הנושא “${sourceTitle}” נסגר. הוא נשאר כאן כתיעוד של מה שהיה ואיך זה נפתר, ואינו דורש ממך פעולה.`
      : override.plainContext || `נשאר פער פעיל בנושא “${sourceTitle}”. הוא מוצג כאן כדי להבין את ההשפעה ולא כדי להמציא שאלה עסקית שאינה נדרשת.`,
    currentDecisionPlain: closed ? 'הנושא נסגר ואינו חוב פעיל.' : 'הנושא עדיין פתוח כחוב פעיל.',
    whyItMatters: override.whyItMatters || implications[0],
    implications,
    impactAreas: impactAreas('debt', section, implications),
    whatItDoesNotDo: override.whatItDoesNotDo || 'הצגת החוב אינה משנה את המוצר ואינה מפעילה שירות או כתיבה לנתונים.',
    nextAction: closed ? 'אין צעד המשך. החוב נסגר, והראיה רשומה ברשם החובות.' : nextAction,
    responsibility: closed ? 'אין טיפול פתוח. הפריט נשמר כתיעוד בלבד.' : responsibility,
    ownerInstruction: closed ? 'לא נדרשת ממך פעולה.' : requiresOwnerDecision ? 'בחר אחת מהאפשרויות המוצגות. לאחר מכן הסוכן יוכל להפוך אותה לתוכנית מימוש.' : 'אל תבחר פתרון טכני. קבע רק אם לקדם עכשיו, להשאיר בתור או לבקש הסבר נוסף.',
    completionProof: closed ? 'החוב כבר נסגר.' : debtCompletionProof(nextAction),
    recommendedPriority: recommendation.priority,
    recommendationReason: recommendation.reason,
    status: closed ? 'decided-history' : requiresOwnerDecision ? 'needs-owner-decision' : 'technical-debt',
    closed,
    requiresOwnerDecision,
    changeMode: requiresOwnerDecision ? 'direct-answer' : 'information-only',
    options: override.options || [],
    recommendation: override.recommendation || null,
    glossary: glossaryFor(body),
  };
}

function parseDecisions(text) {
  const lines = text.split(/\r?\n/);
  const items = [];
  let section = 'החלטות כלליות';
  lines.forEach((line, index) => {
    const sectionMatch = line.match(/^##+\s+(.+)$/);
    if (sectionMatch) section = simplify(sectionMatch[1]);
    const rowMatch = line.match(/^\|\s*(\d+)\s*\|/);
    if (!rowMatch) return;
    items.push(decisionItem({ id: Number(rowMatch[1]), line, lineNumber: index + 1, section }));
  });
  return items;
}

function parseDebts(text) {
  const lines = text.split(/\r?\n/);
  const headings = [];
  let section = 'חוב פעיל';
  lines.forEach((line, index) => {
    const sectionMatch = line.match(/^##\s+(.+)$/);
    if (sectionMatch) section = simplify(sectionMatch[1]);
    if (/^###\s+§/.test(line)) headings.push({ line, lineNumber: index + 1, index, section });
  });
  return headings.map((entry, position) => {
    const end = headings[position + 1]?.index ?? lines.length;
    const body = lines.slice(entry.index, end).join('\n').trim();
    return debtItem({ heading: entry.line.replace(/^###\s+/, ''), body, lineNumber: entry.lineNumber, section: entry.section });
  });
}

export async function buildCatalog({ rootDir, sourceCommit }) {
  const [decisionsText, debtsText] = await Promise.all([
    readFile(path.join(rootDir, 'docs', 'OPEN-DECISIONS.md'), 'utf8'),
    readFile(path.join(rootDir, 'docs', 'DEBT-REGISTER.md'), 'utf8'),
  ]);
  const decisions = parseDecisions(decisionsText);
  const debts = parseDebts(debtsText);
  return {
    schemaVersion: 1,
    sourceCommit,
    generatedAt: new Date().toISOString(),
    counts: { decisions: decisions.length, debts: debts.length },
    sourceFiles: {
      decisions: sha256(decisionsText),
      debts: sha256(debtsText),
    },
    items: [...decisions, ...debts],
  };
}

export { simplify, splitMarkdownRow };
