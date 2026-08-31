# GATES — Paddle Sandbox integration (feat/paddle-sandbox-integration-20260831)

Owner ruling 31.08.2026: option **ב** — the live round trip runs against the LOCAL stack with a
temporary tunnel. No permanent enablement switch is added; nothing in production billing is touched.
Paddle **Sandbox only**. Live Paddle is out of scope in every gate below.

| # | Gate | Evidence required | Status |
|---|------|-------------------|--------|
| G1 | Sandbox catalogue exists and is deterministic | `GET /products` + `GET /prices` list exactly 3 products / 6 prices, re-run creates nothing new | |
| G2 | Plan mapping is server-side and complete | migration rows in `private.billing_provider_price_map`, one per sandbox price, no guessed plan | |
| G3 | Adapter makes real Sandbox calls | createCustomer / createTransaction / cancel / portal return live sandbox ids | |
| G4 | Secrets are server-side only | no `pdl_sdbx_apikey` anywhere under `src/`; bundle scan clean | |
| G5 | Paddle.js loads Sandbox only | `environment: 'sandbox'` asserted; client token is the `test_` one | |
| G6 | Webhook destination registered | Paddle notification-setting id + subscribed events, only events the app maps | |
| G7 | Signature verification over raw body | existing Deno tests still pass + a REAL sandbox delivery verifies | |
| G8 | Customer→org attribution is server-written | org resolved only via `provider_customer_id` we wrote | |
| G9 | Entitlement changes only from verified events | frontend success callback proven inert | |
| G10 | Idempotency + replay | duplicate delivery = one effect; stale `ts` refused | |
| G11 | Unknown customer / unknown price fail safe and visible | dead-letter rows with reason codes | |
| G12 | Tenant isolation | an org-A event provably cannot touch org-B | |
| G13 | Live sandbox round trip | real checkout → real payment → real signed webhook → plan changed, on the LOCAL stack | |
| G14 | Repo quality gates | build + verify green; SQL suite green | |
| G15 | Docs/DEBT/OPEN-DECISIONS updated, nothing marked live-ready | diff | |

ABANDON entries go here with a reason. A gate with no measured evidence is not PASS.
