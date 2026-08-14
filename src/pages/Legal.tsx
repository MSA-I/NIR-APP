import { Link } from 'react-router';
import { APP_NAME } from '../lib/branding';

/**
 * Terms of service + privacy policy (package 7, owner decision 09.08.2026: the agent drafts).
 *
 * The version is what a user consents TO: accept_invitation (0089) refuses to create a
 * profile without it, and stamps it into audit_logs. Changing the TEXT in any way that
 * matters legally must bump TERMS_VERSION — an unchanged version over changed terms would
 * make every stored consent a lie.
 *
 * Drafted with the requirements of תיקון 13 לחוק הגנת הפרטיות (in force 14.08.2025) in view:
 * what is collected, for what purpose, on what legal basis, who processes it, and the data
 * subject's rights. Two honest gaps are recorded in OPEN-DECISIONS: the operator's legal
 * identity/contact details are placeholders the owner must fill before marketing the
 * product, and this drafting is NOT legal advice — a lawyer's review is the owner's call.
 */
export const TERMS_VERSION = '2026-08-09';

function LegalShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-shell py-8 px-4">
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-white">{APP_NAME}</h1>
        </div>
        <div className="card card-pad space-y-4">
          <h2 className="page-title">{title}</h2>
          <p className="text-xs text-ink-muted">גרסה: {TERMS_VERSION}</p>
          <div className="space-y-4 text-sm leading-relaxed text-ink-mid [&_h3]:font-semibold [&_h3]:text-ink [&_h3]:mt-2">
            {children}
          </div>
          <div className="pt-3 border-t border-line-soft flex gap-4 text-sm">
            <Link className="link" to="/terms">תנאי שימוש</Link>
            <Link className="link" to="/privacy">מדיניות פרטיות</Link>
            <Link className="link" to="/login">מסך הכניסה</Link>
          </div>
        </div>
      </div>
    </div>
  );
}

export function TermsOfService() {
  return (
    <LegalShell title="תנאי שימוש">
      <section>
        <h3>1. השירות</h3>
        <p>
          {APP_NAME} היא מערכת לניהול רכש, חשבוניות ותשלומים לעסקים ("השירות"), המופעלת על ידי
          מפעילת השירות ("המפעילה"). השימוש בשירות מיועד לעסקים ולמשתמשים שהוזמנו על ידי עסק
          ("הלקוח"), והוא כפוף לתנאים אלה. הצטרפות לשירות מהווה הסכמה לתנאים ולמדיניות הפרטיות.
        </p>
      </section>
      <section>
        <h3>2. חשבונות והרשאות</h3>
        <p>
          כל משתמש פועל תחת חשבון אישי ובתפקיד שהוגדר לו על ידי הלקוח. המשתמש אחראי לשמירת
          סודיות פרטי ההתחברות שלו ולכל פעולה שתבוצע מחשבונו. פעולות רגישות נרשמות ביומן ביקורת.
        </p>
      </section>
      <section>
        <h3>3. הנתונים של הלקוח</h3>
        <p>
          הנתונים העסקיים שהלקוח מזין או מעלה (ספקים, הזמנות, חשבוניות, מסמכים) שייכים ללקוח.
          המפעילה מעבדת אותם אך ורק לצורך מתן השירות, כמפורט במדיניות הפרטיות, ואינה מוכרת אותם
          לצדדים שלישיים.
        </p>
      </section>
      <section>
        <h3>4. עיבוד אוטומטי של מסמכים</h3>
        <p>
          השירות כולל קריאה ופירוש אוטומטיים של מסמכים (OCR ומודל בינה מלאכותית). תוצאת הפירוש
          עשויה להיות שגויה; היא מסומנת ככזו כשהביטחון נמוך, וניתנת תמיד לבדיקה ולביטול על ידי
          משתמש מורשה. האחריות על נכונות הרשומות הכספיות מוטלת בסופו של דבר על הלקוח.
        </p>
      </section>
      <section>
        <h3>5. זמינות ואחריות</h3>
        <p>
          המפעילה פועלת לזמינות גבוהה של השירות אך אינה מתחייבת לזמינות רציפה. השירות ניתן כפי
          שהוא (AS-IS). המפעילה לא תישא באחריות לנזק עקיף או תוצאתי; אחריותה הכוללת מוגבלת לסכום
          ששילם הלקוח בגין השירות בשנים-עשר החודשים שקדמו לאירוע. אין באמור לגרוע מאחריות שלא
          ניתן להגבילה על פי דין.
        </p>
      </section>
      <section>
        <h3>6. סיום והתנתקות</h3>
        <p>
          הלקוח רשאי להפסיק את השימוש בכל עת. עם סיום ההתקשרות זכאי הלקוח לקבל העתק של נתוניו
          בפורמט מקובל, בפנייה למפעילה. המפעילה רשאית להשעות חשבון בשל הפרה מהותית של תנאים אלה,
          בהודעה מנומקת.
        </p>
      </section>
      <section>
        <h3>7. שינוי בתנאים ודין</h3>
        <p>
          עדכון מהותי בתנאים ילווה בעדכון מספר הגרסה ובהודעה למשתמשים. על תנאים אלה חל הדין
          הישראלי, וסמכות השיפוט נתונה לבתי המשפט המוסמכים בישראל.
        </p>
      </section>
    </LegalShell>
  );
}

