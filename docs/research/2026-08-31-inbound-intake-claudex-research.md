# Claudex research brief — inbound intake (web tier), 2026-08-31

Sources read 2026-08-31. Answers ט-1..ט-4 of the plan.

## Key Takeaways

### ט-2 — Is `email.received` signed like the rest? YES (strong inference)
Resend signs with Svix: `svix-id`, `svix-timestamp`, `svix-signature`. Docs:
"each webhook and its metadata are signed with a unique key specific to the endpoint."
Signing is a property of the ENDPOINT, not of the event type. => existing
`email-webhook/core.ts` verification is reusable unchanged.
Source: resend.com/docs/dashboard/webhooks/verify-webhooks-requests
NOT stated verbatim for email.received. Confirm on first live payload.

### ט-3 — Can a separate endpoint take `email.received` only? YES
An endpoint is registered with a chosen subset of the 15 event types;
`email.received` is selectable. Combined with per-endpoint secrets, the plan's
preferred shape (separate `email-inbound` function, own secret) is viable.
Source: resend.com/docs/webhooks/introduction

### ט-1 — Limits: PARTIAL
- Data retention: 30 days (Free/Pro/Scale). Enterprise flexible.
  => aligns with the #317 proposal of 30 days.
- Max email size: NOT DOCUMENTED. Still open.
- Max attachment size: NOT DOCUMENTED. Still open.
- API rate limit: 10 requests/second, TEAM-WIDE.
Source: resend.com/docs/knowledge-base/account-quotas-and-limits

### ט-4 — Twilio inbound WhatsApp: CONFIRMED + extras
Params: MessageSid, SmsSid, SmsMessageSid, AccountSid, MessagingServiceSid,
From, To, Body, NumMedia, MediaContentType{N}, MediaUrl{N} (N zero-based).
WhatsApp-specific and NOT in the plan: ProfileName, WaId, Forwarded,
FrequentlyForwarded.
Addressing: `whatsapp:<E.164>` prefix on From/To.
Media: JPG/JPEG/PNG, audio, PDF. **16MB limit per message.**
Docs warn parameters vary by channel and may be added without notice.
Sources: twilio.com/docs/messaging/guides/webhook-request, twilio.com/docs/whatsapp/api

## NEW RISKS the plan did not carry

1. **Resend 10 req/s is team-wide, not per-tenant.** Every attachment fetch
   goes through it, shared across all tenants. The plan specifies a per-org /
   per-address DB rate limit but no shared-ceiling backpressure. A burst at one
   tenant starves attachment fetches for every other tenant.

2. **Size ceiling mismatch on WhatsApp: Twilio 16MB vs our bucket 10MB**
   (`file_size_limit = 10485760`, measured in 0045). A 12MB PDF is accepted by
   the provider and rejected by us. The plan flagged this class of gap for email
   (ט-1) but NOT for WhatsApp, where it is now a MEASURED fact, not a risk.

3. **`received_for` provenance may break attribution.** Docs: it is extracted
   from the `Received` header's `for` clause, and in the official example it
   differs from `to` (`to: [delivered@resend.dev]` vs
   `received_for: [forwarded@example.com]`). UNCONFIRMED: whether it is populated
   for DIRECT (non-forwarded) delivery. If it is empty on direct mail, the plan's
   "attribute from received_for only" rule attributes nothing at all.
   => blocking verification before PR-8.

4. `whatsapp:` prefix on From/To means the routing key needs normalisation before
   it can match `whatsapp_connections.provider_sender_id`. Plan does not say which
   form is stored.

## Carried from the plan, NOT re-verified here
- Twilio stores media until deleted; media URL valid 4 hours.
  (support.twilio.com returned HTTP 403 to automated fetch.)
