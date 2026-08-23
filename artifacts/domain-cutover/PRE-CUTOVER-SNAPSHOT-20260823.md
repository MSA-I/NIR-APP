# Pre-cutover snapshot — `app.inplace.digital`

Captured 23.08.2026 (evening, local time) directly from live infrastructure, before any change.
Read-only. No secret value is recorded here; secrets appear as name + presence only.

This file is the rollback reference for the cutover. Everything below was **measured**, not read
out of project documentation — several documented claims turned out to be stale (see §7).

## 1. Git

| Item | Value |
|---|---|
| Repository | `MSA-I/NIR-APP` |
| `origin/main` | `f0c5cd226087de81d4d55c9c96241c9c18422f8f` (`f0c5cd2`) |
| Local `HEAD` at capture | `35edc3f` on `feat/supplier-order-portal` |
| Working tree | 6 modified files under `docs/`, uncommitted (decision round of 22–23.08) |
| Commit currently deployed to production | `15baeac` |
| Delta `15baeac..origin/main` | 2 commits, `docs/PROGRESS.md` + `docs/DEBT-REGISTER.md` only — **no product code** |

## 2. Cloudflare

| Item | Value |
|---|---|
| Account | `Studentmoshe@gmail.com's Account` — `7787d2e04e755ec655f8506124aa0ecf` |
| Auth used by this agent | wrangler 4.125.0 OAuth session (`pages: write`, **`zone: read` only**) |
| Pages project | `supplyflow` |
| Canonical Pages hostname | `supplyflow-baq.pages.dev` |
| Custom domains | **none** — confirmed twice: `wrangler pages project list` shows only the `pages.dev` hostname, and the Pages domains API returns an empty list |
| Current production deployment ID | `e851dbe8-fcc6-450d-b5b8-d80aace67da0` |
| Its source | branch `main`, commit `15baeac`, ~16 h before capture |
| Previous production deployment (rollback target) | `16cd6e2c-a48e-4145-8f53-6a7fb1d01da0` — `22910e7` |
| Pages environment variables | none required by the frontend beyond the Vite build inputs; the bundle is origin-agnostic (see §5) |
| Redirect rules for `inplace.digital` | none |

### 2.1 The zone — it already exists (measured with the owner-supplied API token)

| Item | Value |
|---|---|
| Zone | `inplace.digital` — id `82a4bdef942f4f4393d17b516fce7b5a`, type `full` |
| Status | **`pending`** — `activated_on: null`; Cloudflare is not authoritative yet |
| Assigned Cloudflare nameservers | **`clyde.ns.cloudflare.com`**, **`rose.ns.cloudflare.com`** |
| `original_name_servers` | `pdns1.registrar-servers.com`, `pdns2.registrar-servers.com` |
| `original_registrar` | `namecheap, inc. (id: 1068)` |

**The zone-scan imported NameCheap's default records**, including two web records that would make the
brand apex serve a parking page the moment delegation completes — directly against the owner ruling
that the apex and `www` stay unconfigured:

| Type | Name | Content | Proxy |
|---|---|---|---|
| `A` | `inplace.digital` | `192.64.119.114` (NameCheap parking) | **proxied** |
| `CNAME` | `www.inplace.digital` | `parkingpage.namecheap.com` | **proxied** |
| `MX` ×5 | `inplace.digital` | `eforward1..5.registrar-servers.com` | DNS only |
| `TXT` | `inplace.digital` | `"v=spf1 include:spf.efwd.registrar-servers.com ~all"` | DNS only |

The two web records must be removed before delegation completes. Removal was attempted and **failed
with HTTP 403** — the supplied token is read-only (see §2.2). The exact values are recorded above so
the deletion is reversible.

The five `MX` records and the SPF `TXT` are the **mail plane** and are deliberately left alone; §6.ה of
the integrations runbook keeps root mail records in scope for a later, separate step. Note for that
step: the imported SPF will conflict with a future Resend SPF on the same name.

### 2.2 API credentials actually available

