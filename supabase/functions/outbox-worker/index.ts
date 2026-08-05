// outbox-worker — delivers claimed integration_outbox rows to registered targets.
//
// Callers are NOT browsers: pg_cron invokes this over pg_net through
// private.dispatch_integration_outbox() (supabase/migrations/0064_integration_outbox.sql),
// the same config-gated vault pattern as the WhatsApp reminder dispatcher (0028) and the
// same cron-function shape as send-push (0016). A database job cannot mint a user JWT, so
// authentication is a shared secret in the `x-outbox-cron-secret` header, compared in
// constant time against OUTBOX_FN_SECRET — that secret, not a JWT, is the security
// boundary, which is why the function is deployed with verify_jwt=false (and, hosted,
// `supabase functions deploy outbox-worker --no-verify-jwt`).
//
// service_role is used deliberately and stays server-side (CLAUDE.md iron rule): the
// worker only ever calls the four 0064 RPCs (claim / complete / fail / replay surface),
// which are themselves revoked from every browser role. It never touches business rows.
//
// Wave-5 scope (PLAN-05 §1.4): NO targets are registered yet, so the outbox is empty by
// design and every run is a quiet no-op. resolveTarget() below is the wave-7 seam: it
// answers null for every target name until webhook_subscriptions exist, and a claimed row
// whose target cannot be resolved records a failed attempt (`target_unregistered`) so
// at-least-once accounting stays honest. Wave 7 replaces resolveTarget() with a real
// registry lookup; outbound HTTP must carry the event's correlation id and the
// idempotency key (handled in deliver() below).
//
// Required environment (supabase secrets set ...):
//   OUTBOX_FN_SECRET   -- shared secret; the SAME raw value is stored in Vault and
//                         referenced by private.integration_outbox_config
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY -- injected by the platform
//
// Request contract (POST, empty JSON body): claims up to BATCH_SIZE due rows, attempts
// delivery, and reports { ok: true, results: { claimed, delivered, failed } }.
// Missing environment is a deterministic non-200 (`misconfigured`, 500).

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const BATCH_SIZE = 20;

interface ClaimedRow {
  outbox_id: string;
  target: string;
  attempt: number;
  idempotency_key: string;
  event: {
    id: string;
    sequence: number;
    event_type: string;
    schema_version: number;
    org_id: string;
    unit_id: string | null;
    entity_type: string;
    entity_id: string | null;
    actor_id: string | null;
    correlation_id: string;
    causation_id: string | null;
    occurred_at: string;
    payload: Record<string, unknown>;
    metadata: Record<string, unknown>;
  };
}

interface ResolvedTarget {
  url: string;
  headers?: Record<string, string>;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fail(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

// The document-processing idiom: compare SHA-256 digests byte-by-byte with a
// constant-time accumulator so the comparison never leaks a prefix length.
async function constantTimeSecretMatch(presented: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [presentedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(presented)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const left = new Uint8Array(presentedHash);
  const right = new Uint8Array(expectedHash);
  let mismatch = 0;
  for (let index = 0; index < left.length; index++) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

/** Wave-7 seam. No target registry exists in wave 5 (webhook_subscriptions is explicitly
 * a wave-7 table — OPEN-DECISIONS #93), so every target is unresolvable and the outbox
 * stays empty by design. Wave 7 replaces this with a registry lookup. */
function resolveTarget(_target: string): ResolvedTarget | null {
  return null;
}

/** Delivers one claimed row. Correlation propagation contract: the outbound request
 * carries the EVENT's correlation id and the (target, event) idempotency key so the
 * receiver can trace and deduplicate at-least-once redelivery. */
async function deliver(row: ClaimedRow): Promise<{ ok: boolean; code?: number; error?: string }> {
  const resolved = resolveTarget(row.target);
  if (!resolved) {
    return { ok: false, error: 'target_unregistered' };
  }
  try {
    const response = await fetch(resolved.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-correlation-id': row.event.correlation_id,
        'x-idempotency-key': row.idempotency_key,
        ...resolved.headers,
      },
      body: JSON.stringify(row.event),
    });
    if (response.ok) return { ok: true, code: response.status };
    return { ok: false, code: response.status, error: `target_status_${response.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 500) : 'delivery_failed' };
  }
}

async function claimBatch(admin: SupabaseClient, workerId: string): Promise<ClaimedRow[]> {
  const { data, error } = await admin.rpc('claim_integration_outbox', {
    p_worker_id: workerId,
    p_limit: BATCH_SIZE,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as ClaimedRow[];
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return fail('method_not_allowed', 'POST only', 405);

  const secret = Deno.env.get('OUTBOX_FN_SECRET');
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!secret || !url || !serviceKey) {
    // Deterministic non-200 on absent configuration: the dispatcher's pg_net call must
    // never look like a successful delivery run.
    return fail('misconfigured', 'missing environment', 500);
  }

  if (!await constantTimeSecretMatch(req.headers.get('x-outbox-cron-secret') ?? '', secret)) {
    return fail('forbidden', 'bad or missing x-outbox-cron-secret', 403);
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const workerId = `outbox-worker:${crypto.randomUUID()}`;
  const results = { claimed: 0, delivered: 0, failed: 0 };

  try {
    const rows = await claimBatch(admin, workerId);
    results.claimed = rows.length;

    for (const row of rows) {
      const outcome = await deliver(row);
      if (outcome.ok) {
        const { error } = await admin.rpc('complete_integration_outbox_delivery', {
          p_outbox_id: row.outbox_id,
          p_worker_id: workerId,
          p_response_code: outcome.code ?? null,
        });
        if (error) throw new Error(error.message);
        results.delivered++;
      } else {
        const { error } = await admin.rpc('fail_integration_outbox_delivery', {
          p_outbox_id: row.outbox_id,
          p_worker_id: workerId,
          p_error: outcome.error ?? 'delivery_failed',
          p_response_code: outcome.code ?? null,
        });
        if (error) throw new Error(error.message);
        results.failed++;
      }
    }
  } catch (e) {
    return fail('outbox_run_failed', e instanceof Error ? e.message : 'outbox run failed', 500);
  }

  return json({ ok: true, results }, 200);
});
