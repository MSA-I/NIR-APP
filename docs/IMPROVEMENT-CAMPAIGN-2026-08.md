# SupplyFlow — דוח קמפיין שיפור ייצור 2026-08

**תאריך טיוטה:** 09.08.2026
**ענף:** `codex/improvement-campaign-20260808`
**סטטוס:** מימוש מקומי בביקורת; שער מלא, commit, push ופריסה הם `PENDING`.
**מקור אמת:** קוד ומיגרציות `0086`–`0097`. מסמך זה אינו הופך פעולה שלא הורצה להצלחה.

## 1. תקציר מנהלים

הקמפיין מוסיף שכבות בטיחות ותפעול מעל המערכת הקיימת בלי להחליף את מודל ה־Supabase/RLS או את
פקודות הכסף. עיקרי המימוש: כיול ו־Shadow למחירונים, מרכז תפעול מסמכים, שורות חשבונית ו־3-way
match אמיתי, snapshot שרתי לדשבורד, קבלת סחורה offline עם תמונות, סמנטיקת ספק לא פעיל, כרטיס
ספק פיננסי, הרחבת portal ספק, מלאי מדוד, lifecycle של Trial ומיתוג דייר, offboarding עם export
עמיד ובר־ביטול, והקשחת SECURITY DEFINER.

האינטגרציה החיצונית החיה נדחתה במפורש משום שלא אושרו יעד או credentials. תשתית outbox נשארה
מוכנה ונבדקת מקומית. נכון לטיוטה זו אין אישור שחרור: תוצאות quality, פריסה ו־SHA יירשמו בסעיפים
18, 20 ו־25 רק לאחר ביצוע בפועל.

## 2. ממצאי פתיחת הריפו

- הארכיטקטורה הקיימת כבר כללה RLS דיירי, scope ליחידות, פקודות כספיות אטומיות, audit, idempotency,
  document jobs, domain events ו־transactional outbox. הקמפיין מרחיב אותם ולא יוצר מערכת מקבילה.
- מחירון אוטומטי כבר היה מסוגל לבצע mutation אך הסף `0.900` לא כויל מול corpus אנושי.
- תיעוד offline עדיין תיאר app shell ותמונות כעתיד אף שהקמפיין חיווט אותם.
- בדיקות חשבונית ותיקות היו בעיקר ברמת כותרת/סכום; לא הייתה ראיית שורות סמכותית מלאה.
- דשבורדים ביצעו קריאות רבות והיו סתירות סביב `unmatched`, ‏`suggested` ו־unknown מול zero.
- `trial_ends_at` היה מידע לפני `0094`; לא היה read-only אוטומטי לאחר grace.
- רשם SECURITY DEFINER היה קיים, אך marker של scope היה ניתן לסיפוק במחרוזת שאינה קוד מבצע.
- המסמכים ההיסטוריים היו עשירים אך ערבבו Current State, החלטה היסטורית וחוב פתוח.
- בתחילת הביקורת נמצאו GitHub Issues #2 ו־#3. שניהם כבר תוקנו ב־`origin/main`; הקוד והמבחנים
  הממוקדים אומתו מחדש וה־Issues נסגרו ב־09.08.2026 עם ראיות הקומיט והבדיקה.

## 3. Workstreams שמומשו

| Workstream | תוצאה בקוד | מצב שחרור |
|---|---|---|
| בטיחות מחירונים | calibration, shadow, drift, rollback ו־matching חזק | `PENDING` gates |
| מרכז תפעול מסמכים | metrics, attempts, failure, history, reprocess ו־review | `PENDING` browser |
| שורות חשבונית ו־3-way | evidence, allocations, assessment, guard ו־override | `PENDING` DB/browser |
| Dashboard | snapshot שרתי למדדי הנהלה שהוכרעו | `PENDING` P21/browser |
| Offline receiving | app shell, drafts, conflicts, photos ו־resume | `PENDING` browser |
| ספקים | inactive semantics, finance view ו־portal order acknowledgement | `PENDING` P16/P17/P23 |
| מלאי | read model מדוד והצעות read-only | `PENDING` P24/browser |
| SaaS | Trial ‏30+7/read-only, branding, recovery ו־offboarding/export | `PENDING` P19/P22/P25/browser |
| Security | executable scope proof + pinned body hash | `PENDING` full reset |
| Integration platform | outbox worker/tests הוקשחו; live target נדחה | local gate `PENDING` |
| Documentation | Current State, decisions, debt, architecture ו־report | diff review `PENDING` |

