# אירוח ה-OCR worker

ה-worker הוא התהליך היחיד בפרויקט שדורש מחשב שתמיד דלוק. הכול השאר מתארח: האתר ב-Cloudflare
Pages, מסד הנתונים וה-Edge Functions ב-Supabase. ה-worker מוריד את המסמך, הופך עמודים לתמונות,
שולח ל-OpenAI ומחזיר את התוצאה — ושש מתוך שבע הפעולות האלה דורשות מכונה משלנו.

עד 17.08.2026 הוא רץ על תחנת העבודה של הבעלים. זה תועד כחוב ב-`DEBT-REGISTER.md` §39.
המסמך הזה הוא הצד המעשי של הסעיף הזה.

## מפרט המכונה — נמדד, לא משוער

| מדד | נמדד על שני ה-workers החיים |
|---|---|
| זיכרון במנוחה | 56MB לכל worker |
| מעבד במנוחה | 0%–1% |
| גודל ה-image | 1.22GB |
| תקרת זיכרון לתהליך-בן | 2048MB (`OCR_MAX_MEMORY_MB`) |
| tmpfs לכל worker | 512MB + 64MB — **יושב ב-RAM** |

הצריכה במנוחה זניחה; מה שקובע הוא רינדור PDF לתמונות ותקרת ה-2GB לכל מסמך בטיפול. עם שני
workers ו-`OCR_PAGE_CONCURRENCY=3`:

- **מינימום מעשי:** 2 vCPU · 4GB RAM · 40GB SSD — ב-Hetzner זה סדר הגודל של CX22.
- **נוח:** 4 vCPU · 8GB RAM — נותן מקום לשלושה workers ולמסמכים סרוקים ארוכים.

אין צורך ב-GPU. ה-OCR עצמו רץ אצל OpenAI; המכונה הזאת היא לולאת polling ופרסרים נייטיביים.

## הקמה על Hetzner Cloud

```bash
# 1. שרת: Ubuntu 24.04, מיקום אירופה, ללא IPv4 ציבורי אם מספיק IPv6.
#    ה-worker הוא outbound-only ואינו מאזין לשום פורט.

# 2. Docker
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker          # חובה: בלי זה הפול לא יחזור אחרי reboot
usermod -aG docker "$USER"             # התנתק והתחבר מחדש

# 3. חומת אש: אין צורך לפתוח כלום פנימה. רק SSH.
ufw default deny incoming && ufw default allow outgoing
ufw allow OpenSSH && ufw --force enable

# 4. הקוד
git clone https://github.com/MSA-I/NIR-APP.git /opt/supplyflow
cd /opt/supplyflow

# 5. קובץ הסודות
install -d -m 700 /etc/supplyflow
cat > /etc/supplyflow/ocr.env <<'EOF'
SUPABASE_URL=https://rkftlbctohswhbbiaqin.supabase.co
OCR_WORKER_TOKEN=...
OPENAI_API_KEY=...
MISTRAL_API_KEY=...
EOF
chmod 600 /etc/supplyflow/ocr.env

# 6. הרמה
./scripts/run-ocr-worker.sh --replicas 2
```

**מפתחות לפי המנוע שנבחר.** הסקריפט דורש `OPENAI_API_KEY` רק כשמנוע כלשהו בפול הוא `openai`,
ו-`MISTRAL_API_KEY` רק כשמנוע כלשהו הוא `mistral`. פול שסיים לעבור ספק אינו נחסם בגלל קובץ מפתח
של ספק שאינו בשימוש.

### בחירת מנוע וקנרי

```bash
./scripts/run-ocr-worker.sh --canary mistral    # replica 1 על mistral, השאר על openai
./scripts/run-ocr-worker.sh --adapter mistral   # כל הפול על mistral
```

‏`--canary` דורש לפחות שתי replicas: קנרי שהוא כל הפול אינו קנרי אלא פריסה בלי ביקורת. מזהה
ה-worker נושא את שם המנוע (`supplyflow-<tag>-<index>-<adapter>`), מפני שהמזהה הוא מה שנרשם
ב-lease של הג'וב — בלעדיו שתי אוכלוסיות המסמכים אינן ניתנות להפרדה בדיעבד, וזה כל מה שקנרי אמור
לאפשר. הבחירה בין המנועים נשענת על `NIR-APP-DOCS/ocr-ab/20260818/triage-outcome.md`.

הסקריפט מסרב לרוץ אם `ocr.env` אינו `600`, ואם חסר בו טוקן. קובץ עם מפתח OpenAI שקריא לכולם הוא
כל המתקפה — לכן זו דחייה ולא אזהרה.

**עמידות ל-reboot** מגיעה מ-`--restart unless-stopped` יחד עם `systemctl enable docker`. אין
צורך ב-unit של systemd; הוספת אחד רק מכפילה את מקור האמת לגבי מי מרים את ה-containers.

## החלפת הפול הקיים — הסדר חשוב

1. להרים על Hetzner.
2. לוודא שהוא תופס עבודה: `docker logs --tail 20 supplyflow-ocr-live-1` וכן מסמך חדש שמסיים באתר.
3. **רק אז** לעצור את הפול הישן: על Windows `.\scripts\run-ocr-worker.ps1 -Status` ואז
   `docker rm -f supplyflow-ocr-live-1 supplyflow-ocr-live-2`, או `--stop` בגרסת ה-bash.

הסדר הזה אינו נימוס. שני פולים מול אותו פרויקט נלחמים על אותם ג'ובים, וזה בדיוק המצב שגרם
ב-17.08 לתקרה של 900 שניות להיראות כאילו היא עדיין 300: חלק מהג'ובים נתפסו על ידי image ישן,
ונדרשה שעת חקירה כדי להבין שהמדידה נכונה והמסקנה שגויה.

**לכל worker `OCR_WORKER_ID` ייחודי.** המזהה הוא ה-`lease_owner` של הג'וב; שניים עם אותו שם
יכולים לחדש אחד את ההחזקה של השני. לכן `docker compose up --scale worker=2` אינו מספיק —
הוא נותן לשניהם מזהה זהה. הסקריפטים מייצרים `supplyflow-<sha>-<index>`.

## עלות

ה-VPS בטווח הזה עולה סדר גודל של €5–15 לחודש; לאמת מול מחירון הספק, לא מול המסמך הזה.

**העלות המשמעותית היא OpenAI, לא השרת.** נמדד ב-`document_interpretations` בין 02.08 ל-17.08:
34 פירושים, 306,170 טוקני קלט, 102,395 פלט, ממוצע ~12,000 למסמך, מקסימום ~43,800.

**המספרים האלה הם שלב הפירוש בלבד.** עלות תמלול העמודים — התמונות שנשלחות ל-`v1/responses`,
‏2–3 מעברים לעמוד — **אינה נרשמת במסד** ולכן אינה ניתנת לגזירה מכאן. מסמך סרוק בן 27 עמודים
מגיע עד 81 קריאות מודל. את החשבון האמיתי רואים רק בלוח המחוונים של OpenAI.

לכן `docker-compose.ocr.yml` ממליץ במפורש על מפתח project-scoped עם תקרה חודשית: זו ההגנה
היחידה שממשיכה לעבוד כשהקוד טועה.

## מדריך למשתמש

גרסה בשפה פשוטה לבעלים, כולל צילומי המצב והסבר מה נעצר כשהמכונה כבויה, נמצאת מחוץ לריפו:
`NIR-APP-DOCS\מדריך העברת ה-OCR worker לשרת VPS.pdf` (ואותו תוכן כ-`.txt`).
