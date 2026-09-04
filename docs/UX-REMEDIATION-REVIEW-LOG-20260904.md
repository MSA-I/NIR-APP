# Plan Review Log — תוכנית תיקון: מסמכים והעוזר

נפתח 04.09.2026. ‏`MAX_ROUNDS=5`.
תוכנית: `docs/UX-REMEDIATION-DOCUMENTS-20260904.md`
ענף: `docs/ux-remediation-documents-assistant`
מבקר: Codex CLI 0.149.0, מודל ברירת המחדל של ה-CLI (אין `model` ב-`~/.codex/config.toml`), **קריאה בלבד בכל סבב**.

הביקורת נשלחת עם הוראה מפורשת לפתוח את הקבצים ולאמת כל ציטוט `file:line` בתוכנית —
תוכנית שנבנתה על ציטוט שגוי תייצר עריכה שגויה.

---

## סבב 1 — Codex

**`VERDICT: REVISE`** · thread `01a06c67-95df-7ac1-aeb3-e9d007c70cec`

הביקורת המלאה:

התוכנית עדיין אינה מוכנה למימוש. הקוד לא נסחף מאז בסיס האודיט: ההבדל בין `b48a0b36` ל־HEAD הוא מסמך התוכנית בלבד. הבעיות להלן נמצאות בתוכנית עצמה.

### ציטוטים וטענות שגויים או מוגזמים

- **סיפור השערים התיישן לחלוטין.** [`package.json`](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/package.json:45>) מריץ 32 תת־פקודות — 31 checks ו־Vitest — ו־[`build.yml`](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.github/workflows/build.yml:185>) מריץ בדיוק אותם 32 שמות, ללא חסרים. תיקון: להחליף בכל התוכנית את “27 מול 14, ‏13 חסרים” במצב הנוכחי.

- **PR שבסיסו אינו `main` כבר אינו מקבל אפס בדיקות.** גם [`build.yml`](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.github/workflows/build.yml:20>) וגם [`quality-gate.yml`](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.github/workflows/quality-gate.yml:33>) מכילים `pull_request:` ללא מסנן ענף; `DEBT §65` מסומן סגור. תיקון: למחוק את מלכודת ה־PR ואת חובת הריצה הידנית הנגזרת ממנה.

- **`check:contrast` אינו אדום.** הרצתי `npm.cmd run check:contrast`: ‏exit 0, ‏53 צמדי טקסט, 7 צמדי non-text. תיקון: G4 צריך להיות שער חוסם רגיל; המדידה המרונדרת נשארת ב־browser job.

- **P1.4 אינו “נעול לצמיתות בלי סיבה גלויה”.** הכפתור אכן מושבת ב־[`FileUpload.tsx:960`](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/src/components/FileUpload.tsx:960>), אבל סיכום הכשל וכפתור retry נשארים גלויים ב־[`986–1000`](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/src/components/FileUpload.tsx:986>); “ניקוי שהסתיימו” מנקה את Upload Center, לא את `uploadSummary`. תיקון: לתאר זאת כחוסר אפשרות להתחיל batch חדש או לנטוש retry, לא כמבוי סתום בלתי מוסבר.

- **P2.4 מוחק ראיה שאינה משוכפלת כולה.** `item.values` הוא מקור גם לשם מוצר חדש ב־[`guessLineName`](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/src/components/document-review/PriceListReviewConfirmation.tsx:63>); SKU, יחידה וערכים של שורה לא־מותאמת אינם כולם מוצגים בשדות הייעודיים. תיקון: להחליף את הרשת בסיכום עברי קומפקטי, לא למחוק את ראיית המקור.

- **P2.6 אינו מציג “בתים” גולמיים.** [`UploadCenter.tsx:608`](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/src/components/UploadCenter.tsx:608>) ממיר ל־B/KB/MB. תיקון: לנסח “גודל קובץ מוצג” בלבד.

- **P2.11 אינו כרטיס שתוכנו תמיד תג אחד.** בזמן עבודה חיה הוא מכיל גם `DocumentProcessingProgress` ב־[`DocumentReviewWorkspace.tsx:95–102`](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/src/components/document-review/DocumentReviewWorkspace.tsx:95>); רק ב־`review` הרכיב מחזיר `null`. תיקון: להעביר תג והתקדמות יחד או לפצל לפי state, עם בדיקות לכל שלב.

