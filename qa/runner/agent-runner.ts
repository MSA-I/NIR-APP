import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import {
  blockedRoleRunResult,
  createAgentScenarioContext,
  createQaModelAdapter,
  createVerifierAgent,
  runQaAgentOrchestrator,
  type QaAgentOrchestratorResult,
} from '../agents/index.ts';
import { setupRoleAuthentication } from '../auth/auth.setup.ts';
import { createSafeBrowserTools } from '../browser/browser-tools.ts';
import { ConsoleMonitor } from '../browser/console-monitor.ts';
import { DownloadMonitor } from '../browser/download-monitor.ts';
import { NetworkMonitor } from '../browser/network-monitor.ts';
import { QA_ORGANIZATION_ID, QA_ROLES, type QaRole } from '../config/roles.ts';
import { getScenario, type ScenarioId } from '../scenarios/index.ts';
import { redactText, safeJson } from '../reporting/redact.ts';
import {
  verifyAuditLogs,
  createVerificationResult,
  verifyDatabaseRows,
  verifyDataIntegrity,
  verifyExportFiles,
  type AuditExpectation,
  type DataIntegrityInput,
  type DatabaseRowExpectation,
  type ExportExpectation,
  type VerificationResult,
} from '../verification/index.ts';
import {
  acquireLocalVerificationRuntime,
  type LocalVerificationRuntime,
} from '../verification/runtime.ts';
import { acquireQaLock, releaseQaLock, type QaLockHandle } from './lock.ts';
import { loadReadyQaState } from './runtime-state.ts';
import { startQaPreview, type QaPreviewHandle } from './setup.ts';

const ROLE_SCENARIOS: Readonly<Record<QaRole, ScenarioId>> = {
  supplier: 'supplier-price-list',
  kitchen: 'kitchen-receiving',
  office: 'office-invoice-review',
  owner: 'owner-payment-approval',
  payer: 'payer-transfer-execution',
  accountant: 'accountant-reconciliation',
};

const ENTITY_TABLES: Readonly<Record<string, string>> = {
  invoice: 'invoices',
  payment_request: 'payment_requests',
  payment: 'payments',
  document: 'documents',
  purchase_order: 'purchase_orders',
  supplier_price_submission: 'supplier_price_submissions',
  goods_receipt: 'goods_receipts',
  bank_import: 'bank_imports',
  bank_transaction: 'bank_transactions',
};

const AUDIT_EVENTS: Readonly<Partial<Record<QaRole, Readonly<Record<string, {
  action: string;
  entityType: string;
}>>>>> = {
  supplier: {
    supplier_price_submission: {
      action: 'supplier_price_submission_processed',
      entityType: 'supplier_price_submissions',
    },
  },
  kitchen: {
    goods_receipt: { action: 'goods_receipt_completed', entityType: 'goods_receipts' },
  },
  office: {
    invoice: { action: 'invoice_created', entityType: 'invoices' },
    payment_request: { action: 'payment_request_created', entityType: 'payment_requests' },
  },
  owner: {
    payment_request: { action: 'payment_request_transitioned', entityType: 'payment_requests' },
  },
  payer: {
    payment_request: { action: 'payment_request_executed', entityType: 'payment_requests' },
  },
  accountant: {
    bank_import: { action: 'bank_import_created', entityType: 'bank_imports' },
    bank_transaction: { action: 'bank_match_confirmed', entityType: 'bank_transactions' },
  },
};

type AgentRunStatus = 'PASSED' | 'FAILED' | 'BLOCKED' | 'SKIPPED_BY_CONFIGURATION';

export interface AgentRunResult {
  schemaVersion: 1;
  runId: string;
  status: AgentRunStatus;
  reason: string;
  startedAt: string;
  endedAt: string;
  orchestrator: QaAgentOrchestratorResult | null;
  evidencePaths: string[];
  exitCode: number;
}

interface RoleBrowserResource {
  role: QaRole;
  context: BrowserContext;
  page: Page;
  consoleMonitor: ConsoleMonitor;
  networkMonitor: NetworkMonitor;
  downloadMonitor: DownloadMonitor;
  actions: Array<{ at: string; action: string; detail: string }>;
  evidencePath: string;
}

function enabledFromEnvironment(value: string | undefined): boolean {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error('QA_AGENT_ENABLED must be true or false.');
}

function integerOption(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error('QA agent budget is outside the allowed range.');
  }
  return parsed;
}

async function writeResult(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = filePath + '.tmp';
  await writeFile(temporary, safeJson(value) + '\n', 'utf8');
  await rename(temporary, filePath);
}

