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
  DEFAULT_CROSS_ROLE_ORDER,
  runQaAgentOrchestrator,
  trustedMutationStepId,
  type BrowserMutationEvidence,
  type QaAgentOrchestratorResult,
  type RolePreparationContext,
  type RolePreparationResult,
  type VerifierResult,
} from '../agents/index.ts';
import { setupRoleAuthentication } from '../auth/auth.setup.ts';
import { createSafeBrowserTools, matchesAllowedRoute } from '../browser/browser-tools.ts';
import { ConsoleMonitor } from '../browser/console-monitor.ts';
import { DownloadMonitor } from '../browser/download-monitor.ts';
import { NetworkMonitor } from '../browser/network-monitor.ts';
import {
  QA_ORGANIZATION_ID,
  QA_SUPPLIER_PROFILE_ID,
  type QaRole,
} from '../config/roles.ts';
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
  type VerificationCheck,
  type VerificationResult,
} from '../verification/index.ts';
import {
  acquireLocalVerificationRuntime,
  type LocalVerificationRuntime,
} from '../verification/runtime.ts';
import { acquireQaLock, releaseQaLock, type QaLockHandle } from './lock.ts';
import { loadReadyQaState } from './runtime-state.ts';
import { startQaPreview, type QaPreviewHandle } from './setup.ts';

export const ROLE_SCENARIOS: Readonly<Record<QaRole, ScenarioId>> = {
  supplier: 'supplier-price-list',
  kitchen: 'kitchen-receiving',
  office: 'office-invoice-review',
  owner: 'owner-payment-approval',
  payer: 'payer-transfer-execution',
  accountant: 'accountant-reconciliation',
};

export function agentRoleDependencyGate(
  context: RolePreparationContext,
): RolePreparationResult {
  const unavailable = context.assignment.scenario.definition.dependsOn.filter((scenarioId) => {
    const dependency = context.completedRoleResults.find(
      (result) => result.scenarioId === scenarioId,
    );
    return !dependency
      || (dependency.status !== 'completed' && dependency.blockerType !== 'PRODUCT');
  });
  return unavailable.length
    ? { status: 'blocked', reason: 'scenario_dependency_not_completed:' + unavailable.join(',') }
    : { status: 'ready' };
}

export function verifierEvidenceForResult(
  meaningfulBusinessAction: boolean,
  verificationStatus: VerificationResult['status'],
  evidenceKind: 'database' | 'audit' | 'download',
  ref: string,
): VerifierResult['evidence'] {
  return meaningfulBusinessAction && verificationStatus === 'PASS'
    ? [{ kind: 'database', ref }, { kind: 'audit', ref }]
    : [{ kind: evidenceKind, ref }];
}

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

const ALLOWED_MUTATION_PATHS: Readonly<Record<QaRole, readonly RegExp[]>> = {
  supplier: [
    /^\/functions\/v1\/submit-price-list$/,
    /^\/rest\/v1\/rpc\/(?:reserve_supplier_price_document_upload|register_supplier_price_document|enqueue_document_processing)$/,
    /^\/rest\/v1\/documents$/,
    /^\/storage\/v1\/object\/(?:documents|price-submissions)(?:\/|$)/,
  ],
  kitchen: [
    /^\/rest\/v1\/rpc\/(?:save_goods_receipt|enqueue_document_processing)$/,
    /^\/rest\/v1\/documents$/,
    /^\/storage\/v1\/object\/documents(?:\/|$)/,
  ],
  office: [
    /^\/rest\/v1\/rpc\/(?:create_invoice|set_invoice_review_status|create_payment_request|transition_payment_request|enqueue_document_processing)$/,
    /^\/rest\/v1\/documents$/,
    /^\/storage\/v1\/object\/documents(?:\/|$)/,
  ],
  owner: [/^\/rest\/v1\/rpc\/(?:transition_payment_request|approve_payment_request_with_credit_override)$/],
  payer: [/^\/rest\/v1\/rpc\/execute_payment_request$/],
  accountant: [
    /^\/rest\/v1\/rpc\/(?:import_bank_transactions|match_bank_transaction|mark_month_export_sent)$/,
  ],
};

interface MutationRequestContract {
  readonly method: 'POST' | 'DELETE';
  readonly pathname: RegExp;
}

interface MutationFactContract {
  readonly key: string;
  readonly expected?: string | number | boolean | null;
  readonly oneOf?: readonly (string | number | boolean | null)[];
  readonly positiveInteger?: boolean;
}

interface MutationStepContract {
  readonly role: QaRole;
  readonly allowedRequests: readonly MutationRequestContract[];
  readonly requiredRequests: readonly MutationRequestContract[];
  readonly responsePath: RegExp;
  readonly requiredEntityKinds: readonly string[];
  readonly allowedEntityKinds: readonly string[];
  readonly responseFacts: readonly MutationFactContract[];
}

const post = (pathname: RegExp): MutationRequestContract => ({ method: 'POST', pathname });
const remove = (pathname: RegExp): MutationRequestContract => ({ method: 'DELETE', pathname });

const DOCUMENT_STORAGE = /^\/storage\/v1\/object\/documents(?:\/|$)/;
const DOCUMENT_ROW = /^\/rest\/v1\/documents$/;
const DOCUMENT_ENQUEUE = /^\/rest\/v1\/rpc\/enqueue_document_processing$/;
const SUPPLIER_DOCUMENT_RESERVE = /^\/rest\/v1\/rpc\/reserve_supplier_price_document_upload$/;
const SUPPLIER_DOCUMENT_REGISTER = /^\/rest\/v1\/rpc\/register_supplier_price_document$/;

const STEP_MUTATION_CONTRACTS: Readonly<Record<string, MutationStepContract>> = {
  'submit-price-workbook': {
    role: 'supplier',
    allowedRequests: [
      post(/^\/storage\/v1\/object\/price-submissions(?:\/|$)/),
      post(/^\/functions\/v1\/submit-price-list$/),
    ],
    requiredRequests: [
      post(/^\/storage\/v1\/object\/price-submissions(?:\/|$)/),
      post(/^\/functions\/v1\/submit-price-list$/),
    ],
    responsePath: /^\/functions\/v1\/submit-price-list$/,
    requiredEntityKinds: ['supplier_price_submission'],
    allowedEntityKinds: ['supplier_price_submission'],
    responseFacts: [
      { key: 'status', expected: 'accepted' },
      { key: 'accepted_count', expected: 3 },
      { key: 'rejected_count', expected: 0 },
      { key: 'unchanged_count', expected: 0 },
      { key: 'idempotent', expected: false },
    ],
  },
  'replay-price-workbook': {
    role: 'supplier',
    allowedRequests: [
      post(/^\/storage\/v1\/object\/price-submissions(?:\/|$)/),
      post(/^\/functions\/v1\/submit-price-list$/),
      remove(/^\/storage\/v1\/object\/price-submissions(?:\/|$)/),
    ],
    requiredRequests: [
      post(/^\/storage\/v1\/object\/price-submissions(?:\/|$)/),
      post(/^\/functions\/v1\/submit-price-list$/),
      remove(/^\/storage\/v1\/object\/price-submissions(?:\/|$)/),
    ],
    responsePath: /^\/functions\/v1\/submit-price-list$/,
    requiredEntityKinds: ['supplier_price_submission'],
    allowedEntityKinds: ['supplier_price_submission'],
    responseFacts: [
      { key: 'status', expected: 'accepted' },
      { key: 'accepted_count', expected: 3 },
      { key: 'rejected_count', expected: 0 },
      { key: 'unchanged_count', expected: 0 },
      { key: 'idempotent', expected: true },
    ],
  },
  'record-partial-receipt': {
    role: 'kitchen',
    allowedRequests: [post(/^\/rest\/v1\/rpc\/save_goods_receipt$/)],
    requiredRequests: [post(/^\/rest\/v1\/rpc\/save_goods_receipt$/)],
    responsePath: /^\/rest\/v1\/rpc\/save_goods_receipt$/,
    requiredEntityKinds: ['goods_receipt'],
    allowedEntityKinds: ['goods_receipt'],
    responseFacts: [
      { key: 'status', expected: 'completed' },
      { key: 'order_status', expected: 'partial' },
      { key: 'credit_count', expected: 1 },
      { key: 'idempotent', expected: false },
    ],
  },
  'attach-receipt-document': {
    role: 'kitchen',
    allowedRequests: [post(DOCUMENT_STORAGE), post(DOCUMENT_ROW), post(DOCUMENT_ENQUEUE)],
    requiredRequests: [post(DOCUMENT_STORAGE), post(DOCUMENT_ROW), post(DOCUMENT_ENQUEUE)],
    responsePath: DOCUMENT_ROW,
    requiredEntityKinds: ['document'],
    allowedEntityKinds: ['document'],
    responseFacts: [],
  },
  'create-invoice': {
    role: 'office',
    allowedRequests: [post(/^\/rest\/v1\/rpc\/create_invoice$/)],
    requiredRequests: [post(/^\/rest\/v1\/rpc\/create_invoice$/)],
    responsePath: /^\/rest\/v1\/rpc\/create_invoice$/,
    requiredEntityKinds: ['invoice'],
    allowedEntityKinds: ['invoice'],
    responseFacts: [
      { key: 'review_status', expected: 'received' },
      { key: 'idempotent', expected: false },
    ],
  },
  'start-invoice-review': {
    role: 'office',
    allowedRequests: [post(/^\/rest\/v1\/rpc\/set_invoice_review_status$/)],
    requiredRequests: [post(/^\/rest\/v1\/rpc\/set_invoice_review_status$/)],
    responsePath: /^\/rest\/v1\/rpc\/set_invoice_review_status$/,
    requiredEntityKinds: ['invoice'],
    allowedEntityKinds: ['invoice'],
    responseFacts: [
      { key: 'review_status', expected: 'in_review' },
      { key: 'idempotent', expected: false },
    ],
  },
  'approve-invoice-for-payment': {
    role: 'office',
    allowedRequests: [post(/^\/rest\/v1\/rpc\/set_invoice_review_status$/)],
    requiredRequests: [post(/^\/rest\/v1\/rpc\/set_invoice_review_status$/)],
    responsePath: /^\/rest\/v1\/rpc\/set_invoice_review_status$/,
    requiredEntityKinds: ['invoice'],
    allowedEntityKinds: ['invoice'],
    responseFacts: [
      { key: 'review_status', expected: 'approved' },
      { key: 'idempotent', expected: false },
    ],
  },
  'request-payment': {
    role: 'office',
    allowedRequests: [post(/^\/rest\/v1\/rpc\/create_payment_request$/)],
    requiredRequests: [post(/^\/rest\/v1\/rpc\/create_payment_request$/)],
    responsePath: /^\/rest\/v1\/rpc\/create_payment_request$/,
    requiredEntityKinds: ['payment_request'],
    allowedEntityKinds: ['payment_request'],
    responseFacts: [
      { key: 'number', positiveInteger: true },
      { key: 'status', expected: 'pending_approval' },
      { key: 'idempotent', expected: false },
    ],
  },
  'approve-payment-request': {
    role: 'owner',
    allowedRequests: [post(/^\/rest\/v1\/rpc\/approve_payment_request_with_credit_override$/)],
    requiredRequests: [post(/^\/rest\/v1\/rpc\/approve_payment_request_with_credit_override$/)],
    responsePath: /^\/rest\/v1\/rpc\/approve_payment_request_with_credit_override$/,
    requiredEntityKinds: ['payment_request'],
    allowedEntityKinds: ['payment_request'],
    responseFacts: [
      { key: 'status', expected: 'approved' },
      { key: 'open_credit_override', expected: true },
      { key: 'idempotent', expected: false },
    ],
  },
  'execute-transfer': {
    role: 'payer',
    allowedRequests: [post(/^\/rest\/v1\/rpc\/execute_payment_request$/)],
    requiredRequests: [post(/^\/rest\/v1\/rpc\/execute_payment_request$/)],
    responsePath: /^\/rest\/v1\/rpc\/execute_payment_request$/,
    requiredEntityKinds: ['payment', 'payment_request', 'invoice'],
    allowedEntityKinds: ['payment', 'payment_request', 'invoice'],
    responseFacts: [
      { key: 'status', expected: 'executed' },
      { key: 'idempotent', expected: false },
    ],
  },
  'import-bank-csv': {
    role: 'accountant',
    allowedRequests: [post(/^\/rest\/v1\/rpc\/import_bank_transactions$/)],
    requiredRequests: [post(/^\/rest\/v1\/rpc\/import_bank_transactions$/)],
    responsePath: /^\/rest\/v1\/rpc\/import_bank_transactions$/,
    requiredEntityKinds: ['bank_import'],
    allowedEntityKinds: ['bank_import'],
    responseFacts: [
      { key: 'row_count', expected: 1 },
      { key: 'idempotent', expected: false },
    ],
  },
  'match-bank-payment': {
    role: 'accountant',
    allowedRequests: [post(/^\/rest\/v1\/rpc\/match_bank_transaction$/)],
    requiredRequests: [post(/^\/rest\/v1\/rpc\/match_bank_transaction$/)],
    responsePath: /^\/rest\/v1\/rpc\/match_bank_transaction$/,
    requiredEntityKinds: ['bank_transaction', 'payment', 'invoice'],
    allowedEntityKinds: ['bank_transaction', 'payment', 'invoice'],
    responseFacts: [
      { key: 'status', expected: 'matched' },
      { key: 'idempotent', expected: false },
    ],
  },
};

