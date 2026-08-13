# ADR 0008 — Vitest + MSW + Testing Library, לצד השערים הקיימים

**סטטוס:** מאומץ; פריסת ה־runners עודכנה · **תאריך:** 2026-08-04 · **עדכון:** 2026-08-13

> עדכון 13.08.2026: ההחלטה על Vitest, ‏MSW ו־Testing Library נשארה בתוקף, אך פריסת השערים
> פושטה. כל בדיקות Node העסקיות אוחדו ל־Vitest; ‏`build` מבצע typecheck + bundle בלבד;
> ‏`verify` מריץ Knip, ארבעה guards סטטיים ו־Vitest. גם שני אלה מסווגים לפי צרכן: test בלבד
> מריץ רק Knip+Vitest ואינו בונה bundle או מריץ guards/browser; migration בלבד מריץ רק את
> guard ה־exemptions ו־SQL ללא התקנה/Vitest/browser; ו־SQL
> fixture בלבד אינו מריץ Node. שער האינטגרציה מפריד Edge, ‏OCR,
> dependency audit, ‏SQL ו־browser; קובץ `*.spec.*` בלבד אינו מקים stack דפדפן. התיאור להלן
> מתעד את המצב והנימוקים ביום קבלת ההחלטה.

## הקשר

**אין runner בדיקות.** מה שקיים:
- `npm run check:review` → `node --test` על **קובץ יחיד** (`document-review/model.test.ts`, 16 בדיקות)
- חמישה סקריפטי `node` ידניים (`check-alert-rules`, `check-dashboard-series`, `check-order-savings`,
  `check-order-split`, `check-p2-reliability`)
- 13 סוויטות SQL (~460KB), חלקן עם `dblink` למרוצים אמיתיים
- שני קובצי Deno לפונקציית `interpret-document`
- שער דפדפן: `check-browser-smoke.cjs` בן 104KB שמניע `playwright-core` גולמי — **אין
  `playwright.config`, אין `@playwright/test`, אין תיקיית `tests/`**
- **אין ESLint** — למרות הערות `eslint-disable-next-line` ב-`useQuery.ts:47,51,62`
- **אין CI** — `.github/` אינו קיים; כל שער הוא ריצה ידנית

`CLAUDE.md` עדיין מצהיר "אין linter, אין טסטים" ושה-build הוא `tsc --noEmit && vite build`. שני
החצאים כבר אינם נכונים.

## ההחלטה

**‏Vitest + MSW + `@testing-library/react` + jsdom נוספים כשכבה חדשה, לצד השערים הקיימים — לא במקומם.**

**הנימוק המכריע:** אי אפשר לבדוק את מה שהתוכנית מוסיפה בלי DOM. ‏dedup של בקשות, ביטול-תוקף, retry,
מצב מיושן, החלפת דייר, כשל חלקי בפעולה מרוכזת והעלאה מתחדשת — כולם התנהגויות של hooks בתוך רינדור.
‏`node --test` בלי DOM יכול לבדוק את הפונקציות הטהורות סביבם, לא אותם.

**מה לא השתנה בהחלטה המקורית:** סקריפטי ה־guard, סוויטות ה־SQL, שער ה־Deno, שער הדפדפן
ו־`check-p0-security.ps1` נשארו אז במקומם. הם בדקו דברים שבדיקת יחידה אינה יכולה לבדוק — בידוד
דיירים אמיתי, מרוצים אמיתיים ודפדפן אמיתי. פריסת ה־runner שלהם עודכנה מאוחר יותר כמתואר למעלה.

**‏MSW משמש את הפיתוח ואת הבדיקות מאותם תרחישים** — כשל OCR, timeout באינטגרציה, retry, dead-letter,
העלאה חלקית.

## תוצאות

- `"test": "vitest run"` נוסף אז ל־`build`; בעדכון 13.08 הוא הועבר ל־`verify` כדי שה־build
  יחזור להיות build בלבד.
- ⚠️ `npm audit --audit-level=high` הוא שער קשיח (`check-quality-gates.ps1:61-102`) עם allowlist של
  advisory אחד בלבד (`react-router`). כל חבילה חדשה חייבת לעבור, וכל רישיון נרשם ב-`THIRD_PARTY_NOTICES.md`
  **מהגרסה שנפתרה ב-`node_modules`**, לא מסיכום רישום.
- **בדיקות מדומות בלבד אינן מספיקות לפעולות פיננסיות.** הסוויטות מגובות-ה-DB נשארות התנאי לכל תהליך
  רגיש — זו דרישה מפורשת בבריף, והיא כבר מיושמת כאן.
- `CLAUDE.md` מתוקן: הוא מתאר build ובדיקות שכבר אינם המצב.
- **רווח חינם:** `supabase/functions/document-processing/contract_test.ts` קיים והשער אינו מריץ אותו
  (`:514-517` מריץ רק את שני קובצי `interpret-document`). חיבורו הוא שורה אחת.

## חלופות שנדחו

**להישאר על `node --test` ולהרחיב אותו** — אפס toolchain חדש, אבל בלי DOM אין דרך לבדוק hook, ובלי
בדיקת hook אי אפשר לטעון שהמטמון והביטול-תוקף עובדים.
**Jest** — איטי יותר מול Vite, ודורש תצורת טרנספורמציה נפרדת מזו שכבר קיימת.
**‏`@playwright/test` במקום השער הידני** — מפתה, אבל השער הידני נושא 266 טענות P0 שנצברו לאורך זמן.
המרתו היא פרויקט בפני עצמו וסיכון לאובדן טענות, ואינה נדרשת לאף יכולת שהתוכנית מוסיפה.
