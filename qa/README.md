# מערכת QA רב־סוכנית של SupplyFlow

מערכת ה־QA מריצה בדיקות דטרמיניסטיות ובדיקות דפדפן לפי תפקיד, ובאופן אופציונלי גם סוכני AI. היא פועלת רק מול סביבת Supabase המקומית המבודדת `supplyflow-p0` ב־`http://127.0.0.1:55431`. כל יעד אחר נחסם לפני שינוי נתונים.

> אזהרה: `qa:setup` ו־`qa:clean` מבצעים `supabase db reset` בסביבה המקומית. אין להריץ אותם כאשר תהליך QA אחר משתמש ב־`supplyflow-p0`, ואין להפנות אותם לפרויקט משותף או לייצור.

## ארכיטקטורה

הזרימה היא:

1. `qa:setup` נועל את סביבת הבדיקה, מאמת יעד מקומי, מאפס את מסד הנתונים, יוצר שישה משתמשי דמו, טוען ומאמת seed, יוצר קבצי fixture, בונה את האפליקציה ויוצר מצבי אימות לכל תפקיד.
2. `qa:deterministic` מריץ typecheck, בדיקות יחידה/אינטגרציה, חוזה export, Playwright ו־Axe ללא LLM.
3. `qa:agents` מפעיל, רק אם הוגדר במפורש, סוכן לכל תפקיד דרך מתאם מודל ניטרלי לספק. הסוכן רואה רק UI גלוי ומצונזר ופועל רק דרך כלים מורשים.
4. שכבת verifiers עצמאית בודקת תוצאות במסד הנתונים, audit, הרשאות, שלמות נתונים וקבצי export. מפתח `service_role` מקומי נשאר בתהליך ה־runner ואינו נמסר לדפדפן או למודל.
5. `qa:report` מנרמל ומאחד ממצאים, קובע חומרה ומייצר JSON, Markdown בעברית ו־HTML עצמאי ב־RTL.
6. `qa:clean` מאפס שוב את מסד הנתונים המקומי, מוחק credentials ומצבי auth ומאמת שלא נשארו קבצים מנוהלים. אפשר לשמר רק את הראיות והדוחות.

הרכיבים המרכזיים:

- `qa/config/` — חוזי סביבה, תפקידים, מסלולים והרשאות UI.
- `qa/auth/` — התחברות דרך ה־UI, אימות role/org דרך REST ויצירת storage state.
- `qa/deterministic/` — בדיקות Playwright/Axe יציבות ללא מודל.
- `qa/browser/` — כלים מוגבלים ל־UI, ניטור console/network/downloads וראיות מצונזרות.
- `qa/agents/` — prompts לפי תפקיד, מתאם מודל, orchestrator וסוכן verifier.
- `qa/scenarios/` — מרשם תרחישים, fixtures נדרשים ו־verifier allowlists.
- `qa/verification/` — verifiers בלתי תלויים וקריאה בלבד ככל שניתן.
- `qa/reporting/` — schemas, deduplication, severity, redaction ודוחות.
- `qa/runner/` — setup, הרצות, mutex, report ו־cleanup.

## דרישות מוקדמות

### Windows מקומי

- Node.js 22 ומעלה ו־npm; ה־runners משתמשים בהרצת TypeScript ישירה של Node.
- PowerShell זמין. ב־Windows ה־runner מפעיל `powershell.exe`; מחוץ ל־Windows נדרש `pwsh`.
- Docker Desktop פעיל.
- Supabase CLI זמין ב־`PATH`.
- ה־stack המקומי של הריפו פעיל ומזוהה כ־`supplyflow-p0`.
- אין תהליך מקביל של `npm run quality`, `supabase db reset` או הרצת QA אחרת.
- Chromium של Playwright מותקן.

התקנה ראשונית מתוך שורש הריפו:

```powershell
npm.cmd install
npm.cmd run qa:install-browser
supabase start
```

