# Human email, transactional email and Paddle — measured state, 31.08.2026

Follows `artifacts/domain-cutover/EMAIL-ENABLEMENT-20260824.md`. Everything below was read from the
live provider APIs and public DNS on 31.08.2026, not from the repository. No secret value appears
here, and none was written into any file in this repository.

**Scope note.** This document records the whole audit, including Paddle. The **code** for the
Paddle adapter, the price map and the checkout is NOT in this branch — it belongs to a parallel
branch, `feat/paddle-sandbox-integration-20260831` (see §7). What this branch carries is the email
work and the external configuration recorded in §2.

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
| **Paddle** | **no account existed** at the start of the campaign — no credential, and not one message from Paddle in the owner's mailbox | credentials directory listing; mailbox search |

Two of those lines were the whole story of the campaign, and neither was knowable from the code.

**`email-webhook` and `billing-webhook` were deployed and neither could accept anything.** Both
verify a signature against a secret that was not set, so both failed closed on every request.
`ACTIVE` in the functions list is a statement about a container, not about a contract.

**The Workspace account is on the application's own hostname.** `app.inplace.digital` serves the
product over HTTPS and now also receives mail. Addresses created there would be
`support@app.inplace.digital`, which is not the address any customer would guess and cannot be
moved without replacing the apex MX — which today points at Cloudflare Email Routing and carries
the DMARC mailbox. That is an owner decision, recorded as `#329`.

## 2. What was changed

| Change | Where | Verified by |
|---|---|---|
| Resend delivery webhook → `…/functions/v1/email-webhook`, four delivery events | Resend | read back: `status=enabled` |
| `RESEND_WEBHOOK_SECRET` installed | Supabase | **behaviour change measured** — §2.1 |
| `ORDERS_FROM_EMAIL` separated to `InPlace <orders@inplace.digital>` | Supabase | read back by name |
| Paddle notification destination `ntfset_01m1c484…` → `…/functions/v1/billing-webhook`, 11 events | Paddle sandbox | read back: `active=true`, event list |
| `PADDLE_WEBHOOK_SECRET`, `PADDLE_API_KEY`, `PADDLE_ENVIRONMENT=sandbox`, `BILLING_PROVIDER=paddle` | Supabase | **behaviour change measured** — §2.1 |
| Reply-To across every product email | code | `_shared/reply-to.test.ts`, 14 cases |
| Support addresses reachable in the product | code | `supportContact.spec.tsx`, 6 cases |
| Activation email owed exactly once | `0280` + code | `p103`, seven cases locally **and in CI** |
| Five test suites joined the quality gate, three of which no gate had ever run | `check-quality-gates.ps1` | 182 passed under the frozen lock |

### 2.1 The secrets were verified by behaviour, not by a listing

A secret appearing in a name listing proves somebody wrote a row. What proves the function reads it
is that the function's refusal **changed**. Both endpoints were probed with an unsigned POST before
and after:

| Endpoint | Before | After |
|---|---|---|
| `email-webhook` | `500 misconfigured` — "the delivery webhook is not configured" | **`403 forbidden` — "missing signature headers"** |
| `billing-webhook` | `503 refused` — no adapter could be resolved | **`403 refused`** — the adapter resolved and rejected the signature |

Both now fail closed on the **signature** rather than on the **configuration**, which is the only
difference that matters. `GET` returns `405` on both, unchanged.

### 2.2 One real delivery

A single test message was sent through Resend from `InPlace <no-reply@inplace.digital>` to the
owner's Gmail, carrying `Reply-To: support@inplace.digital`. The provider reported **`delivered`**,
with the reply address preserved on the record.

That proves the sending half — verified domain, DKIM, an accepting recipient — and proves nothing
about the code in this branch: `email-sender` and `send-invite` are not deployed, so a real
invitation still goes out without a Reply-To until they are.

## 3. Paddle, as it actually stands

The owner opened a **sandbox** account on 31.08.2026 and supplied its credentials. Measured against
the live API:

| Product | Monthly | Yearly | InPlace plan |
|---|---|---|---|
| InPlace Basic | $20 | $200 | `basic` |
| InPlace Pro | $79 | $790 | `pro` |
| InPlace Premium | $149 | $1,490 | `premium` |

**The mapping was derived, not chosen.** `public.plan_prices` catalogue `launch-row` holds
20/200, 79/790 and 149/1490 in USD; the account returns exactly those six amounts in minor units.
Every plan key above is that correspondence and nothing else.

**The ILS catalogue does not exist at the provider.** `plan_prices` catalogue `launch-il` decides
69/690, 249/2490 and 449/4490 ILS (`#195`), and `#208` says an Israeli customer is billed in ILS.
Paddle currently holds USD only. Creating those prices is a commercial act with a tax question
attached — whether the stored amounts, recorded as *before VAT*, are entered tax-inclusive or
tax-exclusive — so it was left for the owner rather than guessed.

**Production cannot grant anything, and this was checked rather than assumed.** Read from the
production database after all configuration was in place:

- `private.billing_provider_boundary` — `paddle`, `stripe` and `morning` all `enabled = false`
- `private.billing_provider_price_map` — **0 rows**
- `private.billing_events` — **0 rows at that moment**; §3.1 records what landed in it afterwards

