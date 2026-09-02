# GATES — Paddle Sandbox integration (feat/paddle-sandbox-integration-20260831)

Owner ruling 31.08.2026: option **ב** — the live round trip runs against the LOCAL stack with a
temporary tunnel. No permanent enablement switch was added; nothing in production billing was
touched. Paddle **Sandbox only**. Live is out of scope in every gate below.

Evidence run: `scripts/paddle/sandbox-e2e.mjs`, 23/23, 31.08.2026, every event generated, signed
and delivered by Paddle over the internet to the deployed `billing-webhook` source.

| # | Gate | Status | Evidence |
|---|------|--------|----------|
| G1 | Sandbox catalogue exists and is deterministic | **PASS** | 3 products / 6 prices; re-run created nothing (`reuse` on all 9) |
| G2 | Plan mapping is server-side and complete | **PASS** | `0277` + `verify-catalogue-matches-db.mjs` 6/6 from both sides |
| G3 | Adapter makes real Sandbox calls | **PASS** | customer created + portal session returned live; transaction blocked by G13b |
| G4 | Secrets are server-side only | **PASS** | `check-paddle-secrets.mjs`, verified with 3 negative controls |
| G5 | Paddle.js loads Sandbox only | **PASS** | `src/lib/paddle.ts`; mismatched token/env pair refuses |
| G6 | Webhook destination registered | **PASS** | `ntfset_01m1c4hn3bkszwwxqazngpn8dn`, 21 events read from `billing_event_types` |
| G7 | Signature verification over raw body | **PASS** | real Paddle deliveries accepted; forged + stale refused (403) |
| G8 | Customer→org attribution is server-written | **PASS** | e2e §1, `p100` §4 |
| G9 | Entitlement changes only from verified events | **PASS** | `billing-checkout/core.test.ts`, `orgSubscriptionPaddle.spec.tsx` |
| G10 | Idempotency + replay | **PASS** | e2e §2 and §6 |
| G11 | Unknown customer / unknown price fail safe and visible | **PASS** | e2e §5, dead-letter reasons |
| G12 | Tenant isolation | **PASS** | e2e ×4 + `p100` §5 |
| G13 | Live sandbox round trip (events) | **PASS** | 23/23 |
| G13b | Live sandbox round trip (real card payment) | **ABANDON:** `transaction_default_checkout_url_not_set` — a Paddle **dashboard** setting with no API surface. Owner action; recorded in `DEBT §57` and the PR rather than skipped silently |
| G14 | Repo quality gates | **PASS** locally: build clean, 16/16 `verify` guards, 205 files / 2152 Vitest, `p71` + `p100` green. `check:dead-code` (knip) exits 1 **on clean `origin/main` too** — measured, pre-existing, environmental (shared `node_modules` junction), not touched per the "no unrelated fixes" rule. CI is authoritative |
| G15 | Docs/DEBT/OPEN-DECISIONS updated, nothing marked live-ready | **PASS** | `docs/PADDLE-SANDBOX.md`, `DEBT §57` rewritten, `#213` gains `SANDBOX_PROVEN` with ACCOUNT/KYC/PAYOUT/LIVE still spelled NOT_PROVEN |

## What this branch deliberately did NOT do

- did not enable a merchant of record anywhere; production's boundary is byte-for-byte unchanged
- did not add any permanent mechanism capable of enabling one
- did not touch Paddle Live, production secrets, DNS, Resend, Google Workspace or support email
- did not delete or reconfigure the pre-existing sandbox destination aimed at production
  (`ntfset_01m1c484xq646vsg0fkg8fm7h0`) — not created by this work, flagged for an owner decision

# GATES — חיבור שירותים חיצוניים (צד המייל)

ענף: `claude/external-services-integration-7ee6d9` · 31.08.2026

**היקף הענף צומצם בהכרעת בעלים.** ‏Paddle התגלה כמשימה של סוכן מקביל
(`feat/paddle-sandbox-integration-20260831`), והוכרע ששני PR נפרדים עדיפים על תיאום בזמן אמת על
אותם קבצים. הענף הזה מוסר את **המייל בלבד**; ‏`billing-adapter.ts` הוחזר למצבו ב-`main`.

התצורה החיצונית שכן בוצעה כאן (סודות ויעד webhook) נשארת — היא נחוצה לשני הענפים.

## A — אודיט (הושלם)