`qa:setup` אינו מפעיל stack חסר. אם `supabase status` אינו מחזיר בדיוק את ה־URL המקומי הצפוי, ההרצה מסומנת `BLOCKED` ללא reset.

בדיקות סטטיות שאינן נוגעות ב־stack:

```powershell
npm.cmd run qa:typecheck
npm.cmd run qa:test
```

### CI

ה־runner צריך לספק Node, Docker, Supabase CLI, PowerShell/`pwsh` ותלויות מערכת של Chromium. ב־Linux ייתכן שצריך להתקין מראש את תלויות הדפדפן של Playwright. יש להריץ job יחיד בכל פעם מול `supplyflow-p0`; ה־mutex המקומי אינו תחליף לבידוד בין מכונות או containers.

אין כרגע workflow מחייב בריפו. רצף CI מומלץ מתועד בהמשך כדי שהטמעה עתידית לא תעקוף את שערי הבטיחות.

## משתני סביבה

`.env.qa.example` הוא תיעוד בלבד; סקריפטי npm אינם טוענים אותו אוטומטית. טוענים ערכים לתהליך PowerShell לפני ההרצה. אין להכניס סודות לקובץ בריפו.

משתנים תפעוליים:

| משתנה | ברירת מחדל | שימוש |
|---|---|---|
| `QA_BASE_URL` | `http://127.0.0.1:4173` | כתובת preview מקומית בלבד. |
| `QA_SUPABASE_URL` | `http://127.0.0.1:55431` | נעול ל־Supabase המקומי; שינוי נחסם. |
| `QA_AGENT_ENABLED` | `false` | מפעיל את שלב הסוכנים רק כאשר הערך `true`. |
| `QA_MODEL_PROVIDER` | ריק | כרגע `openai` או `openai-responses`; נדרש רק כשהסוכנים מופעלים. |
| `QA_MODEL_NAME` | ריק | שם מודל מאושר; נדרש רק כשהסוכנים מופעלים. |
| `QA_MODEL_API_KEY` | ריק | סוד runtime בלבד; נדרש רק כשהסוכנים מופעלים. |
| `QA_MAX_AGENT_STEPS` | `30` | תקציב צעדים, בטווח 1–100. |
| `QA_MAX_AGENT_RETRIES` | `2` | ניסיונות חוזרים, בטווח 0–3. |
| `QA_FAIL_ON_MEDIUM` | `false` | האם ממצא medium מאומת מכשיל את שער הדוח. |
| `QA_ACTION_TIMEOUT_MS` | `10000` | timeout לפעולת Playwright ישירה. |
| `QA_NAVIGATION_TIMEOUT_MS` | `25000` | timeout לניווט Playwright ישיר. |

ה־setup מפיק בעצמו מתוך `supabase status` את מפתח ה־anon המקומי ואת נתיב manifest הסיסמאות. בהרצה רגילה אין להגדיר ידנית `QA_SUPABASE_ANON_KEY`, `QA_CREDENTIALS_MANIFEST`, `QA_AUTH_STATE_ROOT` או `QA_ARTIFACT_ROOT`; ה־runners מעבירים אותם ממצב ההרצה. הם קיימים רק לתרחיש מתקדם של הרצת Playwright ישירה.

הפעלה ללא AI:

```powershell
$env:QA_AGENT_ENABLED = 'false'
npm.cmd run qa:full
```

הפעלה עם AI מאושר:

```powershell
$env:QA_AGENT_ENABLED = 'true'
$env:QA_MODEL_PROVIDER = 'openai-responses'
$env:QA_MODEL_NAME = '<approved-model>'
$env:QA_MODEL_API_KEY = '<load-from-secret-store>'
npm.cmd run qa:full
```

אל תדפיסו את `QA_MODEL_API_KEY`, אל תשמרו אותו ב־artifact ואל תעתיקו אותו ל־`.env.qa.example`.

## הרצה ידנית לפי שלבים

### 1. Setup

```powershell
npm.cmd run qa:setup
```