## 4. החלטות ארכיטקטורה

1. פקודות פיננסיות נשארות server-authoritative; הלקוח מציג assessment ואינו מאשר את עצמו.
2. ראיית OCR/interpretation נשארת immutable; correction, reprocess ו־rollback הם רשומות חדשות.
3. Shadow משתמש באותו input ומדיניות, אך אינו מפעיל כותב קטלוג/מחיר.
4. Dashboard עובר מסך־אחר־מסך ל־read model; אין RPC גורף שמקפיא מדד לא מוכרע.
5. Offline מוגבל לקבלת סחורה. Service Worker שומר קונכייה סטטית בלבד, לא API או כסף.
6. כרטיס ספק פיננסי הוא projection נפרד; לא נפתחה גישה לכרטיס הרכש ל־accountant.
7. המלצות מלאי הן read-only; אין auto-purchase.
8. lifecycle נאכף ב־DB/Storage/Edge/UI. UI לבדו אינו גבול.
9. SECURITY DEFINER מטופל פונקציה־פונקציה; לא נעשה rewrite גורף של מיגרציות היסטוריות.
10. Outbox נשאר asynchronous; כשל יעד חיצוני אינו מפיל טרנזקציה עסקית.

## 5. החלטות עסקיות

הכרעות הבעלים המלאות נמצאות ב־`OPEN-DECISIONS.md` #124–#129:

- 3-way: רק g↔kg ו־ml↔liter אוטומטית; packaging דורש יחס מוצר מאושר.
- tolerance: יחידות שלמות 0%; משקל/נפח ±2%; מחיר עד 1% warning; VAT rate ללא tolerance;
  עיגול ₪0.05 לשורה ו־₪1 לחשבונית.
- חשבונית ללא הזמנה מותרת אך אינה "עברה 3-way"; ambiguity אינה "הראשון מנצח".
- owner בלבד מבצע override עם step-up, סיבה ו־audit; אין override לכפילות חשבונית ודאית.
- dashboard: `unmatched` ו־`suggested` נפרדים; שני תורי האישור נפרדים; overdue דורש `due_date`.
- Trial: ‏30 יום + 7 Grace מלאים, ואז read-only; reactivation ל־`active`.
- Live Integration Proof: ‏`DEFERRED` עד יעד ו־credentials מפורשים.
- Drift: רק שינוי מבני חדש מפעיל Shadow; מדדים מספריים נשמרים בלי threshold מומצא.
- Offboarding: read-only מיידי, ביטול owner עד 30 יום, reactivation בידי Platform Admin עד 120 יום,
  CSV+JSON+מסמכי מקור וקישור בר־ביטול ל־7 ימים; לא נדרשת סיבה עסקית לבקשה.
- לא הומצאו pricing plans.

## 6. שינויים במסד הנתונים

| מיגרציה | שינוי מרכזי |
|---|---|
| `0086` | reprocess מנומק, matching מחירון לפי מזהים חזקים, rollback אוטומציה |
| `0087` | trigger שחוסם פעילות מסחרית חדשה עם ספק inactive |
| `0088` | SQL lexer ל־scope marker ורשם body-hash/proof |
| `0089` | shadow/calibration ledgers, corpus queue, drift ו־document operations read models |
| `0090` | `read_financial_supplier` וגבול role/tenant פיננסי |
| `0091` | מיתוג ארגוני ו־Storage policy לוגו דיירי |
| `0092` | invoice line evidence/matches/overrides, assessment ו־approval guard |
| `0093` | `management_dashboard_snapshot(date)` |
| `0094` | Trial ‏30+7, access mode, write guards ו־Storage write latch |
| `0095` | supplier portal projection והרחבת transition PO לספק שלו בלבד |
| `0096` | `inventory_intelligence` read model |
| `0097` | offboarding lifecycle, durable export parts/manifest, revocable delivery, egress leases ו־worker fencing |

כל המיגרציות הן forward-only. היסטוריית מיגרציות קיימת לא שוכתבה. החלה בייצור: `PENDING`.

## 7. שינויים באבטחה