function blockedOrchestrator(runId: string, reason: string): QaAgentOrchestratorResult {
  const roleResults = QA_ROLES.map((role) => {
    const scenario = createAgentScenarioContext(getScenario(ROLE_SCENARIOS[role]), role);
    return blockedRoleRunResult({ runId, role, scenario, reason });
  });
  return {
    runId,
    status: 'blocked',
    provider: 'blocked',
    model: null,
    roleResults,
    roleOrder: QA_ROLES,
    statistics: {
      assigned: QA_ROLES.length,
      completed: 0,
      blocked: QA_ROLES.length,
      failed: 0,
      stepLimit: 0,
      observations: 0,
      verifiedChecks: 0,
      unverifiedMeaningfulActions: 0,
    },
    diagnostics: [reason],
  };
}

function fixtureMap(files: Readonly<Partial<Record<string, string>>>): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(files).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function databaseExpectations(
  entityRefs: readonly { kind: string; visibleReference: string }[],
): DatabaseRowExpectation[] | null {
  const expectations: DatabaseRowExpectation[] = [];
  for (const [index, reference] of entityRefs.entries()) {
    const table = ENTITY_TABLES[reference.kind];
    if (!table || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(reference.visibleReference)) return null;
    expectations.push({
      id: 'agent-db-' + (index + 1),
      table,
      select: 'id,org_id',
      filters: [{ column: 'id', operator: 'eq', value: reference.visibleReference }],
      expectedCount: 1,
    });
  }
  return expectations.length ? expectations : null;
}

function dataIntegrityInput(
  entityRefs: readonly { kind: string; visibleReference: string }[],
): DataIntegrityInput | null {
  const entities: NonNullable<DataIntegrityInput['entities']>[number][] = [];
  const documents: NonNullable<DataIntegrityInput['documents']>[number][] = [];
  for (const [index, reference] of entityRefs.entries()) {
    const table = ENTITY_TABLES[reference.kind];
    if (!table || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(reference.visibleReference)) return null;
    if (reference.kind === 'document') {
      documents.push({
        id: 'agent-integrity-' + (index + 1),
        documentId: reference.visibleReference,
        orgId: QA_ORGANIZATION_ID,
      });
    } else {
      entities.push({
        id: 'agent-integrity-' + (index + 1),
        table,
        rowId: reference.visibleReference,
        orgId: QA_ORGANIZATION_ID,
      });
    }
  }
  return entities.length || documents.length ? { entities, documents } : null;
}

function auditExpectation(
  role: QaRole,
  entityRefs: readonly { kind: string; visibleReference: string }[],
  createdAfter: string,
  actorUserId?: string,
): AuditExpectation | null {
  for (const reference of entityRefs) {
    const event = AUDIT_EVENTS[role]?.[reference.kind];
    if (event && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(reference.visibleReference)) {
      return {
        id: 'agent-audit',
        orgId: QA_ORGANIZATION_ID,
        action: event.action,
        entityType: event.entityType,
        entityId: reference.visibleReference,
        actorUserId,
        createdAfter,
        reasonRequired: true,
        minCount: 1,
      };
    }
  }
  return null;
}

interface TrustedMeaningfulExpectations {
  readonly database: readonly DatabaseRowExpectation[];
  readonly integrity: DataIntegrityInput;
  readonly audit: readonly AuditExpectation[];
}

function trustedReferences(
  entityRefs: readonly { kind: string; visibleReference: string }[],
): ReadonlyMap<string, string> | null {
  const result = new Map<string, string>();
  for (const reference of entityRefs) {
    if (!ENTITY_TABLES[reference.kind]
        || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(reference.visibleReference)
        || result.has(reference.kind)) return null;
    result.set(reference.kind, reference.visibleReference);
  }
  return result.size ? result : null;
}

function trustedAudit(
  role: QaRole,
  kind: string,
  entityId: string,
  actorUserId: string,
  createdAfter: string,
): AuditExpectation | null {
  const event = AUDIT_EVENTS[role]?.[kind];
  return event ? {
    id: `agent-${role}-${kind}-audit`,
    orgId: QA_ORGANIZATION_ID,
    action: event.action,
    entityType: event.entityType,
    entityId,
    actorUserId,
    createdAfter,
    reasonRequired: true,
    exactCount: 1,
  } : null;
}