- **`assessment.ts:147` אינו “השרת מפרסם”.** זו רק הגדרת TypeScript; הפרסום האמיתי הוא ב־[`0109_document_review_assessment_read.sql:159`](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/supabase/migrations/0109_document_review_assessment_read.sql:159>). הטענה שאין קורא ב־`src` נכונה. תיקון: לצטט גם את חוזה השרת וגם את הטיפוס.

- **`QuickSupplierPicker` אינו מנהל את הרשימה בעצמו.** [`useQuickSupplier`](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/src/components/QuickSupplierPicker.tsx:116>) מקבל רשימה שכבר נשלפה מהקורא; הוא רק ממזג יצירות מקומיות. תיקון: להוסיף לתוכנית שאילתת ספקים tenant-scoped ומצבי loading/error.

- **P3.6 חסרת מקור נתונים.** תיקיית המסמכים שולפת `documents`, ספקים, processing ו־auto-actions בלבד ב־[`DocumentsInbox.tsx:467–540`](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/src/pages/DocumentsInbox.tsx:467>); אין בה assessment state. תיקון: לתכנן read model מרוכז ל־`supplier_unresolved`; אסור לבצע RPC אחד לכל שורה.

- **P3.8 “שום דבר לא מתקן” מוגזם.** האישור הסופי כן מעדכן `documents.supplier_id` ב־[`apply_reviewed_document`](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/supabase/migrations/0110_apply_reviewed_document.sql:487>), אך עד האישור הרמז מההעלאה נחשב ראיה סמכותית. תיקון: לתאר את בעיית הקדימות ולתכנן provenance לרמז, לא לטעון שאין תיקון כלל.

- **P5.6 טועה לגבי רואה החשבון.** מסך הבדיקה פתוח רק ל־`owner|office` ב־[`App.tsx:172`](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/src/App.tsx:172>); accountant אינו רואה את ההפניה השבורה. תיקון: לציין שהמבוי הסתום פוגע ב־office בלבד.

- **P7 אינה “ארבעה שדות מספריים”.** `ReviewedLineEdit` מכיל שלושה מספריים ו־`unit` טקסטואלי ב־[`assessment.ts:393–399`](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/src/components/document-review/assessment.ts:393>); הטבלה מציגה כרגע רק quantity ו־unit price, לא unit או line total. תיקון: להגדיר במפורש אילו עמודות נוספות נבנות ואיך כל ערך נערך.

- **P9.1 אינו מבוי סתום P0.** ה־composer נשאר פעיל; שאלה שהוקלדה אף נשארת ב־state אחרי כשל. רק שאלה שנשלחה מהצעה אינה מוחזרת לשדה, וכפתור “בדיקה חדשה” חסר. תיקון: לסווג כבעיית recovery ולהוסיף retry ששומר את `submittedQuestion`.

- **P9.6 אינו טוען את “ההפך מ־AI”.** “בדיקה תפעולית מבוססת ראיות · לקריאה בלבד” תואם גם תשובה שנוצרה ב־AI. תיקון: להציג היעדר disclosure כבחירת מוצר/משפט, לא כהצהרה עובדתית שקרית.

- **P9.7 כבר מבדיל מבנית בין פרוזה לראיה.** claim מקבל כרטיס, `<dl>` של facts וקישורי source ב־[`AnswerView.tsx:300–335`](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/src/components/assistant/AnswerView.tsx:300>); ההבדל אינו “רקע מעט מוצל” בלבד. תיקון: להגדיר ליקוי חזותי מדיד ספציפי או להסיר את הממצא.

- **P9.9 “לעולם לא” שגוי.** שיחה משוחזרת מציגה “בדיקה חדשה”, שמאפסת ומחזירה את ההצעות. תיקון: לנסח “ההצעות אינן מופיעות אוטומטית למשתמש חוזר”.