- tenant ו־supplier isolation נשארים `auth_org()`/`auth_supplier()` + RLS/FK מורכב.
- accountant קורא supplier projection פיננסי בלבד; office אינו מקבל 3-way override.
- supplier portal מחזיר רק הזמנות שהונפקו לאותו supplier ומאפשר מעבר יחיד.
- Trial write guard בודק גם OLD וגם NEW org ב־UPDATE כדי לחסום העברה בין דיירים.
- Storage write policies בודקות `organization_write_allowed()`; SELECT נשאר זמין ב־read-only.
- Edge Functions מבצעות access preflight לפני Storage/provider/service mutation.
- owner override ל־3-way ו־platform lifecycle דורשים password AMR טרי, סיבה ו־audit/security event.
- `0088` דוחה marker ב־comment/literal ומחייב hash של גוף פונקציה שנבדק.
- `service_role` אינו בדפדפן.

## 8. שינויים באוטומציית מסמכים

מרכז התפעול מציג מצבי משתמש ולא jargon של DB: processing, completed, review required, failed,
partially applied, automatically applied ו־reverted. ה־read models מספקים queue age, attempts,
duration, failure, provider/model/version, confidence, usage/cost כאשר ידועים ותוצאת סיווג/מחירון.

`reprocess_document` דורשת סיבה ושומרת את התוצאה הקודמת. היסטוריית ניסיונות והבדל current/previous
נשארים נגישים. retry אינו מוחק evidence ואינו מציג הצלחה לפני completion.

## 9. שינויים באוטומציית מחירונים

- ledger shadow/run/line immutable עם action חזוי ותוצאה לכל שורה.
- החלטת אדם בגרסאות: correct/incorrect/ambiguous/rejected, expected action/product/price ו־labels.
- metrics: שורות, applied, corrected, match/product/price errors, ambiguity, rejection ו־confidence;
  פילוח supplier/format/model/prompt/contract version.
- תור corpus מחזיר עד 50 מסמכים להכרעת אדם; policy threshold אינו משתנה מעצמו.
- fingerprint מבני חדש מפעיל Shadow. unmatched/created/confidence/price drift נשמרים לתצפית בלבד.
- rollback batch מנומק ואידמפוטנטי משחזר מחיר קודם ומשבית רכה רק רשומות שנוצרו באותו batch כאשר
  החוזה מאפשר, בלי למחוק interpretation evidence.
- שם מוצר לבדו אינו התאמה סמכותית.

## 10. שורות חשבונית והתאמת 3-way

`invoice_line_evidence` שומר description, supplier SKU, barcode, quantity, unit, unit price,
discount, VAT ו־line total כאשר זמינים. התאמות explicit נשמרות בנפרד מן evidence.

ה־assessment משווה הזמנה, קבלה וחשבונית ומסביר quantity ordered/received/invoiced, price snapshot,
unit/VAT/arithmetic ו־duplicate candidates. הוא מזהה גם received-not-invoiced ו־invoiced-not-received.
חשבונית ללא הזמנה נשארת במסלול הקיים ומקבלת reason שאינו הצלחה. מספר הזמנות נתמך; ambiguity נחסם
לבדיקה ידנית. owner/office יכולים לתעד ראיית שורה ידנית מנומקת ולהקצות שורה עמומה; שורות אחרות
שחד־משמעיות נשארות deterministic. approval guard רץ בשרת תחת lock ארגון+ספק ושומר לכל אישור
snapshot immutable של ה-assessment. בדיקת הכמות המצטברת קוראת snapshots קודמים, ולכן שינוי barcode
מאוחר או שני אישורים מתחרים אינם עוקפים את כמות הקבלה. UI מציג reason, סכום ואחוז ולא רק קוד.

## 11. שינויים בדשבורד

`management_dashboard_snapshot` מחזיר snapshot דיירי אחד למדדים שהוכרעו. תנועות `unmatched`
נספרות לבדן ו־`suggested` בנפרד. invoice/payment-request approvals נפרדים. overdue נספר רק על
דרישה פעילה עם `due_date`; אם אפילו דרישה פעילה אחת חסרת תאריך, כל מדדי האיחור מוחזרים null והמסך
מציג `—` עם ההסבר המאושר, במקום מדד חלקי. תור פעיל ריק שנמדד מציג `0`; כשל read מציג `—`.
גרפים ורשימות
שאינם חלק מה־snapshot נשארים חוב ביצועים מדוד, לא מספרים מומצאים.

