# Human email, transactional email and Paddle — measured state, 31.08.2026

Follows `artifacts/domain-cutover/EMAIL-ENABLEMENT-20260824.md`. Everything below was read from the
live provider APIs and public DNS on 31.08.2026, not from the repository. No secret value appears
here, and none was written into any file in this repository.

## 1. What the audit found before anything was changed

| Surface | Measured state | How |
|---|---|---|
| Apex `inplace.digital` MX | `route1/2/3.mx.cloudflare.net` — **Cloudflare Email Routing, not Google** | public resolver |
| Apex SPF | one record, `v=spf1 include:_spf.mx.cloudflare.net ~all` | public resolver |
| DMARC | `v=DMARC1; p=none; rua=mailto:dmarc@inplace.digital;` | public resolver |
| Sending DKIM/SPF | `resend._domainkey` present; `send.inplace.digital` SPF `include:amazonses.com` | public resolver |
| Resend domain | `inplace.digital` **verified**, sending enabled, `eu-west-1` | Resend API |
| Resend webhooks | **none existed** | Resend API |
| Cloudflare routing rules | `postmaster@` and `dmarc@` only, both forwarding to one verified destination | Cloudflare API |
| **Google Workspace** | exists — created 27.08.2026 — but on **`app.inplace.digital`**, MX `smtp.google.com` | Workspace mail in the owner's inbox, plus the subdomain's own MX and `google-site-verification` |
| Supabase secrets | `RESEND_API_KEY`, `INVITE_FROM_EMAIL`, `ORDERS_FROM_EMAIL`, `APP_BASE_URL`, `ALLOWED_ORIGINS` set; **`RESEND_WEBHOOK_SECRET` and `PADDLE_WEBHOOK_SECRET` absent** | Management API, names only |
| Edge Functions | `email-sender` v9, `email-webhook` v5, `billing-webhook` v5, all ACTIVE | Management API |
| **Paddle** | **no account exists** — no credential in the secrets directory, and not one message from Paddle in the owner's mailbox, ever | credentials directory listing; mailbox search |

Two of those lines are the whole story of this campaign, and neither was knowable from the code.

**`email-webhook` and `billing-webhook` are deployed and neither can accept anything.** Both verify
a signature against a secret that is not set, so both fail closed on every request. Deployed is not
running; `ACTIVE` in the functions list is a statement about a container, not about a contract.

**The Workspace account is on the application's own hostname.** `app.inplace.digital` serves the
product over HTTPS and now also receives mail. Addresses created there would be
`support@app.inplace.digital`, which is not the address any customer would guess, would not match
the `support@inplace.digital` this campaign wires into the product, and cannot be moved without
replacing the apex MX — which today points at Cloudflare Email Routing and carries the DMARC
mailbox. That is an owner decision, recorded as `#310`.

## 2. What was changed

| Change | Where | Verified by |
|---|---|---|
| Resend delivery webhook created → `…/functions/v1/email-webhook`, events `delivered`, `bounced`, `delivery_delayed`, `complained` | Resend | read back from the API: `status=enabled`, four events |
| `ORDERS_FROM_EMAIL` separated to `InPlace <orders@inplace.digital>` | Supabase secrets | read back by name; it previously carried the `no-reply@` identity |
| Reply-To across every product email | code | `_shared/reply-to.test.ts`, 14 cases |
| Support addresses reachable in the product | code | `supportContact.spec.tsx`, 6 cases |
| Paddle API operations implemented | code | `_shared/billing-adapter-paddle-api.test.ts`, 16 cases |
| Activation email owed exactly once | `0268` + code | `p94`, seven cases against local Postgres |
| Five test suites joined the quality gate, three of which no gate had ever run | `check-quality-gates.ps1` | 198 passed under the frozen lock |

## 3. What is blocked, and on what

### 3.1 Google Workspace — blocked on the owner, twice over

