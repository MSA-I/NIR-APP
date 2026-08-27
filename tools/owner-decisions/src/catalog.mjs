import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const OWNER_CHOICE_DEBTS = new Set(['20', '37', '66']);

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
  [/webhooks?/gi, 'הודעות אוטומטיות בין מערכות'],
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

function decisionStatus(id, source) {
  if (id === 270) return 'needs-owner-decision';
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
  const requiresOwnerDecision = ids.some((id) => OWNER_CHOICE_DEBTS.has(id));
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
    plainContext: override.plainContext || `נשאר פער פעיל בנושא “${sourceTitle}”. הוא מוצג כאן כדי להבין את ההשפעה ולא כדי להמציא שאלה עסקית שאינה נדרשת.`,
    currentDecisionPlain: 'הנושא עדיין פתוח כחוב פעיל.',
    whyItMatters: override.whyItMatters || implications[0],
    implications,
    impactAreas: impactAreas('debt', section, implications),
    whatItDoesNotDo: override.whatItDoesNotDo || 'הצגת החוב אינה משנה את המוצר ואינה מפעילה שירות או כתיבה לנתונים.',
    status: requiresOwnerDecision ? 'needs-owner-decision' : 'technical-debt',
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
