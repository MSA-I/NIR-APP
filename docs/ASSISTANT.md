# העוזר של InPlace — מסמך היוזמה

שם פנימי: **InPlace Assistant**. שם למשתמש: **העוזר של InPlace**.

מסמך זה הוא מקור האמת ליוזמה: החוזים, ההכרעות, מפת היכולות, ממשל הספק ומטריצת השימור.
הקוד הקנוני של החוזים הוא `src/lib/assistant/contracts.ts` — המסמך מתעד אותו, לא להפך.

---

## 0. מה זה, ומה זה לא

**זה לא צ׳אט.** זה עוזר תפעולי שכל טענה כמותית שלו נשענת על ערך שהשרת חישב, עם מזהה שאפשר
לאמת. המודל רשאי **להסביר** מספר; אסור לו **לייצר** אותו.

הכלל המנחה של הפרויקט (סעיף 12 בחוקה) הוא המבחן גם כאן: האם המנהל מבין בתוך שניות מה דורש טיפול
ומה עלול לגרום להפסד. עוזר שמנסח יפה ולא מוכיח — נכשל במבחן הזה, גם כשהוא צודק.

**מה שכבר קיים ואינו נבנה מחדש.** למוצר יש היום "עוזר ללא מודל": `src/lib/summary.ts` (חמישה מדדים
עסקיים) ו-`src/lib/alerts.ts` (שישה סורקי מצב עומד, כולם מעל RPC קיימות). היוזמה הזו **עוטפת** אותם,
ולא כותבת מחדש את החישוב. ‏`summary.ts` נשאר; המפרט אוסר במפורש למחוק אותו או להחליף אותו בפרוזה.

---

## 1. גבולות ההרשאה — שלוש מערכות, שלושה תפקידים

| מנגנון | מה הוא מכריע | איפה | נכשל לכיוון |
|---|---|---|---|
| **דגל** ‏`assistant.ui/history/drafts` | האם המשטח חשוף לארגון | `0059` · `resolve_feature_flags()` | כבוי |
| **מדיניות** ‏`assistant.confirmed_actions` | האם מותר לבצע הצעה מאושרת | דפוס `0076` · פקודת מפעיל עם סיבה וביקורת | כבוי בבסיס (CHECK) |
| **זכאות** ‏`assistant_runs.monthly` | כמה, בתקופה | `0154` · `effective_entitlement()` | סירוב (`measured=false`) |
| **הגבלת קצב** ‏`assistant_assert_run_rate_limit()` | כמה בשעה, למשתמש | דפוס `0020`/`0159`, נספר ב-Postgres | סירוב |
| **תפקיד + RLS + הפקודה הקיימת** | מה בכלל נראה ומה מותר לכתוב | `auth_org()`, ‏`auth_role()`, ‏`auth_scopes()` | חסימה |

החוק של `0059` הוא חוק גם כאן: **דגל לעולם אינו מעניק הרשאה, רק מכבה משטח.**

**ולכן המתג של פעולה מאושרת אינו דגל.** ‏`ENTERPRISE-SECURITY-MODEL §8` אוסר על דגל להרחיב הרשאה,
ו-`p4_flags_identity.sql` אוכף מבנית ש-`resolve_feature_flags()` לא יופיע בשום מסלול הרשאה.
מתג שפותח דרך חדשה לכתיבה עסקית הולך לפי דפוס מדיניות האוטונומיה (`OPEN-DECISIONS #109`,
מיושם ב-`0076`): בסיס כבוי שמוחזק ב-CHECK, והדלקה לארגון רק דרך פקודת מפעיל עם סיבה וביקורת.
‏`0076` נכתב בדיוק מפני ש-`0059` היה הצורה הלא-נכונה למחלקת המתגים הזו, והוא מסביר זאת בכותרת שלו.

**שלושה דגלים, וכולם נולדים כבויים:** `assistant.ui`, `assistant.history`, `assistant.drafts`.
‏`p4_flags_identity.sql` מצמיד את מספרם ודורש נימוק על כל תוספת — הפסקה הזו היא הנימוק.

**מה שלא נוצר, במכוון:**
- **זכאות בוליאנית `assistant.enabled`** — ‏`OPEN-DECISIONS #158` קובע שמסלולים במוצר הזה נבדלים
  בנפח בלבד ולא ביכולת ("Free הוא הדמו של המוצר"). זכאות יכולת הייתה הופכת את ההכרעה הזו בדלת צדדית.
- **שליחה חיצונית** — אין במוצר פקודת "שלח מייל לספק" בכלל. דגל ליכולת שאין לה פקודה מאחוריה הוא
  הבטחה ריקה בממשק המפעיל.
- **הערכה מול מודל חי** — החלטת CI, לא מתג ארגוני.

---

## 2. סמנטיקת זמן — מה שהמוצר באמת מודד

אזור הזמן העסקי הוא **Asia/Jerusalem**, ולא הומצא כאן: `BUSINESS_TIME_ZONE` ב-`src/lib/format.ts`,
ו-`at time zone 'Asia/Jerusalem'` בשרת ב-`supplier_metrics`, ‏`canonical_purchase_metrics`
(עם עוגן ב-`0113` שמפיל את המיגרציה אם ההמרה תיעלם), ‏`usage_period` ועוד. **אין עמודת אזור-זמן
לארגון**, והמצאת אחת עבור העוזר היא הכרעה עסקית שאיש לא קיבל.

**הממצא שקובע את הסעיף הזה: המוצר מתכוון היום לשני דברים שונים במילה "השבוע".**
`summary.ts` ו-`alerts.ts` עובדים בחלונות נגררים (7 ו-30 יום). הדשבורד מקבץ שבועות דרך
`startOfCalendarWeek` — **שבוע שמתחיל ביום ראשון**. בשרת אין בכלל עוזר שבוע. שתי התשובות
מגינות על עצמן, ואין על המסך דבר שאומר איזו מהן ניתנה.

לכן העוזר תומך **בחלונות נגררים בלבד**: 7, ‏30 ו-90 יום. לא כי הקלנדרי לא קיים, אלא כי הצעת שתיהן
הייתה מאפשרת לאותה שאלה לחזור עם שני מספרים. כל כלי מחזיר `as_of` ומצהיר על החלון שלו בטקסט
(`TIME_WINDOW_LABELS`), כדי שהתשובה תישא את גבולותיה.

→ הכרעה פתוחה: `OPEN-DECISIONS #178` — מה "השבוע" אומר במוצר, ומי משנה את עצמו כשיוכרע.

---

## 3. סיווג נתונים ומה לעולם אינו עוזב

`DATA_CLASSES` ב-`contracts.ts`. ‏RLS שולט בשורות; הסיווג שולט ב**שדות**. אלה שני בקרים נפרדים ואף
אחד מהם אינו מחליף את השני.

**לעולם אינו נשלח לספק** (`PROVIDER_FORBIDDEN_CLASSES`): `bank_restricted`, `personal_contact`,
`document_raw`, `provider_forbidden`.

בפועל: מסכת בנק ולא פרטי בנק; ממצאי חשבונית ולא מטען ה-OCR המלא; מדדי ספק ולא רשומת הספק; שם קובץ
בטוח ולא נתיב אחסון. כל כלי מצהיר על ההיטל שלו — אין "שלח את השורה".

---

## 4. ממשל ספק המודל

הקריאה לספק עוברת דרך **גבול ה-egress הקיים** (`supabase/functions/_shared/organization-egress.ts`
ו-`reserved-egress.ts`): הזמנה, ביצוע, סילוק עם ראיה. ארגון מושעה או במצב קריאה-בלבד אינו מגיע לספק
כלל, וכל ניסיון נסגר עם ראיה בלתי-משתנה. לא נבנה גבול חדש.

