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
// Wave-7 scope (PLAN-08): targets are webhook_subscriptions rows, and resolution happens
// in the DATABASE — claim_integration_outbox (0066) returns each row with the resolved
// url, the deterministic body serialization, a timestamp and an HMAC-SHA256 signature
// computed with the subscription's Vault secret. This worker never sees the secret and
// never re-serializes the event: it posts row.body VERBATIM with the five mandatory
// headers (core.ts). A row whose target is unknown, inactive or secret-less arrives
// without url/signature; resolveTarget() answers null and the worker records a failed
// attempt (`target_unregistered`) so at-least-once accounting stays honest — the wave-5
// behavior, preserved. The delivery logic lives in core.ts (the interpret-document
// core-extraction precedent) and is proven by core.test.ts in a dedicated gate step.
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
import { deliverWebhook, type ClaimedRow, resolveTarget } from './core.ts';
import {
  releaseOrganizationEgress,
  reserveOrganizationEgress,
  type OrganizationEgressLease,
  type ServiceRpc,
  type ServiceRpcResult,
} from '../_shared/organization-egress.ts';
import { runReservedEgress } from '../_shared/reserved-egress.ts';

const BATCH_SIZE = 20;

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

/** Delivers one claimed row. Correlation propagation contract: the outbound request
 * carries the EVENT's correlation id, the (target, event) idempotency key, and the
 * wave-7 signature pair (x-supplyflow-signature / x-supplyflow-timestamp). The body is
 * row.body VERBATIM — the database signed exactly those bytes. */
async function deliver(row: ClaimedRow, allowedHosts: ReadonlySet<string>): Promise<{ ok: boolean; code?: number; error?: string }> {
  const resolved = resolveTarget(row);
  if (!resolved) {
    return { ok: false, error: 'target_unregistered' };
  }
  return deliverWebhook(resolved, allowedHosts);
}

async function claimBatch(admin: SupabaseClient, workerId: string): Promise<ClaimedRow[]> {
  const { data, error } = await admin.rpc('claim_integration_outbox', {
    p_worker_id: workerId,
    p_limit: BATCH_SIZE,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as ClaimedRow[];
}

function serviceRpc(admin: SupabaseClient): ServiceRpc {
  return (name, args) =>
    admin.rpc(name, args) as unknown as PromiseLike<ServiceRpcResult>;
}

async function parkClaimedDelivery(
  admin: SupabaseClient,
  row: ClaimedRow,
  workerId: string,
): Promise<void> {
  const { error } = await admin.rpc('service_park_claimed_integration_outbox', {
    p_outbox_id: row.outbox_id,
    p_worker_id: workerId,
    p_reason_code: 'organization_egress_denied',
  });
  if (error) throw new Error(error.message);
}

async function settleClaimedDelivery(
  admin: SupabaseClient,
  row: ClaimedRow,
  workerId: string,
  outcome: 'delivered' | 'failed' | 'ambiguous',
  providerStatus: number | null,
  evidenceCode: string,
): Promise<void> {
  const { error } = await admin.rpc('service_settle_claimed_integration_outbox', {
    p_outbox_id: row.outbox_id,
    p_worker_id: workerId,
    p_outcome: outcome,
    p_response_code: providerStatus,
    p_error: evidenceCode,
  });
  if (error) throw new Error(error.message);
}

async function settleClaimAndEgress(
  admin: SupabaseClient,
  rpc: ServiceRpc,
  lease: OrganizationEgressLease,
  row: ClaimedRow,
  workerId: string,
  outcome: 'delivered' | 'failed' | 'ambiguous',
  providerStatus: number | null,
  evidenceCode: string,
): Promise<void> {
  let settlementError: unknown = null;
  try {
    await settleClaimedDelivery(
      admin,
      row,
      workerId,
      outcome,
      providerStatus,
      evidenceCode,
    );
  } catch (error) {
    settlementError = error;
  }
  await releaseOrganizationEgress(rpc, lease, {
    outcome: settlementError ? 'ambiguous' : outcome,
    evidenceCode: settlementError ? 'outbox_settlement_ambiguous' : evidenceCode,
    providerStatus,
  });
  if (settlementError) throw settlementError;
}

function deliveryEvidenceCode(error: string | undefined): string {
  if (error && /^[a-z0-9_]{1,100}$/.test(error)) return error;
  return 'delivery_failed';
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return fail('method_not_allowed', 'POST only', 405);

  const secret = Deno.env.get('OUTBOX_FN_SECRET');
  const allowedHosts = new Set(
    (Deno.env.get('OUTBOX_ALLOWED_HOSTS') ?? '').split(',')
      .map((host) => host.trim().toLowerCase()).filter(Boolean),
  );
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!secret || !url || !serviceKey || allowedHosts.size === 0) {
    // Deterministic non-200 on absent configuration: the dispatcher's pg_net call must
    // never look like a successful delivery run.
    return fail('misconfigured', 'missing environment', 500);
  }

  if (!await constantTimeSecretMatch(req.headers.get('x-outbox-cron-secret') ?? '', secret)) {
    return fail('forbidden', 'bad or missing x-outbox-cron-secret', 403);
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const workerId = `outbox-worker:${crypto.randomUUID()}`;
  const results = { claimed: 0, delivered: 0, failed: 0, parked: 0, ambiguous: 0 };

  try {
    const rows = await claimBatch(admin, workerId);
    results.claimed = rows.length;

    for (const row of rows) {
      const rpc = serviceRpc(admin);
      const reservation = await reserveOrganizationEgress(rpc, {
        orgId: row.event.org_id,
        kind: 'integration_webhook',
        correlationId: row.outbox_id,
        // deliverWebhook has a 10-second AbortSignal timeout. Keep the database lease safely
        // above that bound while remaining well below the 120-second service maximum.
        ttlSeconds: 30,
      });
      if (!reservation.lease) {
        if (reservation.settledOutcome) {
          await settleClaimedDelivery(
            admin,
            row,
            workerId,
            reservation.settledOutcome === 'delivered' ? 'delivered' : 'ambiguous',
            null,
            `egress_already_${reservation.settledOutcome}`,
          );
          if (reservation.settledOutcome === 'delivered') results.delivered++;
          else results.ambiguous++;
          continue;
        }
        await parkClaimedDelivery(admin, row, workerId);
        results.parked++;
        continue;
      }
      const lease = reservation.lease;
      if (lease.idempotent) {
        throw new Error('outbox_egress_attempt_in_progress');
      }

      const outcome = await runReservedEgress({
        reserve: () => Promise.resolve(lease),
        perform: () => deliver(row, allowedHosts),
        settle: async (reserved, attempt) => {
          if (!attempt.ok) {
            await settleClaimAndEgress(
              admin,
              rpc,
              reserved,
              row,
              workerId,
              'ambiguous',
              null,
              'worker_delivery_exception',
            );
            return;
          }
          const delivery = attempt.result;
          const settlement = delivery.ok ? 'delivered' : 'failed';
          const evidenceCode = delivery.ok
            ? 'target_accepted'
            : deliveryEvidenceCode(delivery.error);
          await settleClaimAndEgress(
            admin,
            rpc,
            reserved,
            row,
            workerId,
            settlement,
            delivery.code ?? null,
            evidenceCode,
          );
        },
      });
      if (outcome.ok) {
        results.delivered++;
      } else {
        results.failed++;
      }
    }
  } catch (e) {
    return fail('outbox_run_failed', e instanceof Error ? e.message : 'outbox run failed', 500);
  }

  return json({ ok: true, results }, 200);
});
