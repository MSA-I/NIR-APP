export class EgressReservationDeniedError extends Error {
  constructor() {
    super("egress_reservation_denied");
  }
}

export type ReservedEgressOutcome<TResult> =
  | { ok: true; result: TResult }
  | { ok: false; error: unknown };

export interface ReservedEgressOptions<TLease, TResult> {
  reserve: () => Promise<TLease | null>;
  perform: (lease: TLease) => Promise<TResult>;
  /**
   * Settlement is deliberately not lifecycle-gated. The reservation is the permission to start;
   * once external I/O happened, its immutable evidence must be recorded even if lifecycle state
   * changes before the provider responds.
   */
  settle: (
    lease: TLease,
    outcome: ReservedEgressOutcome<TResult>,
  ) => Promise<unknown>;
}

/**
 * Runs one externally observable operation under a database reservation. A denied reservation
 * never calls the provider. A completed provider attempt is always settled before its result or
 * error reaches the caller, and a settlement failure can never be reported as success.
 */
export async function runReservedEgress<TLease, TResult>(
  options: ReservedEgressOptions<TLease, TResult>,
): Promise<TResult> {
  const lease = await options.reserve();
  if (lease === null) throw new EgressReservationDeniedError();

  let outcome: ReservedEgressOutcome<TResult>;
  try {
    outcome = { ok: true, result: await options.perform(lease) };
  } catch (error) {
    outcome = { ok: false, error };
  }

  await options.settle(lease, outcome);
  if (outcome.ok) return outcome.result;
  throw outcome.error;
}
