import type { SafeBrowserTools } from '../browser/browser-tools.ts';
import type { QaRole } from '../config/roles.ts';
import type { AgentEvidence, AgentScenarioContext } from './contracts.ts';
import type { QaModelAdapter } from './model-adapter.ts';
import {
  blockedRoleRunResult,
  runRoleAgent,
  type RoleRunResult,
} from './role-agent.ts';
import type { VerifierAgent } from './verifier-agent.ts';

export const DEFAULT_CROSS_ROLE_ORDER: readonly QaRole[] = [
  'supplier',
  'kitchen',
  'office',
  'owner',
  'payer',
  'accountant',
];

export interface OrchestratedRoleAssignment {
  readonly role: QaRole;
  readonly scenario: AgentScenarioContext;
  readonly browserTools: SafeBrowserTools;
  readonly maxSteps?: number;
  readonly maxRetries?: number;
  readonly analyzeAfterActions?: boolean;
  readonly initialEvidence?: readonly AgentEvidence[];
  readonly collectEvidence?: () => Promise<readonly AgentEvidence[]>;
}

export interface RolePreparationContext {
  readonly runId: string;
  readonly assignment: OrchestratedRoleAssignment;
  /** Trusted orchestration context only. It is never forwarded to a role model. */
  readonly completedRoleResults: readonly RoleRunResult[];
}

export type RolePreparationResult =
  | { readonly status: 'ready' }
  | { readonly status: 'blocked'; readonly reason: string };

export interface QaAgentOrchestratorOptions {
  readonly runId: string;
  readonly modelAdapter: QaModelAdapter;
  readonly verifierAgent?: VerifierAgent;
  readonly assignments: readonly OrchestratedRoleAssignment[];
  readonly defaultMaxSteps?: number;
  readonly defaultMaxRetries?: number;
  readonly retryDelayMs?: number;
  readonly stopOnFailure?: boolean;
  readonly beforeRole?: (
    context: RolePreparationContext,
  ) => Promise<RolePreparationResult>;
  readonly afterRole?: (
    context: RolePreparationContext & { readonly result: RoleRunResult },
  ) => Promise<void>;
}

export interface QaAgentOrchestratorResult {
  readonly runId: string;
  readonly status: 'completed' | 'partial' | 'blocked' | 'failed';
  readonly provider: string;
  readonly model: string | null;
  readonly roleResults: readonly RoleRunResult[];
  readonly roleOrder: readonly QaRole[];
  readonly statistics: {
    readonly assigned: number;
    readonly completed: number;
    readonly blocked: number;
    readonly failed: number;
    readonly stepLimit: number;
    readonly observations: number;
    readonly verifiedChecks: number;
    readonly unverifiedMeaningfulActions: number;
  };
  readonly diagnostics: readonly string[];
}

function blockedAssignment(
  options: QaAgentOrchestratorOptions,
  assignment: OrchestratedRoleAssignment,
  reason: string,
): RoleRunResult {
  return blockedRoleRunResult({
    runId: options.runId,
    role: assignment.role,
    scenario: assignment.scenario,
    reason,
  });
}

/**
 * Runs role assignments strictly in the supplied order. A role agent can request help or return a
 * result, but cannot instantiate, authenticate or hand control to another role. Fixture/auth/DB
 * work stays in trusted orchestration hooks and verifier callbacks outside the role model.
 */
