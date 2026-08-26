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

## 2. מייל יוצא — Resend; הדומיין מאומת ו־Auth מחובר (24.08.2026). ‏B1 ממומש ומוזג, לא נפרס

**מצב קוד ומיזוג:** ‏PR #87 ו־`0168` מוזגו. ‏`email-sender` (`verify_jwt=true`) כולל preferences
fail-closed, claim/lease, חמש ניסיונות, קפיאת `unknown`, תבניות he/en ויישוב provider-accepted.
זהו `IMPLEMENTED / MERGED / NOT_DEPLOYED`: Production ledger נשאר ב־`0167`, ורק
`supplier-portal` מבין משטחי ה־Edge החדשים הוכח פעיל. accepted אינו delivered.

| משתנה | תפקיד ומצב |
|---|---|
| `RESEND_API_KEY` | משמש את `send-invite`; עצם קיומו אינו הוכחת דומיין, SMTP או מסירה חיצונית |
| `INVITE_FROM_EMAIL` | **מוגדר 24.08.2026** ל־`InPlace <no-reply@inplace.digital>` |
| `ORDERS_FROM_EMAIL` | **נוצר 24.08.2026** עם אותו ערך. קודם לא היה קיים כלל, ו־`email-sender` נפל חזרה ל־`INVITE_FROM_EMAIL` |
| `APP_BASE_URL` | בסיס לקישורי הפורטל בגוף המייל; מאז 24.08 `https://app.inplace.digital` |
| `ALLOWED_ORIGINS` | allowlist ל־CORS |
| `RESEND_WEBHOOK_SECRET` | סוד Svix לאירועי delivered/bounced; טרם הוכח כמוגדר |

### 2.א ‏ תשתית הדואר — חיה ומדודה מ־24.08.2026

**מה נמדד, ולא הוסק:**

| שכבה | מצב |
|---|---|
| דומיין ב־Resend | `verified` · ‏id `e7f315d9…27c2` · אזור `eu-west-1` (אירופה) |
| ‏DKIM / SPF של Resend | שניהם `verified`, על `resend._domainkey` ועל `send.` |
| ‏DMARC | `v=DMARC1; p=none; rua=mailto:dmarc@inplace.digital;` — שלב ניטור מכוון |
| מסירה יוצאת | נמדדה `delivered`; ‏Gmail החזיר **SPF, DKIM ו־DMARC ‏`PASS`** במקור ההודעה |
| ‏Supabase Auth SMTP | `smtp.resend.com:465`, משתמש `resend`, שולח `no-reply@inplace.digital`, שם `InPlace` |
| מכסת מיילי Auth | **מ־2 ל־100 בשעה.** ‏`rate_limit_email_sent=2` היה חוסם השקה: שני מיילים בשעה **לכל הפרויקט**, מכתובת `supabase.co` |
| קבלת דואר | ‏Cloudflare Email Routing `enabled=true` / `status=ready`; ‏`dmarc@inplace.digital` מועבר לתיבת הבעלים, אומת בהודעת בדיקה שהגיעה. ‏catch-all **כבוי** |

**סיסמת ה־SMTP היא מפתח Resend המוגבל־שליחה**, לא המפתח המלא — Auth רק שולח.

**‏Resend שולח, ‏Cloudflare מקבל, ושניהם על אותו דומיין בלי להתנגש:** רשומות השליחה יושבות על
`send.` ו־`resend._domainkey`; רשומות הקבלה על השורש ועל `cf2024-1._domainkey`. חמש רשומות ה־MX
של NameCheap ורשומת ה־SPF שלהן **נמחקו** — הבעלים אישר שלא היה דואר פעיל, ושתי רשומות SPF על
אותו שם פוסלות זו את זו.

**מה שעדיין לא הוכח, ואסור לטעון:** ‏**מייל Auth אמיתי לא נשלח.** חשבונות הבדיקה הם `@gamos.demo`
— דומיין מזויף שיחזור — ו־`recover` לכתובת שאינה קיימת מחזיר `200` בלי לשלוח, מטעמי אי־מנייה.
‏Supabase אימת את חיבור ה־SMTP בשמירה, וזו הראיה שיש; ההוכחה הסופית היא המייל האמיתי הראשון.
כמו כן `RESEND_WEBHOOK_SECRET` ו־`email-webhook` עדיין אינם, ולכן accepted עדיין אינו delivered
במסלול המוצר.

**חוב שנפתח כאן:** תבניות מיילי ה־Auth הן ברירות המחדל **באנגלית** (`"Reset your password"`,
`"You've been invited"`) במוצר עברי RTL. לא חוסם, אך יש לסגור לפני לקוח ראשון.

**מעבר מ־`p=none`:** רק אחרי תקופה מייצגת של קריאת דוחות `rua` בפועל, ואז `quarantine` לפני
`reject`. הכרעת בעלים חדשה, לא ניקוי בדרך.

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

## 5. דומיין ו־origins — האפליקציה חיה; ה־apex וה־`www` אינם מוגדרים במכוון

**מצב מ־24.08.2026: `PURCHASED / DELEGATED / ZONE_ACTIVE / APP_LIVE / AUTH_CONFIGURED`** — לאפליקציה
בלבד. אומת מול התשתית החיה, לא מתוך תיעוד; הראיות ב־`artifacts/domain-cutover/`.

| כתובת | מצב נמדד |
|---|---|
| `https://app.inplace.digital` | **חי.** ‏custom domain על פרויקט ה־Pages הקיים `supplyflow` (`status=active`, ‏`cert=active`), דרך `CNAME app → supplyflow-baq.pages.dev` proxied |
| `https://app.inplace.digital/operator` | נתיב באותו origin. נטען, והגבול השרתי לא זז — `office` ו־`accountant` מנותבים לדשבורד שלהם |
| `https://supplyflow-baq.pages.dev` | **נשאר חי** כ־origin לגלגול אחורה; מגיש את אותה פריסה בדיוק. אין הפניה למשתמש |
| `https://inplace.digital` (apex) | **אינו מגיש דבר, במכוון.** רשומות ה־web של NameCheap שסריקת הייבוא משכה — `A → 192.64.119.114` ו־`CNAME www → parkingpage.namecheap.com` — נמחקו לפני שההאצלה הפכה סמכותית. השורש נושא רשומות **דואר** בלבד (§2.א); אין לגזור מהן רשות להוסיף לו רשומת web |
| `https://www.inplace.digital` | **‏NXDOMAIN.** אין רשומה ואין הפניה |

האזור מתארח ב־Cloudflare (‏id `82a4bdef…7b5a`, ‏`active`) עם `clyde.ns.cloudflare.com` ו־
`rose.ns.cloudflare.com`; ‏RDAP מדווח את ההחלפה ב־`2026-08-23T22:07:04Z`. רשומות ה־`MX`/`TXT` של
השורש הן מישור הדואר ולא נגעו — ראה §2. **אין לגזור מהן רשות להוסיף לשורש רשומת web.**

