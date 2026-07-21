---
target: dashboard
total_score: 26
p0_count: 0
p1_count: 1
timestamp: 2026-07-21T04-40-46Z
slug: src-pages-dashboard-tsx
---
# Critique — SupplyFlow Dashboard (משולב: Assessment A + Assessment B)

תאריך: 2026-07-21 · יעד: `src/pages/Dashboard.tsx` (`/dashboard`, מחובר כ-owner@gamos.demo, נתוני דמו מלאים)

## Design Health Score — 26/40 (Acceptable)

| # | היוריסטיקה | ציון | סוגיה מרכזית |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | אין חותמת "עודכן ב-" על מסך שמבטיח זמן-אמת |
| 2 | Match System / Real World | 3 | "13,082.15₪" מחבר זיכויים+התחייבויות; כיוון ₪X ← ₪Y לא מתויג |
| 3 | User Control & Freedom | 3 | Esc/ביטול קיימים; מעט לבטל בדשבורד |
| 4 | Consistency & Standards | 3 | focus ring מותאם רק ל-input; גרף שבועי בלי תוויות מול חודשי מתויג |
| 5 | Error Prevention | 3 | ConfirmDialog עם סיבה — מצוין |
| 6 | Recognition Rather Than Recall | 3 | שורות חריגים/מוצרים → רשימה גנרית (memory bridge) |
| 7 | Flexibility & Efficiency | 2 | ‏Ctrl+K לחיפוש קיים (GlobalSearch) — אך אין קיצורים מעבר לו, אין bulk/התאמה |
| 8 | Aesthetic & Minimalist | 3 | 8 אזורים + 3 גרפים = דף ארוך; רעש slate-400 |
| 9 | Error Recovery | 2 | שגיאה גורפת מוחקת את כל המסך, בלי "נסה שוב" |
| 10 | Help & Documentation | 1 | אפס tooltips/הסברים למונחים כספיים |
| **סה"כ** | | **26/40** | **Acceptable** |

תיקון סינתזה להיוריסטיקה 7: הטענה "אין ⌘K" שגויה — Ctrl/Cmd+K ממומש ב-GlobalSearch (מאומת בקוד וב-audit). הציון 2 נשאר בתוקף בשל היעדר כל מאיץ אחר.

## Anti-Patterns Verdict — PASS (מוסכם בשלוש שכבות)

- **LLM (A):** לא נראה AI-generated; עמדה עיצובית אמיתית (AttentionZone דו-שכבתי, משמעת `—`/`0`/`null`, מסך תקין כמעט מונוכרומטי). שוליים: דף ארוך, recharts גנרי, 🎉 כפול.
- **דטרמיניסטי (B):** ‏CLI — ‏2 ‏`gray-on-color`, שניהם false positives (ענפי ternary מנוגדים). ‏In-page — ‏2 ‏`low-contrast` false positives (ה-resolver נפל ל-#ffffff במקום slate-900 של הסייד-בר) + `single-font` (Heebo יחיד — החלטה מכוונת ומתועדת ב-DESIGN.md).
- **הצלבה:** הדטקטור לא תפס אף בעיה אמיתית ש-A פספס; ואילו הבעיה האמיתית (slate-400 כטקסט מהותי, 2.56:1) נתפסה ע"י A וה-audit — ולא ע"י הדטקטור. ה-overlay הוצג ותועד בצילום לפני ניקוי.

## Priority Issues

1. **[P1] slate-400 (2.56:1) כטקסט מהותי** — סוג חריג, שם ספק, מחירים ישן←חדש, hints (`Dashboard.tsx:228,263,266`, ‏`ui.tsx:207,240`). מפר WCAG 1.4.3 ואת חוק ה-DESIGN.md עצמו. תיקון: ‏ink-muted (slate-500, ‏4.76:1) ומעלה לטקסט מהותי. → `/impeccable colorize`
2. **[P2] שורות סיכום → רשימה גנרית** — חריגים ל-`/exceptions?status=open`, מוצרים ל-`/prices?increases=1`; ספקים דווקא כן מקשרים לפרטים. ציפייה מופרת + memory bridge. → `/impeccable clarify`
3. **[P2] אין הסבר למונחים כספיים** — "חיסכון משוער", "התחייבויות רכש · נותר לקבלה" בלי tooltip; פרסונת ניר נשארת בלי פענוח. → `/impeccable clarify`
4. **[P2] אין חותמת טריות + שגיאה גורפת בלי retry** — `Dashboard.tsx:197`. → `/impeccable harden`
5. **[P3] ‏peak-end חלש** — גרף קטגוריות חצי-ריק בסוף; ‏🎉 כפול על מערכת "שקטה". → `/impeccable quieter`

## Persona Red Flags

- **Alex:** אין קיצורים מעבר ל-Ctrl+K; אין deep-link לשורת חריג. חיובי: `<Link>` אמיתיים (middle-click עובד).
- **Sam:** ‏focus גלוי ✓, סטטוס תמיד עם טקסט ✓; ‏slate-400/12px לתוכן מהותי ✗; גרף שבועי בלי תוויות/ציר ✗.
- **ניר (10 שניות, לא טכני):** הרצועה בנויה בשבילו ✓; תמונה מלאה דורשת 8 אזורים ✗; מונחים בלי הסבר ✗; "6 פריטים · 13,082.15₪" עלול להיקרא כ"כסף בסיכון" ✗.

## Minor Observations

- גרף שבועי בלי תוויות ערך; העמודה הזעירה (₪640) נראית כשגיאה.
- ‏focus ring לא עקבי-מותג מחוץ ל-input.
- ‏`violet` יתום ב-`ui.tsx:235` ו-`supplier-metrics.tsx` למרות שהוסר מ-`status.ts`.
- כותרת הרצועה מסכמת שני סוגי כסף לא-דומים.
- סרגל owner ~17 פריטים — ממותן בקבוצות אך צפוף.

## Questions to Consider

1. מה אם הרצועה הייתה כל ה-above-the-fold, וכל השאר בגילוי מדורג? האם הבטחת 10 השניות צריכה 3 גרפים?
2. אם "זמן אמת" — איפה השעה?
3. מה "13,082.15₪" באמת אומר למנהל בשנייה שהוא קורא אותו?