אפשר לבחור פורט preview מקומי אחר:

```powershell
npm.cmd run qa:setup -- --base-url=http://127.0.0.1:4180
```

ה־setup מסרב ל־hostname או URL שאינם loopback מפורש, בודק שאין state קודם ואין תהליך reset/quality מתחרה, ואז מבצע:

- reset של `supplyflow-p0` בלבד;
- יצירת ששת חשבונות הדמו: `owner`, `office`, `kitchen`, `payer`, `accountant`, `supplier`;
- seed ו־verify של נתוני הדמו והרב־דיירות;
- יצירת CSV בנק, XLSX מחירון, PDF חשבונית ו־JPG קבלה סינתטיים עם hash במניפסט;
- `npm run build`;
- התחברות אמיתית דרך מסך login לכל תפקיד;
- אימות profile פעיל, role, `org_id` וקישור supplier דרך REST;
- יצירת storage state מבודד לכל תפקיד.

תוצאה תקינה היא `READY`. אם מוחזר `cleanupRequired: true`, יש להריץ cleanup גם אחרי `FAILED` או `BLOCKED`.

### 2. בדיקות דטרמיניסטיות

```powershell
npm.cmd run qa:deterministic
```

השלב דורש state במצב `READY` ומריץ:

- `qa:typecheck`;
- בדיקות יחידה ואינטגרציה תחת `qa/**/*.test.ts`;
- `scripts/check-document-export.ts`;
- preview מקומי זמני;
- תרחיש Playwright סדרתי לששת תהליכי הליבה: מחירון ספק, קבלת סחורה, חשבונית ודרישת תשלום, אישור בעלים, ביצוע העברה, ייבוא בנק והתאמה;
- verifiers בלתי תלויים למסד הנתונים ול־audit אחרי כל mutation; תרחיש ליבה חסר או מדולג מכריע את השלב כ־`BLOCKED` ולא מאפשר PASS מלאכותי;
- Playwright לכל ששת התפקידים;
- התחברות באמצעות storage state;
- מסלולים מותרים ואסורים, route redirect ובקרת ליבה;
- Axe על מסלול הליבה של כל תפקיד;
- skip-link ומקלדת;
- viewport מטבח `390x844`, overflow ויעדי מגע;
- smoke של export XLSX לחשבונאי ו־CSV לספק;
- ניקוי trace לפני פרסום ומחיקת ה־preview.

שלב זה אינו משתמש ב־LLM ואמור להיות שער החובה הראשי.

### 3. סוכני תפקידים

```powershell
npm.cmd run qa:agents
```

כאשר `QA_AGENT_ENABLED=false`, נכתב result במצב `SKIPPED_BY_CONFIGURATION` והפקודה אינה דורשת מפתח. כאשר `QA_AGENT_ENABLED=true` ואין provider, model או API key תקינים, רק שלב הסוכנים מסומן `BLOCKED`; אין fallback שקט למודל אחר.

התרחיש הראשי לכל תפקיד:

| תפקיד | תרחיש |
|---|---|
| `supplier` | הגשת מחירון ספק |
| `kitchen` | קבלת סחורה |
| `office` | קליטת ובדיקת חשבונית |
| `owner` | אישור דרישת תשלום |
| `payer` | ביצוע העברה |
| `accountant` | התאמת בנק ויצוא חודשי |

כל סוכן מקבל browser context נפרד ומורשה להשתמש רק ב־route וב־fixture allowlist של התרחיש. הכלים תומכים בניווט יחסי, snapshot של UI גלוי, click/fill/select/upload, מקלדת, גלילה, המתנה, צילום מסך מצונזר וקריאת URL. אין לסוכן shell, SQL, HTTP כללי, `eval`, DOM script או גישה למפתחות. תוכן האפליקציה מסומן כמידע לא מהימן כדי שלא יוכל לשנות את הוראות הסוכן.

פעולה עסקית משמעותית אינה נחשבת מוצלחת בלי בדיקת verifier עצמאית ומאושרת לתרחיש.

