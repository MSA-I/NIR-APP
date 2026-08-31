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
