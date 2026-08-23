# INTEGRATIONS-SETUP — הקמה, סודות ותפעול של משטחי האינטגרציה

עודכן: 23.08.2026. המסמך הזה הוא מקום ההקמה היחיד לכל משטח אינטגרציה חיצוני: אילו משתני סביבה
נדרשים, איך מסובבים סוד, איך מנתקים ספק בלי לשבור עבודה ידנית, ומה עדיין חסר כדי לחבר ספק אמיתי.
עקרונות-העל: סודות רק ב-`supabase secrets` / ‏Vault, לעולם לא בריפו; אין fake-success כשתצורה
חסרה — משטח לא מוגדר עונה `misconfigured`/נופל-סגור.

## 1. פורטל ספק (0167) — ממומש, מוזג וחי

**מצב:** PR #86 מוזג ונפרס. Production ledger הגיע ל־`0167`; ‏Edge ‏`supplier-portal` פעיל,
Pages מגיש את entry הפורטל, ו־live E2E מלא הוכיח issue→redeem→submit→review→revision. הפרטים
וה־SHA נמצאים ב־`PROGRESS.md`. ההוראות להלן הן חוזה תחזוקה/שחזור, לא רשימת פעולות שטרם בוצעו.

**Edge Function:** ‏`supplier-portal` ‏(`verify_jwt=false`; ‏POST בלבד).

| משתנה | תפקיד |
|---|---|
| `ALLOWED_ORIGINS` | ‏allowlist ל-CORS, מופרד בפסיקים; ברירת מחדל `APP_BASE_URL`. חייב לכלול את origin הייצור, ול-dev את `http://localhost:5199` |
| `APP_BASE_URL` | ‏fallback ל-allowlist; אותו ערך שכבר משמש את `send-invite` |
| `SUPPLIER_PORTAL_RATE_LIMIT_PEPPER` | סוד אקראי שרתי, 32 תווים לפחות. משמש HMAC חד-כיווני לכתובת הלקוח לפני מונה קצב מתמיד; אסור `VITE_` ואסור לוג |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | מוזרקים על ידי הפלטפורמה |

**פריסה:** ליצור pepper במנהל סודות (`supabase secrets set SUPPLIER_PORTAL_RATE_LIMIT_PEPPER=...`),
ואז ‏`supabase functions deploy supplier-portal --no-verify-jwt` אחרי החלת `0167` (הפונקציה קוראת
RPCs שהמיגרציה יוצרת — סדר: מסד ואז סוד ואז Edge ואז frontend). בלי pepper או בלי כתובת שה-gateway
סיפק, הדלת מסרבת; אין fallback למונה בזיכרון.

**סיבוב pepper:** זהות המונה נגזרת מהסוד, ולכן סיבוב מאפס בפועל את חלון הקצב לכל כתובת. מסובבים רק
באירוע אבטחה או rollout מתוכנן, מעלים את הסוד ואת Edge באותו חלון, ומתעדים שהשורות הישנות נשארות
אטומות ונמחקות על ידי `supplyflow-supplier-portal-rate-prune` אחרי 30 יום.

**‏smoke לפריסת frontend:** ‏`/portal` חייב שורה בבדיקת הנתיבים של סקריפט הפריסה (הלקח של
`/operator`, ‏19.08.2026): ‏GET ‏`/portal` מגיש את ‏`assets/portal-*.js` ואינו את קליפת הדייר;
‏`/portal.html` עונה 308 אל `/portal` — זו התנהגות Pages תקינה; **אסור** להוסיף לו כלל
`_redirects`.

**סיבוב/ביטול קישורים:** אין סוד גלובלי לסובב — כל קישור הוא סוד עצמאי. ביטול קישור בודד: כפתור
"ביטול הקישור" במסך ההזמנה (או `revoke_supplier_order_link`). ביטול גורף לארגון:
`update supplier_order_links set revoked_at = now(), revoked_by = null, revoked_reason = 'bulk revoke' where org_id = :org and revoked_at is null;`
‏(דרך פקודת SQL מנומקת של המפעיל; אין ממשק לכך בכוונה).

**לוקאל:** ‏`?lang=en` פותח אנגלית/LTR, ‏`?lang=he` עברית/RTL; בלי פרמטר נבחרת שפת הדפדפן עם
fallback לעברית, ובדף יש מתג שפה. הטוקן נשאר ב-fragment ואינו עובר לפרמטר query.

**תצפית:** מוני IP אטומים נמצאים ב-`private.supplier_portal_rate_limits` (‏30 בקשות בדקה,
חסימה לעשר דקות; אין IP קריא); כשלי lookup ב-`private.supplier_portal_lookup_failures`;
נעילות קישור ב-`supplier_order_links.locked_until`. משטח קריאה מורשה יתווסף בפאזת התצפיות.

## 2. מייל יוצא — Resend; ‏B1 ממומש ומוזג, לא נפרס

**מצב קוד ומיזוג:** ‏PR #87 ו־`0168` מוזגו. ‏`email-sender` (`verify_jwt=true`) כולל preferences
fail-closed, claim/lease, חמש ניסיונות, קפיאת `unknown`, תבניות he/en ויישוב provider-accepted.
זהו `IMPLEMENTED / MERGED / NOT_DEPLOYED`: Production ledger נשאר ב־`0167`, ורק
`supplier-portal` מבין משטחי ה־Edge החדשים הוכח פעיל. accepted אינו delivered.