The Admin console is a password sign-in, and this agent is not permitted to enter a password into
any field. There is no API path either: the Google credential in the secrets directory is a **web
OAuth client** (`client_id`/`client_secret`/`redirect_uris`) for signing users into the product —
not an Admin SDK service account with domain-wide delegation, and it could not administer a
Workspace domain even if it were used.

Underneath that is the harder question, which is not technical: the Workspace domain is
`app.inplace.digital`, and the addresses this product needs are on `inplace.digital`. See `#310`.

### 3.2 Cloudflare Email Routing rules — blocked by the agent harness

Creating `support@`, `billing@`, `security@` and `hello@` as forwarding rules needs four API calls
against an already-verified destination. The harness refused the call, exactly as it refused the
same class of action on 24.08.2026 (`EMAIL-ENABLEMENT-20260824.md §7`): a mail-forwarding rule
matches an account-takeover pattern, and no permission rule in the repository overrides that. This
was not worked around.

**Consequence, stated plainly: `support@inplace.digital` does not receive mail today.** The product
now prints that address on two screens and sets it as the Reply-To on every product email. Until
the four rules exist, a customer writing to it gets a bounce. This is the single highest-priority
item in this document.

### 3.3 The Resend signing secret — blocked by the harness

The webhook was created; reading its signing secret back and writing it into Supabase was refused
under the same rule. So the endpoint is registered and enabled, and `email-webhook` will answer
`403` to every delivery until `RESEND_WEBHOOK_SECRET` is set. That refusal is the designed
behaviour — an endpoint that accepted unsigned events would be a hole — but it means delivery
events are not being recorded yet, and Resend will eventually disable an endpoint that keeps
failing.

### 3.4 Paddle — blocked on an account that does not exist

Not "unconfigured". Not "sandbox". There is no account. Creating one, and completing KYC, are both
actions this agent must not perform. Every Paddle gate in `#213` therefore stands exactly where it
stood: `ACCOUNT_NOT_PROVEN / KYC_NOT_PROVEN / ISRAEL_PAYOUT_NOT_PROVEN / NOT_INTEGRATED`.

What exists in the repository after this campaign is an adapter that implements the published API
and refuses to use it, and a database that seeds every provider disabled with no function able to
enable one. Neither is evidence that Paddle works, and the code says so in the places somebody
would look.

## 4. The owner's next actions, in the order that unblocks the most

1. **Create the four routing rules** on `inplace.digital` in the Cloudflare dashboard —
   `support@`, `billing@`, `security@`, `hello@` → the already-verified destination. Four rules,
   the same shape as the two that exist. This makes the addresses the product now advertises real.
2. **Copy the Resend webhook signing secret** (webhook `ea6ea6a8-96af-47fa-9453-cefad76fdd3a`) into
   the Supabase secret `RESEND_WEBHOOK_SECRET`. Then send one email and confirm a `delivered` event
   is recorded — that is the first proof the delivery path is closed end to end.
3. **Decide `#310`**: whether the human inboxes live on Cloudflare Email Routing (free, forward
   only, no send-as) or on Google Workspace (paid, replies from `support@`, requires moving the
   apex MX off Cloudflare and adding `inplace.digital` to the Workspace account).
4. **Deploy the Edge Functions** this branch changed, after merge: `email-sender`, `send-invite`,
   `billing-webhook`. Until then Reply-To is in the repository and not in production.
5. **Paddle**, when and if the account is created: the sandbox credential goes into `PADDLE_API_KEY`
   with `PADDLE_ENVIRONMENT=sandbox`, the notification destination's secret into
   `PADDLE_WEBHOOK_SECRET`, and the price ids into `private.billing_provider_price_map` — which
   `0187` seeds empty precisely so an unmapped price grants nothing.

## 5. What this document does not claim

No email was sent through the new Reply-To path in production, because the functions that carry it
are not deployed. No delivery event has been received. No Paddle call has ever been made from this
repository. `0268` was applied to the local stack and its suite passed there; it has **not** been
applied to production.