- **P9.14 אינו חיתוך קבוע ללא מוצא.** זה disclosure שנמדד ומציג “הצג עוד”, לפי הכרעת בעלים מתועדת ב־[`CollapsibleAnswer.tsx:7`](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/src/components/assistant/CollapsibleAnswer.tsx:7>). תיקון: לא לשנות את ה־clamp בלי הכרעה חדשה וראיית שימוש.

- **P10.11 כבר תוקן במסך הבדיקה.** `confidenceLabel` מחזיר “זוהה בבירור/חלקית/לא ודאי”, ובדיקות אוסרות אחוזים; אחוז גולמי נשאר רק בהקשר הפיקוח על שיוך אוטומטי. תיקון: לצמצם את הסעיף למשטח auto-assignment המדויק.

### תיקונים מוצעים שאינם בטוחים

- **P1.4 עלולה ליצור כפילות.** resume נשמר לפי אותו אובייקט `File` וה־`clientUploadKey` ב־[`FileUpload.tsx:101–116`](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/src/components/FileUpload.tsx:101>); בחירה מחדש של אותו קובץ יוצרת `File` חדש ומפתח חדש. batch חדש גם דורס את `retryFiles` הישן. תיקון: לשמר retries לפי מפתח יציב ולאפשר batch חדש בלי לאבד אותם; אין להסיר את תנאי ה־disabled לבדו.

- **P3 יצירת ספק מפרה את כלל audit-with-reason.** `QuickCreateSupplier` מבצע insert ישיר עם `org_id` ונסמך נכון על RLS, אבל הטריגר הגנרי כותב audit עם `reason = null`; [`QuickCreateSupplier.tsx:161`](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/src/components/QuickCreateSupplier.tsx:161>). תיקון: לפני הרכבת create במסך זה, להעביר יצירת ספק ל־RPC tenant-scoped, idempotent ומנומק, או לא להציע יצירה.

- **בחירת ספק קיימת כן מוגנת בשרת.** `apply_reviewed_document` מאמת org, supplier, order, scope וסיבה ב־[`0110:341–355`](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/supabase/migrations/0110_apply_reviewed_document.sql:341>). תיקון: לשמור את הכתיבה רק דרך RPC זה ולבדוק גם credit note, שבו ספק ידני אינו פותר `credit_resolution` לא־פתור.

- **P3.4 אינה מגדירה אילו הזמנות מותר להציג.** cancelled/closed/fully-received, ישות משפטית, יחידה ומטבע אינם מוגדרים. תיקון: לנעול eligibility מול אותו חוזה שהשרת בודק ולבדוק שהבחירה נשארת באותו supplier/currency/scope.

- **P3.7 היא חקירה פתוחה, לא שלב מימוש.** “לאתר איזה מהשניים משקר” משאיר root cause לא ידוע בתוך תוכנית נעולה. תיקון: לבצע אבחון read-only קודם ולהכניס לתוכנית עריכת מקור מדויקת.

- **P4.3 אינה יכולה לשמור “אותו מנגנון משוב” כקישור יחיד.** `add_document_feedback` דורש `annotation.id`; במסמך יכולים להיות כמה annotations וכללים. תיקון: להשאיר פעולה קומפקטית לכל הצעה, או להוסיף חוזה document-level חדש ומבוקר.

- **העברת הקונסולה ל־`/documents/operations` אינה מתוכננת.** המסך אינו טוען annotations, feedback או learning rules. תיקון: להוסיף חבילת query/UI/authorization נפרדת; מחיקה מהמסך הנוכחי אינה “העברה”.

- **P5.1 מוחקת הבחנה שנבנתה בעקבות תקלה אמיתית.** `DocumentProcessingProgress` מפריד בכוונה “ממתין בתור” מ“קריאת המסמך”; “משפר תמונה” אף מצהיר שטרם בוצע OCR. תיקון: לאחד רק ניסוחים בתוך כל state, לא queue/scanning/reading לאותה טענה.

- **P5.4 מניחה פעולה זהה כשאין פעולה זהה.** failed מציג retry; stuck אינו נכלל ב־row retry ואינו מקבל כפתור במסך הבדיקה. תיקון: לבנות קודם recovery אחיד, ורק אז לשקול תווית אחידה.

