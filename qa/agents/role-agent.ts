import { randomUUID } from 'node:crypto';
import type {
  BrowserMutationEvidence,
  SafeBrowserTools,
  SafeKey,
  SafeTarget,
  VisibleUiSnapshot,
} from '../browser/browser-tools.ts';
import type { QaRole } from '../config/roles.ts';
import {
  AgentEvidenceSchema,
  type AgentEvidence,
  type AgentObservation,
  type AgentScenarioContext,
  type RoleStepDecision,
  type RoleSummary,
  type SafeBrowserAction,
  type SafeBrowserTargetDecision,
} from './contracts.ts';
import {
  QaModelError,
  redactAgentText,
  safeAgentErrorMessage,
  type ModelScenarioProjection,
  type ModelStepReceipt,
  type QaModelAdapter,
} from './model-adapter.ts';
import { renderRoleInstructions, rolePromptFor } from './prompts/index.ts';
import type {
  VerifierAgent,
  VerifierResult,
} from './verifier-agent.ts';

export const SAFE_BROWSER_ACTION_NAMES = [
  'open',
  'snapshot',
  'click',
  'fill',
  'select',
  'upload',
  'press',
  'scroll',
  'wait_for_text',
  'screenshot',
  'current_url',
] as const;

export interface RoleAgentOptions {
  readonly runId: string;
  readonly role: QaRole;
  readonly scenario: AgentScenarioContext;
  readonly browserTools: SafeBrowserTools;
  readonly modelAdapter: QaModelAdapter;
  readonly verifierAgent?: VerifierAgent;
  readonly maxSteps?: number;
  readonly maxRetries?: number;
  readonly analyzeAfterActions?: boolean;
  readonly retryDelayMs?: number;
  /** Trusted evidence handles prepared by monitors outside the role model. */
  readonly initialEvidence?: readonly AgentEvidence[];
  /** Trusted monitor callback. Its implementation and handles are never exposed to the model. */
  readonly collectEvidence?: () => Promise<readonly AgentEvidence[]>;
}

export interface RoleStepRecord {
  readonly step: number;
  readonly decision: RoleStepDecision;
  readonly receipt: ModelStepReceipt | null;
}

export interface RoleVerificationRecord {
  readonly step: number;
  readonly checkId: string;
  readonly actionId: string | null;
  readonly mutationEvidence: BrowserMutationEvidence | null;
  readonly result: VerifierResult;
}

export type RoleRunStatus = 'completed' | 'blocked' | 'failed' | 'step_limit';
export type RoleBlockerType = 'PRODUCT' | 'INFRASTRUCTURE' | 'CONFIGURATION' | null;

export interface RoleRunResult {
  readonly runId: string;
  readonly role: QaRole;
  readonly scenarioId: string;
  readonly scenarioName: string;
  readonly status: RoleRunStatus;
  readonly blockerType: RoleBlockerType;
  readonly terminalReason: string;
  readonly steps: readonly RoleStepRecord[];
  readonly receipts: readonly ModelStepReceipt[];
  readonly verificationResults: readonly RoleVerificationRecord[];
  readonly observations: readonly AgentObservation[];
  readonly summary: RoleSummary | null;
  readonly evidence: readonly AgentEvidence[];
  readonly evidenceRefs: readonly string[];
  readonly missingEvidenceKinds: readonly string[];
  readonly unverifiedMeaningfulActions: number;
  readonly helpQuestion: string | null;
  readonly diagnostics: readonly string[];
}

interface BrowserExecutionResult {
  readonly summary: string;
  readonly snapshot: VisibleUiSnapshot | null;
  readonly evidence: readonly AgentEvidence[];
  readonly mutationEvidence?: BrowserMutationEvidence;
  readonly actionError?: string;
}

