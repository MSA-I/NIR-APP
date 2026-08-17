# DEBT-REGISTER — חוב פתוח ומגבלות ידועות

עודכן: 17.08.2026.

הקובץ מכיל רק חוב פעיל. סעיפים שנסגרו, תכניות קמפיין וראיות היסטוריות נשמרים ב־Git history.
שאלה עסקית יושבת ב־`OPEN-DECISIONS.md`; כאן מתועדת רק המגבלה, הראיה והצעד הבא.

לפני סגירת סעיף יש להוסיף או לעדכן טענה בשער. הצלחה היסטורית או קריאת קוד לבדה אינן PASS.

## P0 — גבולות אמון ושלמות

### §7 — רשם חריגי `SECURITY DEFINER` עדיין אינו ריק

- **מצב:** `private.scope_definer_exemptions` מאפשר מעבר הדרגתי של פונקציות ישנות לאכיפת scope
  מפורשת. `check:exemptions`, ‏A5 והבריח של ארגון רב־יחידתי מונעים סחף, אך החריגים עצמם נשארים.
- **סיכון:** ארגון עם יחידות אחיות אינו נתמך כל עוד קיימת פונקציה פטורה. הגנת `org_units` היא
  גם גדר תפעולית, לא רק טענת preflight.
- **ראיה:** `0057_scope_enforcement.sql`, ‏`0095_scope_enforcement_marker_hardening.sql`,
  `scripts/check-exemption-pin.ts`, ‏`p9_five_domains.sql`, ‏`p1_preflight.sql`.
- **הצעד הבא:** ריקון פונקציה־פונקציה עם actor, tenant, unit, tables, reason, audit וטסט; אין לבצע
  הצהרה־מחדש גורפת.

### §8 — חוזה “פקודות אינן כותבות domain events ישירות” צר מדי

- **מצב:** `p5_domain_events.sql` מצמיד את האינווריאנט לפקודה אחת, אף שהחוזה חל על קבוצת
  הפקודות הפיננסיות והעסקיות.
- **ראיה:** `supabase/tests/p5_domain_events.sql`.
- **הצעד הבא:** להרחיב את הטענה לכל הפקודות המבוקרות בלי לשנות את מנגנון fan-out מ־audit.

### §9 — נוכחות re-assert במיגרציות עתידיות תלויה בזיכרון המחבר

- **מצב:** `check:exemptions` מצמיד את מספר החריגים, אך אינו דורש שכל מיגרציה מעל `0057` תריץ
  מחדש את `private.scope_enforcement_violations()`; `0067` הוא התקדים לפער.
- **ראיה:** `0057_scope_enforcement.sql`, ‏`0067_offline_receiving.sql`,
  `scripts/check-exemption-pin.ts`.
- **הצעד הבא:** check טקסטואלי זול שמכשיל מיגרציה עתידית ללא בלוק re-assert.

### §10 — `p2_invoice_without_order_count()` רגיש ל־RLS

- **מצב:** הפונקציה היא invoker ומשתמשת ב־`NOT EXISTS` על קישור שמסונן ב־RLS. הקוראים החיים
  מוגבלים ל־owner/office בלקוח, אך החוזה אינו נאכף בגוף ה־RPC.
- **סיכון:** קורא עתידי מתפקיד אחר עלול לקבל מספר שגוי, לא דליפת שורות.
- **ראיה:** `p2_data_reliability.sql`, ‏`src/lib/alerts.ts`,
  `src/pages/serverListScreens.spec.tsx`.
- **הצעד הבא:** הכרעה בין guard תפקיד בשרת לבין `SECURITY DEFINER` עם scope מפורש.

### §19 — דיג׳סט הפרומפט אינו הוכחת התנהגות מודל

- **מצב:** `PROMPT_VERSION` והדיג׳סט מוכיחים איזה prompt נשלח. בדיקות המודל הן mocks; אין corpus
  חי שמוכיח דיוק התנהגותי או drift.
- **ראיה:** `supabase/functions/interpret-document/core.ts`, ‏`core.test.ts`,
  `document_filings.reason_code`, ‏`p18_document_automation_calibration.sql`.