export async function runQaAgentOrchestrator(
  options: QaAgentOrchestratorOptions,
): Promise<QaAgentOrchestratorResult> {
  if (!options.runId.trim()) throw new Error('QA agent runId is required');
  if (options.assignments.length === 0) throw new Error('At least one role assignment is required');

  const roleResults: RoleRunResult[] = [];
  const diagnostics: string[] = [];
  let stopReason: string | null = null;

  for (const assignment of options.assignments) {
    if (stopReason) {
      roleResults.push(blockedAssignment(options, assignment, stopReason));
      continue;
    }

    if (assignment.scenario.definition.status === 'BLOCKED') {
      roleResults.push(blockedAssignment(
        options,
        assignment,
        assignment.scenario.definition.blockedReason ?? 'scenario_is_blocked',
      ));
      continue;
    }
    if (!assignment.scenario.definition.roles.includes(assignment.role)
      && !assignment.scenario.definition.roles.includes('all')) {
      roleResults.push(blockedAssignment(options, assignment, 'role_not_assigned_to_scenario'));
      continue;
    }

    const preparationContext: RolePreparationContext = {
      runId: options.runId,
      assignment,
      completedRoleResults: Object.freeze([...roleResults]),
    };
    if (options.beforeRole) {
      let preparation: RolePreparationResult;
      try {
        preparation = await options.beforeRole(preparationContext);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'role_preparation_failed';
        diagnostics.push(`beforeRole:${assignment.role}:${message}`);
        const result = {
          ...blockedAssignment(options, assignment, 'role_preparation_failed'),
          status: 'failed' as const,
          terminalReason: 'role_preparation_failed',
        };
        roleResults.push(result);
        if (options.stopOnFailure ?? true) stopReason = 'not_run_after_prior_role_failure';
        continue;
      }
      if (preparation.status === 'blocked') {
        roleResults.push(blockedAssignment(options, assignment, preparation.reason));
        continue;
      }
    }

    const result = await runRoleAgent({
      runId: options.runId,
      role: assignment.role,
      scenario: assignment.scenario,
      browserTools: assignment.browserTools,
      modelAdapter: options.modelAdapter,
      verifierAgent: options.verifierAgent,
      maxSteps: assignment.maxSteps
        ?? options.defaultMaxSteps
        ?? assignment.scenario.definition.maxAgentSteps,
      maxRetries: assignment.maxRetries
        ?? options.defaultMaxRetries
        ?? assignment.scenario.definition.maxRetries,
      analyzeAfterActions: assignment.analyzeAfterActions,
      retryDelayMs: options.retryDelayMs,
      initialEvidence: assignment.initialEvidence,
      collectEvidence: assignment.collectEvidence,
    });
    roleResults.push(result);

    if (options.afterRole) {
      try {
        await options.afterRole({ ...preparationContext, result });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'after_role_hook_failed';
        diagnostics.push(`afterRole:${assignment.role}:${message}`);
        if (options.stopOnFailure ?? true) stopReason = 'not_run_after_after_role_failure';
      }
    }
    if ((options.stopOnFailure ?? true)
      && (result.status === 'failed' || result.status === 'step_limit')) {
      stopReason = 'not_run_after_prior_role_failure';
    }
  }

  const completed = roleResults.filter(({ status }) => status === 'completed').length;
  const blocked = roleResults.filter(({ status }) => status === 'blocked').length;
  const failed = roleResults.filter(({ status }) => status === 'failed').length;
  const stepLimit = roleResults.filter(({ status }) => status === 'step_limit').length;
  const status: QaAgentOrchestratorResult['status'] = failed > 0 || stepLimit > 0
    ? 'failed'
    : completed === roleResults.length
    ? 'completed'
    : completed === 0 && blocked === roleResults.length
    ? 'blocked'
    : 'partial';

  return {
    runId: options.runId,
    status,
    provider: options.modelAdapter.provider,
    model: options.modelAdapter.model,
    roleResults,
    roleOrder: options.assignments.map(({ role }) => role),
    statistics: {
      assigned: options.assignments.length,
      completed,
      blocked,
      failed,
      stepLimit,
      observations: roleResults.reduce((sum, result) => sum + result.observations.length, 0),
      verifiedChecks: roleResults.reduce(
        (sum, result) => sum + result.verificationResults.filter(
          ({ result: verification }) => verification.status === 'verified',
        ).length,
        0,
      ),
      unverifiedMeaningfulActions: roleResults.reduce(
        (sum, result) => sum + result.unverifiedMeaningfulActions,
        0,
      ),
    },
    diagnostics,
  };
}