function scenarioProjection(
  scenario: AgentScenarioContext,
  role: QaRole,
  completedStepIds: ReadonlySet<string> = new Set(),
): ModelScenarioProjection {
  const steps = scenario.definition.steps.filter((step) => step.actorRole === role);
  const pendingMutationStep = steps.find(({ id, mutatesData }) =>
    mutatesData && !completedStepIds.has(id));
  return {
    id: scenario.id,
    name: scenario.name,
    objective: scenario.objective,
    allowedRoutes: [...scenario.allowedRoutes],
    allowedFixtureNames: [...scenario.allowedFixtureNames],
    allowedVerificationChecks: [...scenario.allowedVerificationChecks],
    evidenceRequirements: [...scenario.evidenceRequirements],
    steps: steps.map(({ id, route, action, expected, mutatesData, verifierIds }) => ({
      id,
      route,
      action,
      expected,
      mutatesData,
      verifierIds: [...verifierIds],
    })),
    completedStepIds: steps
      .filter(({ id }) => completedStepIds.has(id))
      .map(({ id }) => id),
    pendingMutationStepId: pendingMutationStep?.id ?? null,
    pendingVerificationStepId: pendingMutationStep
      ? null
      : steps.find(({ id, mutatesData, verifierIds }) =>
          !mutatesData && verifierIds.includes('export') && !completedStepIds.has(id))?.id ?? null,
  };
}

function toSafeTarget(target: SafeBrowserTargetDecision): SafeTarget {
  if (target.kind === 'role') {
    if (!target.role || !target.name) throw new Error('invalid_role_target');
    return { kind: 'role', role: target.role, name: target.name, exact: target.exact };
  }
  if (target.kind === 'label') {
    if (!target.label) throw new Error('invalid_label_target');
    return { kind: 'label', label: target.label, exact: target.exact };
  }
  if (!target.text) throw new Error('invalid_text_target');
  return { kind: 'text', text: target.text, exact: target.exact };
}

function requireTarget(action: SafeBrowserAction): SafeTarget {
  if (!action.target) throw new Error(`target_required:${action.type}`);
  return toSafeTarget(action.target);
}

function requireString(value: string | null, field: string): string {
  if (value === null) throw new Error(`${field}_required`);
  return value;
}

export async function executeSafeBrowserAction(
  tools: SafeBrowserTools,
  action: SafeBrowserAction,
): Promise<BrowserExecutionResult> {
  switch (action.type) {
    case 'open': {
      const route = requireString(action.route, 'route');
      return { summary: `opened:${route}`, snapshot: await tools.open(route), evidence: [] };
    }
    case 'snapshot':
      return { summary: 'snapshot_captured', snapshot: await tools.snapshot(), evidence: [] };
    case 'click':
      return {
        summary: 'control_clicked',
        snapshot: await tools.click(requireTarget(action)),
        evidence: [],
      };
    case 'fill':
      return {
        summary: 'field_filled',
        snapshot: await tools.fill(requireTarget(action), requireString(action.value, 'value')),
        evidence: [],
      };
    case 'select':
      return {
        summary: 'option_selected',
        snapshot: await tools.select(requireTarget(action), requireString(action.value, 'value')),
        evidence: [],
      };
    case 'upload':
      return {
        summary: `fixture_uploaded:${requireString(action.fixtureName, 'fixtureName')}`,
        snapshot: await tools.upload(
          requireTarget(action),
          requireString(action.fixtureName, 'fixtureName'),
        ),
        evidence: [],
      };
    case 'press':
      return {
        summary: `key_pressed:${action.key}`,
        snapshot: await tools.press(requireString(action.key, 'key') as SafeKey),
        evidence: [],
      };
    case 'scroll':
      return {
        summary: `scrolled:${action.direction}`,
        snapshot: await tools.scroll(action.direction ?? 'down'),
        evidence: [],
      };
    case 'wait_for_text':
      return {
        summary: 'visible_text_observed',
        snapshot: await tools.waitForText(requireString(action.text, 'text')),
        evidence: [],
      };
    case 'screenshot': {
      const path = await tools.screenshot(requireString(action.label, 'label'));
      return {
        summary: 'screenshot_captured',
        snapshot: null,
        evidence: [{ kind: 'screenshot', ref: path, source: 'browser' }],
      };
    }
    case 'current_url': {
      const url = await tools.currentUrl();
      return { summary: `current_url:${url}`, snapshot: null, evidence: [] };
    }
  }
}

function routeMatches(path: string, allowed: string): boolean {
  const allowedPath = new URL(allowed, 'http://qa.local').pathname;
  if (allowedPath.endsWith('/*')) return path.startsWith(allowedPath.slice(0, -1));
  const pathParts = path.split('/').filter(Boolean);
  const allowedParts = allowedPath.split('/').filter(Boolean);
  return pathParts.length === allowedParts.length && allowedParts.every(
    (part, index) => part.startsWith(':') || part === pathParts[index],
  );
}