## 12. שינויים ב־Offline/PWA

- Service Worker cache-first לנכסים סטטיים ו־network→shell fallback לניווט.
- אין cache ל־Supabase/API/Functions או מידע פיננסי חי.
- טיוטת receipt, key, quantities, missing/damaged ו־notes נשמרים ב־IndexedDB.
- תמונה נשמרת כ־Blob ב־`pending_photos`, כולל resume path/document id ו־attempt state.
- סנכרון מחודש משתמש באותו RPC/idempotency key; duplicate retry אינו יוצר קבלה שנייה.
- קונפליקט מקבל מצב אנושי; permanent scope/auth failure אינו נכנס ללולאת retry.
- המצבים בעברית: שמור במכשיר, ממתין לסנכרון, מסנכרן, סונכרן, נדרש טיפול.

שער browser מלא לרשת שנופלת/חוזרת, refresh וסגירת tab: `PENDING`.

## 13. שינויים בזרימות ספק

- inactive פירושו "אין פעילות חדשה"; היסטוריה, חוב, זיכוי, תשלום והתאמה נשארים.
- רשימת ספקים כוללת status filter; new order/price intake/link נחסמים גם בשרת.
- `/finance/suppliers/:id` הוא מסך חשבונאי נפרד עם balance, invoices, credits, payments,
  allocations, bank, terms, due exposure ופעילות אחרונה.
- portal supplier מציג מחירון/מסמכים והזמנות שהונפקו בלבד. supplier יכול לאשר שקיבל הזמנה
  (`sent→confirmed`) אך אינו משנה delivery date ואינו קורא supplier אחר.
- delivery-date negotiation, withdrawal והעלאות נוספות שלא קיבלו חוזה עסקי לא הומצאו.

## 14. שינויים במלאי

ה־ledger הקיים נשאר מקור האמת. `inventory_intelligence` מחשב רק כשיש ראיות: balance לאחר count,
צריכה יומית מתנועות מאז הספירה (עד 30 יום), יתרת PO פתוחה, projected stockout, top-up ל־min stock,
מחיר ספק פעיל/בעייתי זול והפרש מול last purchase cost של הזמנה שהונפקה/התקבלה. draft/ready אינם
נספרים כאספקה צפויה ואינם מחיר רכישה אחרון. בלי בסיס מספיק מוחזר null. הצעות אינן
יוצרות או משנות הזמנה.

## 15. שינויים ב־SaaS

- default Trial: ‏30 יום; Grace: ‏7 ימים מלאים עם הודעת owner המאושרת.
- לאחר Grace: read-only, לא lockout. login/view/search/report/export נשארים. הלקוח צורך ומרענן
  `organization_access_state` סמכותי ואינו מחשב פקיעה באמצעות שעון המכשיר.
- owner אינו מאריך לעצמו. רק platform admin עם step-up, reason ותאריך עתידי.
- reactivation מחזיר ל־active. suspended נשאר מצב נפרד.
- branding: display name + PNG/JPEG/WebP עד 2MB, path דיירי, fallback, ללא CSS/HTML.
- recovery: self-service למייל המאומת; אין איפוס סיסמת עובד על ידי owner.
- offboarding: owner מבקש לאחר step-up, הארגון עובר מיד ל־read-only, וניתן לבטל 30 יום. Platform
  Admin מאשר את הייצוא ויכול להפעיל מחדש עד 120 יום; reactivation מחזיר ל־active.
- tenant export הוא job עמיד ובר־חידוש: CSV ו־JSON בחלקים של עד 50 רשומות ובמגבלת bytes,
  נתוני חשבון מותרים ומסמכי מקור כאובייקטים פרטיים. manifest עצמו מדורג לעמודים של עד 100
  artifacts, וה-root manifest מאנדקס את העמודים בלי לטעון את כל הייצוא לזיכרון. כל descriptor
  מכיל שם לוגי, hash וגודל; קישור broker תקף
  לשבעה ימים, ניתן לביטול ונבדק מחדש לפני כל הורדה. אין ZIP גדול בזיכרון ואין ייצוא סודות.