### 4. דוחות

```powershell
npm.cmd run qa:report
```

הפקודה קוראת את תוצאות ההרצה הנוכחית ואינה ממציאה PASS לקלט חסר. היא כותבת ישירות אל `.qa-runs/<runId>/`:

- `report.json` — חוזה מכונה מלא ומצונזר;
- `executive.he.md` — סיכום הנהלה בעברית;
- `report.html` — HTML עצמאי, RTL, ללא CDN;
- `roles/<role>/report.he.md` — דוח תפקיד נפרד;
- `playwright-results.json` — פלט Playwright; יש לבדוק גם אותו לפני שיתוף;
- `results/deterministic.json` ו־`results/agents.json` — תוצאות שלבי ההרצה;
- `playwright/` וראיות סוכן — action logs, console/network/download metadata, screenshots ו־traces זמינים.

כל רשומת תפקיד ב־JSON וכל `roles/<role>/report.he.md` כוללים במפורש: משימות שנוסו/הושלמו/נחסמו, אזורים נגישים וחריגות גישה, תקלות פונקציונליות והרשאה, ממצאי נגישות, תצפיות שימושיות, ניסוחים לא ברורים, בעיות התאוששות, ראיות, ביטחון והמלצות. שדה ללא ראיה נשאר ריק או `לא זמין`; הוא אינו מושלם בהשערה.

אחרי `qa:full`, ה־current state כבר נמחק אך ה־artifacts נשמרו. אפשר לבנות את הדוח מחדש מנתיב ההרצה המוחלט:

```powershell
npm.cmd run qa:report -- --artifact-root="<absolute path>"
```

Traces נשמרים רק בכשל/ניסיון חוזר, בלי snapshots, sources או screenshots מוטמעים, ועוברים redaction לפני דיווח. צילומי מסך מפורשים מפעילים מסכות על שדות רגישים. למרות זאת יש להתייחס לכל `.qa-runs/` כאל חומר פנימי ולבדוק אותו לפני שיתוף מחוץ לצוות.

### 5. Cleanup

למחיקת כל מצב ההרצה וה־artifacts:

```powershell
npm.cmd run qa:clean
```

למחיקת credentials, auth state ו־state תוך שמירת הדוחות והראיות:

```powershell
npm.cmd run qa:clean -- --keep-artifacts
```

ה־cleanup:

- מאמת שוב שהיעד הוא `supplyflow-p0` המקומי;
- מסרב לפעול מול תהליך quality/reset מתחרה;
- מאפס ומאמת את מסד הנתונים המקומי;
- מוחק `.qa-auth/<runId>/`;
- מוחק את manifest הסיסמאות מתיקיית temp;
- מוחק `.qa-state/current.json`;
- מוחק `.qa-runs/<runId>/` אלא אם הועבר `--keep-artifacts`;
- מאמת בפועל שהנתיבים שנדרש למחוק אינם קיימים.

אל תמחקו ידנית את `.qa-state/current.json` לפני cleanup: הוא מכיל את נתיבי ה־credentials וה־auth שעל ה־runner למחוק. אם cleanup מסומן `BLOCKED`, עצרו את התהליך המתחרה והריצו שוב; אין לעקוף את ה־lock או למחוק נתיבים רחבים ידנית.

## הרצה מלאה

```powershell
npm.cmd run qa:full
```

`qa:full` מבצע `setup → deterministic → refresh מקומי של הנתונים → agents → cleanup --keep-artifacts → report סופי`. ה־refresh רץ רק לאחר שכל שערי התשתית והראיות הדטרמיניסטיים עברו; כשל מוצר דטרמיניסטי מתועד אינו מונע חקירה, אבל מצב תשתית חסר או לא מוכח חוסם אותה. ה־refresh מאפס את ה־stack המקומי, מנקה credentials ו־auth state, ומבצע `setup` מחדש עם אותו `runId` ואותה תיקיית artifacts כדי שסוכני ה־AI יקבלו dataset טרי. ה־cleanup הסופי רץ גם כאשר שלב מאוחר נכשל, ותוצאתו נכללת בדוח הסופי שנשאר תחת `.qa-runs/<runId>/`. שלב הסוכנים נשאר אופציונלי לפי `QA_AGENT_ENABLED`.

