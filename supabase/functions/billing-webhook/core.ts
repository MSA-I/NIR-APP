// billing-webhook/core.ts -- the whole decision, extracted from Deno.serve so it is provable
// without a network or a database (the outbox-worker and supplier-portal core.ts precedent).
// index.ts builds the ports and adds no logic of its own -- in particular it never touches the
// request body, which is read here, once, and verified before it is allowed to become a document.
//
// THE ORDER IS THE SECURITY. Read raw bytes, verify the signature over exactly those bytes, only
// then let them become a document, then take the idempotency key in the database, and only then
// run a transition. Every one of those steps is a hole if moved:
//   * parse before verify -> the signature is checked against a string the provider never sent
//   * store before verify -> private.billing_events uniques on the event id the request CLAIMS, so
//     an attacker can pre-register an identifier and make the genuine delivery look like a replay
//   * apply before store  -> a redelivery races itself and applies twice
//
// WHAT THE STATUS CODE MEANS TO PADDLE. Its documented live schedule is up to sixty retries over
// three days, and it re-sends the same event_id each time (read 23.08.2026,
// https://developer.paddle.com/webhooks/respond-to-webhooks). So 200 means "held, stop asking" --
// including for an event that dead-lettered, because a retry cannot make an unmapped price mapped.
// 500 is reserved for the case where a retry genuinely could succeed: our storage or our
// dispatcher failed. 403 for anything unverifiable, which no retry will fix either, but which we
// also do not want to look like success.

import type { BillingAdapter, BillingEvent, BillingRefusal } from "../_shared/billing-adapter.ts";

export interface RecordOutcome {
  ok: boolean;
  /** 'stored' or 'dead_letter' -- 0157's two attribution outcomes. */
  status?: string;
  idempotent?: boolean;
  detail?: string;
}

export interface ApplyOutcome {
  ok: boolean;
  status?: string;
  applied?: boolean;
  idempotent?: boolean;
  reasonCode?: string;
  detail?: string;
}

export interface WebhookPorts {
  /** Null when no adapter could be resolved; `adapterRefusal` then says why. */
  adapter: BillingAdapter | null;
  /**
   * The provider this deployment is configured to serve. Needed because a refusal has to be
   * counted under a real name: when the adapter is null there is no adapter to ask, and filing a
   * refused Stripe delivery under "unknown" would hide exactly the fact worth seeing.
   */
  providerName?: string;
  adapterRefusal?: { code: BillingRefusal; detail: string };
  recordEvent(event: BillingEvent): Promise<RecordOutcome>;
  applyEvent(providerEventId: string, provider: string): Promise<ApplyOutcome>;
  recordRejection(provider: string, reasonCode: string): Promise<void>;
}

/**
 * One body for every refusal. A response that distinguished "bad signature" from "stale
 * timestamp" from "unknown customer" would be a free oracle for whoever is probing the endpoint,
 * and the operator learns the real reason from the reconciliation reads instead (0188).
 */
const REFUSED = JSON.stringify({ error: "refused" });
const ACCEPTED = JSON.stringify({ received: true });

function answer(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** How a refusal from the boundary is answered. Only `not_configured` is our fault, so only it is a 5xx. */
const REFUSAL_STATUS: Record<BillingRefusal, number> = {
  not_configured: 503,
  not_authorized: 403,
  unsupported: 403,
  signature_invalid: 403,
  payload_invalid: 400,
};

export async function handleWebhook(request: Request, ports: WebhookPorts): Promise<Response> {
  // A GET would put nothing useful in a webhook and would invite somebody to probe the endpoint
  // from a browser bar. It is not a provider request, so it is not counted as a provider refusal.
  if (request.method !== "POST") return answer(405, REFUSED);

  const provider = ports.adapter?.provider ?? ports.providerName ?? "unknown";

  if (ports.adapter === null) {
    const refusal = ports.adapterRefusal ?? { code: "unsupported" as const, detail: "no adapter" };
    await ports.recordRejection(provider, refusal.code);
    return answer(REFUSAL_STATUS[refusal.code] ?? 403, REFUSED);
  }

  // The raw text, exactly as delivered, read in the ONE place that is allowed to read it. A
  // Request body can only be consumed once, so keeping this here is what guarantees the bytes
  // that get verified are the bytes that arrived rather than something a caller reconstructed.
  const rawBody = await request.text();

  const verified = await ports.adapter.verifyAndParse(rawBody, request.headers);
  if (!verified.ok) {
    // Counted, never stored. The counter holds no identifier the caller supplied, so a flood of
    // these tells an operator that unverifiable traffic is arriving without letting the caller
    // write anything into the ledger the real events depend on.
    await ports.recordRejection(provider, verified.code);
    return answer(REFUSAL_STATUS[verified.code] ?? 403, REFUSED);
  }

  // Store first. This is where the (provider, provider_event_id) unique is taken, and it is what
  // makes sixty redeliveries one row and one effect.
  const recorded = await ports.recordEvent(verified.value);
  if (!recorded.ok) return answer(500, REFUSED);

  // Unattributable: the event names a provider customer we have no link to. 0157 already filed it
  // as a dead letter for the operator; there is nothing to dispatch and nothing a retry would fix.
  if (recorded.status === "dead_letter") return answer(200, ACCEPTED);

  const applied = await ports.applyEvent(verified.value.providerEventId, provider);
  if (!applied.ok) return answer(500, REFUSED);

  // 200 covers everything the database successfully decided, including a dead letter: the event is
  // held, the refusal is visible, and asking Paddle to send it fifty-nine more times would not
  // change the answer.
  return answer(200, ACCEPTED);
}