function trustedMeaningfulExpectations(
  role: QaRole,
  entityRefs: readonly { kind: string; visibleReference: string }[],
  actorUserId: string,
  createdAfter: string,
): TrustedMeaningfulExpectations | null {
  const refs = trustedReferences(entityRefs);
  if (!refs) return null;
  const entity = (kind: string, expectedFields: Record<string, string | number | boolean | null>) => ({
    id: `agent-${role}-${kind}-integrity`,
    table: ENTITY_TABLES[kind],
    rowId: refs.get(kind)!,
    orgId: QA_ORGANIZATION_ID,
    expectedFields,
  });
  const row = (
    id: string,
    table: string,
    select: string,
    filters: DatabaseRowExpectation['filters'],
    expectedSubsets?: DatabaseRowExpectation['expectedSubsets'],
    expectedCount = 1,
  ): DatabaseRowExpectation => ({ id, table, select, filters, expectedSubsets, expectedCount });

  if (role === 'supplier') {
    const submissionId = refs.get('supplier_price_submission');
    if (!submissionId) return null;
    const audit = trustedAudit(role, 'supplier_price_submission', submissionId, actorUserId, createdAfter);
    if (!audit) return null;
    return {
      database: [row(
        'agent-supplier-submission-row',
        'supplier_price_submissions',
        'id,org_id,submitted_by,status,row_count,accepted_count,rejected_count,unchanged_count',
        [
          { column: 'id', operator: 'eq', value: submissionId },
          { column: 'org_id', operator: 'eq', value: QA_ORGANIZATION_ID },
          { column: 'submitted_by', operator: 'eq', value: actorUserId },
          { column: 'status', operator: 'in', value: ['accepted', 'accepted_with_rejections', 'rejected'] },
        ],
        [{
          id: submissionId,
          org_id: QA_ORGANIZATION_ID,
          submitted_by: actorUserId,
          status: 'accepted',
          row_count: 3,
        }],
      )],
      integrity: {
        entities: [entity('supplier_price_submission', {
          submitted_by: actorUserId,
          status: 'accepted',
          row_count: 3,
        })],
      },
      audit: [audit],
    };
  }

  if (role === 'kitchen') {
    const receiptId = refs.get('goods_receipt');
    if (!receiptId) return null;
    const audit = trustedAudit(role, 'goods_receipt', receiptId, actorUserId, createdAfter);
    if (!audit) return null;
    return {
      database: [
        row('agent-kitchen-receipt-row', 'goods_receipts', 'id,org_id,status,received_by', [
          { column: 'id', operator: 'eq', value: receiptId },
          { column: 'org_id', operator: 'eq', value: QA_ORGANIZATION_ID },
        ], [{ id: receiptId, org_id: QA_ORGANIZATION_ID, status: 'completed', received_by: actorUserId }]),
        { id: 'agent-kitchen-receipt-lines', table: 'goods_receipt_items', select: 'id,receipt_id,order_item_id,qty_received,status', filters: [{ column: 'receipt_id', operator: 'eq', value: receiptId }], minCount: 1 },
      ],
      integrity: { entities: [entity('goods_receipt', { status: 'completed', received_by: actorUserId })] },
      audit: [audit],
    };
  }

  if (role === 'office' && refs.has('payment_request')) {
    const requestId = refs.get('payment_request')!;
    const invoiceId = refs.get('invoice');
    if (!invoiceId) return null;
    const audit = trustedAudit(role, 'payment_request', requestId, actorUserId, createdAfter);
    if (!audit) return null;
    return {
      database: [
        row('agent-office-request-row', 'payment_requests', 'id,org_id,status,created_by', [
          { column: 'id', operator: 'eq', value: requestId },
          { column: 'org_id', operator: 'eq', value: QA_ORGANIZATION_ID },
        ], [{ id: requestId, org_id: QA_ORGANIZATION_ID, status: 'pending_approval', created_by: actorUserId }]),
        row('agent-office-request-invoice', 'payment_request_invoices', 'payment_request_id,invoice_id,amount_allocated', [
          { column: 'payment_request_id', operator: 'eq', value: requestId },
        ], [{ payment_request_id: requestId, invoice_id: invoiceId }]),
      ],
      integrity: {
        entities: [entity('payment_request', { status: 'pending_approval', created_by: actorUserId })],
        invoices: [{ id: 'agent-office-request-invoice-balance', invoiceId, orgId: QA_ORGANIZATION_ID, expectedPaymentStatus: 'unpaid' }],
      },
      audit: [audit],
    };
  }

  if (role === 'office') {
    const invoiceId = refs.get('invoice');
    const documentId = refs.get('document');
    if (!invoiceId || !documentId) return null;
    const audit = trustedAudit(role, 'invoice', invoiceId, actorUserId, createdAfter);
    if (!audit) return null;
    return {
      database: [
        row('agent-office-invoice-row', 'invoices', 'id,org_id,received_by,payment_status,deleted_at', [
          { column: 'id', operator: 'eq', value: invoiceId },
          { column: 'org_id', operator: 'eq', value: QA_ORGANIZATION_ID },
          { column: 'deleted_at', operator: 'is', value: null },
        ], [{ id: invoiceId, org_id: QA_ORGANIZATION_ID, received_by: actorUserId, payment_status: 'unpaid', deleted_at: null }]),
        row('agent-office-invoice-document-row', 'documents', 'id,org_id,entity_type,entity_id,uploaded_by,deleted_at', [
          { column: 'id', operator: 'eq', value: documentId },
          { column: 'org_id', operator: 'eq', value: QA_ORGANIZATION_ID },
          { column: 'deleted_at', operator: 'is', value: null },
        ], [{ id: documentId, org_id: QA_ORGANIZATION_ID, entity_type: 'invoice', entity_id: invoiceId, uploaded_by: actorUserId, deleted_at: null }]),
      ],
      integrity: {
        entities: [entity('invoice', { received_by: actorUserId, payment_status: 'unpaid', deleted_at: null })],
        documents: [{ id: 'agent-office-invoice-document', documentId, orgId: QA_ORGANIZATION_ID, expectedDeleted: false }],
        invoices: [{ id: 'agent-office-invoice-balance', invoiceId, orgId: QA_ORGANIZATION_ID, expectedPaymentStatus: 'unpaid' }],
      },
      audit: [audit],
    };
  }

  if (role === 'owner') {
    const requestId = refs.get('payment_request');
    if (!requestId) return null;
    const audit = trustedAudit(role, 'payment_request', requestId, actorUserId, createdAfter);
    if (!audit) return null;
    return {
      database: [row('agent-owner-request-row', 'payment_requests', 'id,org_id,status,approved_by,approved_at', [
        { column: 'id', operator: 'eq', value: requestId },
        { column: 'org_id', operator: 'eq', value: QA_ORGANIZATION_ID },
      ], [{ id: requestId, org_id: QA_ORGANIZATION_ID, status: 'approved', approved_by: actorUserId }])],
      integrity: { entities: [entity('payment_request', { status: 'approved', approved_by: actorUserId })] },
      audit: [audit],
    };
  }

  if (role === 'payer') {
    const requestId = refs.get('payment_request');
    const paymentId = refs.get('payment');
    const invoiceId = refs.get('invoice');
    if (!requestId || !paymentId || !invoiceId) return null;
    const audit = trustedAudit(role, 'payment_request', requestId, actorUserId, createdAfter);
    if (!audit) return null;
    return {
      database: [
        row('agent-payer-request-row', 'payment_requests', 'id,org_id,status', [
          { column: 'id', operator: 'eq', value: requestId },
          { column: 'org_id', operator: 'eq', value: QA_ORGANIZATION_ID },
        ], [{ id: requestId, org_id: QA_ORGANIZATION_ID, status: 'executed' }]),
        row('agent-payer-payment-unique', 'payments', 'id,org_id,payment_request_id,executed_by,amount', [
          { column: 'payment_request_id', operator: 'eq', value: requestId },
          { column: 'org_id', operator: 'eq', value: QA_ORGANIZATION_ID },
        ], [{ id: paymentId, payment_request_id: requestId, executed_by: actorUserId }]),
        { id: 'agent-payer-allocations', table: 'payment_allocations', select: 'id,payment_id,invoice_id,credit_id,amount', filters: [{ column: 'payment_id', operator: 'eq', value: paymentId }], expectedCount: 1, expectedSubsets: [{ payment_id: paymentId, invoice_id: invoiceId }] },
      ],
      integrity: {
        entities: [
          entity('payment_request', { status: 'executed' }),
          entity('payment', { payment_request_id: requestId, executed_by: actorUserId }),
        ],
        invoices: [{ id: 'agent-payer-invoice-balance', invoiceId, orgId: QA_ORGANIZATION_ID }],
      },
      audit: [audit],
    };
  }

  if (role === 'accountant' && refs.has('bank_transaction')) {
    const transactionId = refs.get('bank_transaction')!;
    const paymentId = refs.get('payment');
    if (!paymentId) return null;
    const audit = trustedAudit(role, 'bank_transaction', transactionId, actorUserId, createdAfter);
    if (!audit) return null;
    return {
      database: [
        row('agent-accountant-transaction-row', 'bank_transactions', 'id,org_id,status,supplier_id,amount', [
          { column: 'id', operator: 'eq', value: transactionId },
          { column: 'org_id', operator: 'eq', value: QA_ORGANIZATION_ID },
        ], [{ id: transactionId, org_id: QA_ORGANIZATION_ID, status: 'matched' }]),
        row('agent-accountant-bank-allocation', 'bank_allocations', 'id,org_id,bank_transaction_id,payment_id,amount,confirmed,created_by', [
          { column: 'bank_transaction_id', operator: 'eq', value: transactionId },
          { column: 'org_id', operator: 'eq', value: QA_ORGANIZATION_ID },
        ], [{ bank_transaction_id: transactionId, payment_id: paymentId, confirmed: true, created_by: actorUserId }]),
      ],
      integrity: { entities: [entity('bank_transaction', { status: 'matched' }), entity('payment', {})] },
      audit: [audit],
    };
  }

  if (role === 'accountant') {
    const importId = refs.get('bank_import');
    if (!importId) return null;
    const audit = trustedAudit(role, 'bank_import', importId, actorUserId, createdAfter);
    if (!audit) return null;
    return {
      database: [
        row('agent-accountant-import-row', 'bank_imports', 'id,org_id,row_count,imported_by', [
          { column: 'id', operator: 'eq', value: importId },
          { column: 'org_id', operator: 'eq', value: QA_ORGANIZATION_ID },
        ], [{ id: importId, org_id: QA_ORGANIZATION_ID, row_count: 1, imported_by: actorUserId }]),
        row('agent-accountant-imported-transaction', 'bank_transactions', 'id,org_id,import_id,status', [
          { column: 'import_id', operator: 'eq', value: importId },
          { column: 'org_id', operator: 'eq', value: QA_ORGANIZATION_ID },
        ], [{ import_id: importId, org_id: QA_ORGANIZATION_ID, status: 'unmatched' }]),
      ],
      integrity: { entities: [entity('bank_import', { row_count: 1, imported_by: actorUserId })] },
      audit: [audit],
    };
  }

  return null;
}