- **P5.5 עלולה למחוק מצב בטיחות כספי.** “הועלה אך לא נרשם” שונה מהותית מ“נרשם — העיבוד לא החל”: בראשון אין registry row, בשני אסור להעלות שוב. תיקון: להחליף ז'רגון במילים אנושיות אך לשמור את ההבחנה ואת פעולת ה־retry המתאימה.

- **P5.9 ממזגת פעולות עם תוצאות שונות.** הסרה מהארכיון היא soft delete בלי סיבה; “הסרה עם השפעה” יכולה לבטל נגזרות, דורשת סיבה ונחסמת על תלות כספית. תיקון: להשאיר שמות שונים או לתאר את ההשלכה כבר בתפריט.

- **P2.9 מוחקת provenance רחב מדי.** `Fact.as_of` הוא חלק מחוזה הראיה ויכול להשתנות בין facts בעתיד; רק product help חותם כעת `ctx.now()` על תוכן סטטי. תיקון: להשתמש ב־`entry.updated_at` לעזרת מוצר או לקבץ חותמות זהות, לא למחוק fact-level freshness גלובלית.

- **P7 מפצלת את האישור ממחירון בצורה לא נכונה.** [`priceSeedRows`](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/src/components/document-review/assessment.ts:490>) מתעלם מ־`edits.unit_price` ומשתמש במחיר שהמכונה קראה; חשבונית יכולה להירשם במחיר המתוקן ואז מחירון הספק להיזרע במחיר השגוי. תיקון: לגזור seed מה־reviewed proposal המאושר או להעביר את הזריעה לשרת.

- **P7 חסרה ולידציית קלט ומטבע.** ערכי string חופשיים עלולים להגיע כפסיק, סימן מטבע, ערך שלילי או precision אסור; unit price ו־line total חייבים להציג את מטבע המסמך. תיקון: להגדיר parsing/empty/precision/negative rules, להשאיר currency בלתי־ניתן לעריכה, ולבדוק את `minor_units`.

- **P8 מטפלת בכל scan failure כאילו היה כשל גבולות.** הקודים כוללים corrupt, decompressed-size, file-size, resource, timeout ו־image-too-small ב־[`DocumentScanPreview.tsx:33–43`](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/src/components/document-review/DocumentScanPreview.tsx:33>); full frame לא מתקן אותם. כשל גבולות רגיל כבר מפיק `full_frame_fallback`. תיקון: לפצל recovery לפי error code ולהציע full-frame רק כשמקור תקין והבעיה גאומטרית.

- **P8.3 אינה “עוד כפתור”.** אין callback שמחליף קובץ; העלאה חדשה יוצרת מסמך חדש, וצריך להחליט מה קורה למסמך הכושל, למקור immutable ולניווט. תיקון: להגדיר replace/supersede server contract, audit וסיבה, תוך שמירת המקור הישן.

- **P9.2–P9.5 אינן Frontend בלבד.** `routeAccess.ts` ו־`productHelpRegistry.ts` מיובאים לתוך פונקציית `assistant`; שינוי בהם מחייב Deno contracts ופריסת Edge, לא רק Pages. תיקון: לסווג P9 כ־Frontend + Edge ולדרוש deploy וקריאת assistant חיה.

### היקף ותלויות

- **P9 אינו עצמאי.** הוא חולק את `AnswerView.tsx` עם P2 ואת `he.ts`/`en.ts` עם P2–P5, P8 ו־P10. תיקון: להריץ P9 אחרי חוזה מילון/AnswerView משותף, או להפריד ownership ולבצע integration leaf.

- **גם P1–P8 אינם חייבים כולם בטור.** הקשרים האמיתיים הם P2→P6, ‏P3→P7, ו־P8↔P6 סביב `DocumentReview`; P1 ו־P4 יכולים להיות עצמאיים מלבד המילונים. תיקון: להחליף שרשרת אחת ב־DAG לפי קבצים וחוזים.

- **P2 אינה “מחיקות טהורות”.** ‏2.2 דורשת להמיר `/inbox?filing=unfiled` ל־processing filter ולעדכן `App.tsx`, architecture ובדיקות; ‏2.11 מעבירה state; ‏2.12 מוסיפה disclosure חדש. תיקון: לסווג כ־UI refactor עם בדיקות התנהגות.