So a sandbox event arriving at the production endpoint verifies, is stored, and changes nothing —
§3.1 is that happening for real. It is what makes pointing a sandbox destination at production a
test rather than a hole: a sandbox subscription bought with a test card cannot become a real
tenant's paid plan.

### 3.1 A real Paddle event reached the endpoint, and did exactly nothing

Run from the Paddle dashboard on 31.08.2026 — a `subscription.activated` simulation aimed at the
production `billing-webhook`. Read back from the production database:

```
provider  event_type              status       org_id  received
paddle    subscription.activated  dead_letter  null    16:52:31
paddle    subscription.activated  dead_letter  null    16:54:23
paddle    subscription.activated  dead_letter  null    16:54:29
```

Every step of the chain is in that table:

1. **Paddle reached us** over the public internet — the row exists.
2. **The signature verified.** A failed signature is counted in
   `private.billing_ingress_rejections` and never stored; that counter still holds exactly the
   two probe rows from §2.1 and gained nothing. Three deliveries, zero rejections.
3. **The event was stored** under the provider event id it arrived with.
4. **Attribution refused.** `org_id` is null and the status is `dead_letter`: the simulated
   customer id belongs to no organization we have ever written, so 0157 filed it rather than
   guessing. This is the attack the whole boundary is shaped against, arriving by accident and
   being handled correctly.
5. **Nothing was granted.** `billing_provider_enabled('paddle')` is still false.

**One thing this did NOT prove, and the distinction matters.** Paddle's "Replay event" mints a
NEW event id each time (`ntfsimevt_…`), so the three rows above are three distinct events, not
one event delivered three times. The replay key was therefore never exercised over the network.
Idempotency remains proven where it is enforced — the unique on (provider, provider_event_id)
and `p54_billing_boundary_and_funnel.sql` — and a genuine duplicate delivery only happens when
our endpoint answers non-2xx, which it does not.

**A configuration fact worth keeping.** The destination was created through the API with
Paddle's default usage type, `Platform`, which accepts production traffic only — the dashboard
refused to aim a simulation at it and said so. It was changed to `Platform, Simulation`. Anyone
creating a destination for testing hits this, and the other agent worked around it by creating a
second, simulation-only destination and later deleting it, which is why eighteen orphaned
simulations in the account point at a `ntfset_` id that no longer exists.

## 4. What is blocked, and on what

### 4.1 `support@inplace.digital` receives no mail — and the product now advertises it

Creating `support@`, `billing@`, `security@` and `hello@` as forwarding rules needs four API calls
against an already-verified destination. The agent harness refused the call, exactly as it refused
the same class of action on 24.08.2026 (`EMAIL-ENABLEMENT-20260824.md §7`). This was not worked
around. **Until the four rules exist, a customer writing to that address gets a bounce.** This is
the highest-priority item in this document and it is a regression this branch introduces.

### 4.2 Google Workspace — blocked on the owner, twice over

The Admin console is a password sign-in, and this agent is not permitted to enter a password into
any field. There is no API path either: the Google credential in the secrets directory is a **web
OAuth client** for signing users into the product, not an Admin SDK service account with
domain-wide delegation. Underneath that sits `#329`: the Workspace domain is
`app.inplace.digital` and the addresses this product needs are on `inplace.digital`.

### 4.3 Paddle live selling — sandbox is not readiness

`#213`'s gates are KYC, Israel payout and a live catalogue. A sandbox account proves none of them.
Opening an account and completing KYC are also actions this agent must not perform. The provider
boundary stays shut until the owner proves all three, and opening it is a deliberate forward-only
migration, not a toggle.

## 5. The owner's next actions, in the order that unblocks the most

1. **Create the four routing rules** on `inplace.digital` in the Cloudflare dashboard, to the
   already-verified destination. Four rules, the same shape as the two that exist.
2. **Decide `#329`** — Cloudflare Email Routing (free, forward only, no send-as) or Google
   Workspace on the apex (paid, replies from `support@`, requires moving the apex MX).
3. **Deploy the Edge Functions** this branch changed, after merge: `email-sender`, `send-invite`,
   `billing-webhook`. Until then Reply-To is in the repository and not in production.
4. **Decide the ILS catalogue at Paddle**, including whether the decided amounts are entered
   tax-inclusive or tax-exclusive.
5. **Paddle live**: KYC and Israel payout, then a live catalogue, then the forward-only migration
   that opens the boundary — reviewed as the commercial decision it is.

## 6. What this document does not claim

No email was sent through the new Reply-To path in production, because the functions that carry it
are not deployed. No Paddle event has yet reached the endpoint. `0280` was applied to the local
stack and its suite passed there and in CI; it has **not** been applied to production.

## 7. Two branches, and why

While this campaign ran, a parallel agent independently built the Paddle side on
`feat/paddle-sandbox-integration-20260831` (local, commit `cc5e1ecb`, 17:41): the price map
(`0277`), checkout authorization (`0278`), a `billing-checkout` Edge Function, and the same four
live adapter operations this branch had written.

The owner chose to keep the two separate rather than coordinate two agents on one file. So
`supabase/functions/_shared/billing-adapter.ts` was **returned to its `main` state here**, and this
branch carries the email work only. The external configuration in §2 is deliberately kept: it is
account-level state that both branches need, and neither branch owns it.

**One thing the other branch cannot know from its own diff:** the notification destination and the
four Paddle secrets already exist in production as of this campaign. Its migrations should not
create a second destination.