function exportExpectations(resource: RoleBrowserResource): ExportExpectation[] {
  const expectations: ExportExpectation[] = [];
  for (const [index, entry] of resource.downloadMonitor.entries.entries()) {
    if (!entry.path || entry.failure || entry.bytes <= 0 || !entry.sha256) continue;
    const extension = path.extname(entry.fileName).toLowerCase();
    const base = { id: 'agent-export-' + (index + 1), filePath: entry.path };
    if (extension === '.xlsx') expectations.push({ ...base, kind: 'xlsx', minRowCount: 1, forbidFormulas: true });
    else if (extension === '.csv') expectations.push({ ...base, kind: 'csv', minRowCount: 1 });
    else if (extension === '.pdf') expectations.push({ ...base, kind: 'pdf' });
    else if (extension === '.jpg' || extension === '.jpeg') expectations.push({ ...base, kind: 'jpg' });
  }
  return expectations;
}

async function saveVerifierResult(
  artifactRoot: string,
  role: QaRole,
  step: number,
  checkId: string,
  verification: VerificationResult,
): Promise<string> {
  const relative = path.join(
    'agents',
    role,
    'verification',
    String(step).padStart(2, '0') + '-' + checkId + '.json',
  ).replaceAll('\\', '/');
  await writeResult(path.join(artifactRoot, relative), verification);
  return relative;
}