function routeAllowed(route: string, allowedRoutes: readonly string[]): boolean {
  if (!route.startsWith('/') || route.startsWith('//')) return false;
  const url = new URL(route, 'http://qa.local');
  if (url.origin !== 'http://qa.local') return false;
  return allowedRoutes.some((allowed) => routeMatches(url.pathname, allowed));
}

function actionDenial(
  action: SafeBrowserAction,
  scenario: AgentScenarioContext,
): string | null {
  if (action.type === 'open') {
    return action.route && routeAllowed(action.route, scenario.allowedRoutes)
      ? null
      : 'route_outside_scenario_allowlist';
  }
  if (action.type === 'upload') {
    return action.fixtureName && scenario.allowedFixtureNames.includes(action.fixtureName)
      ? null
      : 'fixture_outside_scenario_allowlist';
  }
  return null;
}

function actionFingerprint(action: SafeBrowserAction): string {
  const target = action.target
    ? `${action.target.kind}:${action.target.role ?? ''}:${action.target.name ?? ''}:${action.target.label ?? ''}:${action.target.text ?? ''}`
    : '';
  return [action.type, action.route ?? '', target, action.fixtureName ?? '', action.key ?? ''].join('|');
}

function actionRequiresVerification(
  _action: SafeBrowserAction,
  declaredMeaningful: boolean,
): boolean {
  return declaredMeaningful;
}

function actionMayMutate(action: SafeBrowserAction): boolean {
  return ['click', 'fill', 'select', 'upload', 'press'].includes(action.type);
}

function trustedActionDescription(action: SafeBrowserAction): string {
  const target = action.target
    ? [action.target.kind, action.target.role, action.target.name, action.target.label, action.target.text]
      .filter(Boolean).join(':')
    : null;
  return [action.type, target, action.route, action.fixtureName, action.key].filter(Boolean).join(' | ');
}

const MUTATION_STEP_ENTITY_KINDS: Readonly<Record<string, readonly string[]>> = {
  'submit-price-workbook': ['supplier_price_submission'],
  'replay-price-workbook': ['supplier_price_submission'],
  'record-partial-receipt': ['goods_receipt'],
  'attach-receipt-document': ['document'],
  'create-invoice': ['invoice'],
  'start-invoice-review': ['invoice'],
  'approve-invoice-for-payment': ['invoice'],
  'request-payment': ['payment_request'],
  'approve-payment-request': ['payment_request'],
  'execute-transfer': ['payment', 'payment_request', 'invoice'],
  'import-bank-csv': ['bank_import'],
  'match-bank-payment': ['bank_transaction', 'payment', 'invoice'],
};

function roleMutationSteps(scenario: AgentScenarioContext, role: QaRole) {
  return scenario.definition.steps.filter(
    (step) => step.actorRole === role && step.mutatesData,
  );
}

function roleRequiredVerificationSteps(scenario: AgentScenarioContext, role: QaRole) {
  return scenario.definition.steps.filter(
    (step) => step.actorRole === role
      && !step.mutatesData
      && step.verifierIds.includes('export'),
  );
}

export function trustedExpectedMutation(
  scenario: AgentScenarioContext,
  role: QaRole,
  mutationStepId?: string,
): string {
  const mutations = roleMutationSteps(scenario, role);
  if (!mutations.length || !mutationStepId) return 'No scenario mutation is expected.';
  const mutation = mutations.find(({ id }) => id === mutationStepId);
  return mutation
    ? `${mutation.id}: ${mutation.expected}`
    : 'No scenario mutation is expected.';
}

export function trustedMutationExpectations(
  scenario: AgentScenarioContext,
  role: QaRole,
): readonly string[] {
  return roleMutationSteps(scenario, role).map(({ id }) =>
    trustedExpectedMutation(scenario, role, id));
}

export function trustedMutationStepId(
  scenario: AgentScenarioContext,
  role: QaRole,
  expectedMutation: string,
): string | null {
  return roleMutationSteps(scenario, role).find(({ id }) =>
    trustedExpectedMutation(scenario, role, id) === expectedMutation)?.id ?? null;
}

