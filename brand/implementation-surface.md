# משטח הטמעת המותג — InPlace

עודכן: 21.08.2026. מסמך זה מתאר את מצב ה־runtime לאחר אישור הלוגו הסופי.

## נכסים קנוניים

| שימוש | נכס |
|---|---|
| לוח מקור ו־signoff | `brand/assets/inplace-brand-board-3x3.svg` |
| lockup ראשי / הפוך | `brand/assets/inplace-lockup.svg` · `inplace-lockup-paper.svg` |
| סמל ראשי / הפוך | `brand/assets/inplace-symbol.svg` · `inplace-symbol-paper.svg` |
| וריאציות | `inplace-symbol-muted.svg` · `inplace-symbol-accent.svg` · `inplace-symbol-accent-dot.svg` |
| app icon | `inplace-app-icon.svg` · `inplace-app-icon-maskable.svg` |
| runtime SVG | `public/brand/` |
| favicon / PWA / push | `public/icons/icon-192.png` · `icon-512.png` · `icon-512-maskable.png` |

ה־SVG הסופי שטוח וכולל paths בלבד. לכן ה־wordmark נשמר בדיוק ואינו תלוי ב־Manrope, Segoe UI או
פונט מערכת. סקריפט החילוץ בוחר את אזורי ה־signoff, מנרמל צבעים ל־hex, מפיק inverse נגזר ומרנדר
את קובצי ה־PNG. אין לערוך path ידנית; שינוי מקור מחייב הפקה מחדש ומדידות חדשות.

## צרכני runtime

- `Login`, ‏`AcceptInvite`, ‏`ForgotPassword`, ‏`ResetPassword` ו־`Legal` מציגים inverse lockup.
- `Layout` משתמש ב־app icon כ־fallback רק כאשר לארגון אין לוגו משלו.
- `index.html` ו־`manifest.webmanifest` צורכים את קובצי ה־PNG הקבועים.
- `sw.js` משתמש ב־`icon-192.png` ל־push icon ול־badge.

כתובות הנכסים הקיימות נשמרו כדי ש־favicon, התקנת PWA, precache ו־push לא יישברו. build חדש מעדכן
את revision של ה־service worker ומחליף את cache המעטפת.

## גבולות

- אין שינוי בטוקני `src/index.css`, ב־theme/background של manifest או בצבעי סטטוס.
- אין שינוי ב־`APP_NAME`, בחוזי wire, במפתחות cache/IndexedDB, בשמות Supabase או בשם פרויקט Pages.
- מיתוג דייר נשאר נפרד: `0098_organization_branding.sql` ו־`src/lib/organizationBranding.ts` אינם
  נכסי מוצר ואינם משתנים בהחלפת הלוגו.
- המחרוזת `supplyflow` נשארת במזהי תשתית היסטוריים שבהם שינוי מכני ישבור תאימות.

## אימות נדרש

כל שינוי עתידי בלוגו חייב לכלול: SHA-256 למקור ולנגזרות, בדיקת dimensions/alpha ל־PNG, רינדור
ויזואלי של lockup והאייקונים, בדיקת maskable safe zone, וצילומי מסך של auth ושל shell בדסקטופ
ובמובייל. שינוי ויזואלי אינו סגור ללא ההשוואה הזו.
