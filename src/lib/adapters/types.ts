/**
 * Vendor-neutral integration adapter contracts (INTEGRATION-ARCHITECTURE.md §4, wave 7).
 *
 * ZERO IMPORTERS BY DESIGN (the flags.ts precedent): no screen, service or worker
 * consumes these interfaces yet. A provider implementation is a later wave — #98 defers
 * the integrations screen, and §4:96 forbids provider-specific screens before a provider
 * actually exists. What keeps these contracts from rotting is the mock suite under
 * `./mock`: `npm run build` type-checks every interface and runs the specs on every gate.
 *
 * The boundary law (§4:91-92): the mapping between an internal entity and its identity
 * at an external provider lives ONLY in `public.external_references` (0066) — the
 * `ExternalReference` tuple below mirrors that row. No `odoo_id`-style columns on
 * business tables, ever.
 */

/** Mirrors the `public.external_references` tuple (0066): one internal entity, one
 * external identity, per (org, provider, entityType) — a bijection in both directions. */
export interface ExternalReference {
  orgId: string;
  provider: string;
  /** Data, never a column name: 'supplier', 'product', 'purchase_order', ... */
  entityType: string;
  internalId: string;
  externalId: string;
}

/** A structured adapter failure. `retryable` is the adapter's honest transport verdict —
 * the outbox layer, not the caller, owns retry policy (OPEN-DECISIONS #90). */
export interface AdapterError {
  code: string;
  message: string;
  retryable: boolean;
  correlationId?: string;
}

/** How a sync conflict should be settled. `manual_review` is the default posture:
 * financial data never auto-resolves silently (the reasoned-command discipline). */
export type ConflictResolution = 'local_wins' | 'remote_wins' | 'manual_review';

/** Every adapter call answers with exactly one of the three outcomes — a discriminated
 * union so callers must handle conflict and failure explicitly, never by exception. */
export type AdapterResult<T> =
  | { status: 'ok'; value: T; reference: ExternalReference | null }
  | { status: 'conflict'; error: AdapterError; suggestedResolution: ConflictResolution }
  | { status: 'failed'; error: AdapterError };

/** Import/export health for one provider connection. Unknown numbers are `null`, never
 * 0 — zero is a claim about reality (the CLAUDE.md dashboard law applies to adapters
 * too: a metric without data shows nothing, not a fake zero). */
export interface SyncStatus {
  provider: string;
  connected: boolean;
  /** ISO timestamp of the last successful sync, or null when none is known. */
  lastSuccessAt: string | null;
  pendingCount: number | null;
  failedCount: number | null;
}
