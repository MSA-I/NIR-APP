# מדריך פריסה ל-VPS — לסוכנים עתידיים

שרת אחד ב-Hetzner מריץ **שני** שירותים שאף שער, מיזוג או רולאאוט אינו נוגע בהם. המדריך הזה
מרכז את כל מה שצריך כדי לטפל בהם, כולל המלכודות שכבר עלו זמן. נכתב 02.09.2026 אחרי פריסת שירות
ה-render בפועל.

> **קרא קודם, פרוס אחר כך.** כל טענה כאן **נמדדה** בפריסה אמיתית, לא שוערה. שניים מהמסמכים
> הצמודים הם המקור לפרטים: `docs/OCR-WORKER-HOSTING.md` (OCR) ו-`docs/RENDER-WORKER-HOSTING.md`
> (render). המדריך הזה הוא השכבה שמעליהם — **איך ניגשים, מה המלכודות, ואיך מוודאים**.

---

## 1. מה רץ שם

| שירות | מקור | מודל | פורט | חוזה דו-צדדי |
|---|---|---|---|---|
| **OCR worker** ×2 | `worker/ocr` | **outbound-only** — מושך ג'ובים מהמסד | לא מאזין לכלום | `GATEWAY_CONTRACT_VERSION`, `SCAN_GATEWAY_CONTRACT_VERSION` |
| **render** | `worker/render` | **inbound** — נקרא ע"י `render-document` ה-Edge | `127.0.0.1:8091` מאחורי Caddy(TLS) | `RENDER_CONTRACT_VERSION` |

שני מודלים שונים = שתי דרישות רשת שונות. ה-OCR לא צריך שאף אחד יגיע אליו; render **חייב** נתיב
נכנס מוצפן. אל תערבב ביניהם.

---

## 2. גישה — המלכודת שתעלה לך זמן אם לא תקרא את זה

**המפתח מוצפן בסיסמה (passphrase).** זו הסיבה היחידה שסוכן אחד הכריז בטעות „אי אפשר להתחבר".

- קובץ המפתח: `NIR-APP-DOCS\SSH\id_ed25519` (‏ed25519, ‏comment `supplyflow-vps`).
- קובץ ה-passphrase: `NIR-APP-DOCS\passphrase for key.txt`.
- host: `95.217.134.162` · user: **`root`**.

**החתימה של הכשל:** ניסיון עם `BatchMode=yes` בלי passphrase נכשל, ו-`ssh -vv` מראה בדיוק:
```
debug1: Server accepts key: ... ED25519 ...   <- השרת מכיר את המפתח
root@95.217.134.162: Permission denied (publickey,password).   <- ה-client לא הצליח לחתום
```
`Server accepts key` ואז `Permission denied` = **המפתח נכון, ה-passphrase חסר** — לא מפתח שגוי,
לא user שגוי. אל תנחש שמות משתמש אחרים ואל תירה ניסיונות: יותר מכמה כשלים = חסימת IP (fail2ban)
על שרת ייצור.