- **הצעד הבא:** למדוד תוצאות מול הכרעת אדם על מסמכי הדייר החי ולפלח לפי prompt/model/version.

### §20 — `document_text_sanitize` נשאר denylist

- **מצב:** מפתח הכפילות הוא allowlist, אך הטקסט הנשמר מעדיף נאמנות למסמך ומסיר רק תווים ידועים.
- **סיכון שיורי:** תו בלתי־נראה לא מוכר יכול להקשות על חיפוש, אך אינו עוקף את מפתח הכפילות.
- **ראיה:** `0077_apply_document_interpretation.sql`, ‏`p14_apply_interpretation.sql`.
- **הצעד הבא:** אין שינוי ללא הכרעה שנאמנות המקור פחות חשובה מנרמול הטקסט הנשמר.

## ביצועים וקנה מידה

### §1 — קריאות הדשבורד צומצמו, לא אוחדו כולן

- **מצב:** `management_dashboard_snapshot()` מרכז את מדדי ההנהלה שהוגדרו. גרפים ורשימות
  מפורטים עדיין כוללים round trips נפרדים.
- **ראיה:** `0100_management_dashboard_snapshot.sql`, ‏`p21_dashboard_snapshot.sql`.
- **הצעד הבא:** למדוד latency ולקדם מדד נוסף רק אחרי שהגדרתו העסקית סגורה.

### §12 — rider הסקופ הקנוני אינו InitPlan מובטח

- **מצב:** `auth_scopes() @> array[unit_id]` עלול להיות מוערך פר־שורה כשאימוץ יחידות גדל.
  עטיפה ב־`(select auth_scopes())` נמדדה מהירה יותר, אך משנה חוזה שמוצמד ב־A3.
- **ראיה:** `0057_scope_enforcement.sql`, ‏`p3_org_scope.sql`,
  `ENTERPRISE-SECURITY-MODEL.md`.
- **הצעד הבא:** אם משנים, לעדכן באותו commit את A3, מודל האבטחה והסוויטה.

### §13 — `global_search` אינו נהנה מ־pg_trgm בשרשרת ה־OR הנוכחית

- **מצב:** עמודות לא־מאונדקסות ו־join לספק מונעים BitmapOr יעיל.
- **ראיה:** `0069_global_search_result_type_gate.sql`, ‏`global_search` ומדידות התכנית ההיסטוריות
  שנשמרות ב־Git.
- **הצעד הבא:** לעצב מחדש את השאילתה או לצמצם לעמודות מאונדקסות; אין הצדקה למנוע חיפוש חדש.

### §14 — מסנן `invoice_has_duplicate` אינו גדל היטב

- **מצב:** כעמודה מוצגת הוא זול; כמסנן על נפח גדול הוא יקר.
- **ראיה:** `serverList` וחוזי רשימת החשבוניות.
- **הצעד הבא:** לפני חשיפה במסך נוסף, לבחור אינדקס תומך, count מתוכנן או לוותר על המסנן.

### §15 — `count: 'exact'` שולט בעלות בקנה מידה גדול

- **מצב:** הספירה המדויקת היא חלק מחוזה pagination הנוכחי, אך נעשית יקרה משמעותית ככל שהטבלה
  גדלה.
- **ראיה:** `src/lib/serverList.ts`, ‏ADR-0007 וחוזי הרשימות.
- **הצעד הבא:** מעבר מעל רף שורות ל־planned count חייב להגיע עם טקסט שמצהיר “כ־N”.

### §33 — `@supabase/supabase-js` עדיין מצוין כטווח צף

- **מצב:** `package-lock.json` מגן על `npm ci`, אך `npm install` יכול להזיז שרשרת auth בלי שינוי
  מכוון בקוד.
- **ראיה:** `package.json`, ‏`package-lock.json` ושומר bundle הפריסה.
- **הצעד הבא:** להצמיד גרסה מדויקת או להצמיד בשער את גרסת `auth-js` שנפתרה.

## מסמכים, OCR ו־Storage