- **P6 אינה 2 קבצים ואינה layout-only.** הציטוטים עצמם נוגעים לפחות ב־Workspace, PrimaryDecision, AssessmentPanel, ReconciliationStrip, Proposals ו־DocumentReview; קיפול והסתרת controls הם שינויי interaction. תיקון: לעדכן היקף, בעלות ובדיקות state.

- **P9 גדול משמעותית מ־“6+”.** נדרשים לפחות dialog/session, route allowlist, registry, Edge tool, AnswerView, panel, client, CSS, dictionaries, tests ו־`DESIGN.md`. תיקון: לפרק ל־recovery, help/Edge, feedback ו־visual packages.

- **P10 אינה 2 מילונים.** ‏10.10 משנה במפורש `PriceLists.tsx`; ‏10.9 משנה את מבנה `FileUpload` ולא רק ניסוח. תיקון: לספור קובצי מוצר ובדיקות, או להוציא שינויי interaction מחבילת copy.

- **“P1+P2 = 14 קבצים” הוא חיבור שגוי.** שלושה קבצים חופפים; יש 11 קובצי קוד ייחודיים בציטוטים, או 13 עם שני המילונים. תיקון: לספור union של paths, לא סכום חבילות.

### הכרעות בעלים

| הכרעה | מצב ביקורת | תיקון |
|---|---|---|
| D-1 | בחירת UX לגיטימית, לא שאלה עסקית או שינוי נתונים | לא לחסום בגללה את יתר P2 |
| D-2 | כבר הוכרעה ב־`#125`: order לא־פתור ממתין לאדם; השרת מחייב order | לצטט `#125` ולממש picker |
| D-3 | שאלה לגיטימית, אך התוכנית אינה מממשת את ההעברה המומלצת | להוסיף חבילת operations אמיתית |
| D-4 | שאלה לגיטימית אך הבינאריות שגויה; error codes שונים דורשים תוצאות שונות | לפצל לפי סוג כשל ולהצליב עם `#70` ו־`#247` |
| D-5 | אינה הכרעה אחת; ארבעה מיזוגים משנים אמת ופעולות שונות | להציג לבעלים matrix נפרדת לכל merge |
| D-6 | הכרעה עסקית נכונה | להוסיף החלטה על price seeding ועל שדות/precision |
| D-7 | שאלה מוצרית, אך הרחבה גורפת לפי route אינה מספיקה | לאשר כל entry מול כל פעולה המתוארת בו |
| D-8 | כבר הוכרעה ב־`#231`: re-import מהמקור, preview ואישור אדם | לא להקצות `#365`; לקשר ל־`#231` |

הכרעות חסרות: סמכות רמז supplier בהעלאה; eligibility להזמנה ידנית; override ספק בזיכוי; מה קורה למסמך הישן בהעלאה חוזרת; source-first במובייל; disclosure של AI; והיפוך הכרעות הבעלים הקיימות על שש הצעות, clamp, כרטיס צף ו־glass effect.

### כללי ברזל ושערים

- P3 במתכונתה מפרה `audit_logs with reason`; P7 חייבת לשמור מטבע על כל שדה כסף; P8 חייבת לשמור מקור immutable והחלטת scan מתועדת; P9.13 משנה שפה ויזואלית ולכן מחייבת עדכון `src/index.css` ו־`DESIGN.md` יחד.
- לא מצאתי הצעה ישירה שמשנה N:M allocations, יתרות מחושבות, soft delete פיננסי, `user_role`, ערכי dashboard או מוסיפה `tailwind.config.js`.
- `workflow_dispatch` עצמו חסר `render=true` ב־[`quality-gate.yml:77–83`](<D:/משה פרוייקטים/פיתוח אתרים/NIR-APP/.github/workflows/quality-gate.yml:77>), ולכן “מריץ הכול” אינו נכון. תיקון: להוסיף את output החסר או להפסיק לקרוא לריצה full gate.
- G1 צריך לצפות ל־32 תת־פקודות; G3 כבר מכוסה גם ב־CI; G4 צריך לחסום; G7 צריך להסתמך על ה־PR האוטומטי ולדרוש dispatch ידני רק כשבאמת נדרש full-path run.

