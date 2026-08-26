import { Link } from 'react-router';
import { APP_NAME } from '../lib/branding';
import { Card } from '../components/ui';

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
 *
 * 2026-08-24 — version bumped for one deletion: the privacy policy used to state flatly that a
 * document sent for interpretation is not stored at the model provider. `store: false` is an API
 * REQUEST, not the provider's undertaking — docs/ASSISTANT.md §5.1 says so in the same repository —
 * and OPEN-DECISIONS #179 forbids promising zero retention without a contract that proves it. A
 * consent document is the last place a promise nobody can back belongs, so the sentence now says
 * what the system actually does and what it does not know.
 *
 * 2026-08-24, same version, second change — and deliberately the SAME version rather than a second
 * bump. The deletion above shipped nowhere: it was merged and never deployed, so no consent was
 * ever stamped against the intermediate text. The version a user will actually consent to is this
 * one, and stamping two different documents with one string is only a lie if both were served.
 *
 * What this change adds is section 3, and it exists because the #179 evidence was finally gathered
 * from OpenAI's own dated pages (docs/ASSISTANT-ACTIVATION-EVIDENCE.md §1). Removing a promise we
 * could not keep was half the work; the other half is saying what actually happens. Three facts a
 * reader has no way to discover and every right to know: inputs may be retained for up to 30 days
 * with two open-ended extensions in the provider's own wording; those abuse logs are readable by
 * the provider's authorised employees AND by third-party contractors; and no regional restriction
 * is configured, Israel is not even an available region, and provider-side "system data" leaves any
 * region regardless. Section 2 keeps the sub-processor list; the provider-side facts get their own
 * heading rather than a clause at the end of a dense paragraph, because a disclosure buried in
 * prose is the same half-truth in a politer form.
 */
export const TERMS_VERSION = '2026-08-24';

function LegalShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-action px-4 py-6 sm:py-10">
      <div className="max-w-2xl mx-auto space-y-4">
        {/* The lockup is the product's mark, not this document's title. It used to be the page's
            only <h1>, which left the actual subject — „תנאי שימוש" — as an <h2> with no h1 above
            it. The mark keeps its alt text and stops being a heading; the title becomes the h1.
            Same treatment on all four standalone auth screens. */}
        <div className="text-center">
          <img src="/brand/inplace-lockup-paper.svg" alt={APP_NAME} width="166" height="36"
            className="mx-auto h-auto w-40" />
        </div>
        <Card className="space-y-4">
          <h1 className="page-title">{title}</h1>
          <p className="text-xs text-ink-muted">גרסה: {TERMS_VERSION}</p>
          <div className="space-y-4 text-sm leading-relaxed text-ink-mid [&_h3]:font-semibold [&_h3]:text-ink [&_h3]:mt-2">
            {children}
          </div>
          <div className="pt-3 border-t border-line-soft flex gap-4 text-sm">
            <Link className="link" to="/terms">תנאי שימוש</Link>
            <Link className="link" to="/privacy">מדיניות פרטיות</Link>
            <Link className="link" to="/login">מסך הכניסה</Link>
          </div>
        </Card>
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
          האפליקציה), ‏Resend (משלוח מיילים תפעוליים) ו-Sentry (דיווח תקלות). המפעילה אינה
          מוכרת מידע אישי ואינה משתמשת בו לפרסום.
        </p>
      </section>
      <section>
        <h3>3. מה קורה אצל ספק המודל</h3>
        <p>
          כשמסמך נשלח לפירוש אוטומטי, תוכנו מגיע ל-OpenAI. הפרטים שלהלן נבדקו בתנאים הרשמיים
          של הספק ב-24.08.2026, והם תיאור של מה שהספק אומר — לא התחייבות של המפעילה במקומו.
        </p>
        <p>
          <strong>אימון:</strong> לפי תנאי הספק, נתונים שנשלחים דרך ה-API אינם משמשים לאימון
          מודלים, אלא אם הארגון בחר במפורש לשתף אותם. המפעילה לא בחרה בכך.{' '}
          <strong>שמירה:</strong> הספק רשאי לשמור קלט ופלט <strong>עד 30 יום</strong> לצורך
          מתן השירות ואיתור שימוש לרעה, ולתקופה ארוכה יותר אם הדין מחייב או אם הדבר נדרש
          להגנה על השירות או על צד שלישי מפני נזק.{' '}
          <strong>עיון אנושי:</strong> יומני השימוש-לרעה עשויים לכלול את הטקסט עצמו, ולפי תנאי
          הספק הם נגישים לעובדים מורשים שלו <strong>וגם לקבלני צד-שלישי</strong> המחויבים
          בסודיות, לצורך בדיקת שימוש לרעה בלבד.
        </p>
        <p>
          <strong>מה שהמערכת עושה, ומה שאין בו הבטחה:</strong> בכל קריאה המערכת מבקשת מהספק שלא
          לשמור את התשובה לשליפה מאוחרת (‏store: false). זו בקשה בממשק הספק ולא
          התחייבות שלו, והיא <strong>אינה</strong> מונעת את יומני השימוש-לרעה שתוארו למעלה.
          הסדר של אפס-שימור אצל הספק דורש אישור מוקדם והסכם נפרד; כל עוד אין הסכם כזה,{' '}
          <strong>המפעילה אינה מבטיחה אפס-שימור</strong>.
        </p>
        <p>
          <strong>מיקום העיבוד:</strong> לא הוגדרה הגבלת אזור מול הספק, ולכן העיבוד והאחסון
          הזמני אצלו עשויים להתבצע מחוץ לישראל, לרבות מחוץ לאיחוד האירופי. ישראל אינה אזור
          נתמך אצל הספק. גם במסלולי הגבלת אזור, נתוני מערכת ומטא-דאטה עשויים לצאת מהאזור.
        </p>
      </section>
      <section>
        <h3>4. הפרדת לקוחות ואבטחה</h3>
        <p>
          נתוני כל לקוח מופרדים ברמת מסד הנתונים (Row-Level Security לפי ארגון), הגישה מוצפנת
          (TLS), פעולות רגישות דורשות אימות סיסמה טרי, וקבצים נשמרים בדלי פרטי שהגישה אליו
          מוגבלת לארגון בלבד.
        </p>
      </section>
      <section>
        <h3>5. שמירה ומחיקה</h3>
        <p>
          רשומות כספיות נשמרות לאורך תקופת ההתקשרות ובהתאם לחובות שמירת רשומות שבדין. מחיקת
          רשומות כספיות היא "מחיקה רכה" המשמרת עקיבות ביקורת. עם סיום ההתקשרות ניתן לבקש העתק
          של הנתונים ומחיקה של מה שאין חובה חוקית לשמור.
        </p>
      </section>
      <section>
        <h3>6. הזכויות שלך</h3>
        <p>
          בהתאם לחוק הגנת הפרטיות, התשמ"א-1981 (כפי שתוקן בתיקון 13), עומדת לך זכות לעיין במידע
          שנאסף עליך, לבקש תיקון מידע שגוי ולבקש מחיקה בכפוף לחובות שבדין. פנייה בנושא — אל איש
          הקשר של העסק שהזמין אותך, או אל מפעילת השירות.
        </p>
      </section>
      <section>
        <h3>7. עוגיות ואחסון מקומי</h3>
        <p>
          השירות משתמש באחסון מקומי בדפדפן לניהול ההתחברות ולעבודה לא-מקוונת (טיוטות קבלה
          וצילומים שממתינים לחיבור). אין שימוש בעוגיות פרסום או מעקב צד-שלישי.
        </p>
      </section>
    </LegalShell>
  );
}
