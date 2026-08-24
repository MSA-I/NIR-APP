# Email enablement on `inplace.digital` — 24.08.2026

Follows `CUTOVER-RECORD-20260823.md`. Configuration only: no code, no build, no deployment. No
secret value appears here.

## 1. The blocker this round found

Measured on the production project **before** any change:

```
rate_limit_email_sent = 2
smtp_host             = null
```

Two emails per hour **for the whole project**, through Supabase's shared development sender, from a
`supabase.co` address. Three tenants resetting a password in the same hour and the third gets
nothing — with no error anywhere. This was not a setting to improve later; it was a launch blocker
sitting quietly in the default.

## 2. What is live now

| Layer | State | How it was proven |
|---|---|---|
| Resend domain | `verified`, id `e7f315d9…27c2`, region `eu-west-1` | Resend API after its own verify call |
| DKIM / SPF (sending) | both `verified` on `resend._domainkey` and `send.` | Resend API + public resolver |
| DMARC | `v=DMARC1; p=none; rua=mailto:dmarc@inplace.digital;` | public resolver |
| Outbound delivery | `delivered`; **SPF, DKIM and DMARC all `PASS`** | Resend event API, and the owner read the three results in Gmail's "show original" |
| Supabase Auth SMTP | `smtp.resend.com:465`, user `resend`, sender `no-reply@inplace.digital`, name `InPlace` | Management API read-back |
| Auth email cap | **2 → 100 per hour** | Management API read-back |
| Sender identity | `INVITE_FROM_EMAIL` and `ORDERS_FROM_EMAIL` both `InPlace <no-reply@inplace.digital>` | secret names read back; `ORDERS_FROM_EMAIL` did not exist before |
| Inbound routing | Cloudflare Email Routing `enabled=true` / `status=ready`; `dmarc@` forwards to the owner; catch-all **disabled** | routing API, and a test message sent to `dmarc@inplace.digital` arrived in the owner's inbox |

The SMTP password is the **send-only** Resend key, not the full-access one. Auth only ever sends.

## 3. Two mail surfaces on one name, deliberately not colliding

- **Sending** lives on `send.inplace.digital` (MX + SPF) and `resend._domainkey` (DKIM).
- **Receiving** lives on the root (three `route*.mx.cloudflare.net` MX + SPF) and `cf2024-1._domainkey`.

The five inherited NameCheap `eforward` MX records and their SPF TXT were **deleted**: the owner
confirmed no mail was ever active on the domain, and two SPF TXT records on the same name invalidate
each other. Resend was re-checked afterwards and stayed `verified` on all three of its records.

The root now carries mail records and still serves no web content — §5 of the integrations runbook
keeps the apex a decided non-configuration, and an `MX` on the root is not a licence to add a
`CNAME` to it.

## 4. Not proven — do not claim it

**No real Auth email has been sent.** The three test identities are `@gamos.demo`, a fake domain
that would bounce, and `recover` for a non-existent address returns `200` without sending, by
anti-enumeration design. Supabase validated the SMTP connection when the settings were saved; that
is the evidence that exists. The first real password-reset email is the final proof, and it can be
read in Resend's event log when it happens.

`RESEND_WEBHOOK_SECRET` and `email-webhook` still do not exist, so *accepted* is still not
*delivered* on the product path (#238).

## 5. Debt opened here

- **Auth email templates are the English defaults** (`"Reset your password"`, `"You've been invited"`)
  in a Hebrew RTL product. Not blocking; close it before the first customer.
- `p=none` is the monitoring stage. Moving to `quarantine` and then `reject` requires a
  representative period of actually reading `rua` reports — now possible, since the mailbox
  forwards — and is a fresh owner decision, not a tidy-up.

## 6. Rollback

| Surface | Restore to |
|---|---|
| Auth SMTP | clear `smtp_host` / `smtp_port` / `smtp_user` / `smtp_pass` / `smtp_admin_email` / `smtp_sender_name`, and set `rate_limit_email_sent` back to `2` |
| `INVITE_FROM_EMAIL` | previous value not readable (digest); it predated any verified domain, so it was a sandbox or non-delivering sender |
| `ORDERS_FROM_EMAIL` | delete the secret — it did not exist before |
| Inbound routing | disable Email Routing; the forwarding rule and destination were created by the owner in the dashboard |
| Deleted NameCheap records | `MX inplace.digital → eforward1..5.registrar-servers.com` and `TXT inplace.digital → "v=spf1 include:spf.efwd.registrar-servers.com ~all"` |

## 7. Note on how this was executed

Several steps were refused by the agent harness rather than by any provider: writing an API key as
an SMTP password, and creating a mail-forwarding rule, both match credential-exfiltration and
account-takeover patterns. A permission rule in `.claude/settings.local.json` did not override them.
Those two steps were performed by the owner in the Supabase and Cloudflare dashboards; everything
else was done through the APIs and verified here by reading the resulting state back.