function documentMutationContract(role: QaRole): MutationStepContract | null {
  if (role !== 'supplier' && role !== 'office' && role !== 'kitchen') return null;
  const supplierRequests = [
    post(DOCUMENT_STORAGE), post(DOCUMENT_ROW), post(DOCUMENT_ENQUEUE),
    post(SUPPLIER_DOCUMENT_RESERVE), post(SUPPLIER_DOCUMENT_REGISTER),
  ];
  return {
    role,
    allowedRequests: role === 'supplier'
      ? supplierRequests
      : [post(DOCUMENT_STORAGE), post(DOCUMENT_ROW), post(DOCUMENT_ENQUEUE)],
    requiredRequests: role === 'supplier'
      ? [post(DOCUMENT_STORAGE), post(SUPPLIER_DOCUMENT_REGISTER), post(DOCUMENT_ENQUEUE)]
      : [post(DOCUMENT_STORAGE), post(DOCUMENT_ROW), post(DOCUMENT_ENQUEUE)],
    responsePath: role === 'supplier' ? SUPPLIER_DOCUMENT_REGISTER : DOCUMENT_ROW,
    requiredEntityKinds: ['document'],
    allowedEntityKinds: ['document'],
    responseFacts: [],
  };
}

function requestMatches(
  entry: Pick<BrowserMutationEvidence['network'][number], 'method' | 'pathname'>,
  contract: MutationRequestContract,
): boolean {
  return entry.method.toUpperCase() === contract.method && contract.pathname.test(entry.pathname);
}

export function evaluateAgentMutationStepEvidenceContract(input: {
  readonly role: QaRole;
  readonly mutationStepId: string | null;
  readonly mutationEntries: BrowserMutationEvidence['network'];
  readonly entityRefs: BrowserMutationEvidence['entityRefs'];
}) {
  const successfulMutationEntries = input.mutationEntries.filter(({ status, failure }) =>
    failure === null && status !== null && status >= 200 && status < 300);
  const observedEntityKinds = new Set(input.entityRefs.map(({ kind }) => kind));
  const documentOnly = observedEntityKinds.size === 1 && observedEntityKinds.has('document');
  const contract = input.mutationStepId
    ? STEP_MUTATION_CONTRACTS[input.mutationStepId] ?? null
    : documentOnly ? documentMutationContract(input.role) : null;
  const endpointsAllowed = contract !== null
    && contract.role === input.role
    && input.mutationEntries.every((entry) => contract.allowedRequests.some(
      (request) => requestMatches(entry, request),
    ));
  const requiredRequestsObserved = contract !== null
    && contract.requiredRequests.every((request) =>
      successfulMutationEntries.some((entry) => requestMatches(entry, request)));
  const requiredEntityKindsPresent = contract !== null
    && contract.requiredEntityKinds.every((kind) => observedEntityKinds.has(kind));
  const entityKindsAllowed = contract !== null
    && [...observedEntityKinds].every((kind) => contract.allowedEntityKinds.includes(kind));
  const responseEntry = contract
    ? successfulMutationEntries.find(({ pathname }) => contract.responsePath.test(pathname))
    : undefined;
  const responseFactMatches = contract?.responseFacts.map((requirement) => {
    const observed = responseEntry?.responseFacts[requirement.key];
    const matches = requirement.positiveInteger
      ? typeof observed === 'number' && Number.isInteger(observed) && observed > 0
      : requirement.oneOf
        ? requirement.oneOf.includes(observed ?? null)
        : observed === requirement.expected;
    return {
      key: requirement.key,
      matches,
      observed,
      expected: requirement.positiveInteger
        ? 'positive_integer'
        : requirement.oneOf ?? requirement.expected,
    };
  }) ?? [];
  return {
    contractAvailable: contract !== null,
    documentOnly,
    endpointsAllowed,
    requiredRequestsObserved,
    requiredEntityKindsPresent,
    entityKindsAllowed,
    responseFactsMatch: contract !== null
      && responseEntry !== undefined
      && responseFactMatches.every(({ matches }) => matches),
    responsePathPresent: responseEntry !== undefined,
    responseFactMatches,
    requiredEntityKinds: contract?.requiredEntityKinds ?? [],
    allowedEntityKinds: contract?.allowedEntityKinds ?? [],
    observedEntityKinds: [...observedEntityKinds],
  };
}

export function evaluateAgentMutationNetworkOutcome(
  mutationEntries: BrowserMutationEvidence['network'],
): {
  readonly status: VerificationCheck['status'];
  readonly mutationSucceeded: boolean;
  readonly networkFailed: boolean;
  readonly networkPending: boolean;
} {
  const mutationSucceeded = mutationEntries.some(({ status }) =>
    status !== null && status >= 200 && status < 300);
  const networkFailed = mutationEntries.some(({ status, failure }) =>
    failure !== null || (status !== null && (status < 200 || status >= 300)));
  const networkPending = mutationEntries.some(({ status, failure, completedAt }) =>
    status === null && failure === null && completedAt === null);
  return {
    status: networkFailed
      ? 'FAIL'
      : networkPending || !mutationSucceeded ? 'BLOCKED' : 'PASS',
    mutationSucceeded,
    networkFailed,
    networkPending,
  };
}

export function isAllowedAgentMutationEndpoint(
  role: QaRole,
  method: string,
  pathname: string,
  mutationStepId?: string,
): boolean {
  if (mutationStepId) {
    const contract = STEP_MUTATION_CONTRACTS[mutationStepId];
    return contract?.role === role
      && contract.allowedRequests.some((request) => requestMatches({ method, pathname }, request));
  }
  if (role === 'supplier' && method.toUpperCase() === 'DELETE') return false;
  return method.toUpperCase() === 'POST'
    && ALLOWED_MUTATION_PATHS[role].some((pattern) => pattern.test(pathname));
}

export type AgentRunStatus = 'PASSED' | 'FAILED' | 'BLOCKED' | 'SKIPPED_BY_CONFIGURATION';
export type AgentBlockerType = 'PRODUCT' | 'INFRASTRUCTURE' | 'CONFIGURATION' | null;

export interface AgentOrchestrationOutcome {
  readonly status: 'PASSED' | 'FAILED' | 'BLOCKED';
  readonly blockerType: Exclude<AgentBlockerType, 'CONFIGURATION'>;
  readonly reason: string;
}

export function classifyAgentOrchestrationOutcome(input: {
  readonly orchestratorStatus: QaAgentOrchestratorResult['status'];
  readonly unverifiedMeaningfulActions: number;
  readonly blockedRoleCount: number;
  readonly infrastructureFailedRoleCount: number;
  readonly productVerifierFailure: boolean;
}): AgentOrchestrationOutcome {
  if (input.unverifiedMeaningfulActions > 0) {
    return {
      status: 'BLOCKED',
      blockerType: 'INFRASTRUCTURE',
      reason: 'One or more meaningful business actions lacked independent verification.',
    };
  }
  if (input.blockedRoleCount > 0) {
    return {
      status: 'BLOCKED',
      blockerType: 'INFRASTRUCTURE',
      reason: 'One or more required role scenarios were blocked or not executed.',
    };
  }
  if (input.infrastructureFailedRoleCount > 0) {
    return {
      status: 'BLOCKED',
      blockerType: 'INFRASTRUCTURE',
      reason: 'One or more required role scenarios failed without verified product evidence.',
    };
  }
  if (input.productVerifierFailure) {
    return {
      status: 'FAILED',
      blockerType: 'PRODUCT',
      reason: 'One or more trusted verifier checks proved a product-state mismatch.',
    };
  }
  if (input.orchestratorStatus === 'completed') {
    return {
      status: 'PASSED',
      blockerType: null,
      reason: 'Agent orchestration completed with independently verified actions.',
    };
  }
  return {
    status: 'BLOCKED',
    blockerType: 'INFRASTRUCTURE',
    reason: `Agent orchestration ended as ${input.orchestratorStatus} without verified product-failure evidence.`,
  };
}

export function mergeAgentOrchestrationOutcomes(
  current: AgentOrchestrationOutcome | null,
  incoming: AgentOrchestrationOutcome,
): AgentOrchestrationOutcome {
  if (current === null) return incoming;
  if (incoming.blockerType === 'INFRASTRUCTURE') return incoming;
  if (current.blockerType === 'INFRASTRUCTURE') return current;
  if (incoming.blockerType === 'PRODUCT') return incoming;
  if (current.blockerType === 'PRODUCT') return current;
  return incoming;
}