| משתנה | תפקיד ומצב |
|---|---|
| `RESEND_API_KEY` | משמש את `send-invite`; עצם קיומו אינו הוכחת דומיין, SMTP או מסירה חיצונית |
| `INVITE_FROM_EMAIL` | זהות שולח להזמנות עובד; היעד המוכרע הוא `no-reply@inplace.digital` |
| `ORDERS_FROM_EMAIL` | זהות שולח להזמנות ספק; היעד המוכרע הוא אותה כתובת. טרם הוכח כמוגדר |
| `APP_BASE_URL` | בסיס לקישורי הפורטל בגוף המייל |
| `ALLOWED_ORIGINS` | allowlist ל־CORS |
| `RESEND_WEBHOOK_SECRET` | סוד Svix לאירועי delivered/bounced; טרם הוכח כמוגדר |

**מה חסר להפעלה:** ‏`inplace.digital` נבחר אך לא נרכש ולא אומת. נדרשים רכישה, SPF/DKIM/DMARC,
אימות Resend, הגדרת השולחים, SMTP Auth ל־Supabase, החלת `0168`, פריסת `email-sender` ו־smoke
חיצוני. בלי תצורה הפונקציה עונה `misconfigured`; העבודה הידנית והפורטל נשארים זמינים.

**Webhook bounce הוא שלב עתידי נפרד:** ‏`email-webhook` אינו קיים. #238 קובע ש־bounce מאוחר
אינו מחזיר את lifecycle ההזמנה אחורה: ההזמנה נשארת `sent`, מצב ערוץ המייל הופך
`delivery_failed`, ו־retry מנפיק קישור חדש ומבטל את הקודם. אין לטעון delivered לפני webhook
חתום, de-dup ו־smoke חי.

## 3. ‏WhatsApp — Twilio נבחר; אינטגרציה עדיין לא קיימת

שכבת המסד קיימת ורדומה: ‏`whatsapp_connections`, ‏`whatsapp_order_messages`,
‏`process_whatsapp_webhook_event` ו־cron תזכורות. הבעלים בחר Twilio, וכל ארגון יחבר מספר/WABA
משלו; אין מספר InPlace מרכזי. ההשקה המתוכננת היא outbound בלבד עם מעקב
delivery/read/failed. inbound text/media אינם נקלטים או מתויקים.

| חוזה שנדרש לאמת | יעד Twilio המתוכנן |
|---|---|
| API ושליחה | חוזה Messages API חי וממוסמך; אין URL מומצא בקוד |
| אישור גישה | credentials פר־ארגון ב־Vault; לעולם לא בדפדפן או בריפו |
| מזהה שולח | מספר WhatsApp/WABA של הארגון, עם scope ו־revocation פר־דייר |
| חתימת webhook | אימות חתימת Twilio לפי החוזה החי לפני כל שינוי סטטוס |
| אירועי סטטוס | מיפוי אל `queued→accepted→sent→delivered→read/failed` עם de-dup |
| inbound | נדחה/נזנח במפורש; אסור להציג כאילו טופל |

עד חיבור חשבון, credentials, חוזה API ו־sandbox proof, ‏`wa.me` + תמונה נשאר המסלול הפעיל וכל
provider חדש חייב להיכשל סגור עם `misconfigured`. ‏DEBT §61 מתעד את יישור שער `sent` מול B1.

## 4. חיוב ומסמכי מס — Paddle ראשי; Stripe + Morning הם fallback בלבד

Paddle נבחר כ־Merchant of Record ראשי. Stripe direct יופעל רק אם Paddle אינו יכול לשרת את ישראל,
ובמקרה זה Morning / חשבונית ירוקה נבחרה למסמכי מס, קבלות וזיכויים בישראל — לא לסליקה.
‏`AccountingAdapter` ‏(7 מתודות), ‏`external_references`, ‏outbox ו־mocks קיימים, אך אין חיבור
Morning או חיוב Paddle/Stripe פעיל. לפני הפעלה נדרשים חשבונות מאומתים, חוזי API חיים, sandbox,
מספור/ביטול/זיכוי, webhooks חתומים ו־reconciliation. מצב:
`SELECTED / ACCOUNT_NOT_PROVEN / NOT_CONFIGURED / NOT_INTEGRATED / NOT_LIVE`.

## 5. דומיין ו־origins — נבחרו; טרם נרכשו או הוגדרו

- אתר שיווקי: `https://inplace.digital`
- אפליקציה: `https://app.inplace.digital`
- מפעיל: `https://app.inplace.digital/operator`
- `https://www.inplace.digital` מפנה קנונית ל־`https://inplace.digital`

האפליקציה והמפעיל חולקים origin/session, אך הרשאת המפעיל נשארת שרתית. מצב:
`SELECTED / NOT_PURCHASED / DNS_NOT_CONFIGURED / AUTH_ALLOWLIST_NOT_CONFIGURED / NOT_DEPLOYED`.
לפני טענת זמינות נדרשים רכישה, DNS, redirect, ‏Cloudflare Pages custom domains, ‏Supabase Auth
redirect allowlist, התאמת origins וסשן, ואז smoke אנונימי ומחובר.

