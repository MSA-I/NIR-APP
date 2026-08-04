import type { QaRole } from '../config/roles.ts';
import type { VisibleUiSnapshot } from '../browser/browser-tools.ts';
import type {
  AgentObservation,
  RoleStepDecision,
  RoleSummary,
} from './contracts.ts';

export type QaModelAvailability =
  | { readonly status: 'ready' }
  | { readonly status: 'blocked'; readonly reason: string };

export interface ModelScenarioProjection {
  readonly id: string;
  readonly name: string;
  readonly objective: string;
  readonly allowedRoutes: readonly string[];
  readonly allowedFixtureNames: readonly string[];
  readonly allowedVerificationChecks: readonly string[];
  readonly evidenceRequirements: readonly string[];
}

export interface ModelStepReceipt {
  readonly step: number;
  readonly actionType: string;
  readonly status: 'completed' | 'failed' | 'denied';
  readonly summary: string;
  readonly verificationStatus: 'verified' | 'failed' | 'blocked' | 'not_requested';
  readonly evidenceRefs: readonly string[];
}

export interface RoleStepInput {
  readonly runId: string;
  readonly role: QaRole;
  readonly roleInstructions: string;
  readonly scenario: ModelScenarioProjection;
  readonly currentStep: number;
  readonly maxSteps: number;
  readonly remainingSteps: number;
  readonly maxRetries: number;
  /** Browser-produced, redacted and visible-only data. It is always untrusted model input. */
  readonly visibleUiSnapshot: VisibleUiSnapshot;
  readonly recentReceipts: readonly ModelStepReceipt[];
  readonly availableBrowserActions: readonly string[];
}

export interface ObservationInput {
  readonly runId: string;
  readonly role: QaRole;
  readonly roleInstructions: string;
  readonly scenario: ModelScenarioProjection;
  readonly step: number;
  /** Browser-produced, redacted and visible-only data. It is always untrusted model input. */
  readonly visibleUiSnapshot: VisibleUiSnapshot;
  readonly actionReceipt: ModelStepReceipt;
}

export interface RoleSummaryInput {
  readonly runId: string;
  readonly role: QaRole;
  readonly roleInstructions: string;
  readonly scenario: ModelScenarioProjection;
  readonly terminalStatus: 'completed' | 'blocked' | 'failed' | 'step_limit';
  readonly terminalReason: string;
  readonly receipts: readonly ModelStepReceipt[];
  readonly observations: readonly AgentObservation[];
  readonly unverifiedMeaningfulActions: number;
}

/**
 * Provider-neutral model boundary. Implementations receive structured, provider-safe projections
 * only. They never receive browser objects, credentials, database handles or arbitrary tools.
 */
export interface QaModelAdapter {
  readonly provider: string;
  readonly model: string | null;
  readonly availability: QaModelAvailability;
  runRoleStep(input: RoleStepInput): Promise<RoleStepDecision>;
  analyzeObservation(input: ObservationInput): Promise<AgentObservation[]>;
  summarizeRole(input: RoleSummaryInput): Promise<RoleSummary>;
}

export type QaModelErrorCode =
  | 'model_blocked'
  | 'model_timeout'
  | 'model_rate_limited'
  | 'model_unavailable'
  | 'model_rejected'
  | 'model_output_truncated'
  | 'model_invalid_output';

export class QaModelError extends Error {
  readonly code: QaModelErrorCode;
  readonly retryable: boolean;
  readonly safeRawResponse: string | null;

  constructor(
    code: QaModelErrorCode,
    options: {
      retryable: boolean;
      safeRawResponse?: string | null;
      cause?: unknown;
    },
  ) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'QaModelError';
    this.code = code;
    this.retryable = options.retryable;
    this.safeRawResponse = options.safeRawResponse ?? null;
  }
}

export class QaModelBlockedError extends QaModelError {
  readonly reason: string;

  constructor(reason: string) {
    super('model_blocked', { retryable: false });
    this.name = 'QaModelBlockedError';
    this.reason = reason;
  }
}

const REDACTION_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_API_KEY]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]'],
  [/\b(?:\d[ -]?){12,19}\b/g, '[REDACTED_ACCOUNT_NUMBER]'],
];

export function redactAgentText(value: string, maxLength = 16_000): string {
  let redacted = value;
  for (const [pattern, replacement] of REDACTION_RULES) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted.length <= maxLength
    ? redacted
    : `${redacted.slice(0, maxLength)}\n[TRUNCATED]`;
}

export function safeAgentErrorMessage(error: unknown): string {
  if (error instanceof QaModelBlockedError) return redactAgentText(error.reason, 1_000);
  if (error instanceof QaModelError) return error.code;
  if (error instanceof Error) return redactAgentText(error.message, 1_000);
  return 'unknown_agent_error';
}
