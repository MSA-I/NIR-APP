# ראיות הפעלה — ממשל ספק המודל של העוזר

> **הכלל העומד: כל שורה שאינה `VERIFIED` ⇒ ההפעלה נדחית.**
> אין שורה "כמעט", אין שורה "בטיפול", ואין ויתור זמני לצורך הדגמה. שער שנפתח עם ארבע שורות מתוך
> חמש אינו שער.

מסמך זה הוא **התבנית והיומן** של `OPEN-DECISIONS #179`. הוא אינו מתאר את הקוד — הקוד הוא
`supabase/functions/assistant/governance.ts`, והמסמך הוא המקום שבו **אדם חותם** על מה שקרא.
המסמך אינו מייצר הרשאה: הוא מתעד ראיה, והקוד הוא זה שמסרב.

`#179` (הוכרע 21.08.2026, בעלים) קובע חמש שורות חובה: **שימוש באימון · שימור · לוגים אצל הספק ·
DPA · אזור נתונים** — כולן ל-OpenAI, שהוא ספק המודל היחיד (#124). ‏`standard retention` מותר
בגילוי נאות; **`zero retention` לעולם אינו מובטח בלי חוזה שמוכיח אותו**. אם ה-DPA או תנאי חובה
אחר אינם זמינים — העוזר נשאר כבוי. **אין ספק גיבוי**: כשל ספק מחזיר את המשתמש למסלול הדטרמיניסטי
(`/alerts` והמסכים), לעולם לא לספק שני.

---

## 1. חמש שורות החובה

מצב נכון ל-**25.08.2026**. ארבע שורות `VERIFIED` (נשלפו מהמקורות הרשמיים של OpenAI ב-24.08),
שורה אחת (`dpa`) `MISSING` — ולכן **ההפעלה עדיין נדחית.**

> **מה השתנה ב-25.08.2026, וזו הבחנה שמשנה את המשמעות של השורה החסרה.** עד אז נרשם כאן שהבעלים
> *בחר* לדחות חתימה זמינה. זה לא היה מדויק, והבעלים תיקן: **אין מי שיחתום.** ‏DPA נכרת בין
> **ישות משפטית** לבין `OpenAI OpCo, LLC`, וחברה טרם נרשמה — כלומר אין צד מתקשר. החתימה נקבעה
> **לזמן ההשקה**, כשהחברה קיימת, ולפני הדייר הראשון.
>
> **הבעלים גם הורה להפעיל את העוזר בייצור.** ‏**ההוראה אינה מיושמת, ואסור שתיושם בכתיבת
> `VERIFIED` בשורת `dpa`.** ‏`VERIFIED` הוא טענה על חוזה קיים; לרשום אותו בהיעדר חוזה הוא בדיוק
> מה שהמסמך הזה קיים כדי למנוע, והוא היה זולג משם ל-`/privacy` ול-`/terms` שנגזרים מאותן שורות.
> ההוראה ממתינה למשטח חריג מפורש בקוד השער — מוגבל לפני ההשקה, לארגון של הבעלים בלבד, נרשם
> ב-`audit_logs` ונסגר ברגע שקיים דייר. **הכלל העומד בראש המסמך לא זז:** שער שנפתח עם ארבע
> שורות מתוך חמש אינו שער, וגם „הכרעת בעלים" אינה שורת ראיה.

| שורה | תביעה (claim) | מקור רשמי מתוארך | תאריך שליפה | מי אימת | סטטוס |
|---|---|---|---|---|---|
| `training_use` | `no_training_on_api_data_by_default_opt_in_available` | `https://developers.openai.com/api/docs/guides/your-data` · `https://help.openai.com/en/articles/5722486-how-your-data-is-used-to-improve-model-performance` | 2026-08-24 | Claude (סוכן מחקר), ציטוטים אומתו שנית ב-`curl` על ידי הסוכן הראשי | `VERIFIED` |
| `retention` | `retention_up_to_30_days_default` | `https://openai.com/enterprise-privacy/` (Updated: January 8, 2026) | 2026-08-24 | כנ״ל | `VERIFIED` |
| `provider_logs` | `abuse_logs_30_days_employees_and_third_party_contractors` | `https://developers.openai.com/api/docs/guides/your-data` · `https://openai.com/enterprise-privacy/` | 2026-08-24 | כנ״ל | `VERIFIED` |
| `dpa` | `dpa_self_serve_form_via_ironclad_clickthrough` — **התהליך** מתועד; **החתימה אינה אפשרית היום: אין ישות משפטית שתתקשר** (בעלים, 25.08.2026), ונקבעה לזמן ההשקה לפני הדייר הראשון. חוב: `DEBT-REGISTER §63` | `https://openai.com/policies/data-processing-addendum/` (Effective: January 1, 2026) · טופס: `https://ironcladapp.com/public-launch/63ffefa2bed6885f4536d0fe` | 2026-08-24 | — | `MISSING` (אין צד מתקשר) |
| `data_region` | `no_data_residency_configured_unrestricted_processing` | `https://developers.openai.com/api/docs/guides/your-data` | 2026-08-24 | כנ״ל | `VERIFIED` |

### מה שנצפה בחשבון עצמו (בעלים, 24.08.2026)

התנאים הפומביים אומרים מה **מותר** לספק לעשות. אלה שלוש עובדות על **החשבון שלנו**, שאין דרך
לחקור אותן מבחוץ ורק בעל החשבון יכול לראות. הן נרשמות כאן כתצפית של אדם, לא כתוצאת מחקר.

| מה נבדק | היכן | מה נמצא | מה זה אומר |
|---|---|---|---|
| שיתוף נתונים לאימון | ‏`Settings → Organization → Data controls` | **מכובה** | ברירת המחדל של הספק לא שונתה. הטענה בדף הפרטיות — „המפעילה לא בחרה בכך" — **נכונה ונצפתה**, ולא רק הוסקה מברירת מחדל |
| טאב `Data Retention` | ‏`platform.openai.com/settings/organization/data-controls/data-retention` | **קיים** | לפי תיעוד הספק הטאב מופיע רק לארגון ש**אושר** לבקרות שימור. ראה ההערה למטה — זו הסקה מתיעוד, לא תצפית ישירה על מכתב אישור |
| בקרת השימור עצמה | אותו מסך | **מכובה** | **לא הופעל ZDR ולא MAM.** כלומר עלינו חל שימור ברירת המחדל של עד 30 יום — בדיוק מה שדף הפרטיות אומר |

**מה שהתצפית הזו סוגרת:** אין פער בין מה שהדף אומר למה שקורה. הדף מתאר שימור של עד 30 יום
ואינו מבטיח אפס-שימור — וזה בדיוק מצב החשבון. **אילו הבקרה הייתה דלוקה, הדף היה מספר על
המשתמש פחות ממה שנכון**, וזו הייתה טעות בכיוון ההפוך — פחות מסוכנת, אך עדיין אי-דיוק.

**שאלה פתוחה שאינה חוסמת:** קיום הטאב מרמז, לפי תיעוד הספק, על אישור קיים לבקרות שימור. לא
נבדק מה הטאב **מציע** בפועל (אפשרויות לבחירה מול הפניה למכירות), ולכן `#179` אינו מסתמך על כך
בשום שורה. אין לכך משמעות כל עוד הבקרה מכובה: התוצאה זהה. אם אי-פעם תישקל הפעלת ZDR — **זו
נקודת הפתיחה לבדוק**, ולא הנחה שאפשר לצאת ממנה.

### הציטוטים המכריעים, מילה במילה

הציטוטים נשמרים באנגלית בכוונה: זהו נוסח משפטי, ותרגום הופך ראיה לפרשנות.

- **`training_use`** — „As of March 1, 2023, data sent to the OpenAI API is not used to train or
  improve OpenAI models (unless you explicitly opt in to share data with us)."
  ובעמוד העזרה: „Unless they explicitly opt-in, organizations are opted out of data-sharing by
  default."
- **`retention`** — „OpenAI may securely retain API inputs and outputs for up to 30 days to
  provide the services and to identify abuse. After 30 days, API inputs and outputs are removed
  from our systems, unless we are legally required to retain them."
- **`provider_logs`** — „By default, abuse monitoring logs are generated for all API feature
  usage and retained for up to 30 days, unless longer retention is required by law, or is
  reasonably necessary to protect our services or any third party from harm."
  ומי קורא אותם: „(1) authorized employees … and (2) specialized third-party contractors who are
  bound by confidentiality and security obligations, solely to review for abuse and misuse."
- **`dpa`** — „Yes, we are able to execute a Data Processing Addendum (DPA) with customers … Please
  complete our DPA form to execute a DPA with OpenAI."
- **`data_region`** — „Contact our sales team to see if you're eligible for using data residency
  controls." · „To use data residency with any region other than the United States, you must be
  approved for abuse monitoring controls, and execute a Modified Retention amendment."

### מה שהמחקר מצא ומשנה את מה שמותר לכתוב ללקוח

1. **אפס-שימור אינו זמין בלי הסכם נפרד.** ‏„Currently, these controls are subject to prior
   approval by OpenAI and acceptance of additional requirements." הכרעת `#179` — שאין להבטיח
   אפס-שימור בלי חוזה שמוכיח אותו — **נכונה ונתמכת ישירות**. וגם ZDR מאושר אינו מוחלט: סריקת
   CSAM, ‏„Eyes Off" ו-„Safety Retention" הן שלוש הסתייגויות כתובות שמחזירות תוכן ללוגים.
2. **`store: false` הוא מתג שליפה, לא ערובת שימור.** ההגדרה המלאה בתיעוד ה-API היא
   „Whether to store the generated model response for later retrieval via API." לוגי ניטור
   ההתעללות נוצרים בכל מקרה — ‏„generated for all API feature usage". הכיוון אף הפוך מהאינטואיציה:
   ‏„When Zero Data Retention is enabled for an organization, the store parameter will always be
   treated as false" — ‏ZDR כופה את הפרמטר, לא הפרמטר משיג ZDR. **הניסוח „שלחנו `store:false`
   ולכן שום דבר לא נשמר" הוא הבטחה כוזבת.**
3. **קבלני צד-שלישי קוראים תוכן.** לא רק עובדי OpenAI. גילוי נאות חייב לומר זאת.
4. **ה-DPA הנוכחי (1.1.2026) אינו מכיל סעיף שימור של 30 יום.** סעיף 3.3 מטיל את הגדרות השימור
   על הלקוח. סעיף 30 היום חי ב-FAQ ובתיעוד — מסמכים שהספק רשאי לשנות חד-צדדית — **ולא בחוזה.**
   אין לצטט את ה-DPA כמקור למגבלת 30 היום. (נוסח „maximum of thirty (30) days" ששרד בתוצאות
   חיפוש שייך ל-DPA המבוטל מ-2.2024.)
5. **אחסון אזורי אינו עיבוד אזורי.** מתוך עשר האזורים הנתמכים, **בשבעה** `Processing: No` —
   הנתונים במנוחה נשארים, ההסקה יוצאת. עיבוד באיחוד האירופי מותנה מראש באישור ZDR/MAM. ‏**ישראל
   אינה ברשימת האזורים כלל.** ובלי הגדרה כלשהי — וזה מצבנו — ברירת המחדל היא בלתי-מוגבלת.
6. **מה שמוגדר כ-„system data" יוצא מהאזור בכל מקרה**, וכולל **`structured output schema`** —
   כלומר סכימת ה-JSON שמתארת את אובייקטי העסק שלנו.

### למה `dpa` נשארת `MISSING`, ומה בדיוק צריך כדי לסגור אותה

התהליך מתועד ואומת: ‏OpenAI מציעה DPA ל-API, החתימה היא click-through דרך טופס **Ironclad**
(צד שלישי, לא דומיין של OpenAI), ולקוח באזור הכלכלי האירופי מתקשר מול `OpenAI Ireland Ltd.`
ואחרת מול `OpenAI OpCo, LLC`.

**מה שאיש לא יכול לחקור:** האם **החשבון הזה** חתם. זו עובדה על החשבון ולא על התנאים הפומביים,
ואין עמוד בעולם שיענה עליה. היא חייבת להיקבע על ידי מי שיש לו גישה להגדרות הארגון ב-OpenAI,
ולהירשם כאן כעובדה שאושרה על ידי הבעלים — **לא כעובדה שנחקרה**.

### מה שלא ניתן היה לשלוף, ונשאר לא-נענה

- ‏`trust.openai.com` החזיר 403 מאחורי Cloudflare בכל ניסיון. **אף שורה בדוח הזה אינה מסתמכת
  עליו.**
- שם יחידה ארגונית שקוראת את הלוגים. העמודים אומרים „authorized employees" ו-„specialized
  third-party contractors" בלבד.
- ערך ברירת המחדל המתועד של `store`. התיעוד מתאר את ההתנהגות ואינו נוקב בערך.

---

## 2. איך ממלאים שורה

1. פותחים את המקור **הרשמי של הספק** (לא סיכום, לא בלוג, לא תשובת תמיכה בעל-פה).
2. רושמים בטבלה: את התביעה כטוקן קצר ויציב, את ה-URL המלא, את **תאריך השליפה** בפועל, ואת שם
   מי שקרא. "מי אימת" אינו תפקיד גנרי — זה שם.
3. אם המקור סותר תביעה קיימת: הסטטוס הוא `CONTRADICTED`, לא `MISSING`. ההבדל חשוב — `MISSING`
   אומר "לא בדקנו", ‏`CONTRADICTED` אומר "בדקנו והתשובה שלילית", ורק אחת מהן מסתיימת בהמתנה.
4. שורה שמסתמכת על חוזה (בעיקר `zero_retention` ו-DPA) חייבת **הפניה לחוזה**: מזהה, לא תיאור.
5. מוסיפים שורה ליומן האימות (§5) — כולל אימות חוזר של שורה שכבר נבדקה.

**תוקף בזמן.** תאריך השליפה נרשם ואינו נבדק מול שעון בקוד — שער שמשתנה לבד עם הזמן היה מכבה
ייצור בלי שאיש נגע בו. **הרעננות היא באחריות אדם**: תנאי ספק משתנים, ושורה משנה שעברה היא ראיה
ישנה גם כשהסטטוס עדיין `VERIFIED`. בכל שינוי מהותי בתנאי הספק — בודקים מחדש ומעדכנים כאן.

---

## 3. הצורה בתצורה — איך הראיה מגיעה לקוד

חמישה סודות של פונקציית ה-Edge (‏`GOVERNANCE_ENV_VARS` ב-`governance.ts`). **אינם נכנסים ל-Git.**

| שורה | משתנה |
|---|---|
| `training_use` | `AI_ASSISTANT_GOVERNANCE_TRAINING_USE` |
| `retention` | `AI_ASSISTANT_GOVERNANCE_RETENTION` |
| `provider_logs` | `AI_ASSISTANT_GOVERNANCE_PROVIDER_LOGS` |
| `dpa` | `AI_ASSISTANT_GOVERNANCE_DPA` |
| `data_region` | `AI_ASSISTANT_GOVERNANCE_DATA_REGION` |

הפורמט של כל ערך:

```
status=VERIFIED;claim=<טוקן>;source=https://…;retrieved=YYYY-MM-DD;verifier=<שם>[;contract=<מזהה>]
```

**הדוגמה הבאה היא המחשה של הפורמט בלבד ואינה ראיה על אף ספק:**

```
status=VERIFIED;claim=example_claim;source=https://example.invalid/policy;retrieved=2026-08-24;verifier=example-name
```

מה נדחה, ולמה: ‏`source` שאינו `https` (ראיה שניתן לשכתב בדרך אינה ראיה) · תאריך שאינו
`YYYY-MM-DD` · שדה שמולא ב-`tbd`/`none`/`unknown` וכיוצא בהם (מציין-מקום שנראה כמו תשובה) ·
שם שדה שגוי (ערך שנשמט בשקט הוא שער שהפסיק לבדוק) · ‏`claim=zero_retention` בלי `contract`.

---

## 4. מה קורה כשהשער סגור

- ‏`parseAssistantConfig` מסרב לפני הדגם ולפני שאר הכוונונים; ‏`index.ts` מחזיר
  `assistant_provider_unavailable` (503) ורושם ללוג את שמות השורות החסרות.
- הנוסח למשתמש כבר קיים ואינו מבטיח דבר: **"העוזר אינו זמין כרגע. הנתונים עצמם זמינים במסכים."**
  זה בדיוק ה-fallback של `#179` — המסכים והסיכום הדטרמיניסטי ממשיכים לעבוד בלי מודל.
- **אין ניסיון שני ואין ספק שני.** סירוב אינו אזהרה רכה, ואינו סיבה לנסות משהו אחר.
- הסירוב מנוסח בלי לנקוב בשם ספק חלופי — הודעת סירוב שמזכירה ספק אחר נקראת כהמלצה.

---

## 5. יומן אימות

| תאריך | שורה | פעולה | תוצאה | מי |
|---|---|---|---|---|
| 24.08.2026 | כל חמש | הקמת התבנית; חיפוש ראיה בריפו | אין בריפו מקור רשמי מתוארך לאף שורה — כולן `MISSING`, ההפעלה נדחית | סוכן ממשל (בסקירת בעלים) |
| 24.08.2026 | `training_use`, `retention`, `provider_logs`, `data_region` | שליפה מהמקורות הרשמיים של OpenAI לבקשת הבעלים | ארבע השורות `VERIFIED` עם URL, תאריך שליפה וציטוט מילולי | סוכן מחקר; חמישה ציטוטים מכריעים אומתו שנית ב-`curl` בלתי-תלוי על ידי הסוכן הראשי |
| 24.08.2026 | `dpa` | שליפה מהמקורות הרשמיים | **התהליך** אומת (טופס Ironclad, ‏click-through, ישות מתקשרת לפי אזור); **החתימה בפועל בחשבון אינה ניתנת למחקר** ונשארת `MISSING` | כנ״ל |
| 24.08.2026 | — | ניסיון גישה ל-`trust.openai.com` | ‏403 מאחורי Cloudflare; **אף שורה אינה נשענת עליו** | כנ״ל |
| 24.08.2026 | `dpa` | הכרעת בעלים | **החתימה נדחית ונרשמת כחוב** (`DEBT §63`). דחייה מאושרת אינה פותחת את השער: `#179` מותיר את העוזר כבוי כשה-DPA אינו זמין, והקוד אוכף זאת | בעלים |
| 24.08.2026 | `training_use`, `retention` | תצפית בעלים בחשבון עצמו | שיתוף לאימון **מכובה**; טאב `Data Retention` **קיים** אך הבקרה **מכובה** — כלומר שימור ברירת המחדל של עד 30 יום חל עלינו, כפי שדף הפרטיות אומר | בעלים |
| 24.08.2026 | — | הרצה חיה **מקומית** מקצה לקצה, אחרי תיקון עשר סכמות הכלים שהחזירו `invalid_function_parameters` | ‏**הזרימה עובדת**: שש קריאות Edge ב-200, שתי תשובות עם כרטיסי ראיות (זיכויים פתוחים, חשבוניות ממתינות), ושרשור ששרד ריענון. ראיות: `NIR-APP-DOCS/release-evidence/20260824-assistant-local/`. **מקומי בלבד — ייצור מעולם לא קרא לספק** | סוכן, בבקשת הבעלים |
| 25.08.2026 | `dpa` | תיקון בעלים לרישום מ-24.08 | ‏**„נדחה" הוחלף ב-„אין מי שיחתום"**: אין ישות משפטית שתתקשר מול `OpenAI OpCo, LLC`. החתימה נקבעה לזמן ההשקה, לפני הדייר הראשון. השורה נשארת `MISSING` — הסיבה השתנתה, הסטטוס לא | בעלים |
| 25.08.2026 | — | הוראת בעלים: להפעיל את העוזר בייצור | ‏**לא בוצע, וזה מתועד ולא מוסתר.** השער דורש `VERIFIED` בכל חמש; ‏`dpa` אינה, ואסור לסמנה ככזו — זו תהיה הצהרה כוזבת שזולגת ל-`/privacy` ול-`/terms`. ההוראה ממתינה למשטח חריג מפורש בקוד (לפני-השקה · ארגון הבעלים בלבד · נרשם ב-`audit_logs` · נסגר עם הדייר הראשון), שטרם נכתב | בעלים · סוכן |

---

## 6. מה אסור להבטיח, גם כשהשער ייפתח

- **‏`zero retention` בלי חוזה** — ‏`#179`. גם `store: false` אינו זה.
- **זמינות מספרית או SLA** — ‏`#205`: השקה גלובלית ללא SLA חוזי וללא uptime מספרי לפחות בששת
  חודשי המדידה הראשונים. אין להוסיף אחוז זמינות ל-`/terms`, ל-`/privacy` או לשיווק.
- **מחיקה אצל הספק כתוצאה ממחיקת שיחה** — הטיהור מוחק מהמסד החי (`ASSISTANT.md §6`); הוא אינו
  טוען דבר על הספק.
- **ספק גיבוי** — לא קיים, ואין להציג אותו כתוכנית המשכיות.

### ומה שחייב **להיאמר** לפני ההפעלה, לפי מה שנשלף ב-24.08

הרשימה למעלה היא מה שאסור להבטיח. אלה שלושה דברים שאסור **להשמיט**, כי הם ההפרש בין גילוי נאות
לבין חצי אמת:

1. **בני אדם שאינם עובדי הספק רשאים לקרוא תוכן.** ‏„specialized third-party contractors …
   solely to review for abuse and misuse". גילוי שאומר רק „הספק" מחמיץ את זה.
2. **שימור של עד 30 יום הוא ברירת המחדל שלנו**, ולא אפס — עם שתי הארכות פתוחות בנוסח הספק
   („required by law" · „reasonably necessary to protect our services or any third party from
   harm"). ‏`store: false` אינו משנה זאת.
3. **אין אצלנו הגדרת אזור.** ברירת המחדל בלתי-מוגבלת; ישראל אינה אזור נתמך כלל; ואפילו אילו
   הוגדר אזור — אחסון אזורי אינו עיבוד אזורי בשבעה מתוך עשרה אזורים, ו-`structured output schema`
   מסווג `system data` ויוצא מהאזור בכל מקרה.

**קשור:** `docs/ASSISTANT.md §4` (ממשל הספק) · `docs/OPEN-DECISIONS.md` שורות #179, ‏#124, ‏#182,
‏#191, ‏#193, ‏#205 · `supabase/functions/assistant/governance.ts` ·
`supabase/functions/assistant/governance.test.ts`.