### §6 — resume בענן אינו מוכח על ידי FileStore מקומי

- **מצב:** חוזי tus מוכיחים חידוש העלאה מקומית. התנהגות Storage מנוהל אינה זהה ולא נבדקה.
- **ראיה:** `src/lib/tusUpload.ts`, ‏`src/lib/tusUpload.spec.ts`.
- **הצעד הבא:** smoke מורשה מול Storage מנוהל עם ניתוק וחידוש של קובץ גדול.

### §16 / §24 — סף האוטונומיה `0.900` אינו מכויל על נתוני הדייר החי

- **מצב:** הסף קיבל מדידה מוקדמת על corpus ציבורי, אך לא על 50 מסמכי דייר עם הכרעת אדם.
  `document.interpretation`, ‏`price_list.intake`, ‏`delivery_note.receiving` ו־
  `document.packet_split` הן מדיניות נפרדות. גם סף הפיצול החדש טרם כויל על חבילות PDF של הדייר.
- **סיכון:** טעות מחירון יכולה לחזור על שורות רבות; שינוי סף ללא נתונים הוא ניחוש נוסף.
- **ראיה:** `0076`, ‏`0081`, ‏`0096`, ‏`0140`, ‏`p13_document_autonomy_config.sql`,
  `p18_document_automation_calibration.sql`, ‏`p47_mixed_document_packets.sql`.
- **הצעד הבא:** למדוד 50 מסמכים חיים עם false-positive/false-negative נפרדים לפי סוג מסמך; אין
  להוריד את הרצפה לפני המדידה.

### §17 — המסלול האוטומטי עדיין משתמש בתווית חריג מקורבת

- **מצב:** פתיחה ידנית משתמשת ב־`item_not_ordered`; `apply_document_interpretation` עדיין עשויה
  לפתוח `receipt_mismatch` עם `details.code='item_not_ordered'`.
- **ראיה:** `0086`, ‏`0087`, ‏`0077`, ‏`p14_apply_interpretation.sql`, ‏`src/lib/status.ts`.
- **הצעד הבא:** הזרקה בעוגנים לגוף החי ועדכון שלוש הטענות באותו commit.

### §27 — `single_open_order` הוא heuristic מקובל לתעודת משלוח

- **מצב:** דרגת הראיה החלשה מקשרת כאשר לספק יש הזמנה פתוחה יחידה. התוצר הוא טיוטה בלבד והדרגה
  נשמרת ומוצגת לאדם.
- **ראיה:** `0090_automatic_delivery_note_receiving.sql`, ‏`p16_automatic_delivery_note_receiving.sql`.
- **הצעד הבא:** אחרי 30 טיוטות, למדוד כמה שיוכים מדרגה זו תוקנו ידנית.

### §31 — lease של תמונת קבלה offline אינו מתחדש בזמן upload ארוך

- **מצב:** claim אטומי מונע התחלה כפולה, אך lease בן 15 דקות ללא heartbeat יכול לפוג תוך העלאה.
- **ראיה:** `src/lib/offlineDb.ts`, ‏`offlinePhotoQueue.spec.ts`.
- **הצעד הבא:** renewal תקופתי עם ownership check ותרחיש browser שחוצה את חלון ה־lease.

### §32 — תקיעת bootstrap מגודרת, לא נפתרה בשורש

- **מצב:** watchdog בן 15 שניות מחזיר מסך retry/logout במקום loader אינסופי; הנעילה האפשרית
  ב־`@supabase/auth-js` לא שוחזרה בדטרמיניזם.
- **ראיה:** `src/auth/AuthContext.tsx`, ‏`bootstrapWatchdog.spec.tsx`.
- **הצעד הבא:** בדיקה שמאלצת `getSession` תקוע מול `navigator.locks`, ואז להכריע אם לאתחל client.

### §35 — assessment מסמך אינו מנכה צריכה מצטברת לפני אישור

- **מצב:** `document_reconciliation_assessment` משווה לכמות שהוזמנה. הצריכה המצטברת נתפסת בשער
  האישור הסופי של החשבונית, לא בשער המסמך.
