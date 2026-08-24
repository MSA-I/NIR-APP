# Cutover record — `app.inplace.digital`

Companion to `PRE-CUTOVER-SNAPSHOT-20260823.md`. Records what was actually changed, what was
deliberately not changed, and the exact remaining sequence. Contains no secret values.

Final status: **PASS**, completed 24.08.2026. The manual gate (registrar nameserver change + a
Cloudflare token with edit scope) was cleared by the owner; everything after it was executed and
measured here.

## 0. Timeline as measured

| When (UTC) | Event |
|---|---|
| `2026-08-23T14:23:27Z` | domain registered at NameCheap |
| `2026-08-23T22:07:04Z` | registrar nameservers replaced with `clyde` / `rose` (owner action) |
| `22:14`–`22:22` | delegation visible at `8.8.8.8` and `1.1.1.1`; `clyde` answers SOA authoritatively |
| `22:19` | the two imported NameCheap parking web records deleted |
| `22:22` | `app.inplace.digital` attached to Pages project `supplyflow`; `CNAME app` created |
| `22:25` | custom domain `active`, certificate `active`, `HTTPS 200` — while the zone flag still read `pending` |
| `22:27` | zone `active` |
| `22:3x` | Auth Site URL + allowlist, `APP_BASE_URL`, then the full live smoke |

## 1. Changes applied

### 1.1 Supabase Edge `ALLOWED_ORIGINS` — additive

| | value |
|---|---|
| before (measured, see snapshot §4.3) | `https://supplyflow-baq.pages.dev,http://localhost:5199` |
| after | `https://supplyflow-baq.pages.dev,http://localhost:5199,https://app.inplace.digital` |

Appended at the end so `allowed[0]` — the fallback origin echoed to non-members — stays
`https://supplyflow-baq.pages.dev`; existing browser clients see no behavioural change.

Verified live by `OPTIONS` preflight against three functions (`supplier-portal`, `send-invite`,
`submit-price-list`) immediately after the write, with no function redeploy:

| Origin | `Access-Control-Allow-Origin` |
|---|---|
| `https://supplyflow-baq.pages.dev` | echoed |
| `http://localhost:5199` | echoed |
| `https://app.inplace.digital` | echoed — **new** |
| `https://evil.example.com` | not echoed; falls back to the pages.dev origin, never `*` |

Rollback: set `ALLOWED_ORIGINS` back to the "before" value above.

### 1.2 Cloudflare DNS — two registrar-default web records removed

| Type | Name | Content | Proxy |
|---|---|---|---|
| `A` | `inplace.digital` | `192.64.119.114` | proxied |
| `CNAME` | `www.inplace.digital` | `parkingpage.namecheap.com` | proxied |

Cloudflare's zone scan imported these from NameCheap. Left in place they would have served a parking
page from the brand apex, over Cloudflare TLS, the moment delegation became authoritative — against
the owner ruling that the apex and `www` stay unconfigured. Deleted before that happened. The five
root `MX` records and the SPF `TXT` were **not** touched.

Verified after: `https://inplace.digital` does not answer, `www.inplace.digital` is `NXDOMAIN`.

### 1.3 Cloudflare DNS — the one record this cutover needs

`CNAME app.inplace.digital → supplyflow-baq.pages.dev`, proxied, TTL auto, created **after** the Pages
custom-domain binding existed, which is the order Cloudflare's documentation requires.

### 1.4 Cloudflare Pages — custom domain

`app.inplace.digital` attached to the existing production project `supplyflow`. No second project, no
second deployment. Final state: `status=active`, `verification=active`, `cert=active`.

Attaching succeeded while the zone flag still read `pending`, because the delegation itself was
already real — Google and Cloudflare resolvers both returned the Cloudflare nameservers and `clyde`
answered SOA. Pages did not auto-create the DNS record in that window, which is why §1.3 was done by
hand; the zone flipped to `active` two minutes later.

Rollback: `DELETE` the custom domain and the `CNAME`.

### 1.5 Supabase Auth

| Field | Before | After |
|---|---|---|
| Site URL | `http://localhost:3000` | `https://app.inplace.digital` |
| `uri_allow_list` | `https://supplyflow-baq.pages.dev/reset-password` | same **plus** `https://app.inplace.digital/reset-password` |

Extended, not replaced, so recovery links already in inboxes still land. Exact paths, no wildcard.

### 1.6 Supabase `APP_BASE_URL`

`https://app.inplace.digital`. This is the origin baked into server-generated invitation links
(`send-invite`) and supplier portal links (`email-sender`). Previous value not readable (digest);
rollback value per the snapshot is `https://supplyflow-baq.pages.dev`, which stays live.

### 1.7 Live verification

Infrastructure: 14 routes answer `200` on the new host; `/operator.html` answers `308` to
`/operator`; TLS verifies; no redirect loop; apex and `www` serve nothing.

Same-deployment proof: entry chunks on `app.inplace.digital` and `supplyflow-baq.pages.dev` are
identical — `index-Do0SLF1a.js`, `client-DW-RYYJh.js`, `format-BW5Zejev.js`, `recharts-BhAWep5w.js`.

Browser (`cutover-smoke.cjs`, three authorised demo identities, 1440×900 and 390×844):

