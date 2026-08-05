# מסירת אינטגרציית QA על קו Enterprise

תאריך: 05.08.2026

## מצב

- ענף: `codex/qa-enterprise-integration-20260805`.
- בסיס: `main` מקומי ב-`2ff1fb4a056e57dbab8639db840baf46f83fab31`.
- הבסיס מכיל את גלי Enterprise ‏0–6 ואת migrations ‏`0053`–`0064`.
- `origin/main` עדיין ב-`01ca87cf6a88163b61a040d33a54f46527ec0e68`; 50 קומיטי ה-Enterprise אינם קיימים ב-remote ref.
- תשתית ה-QA, תיקון הקשר החשבונית, תיקון נוסח הסטטוס ומסך הקבלה לקריאה בלבד הועברו ידנית/ב-cherry-pick מבוקר.
- קונפליקטי `package.json`, ‏`package-lock.json` ושני סקריפטי השער נפתרו סמנטית: נשמרו Vitest/TanStack/React-PDF והקשחות ה-Enterprise, ונוספו פקודות ותלויות QA והמנעול המשותף.
- לא הורצו build, tests, SQL, RLS, Playwright, `quality` או `qa:full`.

## Job Object ב-Windows

ה-polling לפי CIM/PID הוחלף ב-`runCommand` ב-Windows ב-Job Object מקומי:

- `CreateProcess` במצב suspended.
- `AssignProcessToJobObject` לפני `ResumeThread`.
- `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
- timeout ו-descendant grace רגילים תחומים בזמן וחוזרים רק אחרי `ACTIVE_PROCESS_ZERO`.
- spec וה-environment עוברים ב-stdin, לא ב-argv.
- מסלול Unix נשאר process group.

הקומיטים: `a15dbe12196b63362d6c9aa4c724e6b4085f6865`, ‏`ededa227ecf702cac274a2d002e40d1b69739a3a`. הפרוטוקול מקבל רק `JOB_EMPTY`; כשל Windows שאינו מאפשר להוכיח zero נכנס ל-containment hold מפורש ומשאיר את ה-mutex מוחזק. זהו המסלול הלא־תחום היחיד, במכוון, משום שחזרה ממנו הייתה משחררת את ה-stack לשימוש מקביל ללא הוכחת cleanup. סקירה בלתי־תלויה קבעה `PASS / READY_FOR_RUNTIME_VALIDATION` ליישום הסטטי. נוספו בדיקות ממוקדות אך הן לא הורצו. `startQaPreview` הוא מסלול spawn נפרד ולא שונה.

## migrations

| טווח | מצב |
|---|---|
| `0053`–`0064` | קיימות בבסיס המקומי ונכללות בענף זה. |
| `0065` | מוקצית ל-Wave 6b; טרם מומשה. |
| `0066` | מוקצית ל-Wave 7; טרם מומשה. |
| `0067` | מוקצית ל-Wave 8; טרם מומשה. |
| `0068`–`0072` | מוקצות ל-Wave 9; טרם מומשו. |
| `0073`–`0074` | שמורות לשני תיקוני ה-QA, אך אסורות לנחיתה לפני `0053`–`0072`. |

אסור ליצור migrations ריקות כדי למלא את הפער ואסור להזיז את תיקוני ה-QA אל `0065`–`0066`.

## הכרעות scope

1. snapshot סופי לרו״ח הוא פר-`legal_entity`, כאשר `org_id` נשאר גבול הדייר.
2. כל open credit חייב לקבל ייחוס מוכח לישות משפטית לפני הפעלת override מסוקף. legacy שלא ניתן לייחס חוסם migration/preflight; אין total ארגוני שיחשוף נתונים בין ישויות.
3. ה-policy המאושר נשמר: override מפורש עם סיבה ו-audit, ללא קיזוז אוטומטי, ללא סגירת זיכוי וללא שינוי סכום הדרישה.

ההכרעות מתועדות ב-`docs/OPEN-DECISIONS.md` ‏#95–#96.

## תנאים ל-port של `0073`

- לקרוא את הגוף הסופי של `transition_payment_request` לאחר `0072`; לא להעתיק גוף ישן.
- לקבוע `payment_requests.unit_id` ולדרוש שכל החשבוניות המשויכות שייכות לאותה ישות.
- לקרוא `assert_unit_in_scope`, להסיר את exemption של הפונקציה ולסיים באפס הפרות A5.
- לנעול ולחשב רק זיכויים מאותה ישות; זיכוי לא מסווג נכשל סגור.
- לשמור audit/event יחידים ו-replay idempotent.

## תנאים ל-port של `0074`

- `monthly_report_snapshots.unit_id` הוא legal entity עם FK מרוכב ו-unique לפי entity/month/version.
- רישום ב-`private.scope_registry`, רוכב A3, כיסוי A5 וזרועות A/B/C ב-`demo_verify.sql`.
- audit ו-domain event באותה עסקה.
- XLSX נבנה רק מה-snapshot השמור וכולל rows, totals, bank rows, metadata ו-hash, ללא נוסחאות.
- `Reports.tsx` חייב לשמר `safeMonth` ו-`ReauthModal` ולהוסיף בורר legal entity מסונן-סקופ.

## Gate

`BLOCKED / NOT_READY_FOR_PR`

החסימות:

1. migrations ‏`0065`–`0072` ותוכניות Waves 6b–9 טרם נחתו.
2. אין עדיין סכימת scope סופית ל-`payment_requests`, ‏`credit_requests`, ‏`bank_imports` ו-`exceptions` שעליה ניתן לבנות את `0073`–`0074`.
3. קו ה-Enterprise המקומי עדיין לא פורסם; PR לענף `origin/main` יציג גם את 50 הקומיטים האלה.
4. לא קיימת הרצת validation עדכנית לענף זה.

לכן לא בוצעו push, פתיחת PR, merge או סגירת Issues.