- **ראיה:** `0108`, ‏`0099`, ‏`p29_document_reconciliation_assessment.sql`.
- **הצעד הבא:** אין ליצור מצבר שני. פתרון תלוי בהכרעת §29 על reversal של snapshot.

### §37 — שימור עיצוב חוברת Excel לא הוכח

- **מצב:** SheetJS CE מוכיח תוכן, טיפוסים ו־formula neutralization; הוא אינו מבטיח שכל סגנון
  בחוברת רו״ח ישרוד round trip.
- **ראיה:** `src/lib/exportTemplateWorkbook.ts`, ‏`exportTemplateWorkbook.spec.ts`.
- **הצעד הבא:** חוברת מעוצבת אמיתית אחת, round trip והשוואה חזותית לפני הבטחת שימור עיצוב.

### §38 — חבילות PDF מעורבות מוגבלות ל־100 עמודים ול־20 עמודי OCR אוטומטי

- **מצב:** Worker מקבץ רינדור לפי מגבלת זיכרון, אך קובץ מעל 100 עמודים או עמוד יחיד שחורג מן
  הגבול נדחה. מעל 20 עמודי OCR, חילוץ חלקי או segment מתחת לסף אינם מתפצלים ללא אדם.
- **סיכון:** מסמך קצה גדול או פגום דורש פיצול חיצוני; אין עדיין corpus חי שמודד דיוק גבולות בין
  חשבונית מרכזת, תעודות משלוח ומסמכים נוספים באותו PDF.
- **ראיה:** `worker/ocr/src/parsers.py`, ‏`worker/ocr/self_check.py`, ‏`0140`, ‏P47 וחוזי
  `interpret-document-v11`.
- **הצעד הבא:** למדוד 50 חבילות אמיתיות עם הכרעת אדם, לרבות גבול מסמך שגוי, ורק אז לשנות סף או
  מגבלת עמודים.

### §39 — ‏**נסגר 17.08.2026** — ה־OCR worker הועבר ל־VPS

- **נסגר.** הפול רץ על Hetzner (`95.217.134.162`, ‏Ubuntu 24.04, ‏4 vCPU, ‏7.7GB RAM), שני
  workers על image של `59fcb63`, ‏`OCR_JOB_TIMEOUT_SECONDS=900`, ‏`OCR_PAGE_CONCURRENCY=3`,
  מזהים ייחודיים `supplyflow-59fcb63-1/2`. ‏`systemctl is-enabled docker` מחזיר `enabled`
  ו־`--restart unless-stopped` על ה־containers, כך שאתחול השרת מחזיר את הפול לבד.
  ‏`ufw` פעיל: נכנס חסום למעט SSH; ה־worker הוא outbound-only.
- **הסודות** ב־`/etc/supplyflow/ocr.env` במצב `600` בבעלות root, מחוץ ל־Git.
- **הראיה שזה עובד, לא שזה רץ:** העלאה אמיתית של PDF סרוק בן 4 עמודים (ללא שכבת טקסט) לאתר
  החי נתפסה על ידי `supplyflow-59fcb63-1`, דיווחה `progress 3/4` תוך כדי, והגיעה ל־`completed`.
  הפול המקומי היה עצור באותו רגע, כך שהייחוס חד־משמעי.
- **מה שהוחלף:** הפול על תחנת העבודה נעצר לאחר שהחדש הוכיח את עצמו, בסדר הזה ולא הפוך. שני
  פולים מול אותו פרויקט נלחמים על אותם ג'ובים.
- **התיעוד:** ‏`docs/OCR-WORKER-HOSTING.md`, ‏`scripts/run-ocr-worker.sh`, ומדריך בשפה פשוטה
  ב־`NIR-APP-DOCS\מדריך העברת ה-OCR worker לשרת VPS.pdf`.
- **מה שנשאר פתוח:** אין ניטור. שרת שנופל או worker שמפסיק לתפוס אינם מתריעים לאיש; הסימן
  היחיד הוא מסמכים שנתקעים ב„ממתין בתור” עד שסיווג ה־stuck מגיע לשעתיים. זה חוב חדש ולא
  המשך של הסעיף הזה.

