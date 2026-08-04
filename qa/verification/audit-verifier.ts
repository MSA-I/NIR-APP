import type { LocalVerificationRuntime } from './runtime.ts';
import { createVerificationResult, type VerificationCheck, type VerificationResult } from './types.ts';

export interface AuditExpectation {
  id: string;
  orgId: string;
  action: string;
  entityType: string;
  entityId?: string;
  actorUserId?: string;
  createdAfter?: string;
  reasonRequired?: boolean;
  minCount?: number;
  exactCount?: number;
}

interface AuditRow {
  id: string;
  org_id: string | null;
  user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  reason: string | null;
  created_at: string;
}

interface AuditResponse {
  data: AuditRow[] | null;
  error: { message?: string } | null;
  count: number | null;
}

interface AuditQuery extends PromiseLike<AuditResponse> {
  eq(column: string, value: string): AuditQuery;
  gte(column: string, value: string): AuditQuery;
  order(column: string, options: { ascending: boolean }): AuditQuery;
}

interface AuditClient {
  from(table: 'audit_logs'): {
    select(columns: string, options: { count: 'exact' }): AuditQuery;
  };
}

async function verifyAuditExpectation(
  client: AuditClient,
  expectation: AuditExpectation,
): Promise<VerificationCheck> {
  let query = client.from('audit_logs')
    .select('id,org_id,user_id,action,entity_type,entity_id,reason,created_at', { count: 'exact' })
    .eq('org_id', expectation.orgId)
    .eq('action', expectation.action)
    .eq('entity_type', expectation.entityType);
  if (expectation.entityId) query = query.eq('entity_id', expectation.entityId);
  if (expectation.actorUserId) query = query.eq('user_id', expectation.actorUserId);
  if (expectation.createdAfter) query = query.gte('created_at', expectation.createdAfter);
  const response = await query.order('created_at', { ascending: false });

  if (response.error) {
    return {
      id: expectation.id,
      status: 'BLOCKED',
      summary: 'Audit evidence query failed; no PASS was inferred.',
      evidence: { errorPresent: true, action: expectation.action, entityType: expectation.entityType },
    };
  }
  const rows = response.data ?? [];
  const count = response.count ?? rows.length;
  const minCount = expectation.minCount ?? 1;
  const countMatches = expectation.exactCount === undefined
    ? count >= minCount
    : count === expectation.exactCount;
  const reasonsPresent = !expectation.reasonRequired
    || (rows.length > 0 && rows.every((row) => Boolean(row.reason?.trim())));
  const tenantMatches = rows.every((row) => row.org_id === expectation.orgId);
  const actorMatches = !expectation.actorUserId
    || rows.every((row) => row.user_id === expectation.actorUserId);
  const passed = countMatches && reasonsPresent && tenantMatches && actorMatches;

  return {
    id: expectation.id,
    status: passed ? 'PASS' : 'FAIL',
    summary: passed
      ? 'Expected reasoned audit evidence is present.'
      : 'Audit count, actor, tenant, or mandatory reason did not match.',
    evidence: {
      action: expectation.action,
      entityType: expectation.entityType,
      entityId: expectation.entityId,
      observedCount: count,
      exactCount: expectation.exactCount,
      minCount,
      reasonsPresent,
      tenantMatches,
      actorMatches,
      auditIds: rows.slice(0, 20).map(({ id }) => id),
    },
  };
}

export async function verifyAuditLogs(
  runtime: LocalVerificationRuntime,
  expectations: readonly AuditExpectation[],
): Promise<VerificationResult> {
  if (expectations.length === 0) {
    return createVerificationResult('audit', 'No audit expectations were supplied.', [{
      id: 'audit-expectations-missing',
      status: 'BLOCKED',
      summary: 'Audit verification requires an explicit action/entity/tenant expectation.',
    }]);
  }
  const client = runtime.createServiceClient() as unknown as AuditClient;
  const checks: VerificationCheck[] = [];
  for (const expectation of expectations) checks.push(await verifyAuditExpectation(client, expectation));
  return createVerificationResult('audit', 'Audit logs were inspected with SELECT-only service-role evidence.', checks, {
    expectationCount: expectations.length,
    rawReasonsEmitted: false,
  });
}
