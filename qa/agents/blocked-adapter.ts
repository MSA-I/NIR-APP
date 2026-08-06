import {
  QaModelBlockedError,
  redactAgentText,
  type ObservationInput,
  type QaModelAdapter,
  type RoleStepInput,
  type RoleSummaryInput,
} from './model-adapter.ts';

/**
 * Honest no-model behavior. The deterministic suite remains runnable, while every AI operation
 * fails as BLOCKED instead of being reported as a pass or replaced by fabricated output.
 */
export function createBlockedModelAdapter(reason: string): QaModelAdapter {
  const safeReason = redactAgentText(
    reason.trim() || 'QA model configuration is unavailable',
    1_000,
  );
  const blocked = async (): Promise<never> => {
    throw new QaModelBlockedError(safeReason);
  };

  return {
    provider: 'blocked',
    model: null,
    availability: { status: 'blocked', reason: safeReason },
    runRoleStep: (_input: RoleStepInput) => blocked(),
    analyzeObservation: (_input: ObservationInput) => blocked(),
    summarizeRole: (_input: RoleSummaryInput) => blocked(),
  };
}