function mutationEvidenceCompletesStep(
  mutationStepId: string,
  evidence: BrowserMutationEvidence | undefined,
): boolean {
  const requiredKinds = MUTATION_STEP_ENTITY_KINDS[mutationStepId];
  if (!requiredKinds || !evidence?.hasMutationRequest) return false;
  const observedKinds = new Set(evidence.entityRefs.map(({ kind }) => kind));
  return requiredKinds.every((kind) => observedKinds.has(kind));
}

function singleDispatchRequired(
  action: SafeBrowserAction,
  declaredMeaningful: boolean,
): boolean {
  return actionRequiresVerification(action, declaredMeaningful);
}

function receipt(
  step: number,
  actionType: string,
  status: ModelStepReceipt['status'],
  summary: string,
  verificationStatus: ModelStepReceipt['verificationStatus'] = 'not_requested',
  evidenceRefs: readonly string[] = [],
): ModelStepReceipt {
  return {
    step,
    actionType,
    status,
    summary: redactAgentText(summary, 2_000),
    verificationStatus,
    // Receipts are sent back to the model. Keep artifact filesystem paths in RoleRunResult only;
    // the model receives opaque handles and therefore gains no filesystem visibility.
    evidenceRefs: evidenceRefs.map((_ref, index) => `evidence:${step}:${index + 1}`),
  };
}

function retryBudget(value: number | undefined, fallback: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > max) {
    throw new Error(`agent_budget_out_of_range:${resolved}`);
  }
  return resolved;
}

async function withModelRetries<T>(
  operation: () => Promise<T>,
  maxRetries: number,
  delayMs: number,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof QaModelError) || !error.retryable || attempt >= maxRetries) {
        throw error;
      }
      const fallbackDelay = error.code === 'model_rate_limited' ? 10_000 * (attempt + 1) : 0;
      const waitMs = Math.max(delayMs * (attempt + 1), error.retryAfterMs ?? fallbackDelay);
      if (waitMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }
}

export function blockedRoleRunResult(options: {
  readonly runId: string;
  readonly role: QaRole;
  readonly scenario: AgentScenarioContext;
  readonly reason: string;
  readonly blockerType?: 'INFRASTRUCTURE' | 'CONFIGURATION';
}): RoleRunResult {
  return {
    runId: options.runId,
    role: options.role,
    scenarioId: options.scenario.id,
    scenarioName: options.scenario.name,
    status: 'blocked',
    blockerType: options.blockerType ?? 'INFRASTRUCTURE',
    terminalReason: options.reason,
    steps: [],
    receipts: [],
    verificationResults: [],
    observations: [],
    summary: null,
    evidence: [],
    evidenceRefs: [],
    missingEvidenceKinds: [...options.scenario.evidenceRequirements],
    unverifiedMeaningfulActions: 0,
    helpQuestion: null,
    diagnostics: [options.reason],
  };
}

export function classifyRoleRunBlocker(
  status: RoleRunStatus,
  verificationResults: readonly RoleVerificationRecord[],
): RoleBlockerType {
  if (status === 'completed') return null;
  const productFailure = status === 'failed' && verificationResults.some(({ result }) =>
    result.status === 'failed'
      && result.facts.some(({ key, value }) => key === 'product_evidence' && value === true));
  return productFailure ? 'PRODUCT' : 'INFRASTRUCTURE';
}