## כיסוי מלא לפי תפקיד

מעל ההרצה הזו יושבת שכבת **כיסוי** נפרדת, שמרחיבה את הבדיקה משישה תרחישי ליבה אל מלאי מלא של מסכים, אזורים, בקרות, פעולות ומצבים לכל תפקיד:

```powershell
npm.cmd run qa:setup      # חייב לרוץ קודם
npm.cmd run qa:coverage   # ההילוך המלא, שישה תפקידים סדרתית
```

היא משתמשת ב-config נפרד של Playwright (`qa/coverage/playwright.coverage.config.ts`) ולא ב-`qa/playwright.config.ts`, משום שזה האחרון מורץ ללא `--project` ולכן כל project שנוסף לו היה משנה בשקט את משמעות השער הדטרמיניסטי ואת משך הריצה. שתי ההרצות חולקות רק את ה-auth setup ואת תיקיית ה-artifacts.

ההילוך **אינו מבצע reset ואינו יוצר, מאשר, משלם או מוחק** — פעולות אלה נשארות בבעלות `qa/deterministic/critical-workflows.spec.ts` עם ה-verifiers שלה. בקרה כספית או הרסנית נרשמת כ"אותרה ולא הופעלה". הפירוט המלא, כולל הגדרת כל אחוז כיסוי והמגבלות, נמצא ב-[`coverage/README.md`](./coverage/README.md).

שער `npm.cmd run quality` הקיים נשאר נפרד וחובה: הוא מכסה RLS, Storage, בידוד רב־דיירי וחוזים משולבים שאינם מוחלפים על ידי מטריצת מסלולי ה־UI. אין להריץ אותו במקביל ל־`qa:setup` או ל־`qa:full`, משום ששני המסלולים משתמשים ב־reset מקומי מבוקר.

## Credentials, auth state ו־fixtures

### Manifest סיסמאות

ה־setup יוצר סיסמאות אקראיות ונפרדות לששת חשבונות הדמו ושומר אותן מחוץ לריפו:

```text
%TEMP%\supplyflow-qa\<runId>\credentials.json
```

הקובץ חייב להכיל בדיוק את ששת חשבונות הדמו, סיסמה ייחודית באורך 16 תווים ומעלה לכל תפקיד, והוא לעולם אינו מועתק ל־artifact או לדוח. `qa:clean` מוחק אותו ומאמת את המחיקה.

### Storage states

מצבי האימות נשמרים ב־`.qa-auth/<runId>/<role>.json`. הם עשויים להכיל session tokens ולכן הם סוד זמני: אין לפתוח, לפרסם או לצרף אותם ל־CI artifacts. ה־setup מחדש אותם, ו־cleanup מוחק אותם.

### Fixtures

קבצי fixture נמצאים ב־`.qa-runs/<runId>/fixtures/` ומלווים ב־`manifest.json` עם `runId`, סוג, MIME, גודל ו־SHA-256. הם סינתטיים ודטרמיניסטיים להרצה; אין להשתמש במסמכי לקוח אמיתיים.

## פירוש סטטוסים

הדוח המאוחד מפריד בין שתי החלטות שאינן שקולות:

| שדה | ערכים | משמעות |
|---|---|---|
| `runStatus` | `COMPLETED`, `BLOCKED`, `INFRASTRUCTURE_FAILED` | האם כל כיסוי החובה שניתן היה להריץ הושלם והאם תשתית ה-QA עבדה. |
| `productQualityStatus` | `PASS`, `PASS_WITH_FINDINGS`, `FAIL` | מה הראיות אומרות על המוצר. פגם מוצר מאומת יכול להחזיר `FAIL` יחד עם `runStatus=COMPLETED`. |