הכיוון היחיד המותר הוא **דפדפן ← גבול InPlace ← ספק**. מפתח ספק לעולם אינו בדפדפן, והתצורה של ספק
העוזר נפרדת מזו של פירוש המסמכים (משתנה סביבה נפרד, לא שימוש חוזר ב-`OPENAI_API_KEY`).

**בחירת הספק היא הכרעת ממשל, לא העדפה טכנית.** ‏`OPEN-DECISIONS #124`: הדפים `/terms` ו-`/privacy`
נוקבים בשמות מעבדי-המשנה האמיתיים — Supabase, ‏OpenAI, ‏Cloudflare, ‏Resend, ‏Sentry — ו-`TERMS_VERSION`
מוצמד עם הסכמה שנאכפת בשרת (`0089`). לכן ברירת המחדל היא **OpenAI**, שכבר מופיע שם ומשמש את פירוש
המסמכים. **מעבר לספק אחר אינו שינוי תצורה אלא שינוי מסמכי הסכמה** — עדכון שני הדפים והעלאת גרסת
התנאים, לפני שורת קוד אחת.

`OPEN-DECISIONS #98` מסווג הזרמת נתונים עסקיים לכתובת חיצונית כ"אותה מחלקת דליפה כמו פרטי בנק".
זה בדיוק מה שהיטל הכלי הופך להיות כשהוא מגיע לספק — ולכן ההיטל הצר הוא הבקרה, לא הבטחה.

**חמש שורות החובה של `#179` נאכפות בקוד, לא בכוונה טובה.**
‏`supabase/functions/assistant/governance.ts` קורא אותן מהתצורה, ו-`parseAssistantConfig` מסרב
**לפני הדגם ולפני שאר הכוונונים** אם אחת מהן אינה `VERIFIED`. הסירוב מגיע לדפדפן כ-
`assistant_provider_unavailable` (‏503) — "העוזר אינו זמין כרגע. הנתונים עצמם זמינים במסכים." —
כלומר בדיוק ה-fallback הדטרמיניסטי, ולא ספק שני. הראיות עצמן, עם מקור מתוארך ושם מי שאימת,
נרשמות ב-**`docs/ASSISTANT-ACTIVATION-EVIDENCE.md`**; המסמך הזה מתעד את הקוד, לא להפך.

| שורת ממשל | מפתח בקוד | מצב 25.08.2026 | מה נדרש כדי לסגור |
|---|---|---|---|
| שימוש הנתונים לאימון | `training_use` | `VERIFIED` (24.08) | מקור רשמי מתוארך של הספק, ושם מי שקרא |
| שימור אצל הספק | `retention` | `VERIFIED` (24.08) | ‏standard בגילוי נאות **או** חוזה שמוכיח zero-retention |
| לוגים אצל הספק | `provider_logs` | `VERIFIED` (24.08) | מקור רשמי מתוארך; אותו כלל חוזה חל על טענת אפס-לוגים |
| הסכם עיבוד נתונים (DPA) | `dpa` | **`MISSING`** — אין ישות משפטית שתתקשר (בעלים, 25.08) | חתימה לפני דייר ראשון, עם הפניה לחוזה |
| אזור / ריבונות נתונים | `data_region` | `VERIFIED` (24.08) | מקור רשמי מתוארך |
| הפרדת סביבות | — | קיים | מפתח נפרד לייצור ולפיתוח |
| החלפת מפתחות | — | קיים | ידנית, מתועדת |
| מדיניות ספק גיבוי | — | **אין ספק גיבוי** | כשל ספק = תשובה דטרמיניסטית, לא ספק אחר |

‏`store: false` (‏`provider.ts:339`) אינו אחת מחמש השורות ואינו מחליף אף אחת מהן: זו בקשת API,
לא הוכחת מחיקה ולא חוזה.

**מה שהטבלה אומרת ומה שהיא לא.** העמודה „מצב" היא מצב **הראיה המתועדת**
(`ASSISTANT-ACTIVATION-EVIDENCE.md §1`), לא מצב הסוד בפונקציה הפרוסה. ‏`VERIFIED` בטבלה פירושו
שנמצא מקור רשמי מתוארך ושמישהו חתום עליו — לא שמשתנה הסביבה המתאים הוגדר בייצור. בייצור לא
נפרס דבר.

**שורה אחת חסרה, והשער סגור — גם אחרי שהבעלים הורה להפעיל.** ‏`dpa` נשארת `MISSING` מסיבה
שאינה בשליטת הפרויקט: ‏DPA נכרת בין ישות משפטית ל-`OpenAI OpCo, LLC`, וחברה טרם נרשמה
(בעלים, 25.08.2026). החתימה נקבעה לזמן ההשקה, לפני הדייר הראשון. הבעלים הורה באותו יום להפעיל
את העוזר בייצור; **ההוראה לא יושמה, ואין לממש אותה בכתיבת `VERIFIED` בשורה** — הסטטוס הוא טענה
על חוזה קיים, והוא נגזר החוצה ל-`/privacy` ול-`/terms`. הדרך הכשרה היא משטח חריג מפורש שטרם
נכתב: לפני-השקה בלבד, לארגון של הבעלים בלבד, נרשם ב-`audit_logs`, ונסגר עם הדייר הראשון.
הפירוט ב-`DEBT-REGISTER §63` ו-`OPEN-DECISIONS #179`. **הזרימה עצמה אינה בספק:** היא הורצה
מקצה לקצה מקומית ב-24.08.2026 (`NIR-APP-DOCS/release-evidence/20260824-assistant-local/`).

### תצורה — משתני סביבה של פונקציית ה-Edge

**אינם נכנסים ל-Git.** נקבעים כסודות של הפונקציה, בנפרד מתצורת ה-OCR ופירוש המסמכים.

| משתנה | ברירת מחדל | התנהגות כשחסר או פגום |
|---|---|---|
| `AI_ASSISTANT_API_KEY` | — | **חובה.** חסר = סירוב `assistant_provider_unavailable` |
| `AI_ASSISTANT_MODEL` | — | **חובה.** אין ברירת מחדל שקטה לדגם |
| `AI_ASSISTANT_PROVIDER` | `openai` | ספק אחר = שינוי מעבדי-משנה, ראו למעלה |
| `AI_ASSISTANT_FAST_MODEL` | — | אופציונלי |
| `AI_ASSISTANT_MAX_OUTPUT_TOKENS` | ‏4096 | פגום = סירוב |
| `AI_ASSISTANT_TIMEOUT_MS` | ‏30,000 | פגום = סירוב |
| `AI_ASSISTANT_MAX_TOOL_CALLS_PER_TURN` | ‏4 | פגום = סירוב |
| `AI_ASSISTANT_CONTEXT_MESSAGE_LIMIT` | ‏12 | פגום = סירוב |
| `AI_ASSISTANT_GOVERNANCE_TRAINING_USE` · `_RETENTION` · `_PROVIDER_LOGS` · `_DPA` · `_DATA_REGION` | — | **חובה, חמישתן.** חסרה, אינה `VERIFIED`, או אינה מפוענחת = סירוב `assistant_governance_incomplete:<שורות>`. הפורמט ב-`ASSISTANT-ACTIVATION-EVIDENCE.md §3` |
| `AI_ASSISTANT_PRELAUNCH_EXCEPTION` | — (אין) | **‏30.08.2026: אינו מוגדר בייצור, וזה מכוון.** ה-DPA נחתם, שורת `dpa` עומדת על ראיה, וההיתר נמחק (`DEBT §63`). המשטח נשאר בקוד; **החזרתו היא הכרעה ולא תיקון**. מכאן ולמטה — תיאור המנגנון: **אופציונלי, ומוותר על שורת `dpa` בלבד** (`#271`). פורמט `until=YYYY-MM-DD;org=<uuid>;reason=<text>`. מוותר רק כאשר `dpa` חסרה או `MISSING`, רק לארגון הנקוב, ורק עד התאריך — אחרת `prelaunch_exception_covers_dpa_only` / `_not_for_this_cause` / `_wrong_organization` / `_expired`. ערך פגום = `assistant_prelaunch_exception_unparsable`, **לא** „אין היתר". **אינו הופך את `dpa` ל-`VERIFIED` ואינו משנה דבר ב-`/privacy`** |
| `AI_ASSISTANT_DAILY_USER_LIMIT` · `_DAILY_ORG_LIMIT` · `_MONTHLY_ORG_LIMIT` | לא מוגדר | לא מוגדר = **אין תקרה נוספת**; מוגדר אך בלתי-מדיד = סירוב |
| `AI_ASSISTANT_SOFT_COST_CAP` · `_HARD_COST_CAP` | לא מוגדר | **אין מקור מחיר היום** (`#183`), ולכן עלות נרשמת `null`; הגדרת אחת התקרות מסרבת fail-closed עד שמקור מחיר מנוהל ימלא מדידה אמיתית |