- אין purge אוטומטי. ברירת השימור היא סוף שנת המס ועוד 7 שנים למידע פיננסי, 24 חודשים לראיות
  אבטחה, ו־legal hold חוסם מחיקה. executor עתידי חייב dry-run, גיבוי/export תקין, scope ו־audit.

## 16. שינויים באינטגרציות

Outbox worker ממשיך להשתמש ב־domain event/outbox, correlation id, idempotency, signed delivery,
retry, attempts, dead-letter ו־replay מנומק. business command אינו מחכה ליעד חיצוני.

**Live Integration Proof: DEFERRED — requires explicit external target and credentials.** לא נבחרו
ERP, מערכת הנהלת חשבונות, בנק, endpoint, tenant או account לבדיקה. זה אינו blocker לשאר הקמפיין,
ואין להציג local loopback כהוכחת צד ג׳ חיה.

## 17. Issues שנסגרו או עודכנו

| Issue | בדיקת קוד | פעולת GitHub |
|---|---|---|
| #2 — הקשר הזמנה/קבלה בחשבונית | קומיט `6206866`; ‏3/3 בדיקות `invoice-linked-context` עברו | `CLOSED` ‏09.08.2026 |
| #3 — נוסח סטטוס תשלום | קומיט `5b6d16c`; ‏2/2 בדיקות `status.spec.ts` עברו | `CLOSED` ‏09.08.2026 |

לא נותרו Issues פתוחים ב־GitHub לאחר הסגירה המאומתת.

## 18. בדיקות ותוצאות מדויקות

| שער | תוצאה | ראיה |
|---|---|---|
| TypeScript | `PASS` ביניים; יירוץ שוב בשער הסופי | `npm.cmd run build`, ‏09.08.2026 |
| Vitest | `PASS` ביניים: 50 files, ‏451/451 tests | `npm.cmd test -- --run`, ‏09.08.2026 |
| DB reset/migrations | `PENDING` | — |
| P16–P24 | `PENDING` | — |
| RLS/tenant/idempotency/finance | `PENDING` | — |
| Edge/Deno | tenant-export ‏11/11 + typecheck/format `PASS`; document/branding contracts ‏73/73 `PASS`; rerun בשער הסופי | `deno test` / `deno check` / `deno fmt --check`, ‏09.08.2026 |
| Playwright desktop/mobile/RTL/a11y | `PENDING` | — |
| Offline/retry/recovery | `PENDING` | — |
| `npm run build` | `PASS` ביניים לפני שילוב upstream; rerun חובה אחרי merge | TypeScript, checks, pin ‏75, ‏451 Vitest ו־Vite build עברו ב־56s; תוצאה זו אינה שער שחרור לענף המשולב |
| `npm run quality` | `PENDING` | — |

לא תירשם הצלחה אם test skipped או אם השער רץ על SHA אחר.

## 19. רצף מיגרציות לייצור

1. preflight: backup, migration ledger, secrets/config, current SHA ו־dry-run.
2. להחיל בסדר עולה בלבד: `0086` → `0087` → `0088` → `0089` → `0090` → `0091` → `0092` →
   `0093` → `0094` → `0095` → `0096` → `0097`.
3. להריץ postflight assertions, RLS/tenant tests וספירות invariants.
4. לפרוס Edge Functions ששונו ורק אחר כך frontend שקורא את ה־RPC החדשים.
5. לא לכתוב מחדש migration שהוחלה ולא למלא את `0072`.

החלה בפועל: `PENDING`.

## 20. פרטי פריסה

| רכיב | יעד | תוצאה |
|---|---|---|
| Database/RLS/RPC | Supabase production | `PENDING` |
| Edge Functions | Supabase production | `PENDING` |
| Storage policies | Supabase production | `PENDING` |
| Cron/Vault/secrets | Supabase production | `PENDING` |
| Frontend | Cloudflare Pages `supplyflow` | `PENDING` |
| Deployed commit SHA | — | `PENDING` |
| Asset hash parity | — | `PENDING` |

נדרשת בדיקה שה־build לייצור אינו מצביע ל־Supabase מקומי לפני העלאה.

## 21. תוכנית Rollback