## 6. Runbook תפעולי — דומיין, DNS, ‏Pages, ‏Auth ו־Resend. **אף שלב בו לא בוצע**

הפרק הזה הוא רשימת פעולות לביצוע, לא דיווח על ביצוע. **שום דבר כאן לא הורץ.** כל שלב הוא מוטציה
תפעולית אצל ספק חיצוני, וכל שלב דורש **הרשאת בעלים מפורשת** ומבוצע בידי מי שמחזיק בפועל את
חשבונות הרשם, ‏Cloudflare, ‏Supabase ו־Resend. סוכן אינו רוכש דומיין, אינו פותח חשבון, אינו כותב
רשומת DNS, אינו מפעיל SMTP ואינו שולח מייל חי — גם לא "מייל בדיקה אחד". הפעולה היחידה שבוצעה
בכתיבת הפרק היא **קריאת RDAP**, שהיא קריאה בלבד.

לכל שלב יש **תנאי מקדים** מפורש. שלב שהתנאי שלו לא התקיים אינו "כמעט מוכן" — הוא חסום, וסדר
השלבים אינו המלצה סגנונית אלא תוצאה של כשלים ממשיים המתוארים ב-§6.ח.

### 6.א ‏ רכישת הדומיין (#234)

מצב מילולי מ-#234: **`SELECTED / NO_REGISTRY_RECORD_AT_CHECK / NOT_PURCHASED / NOT_CONFIGURED`**;
"זמינות אינה נשמרת; אין טענת בעלות עד רכישה ו־DNS".

**בדיקת RDAP חוזרת — נבדקה 23.08.2026 בשעה 13:18 UTC, קריאה בלבד:**

| נקודת קצה | סטטוס HTTP | מה חזר |
|---|---|---|
| `https://rdap.org/domain/inplace.digital` | ‏`302` | הפניה ל־`https://rdap.identitydigital.services/rdap/domain/inplace.digital` (‏bootstrap של IANA לרשם `.digital`) |
| `https://rdap.identitydigital.services/rdap/domain/inplace.digital` | ‏`404` | אובייקט שגיאה תקני של RDAP: ‏`errorCode: 404`, ‏`title: "Object not found"` |

**המסקנה:** במועד הקריאה **אין רשומת רישום** ל־`inplace.digital` ברשם. זו קריאה של רגע אחד ולא
שריון: השם עשוי להירכש בידי צד שלישי בכל רגע עד שהבעלים רוכש אותו בפועל. ‏`404` אינו "פנוי לנצח"
ואינו טענת בעלות. הממצא תואם את #234 ואינו סותר אותו.

הערת שיטה: הקריאה בוצעה עם `curl` מפני ש-`WebFetch` קיבל `403` מ-`rdap.org` (חסימה ברמת הכלי, לא
תשובת רשם). לא נעשה שימוש בתוצאת חיפוש כתחליף לקריאת RDAP.

**מה לעשות ומה לא:**

1. **תנאי מקדים:** החלטת בעלים על רכישה. **הרכישה היא פעולת בעלים** — היא כרוכה בפתיחת חשבון אצל
   רשם ובאמצעי תשלום, ולכן חסומה לכל סוכן.
