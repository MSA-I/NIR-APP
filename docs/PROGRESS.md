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

## השינוי הממתין לשחרור

`0133_remove_retired_persona_surfaces.sql` היא מיגרציה forward-only שמסירה את
`supplier_portal_context()`, פוליסות ו־helpers ששירתו התחברות ספק, ומצרה RPCs, מחירונים,
מסמכים, Storage ומעברי הזמנה למשטח הפעיל. חריגי `0127` ו־`0132`, enum values, היסטוריה עסקית
ו־audit נשמרים.

למיגרציה יש self-check שמכשיל אותה אם policy, view או RPC נגישים ל־`authenticated` עדיין
מכילים תפקיד שפרש מחוץ לחריגים ההיסטוריים המפורשים. `p43_active_persona_surface.sql` מוכיחה את
הגבול החדש ואת המשך העבודה של שלושת התפקידים.

במקביל הוסרו מסכי Kitchen/Supplier, ‏`/my-prices`, רכיב הזמנות ספק, תשתית `qa/` הישנה,
סקריפטים ותלויות ללא צרכן. `ActiveRole` משמש את קוד המוצר; `Role` הרחב נשאר רק בגבולות DB,
נתונים היסטוריים ותצוגת audit. ‏Knip מוצמד ונכלל ב־`npm run build` כ־`check:dead-code`.

## אימות קוד

הספירות שמוצמדות בחוקה וב־`check:counts` הן:

| שער | ספירה |
|---|---:|
| קובצי Vitest | 70 |
| בדיקות Vitest | 651 |
| סוויטות SQL פעילות | 57 |
| זרועות preflight | 46 |
| תרחישי browser | 35 |
| בדיקות `check:review` | 22 |
| סקריפטי `check:*` | 12 |

לפני מסירה נדרשים `check:dead-code`, ‏`npm run build`, ‏`check:exemptions`, ‏`check:counts`,
`git diff --check`, חיפוש אחר משטחי retired personas ובדיקת references. ‏`npm run quality` רץ
ב־CI בלבד.

## גבול השחרור

מיזוג לריפו ופריסה לייצור הם שני מצבים שונים:

- הכנסת הקוד ו־`0133` ל־`main` אינה משנה את Supabase Production או Cloudflare Pages.
- Production אינה נחשבת נקייה עד rollout עתידי של המיגרציה וה־frontend, עם גיבוי, ledger,
  postflight, asset parity ו־smoke מחובר לשלושת החשבונות המורשים.
- עד rollout כזה אין לטעון שהמשטחים הישנים הוסרו מן הסביבה החיה.

## עבודה פתוחה

החוב והמגבלות הפעילים נמצאים רק ב־`docs/DEBT-REGISTER.md`. הכרעות עסקיות נמצאות רק ב־
`docs/OPEN-DECISIONS.md`. אין לפתוח תכנית קמפיין חדשה בתוך הריפו לצורך המשך העבודה.