| Check | Result |
|---|---|
| login / logout | 3/3 · 3/3 |
| deep link `/suppliers` + full reload keeps the session | 3/3 |
| horizontal overflow | 0 |
| console errors · page errors · HTTP ≥400 · CORS errors | 0 · 0 · 0 · 0 |
| recovery `redirect_to` built by the client | `https://app.inplace.digital/reset-password` — captured from the request, which was then aborted so no email was sent |
| `/accept-invite?token=…` | renders its own invalid-link screen, not a 404 |
| `/portal#token=…` | renders the portal entry's invalid-link screen |
| `/operator` as `office` / `accountant` | redirected to their own dashboard — boundary intact |

The only `requestfailed` entries are `net::ERR_ABORTED` on in-flight PostgREST reads and the logout
call — the SPA cancelling its own fetches on navigation. **The identical suite was run against
`supplyflow-baq.pages.dev` as a control and returned a byte-identical summary**, including the same
aborts and the same operator body text, which is what proves the pattern belongs to the product and
not to the cutover.

## 2. Changes deliberately NOT made

| Surface | Why not |
|---|---|
| Removing the previous production origin | `supplyflow-baq.pages.dev` stays live and is not redirected. It is the rollback origin and the target of already-issued links |
| Replacing the Auth redirect allowlist | it was extended. Dropping the pages.dev entry would break recovery links already sitting in inboxes |
| Frontend rebuild / redeploy | measured: the bundle carries no base URL. Client links are built from `window.location.origin`; the deployed artefact is origin-agnostic. Production stays on deployment `e851dbe8…` / `15baeac` |
| `VITE_APP_BASE_URL` | does not exist in this repository's runtime contract. Adding it would be dead configuration |
| apex `inplace.digital` and `www` | owner ruling of 23.08.2026: decided non-configuration, not a pending step. No records, no redirect, no second Pages project |
| Pages project rename (`supplyflow` → InPlace-branded) | renaming moves `*.pages.dev` and breaks every allowlist, DNS record and probe pointing at it. Separate owner decision |
| Resend / SMTP / email activation | `RESEND_API_KEY` exists but is a **send-only restricted key** — `GET /domains` answers `401 restricted_api_key`, so domain verification state cannot be read from here. Nothing was activated |
| `public-signup` CORS (`*`) | pre-existing design of that function, unrelated to the cutover |
| Anything touching data, RLS, migrations, billing, assistant, WhatsApp | out of scope by the cutover contract |

## 3. Sequence — executed

Each step's precondition is literal. A step whose precondition is unmet is blocked, not "nearly ready".

0. **Was blocked on credentials.** Both available Cloudflare credentials are read-only for the surfaces
   this cutover needs: the wrangler OAuth session has `zone: read`, and the owner-supplied token
   answers `403` to `DELETE dns_record` and to `POST pages custom domain`. A token carrying
   *Zone → DNS → Edit* and *Account → Cloudflare Pages → Edit* is required.
1. **Delegation** (registrar action, owner only). The zone already exists in Cloudflare as `pending`
   with nameservers `clyde.ns.cloudflare.com` and `rose.ns.cloudflare.com`; the registrar still
   publishes `pdns1/pdns2.registrar-servers.com`.
2. **Measure delegation** — RDAP `nameservers` shows the Cloudflare pair *and* a direct `NS` query
   answers from Cloudflare. Not a stopwatch.
2a. **Remove the imported parking records** — `A inplace.digital` and `CNAME www.inplace.digital`.
   Best done before delegation lands, so the apex never serves the parking page even briefly.
3. **Pages custom domain** — attach `app.inplace.digital` to the existing `supplyflow` project through
   the Pages custom-domain mechanism, which creates the DNS record itself. Never hand-write the CNAME
   first: Cloudflare's own documentation says that yields `522`.
4. **Wait for `Active` + a successful HTTPS read** of the host. Do not edit records while provisioning.
5. **Supabase Auth** — Site URL `https://app.inplace.digital`; add redirect URL
   `https://app.inplace.digital/reset-password` while keeping
   `https://supplyflow-baq.pages.dev/reset-password` so already-issued recovery links still land.
   That exact path is required by #114 and is the only `redirectTo` the client sends.
6. **`APP_BASE_URL`** → `https://app.inplace.digital`, so new invitation and portal links carry the
   canonical origin. Existing links keep working because the pages.dev origin is not removed.
7. **Live smoke on the new origin** — DNS, TLS, no redirect loop, `/login`, `/signup`,
   `/forgot-password`, `/reset-password`, `/accept-invite`, `/portal`, deep-link refresh on an
   authenticated route, `/operator` still permission-protected, Supabase REST + Edge calls with no CORS
   error, login/logout with the demo accounts, 390 px and desktop widths, console and network clean.
8. **Documentation** — only after 7 passes, update the current-state sections with the proven facts.

`https://supplyflow-baq.pages.dev` stays live throughout as the rollback origin.

## 4. Rollback

| Trigger | Action |
|---|---|
| TLS never becomes valid, host unreachable, login broken, CORS blocked, recovery redirect invalid, operator boundary changed, widespread 4xx/5xx | remove the `app.inplace.digital` custom domain from the Pages project; restore `ALLOWED_ORIGINS`, `APP_BASE_URL`, Auth Site URL and redirect allowlist to the snapshot values |
| Non-critical single-feature failure while the app is otherwise healthy | do **not** tear down the domain; record the defect and fix forward |

Production deployment `e851dbe8-fcc6-450d-b5b8-d80aace67da0` (`15baeac`) is untouched by every step
above, so the pages.dev origin remains a complete, working system at all times.