export function agentRunExitCode(status: AgentRunStatus): number {
  return status === 'PASSED' || status === 'SKIPPED_BY_CONFIGURATION'
    ? 0
    : status === 'FAILED'
    ? 1
    : 2;
}

export interface AgentRunResult {
  schemaVersion: 1;
  runId: string;
  status: AgentRunStatus;
  blockerType: AgentBlockerType;
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
  protectedSearches: Map<string, string>;
}

class BrowserProductEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserProductEvidenceError';
  }
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

function blockedOrchestrator(
  runId: string,
  reason: string,
  blockerType: 'INFRASTRUCTURE' | 'CONFIGURATION' = 'INFRASTRUCTURE',
): QaAgentOrchestratorResult {
  const roleResults = DEFAULT_CROSS_ROLE_ORDER.map((role) => {
    const scenario = createAgentScenarioContext(getScenario(ROLE_SCENARIOS[role]), role);
    return blockedRoleRunResult({ runId, role, scenario, reason, blockerType });
  });
  return {
    runId,
    status: 'blocked',
    provider: 'blocked',
    model: null,
    roleResults,
    roleOrder: DEFAULT_CROSS_ROLE_ORDER,
    statistics: {
      assigned: DEFAULT_CROSS_ROLE_ORDER.length,
      completed: 0,
      blocked: DEFAULT_CROSS_ROLE_ORDER.length,
      failed: 0,
      stepLimit: 0,
      observations: 0,
      verifiedChecks: 0,
      unverifiedMeaningfulActions: 0,
    },
    diagnostics: [reason],
  };
}

export function verifierFailureIsProduct(result: VerifierResult): boolean {
  return result.status === 'failed'
    && result.facts.some(({ key, value }) => key === 'product_evidence' && value === true);
}

function hasProductVerifierFailure(orchestrator: QaAgentOrchestratorResult): boolean {
  return orchestrator.roleResults.some(({ verificationResults }) =>
    verificationResults.some(({ result }) => verifierFailureIsProduct(result)));
}

function fixtureMap(files: Readonly<Partial<Record<string, string>>>): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(files).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

