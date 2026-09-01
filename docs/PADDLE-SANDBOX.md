# Paddle — מצב האינטגרציה, ואיך מריצים את הוכחת ה־Sandbox

**עודכן 31.08.2026.** המסמך הזה מתאר את **Sandbox בלבד.** אין בו שום שלב שנוגע ב־Paddle Live,
ואין להסיק ממנו רשימת פעולות לייצור — הרשימה הזו נמצאת בסוף, תחת «מה עוד חסר לפני Live».

## המצב בשורה אחת

הצנרת מקצה לקצה עובדת מול חשבון Paddle Sandbox אמיתי, **ובייצור אף אחד עדיין לא יכול לשלם ולא
יכול לקבל מסלול** — כי מתג ה־merchant of record כבוי, ושום קוד לא יכול להדליק אותו.

## מה קיים

| שכבה | מצב | היכן |
|---|---|---|
| קטלוג Sandbox | 3 מוצרים, 6 מחירים, אידמפוטנטי | `scripts/paddle/sandbox-catalogue.mjs` |
| התאמת מחירים למסד | נבדקת משני הצדדים | `scripts/paddle/verify-catalogue-matches-db.mjs` |
| מיפוי price→plan | 6 שורות, עם product id ו־interval | `0277` |
| הרשאת רכישה וניהול | ‏`auth_org()` בלבד, בלי ארגומנט ארגון | `0278` |
| קישור לקוח־לארגון | ‏service_role בלבד, אידמפוטנטי | `0278` |
| קריאות Paddle חיות | לקוח, עסקה, ביטול, שינוי מסלול, portal | `_shared/billing-adapter.ts` |
| ‏Edge של רכישה | `billing-checkout` | `supabase/functions/billing-checkout/` |
| ‏Edge של webhook | `billing-webhook` — קיים מקודם, פרוס בייצור | `supabase/functions/billing-webhook/` |
| ‏Paddle.js | ‏sandbox בלבד, טוקן לקוח בלבד | `src/lib/paddle.ts` |
| שומר סודות | נבדק עם ניסוי שלילי | `scripts/check-paddle-secrets.mjs` |

## שני החצאים של הקרדנציאלס — וההפרדה היא המנגנון

| סוד | איפה הוא חי | מה הוא יכול |
|---|---|---|
| `PADDLE_API_KEY` (`pdl_sdbx_apikey_…`) | סוד של Edge Function בלבד | הכול: לקוחות, מנויים, החזרים |
| `PADDLE_ENVIRONMENT` | סוד של Edge Function | `sandbox` או `live`. **חייב להיכתב במפורש** — שגיאת כתיב מסרבת, לא מנחשת |
| `PADDLE_WEBHOOK_SECRET` (`pdl_ntfset_…`) | סוד של Edge Function בלבד | אימות חתימה |
| `VITE_PADDLE_CLIENT_TOKEN` (`test_…`) | ‏bundle של הדפדפן | לפתוח checkout לעסקה שהשרת כבר יצר. ותו לא |
| `VITE_PADDLE_ENVIRONMENT` | ‏bundle של הדפדפן | `sandbox` / `live` |

`billing-webhook` נפרס **בלי** `PADDLE_API_KEY`. זו לא הזנחה: הפונקציה שמקבלת אירועי כסף אינה
מסוגלת מבנית ליצור אחד, ויש על כך בדיקה (`billingAdapterFor gives the webhook deployment no API key`).

הערכים עצמם נקראים בזמן ריצה מהתיקייה החיצונית שב־`docs/LOCAL-CREDENTIALS-PATH.md`. אין להדפיס
אותם, ואין להכניס אף אחד מהם לריפו.

## איך מריצים את הוכחת ה־Sandbox מקצה לקצה

דרושים: ה־stack המקומי למעלה, ו־`cloudflared`.

```bash
# 1. מנהרה ציבורית אל הפונקציה המקומית
cloudflared tunnel --url http://localhost:8000

# 2. הפונקציה עצמה — הקוד הפרוס, לא עותק
SUPABASE_URL=http://127.0.0.1:55431 \
SUPABASE_SERVICE_ROLE_KEY=<local> \
BILLING_PROVIDER=paddle \
PADDLE_WEBHOOK_SECRET=<from the credentials folder> \
  deno run --allow-net --allow-env supabase/functions/billing-webhook/index.ts

# 3. רישום יעד ההתראות אצל Paddle (קורא את רשימת האירועים מהמסד)
node scripts/paddle/sandbox-notification-destination.mjs https://<tunnel>/billing-webhook

# 4. ההוכחה
node scripts/paddle/sandbox-e2e.mjs
```

