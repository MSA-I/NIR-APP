# תבניות המייל של Supabase Auth — קבצים שהרכז מחיל

חמש התבניות שכאן הן **המקור** לנוסח שהפרויקט המאוחסן שולח. הן אינן נטענות בזמן ריצה: Supabase
מחזיקה אותן בהגדרות הפרויקט, והקבצים כאן הם מה שנכנס לשם ומה שנקרא בביקורת. שינוי נוסח נעשה כאן
**ואז** מוחל — קובץ שהשתנה בלי שהוחל הוא נוסח שאיש אינו מקבל.

## למה כולן מצביעות לכתובת אחת

מ-02.09.2026 הלקוח נוצר עם `flowType: 'pkce'` (`src/lib/supabase.ts`). ‏PKCE שומר אסימונים מחוץ
לשורת הכתובת, אבל הוא קושר את ההחלפה ל**דפדפן שפתח את התהליך**: ה-code verifier נשמר שם. מייל
נפתח לעיתים קרובות במכשיר אחר לגמרי, ולכן קישור `code=` היה נשבר בדיוק במקרה שהכי כואב — „הקישור
עובד במחשב ולא בטלפון".

לכן כל מייל מצביע ל-`/auth/confirm` עם **token hash**: סוד חד-פעמי שנולד במייל, שאפשר לפדות בכל
דפדפן, בלי verifier. המסך פודה אותו ב-`supabase.auth.verifyOtp({ token_hash, type })` ומנתב הלאה
(`src/pages/AuthConfirm.tsx`, `src/lib/authConfirm.ts`).

## מיפוי: קובץ → סוג → שדה ב-Management API

הקבצים מוחלים על `PATCH https://api.supabase.com/v1/projects/{ref}/config/auth`. לכל תבנית שני
שדות רלוונטיים — הנושא והגוף; מה שכאן הוא **הגוף**.

| קובץ | `type=` בקישור | שדה הגוף | שדה הנושא |
|---|---|---|---|
| `confirmation.html` | `signup` | `mailer_templates_confirmation_content` | `mailer_subjects_confirmation` |
| `invite.html` | `invite` | `mailer_templates_invite_content` | `mailer_subjects_invite` |
| `magic-link.html` | `magiclink` | `mailer_templates_magic_link_content` | `mailer_subjects_magic_link` |
| `recovery.html` | `recovery` | `mailer_templates_recovery_content` | `mailer_subjects_recovery` |
| `email-change.html` | `email_change` | `mailer_templates_email_change_content` | `mailer_subjects_email_change` |

הנושאים אינם קבצים כאן — הם שורה אחת כל אחד, ונקבעים באותה קריאה:

| שדה | נוסח |
|---|---|
| `mailer_subjects_confirmation` | אישור כתובת הדואר ובחירת סיסמה ב-InPlace |
| `mailer_subjects_invite` | הוזמנתם להצטרף לעסק ב-InPlace |
| `mailer_subjects_magic_link` | קישור הכניסה שלכם ל-InPlace |
| `mailer_subjects_recovery` | איפוס הסיסמה שלכם ב-InPlace |
| `mailer_subjects_email_change` | אישור כתובת הדואר החדשה ב-InPlace |

**‏Google OAuth אינו צריך תבנית.** הספק מוכיח את הכתובת בעצמו ואינו עובר במייל.

## שני כללים שהתבניות תלויות בהם

1. **‏`{{ .RedirectTo }}` מוזרק כמו שהוא, לא מקודד.** לכן האפליקציה לעולם אינה מוסרת יעד עם יותר
   מפרמטר שאילתה אחד: `AcceptInvite` שולחת `/accept-invite?token=…` ו-`AcceptOperatorInvite`
   שולחת `/operator-invite?token=…` — פרמטר אחד כל אחת. יעד עם `&` היה נקרא כפרמטר של
   `/auth/confirm` עצמו, והטוקן של ההזמנה היה נעלם בדרך.
2. **‏`{{ .RedirectTo }}` ריק אינו „שורש האתר".** כשלא נמסר `redirect_to`, ‏GoTrue מציב שם את
   ה-Site URL של הפרויקט. ‏`sameOriginNext` (`src/lib/authConfirm.ts`) קורא נתיב `/` כ„אין יעד",
   ולכן בעלים טרי מגיע ל-`/set-password` ולא לדשבורד בלי סיסמה. זה בכוונה: מייל אישור ההרשמה הוא
   בדיוק הקישור שאינו מוסר `redirect_to`, מפני ש-`public-signup` **אינו** קורא את כותרת ה-Origin
   של הקורא — כתובת יעד שנבחרת על ידי בקשה אנונימית היא הפניה פתוחה עם חיבור מחובר עליה.

## מה עוד צריך להיות מוגדר בפרויקט המאוחסן

- **‏`Site URL`** — מקור האפליקציה. הוא מה שנכנס ל-`{{ .SiteURL }}` בכל חמש התבניות.
- **‏`Redirect URLs`** — חייבים לכלול את `{origin}/accept-invite`, ‏`{origin}/operator-invite`
  ו-`{origin}/reset-password`. יעד שאינו ברשימה נדחה על ידי GoTrue והמייל יוצא בלי `next`.
- **‏`Mailer autoconfirm = false`.** ‏`0282` ו-`0289` שניהם נשענים על `email_confirmed_at`; עם
  autoconfirm דלוק הכתובת „מאושרת" בלי שאיש קרא מייל.

## מה לא נבדק כאן

הקבצים לא הוחלו על אף פרויקט מהענף הזה ולא נשלח מהם מייל אמיתי. ההגדרות המאוחסנות הן פעולת
בעלים/רכז, והראיה שהן הוחלו היא קריאת `GET /config/auth` שמחזירה את אותו גוף — לא קיומו של הקובץ.