<details>
<summary>הניסוח המקורי, לפני הסגירה</summary>

### §39 — ה־OCR worker של הייצור רץ על מחשב העבודה של הבעלים

- **מצב:** ‏`supplyflow-ocr-live-1/2` רצים ב־Docker Desktop על תחנת Windows אחת, מחוברים ישירות
  ל־Supabase של הייצור. אין host מנוהל, אין תזמון הפעלה בעליית מערכת ואין ניטור.
- **סיכון:** מחשב שנרדם או Docker Desktop שנעצר מפסיקים את כל עיבוד המסמכים באתר החי. הממשק ימשיך
  להציג „ממתין בתור” עד שסיווג ה־stuck של `0130` יגיע ל־`active_over_two_hours` — שעתיים שבהן
  המשתמש רואה מסך שנראה תקין ושום עבודה לא מתקדמת.
- **ראיה:** ‏`scripts/run-ocr-worker.ps1`, ‏`docker-compose.ocr.yml`, ותיעוד הבעיה ב־17.08.2026:
  לפני הכתיבה של הסקריפט הריפו לא הכיל שום דרך להפעיל את ה־worker של הייצור, וה־compose הצביע על
  ‏`2026-08-12-contract-v2` בזמן שרצה build אחר.
- **הצעד הבא:** הכרעת אירוח (VM קטן תמיד־דלוק או שירות container מנוהל) והעברת הסקריפט לשם. עד אז
  יש לוודא ידנית שהמכונה ערה. אין להסתמך על `restart: unless-stopped` — הוא מכסה קריסת container,
  לא מחשב כבוי.

</details>

### §43 — אין ניטור על פול ה־OCR

- **מצב:** אחרי סגירת §39 הפול רץ על VPS מנוהל, אבל **איש אינו יודע אם הוא חי**. אין התראה על
  שרת שנפל, על container שנעצר, על טוקן שפג או על תקרת OpenAI שנגמרה.
- **סיכון:** הסימן היחיד למשתמש הוא מסמכים שנתקעים ב„ממתין בתור”, וסיווג ה־stuck של `0130`
  מגיע ל־`active_over_two_hours` רק אחרי **שעתיים**. זה חלון שבו האתר נראה תקין ושום עבודה
  אינה מתקדמת. ההעברה ל־VPS הקטינה את ההסתברות לנפילה; היא לא קיצרה את זמן הגילוי.
- **מה כן קיים:** ‏`--restart unless-stopped` מכסה קריסת container, ו־`systemctl is-enabled docker`
  מכסה אתחול שרת. שניהם מתקנים בשקט ואינם מדווחים דבר.
- **ראיה:** ‏`scripts/run-ocr-worker.sh --status` הוא הבדיקה היחידה, והיא ידנית;
  ‏`private.document_processing_stuck_reason` ב־`0130` הוא מקור סף השעתיים.
- **הצעד הבא:** הזול ביותר שמכסה את רוב המקרים — שאילתה מתוזמנת שמתריעה כשקיים ג'וב במצב
  `queued` מעל סף קצר בהרבה משעתיים (למשל 15 דקות). זה מודד את **התוצאה** ולא את בריאות
  התהליך, ולכן תופס גם נפילת שרת, גם טוקן שפג וגם תקרת OpenAI — בלי סוכן ניטור על המכונה.

### §42 — שער הכיול של קליטת המחירונים אינו נגיש מהמוצר

