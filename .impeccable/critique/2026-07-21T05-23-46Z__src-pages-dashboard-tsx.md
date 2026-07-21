---
target: dashboard
total_score: 29
p0_count: 0
p1_count: 2
timestamp: 2026-07-21T05-23-46Z
slug: src-pages-dashboard-tsx
---
# Critique #2 — SupplyFlow Dashboard (אחרי סבב תיקוני 21.07)

תאריך: 2026-07-21 · יעד: `src/pages/Dashboard.tsx` · קודם: 26/40

## Design Health Score — 29/40 (Good)

| # | היוריסטיקה | ציון | שינוי | סוגיה מרכזית |
|---|---|---|---|---|
| 1 | Visibility of System Status | 3 | = | חותמת+רענון+retry חזקים; אבל הדשבורד עצמו נטען ב-PageLoader ולא skeleton |
| 2 | Match System / Real World | 3 | = | כיוון מחיר מפורש ✓; "סה״כ בטיפול" עדיין סכום מעורב |
| 3 | User Control & Freedom | 3 | = | deep-links עם דרכי-מוצא ✓ |
| 4 | Consistency & Standards | 3 | = | TaskLine badge (indigo) מול badge הטונים — שתי שפות count |
| 5 | Error Prevention | 3 | = | משמעת `—` ✓ |
| 6 | Recognition Rather Than Recall | 4 | +1 | הכול מתויג ומתאר את עצמו |
| 7 | Flexibility & Efficiency | 2 | = | אין קיצורים, אין skip-to-content (~19 Tab עד התוכן) |
| 8 | Aesthetic & Minimalist | 3 | = | רגוע באמת; 2 גרפים כמעט זהים, עשרוני לא אחיד |
| 9 | Error Recovery | 3 | +1 | Note עם "נסה שוב" ששומר נתונים — דפוס חזק |
| 10 | Help & Documentation | 2 | +1 | subs מסבירים + title על גרפים; עדיין אין עזרה discoverable |
| **סה"כ** | | **29/40** | **+3** | **Good** |

## מה נסגר מהסבב הקודם (מאומת ע"י הסוכנים החדשים, בלי שידעו על הקודם)

- ‏slate-400 כטקסט מהותי — **נעלם מהדוח**; לא דווח אף כשל ניגודיות בדשבורד.
- חותמת "עודכן ב-" + רענון — צוינו כחוזקה (Visibility).
- שגיאה עם retry ששומרת נתונים — צוינה כדפוס חזק (Recovery +1).
- ‏deep-links — צוינו כחוזקה מרכזית: "שורת התייקרות → מחירון מסונן שמראה ספק זול יותר — מסך החלטה בפעולה" (אומת בדפדפן).
- כיוון "מ-₪X ל-₪Y" ✓ · ‏🎉 הוסר ✓ · ‏peak-end תוקן ("נחיתה רגועה") ✓.
- ‏Modal/th/Toast/reduced-motion/מירכוז/מגע — כולם ב-Positive Findings של ה-audit החדש.

## Anti-Patterns Verdict — PASS (שני הסבבים, כל השכבות)

‏A2: ‏"בבירור עבודת אדם עם עמדה". דטקטור (B2): ‏2 ‏gray-on-color — שניהם false positives מאומתים (ענפי ternary); ‏overlay לא רץ הפעם (כשל רשת סביבתי של האוטומציה, דווח כ-fallback).

## ממצאים חדשים (backlog לסבב הבא)

1. **[P1] ההיררכיה בתוך AttentionZone** — האדום (8 חריגים, 2 בחומרה גבוהה) קבור שלישי מתחת לשני פריטי-1 כתומים; המיון עסקי-קבוע, לא לפי חומרה. → `layout`
2. **[P1] דילול האות** — פריטי idle/info (התחייבויות, זיכויים) חולקים את "דורש טיפול היום" עם פריטי פעולה, בניגוד ל"חוק האות הכתום". → `clarify`/`distill`
3. **[P1-audit] שורות DataTable לחיצות לא נגישות-מקלדת** (`ui.tsx:462`) — האפורדנס היחיד ב-~10 מסכים; ‏WCAG 2.1.1 Level A. תיקון אחד ברכיב משותף. → `harden`
4. **[P2] הסכום המעורב** — התווית "סה״כ בטיפול" עזרה אך המספר עדיין מחבר זיכויים+התחייבויות. → `clarify`
5. **[P2] הדשבורד נטען ב-PageLoader** במקום skeleton בצורת התוכן — בניגוד לאזהרה בקוד עצמו. → `polish`
6. **[P2-audit] שאריות amber/emerald-600** בערכים קטנים ב-Reports/Bank/Suppliers/Orders/PaymentRequests — התיקון המרכזי לא הופץ לשם. → `colorize`
7. **[P3]** עשרוני כסף לא אחיד · שני גרפים כמעט זהים · note-boxes ידניים ב-~10 קבצים · ‏skip-to-content · גרפים בלי חלופת טקסט · ‏FileUpload יעד מגע 22px · ‏inline textAlign פיזי.

## Persona highlights

- ‏Sam: פוקוס נראה ✓, צבע+טקסט ✓; אין skip-link, גרפים בלי חלופה לא-חזותית.
- ‏Alex: ‏`<Link>` אמיתיים ✓; אפס קיצורים, ‏real-time מובטח אך ידני.
- ניר: הרצועה עונה מיד ✓; האדום לא ראשון, הסכום המעורב מטעה.

## Questions

1. אם לניר יש 10 שניות — אולי התשובה הכנה היא "3 הפעולות הבאות" והשאר במרחק קליק?
2. "עודכן ב-14:32" שמתעדכן רק בלחיצה — ‏real-time או צילום עם חותמת?
3. מה אם alert תמיד צף לראש ו-idle/info גרים במקום שקט — הרצועה תציית סוף-סוף ל"חוק האות הכתום"?
