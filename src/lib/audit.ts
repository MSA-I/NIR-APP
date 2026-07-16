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
  await supabase.from('audit_logs').insert({
    org_id: opts.orgId,
    user_id: data.user?.id ?? null,
    action: opts.action,
    entity_type: opts.entityType,
    entity_id: opts.entityId ?? null,
    reason: opts.reason ?? null,
    old_values: opts.oldValues ?? null,
    new_values: opts.newValues ?? null,
  });
}
