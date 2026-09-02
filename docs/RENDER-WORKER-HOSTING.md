# אירוח שירות ה-render — נפרס 02.09.2026

מקביל ל-`docs/OCR-WORKER-HOSTING.md`. השירות מרנדר מסך של האפליקציה ל-PDF עם טקסט אמיתי
(‏`§68`) ומטביע סימן מים בצד שרת (`§72`). הוא רץ על **אותו VPS** כמו ה-OCR worker.

> **כמו ה-OCR — נפרס ביד, ואף שער אינו נוגע בו.** מיזוג ל-`main`, שער איכות או רולאאוט Pages
> לא יעדכנו את המכונה הזאת. אם `RENDER_CONTRACT_VERSION` זז בצד אחד בלבד
> (`worker/render/src/contract.mjs` מול `supabase/functions/render-document/contract.ts`),
> ‏CI מפיל את זה, השירות עונה `render_contract_mismatch` במקום להיכשל בשקט, ו-`/health` מחזיר
> את הגרסה שהוא באמת מריץ. זו בדיוק המלכודת שהשביתה את עיבוד המסמכים ב-`a3603c0`.

## הבחירה: TLS מאחורי reverse proxy (אפשרות ב׳)

בניגוד ל-OCR worker, שהוא outbound-only ומושך עבודה מהמסד, שירות ה-render **נקרא** על ידי
`supabase/functions/render-document` (מודל push). לכן הוא חייב נתיב נכנס. הבעלים בחר (02.09.2026)
ב-**TLS מאחורי reverse proxy** ולא בפורט פומבי גלוי: הטוקן ותוכן המסמך של הדייר לעולם אינם
עוברים בטקסט גלוי. זו גם הכוונה שכתובה ב-`docker-compose.render.yml` עצמו:
„no business listening on a public interface … must arrive through the reverse proxy that
terminates TLS".

## הרכיבים החיים (נמדד 02.09.2026)

| רכיב | ערך |
|---|---|
| שרת | ‏Hetzner `95.217.134.162` (‏`docker-ce-ubuntu-8gb-hel1-1`), אותו VPS כמו OCR |
| דומיין | `render.inplace.digital` — רשומת **A, DNS-only** ‏(Cloudflare, לא proxied), מצביעה ל-VPS |
| ‏TLS | ‏Caddy v2, תעודת Let's Encrypt אמיתית (‏HTTP-01), חידוש אוטומטי |
| ‏proxy | ‏`/etc/caddy/Caddyfile`: `render.inplace.digital → 127.0.0.1:8091` |
| container | ‏`inplace-render-render-1`, image `inplace-render:local`, **healthy** |
| bind | ‏`127.0.0.1:8091:8080` — **loopback בלבד**; אין פורט פומבי על 8080 |
| compose | ‏`/opt/supplyflow/docker-compose.render.yml` (הקנוני מהריפו), מורם עם `--env-file /etc/supplyflow/render.env` |
| סודות worker | ‏`/etc/supplyflow/render.env` (‏600, root): `PORT`, `RENDER_SERVICE_TOKEN`, `RENDER_APP_URL=https://app.inplace.digital` |
| סודות Supabase | `RENDER_SERVICE_URL=https://render.inplace.digital`, `RENDER_SERVICE_TOKEN` (זהה ל-worker) |
| ‏UFW | נכנס: `22`, `80`, `443` בלבד. ‏`8080` **נסגר** אחרי המעבר ל-loopback |

## הראיה שזה עובד, לא שזה רץ

ייצוא חי מקצה-לקצה, `owner@gamos.demo` → `render-document` Edge → Caddy(TLS) → worker →
Chromium טוען `https://app.inplace.digital/reports` עם ה-session של הקורא → **PDF, ‏HTTP 200,
‏~373KB, ‏~14 שניות**. חוזה 1 בשני הצדדים; `/health` החיצוני מחזיר `{"ok":true,"contract":"1"}`
עם תעודת Let's Encrypt תקפה. שדה הבקשה הוא `fileName` (לא `file_name`).

## פריסה מחדש / שדרוג גרסה

```bash
# על VPS, כ-root:
cd /opt/supplyflow
git fetch origin main && git checkout origin/main -- worker/render docker-compose.render.yml
docker compose --env-file /etc/supplyflow/render.env -f docker-compose.render.yml up -d --build
curl -s http://127.0.0.1:8091/health   # expect {"ok":true,"contract":"<n>"}
```

**כלל החוזה:** אם משנים `RENDER_CONTRACT_VERSION`, לשנות בשני הצדדים ולפרוס את שניהם באותו
רולאאוט. ‏`/health` חייב להחזיר את הגרסה החדשה **לפני** שמכריזים שהפריסה הצליחה.

## מה אינו כאן

- **גישה ל-VPS** (מפתח, passphrase, host, user) — ב-`docs/LOCAL-CREDENTIALS-PATH.md` בלבד, לא כאן.
- **הטבעת סימן מים אומתה מבנית ולא נכפתה על ייצוא מסומן**: הייצוא החי היה של owner, ש-
  `my_export_watermark` מחזיר לו את ערכו לפי התוכנית; מסלול ההטבעה חי, אך ייצוא עם `watermark=true`
  לא אולץ בנפרד. ראה `§72`.