export function PrivacyPolicy() {
  return (
    <LegalShell title="מדיניות פרטיות">
      <section>
        <h3>1. מה נאסף, ולמה</h3>
        <p>
          <strong>פרטי חשבון:</strong> שם, כתובת אימייל, טלפון (אופציונלי) ותפקיד — לצורך זיהוי,
          הרשאות והתחברות. <strong>נתונים עסקיים:</strong> ספקים, הזמנות, חשבוניות, תשלומים
          ומסמכים שהלקוח מעלה — לצורך מתן השירות עצמו. <strong>יומני פעילות:</strong> פעולות
          רגישות נרשמות ביומן ביקורת עם זהות המבצע והסיבה — לצורך אבטחה ואחריותיות.
          <strong> נתונים טכניים:</strong> אסימוני התחברות והתראות דחיפה במכשיר — לצורך תפעול.
          הבסיס החוקי לעיבוד: קיום ההתקשרות עם הלקוח והסכמת המשתמש בעת ההצטרפות.
        </p>
      </section>
      <section>
        <h3>2. מי מעבד את הנתונים</h3>
        <p>
          הנתונים מאוחסנים ומעובדים אצל ספקי משנה המשמשים את השירות: ‏Supabase (מסד נתונים,
          אימות ואחסון קבצים), ‏OpenAI (פירוש אוטומטי של תוכן מסמכים שהועלו), ‏Cloudflare (אירוח
          האפליקציה), ‏Resend (משלוח מיילים תפעוליים) ו-Sentry (דיווח תקלות). מסמך שנשלח לפירוש
          אינו נשמר אצל ספק המודל (store: false). המפעילה אינה מוכרת מידע אישי ואינה משתמשת בו
          לפרסום.
        </p>
      </section>
      <section>
        <h3>3. הפרדת לקוחות ואבטחה</h3>
        <p>
          נתוני כל לקוח מופרדים ברמת מסד הנתונים (Row-Level Security לפי ארגון), הגישה מוצפנת
          (TLS), פעולות רגישות דורשות אימות סיסמה טרי, וקבצים נשמרים בדלי פרטי שהגישה אליו
          מוגבלת לארגון בלבד.
        </p>
      </section>
      <section>
        <h3>4. שמירה ומחיקה</h3>
        <p>
          רשומות כספיות נשמרות לאורך תקופת ההתקשרות ובהתאם לחובות שמירת רשומות שבדין. מחיקת
          רשומות כספיות היא "מחיקה רכה" המשמרת עקיבות ביקורת. עם סיום ההתקשרות ניתן לבקש העתק
          של הנתונים ומחיקה של מה שאין חובה חוקית לשמור.
        </p>
      </section>
      <section>
        <h3>5. הזכויות שלך</h3>
        <p>
          בהתאם לחוק הגנת הפרטיות, התשמ"א-1981 (כפי שתוקן בתיקון 13), עומדת לך זכות לעיין במידע
          שנאסף עליך, לבקש תיקון מידע שגוי ולבקש מחיקה בכפוף לחובות שבדין. פנייה בנושא — אל איש
          הקשר של העסק שהזמין אותך, או אל מפעילת השירות.
        </p>
      </section>
      <section>
        <h3>6. עוגיות ואחסון מקומי</h3>
        <p>
          השירות משתמש באחסון מקומי בדפדפן לניהול ההתחברות ולעבודה לא-מקוונת (טיוטות קבלה
          וצילומים שממתינים לחיבור). אין שימוש בעוגיות פרסום או מעקב צד-שלישי.
        </p>
      </section>
    </LegalShell>
  );
}
