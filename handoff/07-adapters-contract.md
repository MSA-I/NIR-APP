# handoff 07 — integration adapters contract

**Produced by:** the wave-7 agent (PLAN-08) · **branch:** `wave7/integration-adapters` · **migration:** `0066`
**Consumers:** wave 9 (notification/search/workflow providers) · any wave that implements a real
provider adapter or an inbound integration · the future integrations screen (#98).
**Status:** the registration recipe, the signed-delivery contract and the failure-ledger boundary
below are FINAL for this wave. The signature format is an invented, documented guardrail
(OPEN-DECISIONS #97) — changing it means changing `0066` + `outbox-worker/core.ts` + this file +
both known-answer vectors, together.

---

## 1. Registering a webhook target (the recipe)

`public.webhook_subscriptions` (0066) is the target registry the wave-5 outbox was waiting for.
`target` is a stored **generated** column — `'webhook:' || id` — because the outbox dedup key
`unique(target, event_id)` (0064:38) carries no org_id: targets must be globally unique by
construction, and a generated column cannot drift or be written.

Registration is a three-step, two-privilege flow:

1. **Store the signing secret in Vault** (trusted server context, never PostgREST):
   `select vault.create_secret('<raw secret>', '<name>', '<description>');` → keep the returned uuid.
2. **Configure** (service_role only — the WhatsApp 0028 precedent; the secret travels as a
   Vault id, never as plaintext):
   `select configure_webhook_subscription(p_org_id, p_url, p_event_types, p_secret_id, p_description, p_reason);`
   The subscription is **always born inactive**; the reasoned audit row never contains the secret
   or even its Vault id. `p_event_types = '{}'` means "all event types"; otherwise an exact-match
   allowlist of `domain_events.event_type` values.
3. **Activate** — an OWNER decision, in the browser, with step-up:
   `select set_webhook_subscription_active(p_subscription_id, true, p_reason);`
   Owner + mandatory reason + `assert_recent_password_authentication()` (#85: streaming the
   tenant's business events to an external URL is the bank_details exfiltration class) + audit row
   + `security_events` row (`webhook_subscription_toggled`).

Owners read the registry through `read_webhook_subscriptions()` — everything except `secret_id`.
There is no update command: to change a URL or filter, configure a new subscription and
deactivate the old one (each step reasoned and audited).

## 2. How events reach the outbox

An `AFTER INSERT` trigger on `public.domain_events` (`domain_events_enqueue_subscriptions`, 0066)
calls the wave-5 seam `private.enqueue_integration_outbox(event_id, target)` once per **active**
subscription of the event's tenant whose filter matches. This covers BOTH emission arms — the
0063 audit fan-out and future inline-emitting commands — without touching either. The seam's
`on conflict do nothing` arm keeps enqueueing idempotent per `(target, event)`. Delivery
semantics are unchanged from wave 5 (OPEN-DECISIONS #90): at-least-once, backoff 1m/×4/cap 6h,
8 attempts → dead-letter → reasoned replay.

## 3. The signed delivery — receiver contract

`claim_integration_outbox` (redeclared in 0066 from its live 0064 definition, ancestry-asserted)
resolves the subscription and signs INSIDE Postgres; the worker posts what it is handed and never
sees a secret. Each delivery is an HTTP POST with:

| header | value |
|---|---|
| `Content-Type` | `application/json` |
| `x-correlation-id` | the EVENT's correlation id |
| `x-idempotency-key` | `sf:<event_id>:<target>` — constant across redeliveries; dedup on it |
| `x-supplyflow-signature` | `sha256=<hex>` |
| `x-supplyflow-timestamp` | unix epoch seconds at claim time |

**The body** is the event envelope (`id, sequence, event_type, schema_version, org_id, unit_id,
entity_type, entity_id, actor_id, correlation_id, causation_id, occurred_at, payload, metadata`)
serialized as Postgres `jsonb::text` — deterministic key order. The worker sends it **verbatim**;
the signature covers exactly the bytes on the wire.

**Verification recipe** (exact):

```
signed_string = <raw request body> || '.' || <x-supplyflow-timestamp value>
expected      = hex( HMAC-SHA256( key = <shared secret>, message = signed_string ) )
accept iff constant_time_equal(expected, x-supplyflow-signature minus its 'sha256=' prefix)
```

Known-answer vector (pinned in `p7_integration_adapters.sql` against `extensions.hmac` and in
`supabase/functions/outbox-worker/core.test.ts` against WebCrypto — both sides must agree):

```
secret    = p7-known-answer-secret
body      = {"p7":"known-answer"}
timestamp = 1754400000
signature = 4e3f7e7c2061cba6aa5de9f70b941753e26dc9f33cabd8830a9244608aa94f75
```

Receiver duties: deduplicate on `x-idempotency-key` (at-least-once redelivery is normal), and
apply your own timestamp-freshness window if replay resistance matters to you — the platform
pins the signature format, not your acceptance policy. Answer 2xx to acknowledge; any other
status (or a timeout) counts a failed attempt on our side.

An unregistered / deactivated / secret-less target claims WITHOUT url+signature and the worker
records a `target_unregistered` failed attempt — the wave-5 accounting, preserved. The preflight
arm `outbox_target_unregistered` (40/40) pages on pending rows in that state.

## 4. The failure ledger boundary (OPEN-DECISIONS #99)

- `private.integration_deliveries` (0064) = TRANSPORT outcomes of outbox rows, one row per
  attempt, written only by the worker RPCs.
- `public.integration_failures` (0066) = adapter-plane and inbound failures with NO outbox row —
  a rejected inbound signature, a mapping conflict, a provider SDK error. Record from trusted
  server code via `private.record_integration_failure(p_org, p_source, p_subscription_id,
  p_error_code, p_raw_error, p_correlation_id default null)`; `p_source in
  ('adapter','webhook','inbound')`; a NULL org skips quietly. `raw_error` never reaches a
  browser: the table is Shape-2 and `read_integration_failures()` (owner) returns codes and
  counts only.

## 5. The adapters library (`src/lib/adapters/`)

Vendor-neutral interfaces with ZERO importers by design (the flags.ts precedent): `types.ts`
(the `ExternalReference` tuple mirroring 0066, `AdapterResult` discriminated union
ok/conflict/failed, `SyncStatus` with honest nulls, `ConflictResolution`, `AdapterError`),
`accounting.ts` (the seven document-mandated methods), `erp.ts` + `wms.ts` (the §4 capability
list, split by plane), and a mock per interface (`mock/`) with injectable failure/conflict —
specs run in `npm run build` on every gate. A real provider implements the interface, writes its
mappings to `external_references`, and records its failures through the ledger — no schema
change.

## 6. What stays hosted-only / deferred

- **Live outbound delivery proof** (the honest-negative loopback: an outbox row pointing at the
  worker's own URL → 403 from the cron-secret check → a `failed/403` delivery row) is DEFERRED:
  it needs the built-in Edge runtime plus a container-network origin for pg_net, which the SQL
  gate step does not provision. The delivery pipeline below the fetch (claim → complete/fail →
  dead-letter → replay) is fully proven in SQL (p5 + p7); the fetch itself and header
  transmission are proven at the unit level (core.test.ts). First hosted delivery should be
  verified against a request-bin style receiver using §3's recipe.
- **Hosted deployment** (unchanged from wave 5): `supabase functions deploy outbox-worker
  --no-verify-jwt`, secret `OUTBOX_FN_SECRET` set both as a function secret and as the Vault
  value referenced by `private.integration_outbox_config`.
- **The integrations screen** — deferred (#98); its read surface already exists.

## 7. Where the proofs live

- `supabase/tests/p7_integration_adapters.sql` — structure/ACL/registry, enqueue through an
  unedited command, the four negatives, seam idempotency, the KAV + per-row signature
  verification + body determinism, unregistered-target fallback, claim→complete,
  claim→fail×8→dead-letter→replay, the command surface (configure/step-up toggle/readers/
  recorder), and the deactivation mutation proof. Marker: `p7_integration_adapters_passed`;
  wired after p6b in `check-quality-gates.ps1`.
- `supabase/functions/outbox-worker/core.test.ts` — resolveTarget mapping, unknown→null, the
  five mandatory headers, verbatim body, the shared vector, and the receiver-side verification
  recipe; its own gate step with its own `deno.json` (fails on ignored/skipped).
- `supabase/tests/p1_preflight.sql` — 40 arms; `outbox_target_unregistered` is the honest
  successor to wave 5's empty-outbox canary (and folds the orphan-subscription derivation
  check). `supabase/tests/p5_domain_events.sql` carries the order-dependency note for its (g)
  empty-outbox assertion.
- `supabase/demo/demo_seed.sql` — one INACTIVE subscription (Vault-referenced placeholder
  secret) + one external reference; `demo_verify.sql` — three A arms, three B arms, one C arm
  (org-vs-entity).