- **מצב:** ‏`apply_eligible_price_list_interpretation` (‏`0096`) מחייבת רשומת
  ‏`price_list_automation_scope_decisions` במצב `eligible` לטביעת ה-scope; בלעדיה כל מחירון חוזר
  ‏`queued_for_review` עם `shadow_evidence_missing` או `shadow_scope_not_eligible` ו**בלי לכתוב
  רשומת החלטה** — כלומר גם המסך אינו יכול לספר שהאוטומציה רצה. ‏`decide_price_list_automation_scope`
  דורשת `is_platform_admin()`, אימות סיסמה טרי, ו**דירוג של כל שורת shadow כ-`correct`**
  (‏`price_list_calibration_reviews`). **אין במוצר שום מסך שכותב את הדירוגים האלה:**
  ‏`/document-operations` קורא את `get_document_control_price_review_queue` ומציג תור לקריאה בלבד,
  והפעולה היחידה בו היא „פתיחת המסמך”. לכן המצב `eligible` אינו בר-השגה בפועל, והמתג
  ‏`price_list.intake` בהגדרות אינו מספיק בעצמו.
- **מה כן תוקן (17.08.2026):** מסך האישור קורא את `price_list_shadow_lines` וממלא מראש את השורות
  שהשרת התאים, כך שהעלות האנושית של השער אינה 338 הכרעות אלא לחיצה אחת. **השער עצמו לא נגע.**
- **הפער שנשאר בנוסף:** ‏`0096` מעניקה `select` על טבלאות ה-shadow ל-`owner` בלבד, ולכן משתמש
  ‏`office` שמעלה מחירון אינו מקבל מילוי מראש — הוא נופל לאישור ידני מלא. זה חוסר נוחות, לא ערך
  שגוי: שורה שלא מולאה נשארת בלתי-מאושרת וגלויה.
- **ראיה:** ‏`0096_document_automation_calibration_shadow_operations.sql:2160-2166` (‏`eligible`
  דורש `reviewed_count = line_count` ו-`correct = line_count`), ‏`:2311-2324` (הענף שמחזיר
  ‏`shadow_scope_not_eligible`), ‏`:341-365` (הפוליסות ל-`owner`), ‏`src/pages/DocumentOperations.tsx`
  (תור לקריאה בלבד), ‏`src/components/document-review/PriceListReviewConfirmation.tsx` (המילוי מראש).
- **הצעד הבא:** הכרעת בעלים על מי מכשיר scope. שתי אפשרויות זולות: מסלול שבו בעל הארגון מדרג את
  שורות ה-shadow ומכשיר את ה-scope, או הכשרה אוטומטית אחרי מחירון אחד מאותו scope שאושר ידנית
  ובלי תיקון אף שורה. שתיהן מיגרציה + מסך; אין להרחיב את `is_platform_admin()` בשקט.

### §41 — שתי טבלאות של `0140` ללא `zz_organization_write_guard`

- **מצב:** ‏`document_packets` ו-`document_packet_segments` נושאות `org_id` אך **אין עליהן** את
  טריגר הנעילה `zz_organization_write_guard`. הכיסוי בייצור הוא 98 מתוך 100 טבלאות `org_id`.
- **זה אינו drift:** ‏rebuild מקומי טרי מ-`0001` עד `0141` מראה בדיוק את אותן שתי הטבלאות ואותו
  ‏98/100. זו הצורה ש-`0140` יצרה, לא הבדל בין ייצור לריפו. לשם השוואה, `0137` מחברת את הטריגר
  במפורש לשש טבלאות חדשות (שורות 513–528); ‏`0140` לא מזכירה אותו בכלל.
- **החשיפה בפועל נמדדה ב-17.08.2026, והיא צרה ממה שנוסח כאן בתחילה.** מול הייצור:
  ‏`relrowsecurity` **וגם** `relforcerowsecurity` הם `true` בשתי הטבלאות; ל-`authenticated` יש
  ‏**`SELECT` בלבד** ואין לו `INSERT`/`UPDATE`/`DELETE`; ה-DML כולו שמור ל-`service_role`.
  הפוליסות: ‏`*_select` עם `org_id = auth_org()` ובנוסף פרדיקט היחידה, ולצדה
  ‏`scope_rider_*` מסוג `*` על כל הפקודות. כלומר **תפקיד API של דייר אינו יכול לכתוב לטבלאות
  האלה כלל**, וקריאה מסוננת לארגון וליחידה.