תקרות ה-env הן **תוספת** מעל הזכאות והגבלת הקצב שבמסד, לעולם לא במקומן. משתנה סביבה בתוך מופע
אחד אינו יכול לספור בקשות שנחתו במופע אחר — הספירה היא של Postgres.

**שימור ההיסטוריה אינו משתנה סביבה כאן.** הוא נשמר במסד עם הטיהור המתוזמן (§6): משתנה סביבה
אינו יכול למחוק שורה, ושני מקורות אמת לאותה תקופה הם סתירה שמחכה לקרות.

**הכרעת ארכיטקטורה:** אין fallback לספק שני. ספק שני פירושו שאותם נתונים עוברים לגוף שלא נבדק
באותה מידה, ובדיוק ברגע שבו המערכת לחוצה. במקום זה, כשל ספק מחזיר את המשתמש למסלול הדטרמיניסטי
(`/alerts` והמסכים) — שממשיך לעבוד בלי מודל בכלל.

→ הכרעות פתוחות: `OPEN-DECISIONS #179` (ממשל ספק) ו-`#183` (מקור מחיר קנוני).

### 4.1 evaluation — corpus offline ושער live ידני

`supabase/functions/assistant/evaluation.ts` מחזיק corpus **סינתטי בלבד**: שלוש תשובות נתמכות
וחסימות contact/bank/secret. ‏`evaluation.test.ts` מעביר אותו דרך אותם classifier, validator וחוזה
runtime של הייצור, ומשנה כל claim כדי להוכיח שהערך המזויף נדחה. זו ראיית חוזה, לא ראיית איכות מודל.

`live-evaluation.ts` הוא runner ידני שאינו חלק מ-CI רגיל ואינו קורא Supabase. הוא אינו רשאי ליצור
provider אלא כאשר קיימים יחד:

- `AI_ASSISTANT_LIVE_EVALUATION=1`;
- `AI_ASSISTANT_LIVE_EVALUATION_ACK=synthetic-provider-spend`;
- מפתח `AI_ASSISTANT_API_KEY` ו-model מפורש בזמן הריצה.

הבדיקה האוטומטית מוכיחה שכל שילוב חסר נעצר **לפני** executor. בסגירה הנוכחית לא ניתן מפתח ולא
בוצעה קריאה חיה; לכן הסטטוס נשאר `LIVE_MODEL_NOT_EVALUATED`. גם runner סינתטי אינו עוקף את חסמי
הממשל `#179` והכרעת capability ‏`#193`, ואינו ראיית sandbox/Production.

---

## 5. עדות: עובדות, מקורות, וכלל הספרות

**עובדה (`Fact`)** היא ערך שהשרת חישב, עם מזהה שתקף **רק בריצה שהנפיקה אותו**. זה מה שהופך את
"צטט רק מה שהריצה הזו החזירה" לבדיק.

**מקור (`SourceReference`)** הוא מקום במוצר שאדם יכול ללכת אליו ולראות בעצמו. מקור הוא **הפניה, לא
הרשאה**: בכל טעינה מחדש הוא נבדק מול ההרשאות הנוכחיות.

**כלל הספרות** (`DIGIT_PATTERN`): בלוק טקסט רגיל **אינו רשאי להכיל ספרה**. כל כמות חייבת לשבת בבלוק
`claim` שנשען על לפחות עובדה אחת. זה החצי המכני של "עדות לפני רהיטות", והוא נאכף אחרי הייצור ולפני
שהתשובה מגיעה לדפדפן. תשובה שלא עברה — נדחית, ולא מוצגת פרוזה במקומה.

**אימות אחרי ייצור בודק:** שהמזהה קיים בריצה; שהמקור שייך לדייר; שהקורא הנוכחי רשאי לקרוא אותו;
שהנתיב הוא נתיב שכלי החזיר ולא נתיב שהומצא; ושכל מספר בטקסט תואם עובדה מצוטטת.

### 5.1 סקירת איום P0 — גבול ההיסטוריה והספק

| רגע אמון | האיום | הבקרה המחייבת | סירוב שנבדק |
|---|---|---|---|
| קלט חופשי נוכחי | סוד, פרטי קשר, פרטי בנק או מסמך גולמי נכנסים ל-provider | `input-classification.ts` מסווג בשרת **לפני** מכסה, היסטוריה, lease ובניית provider; אין redaction שמשנה את משמעות השאלה — כל הפריט נדחה | secret/JWT/PEM/bank/contact/raw-document, כולל bidi ו-zero-width |
| היטל כלי | row מורשה מכיל שדה שאסור להוציא | projection מפורש לכל כלי, `DATA_CLASSES`, ‏`mayReachProvider()` ו-`serializeEnvelopeForProvider()` שמסיר `data` ו-routes | bank/contact/raw-document/provider-forbidden לעולם אינם Facts/Sources של הספק |
| טעינת היסטוריה | הרשאה ישנה הופכת למענק קבוע | snapshot גולמי הוא `service_role` בלבד ובנוי מ-Facts/Sources; ב-Edge כל run עובר parse, semantic validation, סיווג טקסט מחדש, actor טרי וקריאת `id` בלבד תחת ה-JWT/RLS הנוכחי | role/scope/tenant change, flag history שבוטל, disabled/offboarded user, suspended org, source שנמחק או הוסתר |
| תשובה אחרי generation/retry | המקור נמחק או ההרשאה השתנתה בזמן קריאת המודל | כל תשובה תקינה עוברת `authorizeAssistantEvidence()` מחדש; ה-actor **אינו נשמר במטמון**, ולכן גם הניסיון הראשון וגם retry רואים את ההרשאה באותו רגע. כשל שני מחזיר `assistant_unsupported_answer` בלי פרוזה | actor/context change, source/RLS change, route לא מורשה ו-Fact שאינו תומך סמנטית בטענה |
| זיכרון הדפדפן | תוצאה ישנה נשארת אחרי החלפת תפקיד/ארגון/lifecycle | fingerprint ללא סודות + epoch; question/result/conversation/error/pending נעלמים לפני paint, ותשובה מאוחרת אינה יכולה לכתוב state | settled ו-pending במעבר owner→office |
| egress וספק | קריאה חיצונית בלי גידור או בלי ממשל | lease מסוג `assistant`, ‏TTL ‏5–120 שניות, active/trial/grace בלבד, settlement עם evidence, ‏`store:false`, אין fallback | tenant suspended, kind תשיעי, TTL חורג, browser ACL |