- DB: forward-only remediation migration; אין `git checkout` או מחיקה של migration שהוחלה.
- Price-list batch: להשתמש בפקודת rollback המנומקת והאידמפוטנטית; interpretation evidence נשאר.
- Trial guard: rollback רק במיגרציה קדימה שמחזירה write contract במפורש; לא לעקוף RLS ידנית.
- Offboarding: owner cancel בתוך החלון או Platform Admin reactivate דרך הפקודות המבוקרות; אין
  למחוק חלקי export או לשנות lifecycle ידנית. DB rollback, אם יידרש, יהיה forward-only.
- Edge: לפרוס גרסה קודמת רק אם החוזה שלה תואם לסכימה שכבר הוחלה.
- Frontend: Cloudflare rollback לפריסה הקודמת לאחר בדיקת תאימות RPC.
- Outbox: לא למחוק delivery attempts; לעצור worker/יעד ולבצע replay מנומק לאחר תיקון.
- לפני כל remediation לשמור גיבוי וספירות postflight.

## 22. מגבלות ידועות

- אין live third-party integration proof.
- corpus של 50 מחירונים אמיתיים טרם הושלם; threshold נשאר לא־מכויל.
- drift מספרי הוא observability בלבד; רק structural fingerprint מפעיל Shadow.
- packaging conversion דורש יחס מוצר מאושר.
- dashboard snapshot אינו מכסה עדיין כל גרף ורשימה.
- browser offline ותמונות דורשים שער final לפני טענת production.
- lease העלאת תמונה offline הוא 15 דקות ללא heartbeat; object key יציב מגן מכפילות מסמך, אך
  upload ארוך במיוחד עשוי להיתבע מחדש מטאב אחר (#27 ב־DEBT-REGISTER).
- purge סופי של דייר אינו אוטומטי; export/read-only/cancel/reactivate קיימים, אך retention executor
  נשאר fail-closed עד שיממש dry-run, legal hold, גיבויים ו־audit (#26 ב־DEBT-REGISTER).
- supplier delivery-date negotiation/withdrawal לא הומצאו.

## 23. חוב טכני שנותר

- ריקון הדרגתי של `private.scope_definer_exemptions` עם proof לכל פונקציה.
- מדידה מחדש של round trips והעברת dashboard נוסף רק אם יש הצדקת latency.
- הוכחת tus/resume בסביבת Storage מנוהלת.
- סבב calibration לאחר 50 מסמכים והכרעה אנושית, לפני שינוי threshold.
- browser race אמיתי בין שני מכשירי קבלה.
- heartbeat ל־pending-photo lease ובדיקת upload שחורג מ־15 דקות.
- retention executor ל־offboarding: dry-run, בדיקת legal hold, export וגיבוי, ומחיקה/אנונימיזציה
  בקטעים עם יכולת עצירה. אין להחליף אותו ב־cascade או cleanup עיוור.

הרשם הקנוני: `DEBT-REGISTER.md`.

## 24. החלטות פתוחות שנותרו

ההחלטות החדשות #124–#129 סגורות. #131 הוכרעה ומומשה בחוזה offboarding/export; #130 נשארת פתוחה
ומגדירה ברירת מחדל שמרנית לחשבונית שאושרה והועברה ל־investigation. בנוסף נשארו
שאלות היסטוריות שמסומנות פתוחות ב־
`OPEN-DECISIONS.md`, ובהן workflow/report jobs, מקדמה לספק, manual exception, חודש ברירת־מחדל
להגשת מחירון וגבולות נוספים שאינם חלק מהקמפיין. אין לתרגם אותן לקוד בלי הכרעה.

היעד החיצוני לאינטגרציה אינו "פתוח לפתרון בקמפיין" אלא `DEFERRED` במפורש לסבב נפרד.

## 25. אימות production סופי

| בדיקה חיה | תוצאה |
|---|---|
| login/recovery | `PENDING` |
| owner dashboard | `PENDING` |
| supplier isolation + portal | `PENDING` |
| receiving + offline recovery | `PENDING` |
| document upload/processing/classification | `PENDING` |
| price-list shadow/apply/rollback | `PENDING` |
| invoice 3-way + override boundary | `PENDING` |
| payment flow + role restrictions | `PENDING` |
| expired trial/read-only + suspended tenant | `PENDING` |
| mobile RTL/a11y/console | `PENDING` |
| tenant isolation smoke | `PENDING` |
| production health | `PENDING` |

**Release Reviewer:** `PENDING`
**Production approval:** `PENDING`
**Final commit SHA:** `PENDING`
**Git working tree clean:** `PENDING`