- **הסיכון שנשאר, מדויק:** ‏`zz_organization_write_guard` היא שכבת ההגנה על כתיבות של
  ‏`SECURITY DEFINER` — אלה רצות כ-`service_role` ו**עוקפות RLS**. באג בפונקציה כזו שיכתוב שורה
  עם `org_id` שגוי ייתפס על ידי הנעילה בכל טבלה אחרת, ובשתי אלה לא. זה סיכון אמיתי, אבל הוא
  סיכון של באג פנימי — לא של גישה מבחוץ. שתי הטבלאות מחזיקות מניפסט עמודים וטווחי עמודים של
  חבילות PDF, לא ערכים כספיים.
- **למה אף שער לא תפס:** אין assertion שדורש כיסוי מלא של הנעילה — לא ב-`verify`, לא בסוויטות
  ה-SQL ולא ב-`scope_enforcement_violations()`. השער היחיד שבדק זאת אי-פעם היה סקריפט פריסה
  חד-פעמי מ-10.08 שדרש שוויון, ומאז לא רץ. התגלה ב-preflight של פריסת `0141`.
- **אומת ב-17.08.2026:** פריסת `0141` הריצה את שאילתת הכיסוי לפני ואחרי והוכיחה שקבוצת הטבלאות
  הלא-מכוסות **זהה** — `0141` לא הרעה את המצב. הפער נשאר בדיוק כפי שהיה.
- **ראיה:** ‏`0140_mixed_document_packets.sql` (אין בו `zz_organization_write_guard`),
  ‏`0137_consolidated_supplier_invoice.sql:513-528` כדוגמה הנגדית, שאילתת הכיסוי ב-
  `NIR-APP-DOCS\deploy-20260817-0141-page-progress.ps1`, ומדידת ה-RLS וההרשאות מול
  ‏`pg_class`, ‏`pg_policy` ו-`information_schema.role_table_grants`.
- **הצעד הבא:** מיגרציה forward-only שמחברת את הטריגר לשתי הטבלאות, **ובאותו commit** assertion
  שדורש כיסוי מלא — אחרת הפער הבא ייווצר באותה שקט. ה-assertion הוא החלק החשוב מבין השניים:
  חיבור הטריגר מתקן שתי טבלאות, ה-assertion מונע את הפעם הבאה. לא נכלל ב-`0141`: הוא נוגע בגבול
  כתיבה של טבלאות שאינן חלק מהשינוי הזה, ומיגרציית אבטחה ראויה לשער משלה ולא לנסיעה חופשית.
- **דחיפות:** בינונית, לא בוערת — לפי המדידה למעלה אין נתיב גישה מבחוץ, רק היעדר רשת ביטחון
  לבאג פנימי עתידי. אין להשתמש בזה כתירוץ לדחות שוב: הפער נוצר בשקט פעם אחת, וללא ה-assertion
  הוא ייווצר בשקט שוב.

### §40 — סף הפיצול של מחירונים ארוכים כויל על שבע מדידות בלבד

- **מצב:** הפיצול מומש (`supabase/functions/interpret-document/split.ts`): מעל 12,000 תווים המסמך
  נחתך לטווחי עמודים של ~9,000 תווים, עד 4 קריאות **במקביל**, והתוצאות ממוזגות. במקביל ולא
  בטור — המעטפת חוסמת זמן־קיר, ולכן שתי קריאות בנות 60 שניות נכנסות בו בעוד שתיים בטור לא.
- **סיכון:** הסף נגזר משבע נקודות ייצור (1,447 תווים → 6.5 שניות; 8,856 → 45.0; 17,135 → כשל).
  נקודה אחת סותרת: סריקה בת 27 עמודים ו־18,615 תווים התפרשה ב־14.8 שניות ותיחתך שלא לצורך —
  קריאה אחת מיותרת. תקרת `MAX_OUTPUT_TOKENS = 32_768` וגם תקרת 500 שורות בסכמה נשארות.
- **ראיה:** ‏`split.test.ts`, ‏`document_interpretations.duration_ms` מול
  `document_extractions.payload`, ושדה `usage.split` שנרשם על כל פירוש מפוצל.