async function browserMutationContractChecks(
  evidence: BrowserMutationEvidence,
  role: QaRole,
  scenarioId: ScenarioId,
  artifactRoot: string,
): Promise<VerificationCheck[]> {
  const scenario = createAgentScenarioContext(getScenario(scenarioId), role);
  const mutationEntries = evidence.network.filter(({ mutationCandidate }) => mutationCandidate);
  const responseRefs = new Set(mutationEntries.flatMap(({ entityRefs }) => entityRefs)
    .map(({ kind, visibleReference }) => `${kind}:${visibleReference.toLowerCase()}`));
  const evidenceRefsInsideRun = evidence.evidenceRefs.every((reference) => {
    const relative = path.relative(artifactRoot, path.resolve(reference));
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
  const evidenceFilesPresent = evidenceRefsInsideRun && (await Promise.all(
    evidence.evidenceRefs.map((reference) => access(reference).then(() => true, () => false)),
  )).every(Boolean);
  const timestampsOrdered = Date.parse(evidence.startedAt) <= Date.parse(evidence.completedAt)
    && evidence.network.every(({ startedAt, completedAt }) => completedAt === null
      || Date.parse(startedAt) <= Date.parse(completedAt));
  const networkOutcome = evaluateAgentMutationNetworkOutcome(mutationEntries);
  const mutationStepId = trustedMutationStepId(
    scenario,
    role,
    evidence.expectedMutation,
  );
  const stepContract = evaluateAgentMutationStepEvidenceContract({
    role,
    mutationStepId,
    mutationEntries,
    entityRefs: evidence.entityRefs,
  });
  const successfulMutationWithoutEntityRefs = networkOutcome.status === 'PASS'
    && evidence.entityRefs.length === 0;
  const refsFromResponses = evidence.entityRefs.length > 0
    && evidence.entityRefs.every(({ kind, visibleReference }) =>
      responseRefs.has(`${kind}:${visibleReference.toLowerCase()}`));
  const expectedMutationMatches = mutationStepId !== null;

  return [
    {
      id: 'agent-action-identity',
      status: evidence.role === role && evidence.scenarioId === scenarioId ? 'PASS' : 'FAIL',
      summary: 'Action evidence role and scenario are bound by the trusted harness.',
      evidence: { actionId: evidence.actionId, roleMatches: evidence.role === role, scenarioMatches: evidence.scenarioId === scenarioId },
    },
    {
      id: 'agent-action-route',
      status: [evidence.routeBefore, evidence.routeAfter].every((route) =>
        scenario.allowedRoutes.some((allowed) => matchesAllowedRoute(route, allowed))) ? 'PASS' : 'FAIL',
      summary: 'Pre/post routes remain inside the scenario allowlist.',
      evidence: { routeBefore: evidence.routeBefore, routeAfter: evidence.routeAfter },
    },
    {
      id: 'agent-action-artifacts',
      status: evidenceFilesPresent && evidence.preScreenshot !== evidence.postScreenshot ? 'PASS' : 'BLOCKED',
      summary: 'Distinct pre/post screenshots and the action artifact must exist inside the run root.',
      evidence: { evidenceRefsInsideRun, evidenceFilesPresent, distinctScreenshots: evidence.preScreenshot !== evidence.postScreenshot },
    },
    {
      id: 'agent-action-network',
      status: evidence.hasMutationRequest ? networkOutcome.status : 'BLOCKED',
      summary: 'At least one successful mutation response must be captured with no failed or pending mutation requests.',
      evidence: {
        mutationEntryCount: mutationEntries.length,
        mutationSucceeded: networkOutcome.mutationSucceeded,
        networkFailed: networkOutcome.networkFailed,
        networkPending: networkOutcome.networkPending,
        declaredMutation: evidence.hasMutationRequest,
      },
    },
    {
      id: 'agent-action-endpoints',
      status: mutationEntries.length === 0
        || successfulMutationWithoutEntityRefs
        || !stepContract.contractAvailable
        ? 'BLOCKED'
        : stepContract.endpointsAllowed && stepContract.requiredRequestsObserved ? 'PASS' : 'FAIL',
      summary: 'Every observed mutation endpoint and every required request must match the exact assigned scenario step.',
      evidence: {
        endpointsAllowed: stepContract.endpointsAllowed,
        requiredRequestsObserved: stepContract.requiredRequestsObserved,
        mutationStepId,
        documentRegistration: stepContract.documentOnly,
        successfulMutationWithoutEntityRefs,
        endpoints: mutationEntries.map(({ method, pathname }) => ({ method, pathname })),
      },
    },
    {
      id: 'agent-action-entity-contract',
      status: networkOutcome.status !== 'PASS'
        || successfulMutationWithoutEntityRefs
        || !stepContract.contractAvailable
        ? 'BLOCKED'
        : stepContract.observedEntityKinds.length === 0
          ? 'BLOCKED'
        : stepContract.requiredEntityKindsPresent && stepContract.entityKindsAllowed ? 'PASS' : 'FAIL',
      summary: 'Response-derived entity kinds must match the exact assigned scenario step.',
      evidence: {
        requiredEntityKinds: stepContract.requiredEntityKinds,
        allowedEntityKinds: stepContract.allowedEntityKinds,
        observedEntityKinds: stepContract.observedEntityKinds,
        requiredEntityKindsPresent: stepContract.requiredEntityKindsPresent,
        entityKindsAllowed: stepContract.entityKindsAllowed,
      },
    },
    {
      id: 'agent-action-response-facts',
      status: networkOutcome.status !== 'PASS'
        || successfulMutationWithoutEntityRefs
        || !stepContract.contractAvailable
        ? 'BLOCKED'
        : stepContract.responseFactsMatch ? 'PASS' : 'FAIL',
      summary: 'Allowlisted response facts must match the exact assigned scenario step.',
      evidence: {
        responsePathPresent: stepContract.responsePathPresent,
        factMatches: stepContract.responseFactMatches,
      },
    },
    {
      id: 'agent-action-entity-source',
      status: refsFromResponses && evidence.entityRefsSource === 'response-body' ? 'PASS' : 'BLOCKED',
      summary: 'Entity UUIDs must come from successful response bodies, never from model output or request payloads.',
      evidence: { entityCount: evidence.entityRefs.length, refsFromResponses, source: evidence.entityRefsSource },
    },
    {
      id: 'agent-action-notification',
      status: evidence.notification.kind === 'error'
        ? 'FAIL'
        : evidence.notification.kind === 'success' ? 'PASS' : 'BLOCKED',
      summary: 'The UI must expose a visible success or error notification after the action.',
      evidence: { notificationKind: evidence.notification.kind, notificationPresent: evidence.notification.text !== null },
    },
    {
      id: 'agent-action-expected-mutation',
      status: expectedMutationMatches ? 'PASS' : 'FAIL',
      summary: 'Expected mutation text identifies exactly one mutating scenario step from the registry.',
      evidence: { expectedMutationMatches },
    },
    {
      id: 'agent-action-timing',
      status: timestampsOrdered ? 'PASS' : 'FAIL',
      summary: 'Action and request timestamps are ordered.',
      evidence: { timestampsOrdered },
    },
    {
      id: 'agent-action-browser-outcome',
      status: evidence.actionError === null ? 'PASS' : 'BLOCKED',
      summary: 'The browser action itself must return without an unknown client-side outcome.',
      evidence: { actionErrorPresent: evidence.actionError !== null },
    },
  ];
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

export interface TrustedMeaningfulExpectations {
  readonly database: readonly DatabaseRowExpectation[];
  readonly integrity: DataIntegrityInput;
  readonly audit: readonly AuditExpectation[];
  readonly auditWindow?: readonly AuditExpectation[];
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

export function trustedCrossRoleHandoffCheck(
  role: QaRole,
  mutationStepId: string,
  entityRefs: readonly { kind: string; visibleReference: string }[],
  trustedEntityRefs: ReadonlyMap<string, string>,
): VerificationCheck | null {
  const requirements: readonly (readonly [kind: string, trustedKey: string])[] =
    role === 'owner' && mutationStepId === 'approve-payment-request'
      ? [['payment_request', 'office:payment_request']]
      : role === 'payer' && mutationStepId === 'execute-transfer'
        ? [['payment_request', 'owner:payment_request'], ['invoice', 'office:invoice']]
        : role === 'accountant' && mutationStepId === 'match-bank-payment'
          ? [
              ['bank_transaction', 'accountant:bank_transaction'],
              ['payment', 'payer:payment'],
              ['invoice', 'office:invoice'],
            ]
          : [];
  if (!requirements.length) return null;

  const observed = trustedReferences(entityRefs);
  const comparisons = requirements.map(([kind, trustedKey]) => {
    const expected = trustedEntityRefs.get(trustedKey);
    const actual = observed?.get(kind);
    return {
      kind,
      trustedKey,
      expectedPresent: !!expected,
      observedPresent: !!actual,
      matches: !!expected && actual === expected,
    };
  });
  const passed = comparisons.every(({ matches }) => matches);
  return {
    id: 'agent-cross-role-handoff',
    status: passed ? 'PASS' : 'BLOCKED',
    summary: passed
      ? 'Response-derived entity references match the verified upstream role handoff.'
      : 'The action did not target the exact entities verified by upstream roles.',
    evidence: { comparisons },
  };
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

function documentProcessingAudit(
  role: 'supplier' | 'office' | 'kitchen',
  actorUserId: string,
  createdAfter: string,
): AuditExpectation {
  return {
    id: `agent-${role}-document-processing-audit`,
    orgId: QA_ORGANIZATION_ID,
    action: 'document_processing_enqueued',
    entityType: 'document_processing_jobs',
    actorUserId,
    createdAfter,
    reasonRequired: true,
    exactCount: 1,
  };
}

function exactAuditWindowEvent(input: {
  readonly id: string;
  readonly action: string;
  readonly entityType: string;
  readonly actorUserId: string;
  readonly createdAfter: string;
  readonly entityId?: string;
  readonly exactCount?: number;
}): AuditExpectation {
  return {
    id: input.id,
    orgId: QA_ORGANIZATION_ID,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    actorUserId: input.actorUserId,
    createdAfter: input.createdAfter,
    exactCount: input.exactCount ?? 1,
  };
}

function documentAuditWindow(
  role: 'supplier' | 'office' | 'kitchen',
  documentId: string,
  actorUserId: string,
  createdAfter: string,
): readonly AuditExpectation[] {
  return [
    exactAuditWindowEvent({
      id: `agent-${role}-document-insert-window`,
      action: 'insert',
      entityType: 'documents',
      entityId: documentId,
      actorUserId,
      createdAfter,
    }),
    documentProcessingAudit(role, actorUserId, createdAfter),
  ];
}

function mutationAuditWindow(
  role: QaRole,
  mutationStepId: string | undefined,
  refs: ReadonlyMap<string, string>,
  actorUserId: string,
  createdAfter: string,
): readonly AuditExpectation[] | null {
  const event = (
    id: string,
    action: string,
    entityType: string,
    entityId?: string,
    exactCount = 1,
  ) => exactAuditWindowEvent({
    id,
    action,
    entityType,
    entityId,
    exactCount,
    actorUserId,
    createdAfter,
  });
  if (role === 'supplier' && mutationStepId === 'replay-price-workbook') return [];
  if (role === 'supplier' && mutationStepId === 'submit-price-workbook') {
    return [
      event('agent-submit-supplier-products-update-window', 'update', 'supplier_products', undefined, 3),
      event('agent-submit-price-history-insert-window', 'insert', 'price_history', undefined, 3),
      event('agent-submit-import-window', 'supplier_prices_imported', 'supplier_products'),
      event('agent-submit-submission-window', 'supplier_price_submission_processed', 'supplier_price_submissions', refs.get('supplier_price_submission')),
    ];
  }
  if (role === 'kitchen' && mutationStepId === 'record-partial-receipt') {
    const receiptId = refs.get('goods_receipt');
    if (!receiptId) return null;
    return [
      event('agent-receipt-insert-window', 'insert', 'goods_receipts', receiptId),
      event('agent-receipt-items-insert-window', 'insert', 'goods_receipt_items', undefined, 2),
      event('agent-order-items-update-window', 'update', 'purchase_order_items', undefined, 2),
      event('agent-order-update-window', 'update', 'purchase_orders'),
      event('agent-credit-insert-window', 'insert', 'credit_requests'),
      event('agent-receipt-update-window', 'update', 'goods_receipts', receiptId),
      event('agent-inventory-movement-window', 'inventory_movement_recorded', 'inventory_movements', undefined, 2),
      event('agent-receipt-completed-window', 'goods_receipt_completed', 'goods_receipts', receiptId),
    ];
  }
  if (role === 'office' && mutationStepId === 'create-invoice') {
    const invoiceId = refs.get('invoice');
    if (!invoiceId) return null;
    return [
      event('agent-invoice-insert-window', 'insert', 'invoices', invoiceId),
      event('agent-invoice-order-link-window', 'insert', 'invoice_order_links'),
      event('agent-invoice-receipt-link-window', 'insert', 'invoice_receipt_links'),
      event('agent-invoice-created-window', 'invoice_created', 'invoices', invoiceId),
    ];
  }
  if (role === 'office'
      && (mutationStepId === 'start-invoice-review'
        || mutationStepId === 'approve-invoice-for-payment')) {
    const invoiceId = refs.get('invoice');
    if (!invoiceId) return null;
    return [
      event(`agent-${mutationStepId}-update-window`, 'update', 'invoices', invoiceId),
      event(`agent-${mutationStepId}-audit-window`, 'invoice_review_status_changed', 'invoices', invoiceId),
    ];
  }
  if (role === 'office' && mutationStepId === 'request-payment') {
    const requestId = refs.get('payment_request');
    if (!requestId) return null;
    return [
      event('agent-payment-request-insert-window', 'insert', 'payment_requests', requestId),
      event('agent-payment-request-invoice-window', 'insert', 'payment_request_invoices'),
      event('agent-payment-request-created-window', 'payment_request_created', 'payment_requests', requestId),
    ];
  }
  if (role === 'owner' && mutationStepId === 'approve-payment-request') {
    const requestId = refs.get('payment_request');
    if (!requestId) return null;
    return [
      event('agent-owner-request-update-window', 'update', 'payment_requests', requestId),
      event('agent-owner-request-transition-window', 'payment_request_transitioned', 'payment_requests', requestId),
    ];
  }
  if (role === 'payer' && mutationStepId === 'execute-transfer') {
    const paymentId = refs.get('payment');
    const requestId = refs.get('payment_request');
    const invoiceId = refs.get('invoice');
    if (!paymentId || !requestId || !invoiceId) return null;
    return [
      event('agent-payment-insert-window', 'insert', 'payments', paymentId),
      event('agent-payment-allocation-window', 'insert', 'payment_allocations'),
      event('agent-payment-invoice-update-window', 'update', 'invoices', invoiceId),
      event('agent-payment-request-update-window', 'update', 'payment_requests', requestId),
      event('agent-payment-executed-window', 'payment_request_executed', 'payment_requests', requestId),
    ];
  }
  if (role === 'accountant' && mutationStepId === 'import-bank-csv') {
    const importId = refs.get('bank_import');
    if (!importId) return null;
    return [
      event('agent-bank-import-insert-window', 'insert', 'bank_imports', importId),
      event('agent-bank-transaction-insert-window', 'insert', 'bank_transactions'),
      event('agent-bank-import-created-window', 'bank_import_created', 'bank_imports', importId),
    ];
  }
  if (role === 'accountant' && mutationStepId === 'match-bank-payment') {
    const transactionId = refs.get('bank_transaction');
    const invoiceId = refs.get('invoice');
    if (!transactionId || !invoiceId) return null;
    return [
      event('agent-bank-allocation-insert-window', 'insert', 'bank_allocations'),
      event('agent-matched-request-update-window', 'update', 'payment_requests'),
      event('agent-bank-transaction-update-window', 'update', 'bank_transactions', transactionId),
      event('agent-matched-invoice-update-window', 'update', 'invoices', invoiceId),
      event('agent-bank-match-confirmed-window', 'bank_match_confirmed', 'bank_transactions', transactionId),
    ];
  }
  return null;
}

export function trustedMeaningfulExpectations(
  role: QaRole,
  entityRefs: readonly { kind: string; visibleReference: string }[],
  actorUserId: string,
  createdAfter: string,
  mutationStepId?: string,
  trustedEntityRefs?: ReadonlyMap<string, string>,
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

  if (refs.has('document') && refs.size === 1) {
    if (role !== 'supplier' && role !== 'office' && role !== 'kitchen') return null;
    const documentId = refs.get('document')!;
    const linkedDocumentFields: Record<string, string | number | boolean | null> = role === 'supplier'
      ? {
          entity_type: 'supplier',
          entity_id: QA_SUPPLIER_PROFILE_ID,
          supplier_id: QA_SUPPLIER_PROFILE_ID,
        }
      : role === 'kitchen' ? { entity_type: 'goods_receipt' } : {};
    return {
      database: [row('agent-document-row', 'documents', 'id,org_id,entity_type,entity_id,supplier_id,uploaded_by,storage_path,deleted_at', [
        { column: 'id', operator: 'eq', value: documentId },
        { column: 'org_id', operator: 'eq', value: QA_ORGANIZATION_ID },
        { column: 'uploaded_by', operator: 'eq', value: actorUserId },
        { column: 'deleted_at', operator: 'is', value: null },
        ...(role === 'supplier' ? [
          { column: 'entity_type', operator: 'eq' as const, value: 'supplier' },
          { column: 'entity_id', operator: 'eq' as const, value: QA_SUPPLIER_PROFILE_ID },
          { column: 'supplier_id', operator: 'eq' as const, value: QA_SUPPLIER_PROFILE_ID },
        ] : []),
      ], [{
        id: documentId,
        org_id: QA_ORGANIZATION_ID,
        uploaded_by: actorUserId,
        deleted_at: null,
        ...linkedDocumentFields,
      }])],
      integrity: {
        entities: Object.keys(linkedDocumentFields).length ? [{
          id: `agent-${role}-document-owner-integrity`,
          table: 'documents',
          rowId: documentId,
          orgId: QA_ORGANIZATION_ID,
          expectedFields: {
            ...linkedDocumentFields,
            uploaded_by: actorUserId,
            deleted_at: null,
          },
        }] : [],
        documents: [{ id: `agent-${role}-document-integrity`, documentId, orgId: QA_ORGANIZATION_ID, expectedDeleted: false }],
      },
      audit: [documentProcessingAudit(role, actorUserId, createdAfter)],
      auditWindow: documentAuditWindow(role, documentId, actorUserId, createdAfter),
    };
  }

  if (role === 'supplier') {
    const submissionId = refs.get('supplier_price_submission');
    if (!submissionId) return null;
    const audit = trustedAudit(role, 'supplier_price_submission', submissionId, actorUserId, createdAfter);
    const auditWindow = mutationAuditWindow(role, mutationStepId, refs, actorUserId, createdAfter);
    if (!audit || auditWindow === null) return null;
    return {
      database: [row(
        'agent-supplier-submission-row',
        'supplier_price_submissions',
        'id,org_id,supplier_id,submitted_by,status,row_count,accepted_count,rejected_count,unchanged_count',
        [
          { column: 'id', operator: 'eq', value: submissionId },
          { column: 'org_id', operator: 'eq', value: QA_ORGANIZATION_ID },
          { column: 'submitted_by', operator: 'eq', value: actorUserId },
          { column: 'status', operator: 'in', value: ['accepted', 'accepted_with_rejections', 'rejected'] },
        ],
        [{
          id: submissionId,
          org_id: QA_ORGANIZATION_ID,
          supplier_id: QA_SUPPLIER_PROFILE_ID,
          submitted_by: actorUserId,
          status: 'accepted',
          row_count: 3,
        }],
      )],
      integrity: {
        entities: [entity('supplier_price_submission', {
          supplier_id: QA_SUPPLIER_PROFILE_ID,
          submitted_by: actorUserId,
          status: 'accepted',
          row_count: 3,
        })],
      },
      audit: [audit],
      auditWindow,
    };
  }

  if (role === 'kitchen') {
    const receiptId = refs.get('goods_receipt');
    const documentId = refs.get('document');
    if (!receiptId) return null;
    const audit = trustedAudit(role, 'goods_receipt', receiptId, actorUserId, createdAfter);
    const auditWindow = mutationAuditWindow(role, mutationStepId, refs, actorUserId, createdAfter);
    if (!audit || auditWindow === null) return null;
    return {
      database: [
        row('agent-kitchen-receipt-row', 'goods_receipts', 'id,org_id,order_id,status,received_by', [
          { column: 'id', operator: 'eq', value: receiptId },
          { column: 'org_id', operator: 'eq', value: QA_ORGANIZATION_ID },
        ], [{ id: receiptId, org_id: QA_ORGANIZATION_ID, status: 'completed', received_by: actorUserId }]),
        row('agent-kitchen-receipt-order-required', 'goods_receipts', 'id,order_id', [
          { column: 'id', operator: 'eq', value: receiptId },
          { column: 'order_id', operator: 'is', value: null },
        ], [], 0),
        { id: 'agent-kitchen-receipt-lines', table: 'goods_receipt_items', select: 'id,receipt_id,order_item_id,qty_received,status', filters: [{ column: 'receipt_id', operator: 'eq', value: receiptId }], minCount: 1 },
      ],
      integrity: { entities: [entity('goods_receipt', { status: 'completed', received_by: actorUserId })] },
      audit: [
        audit,
        ...(documentId ? [documentProcessingAudit('kitchen', actorUserId, createdAfter)] : []),
      ],
      auditWindow,
    };
  }

  if (role === 'office' && refs.has('invoice')
      && (mutationStepId === 'start-invoice-review'
        || mutationStepId === 'approve-invoice-for-payment')) {
    const invoiceId = refs.get('invoice')!;
    const expectedStatus = mutationStepId === 'start-invoice-review' ? 'in_review' : 'approved';
    const audit: AuditExpectation = {
      id: `agent-office-${mutationStepId}-audit`,
      orgId: QA_ORGANIZATION_ID,
      action: 'invoice_review_status_changed',
      entityType: 'invoices',
      entityId: invoiceId,
      actorUserId,
      createdAfter,
      reasonRequired: true,
      exactCount: 1,
    };
    const auditWindow = mutationAuditWindow(role, mutationStepId, refs, actorUserId, createdAfter);
    if (auditWindow === null) return null;
    return {
      database: [row('agent-office-invoice-review-row', 'invoices', 'id,org_id,supplier_id,review_status,deleted_at', [
        { column: 'id', operator: 'eq', value: invoiceId },
        { column: 'org_id', operator: 'eq', value: QA_ORGANIZATION_ID },
        { column: 'deleted_at', operator: 'is', value: null },
      ], [{ id: invoiceId, org_id: QA_ORGANIZATION_ID, review_status: expectedStatus, deleted_at: null }])],
      integrity: {
        entities: [entity('invoice', { review_status: expectedStatus, deleted_at: null })],
      },
      audit: [audit],
      auditWindow,
    };
  }

  if (role === 'office' && refs.has('payment_request')) {
    const requestId = refs.get('payment_request')!;
    const invoiceId = trustedEntityRefs?.get('office:invoice');
    if (!invoiceId) return null;
    const audit = trustedAudit(role, 'payment_request', requestId, actorUserId, createdAfter);
    const auditWindow = mutationAuditWindow(role, mutationStepId, refs, actorUserId, createdAfter);
    if (!audit || auditWindow === null) return null;
    return {
      database: [
        row('agent-office-request-row', 'payment_requests', 'id,org_id,supplier_id,status,created_by', [
          { column: 'id', operator: 'eq', value: requestId },
          { column: 'org_id', operator: 'eq', value: QA_ORGANIZATION_ID },
        ], [{ id: requestId, org_id: QA_ORGANIZATION_ID, status: 'pending_approval', created_by: actorUserId }]),
        row('agent-office-request-supplier-required', 'payment_requests', 'id,supplier_id', [
          { column: 'id', operator: 'eq', value: requestId },
          { column: 'supplier_id', operator: 'is', value: null },
        ], [], 0),
        row('agent-office-request-invoice', 'payment_request_invoices', 'org_id,payment_request_id,invoice_id,amount_allocated', [
          { column: 'payment_request_id', operator: 'eq', value: requestId },
          { column: 'org_id', operator: 'eq', value: QA_ORGANIZATION_ID },
        ], [{ org_id: QA_ORGANIZATION_ID, payment_request_id: requestId, invoice_id: invoiceId }]),
      ],
      integrity: {
        entities: [entity('payment_request', { status: 'pending_approval', created_by: actorUserId })],
      },
      audit: [audit],
      auditWindow,
    };
  }

  if (role === 'office' && mutationStepId === 'create-invoice') {
    const invoiceId = refs.get('invoice');
    const documentId = refs.get('document');
    if (!invoiceId) return null;
    const audit = trustedAudit(role, 'invoice', invoiceId, actorUserId, createdAfter);
    const auditWindow = mutationAuditWindow(role, mutationStepId, refs, actorUserId, createdAfter);
    if (!audit || auditWindow === null) return null;
    return {
      database: [
        row('agent-office-invoice-row', 'invoices', 'id,org_id,supplier_id,received_by,payment_status,deleted_at', [
          { column: 'id', operator: 'eq', value: invoiceId },
          { column: 'org_id', operator: 'eq', value: QA_ORGANIZATION_ID },
          { column: 'deleted_at', operator: 'is', value: null },
        ], [{ id: invoiceId, org_id: QA_ORGANIZATION_ID, received_by: actorUserId, payment_status: 'unpaid', deleted_at: null }]),
        row('agent-office-invoice-supplier-required', 'invoices', 'id,supplier_id', [
          { column: 'id', operator: 'eq', value: invoiceId },
          { column: 'supplier_id', operator: 'is', value: null },
        ], [], 0),
        row('agent-office-invoice-order-link', 'invoice_order_links', 'org_id,invoice_id,order_id', [
          { column: 'invoice_id', operator: 'eq', value: invoiceId },
          { column: 'org_id', operator: 'eq', value: QA_ORGANIZATION_ID },
        ], [{ org_id: QA_ORGANIZATION_ID, invoice_id: invoiceId }]),
        row('agent-office-invoice-receipt-link', 'invoice_receipt_links', 'org_id,invoice_id,receipt_id', [
          { column: 'invoice_id', operator: 'eq', value: invoiceId },
          { column: 'org_id', operator: 'eq', value: QA_ORGANIZATION_ID },
        ], [{ org_id: QA_ORGANIZATION_ID, invoice_id: invoiceId }]),
        ...(documentId ? [row('agent-office-invoice-document-row', 'documents', 'id,org_id,entity_type,entity_id,uploaded_by,deleted_at', [
          { column: 'id', operator: 'eq', value: documentId },
          { column: 'org_id', operator: 'eq', value: QA_ORGANIZATION_ID },
          { column: 'deleted_at', operator: 'is', value: null },
        ], [{ id: documentId, org_id: QA_ORGANIZATION_ID, entity_type: 'invoice', entity_id: invoiceId, uploaded_by: actorUserId, deleted_at: null }])] : []),
      ],
      integrity: {
        entities: [entity('invoice', { received_by: actorUserId, payment_status: 'unpaid', deleted_at: null })],
        documents: documentId
          ? [{ id: 'agent-office-invoice-document', documentId, orgId: QA_ORGANIZATION_ID, expectedDeleted: false }]
          : [],
        invoices: [{ id: 'agent-office-invoice-balance', invoiceId, orgId: QA_ORGANIZATION_ID, expectedPaymentStatus: 'unpaid' }],
      },
      audit: [
        audit,
        ...(documentId ? [documentProcessingAudit('office', actorUserId, createdAfter)] : []),
      ],
      auditWindow,
    };
  }

  if (role === 'owner') {
    const requestId = refs.get('payment_request');
    if (!requestId) return null;
    const audit = trustedAudit(role, 'payment_request', requestId, actorUserId, createdAfter);
    const auditWindow = mutationAuditWindow(role, mutationStepId, refs, actorUserId, createdAfter);
    if (!audit || auditWindow === null) return null;
    return {
      database: [row('agent-owner-request-row', 'payment_requests', 'id,org_id,status,approved_by,approved_at', [
        { column: 'id', operator: 'eq', value: requestId },
        { column: 'org_id', operator: 'eq', value: QA_ORGANIZATION_ID },
      ], [{ id: requestId, org_id: QA_ORGANIZATION_ID, status: 'approved', approved_by: actorUserId }])],
      integrity: { entities: [entity('payment_request', { status: 'approved', approved_by: actorUserId })] },
      audit: [audit],
      auditWindow,
    };
  }

  if (role === 'payer') {
    const requestId = refs.get('payment_request');
    const paymentId = refs.get('payment');
    const invoiceId = refs.get('invoice');
    if (!requestId || !paymentId || !invoiceId) return null;
    const audit = trustedAudit(role, 'payment_request', requestId, actorUserId, createdAfter);
    const auditWindow = mutationAuditWindow(role, mutationStepId, refs, actorUserId, createdAfter);
    if (!audit || auditWindow === null) return null;
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
      auditWindow,
    };
  }

  if (role === 'accountant' && refs.has('bank_transaction')) {
    const transactionId = refs.get('bank_transaction')!;
    const paymentId = refs.get('payment');
    const invoiceId = refs.get('invoice');
    if (!paymentId || !invoiceId) return null;
    const audit = trustedAudit(role, 'bank_transaction', transactionId, actorUserId, createdAfter);
    const auditWindow = mutationAuditWindow(role, mutationStepId, refs, actorUserId, createdAfter);
    if (!audit || auditWindow === null) return null;
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
      auditWindow,
    };
  }

  if (role === 'accountant') {
    const importId = refs.get('bank_import');
    if (!importId) return null;
    const audit = trustedAudit(role, 'bank_import', importId, actorUserId, createdAfter);
    const auditWindow = mutationAuditWindow(role, mutationStepId, refs, actorUserId, createdAfter);
    if (!audit || auditWindow === null) return null;
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
      auditWindow,
    };
  }

  return null;
}

async function verifyActionSupplierRelationship(
  runtime: LocalVerificationRuntime,
  role: QaRole,
  entityRefs: readonly { kind: string; visibleReference: string }[],
): Promise<VerificationCheck> {
  const refs = trustedReferences(entityRefs);
  if (!refs) {
    return { id: 'agent-action-supplier-relationship', status: 'BLOCKED', summary: 'Trusted entity references are unavailable.' };
  }
  const client = runtime.createServiceClient();
  const read = async (table: string, id: string, columns: string) => {
    const response = await client.from(table).select(columns).eq('id', id).maybeSingle();
    return {
      row: response.data as Record<string, unknown> | null,
      blocked: Boolean(response.error),
    };
  };
  const sameTenantSupplier = (rows: readonly (Record<string, unknown> | null)[]): boolean => {
    const present = rows.filter((row): row is Record<string, unknown> => row !== null);
    const suppliers = new Set(present.map((row) => row.supplier_id));
    return present.length === rows.length
      && present.every((row) => row.org_id === QA_ORGANIZATION_ID && typeof row.supplier_id === 'string')
      && suppliers.size === 1;
  };

  if (refs.has('document') && refs.size === 1) {
    const document = await read(
      'documents',
      refs.get('document')!,
      'id,org_id,supplier_id,uploaded_by,deleted_at',
    );
    const tenantMatches = document.row?.org_id === QA_ORGANIZATION_ID;
    const active = document.row?.deleted_at === null;
    const supplierMatches = role !== 'supplier'
      || document.row?.supplier_id === QA_SUPPLIER_PROFILE_ID;
    const passed = !document.blocked && tenantMatches && active && supplierMatches;
    return {
      id: 'agent-action-supplier-relationship',
      status: document.blocked ? 'BLOCKED' : passed ? 'PASS' : 'FAIL',
      summary: role === 'supplier'
        ? 'The uploaded document must belong to the authenticated canonical supplier and organization.'
        : 'The uploaded document must remain active and scoped to the authenticated organization.',
      evidence: {
        documentFound: document.row !== null,
        tenantMatches,
        active,
        supplierMatches,
      },
    };
  }

  if (role === 'supplier') {
    const id = refs.get('supplier_price_submission');
    if (!id) return { id: 'agent-action-supplier-relationship', status: 'BLOCKED', summary: 'Supplier submission id is missing.' };
    const result = await read('supplier_price_submissions', id, 'id,org_id,supplier_id');
    const passed = !result.blocked && result.row?.org_id === QA_ORGANIZATION_ID
      && result.row.supplier_id === QA_SUPPLIER_PROFILE_ID;
    return {
      id: 'agent-action-supplier-relationship',
      status: result.blocked ? 'BLOCKED' : passed ? 'PASS' : 'FAIL',
      summary: 'The supplier submission must belong to the authenticated canonical supplier and organization.',
      evidence: { rowFound: result.row !== null, tenantMatches: result.row?.org_id === QA_ORGANIZATION_ID, supplierMatches: result.row?.supplier_id === QA_SUPPLIER_PROFILE_ID },
    };
  }

  if (role === 'kitchen') {
    const id = refs.get('goods_receipt');
    if (!id) return { id: 'agent-action-supplier-relationship', status: 'BLOCKED', summary: 'Goods receipt id is missing.' };
    const receipt = await read('goods_receipts', id, 'id,org_id,order_id');
    if (receipt.blocked || !receipt.row || typeof receipt.row.order_id !== 'string') {
      return { id: 'agent-action-supplier-relationship', status: 'BLOCKED', summary: 'Receipt-to-order supplier evidence is unavailable.' };
    }
    const order = await read('purchase_orders', receipt.row.order_id, 'id,org_id,supplier_id');
    const passed = !order.blocked && receipt.row.org_id === QA_ORGANIZATION_ID
      && order.row?.org_id === QA_ORGANIZATION_ID && typeof order.row.supplier_id === 'string';
    return { id: 'agent-action-supplier-relationship', status: order.blocked ? 'BLOCKED' : passed ? 'PASS' : 'FAIL', summary: 'The receipt must resolve to one same-tenant order supplier.', evidence: { receiptFound: true, orderFound: order.row !== null, tenantMatches: passed } };
  }

  if (role === 'office') {
    const invoiceId = refs.get('invoice');
    if (invoiceId) {
      const invoice = await read('invoices', invoiceId, 'id,org_id,supplier_id');
      const passed = !invoice.blocked && sameTenantSupplier([invoice.row]);
      return { id: 'agent-action-supplier-relationship', status: invoice.blocked ? 'BLOCKED' : passed ? 'PASS' : 'FAIL', summary: 'The invoice must retain one same-tenant supplier.', evidence: { invoiceFound: invoice.row !== null, supplierPresent: typeof invoice.row?.supplier_id === 'string' } };
    }
    const requestId = refs.get('payment_request');
    if (requestId) {
      const request = await read('payment_requests', requestId, 'id,org_id,supplier_id');
      const links = await client.from('payment_request_invoices').select('org_id,invoice_id').eq('payment_request_id', requestId);
      if (request.blocked || links.error || !request.row || !links.data?.length) {
        return { id: 'agent-action-supplier-relationship', status: 'BLOCKED', summary: 'Payment-request supplier linkage evidence is unavailable.' };
      }
      const invoices = await Promise.all(links.data.map((link) => read('invoices', String(link.invoice_id), 'id,org_id,supplier_id')));
      const blocked = invoices.some((item) => item.blocked);
      const rows = [request.row, ...invoices.map(({ row }) => row)];
      const passed = !blocked && links.data.every((link) => link.org_id === QA_ORGANIZATION_ID) && sameTenantSupplier(rows);
      return { id: 'agent-action-supplier-relationship', status: blocked ? 'BLOCKED' : passed ? 'PASS' : 'FAIL', summary: 'The request and every linked invoice must share one same-tenant supplier.', evidence: { linkedInvoiceCount: links.data.length, supplierMatches: passed } };
    }
  }

  if (role === 'owner') {
    const id = refs.get('payment_request');
    if (id) {
      const request = await read('payment_requests', id, 'id,org_id,supplier_id');
      const passed = !request.blocked && sameTenantSupplier([request.row]);
      return { id: 'agent-action-supplier-relationship', status: request.blocked ? 'BLOCKED' : passed ? 'PASS' : 'FAIL', summary: 'The approved request must retain one same-tenant supplier.', evidence: { requestFound: request.row !== null, supplierPresent: typeof request.row?.supplier_id === 'string' } };
    }
  }

  if (role === 'payer') {
    const paymentId = refs.get('payment');
    const requestId = refs.get('payment_request');
    if (paymentId && requestId) {
      const [payment, request] = await Promise.all([
        read('payments', paymentId, 'id,org_id,supplier_id'),
        read('payment_requests', requestId, 'id,org_id,supplier_id'),
      ]);
      const blocked = payment.blocked || request.blocked;
      const passed = !blocked && sameTenantSupplier([payment.row, request.row]);
      return { id: 'agent-action-supplier-relationship', status: blocked ? 'BLOCKED' : passed ? 'PASS' : 'FAIL', summary: 'The payment and executed request must share one same-tenant supplier.', evidence: { paymentFound: payment.row !== null, requestFound: request.row !== null, supplierMatches: passed } };
    }
  }

  if (role === 'accountant' && refs.has('bank_transaction') && refs.has('payment')) {
    const [transaction, payment] = await Promise.all([
      read('bank_transactions', refs.get('bank_transaction')!, 'id,org_id,supplier_id'),
      read('payments', refs.get('payment')!, 'id,org_id,supplier_id'),
    ]);
    const blocked = transaction.blocked || payment.blocked;
    const passed = !blocked && sameTenantSupplier([transaction.row, payment.row]);
    return { id: 'agent-action-supplier-relationship', status: blocked ? 'BLOCKED' : passed ? 'PASS' : 'FAIL', summary: 'The matched bank transaction and payment must share one same-tenant supplier.', evidence: { transactionFound: transaction.row !== null, paymentFound: payment.row !== null, supplierMatches: passed } };
  }

  if (role === 'accountant' && refs.has('bank_import')) {
    const imported = await read('bank_imports', refs.get('bank_import')!, 'id,org_id,imported_by');
    const passed = !imported.blocked && imported.row?.org_id === QA_ORGANIZATION_ID;
    return { id: 'agent-action-supplier-relationship', status: imported.blocked ? 'BLOCKED' : passed ? 'PASS' : 'FAIL', summary: 'Bank import is organization-scoped; supplier linkage is established only during matching.', evidence: { importFound: imported.row !== null, tenantMatches: passed, supplierNotApplicable: true } };
  }

  return {
    id: 'agent-action-supplier-relationship',
    status: 'BLOCKED',
    summary: 'No complete supplier relationship proof exists for this role/entity combination.',
  };
}

interface ActionAuditWindowRow {
  readonly action: string;
  readonly entity_type: string;
  readonly entity_id: string | null;
}

export function evaluateActionAuditWindow(
  rows: readonly ActionAuditWindowRow[],
  allowed: readonly AuditExpectation[],
): VerificationCheck {
  const matches = (row: ActionAuditWindowRow, expectation: AuditExpectation): boolean =>
    row.action === expectation.action
      && row.entity_type === expectation.entityType
      && (expectation.entityId === undefined || row.entity_id === expectation.entityId);
  const expectationCounts = allowed.map((expectation) => {
    const observedCount = rows.filter((row) => matches(row, expectation)).length;
    const minCount = expectation.minCount ?? 1;
    const countMatches = expectation.exactCount === undefined
      ? observedCount >= minCount
      : observedCount === expectation.exactCount;
    return {
      id: expectation.id,
      observedCount,
      exactCount: expectation.exactCount,
      minCount,
      countMatches,
    };
  });
  const unexpectedRows = rows.filter((row) => !allowed.some((expectation) =>
    matches(row, expectation)));
  const ambiguousRows = rows.filter((row) => allowed.filter((expectation) =>
    matches(row, expectation)).length > 1);
  const passed = expectationCounts.every(({ countMatches }) => countMatches)
    && unexpectedRows.length === 0
    && ambiguousRows.length === 0;
  return {
    id: 'agent-action-audit-window',
    status: passed ? 'PASS' : 'FAIL',
    summary: passed
      ? 'The actor audit window contains exactly the allowlisted action events.'
      : 'The actor audit window contains a missing, duplicate, or unexpected action event.',
    evidence: {
      observedCount: rows.length,
      expectedCount: allowed.reduce(
        (sum, expectation) => sum + (expectation.exactCount ?? expectation.minCount ?? 1),
        0,
      ),
      unexpectedCount: unexpectedRows.length,
      ambiguousCount: ambiguousRows.length,
      expectationCounts,
      observedEventTypes: [...new Set(rows.map(({ action, entity_type }) => `${action}:${entity_type}`))],
      allowedEventTypes: allowed.map(({ action, entityType }) => `${action}:${entityType}`),
    },
  };
}

async function verifyActionAuditWindow(
  runtime: LocalVerificationRuntime,
  expectations: readonly AuditExpectation[],
  actorUserId: string,
  startedAt: string,
  completedAt: string,
): Promise<VerificationCheck> {
  const response = await runtime.createServiceClient()
    .from('audit_logs')
    .select('action,entity_type,entity_id')
    .eq('org_id', QA_ORGANIZATION_ID)
    .eq('user_id', actorUserId)
    .gte('created_at', startedAt)
    .lte('created_at', completedAt);
  if (response.error) {
    return {
      id: 'agent-action-audit-window',
      status: 'BLOCKED',
      summary: 'The actor audit window could not be read; no absence claim was inferred.',
      evidence: { queryErrorPresent: true },
    };
  }
  return evaluateActionAuditWindow(
    (response.data ?? []) as ActionAuditWindowRow[],
    expectations,
  );
}

function nextMonthStart(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new Error('The downloaded report month is malformed.');
  return new Date(Date.UTC(Number(match[1]), Number(match[2]), 1)).toISOString().slice(0, 10);
}

export interface TrustedMonthlyPaymentExportRow {
  readonly amount: number;
  readonly reference: string | null;
  readonly executedBy: string | null;
  readonly createdAt: string;
  readonly supplierName: string;
}

export function buildMonthlyPaymentExportExpectation(input: {
  readonly id: string;
  readonly filePath: string;
  readonly rows: readonly TrustedMonthlyPaymentExportRow[];
  readonly agentStartedAt: string;
  readonly payerUserId: string;
}): ExportExpectation | null {
  const runPayments = input.rows.filter((row) =>
    row.executedBy === input.payerUserId
      && Date.parse(row.createdAt) >= Date.parse(input.agentStartedAt));
  if (runPayments.length !== 1 || input.rows.length === 0) return null;
  return {
    id: input.id,
    filePath: input.filePath,
    kind: 'xlsx',
    sheetName: 'תשלומים',
    expectedHeaders: ['ספק', 'תאריך', 'סכום', 'אמצעי', 'אסמכתא'],
    expectedRowSubsets: input.rows.map((row) => ({
      'ספק': row.supplierName,
      'סכום': row.amount,
      'אסמכתא': row.reference,
    })),
    exactRowCount: input.rows.length,
    forbidFormulas: true,
    total: {
      column: 'סכום',
      expected: input.rows.reduce((sum, row) => sum + row.amount, 0),
    },
  };
}

async function exportExpectations(
  resource: RoleBrowserResource,
  runtime: LocalVerificationRuntime,
  createdAfter: string,
  payerUserId: string,
): Promise<ExportExpectation[]> {
  const expectations: ExportExpectation[] = [];
  for (const [index, entry] of resource.downloadMonitor.entries.entries()) {
    if (!entry.path || entry.failure || entry.bytes <= 0 || !entry.sha256) continue;
    const extension = path.extname(entry.fileName).toLowerCase();
    const base = { id: 'agent-export-' + (index + 1), filePath: entry.path };
    if (extension === '.xlsx') {
      const reportMonth = /report-(\d{4}-\d{2})\.xlsx$/i.exec(entry.fileName)?.[1];
      if (!reportMonth) continue;
      const response = await runtime.createServiceClient()
        .from('payments')
        .select('id,paid_date,amount,reference,executed_by,created_at,supplier:suppliers(name)')
        .eq('org_id', QA_ORGANIZATION_ID)
        .gte('paid_date', `${reportMonth}-01`)
        .lt('paid_date', nextMonthStart(reportMonth))
        .order('paid_date')
        .order('id');
      if (response.error) {
        throw new Error('The verifier could not read the trusted monthly payment slice from the local database.');
      }
      const rows = (response.data ?? []) as Array<{
        id: string;
        paid_date: string;
        amount: number | string;
        reference: string | null;
        executed_by: string | null;
        created_at: string;
        supplier: { name: string } | Array<{ name: string }> | null;
      }>;
      const normalized = rows.map((row) => {
        const supplier = Array.isArray(row.supplier) ? row.supplier[0] : row.supplier;
        const amount = Number(row.amount);
        if (!supplier?.name || !Number.isFinite(amount)) {
          throw new Error('The trusted monthly payment slice contains an invalid supplier or amount.');
        }
        return { ...row, amount, supplierName: supplier.name };
      });
      const expectation = buildMonthlyPaymentExportExpectation({
        id: base.id,
        filePath: base.filePath,
        rows: normalized.map((row) => ({
          amount: row.amount,
          reference: row.reference,
          executedBy: row.executed_by,
          createdAt: row.created_at,
          supplierName: row.supplierName,
        })),
        agentStartedAt: createdAfter,
        payerUserId,
      });
      if (!expectation) {
        throw new Error('The monthly export cannot be bound to exactly one payer mutation from this agent run.');
      }
      expectations.push(expectation);
    }
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
  trustedEntityRefs: Map<string, string>,
) {
  return createVerifierAgent({
    allowedCheckIds,
    callback: async (input) => {
      let verification: VerificationResult;
      let evidenceKind: 'database' | 'audit' | 'download';
      let productEvidence = false;
      if (input.meaningfulBusinessAction) {
        if (!input.mutationEvidence) {
          return {
            status: 'blocked',
            summary: 'Trusted browser mutation evidence is unavailable for this action.',
            evidence: [],
            facts: [{ key: 'trusted_mutation_evidence', value: false }],
          };
        }
        const expectedScenarioId = ROLE_SCENARIOS[input.role];
        if (input.scenarioId !== expectedScenarioId) {
          return {
            status: 'failed',
            summary: 'The role was paired with an unexpected scenario.',
            evidence: [],
            facts: [{ key: 'role_scenario_match', value: false }],
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
        const protocolChecks = await browserMutationContractChecks(
          input.mutationEvidence,
          input.role,
          expectedScenarioId,
          artifactRoot,
        );
        const protocol = createVerificationResult(
          'browser-action-contract',
          'The trusted action envelope, response-derived identifiers, artifacts, notification, endpoints, and timing were evaluated.',
          protocolChecks,
          { mutationMethodsExposed: false, actionId: input.mutationEvidence.actionId },
        );
        if (protocol.status !== 'PASS') {
          const protocolProductEvidence = protocol.checks.some(({ id, status }) =>
            (id === 'agent-action-network'
              || id === 'agent-action-notification'
              || id === 'agent-action-response-facts')
              && status === 'FAIL');
          const relative = await saveVerifierResult(
            artifactRoot,
            input.role,
            input.step,
            input.request.checkId,
            protocol,
          );
          return {
            status: protocol.status === 'FAIL' ? 'failed' : 'blocked',
            summary: protocol.summary,
            evidence: [{ kind: 'network', ref: relative }],
            facts: [
              { key: 'action_contract_pass', value: false },
              { key: 'product_evidence', value: protocolProductEvidence },
              { key: 'check_count', value: protocol.checks.length },
            ],
          };
        }
        const expectedScenario = createAgentScenarioContext(
          getScenario(expectedScenarioId),
          input.role,
        );
        const mutationStepId = trustedMutationStepId(
          expectedScenario,
          input.role,
          input.mutationEvidence.expectedMutation,
        );
        if (!mutationStepId) {
          return {
            status: 'blocked',
            summary: 'The action is not linked to one exact mutating scenario step.',
            evidence: [],
            facts: [{ key: 'mutation_step_linked', value: false }],
          };
        }
        const handoffCheck = trustedCrossRoleHandoffCheck(
          input.role,
          mutationStepId,
          input.mutationEvidence.entityRefs,
          trustedEntityRefs,
        );
        if (handoffCheck && handoffCheck.status !== 'PASS') {
          const handoff = createVerificationResult(
            'cross-role-handoff-contract',
            'Response-derived identifiers were compared with the verified upstream role chain.',
            [handoffCheck],
          );
          const relative = await saveVerifierResult(
            artifactRoot,
            input.role,
            input.step,
            input.request.checkId,
            handoff,
          );
          return {
            status: 'blocked',
            summary: handoff.summary,
            evidence: [{ kind: 'database', ref: relative }],
            facts: [
              { key: 'cross_role_handoff_match', value: false },
              { key: 'product_evidence', value: false },
            ],
          };
        }
        const expectations = trustedMeaningfulExpectations(
          input.role,
          input.mutationEvidence.entityRefs,
          userIds[input.role],
          mutationStepId === 'replay-price-workbook'
            ? createdAfter
            : input.mutationEvidence.startedAt,
          mutationStepId,
          trustedEntityRefs,
        );
        if (!expectations) {
          return {
            status: 'blocked',
            summary: 'The orchestrator has no complete trusted role/entity mapping for this financial action.',
            evidence: [],
            facts: [{ key: 'trusted_mapping_complete', value: false }],
          };
        }
        const [database, integrity, audit, supplierRelationship, auditWindow] = await Promise.all([
          verifyDatabaseRows(runtime, expectations.database),
          verifyDataIntegrity(runtime, expectations.integrity),
          expectations.audit.length
            ? verifyAuditLogs(runtime, expectations.audit)
            : Promise.resolve(createVerificationResult(
                'audit-contract',
                'This isolated document registration has no scenario-defined audit mutation.',
                [{
                  id: 'agent-action-audit-not-defined',
                  status: 'BLOCKED',
                  summary: 'No audit contract exists for this mutation, so full action verification cannot PASS.',
                }],
              )),
          verifyActionSupplierRelationship(runtime, input.role, input.mutationEvidence.entityRefs),
          verifyActionAuditWindow(
            runtime,
            expectations.auditWindow ?? expectations.audit,
            userIds[input.role],
            input.mutationEvidence.startedAt,
            input.mutationEvidence.completedAt,
          ),
        ]);
        let importedTransactionId: string | null = null;
        let importedTransactionCheck: VerificationCheck | null = null;
        if (input.role === 'accountant' && mutationStepId === 'import-bank-csv') {
          const importId = trustedReferences(input.mutationEvidence.entityRefs)?.get('bank_import');
          const imported = importId
            ? await runtime.createServiceClient().from('bank_transactions').select('id')
              .eq('org_id', QA_ORGANIZATION_ID).eq('import_id', importId).limit(2)
            : { data: null, error: new Error('trusted_bank_import_missing') };
          const rows = (imported.data ?? []) as Array<{ id: string }>;
          if (!imported.error && rows.length === 1) importedTransactionId = rows[0]!.id;
          importedTransactionCheck = {
            id: 'agent-imported-bank-transaction-handoff',
            status: importedTransactionId ? 'PASS' : 'BLOCKED',
            summary: importedTransactionId
              ? 'Exactly one imported bank transaction was derived from the verified bank import.'
              : 'The verified bank import did not resolve to exactly one trusted transaction.',
            evidence: { queryError: !!imported.error, observedCount: rows.length },
          };
        }
        productEvidence = database.status === 'FAIL'
          || integrity.status === 'FAIL'
          || audit.status === 'FAIL'
          || supplierRelationship.status === 'FAIL'
          || auditWindow.status === 'FAIL';
        const duplicateAndSideEffectChecks: VerificationCheck[] = [{
          id: 'agent-action-no-duplicate',
          status: database.status === 'PASS' && audit.status === 'PASS' && auditWindow.status === 'PASS'
            ? 'PASS'
            : 'BLOCKED',
          summary: 'Exact primary/relationship counts and an exact allowlisted audit window are required to rule out duplicate dispatch.',
          evidence: { databaseStatus: database.status, auditStatus: audit.status, auditWindowStatus: auditWindow.status },
        }, {
          id: 'agent-action-no-unexpected-side-effect',
          status: database.status === 'PASS' && integrity.status === 'PASS'
            && supplierRelationship.status === 'PASS' && auditWindow.status === 'PASS'
            ? 'PASS'
            : 'BLOCKED',
          summary: 'Only allowlisted endpoints, tenant relationships, and actor audit-window events may occur; incomplete evidence blocks PASS.',
          evidence: { endpointContractStatus: protocol.status, databaseStatus: database.status, integrityStatus: integrity.status, supplierRelationshipStatus: supplierRelationship.status, auditWindowStatus: auditWindow.status },
        }];
        verification = createVerificationResult(
          'trusted-business-action',
          'Action envelope, database state, tenant/supplier integrity, actor attribution, audit reason, duplicate prevention, and scoped side effects were evaluated together.',
          [
            ...protocol.checks,
            ...(handoffCheck ? [handoffCheck] : []),
            ...(importedTransactionCheck ? [importedTransactionCheck] : []),
            ...database.checks,
            ...integrity.checks,
            ...audit.checks,
            supplierRelationship,
            auditWindow,
            ...duplicateAndSideEffectChecks,
          ],
          { mutationMethodsExposed: false, componentStatuses: [protocol.status, database.status, integrity.status, audit.status, supplierRelationship.status, auditWindow.status] },
        );
        if (verification.status === 'PASS') {
          if (importedTransactionId) {
            trustedEntityRefs.set('accountant:bank_transaction', importedTransactionId);
          }
          for (const { kind, visibleReference } of input.mutationEvidence.entityRefs) {
            trustedEntityRefs.set(`${input.role}:${kind}`, visibleReference);
          }
        }
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
        productEvidence = verification.status === 'FAIL';
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
        productEvidence = verification.status === 'FAIL';
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
        productEvidence = verification.status === 'FAIL';
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
        const expectations = await exportExpectations(
          resource,
          runtime,
          createdAfter,
          userIds.payer,
        );
        if (!expectations.length) {
          return {
            status: 'blocked',
            summary: 'No supported, non-empty download was captured for deterministic parsing.',
            evidence: [],
            facts: [{ key: 'supported_download_count', value: 0 }],
          };
        }
        verification = await verifyExportFiles(expectations, artifactRoot);
        productEvidence = verification.status === 'FAIL';
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
        evidence: verifierEvidenceForResult(
          input.meaningfulBusinessAction,
          verification.status,
          evidenceKind,
          relative,
        ),
        facts: [
          { key: 'check_count', value: verification.checks.length },
          { key: 'all_checks_pass', value: verification.status === 'PASS' },
          { key: 'product_evidence', value: productEvidence },
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
  const protectedSearches = new Map<string, string>();
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
    actionEvidenceDirectory: path.join(state.artifactRoot, 'agents', role, 'actions'),
    protectedSearches,
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
    protectedSearches,
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
): Promise<{
  relative: string;
  blockingIssues: readonly string[];
  productBlockingIssueCount: number;
}> {
  const productBlockingIssues = [
    ...resource.consoleMonitor.blockingIssues(),
    ...resource.networkMonitor.blockingIssues(),
  ];
  const infrastructureBlockingIssues = await resource.downloadMonitor.blockingIssues();
  const blockingIssues = [...productBlockingIssues, ...infrastructureBlockingIssues];
  const relative = path.relative(artifactRoot, resource.evidencePath).replaceAll('\\', '/');
  await writeResult(resource.evidencePath, {
    role: resource.role,
    actions: resource.actions,
    console: resource.consoleMonitor.entries,
    network: resource.networkMonitor.entries,
    downloads: resource.downloadMonitor.entries.map(({ path: _path, ...entry }) => entry),
    blockingIssues,
  });
  return {
    relative,
    blockingIssues,
    productBlockingIssueCount: productBlockingIssues.length,
  };
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
    const message = `Role ${resource.role} produced ${evidence.blockingIssues.length} blocking browser evidence issue(s).`;
    if (evidence.productBlockingIssueCount > 0) throw new BrowserProductEvidenceError(message);
    throw new Error(message);
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
      blockerType: 'CONFIGURATION',
      reason: 'QA agent phase is disabled by configuration.',
      startedAt,
      endedAt: new Date().toISOString(),
      orchestrator: null,
      evidencePaths: [],
      exitCode: agentRunExitCode('SKIPPED_BY_CONFIGURATION'),
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
      blockerType: 'CONFIGURATION',
      reason,
      startedAt,
      endedAt: new Date().toISOString(),
      orchestrator: blockedOrchestrator(state.runId, reason, 'CONFIGURATION'),
      evidencePaths: [],
      exitCode: agentRunExitCode('BLOCKED'),
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
  const trustedEntityRefs = new Map<string, string>();
  const evidencePaths: string[] = [];
  let orchestrator: QaAgentOrchestratorResult | null = null;
  let outcome: AgentOrchestrationOutcome | null = null;
  const observeOutcome = (incoming: AgentOrchestrationOutcome): void => {
    outcome = mergeAgentOrchestrationOutcomes(outcome, incoming);
  };

  try {
    const lockResult = await acquireQaLock({ repoRoot: state.repoRoot, runId: 'agents-' + state.runId });
    if (lockResult.status === 'BLOCKED') {
      observeOutcome({
        status: 'BLOCKED',
        blockerType: 'INFRASTRUCTURE',
        reason: lockResult.message,
      });
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
      for (const role of DEFAULT_CROSS_ROLE_ORDER) {
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
          trustedEntityRefs,
        ),
        assignments: prepared,
        beforeRole: async (context) => {
          const dependency = agentRoleDependencyGate(context);
          if (dependency.status === 'blocked') return dependency;

          const role = context.assignment.role;
          const resource = resourcesByRole.get(role);
          if (!resource) throw new Error(`Prepared browser resource is missing for ${role}.`);
          let route: string | null = null;

          if (role === 'office') {
            const receiptId = trustedEntityRefs.get('kitchen:goods_receipt');
            if (receiptId) {
              const client = verificationRuntime!.createServiceClient();
              const receipt = await client.from('goods_receipts')
                .select('order_id')
                .eq('org_id', QA_ORGANIZATION_ID)
                .eq('id', receiptId)
                .maybeSingle();
              if (receipt.error || !receipt.data?.order_id) {
                throw new Error('Trusted kitchen receipt handoff could not resolve its purchase order.');
              }
              const order = await client.from('purchase_orders')
                .select('supplier_id')
                .eq('org_id', QA_ORGANIZATION_ID)
                .eq('id', receipt.data.order_id)
                .maybeSingle();
              if (order.error || !order.data?.supplier_id) {
                throw new Error('Trusted kitchen receipt handoff could not resolve its supplier.');
              }
              route = `/invoices/new?${new URLSearchParams({
                supplier: order.data.supplier_id,
                order: receipt.data.order_id,
                receipt: receiptId,
              })}`;
            }
          } else if (role === 'owner') {
            const requestId = trustedEntityRefs.get('office:payment_request');
            if (requestId) route = `/payment-requests?id=${encodeURIComponent(requestId)}`;
          } else if (role === 'payer') {
            const requestId = trustedEntityRefs.get('owner:payment_request');
            if (requestId) route = `/pay?id=${encodeURIComponent(requestId)}`;
          }

          if (route) {
            const protectedUrl = new URL(route, state.environment.baseUrl);
            if (protectedUrl.search) resource.protectedSearches.set(protectedUrl.pathname, protectedUrl.search);
            await resource.page.goto(state.environment.baseUrl + route, { waitUntil: 'domcontentloaded' });
          }
          return dependency;
        },
        defaultMaxSteps: integerOption(process.env.QA_MAX_AGENT_STEPS, 30, 1, 100),
        defaultMaxRetries: integerOption(process.env.QA_MAX_AGENT_RETRIES, 2, 0, 3),
        stopOnFailure: false,
      });
      const unverified = orchestrator.statistics.unverifiedMeaningfulActions > 0;
      observeOutcome(classifyAgentOrchestrationOutcome({
        orchestratorStatus: orchestrator.status,
        unverifiedMeaningfulActions: unverified
          ? orchestrator.statistics.unverifiedMeaningfulActions
          : 0,
        blockedRoleCount: orchestrator.statistics.blocked,
        infrastructureFailedRoleCount: orchestrator.roleResults.filter(({ status, blockerType }) =>
          status === 'failed' && blockerType === 'INFRASTRUCTURE').length,
        productVerifierFailure: hasProductVerifierFailure(orchestrator),
      }));
    }
  } catch (error) {
    observeOutcome({
      status: 'BLOCKED',
      blockerType: 'INFRASTRUCTURE',
      reason: redactText(error instanceof Error ? error.message : 'Agent runtime failed.'),
    });
  } finally {
    for (const resource of resources) {
      try {
        evidencePaths.push(await finalizeRoleBrowser(resource, state.artifactRoot));
      } catch (error) {
        observeOutcome({
          status: error instanceof BrowserProductEvidenceError ? 'FAILED' : 'BLOCKED',
          blockerType: error instanceof BrowserProductEvidenceError ? 'PRODUCT' : 'INFRASTRUCTURE',
          reason: redactText(error instanceof Error ? error.message : 'Agent evidence cleanup failed.'),
        });
      }
    }
    if (browser) {
      try {
        await browser.close();
      } catch {
        observeOutcome({
          status: 'BLOCKED',
          blockerType: 'INFRASTRUCTURE',
          reason: 'Agent browser did not close cleanly.',
        });
      }
    }
    if (verificationRuntime) {
      try {
        verificationRuntime.dispose();
      } catch {
        observeOutcome({
          status: 'BLOCKED',
          blockerType: 'INFRASTRUCTURE',
          reason: 'Agent verifier runtime did not dispose cleanly.',
        });
      }
    }
    if (preview) {
      try {
        await preview.stop();
      } catch {
        observeOutcome({
          status: 'BLOCKED',
          blockerType: 'INFRASTRUCTURE',
          reason: 'Agent preview process did not stop cleanly.',
        });
      }
    }
    if (lock && !await releaseQaLock(lock)) {
      observeOutcome({
        status: 'BLOCKED',
        blockerType: 'INFRASTRUCTURE',
        reason: 'QA mutex ownership could not be verified during agent cleanup.',
      });
    }
  }

  const finalOutcome = outcome ?? {
    status: 'BLOCKED',
    blockerType: 'INFRASTRUCTURE',
    reason: 'Agent runtime did not start.',
  } satisfies AgentOrchestrationOutcome;
  if (!orchestrator) orchestrator = blockedOrchestrator(state.runId, finalOutcome.reason);
  const result: AgentRunResult = {
    schemaVersion: 1,
    runId: state.runId,
    status: finalOutcome.status,
    blockerType: finalOutcome.blockerType,
    reason: finalOutcome.reason,
    startedAt,
    endedAt: new Date().toISOString(),
    orchestrator,
    evidencePaths,
    exitCode: agentRunExitCode(finalOutcome.status),
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