| Capability | Result |
|---|---|
| wrangler OAuth session | `pages: write`, but **`zone: read` only** — cannot create zones or DNS records |
| Owner-supplied token (`AI/API/CF-TOKEN-DOMAINS.txt`) | valid and active, but **read-only**: `GET /zones`, `GET /dns_records`, `GET pages/…/domains` all succeed; `DELETE dns_record` → `403`, `POST pages custom domain` → `403` |
| `GET /user/tokens` | `403` — the token cannot enumerate its own policies |

Baseline route probe on `https://supplyflow-baq.pages.dev` (all `200 text/html` unless noted):
`/`, `/login`, `/signup`, `/forgot-password`, `/reset-password`, `/accept-invite`, `/portal`,
`/operator`, `/suppliers`, `/orders`, `/terms`, `/privacy`, `/pricing`.
`/operator.html` → `308` to `/operator` (documented, correct Pages behaviour).

## 3. Domain / registrar

Live RDAP read of `https://rdap.identitydigital.services/rdap/domain/inplace.digital`, 23.08.2026:

| Field | Value |
|---|---|
| `ldhName` | `inplace.digital` |
| registration | `2026-08-23T14:23:27.101Z` |
| expiration | `2027-08-23T14:23:27.101Z` |
| registrar | `NameCheap, Inc.` |
| **nameservers** | `pdns1.registrar-servers.com`, `pdns2.registrar-servers.com` — **registrar default, NOT Cloudflare** |
| status | `client transfer prohibited`, `add period` |
| DNSSEC | `delegationSigned: false` |

`https://app.inplace.digital/` — connection fails, host does not resolve. Expected: no zone, no record.

## 4. Supabase

Project ref: `rkftlbctohswhbbiaqin` (production).

### 4.1 Auth configuration — as found

| Field | Value found |
|---|---|
| **Site URL** | **`http://localhost:3000`** — the Supabase default; never pointed at production |
| Redirect allowlist (`uri_allow_list`) | `https://supplyflow-baq.pages.dev/reset-password` — exactly one entry |
| Sign-up disabled | `false` |
| Mailer autoconfirm | `false` |
| Custom SMTP | **not configured** (`smtp_host` / `smtp_user` / `smtp_pass` / `smtp_admin_email` all absent) |
| External OAuth providers | all disabled (google, github, apple, azure) |
| Captcha | disabled |
| `jwt_exp` | `3600` |

### 4.2 Edge functions — 17 ACTIVE

`admin-provision` v14 · `send-invite` v17 · `send-push` v10 · `whatsapp` v5 · `submit-price-list` v8 ·
`document-processing` v9 · `interpret-document` v18 · `outbox-worker` v5 · `send-feedback` v4 ·
`tenant-export` v2 · `upload-organization-logo` v3 · `recover-document-processing` v2 ·
`document-preprocessing` v2 · `supplier-portal` v1 · `public-signup` v1 · `email-sender` v1 · `assistant` v1

### 4.3 Edge secrets — names only, values never read

`ALLOWED_ORIGINS`, `APP_BASE_URL`, `DISCORD_FEEDBACK_WEBHOOK_URL`, `INTERPRET_DOCUMENT_CRON_SECRET`,
`INVITE_FROM_EMAIL`, `OCR_WORKER_TOKEN`, `OPENAI_API_KEY`, `PUSH_FN_SECRET`, `RESEND_API_KEY`,
`SUPABASE_ANON_KEY`, `SUPABASE_DB_URL`, `SUPABASE_JWKS`, `SUPABASE_PUBLISHABLE_KEYS`,
`SUPABASE_SECRET_KEYS`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`,
`SUPPLIER_PORTAL_RATE_LIMIT_PEPPER`, `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`.

The Management API returns secret values as SHA-256 digests, so `ALLOWED_ORIGINS` could not be read.
It was **measured black-box instead**, which is stronger evidence than the stored string: the CORS
helper echoes an allow-listed `Origin` and otherwise falls back to the first entry, so membership is
observable. `OPTIONS` preflight against `supplier-portal` / `send-invite`:

| Probed origin | Echoed back? |
|---|---|
| `https://supplyflow-baq.pages.dev` | **yes** — and it is `allowed[0]` (returned as fallback for every non-member) |
| `http://localhost:5199` | **yes** |
| `https://app.inplace.digital` | no |
| `https://inplace.digital`, `https://www.inplace.digital` | no |
| `http://127.0.0.1:5199`, `http://localhost:5173`, `http://localhost:3000`, `http://localhost:4173` | no |
| `https://supplyflow.pages.dev`, `https://qa.supplyflow-baq.pages.dev`, `https://e851dbe8.supplyflow-baq.pages.dev`, `https://gamos-site.pages.dev` | no |

