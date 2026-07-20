import { supabase } from './supabase';

/**
 * App-level audit entry for business actions (approvals, overrides, reconciliation confirms).
 * Plain row-change history is captured automatically by DB triggers; use this for actions
 * that carry intent + reason (e.g. duplicate override).
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
  const { data } = await supabase.auth.getUser();
  const { error } = await supabase.from('audit_logs').insert({
    org_id: opts.orgId,
    user_id: data.user?.id ?? null,
    action: opts.action,
    entity_type: opts.entityType,
    entity_id: opts.entityId ?? null,
    reason: opts.reason ?? null,
    old_values: opts.oldValues ?? null,
    new_values: opts.newValues ?? null,
  });

  // Deliberately does not throw. By the time this runs the business action has already been
  // committed, so raising here would report a failure that did not happen and would break
  // callers that have no catch. It returns instead, so a caller that must guarantee the trail
  // can tell the user the action succeeded but went unrecorded — which is the truth, and is
  // what the constitution's "every sensitive action is logged" needs in order to be auditable.
  if (error) {
    console.error('[supplyflow] audit log failed:', opts.action, error.message);
    return { logged: false as const };
  }
  return { logged: true as const };
}