**הבדיקה אם מפתח מוצפן** (הבדיקה „ENCRYPTED במחרוזת" **שגויה** לפורמט OpenSSH):
```bash
ssh-keygen -y -P "" -f <keyfile> >/dev/null 2>&1 && echo "no passphrase" || echo "needs passphrase"
```

**הדרך הנכונה להתחבר לא-אינטראקטיבית** — `ssh-agent` + `SSH_ASKPASS` שמזין את ה-passphrase:
```bash
KEY=/path/to/id_ed25519          # העתק לזמני עם chmod 600
PP=/path/to/passphrase.txt       # ה-passphrase בקובץ, לא ב-argv
printf '#!/usr/bin/env bash\ncat "$PP_FILE"\n' > askpass.sh; chmod +x askpass.sh
eval "$(ssh-agent -s)"
PP_FILE="$PP" DISPLAY=dummy:0 SSH_ASKPASS="./askpass.sh" SSH_ASKPASS_REQUIRE=force ssh-add "$KEY"
ssh -o BatchMode=yes -o StrictHostKeyChecking=no root@95.217.134.162 'whoami'
# בסוף: ssh-agent -k ; ומחק את העותקים הזמניים של המפתח וה-passphrase
```

**מלכודת נתיב Windows:** ‏Python `open('/c/Users/...')` **נכשל** — זה נתיב Git-Bash, לא Windows.
בתוך Python השתמש ב-`C:\Users\...`, או כתוב קבצים דרך redirection של bash.

---

## 3. איפה הכול יושב על השרת

| דבר | נתיב |
|---|---|
| ‏checkout של הריפו | `/opt/supplyflow` (‏detached HEAD; מ-שם בונים את שני ה-workers) |
| משגר ה-pool של OCR | `/opt/supplyflow/scripts/run-ocr-worker.sh` — **הוא** שמייצר את `supplyflow-ocr-live-N`. `docker-compose.ocr.yml` קיים ואינו בשימוש בייצור (§4) |
| ‏compose של render | `/opt/supplyflow/docker-compose.render.yml` (הקנוני מהריפו) |
| סודות OCR | `/etc/supplyflow/ocr.env` (‏600, root) |
| סודות render | `/etc/supplyflow/render.env` (‏600, root) |
| ‏Caddy | `/etc/caddy/Caddyfile` · לוגים `/var/log/caddy/` (בעלות `caddy:caddy`!) |

---

## 4. פריסה מחדש / שדרוג גרסה

**OCR** (ראה `docs/OCR-WORKER-HOSTING.md` לפרטים).
**‏`docker compose` אינו הדרך — נמדד ב-03.09.2026.** ה-pool החי אינו נולד מ-`docker-compose.ocr.yml`:
הוא שלושה־ארבעה דגלים של `docker run` שהסקריפט `scripts/run-ocr-worker.sh` מרכיב. ההבדל אינו
קוסמטי — ה-compose נותן `OCR_ADAPTER` ברירת מחדל **`disabled`** ו-`ocr.env` אינו מגדיר אותו, ולכן
`compose up` היה מחליף שני עובדים שעובדים על Mistral ב-pool בשם אחר שאינו מחלץ כלום. הסקריפט גם
נותן לכל replica `OCR_WORKER_ID` ייחודי, ושני עובדים עם אותו מזהה מחדשים זה את החכירה של זה.

```bash
cd /opt/supplyflow
git fetch origin main
git checkout origin/main -- worker/ocr scripts/run-ocr-worker.sh
SHA=$(git rev-parse --short origin/main)

# 1. לבנות מראש — ה-pool הישן ממשיך לשרת בזמן הזה.
docker build --tag "supplyflow-ocr-worker:${SHA}" worker/ocr
docker run --rm --entrypoint python "supplyflow-ocr-worker:${SHA}" self_check.py   # status: self_check_passed

# 2. אם גרסת החוזה זזה — לפרוס עכשיו את ה-Edge, ורק אז להחליף. ראה §5.

# 3. ההחלפה עצמה: הבנייה כאן היא cache hit, ולכן זה שניות.
./scripts/run-ocr-worker.sh --adapter mistral --tag "$SHA"
docker logs --tail 20 supplyflow-ocr-live-1
```
> **‏`--adapter mistral` אינו קישוט.** ברירת המחדל של הסקריפט היא `openai`, ומנוע ה-OCR הפעיל
> בייצור הוא Mistral (‏`docs/LOCAL-CREDENTIALS-PATH.md`). השמטת הדגל מחליפה ספק בשקט.
> ‏`--tag` נדרש מפני שה-checkout הוא detached ו-`HEAD` שלו אינו הקומיט שממנו בונים.

**render** (ראה `docs/RENDER-WORKER-HOSTING.md`):
```bash
cd /opt/supplyflow
git fetch origin main && git checkout origin/main -- worker/render docker-compose.render.yml
docker compose --env-file /etc/supplyflow/render.env -f docker-compose.render.yml up -d --build
curl -s http://127.0.0.1:8091/health          # {"ok":true,"contract":"<n>"}
```
> **החלף רק את ה-subtree, לא את כל ה-checkout.** `git checkout origin/main -- <path>` מושך רק את
> מה שצריך ולא מזיז את ה-HEAD ולא נוגע בשירות השני.

---

## 5. מלכודת החוזה הדו-צדדי — זו שהשביתה ייצור לחמישה ימים

לכל שירות מספר גרסת חוזה **בשני צדדים**. העלאה בצד אחד בלבד **משביתה בשקט**: ה-container מדווח
`Up`/`healthy`, ונכשל בכל קריאה על אי-התאמה. `Up` **אינו ראיה**.

| שירות | צד worker | צד Edge |
|---|---|---|
| document-processing | `worker/ocr/src/gateway.py` | `supabase/functions/document-processing/contract.ts` |
| document-preprocessing | `worker/ocr/src/scan_gateway.py` | `supabase/functions/document-preprocessing/contract.ts` |
| render | `worker/render/src/contract.mjs` | `supabase/functions/render-document/contract.ts` |

כשמשנים חוזה: לשנות **בשני הצדדים**, לפרוס את שניהם, ולוודא ש-`/health` (render) או `job_claimed`
ביומן (OCR) מחזירים את הגרסה החדשה **לפני** שמכריזים שהצליח. `check:*` ב-CI משווה את הליטרלים,
אבל CI אינו נוגע ב-VPS — הפריסה בידיים.

---

## 6. הסודות — יש שני מקומות, ורולאאוט אחד כבר פספס אחד מהם

לכל שירות **שני** סטים של סודות, ושניהם חייבים להיות מוגדרים:
1. **צד ה-worker** — ב-`/etc/supplyflow/<service>.env` על השרת.
2. **צד Supabase** — סודות הפרויקט, ש-ה-Edge קוראת.

עבור render: `RENDER_SERVICE_URL` ו-`RENDER_SERVICE_TOKEN` **בשני המקומות** (הטוקן זהה). ב-02.09.2026
הרולאאוט פרס את `render-document` **בלי שני הסודות ב-Supabase** — הפונקציה ענתה
`renderer_not_configured` (503) לכל בקשה, בשקט. **בדיקת סוד = לרשום את מה שכל 11 הפונקציות
קוראות מול מה שמוגדר**, לא רק את מה שהשתנה. קריאת הסודות:
```bash
curl -s -H "Authorization: Bearer <MGMT_TOKEN>" \
  "https://api.supabase.com/v1/projects/rkftlbctohswhbbiaqin/secrets" | python -c "import sys,json;print(sorted(s['name'] for s in json.load(sys.stdin)))"
```
(‏`MGMT_TOKEN` = `AI\API\NIR-TOKEN-SUPABASE.txt`. ה-API מחזיר hash של הערכים, לא plaintext.)

---

## 7. רשת ו-TLS (render בלבד)

render נקרא מבחוץ, ולכן צריך נתיב נכנס מוצפן. הבחירה שבתוקף (הכרעת בעלים 02.09.2026, אפשרות ב׳):

- **DNS:** `render.inplace.digital` — רשומת A ב-Cloudflare, **DNS-only (לא proxied)**, מצביעה ל-IP.
  (טוקן Cloudflare: `AI\API\CF-TOKEN-DOMAINS.txt`; zone `inplace.digital`.)
- **TLS:** Caddy עם Let's Encrypt (HTTP-01, חידוש אוטומטי). מסיים TLS ומעביר ל-`127.0.0.1:8091`.
- **UFW:** נכנס `22`, `80`, `443` בלבד. ה-container קשור ל-loopback; **אין** פורט render פומבי.

**מלכודת Caddy שעלתה:** `/var/log/caddy` נוצר בבעלות root אבל Caddy רץ כמשתמש `caddy` →
`permission denied` וה-service נופל. תיקון: `chown -R caddy:caddy /var/log/caddy`.

> אם אי-פעם עוברים לאפשרות א׳ (פורט פומבי ישיר) — הטוקן ותוכן המסמך עוברים בטקסט גלוי. זה נדחה
> ב-02.09.2026. אל תחזור לזה בלי הכרעת בעלים מחודשת.

---

## 8. אימות — „עובד", לא „רץ"

- **render:** ‏`/health` חיצוני מחזיר `{"ok":true,"contract":"<n>"}` עם תעודה תקפה, **ו**ייצוא חי
  מקצה-לקצה: התחברות כ-`owner@gamos.demo` (הרשאת בעלים, `docs/LOCAL-CREDENTIALS-PATH.md`), קריאה
  ל-`render-document` עם `{"path":"/reports","orientation":"portrait","fileName":"..."}` —
  **השדה `fileName`, לא `file_name`** — ומצפים ל-`HTTP 200 application/pdf`.
- **OCR:** לא `Up`, אלא `job_claimed`+`job_completed` ביומן, או השוואת
  `document_extractions.max(created_at)` מול `documents.max(created_at)` במסד. אם שניהם ישנים
  ואין תור — המערכת פשוט לא פעילה, לא ה-worker מת.

---

## 9. בטיחות — לא לשבור שרת ייצור חי

- **אל תירה ניסיונות SSH.** כשל = קרא את `ssh -vv`, אל תנחש. fail2ban ינעל אותך.
- **קרא סודות בזמן ריצה בלבד.** אל תדפיס מפתח/passphrase/token לצ'אט, ללוג, לארטיפקט או ל-Git.
  אחרי העבודה — מחק כל עותק זמני של מפתח/passphrase/token מה-scratchpad, והרג את `ssh-agent`.
- **החלף subtree, לא checkout.** לעולם אל תריץ `git reset --hard` או `git checkout <branch>`
  מלא על `/opt/supplyflow` — זה עלול להזיז את מקור שני השירותים בבת אחת.
- **שנה firewall במודע.** לפני `ufw allow`, שאל אם המודל (outbound-only מול inbound-TLS) באמת
  דורש את זה. סגור פורט שפתחת זמנית.

---

## 10. מה המדריך הזה מכוון אליו, ומה לא

- **מכוון:** גישה, פריסה מחדש, מלכודת החוזה, שני מקומות הסודות, TLS, אימות, בטיחות.
- **לא כאן:** ערכי סודות (ב-`docs/LOCAL-CREDENTIALS-PATH.md` בלבד), והקמת שרת **חדש** מאפס
  (ב-`docs/OCR-WORKER-HOSTING.md` §הקמה).