**Pre-cutover `ALLOWED_ORIGINS` value, reconstructed from measurement and used as the rollback value:**

```
https://supplyflow-baq.pages.dev,http://localhost:5199
```

`public-signup` answers `Access-Control-Allow-Origin: *` for every origin. That is that function's own
design, unrelated to this cutover, and is **not** changed here.

## 5. Application base-URL mechanism — measured from source, not assumed

**There is no `VITE_APP_BASE_URL` and no build-time base URL in the frontend contract.** The client is
origin-relative:

- `src/lib/supplierPortal.ts:11` — `` `${origin}/portal#token=${token}` `` with `origin = window.location.origin`
- `src/pages/ForgotPassword.tsx:33` — `` redirectTo: `${window.location.origin}/reset-password` ``

The only absolute base URL lives **server-side**, in the `APP_BASE_URL` Edge secret:

- `supabase/functions/send-invite/index.ts:303` — `` `${APP_BASE_URL}/accept-invite?token=…` ``
- `supabase/functions/email-sender/index.ts` — portal links as `{APP_BASE_URL}/portal#token=…`

Consequence for this cutover: **the deployed bundle needs no rebuild and no redeploy.** Adding a
custom domain is sufficient for the frontend; only server-side origin configuration and Supabase Auth
need edits. Per the task contract, no dead `VITE_APP_BASE_URL` is introduced.

## 6. Owner decisions that bound this cutover

From `docs/INTEGRATIONS-SETUP.md` §6 on branch `feat/domain-email-whatsapp-20260823` (owner rulings of
23.08.2026):

- **Only `app.inplace.digital` is configured.** The apex `inplace.digital` and `www` are a *decided*
  non-configuration, not a pending step. Re-opening them needs a new owner ruling.
- Nameservers move to Cloudflare; **no records are to be created in NameCheap's DNS editor**, not even
  temporarily.
- Pages custom domain must be attached **through the Pages panel/API first**, then DNS — Cloudflare's
  own documentation warns that a hand-made CNAME without the Pages binding yields `522`.
- `/operator` stays a path on the same origin. No operator subdomain, no `_redirects` rule.
- Pages project keeps the name `supplyflow` (renaming would move `*.pages.dev` and break every
  allowlist and probe). Renaming is a separate owner decision.

## 7. Documentation claims contradicted by live state

| Repository says | Live state |
|---|---|
| supplier portal "candidate for deployment, not live" (`INTEGRATIONS-SETUP.md` §1, working tree) | `supplier-portal` Edge function is **ACTIVE v1** in production |
| Auth production Site URL implied to be the production origin | it is **`http://localhost:3000`** |
| `docs/PROGRESS.md` head (working tree) predates the `0168`–`0170` rollout | `origin/main` records that rollout; production runs `15baeac` |

None of these were changed by this snapshot.

## 8. Rollback values

| Surface | Restore to |
|---|---|
| Pages production deployment | `e851dbe8-fcc6-450d-b5b8-d80aace67da0` (`15baeac`) — untouched by this cutover |
| Pages custom domains | none — remove `app.inplace.digital` from the project to revert |
| `ALLOWED_ORIGINS` | `https://supplyflow-baq.pages.dev,http://localhost:5199` |
| `APP_BASE_URL` | value not readable (hashed); it is **not modified** unless the new origin passes every critical check, and the restore value is `https://supplyflow-baq.pages.dev` |
| Auth Site URL | `http://localhost:3000` |
| Auth redirect allowlist | `https://supplyflow-baq.pages.dev/reset-password` |
| Canonical origin during and after transition | `https://supplyflow-baq.pages.dev` stays live and is not removed |