בטעינת היסטוריה המימוש השמרני **משמיט run שלם** אם פרט אחד אינו עובר מחדש; אין redaction חלקי
שעלול להפוך שאלה או תשובה למשפט אחר שנראה סמכותי.

**הגבול השיורי מפורש:** מסווג טקסט הוא שכבת refusal שמכסה תבניות מוכרות, לא הוכחה חוזית שהספק
אינו שומר או מאמן על קלט שעבר. לכן `#179` נשאר חסם activation גם כשהקוד והבדיקות ירוקים. בדומה,
`store:false` הוא בקשת API ולא הוכחת מחיקה אצל הספק. שינוי הרשאה מקבילי יכול להתרחש אחרי בדיקה
אחרונה כמו בכל מערכת מבוזרת; כל נקודת שימוש נבדקת מחדש, כשל מאוחר אינו מציג תשובה, ואין ניסיון
לבטל בדפדפן קריאה שהספק אולי כבר קיבל.

---

## 6. מטריצת שימור ומחיקה

| רשומה | שימור | מחיקה רכה | מחיקה קשה | טיהור | חריג ביקורת |
|---|---|---|---|---|---|
| `assistant_conversations` | 90 יום מפעילות אחרונה | `deleted_at` בבקשת משתמש | בטיהור | מתוזמן | — |
| `assistant_messages` | 90 יום | אין | מיידית במחיקת שיחה | מתוזמן | — |
| `assistant_runs` | 90 יום | אין | בטיהור | מתוזמן | — |
| `assistant_tool_calls` | 90 יום | אין | עם הריצה | מתוזמן | — |
| `assistant_facts` / `assistant_source_references` | 90 יום | אין | עם הריצה | מתוזמן | — |
| `assistant_action_proposals` שלא בוצעו | 30 יום | אין | בטיהור; draft/awaiting/rejected/expired נמחקים מיד במחיקת שיחה | מתוזמן | confirmed/failed נשארים עד חלון 30 הימים כי הם החלטת אדם |
| `assistant_action_proposals` שבוצעו | כשימור הפקודה שהן הפעילו | אין | **לא נמחק** | — | **כן** |
| `assistant_feedback` | 90 יום | אין | בטיהור | מתוזמן | — |
| `usage_counters` / `usage_events` | לפי `0155` | — | — | — | **כן** |
| `audit_logs` | ללא שינוי | — | — | — | **כן** |

**מחיקת היסטוריית שיחה לעולם אינה מוחקת רשומת ביקורת פיננסית.** אם שיחה הובילה לפעולה שבוצעה,
הפעולה נשארת ב-`audit_logs` עם הסיבה שלה; מה שנמחק הוא הטקסט של השיחה.

**התנהגות מחיקה מפורשת:** הודעות, Facts, הפניות מקור, labels שנשמרו, arguments/shape של tool calls,
feedback והצעות שלא אושרו נמחקים מיד. אין compacted summaries במימוש. שורות `assistant_runs`,
`usage_events` ו-usage counters נשארות כראיית מכסה/עלות בלי טקסט שיחה. הצעה confirmed/failed נשארת
עד חלון 30 הימים; הצעה executed ורשומת ה-`audit_logs` שלה אינן נמחקות. שורת השיחה מקבלת tombstone
ונמחקת קשה בטיהור לאחר שאין לה הודעות.

**גיבויים וספק:** הטיהור מבטיח מחיקה מהמסד החי; גיבויי הפלטפורמה עלולים לשמור עותק עד סבב
ה-rotation שלהם. הספק אינו מקבל transcript שמור דרך API של InPlace, אבל מחיקת שיחה במסד אינה
הוכחת מחיקה אצל הספק. שימור/zero-retention/log deletion אצל OpenAI נשארים חסם activation ב-#179.

**הערה על אמינות ההבטחה:** בריפו לא היה לפני `0164` שום job מתוזמן למחיקה — `0103` תכנן טיהור ולא מימש,
ו-`0159` סירב לו במפורש. הטיהור כאן מיושם כפונקציה מתוזמנת דרך `pg_cron` (התקדים קיים ב-`0016`,
`0028`, `0081`, `0142`). **תקופת השימור נשמרת במסד ולא במשתנה סביבה של Edge** — משתנה סביבה אינו
יכול למחוק שורה, ושני מקורות אמת לתקופה אחת הם סתירה שמחכה לקרות.

---

## 7. מפת היכולות

המפה נגזרת ממדידה של הריפו, לא מהמפרט. אין כלי שנכתב לפני שהיכולת שלו סווגה.