| סטטוס | משמעות |
|---|---|
| `PASSED` | כל הבדיקות שבוצעו בשלב עברו. זו אינה הוכחת production readiness מעבר להיקף המדוד. |
| `FAILED` | הבדיקה רצה ונמצאה סתירה לציפייה, שגיאת ניקוי/ראיות, או ממצא שחוצה את שער הכשל. |
| `BLOCKED` | לא ניתן היה לבצע או להוכיח את הבדיקה בבטחה: stack חסר, lock מתחרה, fixture חסר, runtime חסר או AI חסר כשהופעל. אין לפרש כחיובי. |
| `SKIPPED_BY_CONFIGURATION` | שלב אופציונלי הושבת במפורש. הוא אינו כיסוי ואינו כשל. |
| `OPTIONAL_BLOCKED` | כיסוי אופציונלי אינו זמין. הוא מפורט בדוח אך אינו חוסם את ריצת החובה. |
| `READY` | setup הושלם ונוצר state שמוכן להרצה. |
| `CLEAN` | cleanup, reset ואימות המחיקה הושלמו. |

ב־runners הישירים, exit code `0` מציין ריצה שהושלמה ללא כשל איכות חוסם, `1` מציין `productQualityStatus=FAIL` או כשל תשתית, ו־`2` מציין חסימת כיסוי חובה. ה־JSON הוא מקור האמת: תמיד בודקים את `runStatus`, את `productQualityStatus`, את `reason` ואת השלבים, ולא רק את exit code.

תרחיש `platform-admin` מדווח `OPTIONAL_BLOCKED` כאשר מבקשים אותו בלי fixture מאושר, או `SKIPPED_BY_CONFIGURATION` כאשר הוא מושבת. הוא אינו חוסם את ריצת החובה. אסור לשדרג owner או משתמש tenant כדי לייצר PASS מלאכותי.

## מסלול CI מומלץ

Job דטרמיניסטי, ללא סודות AI:

1. checkout נקי ו־`npm ci`;
2. התקנת Chromium ותלויות מערכת;
3. הפעלת Docker ו־`supabase start` מתוך הריפו;
4. `npm.cmd run quality` כשער נפרד, ללא הרצת QA מתחרה;
5. הגדרת `QA_AGENT_ENABLED=false`;
6. `npm.cmd run qa:full`;
7. העלאת `.qa-runs/**` גם בכשל;
8. `supabase stop` ב־`finally` של ה־job.

שלב AI, אם יאושר, צריך להיות job נפרד או flag מפורש עם secret store, מגבלת concurrency ותקציב. אין להריץ אותו אוטומטית על קוד לא מהימן או pull request חיצוני.

## הוספת תפקיד

תפקיד חדש אינו שינוי QA בלבד. תחילה מאשרים ומממשים אותו במודל הנתונים, RLS, `App.tsx`, seed ומסמכי המוצר. לאחר מכן:

1. מעדכנים `qa/config/roles.ts`: `QA_ROLES`, אימייל fixture, חוזה route/control ו־`ROUTE_RULES`.
2. מעדכנים את רשימת החשבונות ב־`qa/runner/setup.ts` ואת `scripts/create-users.ps1`/seed.
3. מוסיפים prompt תחת `qa/agents/prompts/` ומייצאים אותו מה־index.
4. מוסיפים תרחיש מאושר ב־`qa/scenarios/` ומיפוי ב־`qa/runner/agent-runner.ts`.
5. מוסיפים/מעדכנים Playwright דטרמיניסטי להרשאות חיוביות ושליליות.
6. מריצים `npm.cmd run qa:typecheck` ו־`npm.cmd run qa:test`, ואז הרצה מקומית מלאה.

`platform` אינו tenant role ואסור להוסיף אותו ל־`QA_ROLES` כקיצור דרך.

## הוספת תרחיש

