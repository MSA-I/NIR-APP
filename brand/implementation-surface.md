# משטח ההטמעה — מ־SupplyFlow ל־InPlace

מסמך זה **אינו חלק מהתבנית**. הוא נוסף כדי ששלב 4 („הטמעה בקוד”) יהיה רשימת ביצוע ולא מיפוי מחדש.
נכון ל־18.08.2026, לפני כל שינוי קוד. הזהות כאן היא **קונספט בלבד** — המוצר עדיין נושא את השם
SupplyFlow.

## 1. השם בזמן ריצה

יש קבוע מרכזי אחד, והוא **אינו** מכסה הכול:

```ts
// src/lib/branding.ts:8
export const APP_NAME = 'SupplyFlow';
```

הקבוע מכסה את מסכי React בלבד: ‏`Layout.tsx` (‏sidebar, top bar נייד ו־`document.title` בשורות
‏167/220/227), ‏`Login.tsx:84`, ‏`AcceptInvite.tsx:198`, ‏`ForgotPassword.tsx:49`,
‏`ResetPassword.tsx:88`, ‏`Legal.tsx:25`.

**שבעה מקומות נוספים מקודדים את השם בנפרד ולא ייתפסו על ידי שינוי הקבוע:**

| קובץ:שורה | מה יש שם |
|---|---|
| `index.html:13` | `<title>SupplyFlow</title>` |
| `public/manifest.webmanifest:2-3` | `"name"` ו־`"short_name"` — שם ההתקנה של ה־PWA |
| `public/sw.js:75,77` | כותרת ברירת מחדל של push notification |
| `supabase/functions/send-invite/index.ts:150` | „הוזמנת ל-SupplyFlow” בגוף ה־HTML **וגם** בגוף הטקסט |
| `supabase/functions/tenant-export/index.ts:204` | `<title>ייצוא מידע — SupplyFlow</title>` בארכיון המיוצא |
| `src/pages/Reports.tsx:186,214` | שם קובץ הורדה כברירת מחדל, `'supplyflow'` |
| `src/lib/reportTemplateExport.ts:208` | `'supplyflow-export.xlsx'` |

## 2. טקסטים שאין להם קבוע

- הסלוגן `רכש, חשבוניות ותשלומים במקום אחד` מופיע **פעמיים** — `Login.tsx:85` ו־`AcceptInvite.tsx:199`.
- `ניהול רכש ותשלומים` — `Layout.tsx:314` (כתובית ה־sidebar כשאין שם ארגון).
- `Legal.tsx:50` — שם המוצר מוטבע בתוך **פרוזה משפטית**: „SupplyFlow היא מערכת לניהול רכש, חשבוניות
  ותשלומים לעסקים („השירות”)”. שינוי שם כאן הוא שינוי בטקסט חוזי.
- `Dashboard.tsx:826` — התווית `הזמנות ממתינות לקבלת סחורה (ניר)`. שריד מהמקור `NIR-APP`; אינה תפקיד
  בחוזה `owner`/`office`/`accountant` הנוכחי. לתקן או להסיר בנפרד משינוי השם.

## 3. שתי בדיקות ייפלו מיידית על שינוי שם

```
scripts/check-browser-smoke.cjs:630
  await loginPage.getByRole('heading', { name: 'SupplyFlow' }).waitFor();

src/components/layoutActiveState.spec.tsx:124
  expect(document.title).toBe('פרטי הזמנה — ארגון בדיקה · SupplyFlow')
```

שתיהן מחרוזות מדויקות. יש לעדכן אותן באותו commit של שינוי השם, אחרת `npm run test` ושער הדפדפן
נופלים.

## 4. פונט וטוקנים

הטוקנים החזותיים **נקיים משם** — הפלטה כבר זהה לפלטת InPlace (`--color-shell` = `#073942`,
‏`--color-action` = `#0f5a66`). היוצא היחיד הוא שם משפחת הפונט:

- `src/index.css:167` — `"Almoni Neue SupplyFlow"`
- `vite.config.ts:13` — אותו שם ב־`@font-face` שהתוסף מזריק
- `DESIGN.md` — 12 מופעים בשורות 58,63,68,73,78,83,88,93,98,103,108,113

`#073942` מופיע בארבעה מקומות שחייבים להישאר מסונכרנים: `src/index.css:60`, `index.html:6`
(‏`theme-color`), `public/manifest.webmanifest:9`, `DESIGN.md:20`.

## 5. אין נכס לוגו וקטורי במוצר

`public/icons/icon-192.png`, `icon-512.png`, `icon-512-maskable.png` הם **כל** הסימנים הקיימים.
אין `.ico`, אין SVG, ואין `src/assets`. ‏`icon-192.png` משמש בו-זמנית כ־favicon, apple-touch-icon,
סימן ב־sidebar (`Layout.tsx:310`), סימן ב־top bar נייד (`Layout.tsx:380`), לוגו במסך כניסה
(`Login.tsx:82`) ובמסך ההזמנה (`AcceptInvite.tsx:196`), ואייקון של push (`sw.js:82,83`).
בנוסף חסרים: `<meta name="description">`, תגי OG/Twitter, ו־`APP_TAGLINE`.

## 6. מה **אסור** לשנות — חוזי wire ותשתית

אלה מכילים את המחרוזת `supplyflow` אך אינם טקסט מוצר. שינוי שלהם שובר נתונים או אינטגרציות:

- קידומת לוגים `[supplyflow]` — `src/lib/audit.ts:16`, `errors.ts:275`, `offlineQueue.ts:256,360,464`,
  `tusUpload.ts:215`, `offlineDb.ts:403`, `BarcodeScanner.tsx:178`
- מפתחות IndexedDB / cache / storage — `offlineDb.ts:23` (`supplyflow-offline`), `sw.js:13,34`
  (`supplyflow-shell-*`), `Settings.tsx`, `Onboarding.tsx:53`
- אירועי DOM — `supplyflow:service-worker-updated` (`main.tsx:28,39,40`)
- שמות HTTP headers — `organizationBranding.ts:3`, `upload-organization-logo/index.ts:18,36`,
  `outbox-worker/core.ts:13,118,119`
- מזהי DB ותשתית — `supabase/config.toml:1` (`supplyflow-p0`), שמות cron
  (`supplyflow-stuck-document-alert`), תבניות WhatsApp (`supplyflow_order`), חוזי ייצוא
  (`supplyflow_export_download_root_v2`), engine ids של ה־OCR worker
- Docker ו־CI — `docker-compose.ocr.yml`, `worker/ocr/Dockerfile`, `check-quality-gates.ps1`
- משתני סביבה — `SUPPLYFLOW_ALMONI_*`, `SUPPLYFLOW_ALLOW_LOCAL_QUALITY`, `SUPPLYFLOW_ALLOW_MIGRATION_EDIT`
- כתובות דמו `*@demo.supplyflow.local` — חשבונות בדיקה שמופיעים ב־seed, בסקריפטים ובספקים

## 7. מיתוג דייר ≠ מיתוג מוצר

`0098_organization_branding.sql` ו־`src/lib/organizationBranding.ts` הם **לוגו של הלקוח**, לא של
המוצר. אין להם קשר לשינוי השם.

## 8. שם פרויקט הפריסה

הכתובת `supplyflow-baq.pages.dev` ושם פרויקט ה־Cloudflare Pages **אינם בריפו** — אין `wrangler.toml`
ואין הפניה בסקריפטים. שינוי שלהם הוא החלטה תפעולית נפרדת מול הבעלים.
