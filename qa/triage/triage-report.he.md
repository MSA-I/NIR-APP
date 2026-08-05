# דוח טריאז׳ סופי — QA רב־סוכני

## תוצאה

- ריצת המקור: `qa-20260805052133-d7eeaa3e`
- קומיט checkpoint של תשתית ה־QA: `0f21d7ae7edfcb3872b3aae13ec81bce2722be5a`
- תצפיות מקור: **28**
- מועמדי שורש לאחר איחוד כפילויות: **12**
- `CONFIRMED_DEFECT`: **2**
- `FALSE_POSITIVE`: **6**
- `EXPECTED_BEHAVIOR`: **2**
- `BUSINESS_DECISION_REQUIRED`: **2**
- `INCONCLUSIVE`: **0**

לא שונתה התנהגות מוצר. לא בוצעו push או merge. נפתחו Issues רק לשני הפגמים המאושרים: [#2](https://github.com/MSA-I/NIR-APP/issues/2) ו-[#3](https://github.com/MSA-I/NIR-APP/issues/3).

## הראיות שנבדקו

כל הבדיקות להלן בוצעו תחת `.qa-runs/qa-20260805052133-d7eeaa3e`:

- `report.json` וכל **229** הפניות הראיה שבו; **0** הפניות חסרות.
- כל **375** הקבצים בריצה: 195 JSON,‏ 104 PNG,‏ 60 ZIP trace,‏ 4 XLSX,‏ 2 CSV,‏ PDF אחד, JPG אחד, 7 דוחות Markdown ו־HTML אחד.
- כל **104** צילומי המסך נבדקו חזותית לפי תפקיד ובמצב full-resolution במקומות המכריעים.
- כל **47** קבלות הפעולה: 47 פעולות ללא `actionError`; כל המוטציות שנדרשו קיבלו verifier.
- כל **6** קובצי `browser-evidence.json` של התפקידים.
- כל **60** קובצי Playwright `evidence.json` וכל **60** קובצי הראיה המצונזרים הנלווים.
- **3,855** רשומות network נסרקו בשכבות הראיה: 23 בקבלות פעולה, 606 בראיות התפקיד ו־3,226 בראיות Playwright. אלה ייצוגים חופפים בחלקם; לא נמצאה בקשת HTTP שנכשלה.
- כל **60** קובצי `trace.zip`: ‏240 entries ו־8,471 שורות JSONL תקינות. נמצאו 27 אירועי console זהים של כשל handshake זמני ל־Supabase Realtime WebSocket עם 503; לא נמצא כשל HTTP תואם, וכל התרחישים הרלוונטיים עברו.
- כל **13** קובצי האימות: 12 אימותי data-integrity/audit ואימות export אחד; כולם `PASS`. נבדקו קשרי tenant/supplier, actor, סיבה ביומן, ספירות audit מדויקות, מניעת כפילות, יתרות N:M ותופעות לוואי מותרות בלבד.
- כל ארבעת קובצי XLSX נפתחו ונפרסו; כל הגיליונות והמידות נקראו ולא נמצאו תאי נוסחה. שני קובצי ה־CSV נקראו, וחתימות ה־PDF/JPG אומתו.

## שחזור ממוקד

בוצעו שתי ריצות חדשות ועצמאיות מול `supplyflow-p0` המקומי, כל אחת לאחר reset חדש וכל אחת עם cleanup מאומת:

| ריצה | setup | Playwright | תרחישי ליבה | cleanup |
|---|---|---:|---|---|
| `qa-20260805093134-931e53c3` | `READY` | 47 passed, 14 role-skips | 6/6 עברו | `CLEAN` |
| `qa-20260805093617-0123caef` | `READY` | 47 passed, 14 role-skips | 6/6 עברו | `CLEAN` |

שני הסבבים כיסו replay של מחירון, קבלה חלקית והעלאת מסמך, יצירת חשבונית והקשרים, שלוש הרצות בדיקה, מעברי review, יצירת ואישור דרישת תשלום, ביצוע העברה idempotent, ייבוא/התאמת בנק וייצוא חודשי.

## מועמדי השורש והסיווג

### C-01 — replay של מחירון נשאר לכאורה ב״קולט...״

- סיווג: `FALSE_POSITIVE`
- תצפיות: `finding-665b01b0-9ea8-4010-a3e3-db5f79c9910d`, `finding-f15fc5a3-d551-43b6-acdc-b64b4c3dfaa1`
- ראיה מכריעה: צילום ה־post של פעולת replay תפס את מצב ה־busy הזמני. הקבלה הסופית הופיעה לאחר מכן; המוטציה הסתיימה ב־1,319ms, verifier ‏`agents/supplier/verification/10-data-integrity.json` עבר, ונשמרה גרסה אחת בלבד. שני השחזורים החדשים עברו.
- גורם הסתירה: `transient state` יחד עם `snapshot timing problem`.

### C-02 — replay מחזיר את הקבלה המקורית

- סיווג: `EXPECTED_BEHAVIOR`
- תצפית: `finding-78ffa8a7-05af-4d10-aec6-b78712ad6c9c`
- ראיה מכריעה: חוזה ה־idempotency דורש קבלה מקורית, ללא גרסה נוספת וללא audit חדש. אימות המקור ושני השחזורים הוכיחו בדיוק זאת.

### C-03 — בקרים ״לא נגישים״ בארבעה תפקידים

- סיווג: `FALSE_POSITIVE`
- תצפיות: `finding-bda773af-863a-480b-9612-e5e300dc728a`, `finding-5fa49383-4c52-41c7-838e-3b474d9c0b0f`, `finding-c2c3c1ae-cf0a-45a0-836f-c948bac74a46`, `finding-aa0e59e7-4d5b-4277-966c-9c48de623909`, `finding-dd714995-68a5-439e-9f32-e9954b2e49bf`, `finding-3c7fffb4-0c41-4735-bbe3-bb5a968cffac`, `finding-8570bb8a-c9c9-4e83-b712-c67c7480a5d1`, `finding-12eccf65-d36f-4427-a8f3-eb8e61e4d890`, `finding-f44f1460-3983-4287-af29-22acb211b3d4`, `finding-9dcec594-9fa3-47af-9547-8b135fdb5a67`
- תפקידים: supplier, kitchen, office, accountant.
- ראיה מכריעה: אותן פעולות הושלמו בקבלות באמצעות locators סמנטיים (`role`/`label`), ללא selector חופשי; מקור ה־UI משתמש ב־`button`, `label`/`htmlFor` ו־`aria-label`; בדיקות Axe, מקלדת ושמות נגישים עברו בשני השחזורים.
- אין ראיה ל־`actual inaccessible control`. הממצא המטא־רוחבי זיהה נכון שיש סתירה, אך אינו מוכיח פגם נגישות.

### C-04 — הערת אי־התאמה חסרה בקבלה חלקית

- סיווג: `FALSE_POSITIVE`
- תצפית: `finding-c04bc985-bb9a-4c04-bf6a-705d66ebf296`
- ראיה מכריעה: `agents/kitchen/actions/33ead7df-650a-4245-9bfc-b48b236f5575.json` מתעד fill מוצלח בשדה `הערה לקבלת חזה עוף טרי` לפני פעולת השמירה; צילומי 005–008 וה־DB/audit verifier תומכים בסדר זה. שני השחזורים עברו.
- גורם: snapshot ביניים לפני מילוי ההערה ופרשנות סוכן שגויה.

### C-05 — אין זיהוי גלוי של ההזמנה והקבלה לפני שמירת חשבונית מקושרת

- סיווג: `CONFIRMED_DEFECT`
- תצפיות: `finding-c860c83a-923b-4177-9452-d2bb9288b869`, `finding-cf0acdfc-7a18-4538-9ebd-2715576dbcc1`, `finding-3a5e9b85-7935-4feb-a99f-3b12713d3b40`
- ראיה מכריעה: `browser-evidence.json` מתעד כניסה עם `supplier`, `order` ו־`receipt`; `InvoiceNew.tsx` קורא אותם ומעביר אותם ל־RPC, אך מציג רק משפט כללי על קישור אוטומטי, ללא מספר או מזהה ניתן לאימות. אימות DB הוכיח שהקישורים עצמם נשמרו בדיוק פעם אחת—לכן זה פגם שימושיות לפני שמירה, לא כשל data-integrity.
- Issue: [#2](https://github.com/MSA-I/NIR-APP/issues/2)

### C-06 — אין ניווט לאחר יצירת חשבונית

- סיווג: `FALSE_POSITIVE`
- תצפית: `finding-0a7f5058-d2e2-442a-80a1-0b73e4a35852`
- ראיה מכריעה: קבלת הפעולה `96912fda-4861-4aa9-afb6-8e15211f8028.json` מתעדת מעבר מ־`/invoices/new` אל `/invoices/<id>`; צילום 009 מציג את דף החשבונית; `InvoiceNew.tsx` קורא ל־`navigate` לאחר success. שני השחזורים עברו.
- גורם: `snapshot timing problem` בזמן המעבר.

### C-07 — כפתור הרצת בדיקות אוטומטיות מושבת

- סיווג: `FALSE_POSITIVE`
- תצפיות: `finding-82615191-6d2e-4fdf-9201-c5b9bdb6c809`, `finding-ec1e6a80-1fb6-482e-92b3-f221c279a6b8`
- ראיה מכריעה: בריצה המקורית הכפתור הופעל בהצלחה שלוש פעמים; הוא מושבת בקוד רק בזמן `checking`. שני השחזורים השלימו את אותו מסלול.
- גורם: `transient state` לאחר click.

### C-08 — חשבונית עם warnings זמינה ל״העברה לבדיקה״

- סיווג: `EXPECTED_BEHAVIOR`
- תצפית: `finding-fd985ee8-1fc2-4624-9394-af626ce0f420`
- ראיה מכריעה: הפער מול הזמנה/קבלה הוא `warning` והזיכוי הפתוח הוא `info`; הפעולה מעבירה מ־`received` ל־`in_review`, אינה מאשרת תשלום. המעבר נרשם פעם אחת עם סיבה ואומת ב־DB/audit. רק `critical` מחייב בירור או override לפי `ARCHITECTURE.md`.

### C-09 — זיכוי פתוח אינו חוסם אישור דרישת תשלום

- סיווג: `BUSINESS_DECISION_REQUIRED`
- תצפיות: `finding-8c823dbf-4485-490e-a786-7293f3076cfe`, `finding-d9cdf1d8-608e-4b20-82ea-9d6013a70b18`
- ראיה מכריעה: האזהרה והכפתור הפעיל נראו; האישור וה־audit תקינים. אין כלל קנוני שקובע אם זיכוי בסטטוס פתוח/נדרש/התקבל חייב לחסום, לקזז אוטומטית או לדרוש override. שינוי כאן הוא שינוי כספי ולכן לא נפתח Issue ולא הוצע fix אוטומטי.

### C-10 — דרישת תשלום נשארת actionable אחרי ביצוע

- סיווג: `FALSE_POSITIVE`
- תצפית: `finding-18c8698b-a3ae-4f59-bafd-75cea95392b7`
- ראיה מכריעה: לאחר סגירת מודאל ההצלחה צילום 009 מציג ״אין העברות שממתינות לביצוע״ והפריט נמצא רק תחת ״בוצעו לאחרונה״. הקוד מסנן `pending` ל־`approved/sent_for_execution` ואת `executed/matched` ל־`done`. DB, יתרה, הקצאה ו־audit עברו; שני השחזורים חזרו על התוצאה.
- גורם: `incorrect agent interpretation` של מצב המודאל/המסך שלפני `onDone`.

### C-11 — נוסח סטטוס שגוי ״הועברה בוצעה״

- סיווג: `CONFIRMED_DEFECT`
- תצפית: `finding-b6a94361-aec3-42ef-8f92-c1dbba5e5975`
- ראיה מכריעה: `src/lib/status.ts` ממפה `executed` לנוסח השגוי, והוא הופיע בצילום המקור ובשני צילומי השחזור. מצב התשלום עצמו תקין.
- Issue: [#3](https://github.com/MSA-I/NIR-APP/issues/3)

### C-12 — הדוח החודשי אינו snapshot טרנזקציוני

- סיווג: `BUSINESS_DECISION_REQUIRED`
- תצפיות: `finding-f445ccdb-8d29-4016-9522-a8521fccbac3`, `finding-300fa19a-b1f8-4ac3-a0d2-9b9c9e5635f9`, `finding-76d3fb59-2581-4236-9de6-728f246b2a0b`
- ראיה מכריעה: המסך מצהיר במפורש על המגבלה; הייצוא שנבדק היה עקבי מול נתוני הריצה ועבר parsing, totals ו־formula policy. לא הודגמה אי־התאמה ממשית. מעבר ל־snapshot אטומי משנה את חוזה הדיווח, cut-off, late postings וגרסאות export, ולכן נדרשת החלטה עסקית לפני שינוי.

## הכרעת סתירות הנגישות

| תפקיד/בקר | הכרעה | גורם ראשי |
|---|---|---|
| supplier — ״אישור והגשה״ | הבקר נגיש ונלחץ פעמיים; לאחר click שמו משתנה ל״קולט...״ והוא מושבת זמנית | `transient state` |
| kitchen — כרטיס הזמנה | native `button`; נלחץ בהצלחה בריצה המקורית ובשני שחזורים | `snapshot timing problem` בזמן טעינת query |
| kitchen — כמות, סטטוס והערה | `aria-label` מפורש; fill/click הצליחו | `snapshot timing problem` בזמן React render |
| kitchen — ״צילום / העלאה״ | native `button`; העלאת JPG וקישור המסמך אומתו | `snapshot timing problem` אחרי מסך הצלחה |
| office — שדות דרישת תשלום | `label`/`htmlFor`; fill ושליחה הצליחו | `snapshot timing problem` אחרי פתיחת modal |
| accountant — ייבוא בנק | כפתורים ושדות native ומתויגים; upload/fill/click אומתו | `snapshot timing problem` בין שלבי modal |
| accountant — ייצוא Excel | native `button`; הורדה ו־export verifier עברו | `incorrect agent interpretation` של snapshot ביניים |

לא נמצא מקרה מסוג `actual inaccessible control`. קוד האוסף עצמו מציין שבקר שהתנתק במהלך render עשוי להידלג וש־snapshot הבא רואה את ה־DOM החדש; הסוכן הפך את מצב הביניים לתצפית בלי להצליב תחילה את קבלת הפעולה.

## סדר תיקון מומלץ

1. [#2](https://github.com/MSA-I/NIR-APP/issues/2) — הצגת הקשר הזמנה/קבלה לפני שמירת החשבונית המקושרת.
2. [#3](https://github.com/MSA-I/NIR-APP/issues/3) — תיקון נוסח סטטוס `executed`.
3. לאחר מכן, ורק אם מתקבלות הכרעות: מדיניות זיכוי פתוח לפני אישור ומדיניות snapshot לדוח החודשי.
4. חיזוק QA לא־חוסם: לדרוש re-snapshot יציב והצלבה עם receipt לפני שסוכן מדווח שחסר בקר נגיש.

בדיקות אנושיות עם קורא מסך, zoom של 200% ומכשיר פיזי לא בוצעו בשלב הטריאז׳; לכן המסקנה היא שאין ראיה לפגמי הנגישות שדווחו, לא אישור גורף שאין פגמי נגישות אחרים.