2. **מיד לפני הרכישה** יש להריץ שוב את אותה קריאת RDAP. אם היא מחזירה `200` עם אובייקט דומיין —
   השם נתפס, וכל שאר הפרק אינו ישים עד הכרעת בעלים חדשה על שם חלופי (‏#234 נפתחת מחדש).
3. לרשום את הדומיין לאותו חשבון Cloudflare שמחזיק את פרויקט ה-Pages, או להעביר אליו את ה-nameservers;
   ‏Cloudflare Pages דורש שהאזור יהיה תחת ה-nameservers שלו כדי ליצור בעצמו את רשומת ה-apex.
4. **אל תגדיר DNS לפני הרכישה** ואל תשנה שום דבר בסביבה החיה בינתיים — ראה §6.ח.

### 6.ב ‏ רשומות DNS למבנה הכתובות (#235)

מבנה הכתובות המוכרע ב-#235: שיווקי `https://inplace.digital`; אפליקציה `https://app.inplace.digital`;
מפעיל `https://app.inplace.digital/operator`; ‏`https://www.inplace.digital` מפנה קנונית לשיווקי.

**‏`/operator` הוא נתיב, לא subdomain.** ‏#235 ו-#161 קובעים שהאפליקציה והמפעיל חולקים origin וסשן,
ושגבול ההרשאה נשאר **בשרת** (`not_platform_admin`). ‏`public/_redirects` מתעד שהמפעיל אינו צריך שום
כלל, ו-`src/operator/main.tsx` מרכיב `HashRouter` כך שתתי-הנתיבים אינם מגיעים לשרת בכלל. **אין ליצור
subdomain מפעיל ואין "להקשיח" את הגבול הזה ב-DNS** — DNS אינו גבול הרשאה, והפרדה כזו רק תשבור את
הסשן המשותף בלי להוסיף אבטחה.

| סוג | שם | ערך | Proxy | TTL | מתי הערך ידוע |
|---|---|---|---|---|---|
| ‏CNAME (apex) | `inplace.digital` | נוצר על ידי Cloudflare בעת הוספת ה-custom domain בלוח Pages | Proxied | Auto | רק אחרי שקיים פרויקט Pages לאתר השיווקי — **אינו קיים** (§6.ג) |
| ‏CNAME | `www` | נוצר על ידי Cloudflare בעת הוספת `www.inplace.digital` כ-custom domain, ומעליו כלל Single Redirect | Proxied | Auto | אחרי apex |
| ‏CNAME | `app` | ‏`<פרויקט Pages>.pages.dev` — כיום `supplyflow-baq.pages.dev` | Proxied | Auto | הפרויקט קיים; ראה אזהרת השם ב-§6.ג |
| ‏— | `app.inplace.digital/operator` | **אין רשומה.** נתיב באותו origin | — | — | — |
| ‏MX / TXT | רשומות Resend | ראה §6.ה | ראה §6.ה | Auto | רק אחרי שהדומיין נוסף בלוח Resend |

מקור: ‏Cloudflare Pages custom domains (נקרא 23.08.2026,
`https://developers.cloudflare.com/pages/configuration/custom-domains/`) — לדומיין apex "configure
your nameservers to point to Cloudflare's nameservers" ואז "Cloudflare will proceed by creating a
CNAME record for you"; ל-subdomain נדרש `CNAME` אל `<YOUR_SITE>.pages.dev`. אותו עמוד מזהיר
מפורשות שיצירת CNAME ידנית **בלי** לשייך קודם את הדומיין בלוח Pages "will result in your domain
failing to resolve" עם שגיאת `522`. כלומר: **קודם לוח Pages, אחר כך DNS** — לא להפך.

**‏`www` → apex: לממש ככלל Single Redirect ב-Cloudflare, לא בקובץ `_redirects` של הריפו.**
לפי `https://developers.cloudflare.com/rules/url-forwarding/examples/redirect-www-to-root/` (נקרא
23.08.2026): תבנית wildcard על `https://www.*`, יעד `https://${1}`, סטטוס `301`, ו-"Preserve query
string: Enabled". ‏**אסור** לממש את ההפניה הזו כשורה ב-`public/_redirects`: הקובץ הזה חל רק על
בקשות שכבר מוגשות בידי פרויקט ה-Pages, והריפו כבר נשא לולאת הפניה מדודה בדיוק מהדפוס הזה — כלל
`200` שיעדו קובץ `.html` נחת על ה-308 הקנוני של Pages וחזר לעצמו "forever", ובגללו קונסולת המפעיל
הייתה בלתי-נגישה בייצור מרגע השילוח (‏`public/_redirects` שורות 1–15, מדידה מ-19.08.2026;
‏`docs/PROGRESS.md:347-348`). **אין להוסיף ל-`public/_redirects` שום כלל שיעדו `.html`.**

### 6.ג ‏ ‏Cloudflare Pages custom domains

**עובדות הריפו, לא הנחות:**

- פרויקט ה-Pages הקיים מגיש את **האפליקציה**, וכתובתו הקנונית היא `https://supplyflow-baq.pages.dev`;
  לצידה יש כתובת פריסה ייחודית פר-deploy, למשל `https://0b5f7c57.supplyflow-baq.pages.dev`
  (`docs/PROGRESS.md:1275-1277`; ‏`brand/context.md:12`).
- אותו `dist` מכיל **שלושה** entries בלבד — `index.html`, ‏`operator.html`, ‏`portal.html`
  (‏`.github/workflows/build.yml`, ‏`build_inputs='^(src/|public/|index\.html$|operator\.html$|portal\.html$)'`).
- **אין בריפו סקריפט פריסה ל-Pages.** ‏`package.json` אינו מגדיר פקודת deploy, ‏`scripts/` אינו
  מכיל אחת, ו-README מציין במפורש שהעבודה בריפו "אינה פורסת Cloudflare Pages" (`README.md:54`).
  הפריסה היא פעולת בעלים ידנית מחוץ לריפו.

**שתי אזהרות שחייבות הכרעת בעלים לפני ביצוע:**

1. **אין אתר שיווקי.** ‏#235 מקצה את `inplace.digital` ל"אתר שיווקי", אבל **אין ארטיפקט כזה בריפו**.
   הפניית ה-apex לפרויקט ה-Pages הקיים תגיש את **האפליקציה** בכתובת השיווקית — תוצאה שגויה. ה-apex
   נשאר לא-מוגדר עד שקיים אתר שיווקי (פרויקט Pages נפרד), או עד הכרעת בעלים אחרת.
2. **שם פרויקט ה-Pages עדיין נושא את המותג שפרש** (`supplyflow-baq`). שינוי שם הפרויקט משנה את
   הכתובת הקנונית `*.pages.dev` ולכן שובר כל רשומה, allowlist ו-smoke שמצביעים עליה. זו הכרעת
   בעלים, לא ניקוי בדרך.

**סדר הפעולות (‏`https://developers.cloudflare.com/pages/configuration/custom-domains/`, נקרא 23.08.2026):**

1. **תנאי מקדים:** הדומיין נרכש, האזור תחת nameservers של Cloudflare, ופרויקט Pages קיים ליעד.
2. בלוח Cloudflare: ‏**Workers & Pages** ← הפרויקט ← **Custom domains** ← **Set up a domain** ←
   להזין את שם המארח ← **Continue**. ‏Cloudflare יוצר את רשומת ה-DNS בעצמו.
3. להמתין עד שהדומיין מדווח **Active** בלוח. **לא לגעת ברשומות בזמן ההמתנה** — עריכה או מחיקה
   באמצע ה-provisioning מחזירה את התהליך אחורה ומייצרת `522` על מארח שכבר פורסם.
4. משך הנפקת TLS: **לא אומת.** העמוד שנקרא אינו מפרסם ערכי סטטוס ולא זמן הנפקה. אין להעתיק מספר
   מהזיכרון — הקריטריון המעשי הוא "הלוח מדווח Active **וגם** קריאת HTTPS למארח מצליחה", לא שעון.
5. **רק אחרי Active + HTTPS מוצלח** ממשיכים ל-§6.ד ול-§6.ח. לא לפני.

### 6.ד ‏ ‏Supabase Auth — site URL ו-redirect allowlist

**מה נדרש בפרויקט הייצור (הגדרת לוח, לא קובץ):**

| שדה | ערך |
|---|---|
| Site URL | `https://app.inplace.digital` |
| Redirect URLs — ערך חובה | `https://app.inplace.digital/reset-password` |

‏`https://app.inplace.digital/reset-password` הוא **מראה מחייבת** לפי #114: העובד הוא היחיד שרשאי
לאפס את סיסמתו, והקוד שולח בדיוק את הכתובת הזו — `src/pages/ForgotPassword.tsx:32-34`:

```ts
const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim(), {
  redirectTo: `${window.location.origin}/reset-password`,
```

‏origin שאינו ב-allowlist שובר את מסלול השחזור, ואין דרך עוקפת: #114 שולל מבעלים ארגוני את הסמכות
לאפס סיסמה של עובד.

זהו ה-`redirectTo` **היחיד** בקוד הלקוח כרגע. קישור ההזמנה לעובד אינו מסלול Auth redirect — הוא
נבנה בשרת כ-`{APP_BASE_URL}/accept-invite?token=...` (`supabase/functions/send-invite/index.ts:303`)
ולכן תלוי ב-`APP_BASE_URL` ולא ב-allowlist. כל זרימה עתידית שתקבל `redirectTo` תדרוש רשומה משלה.

‏Supabase תומך ב-wildcards ב-allowlist (`https://supabase.com/docs/guides/auth/redirect-urls`, נקרא
23.08.2026: ‏`*`, ‏`**`, ‏`?`, ומפרידים `.` ו-`/`), אבל כאן נדרשת רשומה מדויקת אחת — אין תצוגות
מקדימות ואין סיבה להרחיב את המשטח.

**‏`supabase/config.toml` הוא הגדרת ה-gate המקומי ואינו הייצור.** הקובץ מתעד זאת בעצמו
(שורות 41–47): ‏`site_url = "http://127.0.0.1:5199"` והרשימה יחידנית בכוונה —
"Local GoTrue treats redirect ports as exact, and the pinned CLI loads only the first entry here, so
keep this list deliberately singular. Production needs the mirror ({origin}/reset-password) in the
remote Auth URL configuration (#114)." ‏**אין לערוך את `supabase/config.toml` בשביל ייצור.**
הוספת המארח החדש שם לא תשנה דבר בייצור, ותסכן את הרצת השער המקומי.

### 6.ה ‏ אימות `inplace.digital` ב-Resend (#236)

מצב מ-#236: **`SELECTED / DOMAIN_NOT_VERIFIED / SMTP_NOT_CONFIGURED / NOT_LIVE`**.

**הערכים האמיתיים נוצרים פר-דומיין ואינם ניתנים לכתיבה מראש.** ‏Resend מפרסם שהרשומות "must match
exactly what Resend generated. Copy and paste the records to avoid configuration errors", ושהן
נלקחות מלשונית **Records** של הדומיין בלוח Resend (`https://resend.com/docs/add-a-domain`, נקרא
23.08.2026). הטבלה שלהלן היא **צורת** הרשומות כפי שהיא מפורסמת במדריך Cloudflare הרשמי של Resend
(`https://resend.com/docs/knowledge-base/cloudflare`, נקרא 23.08.2026) — הערכים בעמודה האחרונה הם
דוגמאות מהתיעוד, כולל אזור AWS שעשוי להיות שונה. **להעתיק מהלוח, לא מכאן.**

| סוג | שם ב-Cloudflare | תוכן (דוגמה מהתיעוד) | Priority | Proxy | TTL |
|---|---|---|---|---|---|
| ‏MX | `send` | `feedback-smtp.us-east-1.amazonses.com` | `10` | — | `Auto` |
| ‏TXT ‏(SPF) | `send` | `"v=spf1 include:amazonses.com ~all"` | — | — | `Auto` |
| ‏TXT ‏(DKIM) | `resend._domainkey` | `p=<המפתח שנוצר לדומיין בלוח Resend>` | — | **`DNS Only (disabled)`** | `Auto` |
| ‏TXT ‏(DMARC) | `_dmarc` | `"v=DMARC1; p=<טרם הוכרע>; rua=mailto:<טרם הוכרע>;"` | — | — | `Auto` |

**מלכודות Cloudflare מהתיעוד הרשמי של Resend (אותו עמוד):**

- ‏Cloudflare **אינו** מוסיף את הדומיין לשם הרשומה. להדביק `send`, לא `send.inplace.digital`.
- ה-DKIM חייב `DNS Only (disabled)`; אחרת Cloudflare מחזיר `Code: 1004`.
- לא לחזור על אותה `Priority` בשתי רשומות MX; אם `10` תפוס — `20` או `30`.
- ‏TTL: ‏`Auto` בכל הרשומות.

**רשומת ה-MX ל-`inbound` אינה נוספת.** היא נועדה לקבלת דואר נכנס, ולמוצר אין משטח דואר נכנס:
‏#237 קובע כתובת אחת בלי `reply-to`, ותשובות משתמש אינן ערוץ עבודה.

**זמן אימות:** ‏Resend מפרסם ש"your domain will often verify within 15 minutes of adding the DNS
records. However, DNS changes can occasionally take up to 72 hours to propagate globally". אין
לטעון "מאומת" לפני שהלוח מדווח verified.

**‏Resend ממליץ על subdomain, ‏#237 הכריע על השורש.** התיעוד אומר "We recommend sending your emails
from one or more subdomains (e.g., `updates.example.com`) instead of your root domain to isolate
your sending reputation". ‏#237 הכריע `no-reply@inplace.digital` — כלומר השורש. **ההכרעה עומדת**;
המתח מתועד כאן כדי שלא "יתוקן" בשקט בזמן הביצוע. שינוי דורש הכרעת בעלים חדשה.

**‏DMARC — פער עסקי פתוח, אין להכריע בקוד או כאן.** ‏Resend מתעד שלוש מדיניויות —
‏`p=none;` ‏("Allow all email. Monitoring for DMARC failures"), ‏`p=quarantine;` ו-`p=reject;` — וממליץ
להתחיל ב-`p=none` ולעבור ל-`quarantine`/`reject` "only do this once you know your messages are
delivering and fully passing DMARC" (`https://resend.com/docs/dashboard/domains/dmarc`, נקרא
23.08.2026). **‏#236 ו-#237 אינם נוקבים במדיניות DMARC ואינם נוקבים בתיבת `rua`.** לכן:

- **שאלה פתוחה 1:** באיזו מדיניות `p=` נפתחת ההשקה — `none`, ‏`quarantine` או `reject`?
- **שאלה פתוחה 2:** לאן נשלחים דוחות ה-`rua`? ‏#237 קובע כתובת שולח יחידה בלי `reply-to`, ולכן
  **אין תיבה נכנסת מוגדרת** שיכולה לקלוט אותם.

עד הכרעה מתועדת ב-`OPEN-DECISIONS`, רשומת ה-DMARC נשארת ריקה בטבלה למעלה. **אין לבחור ערך בשקט.**

### 6.ו ‏ זהות השולח (#237)

‏#237: כתובת אחת — `no-reply@inplace.digital` — ל-Auth, להזמנות עובד ולהזמנות ספק. אין `reply-to`.

שמות המשתנים נלקחו מהקוד עצמו, לא מניסוח התוכנית:

| משתנה | היכן נקרא | תפקיד |
|---|---|---|
| `INVITE_FROM_EMAIL` | `supabase/functions/send-invite/index.ts:187` | שולח הזמנות עובד. הפונקציה מחזירה `misconfigured` בלעדיו (שם, שורות 192–193) |
| `ORDERS_FROM_EMAIL` | `supabase/functions/email-sender/index.ts:93` | שולח הזמנות ספק. **נופל בחזרה ל-`INVITE_FROM_EMAIL`** אם אינו מוגדר |

הפורמט לפי ההערות בקוד הוא `"שם תצוגה <כתובת>"` (`send-invite/index.ts:15`,
‏`email-sender/index.ts:13-14`).

**להגדיר את שניהם במפורש.** ה-fallback של `ORDERS_FROM_EMAIL` אומר שהמערכת תשלח גם אם רק אחד
מוגדר — אבל אז זהות השולח של הזמנות הספק היא תוצאת לוואי ולא הכרעה, ו-#237 דורש זהות מפורשת.
‏`email-sender/index.ts:13-14` גם מציין שמזהי sandbox מסמנים `deliveryLimited` — כלומר שולח לא מאומת
אינו נכשל ברעש אלא מדווח מסירה מוגבלת.

**היכן מגדירים:** ‏`supabase secrets set` בלבד. **לא בריפו, לא ב-`.env`, לא ב-`.env.example`,
לא בלוג ולא בפרומפט של סוכן.**

### 6.ז ‏ ‏Supabase Auth SMTP דרך Resend

**תנאי מקדים:** ‏`inplace.digital` מדווח **verified** ב-Resend (§6.ה). לפני כן הגדרת SMTP רק
תייצר כשלי מסירה.

הגדרות החיבור של Resend (`https://resend.com/docs/send-with-smtp`, נקרא 23.08.2026):

| שדה Supabase | ערך |
|---|---|
| `smtp_host` | `smtp.resend.com` |
| `smtp_port` | ‏`465` או `2465` ל-SMTPS ‏("Implicit SSL/TLS"), או `587`/`2587`/`25` ל-STARTTLS ‏("Explicit SSL/TLS") |
| `smtp_user` | `resend` |
| `smtp_pass` | ‏**מפתח API של Resend.** נוצר ונראה בידי הבעלים בלבד; אינו נכתב כאן, אינו נכנס לריפו, אינו מודפס בלוג ואינו מועבר לסוכן |
| `smtp_admin_email` | `no-reply@inplace.digital` (#237) |
| `smtp_sender_name` | שם התצוגה של המותג |

שמות השדות ומקום ההגדרה — "Authentication settings page" בלוח או ה-Management API — לפי
`https://supabase.com/docs/guides/auth/auth-smtp` (נקרא 23.08.2026). אותו עמוד קובע גם:

- שירות המייל המובנה של Supabase מוגבל ל-**"2 messages per hour"**, ללא SLA, ו-**"not meant for
  production use"**; בלי SMTP מותאם "Supabase Auth will refuse to deliver messages to addresses that
  are not part of the project's team". זו בדיוק המגבלה ש-#114 מתאר ("ללא SMTP מותאם המייל מוגבל־קצב
  ולא ממותג"), וזה מה שהשלב הזה סוגר.
- לאחר הפעלת SMTP מותאם, ‏Supabase מחיל **"a low rate-limit of 30 messages per hour"**, שניתן לשנות
  בעמוד ה-Rate Limits. **לבדוק את הערך הזה מול נפח ההזמנות בפועל לפני שמכריזים על המשטח כפעיל** —
  שער קצב שקט הוא כשל מסירה שנראה כמו הצלחה.

### 6.ח ‏ אילוץ הסדר: ‏`APP_BASE_URL` ו-`ALLOWED_ORIGINS` משתנים **אחרונים**

**הכלל:** ‏`APP_BASE_URL` ו-`ALLOWED_ORIGINS` בסביבה החיה משתנים **רק אחרי** ש-DNS ו-TLS פעילים על
ה-origin החדש והוא עונה ב-HTTPS. לא במקביל, לא "כדי להיות מוכנים".

זה אינו נימוס. שני המשתנים מזינים שני מנגנונים שונים, ושניהם נשברים בשקט:

**1. ‏CORS.** כל משטח Edge שמדבר עם דפדפן גוזר את ה-allowlist מ-`ALLOWED_ORIGINS ?? APP_BASE_URL`,
מפצל בפסיקים, ומחזיר `Access-Control-Allow-Origin` **רק** אם ה-Origin של הקורא נמצא ברשימה; אחרת
הוא מחזיר את `allowed[0]` — כלומר את הכתובת **הלא נכונה**, לא שגיאה מפורשת:

- `supabase/functions/supplier-portal/core.ts:8-18` — `allowed.includes(cleaned) ? cleaned : (allowed[0] ?? '')`
- `supabase/functions/email-sender/index.ts:41-51` — אותו דפוס
- `supabase/functions/send-invite/index.ts:33-43` — אותו דפוס, עם ההערה "Echo the caller's Origin
  only when it is on the allowlist -- never a blanket '*'"

לכן, אם מחליפים את הערך ל-`https://app.inplace.digital` בזמן שהדפדפן עדיין טוען את האפליקציה
מ-`https://supplyflow-baq.pages.dev`, כל preflight נענה בכותרת שאינה תואמת, **הדפדפן חוסם**,
ופורטל הספק, שליחת ההזמנות והזמנות העובד מפסיקים לעבוד מהאפליקציה החיה. שום לוג שרת לא יראה שגיאה.

**2. קישורים בתוך מיילים שכבר יצאו.** ‏`APP_BASE_URL` בונה את גוף הקישור:

- `supabase/functions/send-invite/index.ts:303` — `${appBaseUrl}/accept-invite?token=...`
- `supabase/functions/email-sender/index.ts:142` — `${appBaseUrl}/portal#token=...`

שינוי מוקדם מפנה כל קישור חדש למארח שעדיין אינו נפתר. וזה **אינו** ניתן לתיקון בשליחה חוזרת בלי
מחיר: לפי #188 ו-#184, הנפקה מחדש **הורגת מיד את הקישור הקודם**, ולכן "לשלוח שוב" הוא אירוע עסקי,
לא retry טכני.

**3. ‏Auth.** שינוי Site URL או ה-allowlist לפני שה-origin חי הופך את קישור איפוס הסיסמה למת. לפי
‏#114 העובד הוא היחיד שיכול לאפס — אין למי לפנות לעקיפה.

**הסדר המחייב:**

```
רכישה → ‏Cloudflare Pages custom domain (Active) → ‏HTTPS עונה על ה-origin החדש
      → פריסת frontend על הכתובת החדשה ואימות hash parity
      → ‏Supabase Auth site URL + redirect allowlist
      → ‏APP_BASE_URL / ALLOWED_ORIGINS ‏(supabase secrets set)
      → פריסה חוזרת של משטחי ה-Edge שקוראים אותם
      → ‏smoke (§6.ט)
```

בשלב המעבר מותר — ורצוי — להחזיק ב-`ALLOWED_ORIGINS` **את שתי הכתובות** מופרדות בפסיק, כדי שלא
ייווצר חלון שבו אחת מהן חסומה. את הכתובת הישנה מסירים רק אחרי ש-smoke על החדשה עבר.

### 6.ט ‏ ‏Smoke אחרי הפעלה

לפי מטריצת ה-rollout ב-`CLAUDE.md:110`, שורת "Frontend / נכס ציבורי": build עם env ייצור, סריקת
סודות/localhost, ‏Pages, התאמת hashes, ‏"smoke קנוני בנתיבים שהשתנו + `/`/`login` בדסקטופ ובמובייל";
בכתובת הייחודית די ב-hash parity ובבדיקת זמינות אחת.

**אנונימי, על ה-origin החדש:**

| נתיב | מה חייב לקרות |
|---|---|
| `https://app.inplace.digital/` | מגיש `assets/index-*.js` |
| `https://app.inplace.digital/login` | מגיש `assets/index-*.js`; נבדק גם במובייל |
| `https://app.inplace.digital/reset-password` | בלי סשן — הודעת "הקישור מת", לעולם לא טופס סיסמה (`src/pages/ResetPassword.tsx`) |
| `https://app.inplace.digital/operator` | מגיש `assets/operator-*.js` ולא את קליפת הדייר |
| `https://app.inplace.digital/portal` | מגיש `assets/portal-*.js` |
| `https://app.inplace.digital/portal.html` | ‏`308` אל `/portal` — התנהגות Pages תקינה; **אין להוסיף לה כלל `_redirects`** (§2, ‏§6.ב) |
| `https://www.inplace.digital/x?y=1` | ‏`301` אל `https://inplace.digital/x?y=1` — כולל ה-query |

**מחובר:** קריאה בלבד עם שלוש זהויות הבדיקה המאושרות ב-`CLAUDE.md`, והוכחת אפס כתיבות עסקיות.
זהויות שפרשו (`kitchen`, ‏`payer`, ‏`supplier`) חייבות להישאר חסומות.

**מלכודת פער ההתפשטות של הכתובת הקנונית.** הכתובת הקנונית עלולה להמשיך להגיש את ה-build **הקודם**
עוד זמן-מה אחרי העלאה מוצלחת. לכן בדיקת ה-parity היא **לולאת polling** עד להתאמה, לא בקשה אחת:
משווים את hash של ה-entry script בכתובת הקנונית מול הכתובת הייחודית של אותו deploy, וחוזרים עד
שהם זהים. בקשה בודדת שמחזירה את ה-hash הישן אינה "כשל פריסה" ואינה "הצלחה" — היא מדידה מוקדמת.
‏**המלכודת הזו אינה מתועדת ב-`docs/` נכון ל-23.08.2026** — היא נרשמת כאן לראשונה; רישום ב-DEBT הוא
פעולת האורקסטרטור.

### 6.י ‏ מצב סגירה — כל השערים שעדיין סגורים

| שער | הכרעה | מצב 23.08.2026 |
|---|---|---|
| רכישת `inplace.digital` | #234 | `NOT_PURCHASED`. ‏RDAP ‏`404` ב-23.08.2026 13:18 UTC — אין רשומת רישום, ואין שריון |
| ‏DNS למבנה הכתובות | #235 | `DNS_NOT_CONFIGURED`. שום רשומה לא נכתבה |
| אתר שיווקי ל-apex | #235 | **חסר ארטיפקט.** אין אתר שיווקי בריפו; ה-apex אינו ניתן להפניה |
| ‏Cloudflare Pages custom domains | #235 | `ROUTES_NOT_DEPLOYED`. לא נוסף אף custom domain |
| ‏Supabase Auth site URL + allowlist | #235, #114 | `AUTH_ALLOWLIST_NOT_CONFIGURED`. ‏`config.toml` הוא ה-gate המקומי בלבד |
| אימות דומיין ב-Resend | #236 | `DOMAIN_NOT_VERIFIED`. ‏SPF/DKIM/DMARC לא פורסמו |
| מדיניות DMARC ותיבת `rua` | — | **לא הוכרע.** אינו מופיע ב-#236 או ב-#237. שאלה פתוחה לבעלים |
| שם פרויקט ה-Pages | — | **לא הוכרע.** עדיין `supplyflow-baq`; שינוי שם משנה את הכתובת הקנונית |
| ‏Supabase Auth SMTP | #236 | `SMTP_NOT_CONFIGURED`. עדיין 2 מיילים/שעה ורק לכתובות הצוות |
| זהות שולח (`INVITE_FROM_EMAIL`, ‏`ORDERS_FROM_EMAIL`) | #237 | טרם הוכח כמוגדר לזהות המאומתת |
| ‏`APP_BASE_URL` / ‏`ALLOWED_ORIGINS` | #235 | ללא שינוי — ובכוונה, לפי אילוץ הסדר ב-§6.ח |
| מסירה חיצונית מוכחת | #236, #238 | `NOT_LIVE`. לא נשלח מייל חי, גם לא לבדיקה |

**הכרעה אינה הפעלה, וחשבון אינו הפעלה.** כל השורות בטבלה הזו סגורות. אין בפרק הזה טענה שמשהו
הוגדר, אומת או חי.