| שאלה | האובייקט הסמכותי | ההגדרה **כפי שמומשה** | סיווג |
|---|---|---|---|
| למה חשבונית חסומה | `get_invoice_three_way_match` (`0099`) | ‏19 קודי סיבה עם חומרה ומספרים; סבילות שורה ‏0.05₪, כותרת ‏1₪, מחיר ‏1%, כמות ‏2% ליחידות משקל/נפח ו-0 לאחרות. אישור נחסם בטריגר, לא בייעוץ | `VERIFIED` |
| מה הוזמן / התקבל / חויב | אותה RPC, ‏`order_items[]` ו-`lines[]` | הוזמן `poi.qty` · התקבל `poi.received_qty` · חויב כולל חשבוניות מאושרות קודמות. הדלתא מחושבת בשרת | `VERIFIED` |
| אילו שורות חרגו ממחיר ההזמנה | אותה RPC, ‏`unit_price_above_order` | בסיס ההשוואה הוא **snapshot** ‏`purchase_order_items.unit_price`, לא המחירון של היום | `VERIFIED` לחשבונית · **`DOES_NOT_EXIST` כרשימה חוצת-חשבוניות** |
| מצב העסק עכשיו | `management_dashboard_snapshot` (`0100`+`0137`+`0148`) | ‏`SECURITY INVOKER`; מחזיר NULL לכל תפקיד שאינו owner/office; ‏`money.openBalance` ריק ל-office **בכוונה** | `VERIFIED` |
| כמה נרכש בתקופה | `get_purchase_metrics` (`0113`+`0137`) | חשבוניות **מאושרות** בלבד, ‏`payable`, מקובצות לפי **`invoice_date`** — לא לפי מועד הקליטה | `VERIFIED` (בכפוף לניסוח מדויק) |
| כמה חשבוניות נקלטו השבוע | `summary.ts` → `p2_business_summary_rows()` (`0165`) | ‏`received_date >= today-7`, ‏`payable`, לא מחוק | `VERIFIED` |
| איזה ספק מאחר, ועל סמך כמה הזמנות | `supplier_metrics` (‏`0031`, ‏`0133`) | המדדים לכל ספק מאומתים: חלון **קבוע של 180 יום**; בזמן = `received_at ≤ expected_date`; ‏`on_time_pct` **null** כשאין דגימות. אבל "מי מאחר הכי הרבה" דורש לבחור בין אחוז, מספר איחורים, משך איחור וגודל מדגם | מדדים: `VERIFIED`; דירוג חוצה־ספקים: **`REQUIRES_BUSINESS_DECISION` (#30)** |
| אילו מוצרים ייגמרו | `inventory_intelligence` (`0102`) | ‏`projected_stockout_days` = מלאי / צריכה יומית, ‏null אלא אם **שניהם** נמדדו; הזמנות בדרך **אינן** נזקפות | `VERIFIED` |
| כמה כסף ממתין לזיכוי | דשבורד `credits` + `supplier_metrics` | פתוח = `open`/`requested`/`received`; רק `offset`/`closed` מקטינים יתרה | `VERIFIED` |
| חשיפת תשלום | דשבורד `paymentRequests` | **רק דרישות שהוזן להן תאריך**; ‏`dueDateCoverage` חייב לנסוע עם המספר | `VERIFIED` (חלקי מטבעו) |
| הזמנות שנשלחו ולא אושרו | `purchase_orders status='sent'` תחת RLS | ספירה קיימת בדשבורד; הרשימה היא קריאה מסוננת | `VERIFIED` |
| תנועות בנק לא מותאמות | `bank_transactions status in (unmatched,suggested)` | ספירות בדשבורד; הרשימה היא קריאה מסוננת עם היטל צר | `VERIFIED` |
| אילו ספקים העלו מחירים החודש | — | ‏`price_changes_window` סופר שינויים ב-180 יום, **בלי כיוון, בלי סכום, ולא בחודש** | **`REQUIRES_BUSINESS_DECISION`** |
| חיסכון משוער / המלצת ספק / הצעת רכש | — | ‏`suggested_reorder_quantity` הוא נוסחה מעל `min_stock`, לא המלצה | **`REQUIRES_BUSINESS_DECISION`** |
| שליחת תזכורת לספק | — | אין פקודת "שלח מייל לספק". ‏WhatsApp קיים להזמנות ולתזכורות מתוזמנות בלבד | **מחוץ לתחום** |

### 7.1 חוזה הגישה וההיטל של 13 הכלים

`JWT/RLS` בטבלאות הבאות פירושו לקוח Supabase שנבנה מה-JWT הנוכחי של הקורא; אף כלי אינו משתמש
ב-`service_role`. ‏`source-owned unit scope` פירושו שהעוזר אינו ממציא מסנן יחידה נוסף: ה-RLS או גוף
ה-RPC הקנוני מכריעים `org_id`, ‏`auth_scopes()` ותפקיד. בכל הכלים `serializeEnvelopeForProvider()`
מסיר את `data` ואת ה-routes; רק Facts והפניות מקור מצומצמות מגיעים לספק. לכן עמודת "היטל" מתארת
גם מה נשאר בשרת/בדפדפן וגם מה מותר לעבור לגבול הספק.

**מצב גישה משותף לכל 13 הכלים:** actor חייב להיפתר מחדש לתפקיד פעיל ול-`assistant.ui=true`;
זכאות ומכסה חייבות להיות מדידות; lease חיצוני ניתן רק ב-`active|trial|grace`. ‏`read_only`,
offboarding, suspended או actor שהשתנה אחרי טעינת history אינם מגיעים לקריאת ספק. הצעת פעולה,
אם תאושר בעתיד, תדרוש בנוסף `canWrite`, מדיניות #182 והפקודה הקנונית עם ה-JWT של המאשר.

| כלי | תפקידים מורשים | מצב גישה, RLS ויחידות | היטל, שדות רגישים ומיסוך | חוב אבטחה / הכרעה |
|---|---|---|---|---|
| `explain_invoice_block` | owner, office, accountant | ‏`get_invoice_three_way_match`; ‏`SECURITY DEFINER` עם guard מפורש ל-actor, org, role, מחיקה ו-`auth_scopes()`; accountant רואה רק חשבונית מאושרת | סטטוס, סכום, קודי סיבה, סבילויות וסיבת override; אין OCR גולמי, קובץ או storage path; `data` אינו מגיע לספק | כפוף לרשם ה-definer ב-`DEBT §7`, עם enforcement מוצמד ב-`0099`; אין הרחבת הרשאה של העוזר |
| `compare_order_receipt_invoice` | owner, office, accountant | אותו RPC ואותו guard כמו הכלי הקודם | כמויות הזמנה/קבלה/חיוב ודלתאות מחיר שה-RPC חישב; תיאור שורה מנוקה ומוגבל; אין מטען OCR; לכל היותר 25 פריטי הזמנה מנפיקים Facts | ‏`DEBT §29`: snapshot אישור ממשיך לצרוך כמות גם אחרי `investigation`; זו סמנטיקת המקור המוצהרת, לא תיקון של העוזר |
| `get_dashboard_snapshot` | owner, office | ‏`management_dashboard_snapshot`; ‏`SECURITY INVOKER`, ‏JWT/RLS ו-source-owned unit scope | היטל מדדים קבוע. ל-office מוסרים גם מ-`data` וגם מ-Facts את bank, ‏`openSupplierCount` ו-`topBalances`; שמות ספק מנוקים | ‏`DEBT §59` נשאר פתוח במקור. הכלי ממיר את האפס השקרי ל-`complete:false/not_permitted`; צרכנים אחרים עדיין חשופים לחוב |
| `get_business_summary` | owner, office | ‏`p2_business_summary_rows`; ‏`SECURITY INVOKER`, ‏JWT/RLS ו-source-owned unit scope; role gate לפני ה-RPC | חמישה aggregates בלבד; אין rows, שמות או טקסט מקור | accountant הוא `not_permitted` עד read model שמוכיח שה-RLS שלו אינו הופך חוסר נראות ל-`0 measured` |
| `get_purchase_metrics` | owner, office, accountant | ‏`get_purchase_metrics`; ‏`SECURITY DEFINER` עם actor/org/role מפורשים; aggregate ארגוני בלבד, בלי החזרת row חוצה־יחידה | שבעה מדדי כסף/ספירה והגדרת net של השרת; אין חשבוניות או ספקים גולמיים | כפוף ל-`DEBT §7`; semantic window נשאר מתועד ב-#178 |
| `get_open_alerts` | owner, office, accountant | RPCs מסוג `SECURITY INVOKER` ו-`countSentOrders()` מדויק תחת JWT/RLS; source-owned unit scope | ספירות aggregate בלבד; אין רשימות או שמות. מחירון ודרישות מתוארכות נושאים scope warning קנוני | ‏`DEBT §10`: סריקת חשבונית ללא הזמנה נחסמת ל-accountant ומוחזרת ככשל בשם; שאר הסריקות ממשיכות |
| `get_supplier_performance` | owner, office | ‏`supplier_metrics` ‏security-invoker/barrier + RLS; שמות ספקים בשליפה מפורשת `id,name` בלבד | מדדי ביצוע ושם ספק מנוקה; אין contact, ‏bank_details או רשומת ספק מלאה | דירוג "מי מאחר הכי הרבה" הוא `REQUIRES_BUSINESS_DECISION` לפי #30; הכלי אינו מדרג ואוסר להציג את המדדים כדירוג |
| `get_inventory_risk` | owner, office | ‏`inventory_intelligence` ‏security-invoker/barrier + RLS; source-owned unit scope | מדדי מלאי/צריכה/הזמנות בדרך ושם מוצר מנוקה; אין row מוצר מלא | risk read model הוא `VERIFIED`; המלצת ספק/רכש היא `REQUIRES_BUSINESS_DECISION`, ו-#182 אינו תחליף לסמנטיקת המלצה |
| `get_open_credits` | owner, office | snapshot קנוני + `supplier_metrics`, שניהם תחת JWT/RLS | סך ופירוט כספי לפי ספק; `suppliers` מוגבל ל-`id,name`; מסמך זיכוי, OCR ופרטי קשר אינם נשלחים | ‏`DEBT §49`: מסמך זיכוי שלא הפך לרשומת זיכוי אינו נספר; ההגבלה נוסעת עם התשובה |
| `get_payment_exposure` | owner, office | בלוק `paymentRequests` של snapshot קנוני תחת JWT/RLS | aggregates בלבד; הכיסוי `dueDateCoverage/activeCount` תמיד נוסע עם הסכום | אין `invoice.due_date`; חשיפה כוללת מעבר לדרישות מתוארכות היא `DOES_NOT_EXIST`, לא אפס |
| `get_orders_awaiting_confirmation` | owner, office | `purchase_orders` + items + supplier name בקריאה ישירה תחת JWT/RLS | projection מפורש; item snapshots משמשים רק לסכום; לספק עוברים Facts ושם מנוקה, לא שורות הפריטים או פרטי קשר | הרשימה משתמשת overfetch ולא exact count; הספירה המדויקת היחידה להתראה מתועדת מול `DEBT §15` |
| `get_unmatched_bank_transactions` | owner, accountant | `bank_transactions` בקריאה ישירה תחת JWT/RLS; role gate זהה למסך הבנק | `id,date,amount,direction,status,description` בלבד; אין raw import, reference או supplier. התיאור נשאר ב-`data` בלבד ואינו נכנס ל-Fact/Source label של הספק | projection negative test חובה בכל שינוי; אין הרחבה ל-office |
| `find_entity` | owner, office, accountant | ‏`global_search`; ‏`SECURITY INVOKER`, type gate שרתי ו-RLS לפי התפקיד | `id,title,route` בלבד; subtitle של ספק/contact ושל תשלום/reference נזרק; routes נבדקים שוב בשרת; draft חסר EvidenceEntity נזרק | ‏`DEBT §13` הוא חוב ביצועים. היכולת היא locator בלבד, לא מקור אמת כספי |

### 7.2 בעל החישוב, רעננות, גבולות ובדיקות חובה

| כלי | בעל החישוב וסמנטיקת המקור | רעננות | pagination / חלון | בדיקות חובה | מצב יכולת |
|---|---|---|---|---|---|
| `explain_invoice_block` | ‏`get_invoice_three_way_match` (`0099`/`0137`), קודי הסיבה והסבילויות של השרת | קריאה נוכחית; `as_of` בזמן הריצה | UUID יחיד; אין pagination | `tools/business.test.ts`, ‏`p20_invoice_three_way_match.sql`, ‏`p56_assistant_foundations.sql` | `VERIFIED` |
| `compare_order_receipt_invoice` | אותו RPC; דלתאות וכמויות מועברות בלי חישוב במודל | קריאה נוכחית; `as_of` בזמן הריצה | UUID יחיד; Facts ל-25 פריטי הזמנה, ואז `has_more=true` | `tools/business.test.ts`, ‏`p20_invoice_three_way_match.sql`, ‏`p20_invoice_approval_concurrency.sql`, ‏`p56` | `VERIFIED_WITH_DOCUMENTED_CAP` |
| `get_dashboard_snapshot` | ‏`management_dashboard_snapshot` (`0100`/`0137`/`0148`) | business date של Asia/Jerusalem ו-`as_of` נוכחי | aggregate יחיד | `tools/business.test.ts`, ‏`p21_dashboard_snapshot.sql`, ‏`p56` | owner: `VERIFIED`; office: `VERIFIED_PARTIAL/§59_MITIGATED` |
| `get_business_summary` | ‏`p2_business_summary_rows` (`0165`), אותו read model של `summary.ts` | 7 ימים לקבלה, 30 יום למחיר, שאר המדדים נוכחיים; `as_of` נוכחי | חמישה rows קבועים | `tools.test.ts`, ‏`p57_business_summary_parity.sql`, ‏`p56` | owner/office: `VERIFIED`; accountant: `NOT_PERMITTED` |
| `get_purchase_metrics` | ‏`private.canonical_purchase_metrics` דרך `get_purchase_metrics`; snapshot prices, invoice_date ו-net definition שרתיים | מעוגן ביום העסקי בזמן הריצה | חלון נגרר בלבד: 7/30/90 יום; אין pagination | `tools/business.test.ts`, ‏`p33_canonical_purchase_metrics.sql`, ‏`p56` | `VERIFIED`; time-label product decision #178 נשאר גלוי |
| `get_open_alerts` | חמש RPCs קנוניות + exact head count להזמנות sent | נוכחי; מחיר 30 יום, due 7 ימים, margin ‏15% | אין row pagination; כל scan מחזיר aggregate או failure | `tools.test.ts`, ‏`tools/reads.test.ts`, ‏`p2_data_reliability.sql`, ‏`p46_consolidated_supplier_invoice.sql` | `VERIFIED_WITH_NAMED_PARTIAL_FAILURE` |
| `get_supplier_performance` | view ‏`supplier_metrics`; אחוז, sample size, lead time, איחורים וזיכויים כפי שה-view מחשב | חלון קבוע 180 יום; יתרות פתוחות נוכחיות | `limit` ברירת מחדל 50, תקרה 200, ‏limit+1 ו-`has_more` | `tools/business.test.ts`, ‏`tools/reads.test.ts`, ‏`roadmap_db_contracts.sql` | metrics: `VERIFIED`; ranking: `REQUIRES_BUSINESS_DECISION (#30)` |
| `get_inventory_risk` | view ‏`inventory_intelligence`; stockout דורש גם ספירה וגם צריכה; incoming אינו מנוכה | צריכה מאז ספירה ועד 30 יום; מלאי והזמנות בדרך נוכחיים | `limit` ‏50/200, ‏limit+1 ו-`has_more` | `tools/business.test.ts`, ‏`tools/reads.test.ts`, ‏`p24_inventory_intelligence.sql` | risk: `VERIFIED`; recommendation/action: `BLOCKED` |
| `get_open_credits` | credits block של snapshot + פירוט `supplier_metrics`; statuses ‏open/requested/received | business date ו-`as_of` נוכחיים | aggregate + 50 ספקים קבועים, limit+1 ו-`has_more` | `tools/business.test.ts`, ‏`tools/reads.test.ts`, ‏`p21_dashboard_snapshot.sql`, ‏`p56` | `VERIFIED_WITH_SCOPE_LIMIT (DEBT §49)` |
| `get_payment_exposure` | paymentRequests block של snapshot; כסף רק לדרישות עם due date | business date נוכחי; overdue/היום/7 ימים | aggregate יחיד; אין pagination | `tools/business.test.ts`, ‏`p21_dashboard_snapshot.sql`, ‏`p56` | `VERIFIED_PARTIAL_BY_DEFINITION` |
| `get_orders_awaiting_confirmation` | row snapshots של PO; Edge מסכם `qty × unit_price` ומעגל לשתי ספרות; לא מחירון נוכחי | סטטוס sent נוכחי; oldest-first | `limit` ‏50/200, ‏limit+1 ו-`has_more` | `tools/business.test.ts`, ‏`tools/reads.test.ts`, ‏`p56` | `VERIFIED` |
| `get_unmatched_bank_transactions` | rows בסטטוס unmatched/suggested; ספירות הן של העמוד ומסומנות כך כשיש עוד | קריאה נוכחית; newest-first | `limit` ‏50/200, ‏limit+1 ו-`has_more` | `tools/business.test.ts`, ‏`tools/reads.test.ts`, ‏`roadmap_db_contracts.sql`, ‏`p56` | `VERIFIED_WITH_PROVIDER_REDACTION` |
| `find_entity` | ‏`global_search`; איתור בלבד, לא חישוב authoritative | קריאה נוכחית | query ‏2–80; עד 5 תוצאות לכל סוג, בקשת 6 לצורך `has_more`; kind allowlist | `tools/business.test.ts`, ‏`p9_five_domains.sql`, ‏`p46_consolidated_supplier_invoice.sql`, ‏`p56` | `VERIFIED_LOCATOR_ONLY`; ‏`DEBT §13` ביצועים |

### 7.3 Ledger יכולות מפרט המקור

`IMPLEMENTED` פירושו זרימה מחוברת עם מקור שרת ובדיקה; הוא אינו אומר activated או Production.
`BLOCKED_DECISION` פירושו שאין להמציא את הסמנטיקה דרך prompt. כל שורה חסרה מקבלת מספר מפורש.

| יכולת במפרט | סיווג נוכחי | מימוש / חסם |
|---|---|---|
| כמה חשבוניות נקלטו בחלון | `IMPLEMENTED_WITH_DEFINED_WINDOW` | `get_business_summary` מגדיר `payable`, לא מחוק, ‏`received_date >= today-7`; ‏`get_purchase_metrics` עונה על רכישה לפי `invoice_date`, לא על קליטה |
| למה חשבונית חסומה | `IMPLEMENTED` | `explain_invoice_block`; קודי וסבילויות three-way-match של השרת |
| מה הוזמן, התקבל וחויב | `IMPLEMENTED` | `compare_order_receipt_invoice`; quantities/deltas מה-RPC הקנוני |
| שורות מעל מחיר ההזמנה | `IMPLEMENTED_PER_INVOICE` | אותו כלי מול snapshot ההזמנה; רשימה חוצת-חשבוניות היא `DOES_NOT_EXIST` |
| ספקים שהעלו מחיר החודש | `IMPLEMENTED_CALENDAR_MONTH` | `get_monthly_price_rises` מעל `0203`; חודש קלנדרי מ-1 בחודש לפי `Asia/Jerusalem`, delta נטו חיובי בלבד, ושורה בלי בסיס סמכותי מוחרגת כ-`לא ניתן למדוד` ולא נספרת כאפס |
| כסף שממתין לזיכוי | `IMPLEMENTED_WITH_SCOPE_LIMIT` | `get_open_credits`; ‏`DEBT §49` נשאר גלוי |
| הזמנות שנשלחו ולא אושרו | `IMPLEMENTED` | `get_orders_awaiting_confirmation`; סטטוס `sent`, RLS ו-pagination |
| תנועות בנק לא מותאמות | `IMPLEMENTED_ROLE_BOUND` | `get_unmatched_bank_transactions`; owner/accountant בלבד, projection ללא raw/reference |
| הספק שמאחר הכי הרבה וגודל המדגם | `PARTIAL / BLOCKED_DECISION #30` | `get_supplier_performance` מחזיר מדדים ומדגם; אינו ממציא פונקציית דירוג |
| מוצרים שצפויים להיגמר | `IMPLEMENTED_READ_ONLY` | `get_inventory_risk`; null נשאר “לא נמדד”, incoming אינו מנוכה |
| המלצת ספק / חיסכון / הצעת רכש | `IMPLEMENTED_EXPLAIN_ONLY` | `get_purchase_comparison` מעל `0203`, מייבא את `compareLine`/`summarizeComparison` מ-`src/lib/orderComparison.ts` כדי שלא תהיה נוסחה שנייה; מחזיר breach במקום להעלות כמות, ואינו כותב PO (‏#109/#182) |
| טיוטת הזמנת רכש | `BLOCKED_DECISION #109/#182/#190` | state machine קיים; composer ופקודת draft בטוחה אינם קיימים |
| טיוטת דרישת תשלום | `BLOCKED_DECISION #182` | `create_payment_request` מועמד בלבד; אין composer/revalidation/idempotency מחוברים |
| תזכורת לספק | `IMPLEMENTED_DRAFT_ONLY` | `draft_supplier_reminder` מחזיר עובדות בלבד; הגוף נכתב כבלוק `draft` שתוויתו קבוע של המוצר, ספרותיו מוצמדות לערכי עובדות, ו-`נשלח` נדחה. owner/office בלבד. אין external-message capability, ו-`check:assistant-no-send` שומר על כך |
| עזרה על המוצר מ-metadata | `IMPLEMENTED_REGISTRY_ONLY` | `get_product_help` מעל `src/lib/assistant/productHelpRegistry.ts`; ‏route הוא מפתח של `APP_ROUTE_POLICY`, תפקידי רשומה מצרים ולא מרחיבים, עברית היא locale הבסיס, ואין fallback — שאלה שאין לה רשומה נענית `no_capability` |
| חיפוש ישות וניווט | `IMPLEMENTED_LOCATOR_ONLY` | `find_entity`; type/route allowlist ו-current-role validation |
| סיכום/התראות/חשיפת תשלום | `IMPLEMENTED_WITH_NAMED_PARTIALS` | שלושת הכלים מחזירים failures וכיסוי; אין “אפס” במקום נתון שלא נמדד |
| read tools / external sending / live evaluation switches | `BLOCKED_DECISION #193` | UI כרוך ב-read tools; שתי האחרות אינן פעילות ואינן מוצגות כיכולת קיימת |

**הערת קנון שתוקנה בקוד ובכלי יחד:** ‏`0099` הוסיף שורות חשבונית, ולכן ההתראה על עליית מחיר
אומרת כעת שהסריקה בודקת **את המחירון בלבד** ושמחירי שורות החשבונית אינם חלק ממנה; היא אינה טוענת
עוד שאין שורות. לעומת זאת מגבלת מועד הפירעון עדיין נכונה: לחשבוניות אין `due_date`, ו-
`suppliers.payment_terms` הוא טקסט חופשי שאיש אינו מנתח. **אין תקציב בסכימה** — "חריגה מתקציב"
היא קלט עסקי, לא נגזרת.

---

## 8. הכרעות ארכיטקטורה

1. **תשובה שלמה, לא זרימה.** בלקוח אין ולו צרכן `EventSource`/`ReadableStream` אחד, ואין דפוס
   נגישות לטקסט שמגיע בהדרגה. זרימה הייתה מחייבת להמציא גם תעבורה וגם דפוס הכרזה לקורא מסך.
2. **קובץ חוזים אחד, שני זמני ריצה.** ‏`zod` כבר תלות של הלקוח, ולכן `src/lib/assistant/contracts.ts`
   מיובא גם מהדפדפן וגם מה-Edge. עותק שני היה סוטה בשינוי הסכימה הראשון.
3. **הסיכום העסקי מקבל מודל קריאה אחד ב-SQL.** ‏`p2_business_summary_rows()` משרת גם את
   `buildSummary()` וגם את הכלי — לא שכפול, לא בדיקת parity על שתי מימושים.
4. **אין step-up auth בגלל שהפעולה הגיעה מהעוזר.** ההצדקה ב-`0061` היא רגישות הפעולה, לא זהות
   היוזם. פעולה מאושרת רצה עם ההרשאות, האימות והביקורת של הפקודה הקיימת — לא פחות, ולא מסלול אחר.
5. **העוזר אינו מבצע. הוא מנסח.** הצעה עוברת `draft → awaiting_confirmation → confirmed → executed`,
   והביצוע הוא קריאה לפקודת המוצר הקיימת עם ה-JWT של האדם שאישר.

---

## 9. הצעות לפעולה — מה נבנה, ומה במכוון לא

**המנגנון בנוי ונאכף במסד:** טבלת ההצעות, מכונת המצבים כטריגר (מעבר שאינו ב-`PROPOSAL_TRANSITIONS`
נדחה במסד ולא רק ב-TypeScript), עמודות זהות בלתי-משתנות אחרי היצירה, פקודות אישור/דחייה/רישום-תוצאה,
מדיניות `assistant.confirmed_actions` כבויה בבסיס, וחוזה `AssistantProposal` שהממשק יודע לרנדר.

**מה שלא נבנה: אף מנסח הצעה אחד.** לא מפני שקשה, אלא מפני ש**איזו פקודה מותר להציע היא הכרעה
עסקית שאיש לא קיבל** (`OPEN-DECISIONS #182`), והמפרט עצמו אוסר לחשוף יכולת שאין מאחוריה זרימת שרת
מוכרעת. שלוש עובדות שמחדדות למה עצירה כאן היא התשובה הנכונה ולא עצלות:

- ‏`OPEN-DECISIONS #109(ד1)` אוסר במפורש על המודל לכתוב `purchase_orders` ו-`purchase_order_items` —
  כתיבה שם משכתבת היסטוריית מחירי snapshot. כלומר "צור טיוטת הזמנה" מהמפרט **חסום בהכרעה קיימת**.
- "נסח תזכורת לספק" אינה פעולה כלל: אין במוצר פקודת שליחה לספק. זו תשובה שאדם מעתיק, לא הצעה.
- נשארת `create_payment_request` כמטרה היחידה הסבירה — והיא פקודה כספית. להצמיד אליה מנסח לפני
  שהבעלים אמר שהוא רוצה זאת פירושו לבנות דרך חדשה אל הכסף על סמך ניחוש.

**מה שיידרש כשההכרעה תתקבל:** קריאה ל-`assistant_confirmed_actions_enabled()` בהרכבת ההקשר,
מנסח אחד לפקודה שתיבחר שמייצר `payload` שהשרת מאמת **לפני** שההצעה מוצגת, ו-`expires_at` מתוך
`PROPOSAL_TTL_MINUTES`. הביצוע נשאר כפי שהוא כתוב כאן: הפקודה הקיימת, עם ה-JWT של מי שאישר,
עם האימות והביקורת שלה — לא מסלול שני.

---

## 10. מצב UI/UX — חלופה B אושרה ומומשה מקומית

תוכנית הסגירה הקנונית נמצאת ב־
`C:\Users\art1\Desktop\PLAN-INPLACE-ASSISTANT-UI-UX-CLOSURE-20260820.md`.
היא נכתבה ב־20.08.2026 לאחר ביקורת Skeptic, ‏Constraint Guardian ו־User Advocate. לאחר הצגת
שני prototypes זהים בתוכן, בעל המוצר אישר במפורש את **חלופה B**: פאנל docked ו־non-modal
מ־1024px, ומסך מלא מתחתיו. אין באישור ה־UI אישור activation או Production.

**זהות:** שם המוצר הוא `InPlace`; ‏`Place Bay` הוא שם כיוון הסמל בלבד. ‏`brand/identity.md`,
‏`brand/brand.yaml` ו־`src/lib/branding.ts` גוברים לשם ולזהות. aliases ומזהי מכונה היסטוריים
יכולים להישאר `supplyflow-*`; אין להסיק מהם שם מוצר מוצג.

**מצב מקומי נוכחי:** ה־trigger הוא פקד בדיקה תפעולי עם תווית גלויה בדסקטופ; השאלה, `as_of`,
freshness, partial ו־null נשארים גלויים; שמות tools הוחלפו בתוויות מוצר; source route עובר את
מטריצת התפקיד. בדסקטופ המקור נפתח לצד הפאנל והמסך הראשי שומר 27.5rem עבורו; במובייל המקור נפתח
במסך המוצר וטריגר “חזרה לבדיקה” משחזר את אותו run ואת focus.

History אינה קוראת עוד `assistant_conversations` ישירות. ‏`0170` מוסיפה שני RPCs service-only:
רשימת candidate ids/dates ו־snapshot מובנה עם actor, ‏Facts, ‏Sources, tools, completeness ו־freshness.
ה־Edge מחזיר title/date/question/answer רק לאחר reauthorization נוכחי; cache key כולל fingerprint
של actor/org/role/lifecycle, ותוצאה שהחלה לפני שינוי הרשאה נזרקת גם אם הסתיימה אחריו.

**שני שערים:**

- `CORE_READ_ONLY_UI_CLOSED` דורש brief מאושר, question/evidence/freshness, routes לפי role,
  runtime response validation, responsive/RTL/WCAG ו־CI על SHA מדויק.
- `FULL_UI_CLOSED` דורש בנוסף history שנפתחת רק אחרי reauthorization/redaction נוכחיים, עם
  negative tests ל־role downgrade, disabled user, suspended org, deleted source ושינוי הרשאה.

**ראיה מקומית טרייה:** 15/15 תרחישי Playwright על production components עברו בשלושת התפקידים
וב־390/768/1023/1024/1440, עם 40 screenshots, ‏0 console errors, ‏0 overflow, יעדי מגע 44px,
focus/return path, source side-by-side, history open וניגודיות מינימלית 6.64:1. ‏`p61` עבר מול
המסד המקומי לאחר `0170`; flags הודלקו רק ל־QA והוחזרו ל־off דרך הפקודה המבוקרת.

הסטטוס הוא `LOCAL_IMPLEMENTED / OWNER_APPROVED_B / CI_PENDING / NOT_ACTIVATED / NOT_DEPLOYED`.
`CORE_READ_ONLY_UI_CLOSED` ו־`FULL_UI_CLOSED` ייטענו רק אחרי commit, PR ו־required checks ירוקים
על SHA יחיד. ‏Action composer, draft/confirmed actions ו־external sending נשארים מחוץ ל־UI
לקריאה בלבד ואינם מקבלים placeholder.

---

## 11. Workstream handoff

| workstream | בעלות וקבצים | חוזה שנמסר | בדיקות וראיות | תלות/חסם |
|---|---|---|---|---|
| 1. Contracts ו־client boundary | `contracts.ts`, ‏`client.ts`, ‏`errorCodes.ts` | Zod strict ל־ask/run/history; 2xx פגום נכשל סגור | `client.spec.ts`, ‏typecheck | שינוי wire דורש Edge+client באותו commit |
| 2. Actor, flags ומכסה | `auth.ts`, ‏`flags.ts`, ‏`runSession.ts` | actor נפתר בכל שימוש; flags exposure בלבד; fingerprint מנקה זיכרון/cache | auth/flags/component negative tests | מכסה עסקית #180 חוסמת activation |
| 3. Read tools ו־capability map | `tools/*`, ‏§7 | 17 כלים allowlisted, projection מפורש ו־server calculation owner | tools/reads/business/readmodels suites | #189–#192 מומשו ב-24.08.2026; ‏#193 נשאר: אין מתג כתיבה או שליחה, כי היכולת אינה קיימת |
| 4. Provider ו־egress | `provider.ts`, ‏`egress.ts`, ‏`0166` | server-only provider, lease מסוג `assistant`, אין fallback ספק | provider/egress, ‏`p58` | ממשל #179 ומחיר #183 חוסמים activation |
| 5. Validation ו־evidence authorization | `validate.ts`, ‏`evidence-authorization.ts` | semantic claim + source/route/current actor reauthorization | deleted/hidden/tenant/role/scope negative tests | כשל מסיר תשובה שלמה, לא ממציא redaction |
| 6. Persistence, deletion ו־retention | `0164`, ‏`history.ts`, ‏§6 | 90 יום history, ‏30 יום proposal לא־מבוצע, delete עצמי מבוקר | `p56`, history Deno tests | backup/provider deletion נשאר ממשל #179/#181 |
| 7. Core/history UI | `AssistantPanel`, ‏`AssistantDialog`, ‏`AnswerView`, ‏`0170` | B docked/full-screen; source return; Edge-only authorized history | 15 browser cases, component/client tests, ‏`p61` | CI ו־review על SHA משולב טרם בוצעו |
| 8. Deterministic summary parity | `summary.ts`, ‏`0165` | הסיכום הקיים נשאר זמין כשהעוזר כבוי או נכשל | `p57`, summary tests | אין תלות בספק או בדגל assistant |
| 9. Evaluation, cost ו־governance | `evaluation.ts`, ‏`live-evaluation.ts`, ‏§4 | corpus סינתטי offline; live דורש שני opt-ins; cost נשאר null | evaluation/live gate tests | אין live call; #179/#183/#193 פתוחים |
| 10. Release evidence | `docs/PROGRESS.md`, PR/CI | merge, activation ו־rollout הם שלושה מצבים נפרדים | exact SHA, remote parity, required checks | אין deploy/activation במסגרת ה־PR הזה |