- **הצעד הבא:** אחרי 20 מסמכים מפוצלים, להשוות `usage.split.line_items.produced` מול זמן הקריאה
  ולכייל מחדש. אין להזיז את הסף בלי המדידה הזו.

## תהליכים חיצוניים וציות

### §3 — workflow engine ו־report jobs נדחו עד קיום צרכן

- **מצב:** מכונות המצב והייצואים הקיימים מכסים את הצרכים הפעילים. אין הצדקה למנוע workflow,
  rules engine או job reporting נוסף.
- **ראיה:** `INTEGRATION-ARCHITECTURE.md`, ‏`read_allowed_transitions()` ו־`p9_five_domains.sql`.
- **הצעד הבא:** תכנית חדשה רק כשקיים צרכן אמיתי ומדיד.

### §5 — אין הוכחת webhook ליעד חיצוני אמיתי

- **מצב:** outbox, signing, retry ו־dead-letter נבדקים מקומית; לא אושר endpoint או credentials.
- **ראיה:** `OPEN-DECISIONS.md` #137, ‏`INTEGRATION-ARCHITECTURE.md`, ‏`outbox-worker`.
- **הצעד הבא:** סבב מורשה לאחר בחירת יעד חיצוני אמיתי.

### §22 — אין קורא חוצה־דיירים למדיניות אוטונומיה

- **מצב:** `AutonomyPolicyPanel` מציג את ארגון המפעיל בלבד אף שה־setter מקבל `org_id` יעד.
- **ראיה:** `AutonomyPolicyPanel.tsx`, ‏`Admin.tsx`, ‏`0076`.
- **הצעד הבא:** `platform_autonomy_policies()` מוגן ב־`is_platform_admin()` רק כשיש דייר שני.

### §25 — מסירת מייל מוגבלת ללא דומיין מאומת

- **מצב:** הזמנות דרך Resend sandbox אינן מגיעות לכל כתובת; איפוס סיסמה משתמש במיילר המובנה של
  Supabase ואינו ממותג.
- **ראיה:** `send-invite`, ‏`ForgotPassword.tsx`, ‏`ResetPassword.tsx`,
  `OPEN-DECISIONS.md` #114.
- **הצעד הבא:** אימות דומיין, `INVITE_FROM_EMAIL` ו־SMTP מותאם; אז להריץ invite מלא לכתובת חיצונית.

### §29 — snapshot אישור ממשיך לצרוך כמות לאחר `investigation`

- **מצב:** snapshot האישור immutable ושומר את הכמות צרוכה גם אם סטטוס החשבונית השתנה מאוחר יותר.
- **ראיה:** `0099`, ‏`invoice_three_way_approval_snapshots`, ‏`OPEN-DECISIONS.md` #139.
- **הצעד הבא:** הכרעת owner על התנאים, ואז פקודת reversal מנומקת ואידמפוטנטית אם נדרשת.

### §30 — offboarding חסר retention executor סופי

- **מצב:** בקשה, read-only, ביטול, reactivation וייצוא עמיד קיימים. אין purge פיזי אוטומטי.
- **ראיה:** `0103_tenant_offboarding_export.sql`, ‏`OPEN-DECISIONS.md` #140.
- **הצעד הבא:** dry-run, legal hold, אימות export וגיבוי, אישור Platform Admin ומחיקה מדורגת עם audit.

### §34 — חמישה בדיקנים נשארו מחוץ ל־CI

- **מצב:** `check-p0-security.ps1`, ‏`check-p0-upgrade.ps1`, שני Edge smokes ומסע P4 המשולב
  נשארו ידניים. תיק CI ירוק אינו טענה שהם עברו.
- **ראיה:** `CLAUDE.md`, ‏`.github/workflows/quality-gate.yml`.
- **הצעד הבא:** להמיר את בדיקות PowerShell ל־SQL/Node או להוסיף runner מתאים.

## גבול השחרור הנוכחי

`0133` וה־frontend של ניקוי הפרסונות יכולים להיות מוזגים לריפו בלי להיפרס. Production אינה נקייה
עד rollout עתידי ומאומת. זהו גבול שחרור, לא חוב מוצר חדש.
