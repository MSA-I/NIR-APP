# InPlace — הנחיה לכל סוכן

**החוקה היחידה של הריפו היא [`CLAUDE.md`](CLAUDE.md). קרא אותה ראשונה ופעל לפיה — כולה.**

הקובץ הזה היה בעבר עותק של החוקה, והעותק התיישן עד שסתר אותה בארבע טענות מהותיות
(סקירת קוד, 10.08.2026): מבנה שערי הבדיקות,
מנגנון היתרות (views מול פונקציות `SECURITY DEFINER` מ-`0022`), גרסת React Router, והיעדר
`DEBT-REGISTER` ושער האיכות. עותק שני של חוקה הוא מנגנון סטייה — ולכן אין כאן עותק, יש מצביע.

## מה לקרוא, לפי הסדר

1. ‏[`CLAUDE.md`](CLAUDE.md) — החוקה: כללי ברזל, סטאק, השערים, איך סופרים כל מספר.
2. ‏[`docs/PROGRESS.md`](docs/PROGRESS.md) — איפה עצרנו.
3. ‏[`docs/DEBT-REGISTER.md`](docs/DEBT-REGISTER.md) — כל חוב ודחייה, לפני שמתכננים עבודה חדשה.
4. ‏[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/OPEN-DECISIONS.md`](docs/OPEN-DECISIONS.md).

## הערות סביבה לסוכן שאינו Claude Code

- מפתח ה-Supabase המקומי: ראה [`docs/LOCAL-CREDENTIALS-PATH.md`](docs/LOCAL-CREDENTIALS-PATH.md) —
  לקרוא בזמן ריצה בלבד; לעולם לא להדפיס אותו, ללוגים או לריפו.
- ‏`npm run quality` רץ **ב-CI בלבד** (‏`gh workflow run quality-gate.yml`) ומסרב לרוץ מקומית —
  הסיבה והמדידה ב-`CLAUDE.md`. אל תילחם בזה; זה נמדד על 415 ריצות.
- ריצה אחת של שער בכל רגע במכונה; מנעול ה-QA משותף לכל הסוכנים.
