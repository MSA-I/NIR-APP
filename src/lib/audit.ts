/**
 * Legacy caller marker. P0 removed browser INSERT on audit_logs because a browser cannot be
 * trusted to assert that a mutation happened or to author its old/new values. Server triggers
 * still record the real row change. Reasoned business commands not yet moved into an RPC are
 * intentionally reported as unlogged until their owning P1/P2 cutover is implemented.
 */
export async function logAction(opts: {
  orgId: string;
  action: string;
  entityType: string;
  entityId?: string;
  reason?: string;
  oldValues?: Record<string, unknown>;
  newValues?: Record<string, unknown>;
}) {
  console.error('[supplyflow] legacy client-authored audit is disabled:', opts.action);
  return { logged: false as const };
}