1. מוסיפים ID ל־`ScenarioIdSchema` ב־`qa/scenarios/schema.ts`.
2. מוסיפים הגדרה מלאה ל־`qa/scenarios/registry.ts`: תפקידים, status, fixtures, dependencies, routes, צעדים, evidence ו־verifier IDs.
3. מעדכנים את assertion של גודל המרשם ואת בדיקות `registry.test.ts`.
4. מוסיפים fixture סינתטי ל־`qa/fixtures/` אם נדרש, כולל hash ואימות parser.
5. מחברים בדיקה דטרמיניסטית לדרישה יציבה; חקירה פתוחה יכולה להישאר בשלב הסוכנים אך אינה מחליפה שער הרשאות/כספים דטרמיניסטי.
6. כל פעולה עסקית משנה נתונים חייבת verifier בלתי תלוי וראיה.

## הוספת verifier

1. מוסיפים פונקציה ממוקדת תחת `qa/verification/` שמחזירה `VerificationResult` דרך `createVerificationResult` ומצנזרת evidence.
2. שומרים על קריאה בלבד כאשר אפשר. mutations נשארות ב־UI; ה־verifier רק בודק את התוצאה.
3. מייצאים מ־`qa/verification/index.ts`.
4. מחברים check ID מפורש ל־allowlist של התרחיש ול־callback המהימן ב־`qa/runner/agent-runner.ts`.
5. מוסיפים בדיקה קטנה ל־PASS, FAIL, BLOCKED ול־redaction.

אין לחשוף לסוכן או למודל את runtime ה־verification, מפתח `service_role`, SQL, שמות secrets או פלט raw שעלול להכיל מידע רגיש.

## מגבלות ובדיקות אנושיות

- Axe מכסה כללים אוטומטיים בלבד. היעדר הפרת Axe אינו הוכחת תאימות מלאה ל־WCAG 2.1 AA.
- נדרשת בדיקת screen reader אנושית בעברית וב־RTL, כולל סדר קריאה, שמות נגישים והודעות שגיאה.
- נדרשת ביקורת תחום כספי אנושית על סכומים, הקצאות, סטטוסים, idempotency ו־audit reason.
- נדרשת בדיקת עובד מטבח על מכשיר נייד אמיתי בזמן קבלת סחורה.
- נדרשת בדיקת חשבונאי על תוכן ופורמט export אמיתי.
- נדרשת בדיקת ספק האם תהליך המחירון החודשי ברור ומובן ללא הדרכה.
- נדרשת בדיקה ברשת איטית/מקוטעת של התאוששות, כפילויות והודעות מצב.
- הנתונים סינתטיים וקטנים; אין כאן מבחן עומס, ביצועים או נתוני לקוח מייצגים.
- הבדיקות מקומיות בלבד ואינן מאמתות הגדרות, secrets, migrations או RLS של production.
- מתאם ה־AI אופציונלי ולא דטרמיניסטי; כל ממצא משמעותי דורש ראיה ו־verifier עצמאי.
- פרוטוקול פעולת הסוכן שומר actionId, צילומי לפני/אחרי, בקשות ותגובות רשת, מזהים מגוף התגובה והודעה גלויה; mutation ללא ראיה מלאה או verifier עצמאי נחסם fail-closed.
- retry של תשלום אינו mutation נוסף דרך ה־UI: שער דטרמיניסטי מבצע exact replay של אותה בקשה ומוכיח שאין תשלום כפול, והסוכן בודק רק את המצב הגלוי לאחר ההצלחה.
- לשדה סיבת ייבוא הבנק יש שם נגיש קבוע; ה־locator מבוסס התווית תוקן ונבדק מחדש ללא selector מבני מנוחש.
- traces מצומצמים בכוונה לצמצום דליפת מידע, ולכן לעיתים יידרש שחזור ידני נוסף.

החלטות שעדיין דורשות בעלים ואישור מפורטות ב־[`OPEN-QUESTIONS.md`](./OPEN-QUESTIONS.md).