הסקריפט **מדליק את Paddle במסד המקומי ומכבה אותו ב־`finally`** — כולל בריצה שנכשלת. שום מיגרציה
לא נושאת את ההדלקה הזו, ולכן אין מה להסיר אחר כך והייצור לא זז.

**הוא מסרב לכוון את עצמו לייצור.** בחשבון ה־Sandbox קיים גם יעד שמצביע על ה־Edge של הייצור;
הסקריפט פוסל כל יעד שמתארח ב־`supabase.co` ודורש את המנהרה המקומית.

### מה ההרצה הוכיחה (23/23, 31.08.2026)

כל אירוע נוצר אצל Paddle, נחתם על ידי Paddle ונשלח על ידי Paddle דרך האינטרנט:

- הפעלה חתומה מעבירה את הדייר למסלול הממופה — ורק אותו
- שדרוג ושנמוך, שני הכיוונים, מ־`subscription.updated` חתום
- ביטול מחזיר ל־Free; כשל תשלום מסמן `past_due` ו**אינו** משנמך בשקט
- משלוח חוזר = אפקט אחד
- לקוח לא מוכר ומחיר לא ממופה — שניהם dead-letter, גלויים, בלי להעניק כלום
- חתימה שגויה נדחית, לא משנה סטטוס, ו**אינה נכתבת ל־ledger**
- חותמת זמן ישנה נדחית
- בידוד דיירים ארבע פעמים, כולל payload שנוקב בשם הארגון השכן ב־`custom_data`, ‏`passthrough`
  ו־`metadata` בו־זמנית

## מה **לא** הוכח, ולמה

**תשלום אמיתי בכרטיס.** ‏Paddle מסרב ל־`POST /transactions` עם
`transaction_default_checkout_url_not_set` עד שמוגדר **default payment link** בלוח הבקרה שלו.
זו הגדרת חשבון שאין לה API, ולכן היא חסם שנרשם ולא שלב שדולג. ראו «מה נדרש מהבעלים» למטה.

## מה נדרש מהבעלים כדי להשלים

1. **להגדיר default payment link ב־Paddle Sandbox** (Checkout → Checkout settings). אחרי זה
   `node scripts/paddle/sandbox-e2e.mjs` יוכל להורחב לרכישה אמיתית בכרטיס בדיקה.
2. **להחליט מה לעשות עם יעד ההתראות שמצביע על הייצור** — `ntfset_01m1c484xq646vsg0fkg8fm7h0`,
   יעד `https://rkftlbctohswhbbiaqin.supabase.co/functions/v1/billing-webhook`. הוא **אינרטי היום**
   פעמיים: אין בייצור `PADDLE_WEBHOOK_SECRET` (כל משלוח מקבל 503), והמתג כבוי. לא נגעתי בו כי הוא
   לא נוצר על ידי העבודה הזו.

## מה עוד חסר לפני Live — רשימה, לא תוכנית

אף אחד מהסעיפים האלה **לא בוצע** ואין להסיק שבוצע:

- ‏KYC ו־payout לישראל אצל Paddle (`#213` עדיין `ACCOUNT_NOT_PROVEN / KYC_NOT_PROVEN /
  ISRAEL_PAYOUT_NOT_PROVEN`)
- קטלוג Live נפרד — מוצרים ומחירים חדשים, ומיגרציה שמוסיפה שורות `environment = 'live'` לצד
  שורות ה־sandbox
- מיגרציה forward-only שמדליקה את ה־merchant of record, עם מי הדליק, מתי ולמה. **זו הפעולה
  המסחרית עצמה** ולא פרט טכני — היום שום פונקציה אינה יכולה לבצע אותה, וזה נשאר נכון
- יעד התראות Live עם סוד משלו
- ‏`PADDLE_ENVIRONMENT=live` ו־`VITE_PADDLE_CLIENT_TOKEN` בגרסת `live_…`
- מסלול החזרים (`#224`/`#225`) — הקוד קיים ולא נבדק מול Paddle