export async function runRoleAgent(options: RoleAgentOptions): Promise<RoleRunResult> {
  const maxSteps = retryBudget(options.maxSteps, 24, 100);
  if (maxSteps < 1) throw new Error('agent maxSteps must be at least one');
  const maxRetries = retryBudget(options.maxRetries, 1, 3);
  const retryDelayMs = retryBudget(options.retryDelayMs, 250, 5_000);
  const initialProjection = scenarioProjection(options.scenario, options.role);
  const rolePrompt = rolePromptFor(options.role);
  const roleInstructions = renderRoleInstructions(rolePrompt, initialProjection);

  if (options.modelAdapter.availability.status === 'blocked') {
    return blockedRoleRunResult({
      runId: options.runId,
      role: options.role,
      scenario: options.scenario,
      reason: options.modelAdapter.availability.reason,
    });
  }

  const steps: RoleStepRecord[] = [];
  const receipts: ModelStepReceipt[] = [];
  const verificationResults: RoleVerificationRecord[] = [];
  const observations: AgentObservation[] = [];
  const evidence: AgentEvidence[] = [];
  const evidenceKeys = new Set<string>();
  const addEvidence = (item: AgentEvidence) => {
    const parsed = AgentEvidenceSchema.parse(item);
    const key = `${parsed.kind}:${parsed.ref}`;
    if (!evidenceKeys.has(key)) {
      evidenceKeys.add(key);
      evidence.push(parsed);
    }
  };
  for (const item of options.initialEvidence ?? []) addEvidence(item);
  const diagnostics: string[] = [];
  const dispatchedSingleActions = new Set<string>();
  const requiredMutationSteps = roleMutationSteps(options.scenario, options.role);
  const requiredVerificationSteps = roleRequiredVerificationSteps(options.scenario, options.role);
  const verifiedMutationStepIds = new Set<string>();
  const verifiedVerificationStepIds = new Set<string>();
  const completedScenarioStepIds = (): ReadonlySet<string> => new Set([
    ...verifiedMutationStepIds,
    ...verifiedVerificationStepIds,
  ]);
  const missingMutationStepIds = (): string[] => requiredMutationSteps
    .filter(({ id }) => !verifiedMutationStepIds.has(id))
    .map(({ id }) => id);
  const missingVerificationStepIds = (): string[] => requiredVerificationSteps
    .filter(({ id }) => !verifiedVerificationStepIds.has(id))
    .map(({ id }) => id);
  const missingRequiredStepIds = (): string[] => [
    ...missingMutationStepIds(),
    ...missingVerificationStepIds(),
  ];
  let unverifiedMeaningfulActions = 0;
  let terminalStatus: RoleRunStatus = 'step_limit';
  let terminalReason = 'agent_step_limit_reached';
  let helpQuestion: string | null = null;
  let modelTerminalFailure = false;
  let verificationFailures = 0;
  let verificationBlocks = 0;

  for (let step = 1; step <= maxSteps; step += 1) {
    let snapshot: VisibleUiSnapshot;
    try {
      snapshot = await options.browserTools.snapshot();
    } catch (error) {
      terminalStatus = 'failed';
      terminalReason = 'browser_snapshot_failed';
      diagnostics.push(safeAgentErrorMessage(error));
      break;
    }

    let decision: RoleStepDecision;
    try {
      decision = await withModelRetries(
        () => options.modelAdapter.runRoleStep({
          runId: options.runId,
          role: options.role,
          roleInstructions,
          scenario: scenarioProjection(
            options.scenario,
            options.role,
            completedScenarioStepIds(),
          ),
          currentStep: step,
          maxSteps,
          remainingSteps: maxSteps - step + 1,
          maxRetries,
          visibleUiSnapshot: snapshot,
          recentReceipts: receipts.slice(-8),
          availableBrowserActions: SAFE_BROWSER_ACTION_NAMES,
        }),
        maxRetries,
        retryDelayMs,
      );
    } catch (error) {
      terminalStatus = error instanceof QaModelError
        && (error.code === 'model_blocked' || error.retryable)
        ? 'blocked'
        : 'failed';
      terminalReason = safeAgentErrorMessage(error);
      modelTerminalFailure = true;
      if (error instanceof QaModelError && error.safeRawResponse) {
        diagnostics.push(error.safeRawResponse);
      } else diagnostics.push(terminalReason);
      break;
    }

    observations.push(...decision.observations);
    if (decision.decision === 'request_help') {
      helpQuestion = decision.helpQuestion;
      terminalStatus = 'blocked';
      terminalReason = 'agent_requested_orchestrator_help';
      steps.push({ step, decision, receipt: null });
      break;
    }
    if (decision.decision === 'finish') {
      const requestedStatus = decision.finishStatus ?? 'failed';
      const missingSteps = missingRequiredStepIds();
      if (requestedStatus === 'completed' && missingSteps.length > 0) {
        const deniedReason = `required_scenario_steps_missing:${missingSteps.join(',')}`;
        const deniedReceipt = receipt(step, 'finish', 'denied', deniedReason);
        receipts.push(deniedReceipt);
        steps.push({ step, decision, receipt: deniedReceipt });
        continue;
      }
      terminalStatus = requestedStatus;
      terminalReason = decision.finishSummary ?? decision.reason;
      steps.push({ step, decision, receipt: null });
      break;
    }

    const action = decision.action;
    if (!action) {
      terminalStatus = 'failed';
      terminalReason = 'model_action_missing_after_validation';
      steps.push({ step, decision, receipt: null });
      break;
    }
    const assignedMutationStep = requiredMutationSteps.find(
      ({ id }) => !verifiedMutationStepIds.has(id),
    );
    const assignedVerificationStep = missingMutationStepIds().length === 0
      ? requiredVerificationSteps.find(({ id }) => !verifiedVerificationStepIds.has(id))
      : undefined;
    let denied = actionDenial(action, options.scenario);
    if (decision.verification
      && !options.scenario.allowedVerificationChecks.includes(decision.verification.checkId)) {
      denied = 'verification_outside_scenario_allowlist';
    }
    if (decision.meaningfulBusinessAction
      && requiredMutationSteps.length > 0
      && !assignedMutationStep) {
      denied = 'meaningful_action_without_pending_step';
    }
    const fingerprint = `${assignedMutationStep?.id ?? assignedVerificationStep?.id ?? 'unassigned'}|${actionFingerprint(action)}`;
    if (decision.verification && !decision.meaningfulBusinessAction
      && (!assignedVerificationStep
        || action.type !== 'click'
        || decision.verification.checkId !== 'export'
        || !assignedVerificationStep.verifierIds.includes(decision.verification.checkId))) {
      denied = 'non_mutating_verification_outside_pending_step';
    }
    const expectedMutation = trustedExpectedMutation(
      options.scenario,
      options.role,
      assignedMutationStep?.id,
    );
    const requiresVerificationBeforeDispatch = actionRequiresVerification(
      action,
      decision.meaningfulBusinessAction,
    );
    const singleDispatch = singleDispatchRequired(action, decision.meaningfulBusinessAction);
    if (dispatchedSingleActions.has(fingerprint)) {
      denied = 'meaningful_action_repeat_denied';
    }
    if (denied) {
      const deniedReceipt = receipt(step, action.type, 'denied', denied);
      receipts.push(deniedReceipt);
      steps.push({ step, decision, receipt: deniedReceipt });
      if (denied === 'meaningful_action_repeat_denied') {
        terminalStatus = 'blocked';
        terminalReason = denied;
        break;
      }
      continue;
    }

    // Record before dispatch. A browser timeout may happen after the application accepted the
    // action; retrying the same financial mutation would be unsafe.
    if (singleDispatch) dispatchedSingleActions.add(fingerprint);

    const mutationCaptureAttempted = actionMayMutate(action)
      && options.browserTools.capturePotentialMutation !== undefined;
    let execution: BrowserExecutionResult;
    try {
      if (mutationCaptureAttempted && options.browserTools.capturePotentialMutation) {
        const captured = await options.browserTools.capturePotentialMutation({
          actionId: randomUUID(),
          step,
          role: options.role,
          scenarioId: options.scenario.id,
          actionType: action.type,
          description: trustedActionDescription(action),
          expectedMutation,
          expectMutation: requiresVerificationBeforeDispatch,
        }, () => executeSafeBrowserAction(options.browserTools, action));
        execution = captured.value
          ? { ...captured.value, mutationEvidence: captured.evidence }
          : {
              summary: 'browser_action_failed',
              snapshot: null,
              evidence: [],
              mutationEvidence: captured.evidence,
              actionError: captured.evidence.actionError ?? 'browser_action_failed',
            };
        execution = {
          ...execution,
          actionError: captured.evidence.actionError ?? execution.actionError,
          evidence: [
            ...execution.evidence,
            { kind: 'screenshot', ref: captured.evidence.preScreenshot, source: 'browser' },
            { kind: 'screenshot', ref: captured.evidence.postScreenshot, source: 'browser' },
            { kind: 'network', ref: captured.evidence.evidenceRefs[2]!, source: 'browser' },
          ],
        };
      } else {
        execution = await executeSafeBrowserAction(options.browserTools, action);
      }
      for (const item of execution.evidence) addEvidence(item);
    } catch (error) {
      const outcomeUnknown = mutationCaptureAttempted || requiresVerificationBeforeDispatch;
      if (mutationCaptureAttempted) {
        dispatchedSingleActions.add(fingerprint);
        diagnostics.push('mutation_fingerprint_locked_after_capture_failure');
      }
      const failedReceipt = receipt(
        step,
        action.type,
        'failed',
        safeAgentErrorMessage(error),
        outcomeUnknown ? 'blocked' : 'not_requested',
      );
      receipts.push(failedReceipt);
      steps.push({ step, decision, receipt: failedReceipt });
      if (outcomeUnknown) {
        unverifiedMeaningfulActions += 1;
        verificationBlocks += 1;
        terminalStatus = 'blocked';
        terminalReason = mutationCaptureAttempted
          ? 'potential_mutation_outcome_unknown'
          : 'meaningful_action_outcome_unknown';
        break;
      }
      continue;
    }

    // The model may mistake a modal-opening control for the commit button. The captured
    // network envelope, not the model declaration, decides whether a mutation occurred.
    const requiresVerification = execution.mutationEvidence
      ? execution.mutationEvidence.hasMutationRequest
      : requiresVerificationBeforeDispatch;
    if (requiresVerification && !dispatchedSingleActions.has(fingerprint)) {
      dispatchedSingleActions.add(fingerprint);
    }

    let verificationStatus: ModelStepReceipt['verificationStatus'] = 'not_requested';
    const stepEvidence = execution.evidence.map(({ ref }) => ref);
    const requiredNonMutatingVerification = !requiresVerification
      && decision.verification?.checkId === 'export'
      && assignedVerificationStep !== undefined;
    const trustedVerification = requiresVerification
      ? options.scenario.allowedVerificationChecks.includes('data-integrity')
        ? {
            checkId: 'data-integrity',
            purpose: 'Independently verify the exact browser mutation immediately after dispatch.',
            expectedOutcome: expectedMutation,
            entityRefs: [],
          }
        : decision.verification
      : requiredNonMutatingVerification
        ? {
            checkId: 'export',
            purpose: 'Independently verify the downloaded scenario export after the browser action.',
            expectedOutcome: `${assignedVerificationStep.id}: ${assignedVerificationStep.expected}`,
            entityRefs: [],
          }
        : null;
    const requiresStepVerification = requiresVerification || requiredNonMutatingVerification;
    if (trustedVerification) {
      if (!options.verifierAgent) {
        verificationStatus = 'blocked';
        verificationBlocks += 1;
        diagnostics.push(`verifier_unavailable:${trustedVerification.checkId}`);
      } else {
        try {
          const result = await options.verifierAgent.verify({
            runId: options.runId,
            role: options.role,
            scenarioId: options.scenario.id,
            step,
            actionType: action.type,
            meaningfulBusinessAction: requiresVerification,
            mutationEvidence: execution.mutationEvidence ?? null,
            request: trustedVerification,
          });
          verificationStatus = result.status;
          verificationResults.push({
            step,
            checkId: trustedVerification.checkId,
            actionId: execution.mutationEvidence?.actionId ?? null,
            mutationEvidence: execution.mutationEvidence ?? null,
            result,
          });
          if (result.status === 'failed') verificationFailures += 1;
          if (result.status === 'blocked') verificationBlocks += 1;
          for (const item of result.evidence) {
            addEvidence({ ...item, source: 'verifier' });
            stepEvidence.push(item.ref);
          }
        } catch (error) {
          verificationStatus = 'blocked';
          verificationBlocks += 1;
          diagnostics.push(safeAgentErrorMessage(error));
        }
      }
    } else if (requiresVerification) {
      verificationStatus = 'blocked';
      verificationBlocks += 1;
      diagnostics.push('trusted_verification_mapping_unavailable');
    }

    if (requiresVerification && verificationStatus === 'blocked') {
      unverifiedMeaningfulActions += 1;
    }

    const completedReceipt = receipt(
      step,
      action.type,
      requiresStepVerification && verificationStatus !== 'verified' || execution.actionError
        ? 'failed'
        : 'completed',
      execution.actionError ?? execution.summary,
      verificationStatus,
      stepEvidence,
    );
    receipts.push(completedReceipt);
    steps.push({ step, decision, receipt: completedReceipt });

    if (requiresStepVerification && verificationStatus !== 'verified') {
      terminalStatus = verificationStatus === 'failed' ? 'failed' : 'blocked';
      terminalReason = verificationStatus === 'failed'
        ? 'required_verification_failed'
        : 'required_verification_blocked';
      break;
    }

    if (verificationStatus === 'verified'
        && assignedMutationStep
        && mutationEvidenceCompletesStep(assignedMutationStep.id, execution.mutationEvidence)) {
      verifiedMutationStepIds.add(assignedMutationStep.id);
    }
    if (verificationStatus === 'verified'
        && requiredNonMutatingVerification
        && assignedVerificationStep) {
      verifiedVerificationStepIds.add(assignedVerificationStep.id);
    }

    if (options.analyzeAfterActions) {
      try {
        const analysisSnapshot = execution.snapshot ?? await options.browserTools.snapshot();
        const analyzed = await withModelRetries(
          () => options.modelAdapter.analyzeObservation({
            runId: options.runId,
            role: options.role,
            roleInstructions,
            scenario: scenarioProjection(
              options.scenario,
              options.role,
              completedScenarioStepIds(),
            ),
            step,
            visibleUiSnapshot: analysisSnapshot,
            actionReceipt: completedReceipt,
          }),
          maxRetries,
          retryDelayMs,
        );
        observations.push(...analyzed);
      } catch (error) {
        terminalStatus = 'failed';
        terminalReason = safeAgentErrorMessage(error);
        modelTerminalFailure = true;
        diagnostics.push(terminalReason);
        break;
      }
    }
  }

  let evidenceCollectionFailed = false;
  if (options.collectEvidence) {
    try {
      for (const item of await options.collectEvidence()) addEvidence(item);
    } catch (error) {
      evidenceCollectionFailed = true;
      diagnostics.push(`evidence_collection_failed:${safeAgentErrorMessage(error)}`);
    }
  }
  const missingEvidenceKinds = options.scenario.evidenceRequirements.filter(
    (requiredKind) => !evidence.some(({ kind }) => kind === requiredKind),
  );
  if (verificationFailures > 0 && terminalStatus !== 'failed') {
    terminalStatus = 'failed';
    terminalReason = 'required_verification_failed';
  } else if (terminalStatus === 'completed' && verificationBlocks > 0) {
    terminalStatus = 'blocked';
    terminalReason = 'required_verification_blocked';
  } else if (terminalStatus === 'completed' && unverifiedMeaningfulActions > 0) {
    terminalStatus = 'blocked';
    terminalReason = 'meaningful_action_not_verified';
  } else if (terminalStatus === 'completed' && evidenceCollectionFailed) {
    terminalStatus = 'blocked';
    terminalReason = 'evidence_collection_failed';
  } else if (terminalStatus === 'completed' && missingEvidenceKinds.length > 0) {
    terminalStatus = 'blocked';
    terminalReason = `required_evidence_missing:${missingEvidenceKinds.join(',')}`;
  }

  let summary: RoleSummary | null = null;
  if (!modelTerminalFailure && (terminalStatus !== 'step_limit' || receipts.length > 0)) {
    try {
      summary = await withModelRetries(
        () => options.modelAdapter.summarizeRole({
          runId: options.runId,
          role: options.role,
          roleInstructions,
          scenario: scenarioProjection(
            options.scenario,
            options.role,
            completedScenarioStepIds(),
          ),
          terminalStatus,
          terminalReason,
          receipts,
          observations,
          unverifiedMeaningfulActions,
        }),
        maxRetries,
        retryDelayMs,
      );
      const expectedSummaryStatus = terminalStatus === 'completed'
        ? 'completed'
        : terminalStatus === 'blocked'
        ? 'blocked'
        : 'failed';
      if (summary.status !== expectedSummaryStatus) {
        summary = null;
        diagnostics.push('role_summary_status_mismatch');
        if (terminalStatus === 'completed') {
          terminalStatus = 'failed';
          terminalReason = 'role_summary_status_mismatch';
        }
      }
      if (summary) observations.push(...summary.observations);
    } catch (error) {
      const summaryFailure = `role_summary_failed:${safeAgentErrorMessage(error)}`;
      if (terminalStatus === 'completed') {
        terminalStatus = 'failed';
        terminalReason = summaryFailure;
      }
      diagnostics.push(summaryFailure);
    }
  }

  return {
    runId: options.runId,
    role: options.role,
    scenarioId: options.scenario.id,
    scenarioName: options.scenario.name,
    status: terminalStatus,
    blockerType: classifyRoleRunBlocker(terminalStatus, verificationResults),
    terminalReason,
    steps,
    receipts,
    verificationResults,
    observations,
    summary,
    evidence,
    evidenceRefs: evidence.map(({ ref }) => ref),
    missingEvidenceKinds,
    unverifiedMeaningfulActions,
    helpQuestion,
    diagnostics,
  };
}