function createAgentVerifier(
  runtime: LocalVerificationRuntime,
  artifactRoot: string,
  allowedCheckIds: readonly string[],
  resourcesByRole: ReadonlyMap<QaRole, RoleBrowserResource>,
  userIds: Readonly<Record<QaRole, string>>,
  createdAfter: string,
) {
  return createVerifierAgent({
    allowedCheckIds,
    callback: async (input) => {
      let verification: VerificationResult;
      let evidenceKind: 'database' | 'audit' | 'download';
      if (input.meaningfulBusinessAction) {
        if (!input.mutationEvidence) {
          return {
            status: 'blocked',
            summary: 'Trusted browser mutation evidence is unavailable for this action.',
            evidence: [],
            facts: [{ key: 'trusted_mutation_evidence', value: false }],
          };
        }
        if (input.request.checkId !== 'data-integrity') {
          return {
            status: 'blocked',
            summary: 'Meaningful business actions require the trusted composite data-integrity verifier.',
            evidence: [],
            facts: [{ key: 'trusted_composite_required', value: true }],
          };
        }
        const expectations = trustedMeaningfulExpectations(
          input.role,
          input.mutationEvidence.entityRefs,
          userIds[input.role],
          createdAfter,
        );
        if (!expectations) {
          return {
            status: 'blocked',
            summary: 'The orchestrator has no complete trusted role/entity mapping for this financial action.',
            evidence: [],
            facts: [{ key: 'trusted_mapping_complete', value: false }],
          };
        }
        const [database, integrity, audit] = await Promise.all([
          verifyDatabaseRows(runtime, expectations.database),
          verifyDataIntegrity(runtime, expectations.integrity),
          verifyAuditLogs(runtime, expectations.audit),
        ]);
        verification = createVerificationResult(
          'trusted-business-action',
          'Database state, tenant integrity, actor attribution, audit reason, and relevant uniqueness/relationship checks were evaluated together.',
          [...database.checks, ...integrity.checks, ...audit.checks],
          { mutationMethodsExposed: false, componentStatuses: [database.status, integrity.status, audit.status] },
        );
        evidenceKind = 'database';
      } else if (input.request.checkId === 'database') {
        const expectations = databaseExpectations(input.request.entityRefs);
        if (!expectations) {
          return {
            status: 'blocked',
            summary: 'Database verification requires an allowlisted entity kind and visible UUID.',
            evidence: [],
            facts: [{ key: 'entity_reference_valid', value: false }],
          };
        }
        verification = await verifyDatabaseRows(runtime, expectations);
        evidenceKind = 'database';
      } else if (input.request.checkId === 'data-integrity') {
        const expectations = dataIntegrityInput(input.request.entityRefs);
        if (!expectations) {
          return {
            status: 'blocked',
            summary: 'Data-integrity verification requires an allowlisted entity kind and visible UUID.',
            evidence: [],
            facts: [{ key: 'entity_reference_valid', value: false }],
          };
        }
        verification = await verifyDataIntegrity(runtime, expectations);
        evidenceKind = 'database';
      } else if (input.request.checkId === 'audit') {
        const expectation = auditExpectation(
          input.role,
          input.request.entityRefs,
          createdAfter,
          userIds[input.role],
        );
        if (!expectation) {
          return {
            status: 'blocked',
            summary: 'No trusted role/entity audit mapping exists for the visible reference.',
            evidence: [],
            facts: [{ key: 'audit_mapping_available', value: false }],
          };
        }
        verification = await verifyAuditLogs(runtime, [expectation]);
        evidenceKind = 'audit';
      } else if (input.request.checkId === 'export') {
        const resource = resourcesByRole.get(input.role);
        if (!resource) {
          return {
            status: 'blocked',
            summary: 'The role download monitor is unavailable.',
            evidence: [],
            facts: [{ key: 'download_monitor_available', value: false }],
          };
        }
        await writeRoleBrowserEvidence(resource, artifactRoot);
        const expectations = exportExpectations(resource);
        if (!expectations.length) {
          return {
            status: 'blocked',
            summary: 'No supported, non-empty download was captured for deterministic parsing.',
            evidence: [],
            facts: [{ key: 'supported_download_count', value: 0 }],
          };
        }
        verification = await verifyExportFiles(expectations, artifactRoot);
        evidenceKind = 'download';
      } else {
        return {
          status: 'blocked',
          summary: 'No safe deterministic mapping exists for this verifier request.',
          evidence: [],
          facts: [{ key: 'mapping_available', value: false }],
        };
      }
      const relative = await saveVerifierResult(
        artifactRoot,
        input.role,
        input.step,
        input.request.checkId,
        verification,
      );
      return {
        status: verification.status === 'PASS'
          ? 'verified'
          : verification.status === 'FAIL'
          ? 'failed'
          : 'blocked',
        summary: verification.summary,
        evidence: [{ kind: evidenceKind, ref: relative }],
        facts: [
          { key: 'check_count', value: verification.checks.length },
          { key: 'all_checks_pass', value: verification.status === 'PASS' },
        ],
      };
    },
  });
}