- [x] A1 — ‏Edge Functions ושמות סודות מה-Management API (ערכים לא הודפסו מעולם)
- [x] A2 — ‏MX/SPF/DKIM/DMARC של `inplace.digital` ו-`app.inplace.digital` מול 8.8.8.8
- [x] A3 — ‏Resend: דומיין `verified`, ‏**אפס** webhooks, שני מפתחות
- [x] A4 — ‏Cloudflare: ‏Email Routing `ready` עם **שני** כללים בלבד
- [x] A5 — ‏Paddle: בתחילת הקמפיין לא היה חשבון; הבעלים פתח sandbox ב-31.08 ומסר מפתחות
- [x] A6 — נמצא: ‏Workspace קיים אך על `app.inplace.digital`, לא על השורש

## B — תצורה חיצונית שבוצעה

- [x] B1 — ‏`ORDERS_FROM_EMAIL` הופרד ל-`InPlace <orders@inplace.digital>` · נקרא חזרה
- [x] B2 — ‏Resend webhook נוצר ומופעל אל `email-webhook`, ארבעה אירועי מסירה · נקרא חזרה
- [x] B3 — ‏`RESEND_WEBHOOK_SECRET` הותקן · **נמדד:** הנקודה עברה מ-`500 misconfigured` ל-`403`
      על חתימה חסרה, כלומר אימות אמיתי
- [x] B4 — יעד התראות ב-Paddle (`ntfset_01m1c484…`) אל `billing-webhook` בייצור, 11 אירועים
- [x] B5 — ‏`PADDLE_WEBHOOK_SECRET` · `PADDLE_API_KEY` · `PADDLE_ENVIRONMENT=sandbox` ·
      ‏`BILLING_PROVIDER=paddle` · **נמדד:** `billing-webhook` עבר מ-`503` ל-`403`
- [x] B6 — הוכחת מסירה חיה: מייל אחד יצא ו-Resend החזיר `delivered`, עם ה-`Reply-To` נשמר
- [ ] B7 — `BLOCKED:` ארבעת כללי הניתוב (`support@` וחבריו) — ה-harness חסם. ‏`§95` (נרשם אז כ-`§86`)

## C — קוד (מייל בלבד)

- [x] C1 — ‏Reply-To: מייל מוצר → `support@`; הזמנה לספק → הדייר
- [x] C2 — הכתובת נפתרת מזהות מאומתת בשרת, מאומתת מול header injection, ‏fallback מתועד (`#309`)
- [x] C3 — משטח תמיכה במוצר (`/settings`, `/settings/subscription`)
- [x] C4 — מייל הפעלת מנוי אידמפוטנטי (`0281` + `billing-webhook`)
- [x] C5 — בדיקות לכל אחד מהסעיפים
- [~] **הוסר מהענף:** פעולות Paddle החיות ב-`billing-adapter.ts` ובדיקותיהן. הן קיימות בענף
      המקביל, ביחד עם מיפוי המחירים ו-`billing-checkout`.

## D — שערים

- [x] D1 — `npm run typecheck` — נקי
- [x] D2 — חוזי Deno בקונפיג של השער ובנעילה קפואה — **182 עברו / 0 נכשלו**
- [x] D3 — ‏`p103` מול Postgres מקומי — **שבעה מקרים**; עבר גם ב-CI
- [x] D4 — ‏CI על ‏PR #180: ‏`build`, ‏`verify`, ‏`Deno contracts` עברו
- [x] D5 — השוואה מול הבסיס (‏`§85`): כשלי SQL והדפדפן **זהים** לאלה של `main`
      *(‏01.09.2026: שני הבסיסים נסגרו — `§85` ו-`§92`; `main` ב-`d9146bf4` ירוק בשניהם.)*
- [ ] D6 — `BLOCKED:` ‏`npm run quality` המלא לא רץ מקומית (בלעדיות על stack משותף); רץ ב-CI

## E — חסום מחוץ לקוד

- **Workspace** — קונסולת אדמין = סיסמה, ואסור לי; והדומיין הרשום הוא `app.inplace.digital`.
  ‏`§88` · `#329`
- **‏`support@` אינה מקבלת דואר** — והמוצר כבר מפרסם אותה. ‏`§95` (נרשם אז כ-`§86`)
- **‏Paddle live** — ‏sandbox פעיל, אבל KYC, payout ישראלי וקטלוג ILS לא הוכחו. ‏`#213` נשאר.
- **פריסת Edge** — לא נפרסה מהענף הזה: זרימת העבודה היא PR → main → פריסה
