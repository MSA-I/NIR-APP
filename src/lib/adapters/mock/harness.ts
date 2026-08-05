/**
 * Shared machinery for the three mock adapters (wave 7). ZERO IMPORTERS BY DESIGN
 * outside `src/lib/adapters/mock/**` — production code never touches a mock.
 *
 * The point of the mocks (INTEGRATION-ARCHITECTURE.md §4:81-82): the adapter
 * architecture is testable WITHOUT an external provider. Failures and conflicts are
 * INJECTABLE — a spec queues the outcome it wants and the next adapter call consumes it
 * exactly once, so both unhappy paths of the AdapterResult union are exercised
 * deterministically.
 */
import type {
  AdapterError,
  AdapterResult,
  ConflictResolution,
  ExternalReference,
  SyncStatus,
} from '../types';

type InjectedOutcome =
  | { kind: 'failure'; error: AdapterError }
  | { kind: 'conflict'; error: AdapterError; suggestedResolution: ConflictResolution };

export class MockAdapterHarness {
  readonly orgId: string;
  readonly provider: string;

  private readonly references = new Map<string, ExternalReference>();
  private readonly queue: InjectedOutcome[] = [];
  private sequence = 0;
  private succeeded = 0;
  private failed = 0;
  private lastSuccessAt: string | null = null;

  constructor(orgId: string, provider: string) {
    this.orgId = orgId;
    this.provider = provider;
  }

  /** The NEXT adapter call fails once with this error, then the mock recovers. */
  injectFailure(error?: Partial<AdapterError>): void {
    this.queue.push({
      kind: 'failure',
      error: {
        code: error?.code ?? 'mock_provider_unavailable',
        message: error?.message ?? 'injected failure',
        retryable: error?.retryable ?? true,
        ...(error?.correlationId ? { correlationId: error.correlationId } : {}),
      },
    });
  }

  /** The NEXT adapter call reports a conflict once, then the mock recovers. */
  injectConflict(
    suggestedResolution: ConflictResolution = 'manual_review',
    error?: Partial<AdapterError>,
  ): void {
    this.queue.push({
      kind: 'conflict',
      suggestedResolution,
      error: {
        code: error?.code ?? 'mock_mapping_conflict',
        message: error?.message ?? 'injected conflict',
        retryable: error?.retryable ?? false,
        ...(error?.correlationId ? { correlationId: error.correlationId } : {}),
      },
    });
  }

  /** Runs one adapter call: consumes an injected outcome if queued, otherwise succeeds
   * with `value()` and the (optional) reference recorded for it. */
  run<T>(value: () => T, reference: ExternalReference | null = null): AdapterResult<T> {
    const injected = this.queue.shift();
    if (injected?.kind === 'failure') {
      this.failed += 1;
      return { status: 'failed', error: injected.error };
    }
    if (injected?.kind === 'conflict') {
      this.failed += 1;
      return {
        status: 'conflict',
        error: injected.error,
        suggestedResolution: injected.suggestedResolution,
      };
    }
    this.succeeded += 1;
    this.lastSuccessAt = new Date().toISOString();
    return { status: 'ok', value: value(), reference };
  }

  /** Returns the stable external reference for an internal entity, minting one on first
   * sight — the same (entityType, internalId) always maps to the same externalId, the
   * external_references bijection in miniature. */
  reference(entityType: string, internalId: string): ExternalReference {
    const key = `${entityType}:${internalId}`;
    const existing = this.references.get(key);
    if (existing) return existing;
    this.sequence += 1;
    const minted: ExternalReference = {
      orgId: this.orgId,
      provider: this.provider,
      entityType,
      internalId,
      externalId: `mock-${entityType}-${String(this.sequence).padStart(4, '0')}`,
    };
    this.references.set(key, minted);
    return minted;
  }

  /** Reverse lookup by external identity; null when unknown (an answer, not an error). */
  findByExternalId(entityType: string, externalId: string): ExternalReference | null {
    for (const reference of this.references.values()) {
      if (reference.entityType === entityType && reference.externalId === externalId) {
        return reference;
      }
    }
    return null;
  }

  status(): SyncStatus {
    return {
      provider: this.provider,
      connected: true,
      lastSuccessAt: this.lastSuccessAt,
      pendingCount: this.queue.length,
      failedCount: this.failed,
    };
  }
}