async function prepareRoleBrowser(
  browser: Browser,
  state: Awaited<ReturnType<typeof loadReadyQaState>>,
  role: QaRole,
): Promise<{
  resource: RoleBrowserResource;
  assignment: Parameters<typeof runQaAgentOrchestrator>[0]['assignments'][number];
}> {
  const storageState = state.authStates[role];
  if (!storageState) throw new Error('Authenticated storage state is missing for role ' + role + '.');
  const context = await browser.newContext({
    storageState,
    locale: 'he-IL',
    timezoneId: 'Asia/Jerusalem',
    serviceWorkers: 'block',
    viewport: role === 'kitchen' ? { width: 390, height: 844 } : { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  const consoleMonitor = new ConsoleMonitor(page);
  const networkMonitor = new NetworkMonitor(page);
  const downloadMonitor = new DownloadMonitor(page, path.join(state.artifactRoot, 'agents', role, 'downloads'));
  const actions: RoleBrowserResource['actions'] = [];
  const definition = getScenario(ROLE_SCENARIOS[role]);
  const scenario = createAgentScenarioContext(definition, role);
  const evidencePath = path.join(state.artifactRoot, 'agents', role, 'browser-evidence.json');
  const relativeEvidencePath = path.relative(state.artifactRoot, evidencePath).replaceAll('\\', '/');
  await page.goto(state.environment.baseUrl + '/dashboard', { waitUntil: 'domcontentloaded' });
  if (new URL(page.url()).pathname === '/login') throw new Error('Role session is not authenticated: ' + role + '.');
  const browserTools = createSafeBrowserTools({
    page,
    baseUrl: state.environment.baseUrl,
    allowedRoutes: scenario.allowedRoutes,
    fixtures: fixtureMap(state.fixtureFiles),
    screenshotDirectory: path.join(state.artifactRoot, 'agents', role, 'screenshots'),
    record: (action, detail) => actions.push({
      at: new Date().toISOString(),
      action,
      detail,
    }),
  });
  const resource: RoleBrowserResource = {
    role,
    context,
    page,
    consoleMonitor,
    networkMonitor,
    downloadMonitor,
    actions,
    evidencePath,
  };
  return {
    resource,
    assignment: {
      role,
      scenario,
      browserTools,
      analyzeAfterActions: true,
      initialEvidence: [
        { kind: 'action-trace', ref: relativeEvidencePath, source: 'browser' },
        { kind: 'console', ref: relativeEvidencePath, source: 'browser' },
        { kind: 'network', ref: relativeEvidencePath, source: 'browser' },
      ],
      collectEvidence: async () => {
        await writeRoleBrowserEvidence(resource, state.artifactRoot);
        return resource.downloadMonitor.entries.flatMap((entry) => entry.path
          && !entry.failure
          && entry.bytes > 0
          && entry.sha256
          ? [{
              kind: 'download' as const,
              ref: path.relative(state.artifactRoot, entry.path).replaceAll('\\', '/'),
              source: 'browser' as const,
            }]
          : []);
      },
    },
  };
}

async function writeRoleBrowserEvidence(
  resource: RoleBrowserResource,
  artifactRoot: string,
): Promise<{ relative: string; blockingIssues: readonly string[] }> {
  const blockingIssues = [
    ...resource.consoleMonitor.blockingIssues(),
    ...resource.networkMonitor.blockingIssues(),
    ...await resource.downloadMonitor.blockingIssues(),
  ];
  const relative = path.relative(artifactRoot, resource.evidencePath).replaceAll('\\', '/');
  await writeResult(resource.evidencePath, {
    role: resource.role,
    actions: resource.actions,
    console: resource.consoleMonitor.entries,
    network: resource.networkMonitor.entries,
    downloads: resource.downloadMonitor.entries.map(({ path: _path, ...entry }) => entry),
    blockingIssues,
  });
  return { relative, blockingIssues };
}

async function finalizeRoleBrowser(
  resource: RoleBrowserResource,
  artifactRoot: string,
): Promise<string> {
  const evidence = await writeRoleBrowserEvidence(resource, artifactRoot);
  resource.consoleMonitor.stop();
  resource.networkMonitor.stop();
  resource.downloadMonitor.stop();
  await resource.context.close();
  if (evidence.blockingIssues.length) {
    throw new Error(
      `Role ${resource.role} produced ${evidence.blockingIssues.length} blocking browser evidence issue(s).`,
    );
  }
  return evidence.relative;
}

export async function runAgentQa(repoRoot = process.cwd()): Promise<AgentRunResult> {
  const state = await loadReadyQaState(path.resolve(repoRoot));
  const outputPath = path.join(state.artifactRoot, 'results', 'agents.json');
  const startedAt = new Date().toISOString();
  const enabled = enabledFromEnvironment(process.env.QA_AGENT_ENABLED);
  if (!enabled) {
    const result: AgentRunResult = {
      schemaVersion: 1,
      runId: state.runId,
      status: 'SKIPPED_BY_CONFIGURATION',
      reason: 'QA agent phase is disabled by configuration.',
      startedAt,
      endedAt: new Date().toISOString(),
      orchestrator: null,
      evidencePaths: [],
      exitCode: 0,
    };
    await writeResult(outputPath, result);
    return result;
  }

  const modelAdapter = createQaModelAdapter({
    enabled: true,
    provider: process.env.QA_MODEL_PROVIDER,
    model: process.env.QA_MODEL_NAME,
    apiKey: process.env.QA_MODEL_API_KEY,
  });
  if (modelAdapter.availability.status === 'blocked') {
    const reason = modelAdapter.availability.reason;
    const result: AgentRunResult = {
      schemaVersion: 1,
      runId: state.runId,
      status: 'BLOCKED',
      reason,
      startedAt,
      endedAt: new Date().toISOString(),
      orchestrator: blockedOrchestrator(state.runId, reason),
      evidencePaths: [],
      exitCode: 2,
    };
    await writeResult(outputPath, result);
    return result;
  }

  let lock: QaLockHandle | undefined;
  let preview: QaPreviewHandle | undefined;
  let browser: Browser | undefined;
  let verificationRuntime: LocalVerificationRuntime | undefined;
  const resources: RoleBrowserResource[] = [];
  const resourcesByRole = new Map<QaRole, RoleBrowserResource>();
  const evidencePaths: string[] = [];
  let orchestrator: QaAgentOrchestratorResult | null = null;
  let status: AgentRunStatus = 'BLOCKED';
  let reason = 'Agent runtime did not start.';

  try {
    const lockResult = await acquireQaLock({ repoRoot: state.repoRoot, runId: 'agents-' + state.runId });
    if (lockResult.status === 'BLOCKED') {
      reason = lockResult.message;
    } else {
      lock = lockResult.handle;
      await access(chromium.executablePath());
      preview = await startQaPreview({
        repoRoot: state.repoRoot,
        baseUrl: state.environment.baseUrl,
        anonKey: state.browserPublic.supabaseAnonKey,
      });
      const auth = await setupRoleAuthentication({
        apiUrl: state.environment.supabaseUrl,
        anonKey: state.browserPublic.supabaseAnonKey,
        credentialsPath: state.credentialsManifest,
        authDirectory: state.authRoot,
        runId: state.runId,
        baseUrl: state.environment.baseUrl,
      });
      state.authStates = auth.states;
      verificationRuntime = await acquireLocalVerificationRuntime({ repoRoot: state.repoRoot });
      browser = await chromium.launch({ headless: true });

      const prepared = [];
      for (const role of QA_ROLES) {
        const next = await prepareRoleBrowser(browser, state, role);
        resources.push(next.resource);
        resourcesByRole.set(role, next.resource);
        prepared.push(next.assignment);
      }
      const allowedCheckIds = [...new Set(prepared.flatMap(
        ({ scenario }) => scenario.allowedVerificationChecks,
      ))];
      orchestrator = await runQaAgentOrchestrator({
        runId: state.runId,
        modelAdapter,
        verifierAgent: createAgentVerifier(
          verificationRuntime,
          state.artifactRoot,
          allowedCheckIds,
          resourcesByRole,
          auth.userIds,
          startedAt,
        ),
        assignments: prepared,
        beforeRole: async ({ assignment, completedRoleResults }) => {
          const incomplete = assignment.scenario.definition.dependsOn.filter((scenarioId) =>
            completedRoleResults.find((result) => result.scenarioId === scenarioId)?.status !== 'completed'
          );
          return incomplete.length
            ? { status: 'blocked', reason: 'scenario_dependency_not_completed:' + incomplete.join(',') }
            : { status: 'ready' };
        },
        defaultMaxSteps: integerOption(process.env.QA_MAX_AGENT_STEPS, 30, 1, 100),
        defaultMaxRetries: integerOption(process.env.QA_MAX_AGENT_RETRIES, 2, 0, 3),
      });
      const unverified = orchestrator.statistics.unverifiedMeaningfulActions > 0;
      status = orchestrator.status === 'completed' && !unverified
        ? 'PASSED'
        : orchestrator.status === 'failed' || unverified
        ? 'FAILED'
        : 'BLOCKED';
      reason = unverified
        ? 'One or more meaningful business actions lacked independent verification.'
        : 'Agent orchestration finished with status ' + orchestrator.status + '.';
    }
  } catch (error) {
    status = 'BLOCKED';
    reason = redactText(error instanceof Error ? error.message : 'Agent runtime failed.');
  } finally {
    for (const resource of resources) {
      try {
        evidencePaths.push(await finalizeRoleBrowser(resource, state.artifactRoot));
      } catch (error) {
        status = 'FAILED';
        reason = redactText(error instanceof Error ? error.message : 'Agent evidence cleanup failed.');
      }
    }
    if (browser) await browser.close().catch(() => undefined);
    verificationRuntime?.dispose();
    if (preview) {
      try {
        await preview.stop();
      } catch {
        status = 'FAILED';
        reason = 'Agent preview process did not stop cleanly.';
      }
    }
    if (lock && !await releaseQaLock(lock)) {
      status = 'FAILED';
      reason = 'QA mutex ownership could not be verified during agent cleanup.';
    }
  }

  if (!orchestrator) orchestrator = blockedOrchestrator(state.runId, reason);
  const result: AgentRunResult = {
    schemaVersion: 1,
    runId: state.runId,
    status,
    reason,
    startedAt,
    endedAt: new Date().toISOString(),
    orchestrator,
    evidencePaths,
    exitCode: status === 'PASSED' ? 0 : status === 'FAILED' ? 1 : 2,
  };
  await writeResult(outputPath, result);
  return result;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMainModule()) {
  try {
    const result = await runAgentQa();
    process.stdout.write(safeJson(result) + '\n');
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(redactText(error instanceof Error ? error.message : 'QA agent run failed.') + '\n');
    process.exitCode = 2;
  }
}
