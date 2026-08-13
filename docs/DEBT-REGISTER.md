# DEBT-REGISTER — חוב פתוח ומגבלות ידועות

עודכן: 13.08.2026.

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
  `document.interpretation`, ‏`price_list.intake` ו־`delivery_note.receiving` הן מדיניות נפרדות.
- **סיכון:** טעות מחירון יכולה לחזור על שורות רבות; שינוי סף ללא נתונים הוא ניחוש נוסף.
- **ראיה:** `0076`, ‏`0081`, ‏`0096`, ‏`p13_document_autonomy_config.sql`,
  `p18_document_automation_calibration.sql`.
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
