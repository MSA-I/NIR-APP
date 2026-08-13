# PROGRESS — מצב נוכחי

עודכן: 13.08.2026.

המסמך הזה מתאר רק את מצב העבודה הנוכחי. היסטוריית גרסאות, קמפיינים וראיות ישנות נמצאת ב־Git.

## מצב המוצר

- חשבונות המוצר הפעילים הם `owner`, ‏`office` ו־`accountant` בלבד.
- `kitchen`, ‏`payer` ו־`supplier` נשמרים כערכי enum, פרופילים לא־פעילים, קשרים היסטוריים
  ו־audit. אי אפשר להזמין, להפעיל מחדש או להתחבר כתפקידים אלה.
- `supplier` כישות עסקית נשאר חלק מרכזי במוצר: ספקים, מחירונים, הזמנות, יתרות ומסמכים.
- רואה החשבון מבצע תשלום מאושר ב־`/pay`; הנתיב לא השתנה. מסך הקוד הוא
  `AccountantPaymentQueue.tsx`.
- `owner` ו־`office` ממשיכים רכש, קבלה, מסמכים ומחירונים. `accountant` ממשיך קריאה פיננסית,
  ביצוע תשלום והעלאת אסמכתה.

## השינוי שוחרר ואומת

`0133_remove_retired_persona_surfaces.sql` היא מיגרציה forward-only שמסירה את
`supplier_portal_context()`, פוליסות ו־helpers ששירתו התחברות ספק, ומצרה RPCs, מחירונים,
מסמכים, Storage ומעברי הזמנה למשטח הפעיל. חריגי `0127` ו־`0132`, enum values, היסטוריה עסקית
ו־audit נשמרים.

למיגרציה יש self-check שמכשיל אותה אם policy, view או RPC נגישים ל־`authenticated` עדיין
מכילים תפקיד שפרש מחוץ לחריגים ההיסטוריים המפורשים. `p43_active_persona_surface.sql` מוכיחה את
הגבול החדש ואת המשך העבודה של שלושת התפקידים.

במקביל הוסרו מסכי Kitchen/Supplier, ‏`/my-prices`, רכיב הזמנות ספק, תשתית `qa/` הישנה,
סקריפטים ותלויות ללא צרכן. `ActiveRole` משמש את קוד המוצר; `Role` הרחב נשאר רק בגבולות DB,
נתונים היסטוריים ותצוגת audit. ‏Knip מוצמד ונכלל ב־`npm run verify` כ־`check:dead-code`.

השינוי שוחרר לייצור ב־13.08.2026 מתוך
`eea20c84cb5c774365aa1cc60bfa64546029fefb`. לפני המיגרציה נשמר גיבוי schema/data/roles;
`0133` היא ראש ה־ledger ב־Supabase Production, ו־`private.scope_enforcement_violations()`
מחזירה אפס. ה־frontend נפרס ל־Cloudflare Pages בכתובת הקנונית
`https://supplyflow-baq.pages.dev` ובפריסה הייחודית
`https://0b5f7c57.supplyflow-baq.pages.dev`; כל נכסי `dist` תואמים בשתי הכתובות.

## אימות קוד

`npm run build` מבצע typecheck ובניית bundle בלבד. `npm run verify` מריץ את השומרים הסטטיים ואת
כל בדיקות היחידה תחת Vitest אחד. `npm run check` מריץ את שניהם ברצף לשימוש מקומי.

אין להצמיד למסמכים ספירות של בדיקות, סוויטות או תרחישים; הפלט של ה־runner הוא מקור האמת.
שער האינטגרציה `npm run quality` רץ ב־CI בלבד, וה־jobs הכבדים בו מסוננים לפי הנתיבים שהשתנו.
גם `build` ו־`verify` מסווגים לפי צרכן: test בלבד מריץ Knip+Vitest ללא build/guards/browser;
migration בלבד מריץ את guard ה־exemptions ו־SQL ללא התקנת תלויות, Vitest או browser; ‏Edge
אינו מפעיל OCR; ושינוי package מפעיל dependency audit בלי להקים DB. מטריצת ה־rollout המחייבת
נמצאת ב־`CLAUDE.md`.
חריג fail-closed: migration שנוגע ב־RLS/Auth/role/grants כן מפעיל את שער הדפדפן גם ללא שינוי `src`.

## אימות השחרור החי

- הנתיבים הציבוריים `/`, ‏`/login`, ‏`/forgot-password`, ‏`/reset-password`, ‏`/terms`
  ו־`/privacy` אומתו בשתי כתובות הפריסה בדסקטופ ובמובייל: HTTP תקין, RTL, ללא overflow
  וללא שגיאות console/page/HTTP.
- בכתובת הקנונית בוצע smoke מחובר וקריאה בלבד ל־`owner`, ‏`office` ו־`accountant`.
  כל תפקיד הגיע למסך הבית ולמסך המורשה שלו; נתיבים שאינם מורשים והנתיב שפרש
  `/my-prices` הוחזרו למרכז הבקרה. צילומי דסקטופ ומובייל אומתו ויזואלית.
- ספירות הטבלאות העסקיות, אובייקטי Storage ו־`audit_logs` זהות לפני ואחרי ה־smoke;
  לא בוצעה כתיבה עסקית. רק שלושת התפקידים הפעילים ניתנים להתחברות, ומשטחי
  `kitchen`/`payer`/`supplier` שפרשו אינם פעילים בסביבה החיה.

## עבודה פתוחה

החוב והמגבלות הפעילים נמצאים רק ב־`docs/DEBT-REGISTER.md`. הכרעות עסקיות נמצאות רק ב־
`docs/OPEN-DECISIONS.md`. אין לפתוח תכנית קמפיין חדשה בתוך הריפו לצורך המשך העבודה.
