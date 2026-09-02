# נתיב הרשאות מקומי

**עודכן 24.08.2026 — מפתחות ה־API רוכזו לתיקייה אחת מחוץ לריפו:**
`D:\משה פרוייקטים\פיתוח אתרים\AI\API\`

| מפתח | קובץ |
|---|---|
| ‏Supabase Management | `AI\API\NIR-TOKEN-SUPABASE.txt` |
| ‏Resend — שליחה בלבד | `AI\API\Resend api.txt` (זהו גם ה־SMTP password של Supabase Auth) |
| ‏Resend — גישה מלאה | `AI\API\RESEND-Full.txt` (ניהול דומיינים; אין להשתמש בו לשליחה) |
| ‏Cloudflare — ‏DNS/‏Zone | `AI\API\CF-TOKEN-DOMAINS.txt` |
| ‏OpenAI — **העוזר בלבד** | `AI\API\NIR-API-OPENAI-ASSISTENS.txt` → הסוד `AI_ASSISTANT_API_KEY` |
| ‏OpenAI — פירוש מסמכים ו-OCR | `AI\API\NIR-API-OPENAI.txt` → הסוד `OPENAI_API_KEY` |
| ‏Mistral — מנוע OCR חלופי | `AI\API\NIR-AP-MISTRAL.txt` → `MISTRAL_API_KEY` ב-`ocr.env` של ה-VPS |
| ‏טוקן ה-worker (**אינו מפתח ספק**) | `AI\API\NIR-OCR-WORKER-TOKEN.txt` → `OCR_WORKER_TOKEN` |
| ‏Paddle **Sandbox** — מפתח שרת | `AI\API\Sandbox API Key.txt` → הסוד `PADDLE_API_KEY` |
| ‏Paddle **Sandbox** — טוקן לקוח | `AI\API\InPlace Sandbox Web.txt` → `VITE_PADDLE_CLIENT_TOKEN` |
| ‏VPS — מפתח SSH (**מוצפן ב-passphrase**) | `NIR-APP-DOCS\SSH\id_ed25519` · ה-passphrase ב-`NIR-APP-DOCS\passphrase for key.txt` · host `95.217.134.162` · user `root`. איך מתחברים ומלכודת ה-`BatchMode`: `docs/VPS-DEPLOYMENT-GUIDE.md` §2 |

## שני מפתחות Paddle, ורק אחד מהם מותר בדפדפן (31.08.2026)

ההבחנה הזו היא כל מנגנון ההגנה, ושני השמות דומים מספיק כדי להתבלבל בחיפזון:

| קובץ | תחילית | מה הוא יכול | איפה מותר |
|---|---|---|---|
| `Sandbox API Key.txt` | `pdl_sdbx_apikey_…` | הכול: לקוחות, מנויים, **החזרים** | סוד של Edge Function בלבד |
| `InPlace Sandbox Web.txt` | `test_…` | לפתוח checkout לעסקה שהשרת כבר יצר, ותו לא | ‏bundle של הדפדפן |

‏**אסור ליצור משתנה `VITE_` שנושא את מפתח השרת.** ‏Vite מטמיע כל משתנה בתחילית `VITE_` ב-bundle,
ולכן שורה אחת כזו מפרסמת לכל מבקר מפתח שיכול להחזיר כסף — ושום דבר בבנייה לא ייראה שונה.
‏`scripts/check-paddle-secrets.mjs` מפיל את הבנייה על כך, והוא נבדק עם ניסוי שלילי ולא רק נכתב.

שני הקבצים הם **Sandbox בלבד**. אין בתיקייה מפתחות Paddle Live ואין להוסיף אותם כאן.
סוד ה-webhook (`pdl_ntfset_…`) נוצר מחדש בכל רישום יעד ואינו נשמר — ראו `docs/PADDLE-SANDBOX.md`.

## הפרדת עלויות בין העוזר לעיבוד המסמכים (26.08.2026)

עד 26.08.2026 ‏`AI_ASSISTANT_API_KEY` ו-`OPENAI_API_KEY` בייצור נשאו **את אותו מפתח בדיוק**
(נמדד: אותו digest ב-`GET /v1/projects/{ref}/secrets`). המשתנים היו נפרדים, החשבון לא — ולכן
לא היה אפשר לדעת כמה עולה העוזר וכמה עולה עיבוד המסמכים.

**מה שהופרד:** ‏`AI_ASSISTANT_API_KEY` מצביע עכשיו על מפתח ייעודי משלו. ‏`OPENAI_API_KEY` לא
נגע. אימות: שני ה-digests שונים, והעוזר ענה חי אחרי ההחלפה.

**מה שעדיין משותף, במכוון:** שלב הפירוש (`interpret-document`, ‏Edge) ושלב התמלול
(`worker/ocr` על ה-VPS) חולקים את `NIR-API-OPENAI.txt`. שניהם „עיבוד מסמכים", ולכן חשבון אחד
עונה על השאלה. **להפרדה גם ביניהם צריך מפתח שלישי ועריכת `ocr.env` על ה-VPS דרך SSH** —
הקובץ אינו בריפו ואין אליו גישה מסקריפט מקומי.

**‏Mistral הוא מנוע ה-OCR הפעיל — ומשלם.** הטענה ההפוכה, שנרשמה כאן קודם באותו יום, נמדדה
על `document_interpretations` בלבד ולכן ענתה על השאלה הלא נכונה. **שני השלבים משתמשים בספקים
שונים:**

| שלב | טבלה | ספק בפועל |
|---|---|---|
| תמלול עמודים (OCR, ‏worker על VPS) | `document_extractions` | ‏**Mistral** מ-18.08.2026: 6 ריצות, האחרונה 25.08. לפניו OpenAI `gpt-5.6-terra`, ‏50 ריצות |
| פירוש התוכן (Edge) | `document_interpretations` | ‏**OpenAI** `gpt-5.6-terra` — 52 ריצות, ‏100% |

‏`resource_metadata` של שלוש ההרצות האחרונות אומר `{"adapter": "mistral", "worker_version": "2"}`,
כלומר ה-worker שבייצור **הועבר ל-Mistral** ואינו canary. **מפתח Mistral מייצג הוצאה פעילה**,
ואת חשבון ה-OCR רואים בלוח של Mistral — לא בזה של OpenAI.

**‏`OCR_WORKER_TOKEN` אינו מפתח ספק** ואינו עולה כסף — הוא סוד משותף שבו ה-worker מזדהה מול
ה-Edge. אין לו קשר לחשבון AI.

הנתיב הקודם `NIR-APP-DOCS\NIR-TOKEN-SUPABASE.txt` **אינו קיים יותר.** ‏`scripts/db-query.ps1`
קורא את הטוקן ממשתנה הסביבה `SUPABASE_ACCESS_TOKEN` ולכן לא נשבר, אך כל סקריפט שקורא את הקובץ
ישירות חייב את הנתיב החדש.

יש לקרוא את הערך מהקובץ בזמן הרצה בלבד. אין להעתיק את המפתח עצמו לריפו, ללוגים או למסמכי הפרויקט.

**חשבונות הבדיקה והמניפסט המקומי לא זזו** ונשארו תחת `NIR-APP-DOCS` כמתואר למטה.

## חשבונות בדיקה באתר החי

פרטי הכניסה של חשבונות הבדיקה החיים נמצאים מחוץ לריפו ב־
`D:\משה פרוייקטים\פיתוח אתרים\NIR-APP-DOCS\פרטי כניסה דמו.txt`.

בהחלטת בעלים מפורשת מ־13.08.2026, סוכנים רשאים לקרוא את הקובץ בזמן ריצה, להתחבר אוטומטית לאתר
החי ולהשתמש בחשבונות לצורך אימות ובדיקות. אין להדפיס את הסיסמה, access token או refresh token,
ואין להעתיקם לקוד, למסמך שנמצא בריפו, לארטיפקט ציבורי או להודעת Git.

החשבונות הפעילים הם `owner@gamos.demo`, ‏`office@gamos.demo`, ‏`accountant@gamos.demo` בלבד.
ב־13.08.2026 סיסמת שלושתם אופסה לערך המתועד בקובץ החיצוני, וכניסת Auth ו־UI אמיתית לאתר החי
אומתה לכל אחד.
החשבונות `nir@gamos.demo`, ‏`payer@gamos.demo`, ‏`meshek@supplier.demo` פרשו מהמוצר, חסומים,
ואסור להפעיל אותם מחדש. הקובץ החיצוני עשוי עדיין להזכיר אותם לצורך היסטורי.

## חשבונות הדמו המקומיים

המניפסט המקומי נמצא מחוץ לריפו ב־
`D:\משה פרוייקטים\פיתוח אתרים\NIR-APP-DOCS\DEMO-USERS.local.json`.

המניפסט הישן רשאי עדיין להכיל שישה פרטי התחברות, אבל `scripts/create-users.ps1` יוצר ומפעיל רק
את שלושת חשבונות המוצר (`owner`, ‏`office`, ‏`accountant`) וחוסם זהויות ישנות של
`kitchen`/`payer`/`supplier`. הוא ניתן להרצה חוזרת: מול Auth מקומי קיים הוא משחזר את הסיסמאות
לשלושת הפעילים, ומול stack ריק יוצר אותם. מסך הכניסה מציע מילוי מהיר רק לשלושת הפעילים ורק כאשר
`VITE_SUPABASE_URL` הוא loopback ו־`VITE_DEMO_PASSWORD_SEED` מוגדר ב־`.env.local`; שתי ההגנות
מונעות מהקיצור להופיע באתר החי.