התצורה שהשתנתה: ‏`ALLOWED_ORIGINS` הורחב תוספתית ל־
`https://supplyflow-baq.pages.dev,http://localhost:5199,https://app.inplace.digital` (הסדר נשמר, אין
`*`, מקור לא־מורשה עדיין נדחה); ‏`APP_BASE_URL` הועבר ל־`https://app.inplace.digital`; ב־Supabase
Auth ה־Site URL היה `http://localhost:3000` ועכשיו `https://app.inplace.digital`, וה־allowlist
**הורחב ולא הוחלף** — `https://supplyflow-baq.pages.dev/reset-password` נשאר לצד
`https://app.inplace.digital/reset-password`, כדי שקישורי שחזור שכבר נשלחו ימשיכו לנחות.

**לא נדרשה בנייה או פריסה חדשה.** ה־bundle אינו נושא כתובת בסיס: הלקוח בונה קישורים מוחלטים מ־
`window.location.origin`, ולכן אותה פריסה בדיוק (`e851dbe8…`, ‏`15baeac`) נכונה לשתי הכתובות — אומת
בהתאמת entry chunks. אין `VITE_APP_BASE_URL` בחוזה ולא נוסף.

### 5.א ‏ `auth.inplace.digital` — דומיין Auth משלנו; מסך גוגל כבר אינו מציג את מזהה הפרויקט

**מצב מ־26.08.2026: `ACTIVE`.** ‏Supabase מדווח `5_services_reconfigured`, תעודה פעילה מ־Google
Trust Services (‏`issued 2026-08-26`, ‏`expires 2026-11-24`).

**הבעיה שנפתרה.** מסך הכניסה של גוגל מציג את המארח של ה־`redirect_uri`, ו־GoTrue בונה אותו מכתובת
ה־external שלו. כל עוד זו הייתה `rkftlbctohswhbbiaqin.supabase.co`, בעל עסק שנרשם דרך גוגל ראה
„המשך אל rkftlbctohswhbbiaqin.supabase.co" — מזהה הפרויקט הגולמי. זה לא באג בקוד: `signInWithOAuth`
ב־`src/lib/authProviders.ts:55` שולח בקשה רגילה, והמארח נקבע בצד Supabase בלבד.

**מה נעשה.** תוסף ‏Custom Domain (‏10$/חודש) הופעל על הפרויקט — הארגון `MSA-I` כבר על `pro`, ולכן
לא נדרש שדרוג תוכנית. הודעת הדחייה של ה־API לפני ההפעלה (`entitlement_required`) מנוסחת
„available on the Pro plan and above" ומטעה: היא נאמרת גם לארגון Pro שהתוסף עצמו חסר לו.

| רשומה ב־Cloudflare | ערך | הערה |
|---|---|---|
| `CNAME auth` | `rkftlbctohswhbbiaqin.supabase.co` | **`proxied=false` חובה.** ענן כתום שובר את האימות |
| `TXT _acme-challenge.auth` | אתגר ה־DCV שהנפיק Supabase | חד־פעמי; אין להעתיק ערך ישן |