לא ביצעתי שום עריכה. במהלך הביקורת הופיעו שינויים מקבילים לא־שלי ב־`DESIGN.md` וב־`docs/DEBT-REGISTER.md`; השארתי אותם ללא מגע. מיפוי הגרף שימש רק לאיתור תלות, וכל ממצא לעיל אומת ישירות בקוד.

VERDICT: REVISE


### תגובת Claude — סבב 1

**אומת עצמאית לפני קבלה** (לא הסתמכתי על דיווח Codex לבדו):

| טענה | איך נבדקה | תוצאה |
|---|---|---|
| `verify` = 32 תת-פקודות, CI מריץ את כולן | `node -e` על `package.json` + ספירת שמות ב-`build.yml` | **Codex צודק.** `CLAUDE.md` מיושן |
| `check:contrast` עובר | הרצה מקומית | **Codex צודק.** exit 0, 53 צמדי טקסט |
| `§65` נסגר | `grep` ב-`DEBT-REGISTER.md:64`, `:1608` | **Codex צודק.** נסגר 02.09.2026 |
| `#125` מכריע תעודת משלוח בלי הזמנה | `OPEN-DECISIONS.md:342` | **Codex צודק.** שלוש דרגות ראיה, 09.08.2026 |
| `#231` מכריע שמות הפוכים | `OPEN-DECISIONS.md:455`, `:457` | **Codex צודק.** re-import + preview + אישור אדם |
| `priceSeedRows` מתעלם מ-`edits.unit_price` | קריאת `assessment.ts:490-505` | **Codex צודק — וזה באג כספי.** הפונקציה קוראת `edits[...]?.product_id` בלבד ואז `line.normalized_unit_price ?? line.unit_price` |
| `routeAccess`/`productHelpRegistry` מיובאים ל-Edge | `grep` ב-`supabase/functions/` | **Codex צודק.** `evidence-authorization.ts:8`, `index.ts:74`, `live-evaluation.ts:6` |

**התקבל במלואו:** סיפור השערים (סעיף 0 חדש), פיצול P9 ל-Frontend+Edge, גרף תלויות במקום
שרשרת, ספירת union במקום סכום, ארבעת המיזוגים המסוכנים ב-P5 (במיוחד 5.5 — ההבחנה בין
„אין registry row" ל„אסור להעלות שוב" היא בטיחות כספית), פיצול P8 לפי error code,
החוסם הכספי ב-P7, מחיקת D-2 ו-D-8 לטובת `#125` ו-`#231`, וכל תיקוני הציטוט
(‏1.4, ‏2.4, ‏2.6, ‏2.9, ‏2.11, ‏3.8, ‏5.6, ‏7 שדות, ‏9.1, ‏9.7, ‏9.9, ‏9.14, ‏10.11).

**נדחה חלקית — D-1.** ‏Codex טוען שזו בחירת UX ולא שאלה עסקית, ולכן אינה צריכה לחסום.
מקובל שאינה שאלה **עסקית** — אבל ההערה בקוד מגינה על ההצגה במפורש, ומחיקה שקטה עוקפת
כוונה מתועדת. **הודחה מהכרעת בעלים ל„היפוך מתועד", וחוסמת את 2.1 בלבד** במקום את כל P2.

**לא אומת, ולכן נרשם כצעד ראשון ולא כעובדה — טריגר ה-audit.** ‏Codex טוען ש-
`QuickCreateSupplier` יוצר `audit_logs` עם `reason = null`, מה שיסתור כלל ברזל. ראיתי את
ה-insert הישיר (`:161`) אך **לא בדקתי את הטריגר עצמו**. נרשם ב-P3 כחסם שיש לאמת לפני
הרכבת יצירת ספק — לא כטענה מוכחת.

**נותר לא-מוסכם, לבירור בסבב 2:** ‏P9.7 — האם ההבחנה המבנית הקיימת מספיקה, או שנשאר
ליקוי מדיד. הסוכן שלי מדד „רקע מוצל בלבד", Codex קרא את אותן שורות וראה כרטיס + `<dl>` +
קישורי מקור. סומן בתוכנית כ„להגדיר ליקוי מדיד או להסיר את הממצא".

---