**סדר שאסור להפוך:** ה־`CNAME` קודם — Supabase מסרב לאתחל בלעדיו („cannot be found"); ואת
ה־`redirect_uri` החדש מוסיפים ב־Google Cloud **לפני** ‏`Activate`, אחרת ההפעלה מפנה את גוגל לכתובת
שאינה מוכרת לו והכניסה נשברת. ה־client (‏project `inplace-506521`) נושא כעת גם
`https://auth.inplace.digital/auth/v1/callback`, והישן **לא נמחק**.

**הראיה, מדף גוגל עצמו** ולא מהתיעוד: ‏`GET /auth/v1/authorize?provider=google` ומעקב אחרי
ה־`Location` מחזיר דף שבו `data-app-name="inplace.digital"`, ‏`auth.inplace.digital` מופיע ו־
`supabase.co` **אינו מופיע כלל**. גוגל מקצר את התצוגה ל־apex.

**לא נדרשה בנייה או פריסה.** ‏`VITE_SUPABASE_URL` נשאר `https://rkftlbctohswhbbiaqin.supabase.co`
במכוון: ‏GoTrue בונה את ה־`redirect_uri` מכתובת ה־external שלו ולא מהמארח שאליו פנה הדפדפן, ולכן
**גם כניסה דרך המארח הישן מציגה כבר את הכתובת החדשה** — נמדד בשני המסלולים. החלפת המשתנה היא
ניקיון אופציונלי שדורש rollout של frontend, לא תנאי לתיקון.

**‏Apple נהנה מאותו תיקון** בלי עבודה נוספת — הוא עובר באותו `redirect_uri`.

**מה שנשאר פתוח:** גוגל מציג **דומיין**, לא „InPlace". שם ולוגו דורשים מילוי מסך ההסכמה
(‏`console.cloud.google.com/auth/branding`, ‏project `inplace-506521`) ואחריו אימות מותג מול גוגל,
שאורך ימים עד שבועות. עד האישור המסך ממשיך להציג `inplace.digital`, ולכן זו הכרעת בעלים ולא חסם.

**הזהות הנראית של המוצר היא סמל ה-favicon, לא אריח האפליקציה.** ‏`public/favicon.svg` ו-
`public/brand/inplace-app-icon.svg` נושאים את אותו Place Bay ונראים דומה במבט חטוף, אבל האריח
מוסיף רקע Onyx מעוגל שאינו מה שהמוצר מציג בלשונית הדפדפן. הכרעת בעלים 26.08.2026: **כל ייצוא
לוגו לצד שלישי נגזר מסמל ה-favicon**, והאריח נדחה במפורש אחרי שנבחר בטעות.

**‏Google consent screen — הקובץ בפועל הוא הווריאנט הלבן.** ‏`public/brand/inplace-symbol-paper.svg`
הוא אותו סמל ב-Paper במקום Onyx. נבחר בהכרעת בעלים 26.08.2026 מפני ש-`favicon.svg` הוא Onyx על רקע
שקוף, ומסך ההתחברות של גוגל — כפי שנצפה במכשיר הבעלים — מוגש על רקע כהה, שם הסמל הכהה כמעט נעלם.
הייצוא הוא PNG ‏120×120 ברקע שקוף, מרונדר ב-Chromium; אומת ויזואלית מול `#131314`.

> **הפשרה מתועדת ולא נפתרה:** גוגל אינו מאפשר שני לוגואים. סמל לבן על רקע שקוף נעלם על משטח
> **בהיר**, בדיוק כפי שהכהה נעלם על כהה. נבחר הצד שנצפה בפועל. אם יתברר שגוגל מגיש למשתמשים גם
> מסך בהיר, החלופה היחידה שעובדת בשני המצבים היא אריח האפליקציה — וזו סטייה מהכרעת ה-favicon,
> כלומר הכרעת בעלים מחדש ולא בחירה שקטה.

**שינוי שם פרויקט ה־Pages נשאר הכרעת בעלים פתוחה.** הפרויקט עדיין `supplyflow`; שינוי שם מזיז את
`*.pages.dev` ושובר את ה־CNAME, את ה־allowlist ואת ה־smoke.

> **הפרק הזה הוא הנוהל; המצב נמדד ב־§2.א.** ‏Runbook זה נכתב לפני שבוצע ולו שלב תצורה אחד, וניסוחו
> משקף את אותו רגע — כולל המשפטים "אף שלב תצורה בפרק לא בוצע" ותוויות ה־`לא בוצע` שבתוך השלבים.
> **ב־24.08.2026 הצעדים בוצעו בפועל**, והתוצאה **הנמדדת** — דומיין מאומת, ‏DKIM/SPF/DMARC, ‏SMTP של
> Auth ומסירה שנצפתה — נמצאת ב־§2.א ובראיות שמוזגו ב־PR #101. שם מקור האמת על מה שקיים.
>
> הנוהל נשאר במלואו, ולא נערך שלב־שלב: ערך הפרק הוא בסדר הפעולות, בתנאים המקדימים ובנימוקים שמאחורי
> כל שלב — אלה נכונים גם אחרי הביצוע, וישמשו שוב בסביבה נוספת או בדומיין נוסף. לא תיקנתי את תוויות
> הסטטוס אחת־אחת מפני שהיה בכך משום טענה על מה שהוגדר בפועל, ואת זה מודדים ולא כותבים מחדש.

> **גובר על שתי השורות הראשונות: הכרעת בעלים 23.08.2026 — ה-apex ‏`inplace.digital` ו-`www`
> נשארים לא מוגדרים, והכתובת היחידה המיועדת היא `app.inplace.digital`.** ראה §6.ב. הרשימה
> למעלה משקפת את נוסח #235 כפי שנכתב ב-22.08.2026 ונשמרת כהיסטוריה, לא כיעד.

האפליקציה והמפעיל חולקים origin/session, אך הרשאת המפעיל נשארת שרתית. מצב:
`PURCHASED / NOT_DELEGATED / DNS_NOT_CONFIGURED / AUTH_ALLOWLIST_NOT_CONFIGURED / NOT_DEPLOYED`.
הדומיין נרכש 23.08.2026 (§6.א) — **וזה כל מה שהוא.** לפני טענת זמינות נדרשים האצלת nameservers
ל-Cloudflare, ‏DNS, ‏Cloudflare Pages custom domain, ‏Supabase Auth redirect allowlist, התאמת
origins וסשן, ואז smoke אנונימי ומחובר.

## 6. Runbook תפעולי — דומיין, DNS, ‏Pages, ‏Auth ו־Resend. **אף שלב תצורה בו לא בוצע**

הפרק הזה הוא רשימת פעולות לביצוע, לא דיווח על ביצוע. כל שלב הוא מוטציה תפעולית אצל ספק חיצוני,
וכל שלב דורש **הרשאת בעלים מפורשת** ומבוצע בידי מי שמחזיק בפועל את חשבונות הרשם, ‏Cloudflare,
‏Supabase ו־Resend. סוכן אינו רוכש דומיין, אינו פותח חשבון, אינו מאציל nameservers, אינו כותב
רשומת DNS, אינו מפעיל SMTP ואינו שולח מייל חי — גם לא "מייל בדיקה אחד".

**מה כן קרה, ומה לא.** הבעלים **רכש** את `inplace.digital` ב-23.08.2026 (§6.א) — פעולת בעלים
מחוץ לפרק הזה. **אף שלב תצורה בפרק לא בוצע:** אין אזור ב-Cloudflare, אין האצלה, אין רשומת DNS,
אין custom domain, אין TLS, אין הגדרת Auth, אין חשבון או אימות ב-Resend, אין SMTP ואין מסירה.
הפעולה היחידה שסוכן ביצע כאן היא **קריאת RDAP** — פעמיים, קריאה בלבד.

**בעלות אינה תצורה, והכרעה אינה הפעלה.** אלה שני מצבים נפרדים, וכל טענה שמערבבת ביניהם שגויה.

לכל שלב יש **תנאי מקדים** מפורש. שלב שהתנאי שלו לא התקיים אינו "כמעט מוכן" — הוא חסום, וסדר
השלבים אינו המלצה סגנונית אלא תוצאה של כשלים ממשיים המתוארים ב-§6.ח.

### 6.א ‏ רכישת הדומיין (#234) — **נרכש; לא הואצל, לא הוגדר, לא אומת**

מצב מ-#234 בעת ההכרעה: `SELECTED / NO_REGISTRY_RECORD_AT_CHECK / NOT_PURCHASED / NOT_CONFIGURED`,
עם האזהרה "זמינות אינה נשמרת; אין טענת בעלות עד רכישה ו־DNS".

**המצב עכשיו: `PURCHASED / NOT_DELEGATED / NOT_CONFIGURED / NOT_VERIFIED`.** הדומיין בבעלות —
וזה כל מה שהוא. אין אזור ב-Cloudflare, אין רשומה, אין TLS, אין אימות ספק. **בעלות אינה תצורה.**

#### הקריאה הראשונה, ומה שגבר עליה

**‏(1) קריאת RDAP מקורית — 23.08.2026, ‏13:18:29 UTC, קריאה בלבד:**

| נקודת קצה | סטטוס HTTP | מה חזר |
|---|---|---|
| `https://rdap.org/domain/inplace.digital` | ‏`302` | הפניה ל־`https://rdap.identitydigital.services/rdap/domain/inplace.digital` (‏bootstrap של IANA לרשם `.digital`) |
| `https://rdap.identitydigital.services/rdap/domain/inplace.digital` | ‏`404` | אובייקט שגיאה תקני של RDAP: ‏`errorCode: 404`, ‏`title: "Object not found"` |

**‏(2) הקריאה הזו גברה עליה — הדומיין נרכש 65 דקות אחריה.** אומת בקריאת RDAP עצמאית שנייה,
23.08.2026 בשעה **18:51 UTC**, על אותה נקודת קצה:

| שדה RDAP | ערך |
|---|---|
| `ldhName` | `inplace.digital` |
| `events[registration]` | **`2026-08-23T14:23:27.101Z`** |
| `events[expiration]` | `2027-08-23T14:23:27.101Z` |
| `entities[registrar].fn` | **`NameCheap, Inc.`** (handle `1068`) |
| `nameservers` | `pdns1.registrar-servers.com`, `pdns2.registrar-servers.com` — **ברירת המחדל של הרשם** |
| `status` | `client transfer prohibited`, `add period` |
| `secureDNS.delegationSigned` | `false` — אין DNSSEC |

**שתי הקריאות נכונות, ואף אחת מהן אינה שגיאה.** ב-13:18:29Z לא הייתה רשומת רישום; ב-14:23:27Z
הייתה. זו ההדגמה הנקייה ביותר של האזהרה שכתובה ב-#234 עצמו: **‏`404` הוא עובדה על רגע, לא שריון.**
כל בדיקת זמינות מתיישנת ברגע שהיא מסתיימת. הרישום כאן היה של הבעלים — אבל אותם 65 דקות היו
מספיקים בדיוק באותה מידה לצד שלישי.

הערת שיטה: שתי הקריאות בוצעו ב-`curl` מפני ש-`WebFetch` קיבל `403` מ-`rdap.org` (חסימה ברמת
הכלי, לא תשובת רשם). לא נעשה שימוש בתוצאת חיפוש כתחליף לקריאת RDAP, ופרטי הרכישה לא נרשמו כאן
על סמך דיווח — הם נמדדו מול הרשם.

#### מה נותר לעשות — והשלב הראשון הוא האצלה, לא רשומה

**‏#234 נסגר.** הרכישה בוצעה, ואין יותר צורך לבדוק זמינות. כל מה שהיה "לפני הרכישה" בפרק הזה
אינו רלוונטי עוד.

השלב הבא **אינו** יצירת רשומות. ‏`nameservers` ברשם עדיין מצביעים על
`pdns1/pdns2.registrar-servers.com` — כלומר **‏NameCheap הוא עדיין ה-DNS הסמכותי של האזור.**
כל רשומה שתיווצר ב-Cloudflare לפני החלפת ה-nameservers היא רשומה באזור שאיש אינו שואל. ראה §6.ב.

### 6.ב ‏ רשומות DNS — מה מוגדר, ומה **הוכרע שלא** יוגדר

‏#235 כפי שהוא כתוב מונה ארבע כתובות: שיווקי `https://inplace.digital`; אפליקציה
`https://app.inplace.digital`; מפעיל `https://app.inplace.digital/operator`;
ו-`https://www.inplace.digital` שמפנה קנונית לשיווקי.

> **הכרעת בעלים מאוחרת יותר, 23.08.2026 — ‏`inplace.digital` (ה-apex) נשאר לא מוגדר.**
> **הכתובת היחידה המיועדת היא `app.inplace.digital`.** אין אתר שיווקי, אין הפניית apex, אין
> entry רביעי ב-build. **‏`www.inplace.digital` הולך בעקבות ה-apex** — גם הוא מחוץ לתחום.
>
> זהו **מצב מוכרע, לא שלב ממתין.** ‏`inplace.digital` ו-`www.inplace.digital` אינם "עוד לא
> הוגדרו" ואינם מחכים לאיש; הוכרע שהם לא יוגדרו. **החזרתם לתחום דורשת הכרעת בעלים חדשה** —
> ואין לגזור אותה מקיומו של שם הדומיין, מ-#235 כפי שהוא מנוסח, או מהיגיון "ממילא רכשנו".
>
> ההכרעה הזו **סוגרת** את הפער שנרשם כאן קודם ("אין אתר שיווקי ל-apex"): לא חסר ארטיפקט —
> לא נדרש ארטיפקט.
>
> **הערת עקביות:** נוסח #235 ב-`docs/OPEN-DECISIONS.md` טרם תוקן ועדיין מונה את ה-apex ואת
> ‏`www`. תיקון הרשומה שם הוא כתיבה של האורקסטרטור בלבד ואינו בסמכות הפרק הזה. עד שיתוקן,
> **ההכרעה המאוחרת גוברת** על הנוסח הישן, וכל קורא של #235 צריך להגיע לכאן.

**‏`/operator` הוא נתיב, לא subdomain.** ‏#235 ו-#161 קובעים שהאפליקציה והמפעיל חולקים origin וסשן,
ושגבול ההרשאה נשאר **בשרת** (`not_platform_admin`). ‏`public/_redirects` מתעד שהמפעיל אינו צריך שום
כלל, ו-`src/operator/main.tsx` מרכיב `HashRouter` כך שתתי-הנתיבים אינם מגיעים לשרת בכלל. **אין ליצור
subdomain מפעיל ואין "להקשיח" את הגבול הזה ב-DNS** — DNS אינו גבול הרשאה, והפרדה כזו רק תשבור את
הסשן המשותף בלי להוסיף אבטחה.

#### שלב 0 — האצלת האזור ל-Cloudflare. **תנאי מקדים לכל רשומה בפרק הזה**

> **הכרעת בעלים 23.08.2026: ה-nameservers עוברים ל-Cloudflare.** האזור מתארח ב-Cloudflare,
> לא ב-DNS של NameCheap. **אין ליצור רשומות בעורך הרשומות של NameCheap** — לא כ"בינתיים",
> לא כגיבוי. אזור אחד סמכותי, במקום אחד.

נכון לקריאת ה-RDAP ב-18:51 UTC, ה-nameservers ברשם הם עדיין `pdns1.registrar-servers.com`
ו-`pdns2.registrar-servers.com` — **ברירת המחדל של NameCheap.** כלומר האצלה טרם בוצעה.

1. **תנאי מקדים:** הדומיין בבעלות (בוצע) והרשאת בעלים לגשת לחשבונות NameCheap ו-Cloudflare.
2. ב-Cloudflare, בחשבון **שמחזיק את פרויקט ה-Pages**: ‏**Add a site** ← `inplace.digital`.
   ‏Cloudflare מקצה זוג nameservers ייעודי לאזור.
3. **ב-NameCheap** (פעולת רשם, בעלים בלבד): להחליף את זוג `registrar-servers.com` בזוג
   שהוקצה על ידי Cloudflare.
4. **להמתין להשלמת ההאצלה — ולמדוד אותה, לא לתזמן אותה.** החלפת nameservers אינה מיידית:
   עד שהרשם מפרסם את הזוג החדש והפותרים מפסיקים להשתמש בישן, **‏NameCheap נשאר הסמכות**, ושום
   רשומה שנוצרה ב-Cloudflare אינה נענית. הבדיקה היא קריאת RDAP חוזרת (`nameservers` מציג את
   ההאצלה אצל הרשם) ושאילתת NS ישירה — **לא שעון עצר, ולא "בטח כבר עבר".**
5. **רק אחרי שההאצלה הושלמה** ממשיכים ל-§6.ג ‏(Pages custom domain) ול-§6.ה ‏(רשומות Resend).

**‏DNSSEC — אין מלכודת כרגע, ויש אחת בהמשך.** ה-RDAP מדווח `secureDNS.delegationSigned: false`,
כלומר האזור אינו חתום ואין רשומת `DS` שהחלפת nameservers עלולה לשבור. אם DNSSEC יופעל ב-Cloudflare
אי-פעם, יידרש להוסיף רשומת `DS` **אצל NameCheap** — פעולת רשם נפרדת, ולא חלק מהמעבר הזה.

**רשומות שכן נדרשות — הרשימה המלאה, אין מעבר לה:**

| סוג | שם | ערך | Proxy | TTL | מתי הערך ידוע |
|---|---|---|---|---|---|
| ‏CNAME | `app` | ‏`<פרויקט Pages>.pages.dev` — כיום `supplyflow-baq.pages.dev` | Proxied | Auto | הפרויקט קיים; ראה אזהרת השם ב-§6.ג |
| ‏— | `app.inplace.digital/operator` | **אין רשומה.** נתיב באותו origin | — | — | — |
| ‏MX / TXT | רשומות **דואר** על השורש | ראה §6.ה — שליחה דרך Resend, וקבלת דוחות `rua` | ראה §6.ה | Auto | רק אחרי שהדומיין נוסף בלוח Resend / נבחר ספק התיבה |

**רשומות ה-`web` שהוכרע שלא ייכתבו:** ‏`CNAME`/‏custom domain ל-`inplace.digital` ‏(apex)
ו-`www`. אין להן שורה בטבלה למעלה בכוונה — טבלה היא רשימת פעולות, והן אינן פעולה ממתינה אלא
מצב מוכרע (ראה הקטע המסוגר בראש §6.ב). דרך המימוש של הפניית `www` אינה מפורטת כאן, גם לא כהערה,
כדי שלא תיקרא כהוראה רדומה.

**‏`MX`/`TXT` על השורש אינם חריגה מההכרעה הזו.** דואר ו-web הם שני משטחים על אותו שם: השורש יישא
רשומות דואר ולא יישא רשומת web, ולכן `https://inplace.digital` ימשיך לא להגיש דבר. ‏§6.ה מסביר
את ההפרדה במלואה. **אין לגזור מרשומת `MX` על השורש רשות להוסיף לו `CNAME`.**

מקור: ‏Cloudflare Pages custom domains (נקרא 23.08.2026,
`https://developers.cloudflare.com/pages/configuration/custom-domains/`) — ל-subdomain נדרש
`CNAME` אל `<YOUR_SITE>.pages.dev`. אותו עמוד מזהיר מפורשות שיצירת CNAME ידנית **בלי** לשייך
קודם את הדומיין בלוח Pages "will result in your domain failing to resolve" עם שגיאת `522`.
כלומר: **קודם לוח Pages, אחר כך DNS** — לא להפך.

**אזהרת `public/_redirects` — עומדת בפני עצמה, ואינה קשורה לשום הפניית דומיין.** הקובץ הזה חל רק
על בקשות שכבר מוגשות בידי פרויקט ה-Pages, והריפו כבר נשא לולאת הפניה מדודה: כלל `200` שיעדו קובץ
`.html` נחת על ה-308 הקנוני של Pages וחזר לעצמו "forever", ובגללו קונסולת המפעיל הייתה
בלתי-נגישה בייצור מרגע השילוח (‏`public/_redirects` שורות 1–15, מדידה מ-19.08.2026;
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

**מוכרע — שלושת ה-entries נשארים שלושה.** ההכרעה מ-23.08.2026 (§6.ב) מבטלת את הצורך ב-entry
רביעי ובפרויקט Pages שני: אין אתר שיווקי ואין הפניית apex. אין כאן ארטיפקט חסר, ואין כאן משימה
פתוחה — יש היעדר מכוון. **‏custom domain יחיד נוסף לפרויקט הקיים: `app.inplace.digital`.**

**אזהרה אחת שעדיין דורשת הכרעת בעלים:** שם פרויקט ה-Pages עדיין נושא את המותג שפרש
(`supplyflow-baq`). שינוי שם הפרויקט משנה את הכתובת הקנונית `*.pages.dev` ולכן שובר כל רשומה,
allowlist ו-smoke שמצביעים עליה. זו הכרעת בעלים, לא ניקוי בדרך.

**סדר הפעולות (‏`https://developers.cloudflare.com/pages/configuration/custom-domains/`, נקרא 23.08.2026):**

1. **תנאי מקדים:** הדומיין בבעלות (**בוצע**, §6.א); **ההאצלה ל-Cloudflare הושלמה ונמדדה**
   (‏§6.ב שלב 0 — **טרם בוצע**); ופרויקט Pages קיים ליעד. ניסיון להוסיף custom domain לפני
   שההאצלה הושלמה ייכשל או ייתקע ב-provisioning, כי Cloudflare עדיין אינו סמכותי לאזור.
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

**זה אינו סותר את §6.ב.** דואר ואתר הם שני משטחים נפרדים על אותו שם: רשומות `MX`/`TXT` לשורש
`inplace.digital` נדרשות כדי לשלוח מ-`no-reply@inplace.digital` (#237) **וכדי לקבל את דוחות
ה-`rua`** לתיבה `dmarc@inplace.digital` (ראה למטה) — ואינן גורמות לשורש להגיש תעבורת web.
**אין להסיק מהן שה-apex "בעצם כן מוגדר"** ואין לצרף אליהן רשומת `CNAME` או custom domain.
‏`MX` על השורש הוא יעד דואר; ‏`CNAME` על השורש הוא אתר. **‏#235 נשאר מוכרע מחוץ לתחום** — קבלת
דואר בשורש אינה פותחת אותו מחדש.

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
| ‏TXT ‏(DMARC) | `_dmarc` | `"v=DMARC1; p=none; rua=mailto:dmarc@inplace.digital;"` — **הוכרע במלואו**; ראה למטה | — | — | `Auto` |
| ‏MX ‏(+‏`TXT` של הספק) | `@` ‏(השורש) | יעד הדואר של `dmarc@inplace.digital`. **הערכים מגיעים מהספק שייבחר** — ראה למטה | לפי הספק | — | `Auto` |

**מלכודות Cloudflare מהתיעוד הרשמי של Resend (אותו עמוד):**

- ‏Cloudflare **אינו** מוסיף את הדומיין לשם הרשומה. להדביק `send`, לא `send.inplace.digital`.
- ה-DKIM חייב `DNS Only (disabled)`; אחרת Cloudflare מחזיר `Code: 1004`.
- לא לחזור על אותה `Priority` בשתי רשומות MX; אם `10` תפוס — `20` או `30`.
- ‏TTL: ‏`Auto` בכל הרשומות.

**רשומת ה-MX ל-`inbound` של Resend אינה נוספת.** היא שייכת למוצר ה-inbound של Resend, שנועד
לקלוט דואר **מדיירים** — ולזה אין משטח: ‏#237 קובע כתובת אחת בלי `reply-to`, ותשובות משתמש אינן
ערוץ עבודה. ‏**תיבת ה-`rua` היא דבר אחר לגמרי** (ראה למטה): היא מקבלת XML ממכונות, לא הודעות
מדיירים, והיא אינה עוברת דרך מוצר ה-inbound של Resend.

**זמן אימות:** ‏Resend מפרסם ש"your domain will often verify within 15 minutes of adding the DNS
records. However, DNS changes can occasionally take up to 72 hours to propagate globally". אין
לטעון "מאומת" לפני שהלוח מדווח verified.

**‏Resend ממליץ על subdomain, ‏#237 הכריע על השורש.** התיעוד אומר "We recommend sending your emails
from one or more subdomains (e.g., `updates.example.com`) instead of your root domain to isolate
your sending reputation". ‏#237 הכריע `no-reply@inplace.digital` — כלומר השורש. **ההכרעה עומדת**;
המתח מתועד כאן כדי שלא "יתוקן" בשקט בזמן הביצוע. שינוי דורש הכרעת בעלים חדשה.

#### ‏DMARC — ‏`p=none` הוכרע כ**שלב ראשון מכוון**, לא כברירת מחדל רפה

> **הכרעת בעלים 23.08.2026: ‏`p=none`.**

**הנימוק, ולמה הוא לא "לא עשינו כלום":** ‏`p=none` הוא **מצב ניטור**. הוא מפעיל את מנגנון הדיווח
של DMARC בלי להורות לאף שרת מקבל לזרוק או להסגיר הודעה. הסדר הזה מכוון: **קודם מודדים מי שולח
בשם הדומיין ומה עובר אימות, ורק אחר כך מחמירים.** ‏Resend מתאר את `p=none;` כ-"Allow all email.
Monitoring for DMARC failures" וממליץ מפורשות לעבור ל-`quarantine`/`reject` "only do this once you
know your messages are delivering and fully passing DMARC"
(`https://resend.com/docs/dashboard/domains/dmarc`, נקרא 23.08.2026).

הסיכון בכיוון ההפוך אינו תיאורטי: ‏`p=reject` שנקבע לפני מדידה גורם לשרתים מקבלים **להשמיד**
מייל לגיטימי שנכשל באימות מסיבה טכנית — הזמנת עובד או קישור פורטל שלא הגיעו, בלי bounce שמסביר
למה. במוצר הזה זה נופל ישירות על #114 (איפוס סיסמה שהעובד הוא היחיד שיכול לבצע) ועל #188 (הנפקה
חוזרת הורגת את הקישור הקודם).

**מה יצדיק מעבר ל-`quarantine` ואז ל-`reject` — זה שלב ראשון בתוכנית, לא הגדרה שנשכחה:**

1. דוחות ה-`rua` נאספים ונקראים בפועל לאורך תקופה מייצגת (לא יום אחד). **התנאי הזה בר-השגה
   מאז הכרעת תיבת ה-`rua`** — ראה הקטע הבא.
2. **כל** מקור שולח לגיטימי מזוהה ומאמת SPF **ו**-DKIM — כלומר Resend, ו-Auth SMTP דרך Resend,
   ואין שולח שלישי שנשכח.
3. שיעור הכשלים בדוחות יציב ליד אפס, והכשלים שנותרו מזוהים כזיוף ולא כתעבורה שלנו.
4. **‏`quarantine` לפני `reject`** — אף פעם לא קפיצה ישירה מ-`none` ל-`reject`.

**שינוי ה-`p=` הוא הכרעת בעלים חדשה** ומחייב רישום ב-`OPEN-DECISIONS`. אין להחמיר "כי זה מאובטח
יותר" בלי שהתנאים למעלה נמדדו.

#### תיבת ה-`rua` — הוכרעה, וזו הסיבה שה-`p=none` אינו קבוע

> **הכרעת בעלים 23.08.2026: תיבת דיווח ייעודית — `dmarc@inplace.digital`**, או forwarder ממנה
> לתיבה של הבעלים.

**זה אינו סותר את #237, וההבחנה היא כל העניין. אל "תתקן" את הסתירה לכאורה במחיקת תג ה-`rua`.**

| | ‏`reply-to` שאסור לפי #237 | תיבת `rua` שהוכרעה כאן |
|---|---|---|
| מי כותב לשם | **דייר / לקוח**, בן אדם | **שרתי דואר מקבלים**, מכונה |
| מה נשלח | הודעה חופשית בעברית | ‏XML של דוח aggregate לפי תקן DMARC |
| מי רואה את הכתובת | הדייר, בגוף המייל | **אף דייר לא.** היא חיה ברשומת DNS בלבד |
| מה נוצר אם אין מענה | ערוץ תמיכה שאיש אינו מאייש | כלום — אין מי שממתין לתשובה |

‏#237 אוסר ערוץ שדייר עלול לכתוב אליו ולצפות למענה אנושי. תיבת `rua` אינה ערוץ כזה: היא אינה
מופיעה באף מייל יוצא, אינה מוצגת בממשק, ואיש אינו מוזמן להשתמש בה. **משטח אחר, כלל אחר.**

**מה זה פותר — תנאי היציאה הפכו ברי-השגה.** ארבעת התנאים למעבר ל-`quarantine` שנכתבו למעלה
דורשים כולם נתונים מדוחות `rua`. **בלי יעד שנקרא, אף אחד מהם לא היה יכול להתקיים לעולם**, וה-`p=none`
היה קופא כמדיניות קבועה בתחפושת של שלב ראשון. עם התיבה הזו, המסלול `none → quarantine → reject`
הוא תוכנית עם צעד ראשון מוגדר ותנאי מעבר מדידים — לא הצהרת כוונות.

**מה שנדרש בפועל, ומה שעדיין לא ידוע:**

- קבלת דואר ב-`dmarc@inplace.digital` מחייבת **רשומת `MX` על השורש** `inplace.digital`, ובדרך כלל
  גם רשומת `TXT` לאימות מול ספק התיבה/ה-forwarder.
- **הערכים אינם נכתבים כאן.** הבעלים טרם בחר מימוש — תיבה ייעודית אצל ספק דואר, או forwarder
  (למשל Cloudflare Email Routing, שהוא הבחירה הטבעית כשהאזור ממילא עובר ל-Cloudflare). כל מימוש
  מפרסם רשומות משלו. **את הרשומות שולפים מהתיעוד הרשמי של הספק שייבחר, בזמן הביצוע** — אין לכתוב
  כאן ערכי `MX` מהזיכרון.
- זו **בחירת מימוש, לא שאלה עסקית פתוחה.** ההכרעה — שתהיה תיבה — התקבלה.

**מלכודת אחת שחייבת להירשם: לא לשים כתובת בדומיין אחר בתג ה-`rua`.** ‏`dmarc@inplace.digital`
נמצא באותו דומיין שמפרסם את רשומת ה-DMARC, ולכן אינו דורש דבר נוסף. אם מישהו יחליף אותו בכתובת
אישית בדומיין זר (‏Gmail וכדומה), התקן מחייב שהדומיין הזר יפרסם רשומת הרשאה — ‏RFC 7489 §7.1 קובע
שהשולח בונה שאילתה בצורת `[policy-domain]._report._dmarc.[destination-host]` ומצפה ל-TXT שמתחיל
ב-`"v=DMARC1"`, ושבהיעדרו **"the URI MUST be ignored by the Mail Receiver generating the report"**
(`https://datatracker.ietf.org/doc/html/rfc7489`, נקרא 23.08.2026). כלומר הדוחות פשוט לא יגיעו,
בשקט, ואיש לא ידע. **‏forwarder פנימי מ-`dmarc@inplace.digital` לתיבה של הבעלים אינו מפעיל את
הכלל הזה** — ההפניה קורית אחרי הקבלה, והכתובת בתג נשארת באותו דומיין. זו בדיוק הסיבה שהמימוש
הזה עדיף על הדבקת כתובת אישית ברשומה.

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
רכישה (בוצע) → האצלת nameservers ל-Cloudflare + מדידת השלמתה
      → ‏Cloudflare Pages custom domain (Active) → ‏HTTPS עונה על ה-origin החדש
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

‏`inplace.digital` ו-`www.inplace.digital` **אינם נבדקים** — הוכרע שהם לא יוגדרו (§6.ב). ‏smoke
שמנסה אותם אינו כשל של הפריסה, ואין "לתקן" אותו בהוספת רשומה.

**מחובר:** קריאה בלבד עם שלוש זהויות הבדיקה המאושרות ב-`CLAUDE.md`, והוכחת אפס כתיבות עסקיות.
זהויות שפרשו (`kitchen`, ‏`payer`, ‏`supplier`) חייבות להישאר חסומות.

**מלכודת פער ההתפשטות של הכתובת הקנונית.** הכתובת הקנונית עלולה להמשיך להגיש את ה-build **הקודם**
עוד זמן-מה אחרי העלאה מוצלחת. לכן בדיקת ה-parity היא **לולאת polling** עד להתאמה, לא בקשה אחת:
משווים את hash של ה-entry script בכתובת הקנונית מול הכתובת הייחודית של אותו deploy, וחוזרים עד
שהם זהים. בקשה בודדת שמחזירה את ה-hash הישן אינה "כשל פריסה" ואינה "הצלחה" — היא מדידה מוקדמת.
‏**המלכודת הזו אינה מתועדת ב-`docs/` נכון ל-23.08.2026** — היא נרשמת כאן לראשונה; רישום ב-DEBT הוא
פעולת האורקסטרטור.

### 6.י ‏ מצב סגירה

הטבלה הזו מערבבת שלושה דברים שאסור לבלבל ביניהם, ולכן העמודה האחרונה אומרת מה כל שורה:
‏**בוצע** הוא מה שקרה באמת; **שער סגור** הוא משימה שלא בוצעה; **מוכרע מחוץ לתחום** הוא משימה
שלא תבוצע.

**מצב הדומיין בשורה אחת: ‏`PURCHASED / NOT_DELEGATED / NOT_CONFIGURED / NOT_VERIFIED`.**

| שער | הכרעה | מצב 23.08.2026 |
|---|---|---|
| רכישת `inplace.digital` | #234 | **בוצע.** נרשם `2026-08-23T14:23:27Z` אצל `NameCheap, Inc.`, תפוגה `2027-08-23`. אומת ב-RDAP ב-18:51 UTC. **זו הבעלות בלבד** |
| האצלת nameservers ל-Cloudflare | הכרעת בעלים 23.08.2026 | **שער סגור.** ‏`NOT_DELEGATED`; הרשם עדיין מפרסם `pdns1/pdns2.registrar-servers.com`. אין אזור ב-Cloudflare |
| ‏DNS ל-`app` ולרשומות Resend | #235 | **שער סגור.** ‏`DNS_NOT_CONFIGURED`; שום רשומה לא נכתבה — ולא ניתן לכתוב לפני האצלה |
| ‏apex ‏`inplace.digital` + ‏`www` | הכרעת בעלים 23.08.2026 | **מוכרע מחוץ לתחום.** לא יוגדרו; אין אתר שיווקי ואין הפניה קנונית. אין כאן ארטיפקט חסר. החזרה לתחום = הכרעת בעלים חדשה. נוסח #235 טרם תוקן — תיקונו הוא כתיבת האורקסטרטור |
| ‏Cloudflare Pages custom domain ל-`app` | #235 | **שער סגור.** ‏`ROUTES_NOT_DEPLOYED`; לא נוסף אף custom domain |
| ‏Supabase Auth site URL + allowlist | #235, #114 | **שער סגור.** ‏`AUTH_ALLOWLIST_NOT_CONFIGURED`; ‏`config.toml` הוא ה-gate המקומי בלבד |
| אימות דומיין ב-Resend | #236 | **שער סגור.** ‏`DOMAIN_NOT_VERIFIED`; ‏SPF/DKIM/DMARC לא פורסמו |
| מדיניות DMARC | הכרעת בעלים 23.08.2026 | **הוכרע `p=none`** כשלב ניטור ראשון (§6.ה). **טרם פורסם** — אין רשומה. החמרה ל-`quarantine`/`reject` = הכרעה חדשה |
| תיבת `rua` לדוחות DMARC | הכרעת בעלים 23.08.2026 | **הוכרע `dmarc@inplace.digital`** (תיבה או forwarder). אינו סותר את #237 — יעד מכונה, לא ערוץ דייר (§6.ה). **שער סגור בביצוע:** אין תיבה, אין forwarder, אין `MX`. בחירת ספק המימוש עדיין פתוחה, ורשומותיו נשלפות מתיעודו בזמן הביצוע |
| שם פרויקט ה-Pages | — | **לא הוכרע.** עדיין `supplyflow-baq`; שינוי שם משנה את הכתובת הקנונית |
| ‏Supabase Auth SMTP | #236 | **שער סגור.** ‏`SMTP_NOT_CONFIGURED`; עדיין 2 מיילים/שעה ורק לכתובות הצוות |
| זהות שולח (`INVITE_FROM_EMAIL`, ‏`ORDERS_FROM_EMAIL`) | #237 | **שער סגור.** טרם הוכח כמוגדר לזהות המאומתת |
| ‏`APP_BASE_URL` / ‏`ALLOWED_ORIGINS` | #235 | **ללא שינוי — ובכוונה**, לפי אילוץ הסדר ב-§6.ח |
| מסירה חיצונית מוכחת | #236, #238 | **שער סגור.** ‏`NOT_LIVE`; לא נשלח מייל חי, גם לא לבדיקה |

**בעלות אינה תצורה, הכרעה אינה הפעלה, וחשבון אינו הפעלה.** שורה אחת בטבלה מסומנת "בוצע" —
הרכישה — והיא אינה מקנה דבר מעבר לבעלות על השם. כל שאר השורות סגורות או מוכרעות מחוץ לתחום.
**אין בפרק הזה טענה שמשהו הואצל, הוגדר, אומת או חי.**

---

## 7. זהויות פדרטיביות — **Google חי בייצור (25.08.2026); Apple כבוי ומעולם לא הופעל**

הקוד לשני המסלולים קיים ומאומת ביחידה. ל-Apple חסרים credentials, ובלעדיהם הכפתור אינו מצויר
כלל — דלת שמובילה ל-„הספק אינו מופעל" גרועה מהיעדר דלת.

> **המשתנה שמכריע אם הדלת נמצאת שם בכלל: `VITE_GOOGLE_SIGNUP_ENABLED`.** זהו דגל **בזמן בנייה** —
> ‏Vite מטמיע אותו ב-bundle — ולכן **סביבת בנייה שאינה נושאת אותו מייצרת מוצר בלי הכפתור, גם
> כשהספק מוגדר ועובד בשרת.** זה בדיוק מה שקרה כאן: הספק הודלק בייצור בבוקר, והאתר החי לא הציע
> Google במשך שעות, מפני שקובץ ה-`.env` של סביבת הבנייה לא הכיל את השורה. הוא **אינו** נכנס
> ל-Git; ‏`.env.example` מתעד אותו כדי שהחוסר יהיה גלוי במקום שקט.

**מי רשאי, ואיפה זה נאכף.** ‏`#265` (Google, ‏24.08.2026) ו-`#267` (Apple, ‏25.08.2026): זהות
פדרטיבית יכולה להיות **בעלים של ארגון חדש בלבד**. עובד מגיע מהזמנה ובסיסמה. האכיפה **אינה**
בכפתורים — הפעלת ספק ברמת הפרויקט הופכת את `/auth/v1/authorize` לנגיש לכל אחד. היא בשתי נקודות
בשרת: ‏`accept_invitation` מסרב לכל קורא שאינו `email` (‏`0205`, ‏`invite_requires_password_identity`),
והענף הפדרטיבי ב-`public-signup` מסרב לקורא שכבר יש לו פרופיל.

### 7.א ‏ Google — `DECIDED / IMPLEMENTED / PROVIDER_CONFIGURED / LIVE`

**עודכן 25.08.2026 — שני החצאים בוצעו, והכפתור חי באתר.** ‏`VITE_GOOGLE_SIGNUP_ENABLED=true`
נוסף לסביבת הבנייה, נבנה מחדש ונפרס; מסך הכניסה מציג „פתיחת עסק עם Google" עם שורת ההסבר
„לפתיחת עסק חדש. הצטרפות לעסק קיים נעשית מהזמנה שנשלחה אליך.", ואומת בצילום מסך בדסקטופ:

| מה | מצב |
|---|---|
| ‏Google Cloud Console — OAuth client | **בוצע.** שני ה־redirect URIs רשומים: ייצור ומקומי |
| ‏Supabase המרוחק — הספק | **בוצע** דרך Management API: ‏`external_google_enabled=true`, ‏`client_id`/`secret` מוזנים |
| ‏Supabase המרוחק — `uri_allow_list` | **בוצע.** נוסף `/signup` ל־`app.inplace.digital` ול־`supplyflow-baq.pages.dev` (‏`/reset-password` היה שם קודם) |
| אימות שרת | **בוצע.** ‏`/auth/v1/authorize?provider=google` מחזיר 302 ל־`accounts.google.com` עם ה־client_id הרשום, ‏`scope=email profile`, ‏`response_type=code`; ‏Google עונה בדף כניסה ולא ב־`invalid_client` |
| שומרי `0205` בייצור | **נמדדו לפני ההדלקה:** ‏`accept_invitation` מכילה `invite_requires_password_identity`; ‏`private.auth_identity_provider()` ו־`public.service_identity_has_profile(uuid)` קיימות |
| חזית הייצור | **בוצע 25.08.2026.** ‏`VITE_GOOGLE_SIGNUP_ENABLED=true` בסביבת הבנייה, בנייה ופריסה מחדש, ‏hash parity בשלוש הכתובות ו-smoke נקי. **המשתנה אינו בריפו** — הוא חי ב-`.env` של סביבת הבנייה בלבד, ולכן כל סביבה חדשה חייבת להגדיר אותו מחדש או המוצר יאבד את הכפתור בשקט |
| ‏`config.toml` בריפו | `enabled = false` **בכוונה** — שער האיכות מריץ `supabase start` בכל שינוי לקובץ, ו־`true` בלי הסודות ב־runner מפיל jobs שאינם קשורים ל־auth |

**מה שההדלקה בייצור אומרת, ומה שהיא לא.** הפעלת הספק הופכת את
`/auth/v1/authorize?provider=google` לנגיש לכל אחד באינטרנט — גם בלי כפתור. זר שיתחבר כך מקבל
**סשן בלי פרופיל**: ‏`auth_org()` לא מוצא לו שורה, כלומר אפס גישה, ו־`accept_invitation` מסרבת לו
בשם. זה בדיוק מה ש־`#265` תיאר מראש, ולכן נמדדו השומרים **לפני** ההדלקה ולא אחריה.

**מקומית, מקצה לקצה (25.08.2026):** כניסה עם חשבון Google אמיתי יצרה ארגון אחד, פרופיל `owner`
אחד, ‏`plan_key=free` לפי `#165`, קטגוריית בסיס `כללי`, ו־`private.product_events` עם
`signup.completed {"identity":"google"}`. כניסה חוזרת נוחתת במוצר ואינה יוצרת ארגון שני.

**מלכודת מקומית ששווה לדעת:** ‏`npm run dev` קושר **רק** ‏IPv6 ‏(`[::1]:5199`), ולכן
`http://127.0.0.1:5199` מסרב חיבור — בעוד ש־`site_url` ורשימת ההיתר של GoTrue המקומי הם על
`127.0.0.1`. לאימות OAuth יש להריץ `--host 127.0.0.1`.

#### פרטי ההקמה

| מה | ערך |
|---|---|
| ‏Google Cloud Console | ‏OAuth consent screen: `External`; scopes `userinfo.email` + `userinfo.profile` בלבד |
| ‏Authorized redirect URI — ייצור | `https://<project-ref>.supabase.co/auth/v1/callback` (המקור הקובע הוא דף הספק בדשבורד) |
| ‏Authorized redirect URI — מקומי | `http://127.0.0.1:55431/auth/v1/callback` |
| ‏Authorized JavaScript origins | **ריק בכוונה.** הזרימה היא authorization code בצד השרת; ‏GoTrue מבצע את ההחלפה, לא הדפדפן |
| סודות | ‏`SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` · `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET` |
| דגל חזית | ‏`VITE_GOOGLE_SIGNUP_ENABLED=true` |

שני ה-scopes אינם רגישים, ולכן **פרסום האפליקציה אינו דורש ביקורת אימות של Google**. כל עוד היא
במצב `Testing` רק כתובות ב-`Test users` נכנסות, וה-refresh token פג אחרי 7 ימים.

### 7.ב ‏ Apple — `DECIDED / IMPLEMENTED / NEVER_EXERCISED`

**זה לא אותו מצב כמו Google, ואסור לקרוא לו כך.** לגוגל חסרים רק ערכים; לאפל חסר **תנאי מקדים
שאינו בשליטת הפרויקט**: חברות ב-Apple Developer Program (‏$99 לשנה), שבלעדיה אי אפשר להנפיק
Service ID או מפתח חתימה. הקוד לא רץ מעולם מקצה לקצה מול Apple — לא מקומית ולא בייצור.

| מה | ערך |
|---|---|
| דרוש קודם | ‏Apple Developer Program פעיל |
| ‏`client_id` | ה-**Service ID**, לא ה-App ID |
| ‏`secret` | ‏JWT ‏ES256 ש-Supabase מנפיק ממפתח `.p8`; ‏**Apple מפקיע אותו כל 6 חודשים** — חובת רוטציה שאין לגוגל |
| נדרש בקונסולה | ‏App ID ← Service ID ← מפתח „Sign in with Apple" (`.p8`, ‏Key ID, ‏Team ID) ← אימות דומיין |
| ‏Return URL | `https://<project-ref>.supabase.co/auth/v1/callback` |
| סודות | ‏`SUPABASE_AUTH_EXTERNAL_APPLE_CLIENT_ID` · `SUPABASE_AUTH_EXTERNAL_APPLE_SECRET` |
| דגל חזית | ‏`VITE_APPLE_SIGNUP_ENABLED=true` |

**שני דברים שאפל עושה אחרת, ושניהם כבר מטופלים בקוד:**

1. **שם המשתמש מגיע רק בהרשאה הראשונה אי-פעם.** מסך ההרשמה מבקש שם עסק בכל מקרה, ו-`ownerName`
   נופל חזרה לכתובת הדואר כשאין שם — אותו fallback שכבר היה בענף Google.
2. **Private Relay.** משתמש יכול למסור `@privaterelay.appleid.com`. זו הכתובת היחידה שהסשן מוכיח,
   ולכן היא מוצגת כפי שהיא ונשמרת כפי שהיא. **מה שעדיין פתוח:** הכתובת מתה אם המשתמש מבטל את
   הגישה, ואז לארגון אין ערוץ דואר לבעלים — ראו `#267`.

**מה שלא נדרש, ולמה זה תכונה של `0205` ולא מזל.** הוספת Apple **לא דרשה מיגרציה**: השומר של
‏`0205` בודק `coalesce(private.auth_identity_provider(), 'email') <> 'email'`, כלומר הוא כבר מסרב
לכל זהות שאינה סיסמה, ו-`service_identity_has_profile` מעולם לא שאל באיזה ספק מדובר. הכלל נכתב
„פדרטיבי", לא „Google".

### 7.ג ‏ מה נדרש כדי לטעון שמסלול עובד

‏HTTP 200 או הופעת כפתור אינם הוכחה. לכל ספק בנפרד: כניסה חיה בדפדפן ← מסך ההרשמה מציג את
הכתובת שהספק הוכיח ← מתן שם עסק ← **ספירה במסד**: ארגון אחד, פרופיל `owner` אחד, קטגוריות בסיס.
ואז יציאה וכניסה חוזרת עם אותה זהות — נחיתה ישירה במוצר, **בלי ארגון שני**.
