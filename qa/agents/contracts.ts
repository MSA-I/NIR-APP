import { z } from 'zod';
import type { QaRole } from '../config/roles.ts';
import type { ScenarioDefinition } from '../scenarios/schema.ts';

const shortText = z.string().trim().min(1).max(500);
const longText = z.string().trim().min(1).max(4_000);
const nullableLongText = z.string().trim().max(4_000).nullable();
const evidenceRef = z.string().trim().min(1).max(500);

export const AgentObservationSchema = z.object({
  title: shortText,
  category: z.enum([
    'functional',
    'authorization',
    'security',
    'data_integrity',
    'accessibility',
    'usability',
    'visual',
    'performance',
    'resilience',
    'copy',
    'rtl',
    'infrastructure',
  ]),
  severityHint: z.enum(['info', 'low', 'medium']),
  description: longText,
  expected: nullableLongText,
  actual: nullableLongText,
  route: z.string().trim().max(500).nullable(),
  reproductionSteps: z.array(shortText).max(30),
  evidenceRefs: z.array(evidenceRef).max(50),
  humanReviewRequired: z.boolean(),
}).strict();

export type AgentObservation = z.infer<typeof AgentObservationSchema>;

export const AgentEvidenceSchema = z.object({
  kind: z.enum([
    'screenshot',
    'action-trace',
    'console',
    'network',
    'database',
    'audit',
    'download',
    'accessibility',
  ]),
  ref: evidenceRef,
  source: z.enum(['browser', 'verifier', 'orchestrator']),
}).strict();

export type AgentEvidence = z.infer<typeof AgentEvidenceSchema>;

export const VerificationRequestSchema = z.object({
  checkId: z.string().trim().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/),
  purpose: shortText,
  expectedOutcome: longText,
  entityRefs: z.array(z.object({
    kind: z.string().trim().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/),
    visibleReference: z.string().trim().min(1).max(300),
  }).strict()).max(20),
}).strict();

export type VerificationRequest = z.infer<typeof VerificationRequestSchema>;

export const SafeBrowserTargetSchema = z.object({
  kind: z.enum(['role', 'label', 'text']),
  role: z.enum([
    'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'option',
    'menuitem', 'tab', 'heading',
  ]).nullable(),
  name: z.string().trim().max(300).nullable(),
  label: z.string().trim().max(300).nullable(),
  text: z.string().trim().max(300).nullable(),
  exact: z.boolean(),
}).strict().superRefine((target, context) => {
  const required = target.kind === 'role' ? ['role', 'name'] as const
    : target.kind === 'label' ? ['label'] as const
    : ['text'] as const;
  for (const field of required) {
    if (!target[field]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} is required for target kind ${target.kind}`,
      });
    }
  }
});

export type SafeBrowserTargetDecision = z.infer<typeof SafeBrowserTargetSchema>;

export const SafeBrowserActionSchema = z.object({
  type: z.enum([
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
  ]),
  route: z.string().trim().max(500).nullable(),
  target: SafeBrowserTargetSchema.nullable(),
  value: z.string().max(4_000).nullable(),
  fixtureName: z.string().trim().max(200).nullable(),
  key: z.enum([
    'Enter',
    'Tab',
    'Escape',
    'Space',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
  ]).nullable(),
  direction: z.enum(['up', 'down']).nullable(),
  text: z.string().trim().max(1_000).nullable(),
  label: z.string().trim().max(200).nullable(),
}).strict().superRefine((action, context) => {
  const required: Partial<Record<typeof action.type, keyof typeof action>> = {
    open: 'route',
    click: 'target',
    fill: 'target',
    select: 'target',
    upload: 'target',
    press: 'key',
    scroll: 'direction',
    wait_for_text: 'text',
    screenshot: 'label',
  };
  const field = required[action.type];
  if (field && (action[field] === null || action[field] === '')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [field],
      message: `${String(field)} is required for ${action.type}`,
    });
  }
  if ((action.type === 'fill' || action.type === 'select') && action.value === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['value'],
      message: `value is required for ${action.type}`,
    });
  }
  if (action.type === 'upload' && !action.fixtureName) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['fixtureName'],
      message: 'fixtureName is required for upload',
    });
  }
});

export type SafeBrowserAction = z.infer<typeof SafeBrowserActionSchema>;

export const RoleStepDecisionSchema = z.object({
  decision: z.enum(['action', 'request_help', 'finish']),
  reason: longText,
  action: SafeBrowserActionSchema.nullable(),
  expectedObservation: nullableLongText,
  meaningfulBusinessAction: z.boolean(),
  verification: VerificationRequestSchema.nullable(),
  observations: z.array(AgentObservationSchema).max(20),
  helpQuestion: nullableLongText,
  finishStatus: z.enum(['completed', 'blocked', 'failed']).nullable(),
  finishSummary: nullableLongText,
}).strict().superRefine((decision, context) => {
  if (decision.decision === 'action' && decision.action === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['action'],
      message: 'action is required for an action decision',
    });
  }
  if (decision.decision === 'request_help' && !decision.helpQuestion) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['helpQuestion'],
      message: 'helpQuestion is required when requesting help',
    });
  }
  if (decision.decision === 'finish' && (!decision.finishStatus || !decision.finishSummary)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['finishStatus'],
      message: 'finishStatus and finishSummary are required when finishing',
    });
  }
  if (decision.verification && !decision.meaningfulBusinessAction) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['verification'],
      message: 'verification may only accompany a meaningful business action',
    });
  }
});

export type RoleStepDecision = z.infer<typeof RoleStepDecisionSchema>;

export const ObservationAnalysisSchema = z.object({
  observations: z.array(AgentObservationSchema).max(30),
}).strict();

export const RoleSummarySchema = z.object({
  status: z.enum(['completed', 'blocked', 'failed']),
  executiveSummary: longText,
  completedGoals: z.array(shortText).max(30),
  blockedGoals: z.array(shortText).max(30),
  observations: z.array(AgentObservationSchema).max(50),
  evidenceRefs: z.array(evidenceRef).max(100),
  humanReviewRequired: z.boolean(),
}).strict();

export type RoleSummary = z.infer<typeof RoleSummarySchema>;

/**
 * ScenarioDefinition remains the registry's source of truth. These fields are the explicit,
 * provider-safe projection used by the exploratory agent; no callbacks, credentials or fixture
 * preparation details from the registry definition are sent to a model.
 */
export interface AgentScenarioContext {
  readonly definition: ScenarioDefinition;
  readonly id: string;
  readonly name: string;
  readonly objective: string;
  readonly allowedRoutes: readonly string[];
  readonly allowedFixtureNames: readonly string[];
  readonly allowedVerificationChecks: readonly string[];
  readonly evidenceRequirements: readonly string[];
}

export function createAgentScenarioContext(
  definition: ScenarioDefinition,
  role: QaRole,
): AgentScenarioContext {
  const expectations = definition.routeExpectations.filter(
    (expectation) => expectation.role === role,
  );
  const stepRoutes = definition.steps
    .filter((step) => step.actorRole === role)
    .map((step) => step.route);
  const allowedRoutes = new Set<string>([
    // Keep exploratory navigation on the routes needed by this concrete scenario. The broader
    // role capability matrix belongs to deterministic authorization tests, not an open-ended AI
    // browsing budget. Dashboard is retained for initial-route checks.
    ...expectations.flatMap((expectation) => expectation.allowed)
      .filter((route) => route === '/dashboard' || stepRoutes.includes(route)),
    // Forbidden routes are deliberately browser-allowlisted only so the role can verify that the
    // application denies them. SafeBrowserTools still blocks every route outside this scenario.
    ...expectations.flatMap((expectation) => expectation.forbidden),
    ...stepRoutes,
  ]);
  return {
    definition,
    id: definition.id,
    name: definition.title,
    objective: definition.purpose,
    allowedRoutes: [...allowedRoutes],
    allowedFixtureNames: [...definition.fixtures],
    allowedVerificationChecks: [...definition.verifierIds],
    evidenceRequirements: [...definition.evidence],
  };
}

export interface AgentRoleContext {
  readonly role: QaRole;
  readonly description: string;
  readonly allowedBusinessGoals: readonly string[];
  readonly expectedRoutes: readonly string[];
  readonly forbiddenActions: readonly string[];
}

export const SAFE_BROWSER_ACTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: {
      type: 'string',
      enum: [
        'open', 'snapshot', 'click', 'fill', 'select', 'upload', 'press',
        'scroll', 'wait_for_text', 'screenshot', 'current_url',
      ],
    },
    route: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    target: {
      anyOf: [{
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['role', 'label', 'text'] },
          role: {
            anyOf: [{
              type: 'string',
              enum: [
                'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
                'option', 'menuitem', 'tab', 'heading',
              ],
            }, { type: 'null' }],
          },
          name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          label: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          text: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          exact: { type: 'boolean' },
        },
        required: ['kind', 'role', 'name', 'label', 'text', 'exact'],
      }, { type: 'null' }],
    },
    value: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    fixtureName: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    key: {
      anyOf: [{
        type: 'string',
        enum: [
          'Enter', 'Tab', 'Escape', 'Space', 'ArrowUp', 'ArrowDown',
          'ArrowLeft', 'ArrowRight', 'Home', 'End',
        ],
      }, { type: 'null' }],
    },
    direction: { anyOf: [{ type: 'string', enum: ['up', 'down'] }, { type: 'null' }] },
    text: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    label: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: [
    'type', 'route', 'target', 'value', 'fixtureName', 'key', 'direction',
    'text', 'label',
  ],
} as const;

export const AGENT_OBSERVATION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    category: {
      type: 'string',
      enum: [
        'functional', 'authorization', 'security', 'data_integrity',
        'accessibility', 'usability', 'visual', 'performance', 'resilience',
        'copy', 'rtl', 'infrastructure',
      ],
    },
    severityHint: { type: 'string', enum: ['info', 'low', 'medium'] },
    description: { type: 'string' },
    expected: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    actual: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    route: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    reproductionSteps: { type: 'array', items: { type: 'string' } },
    evidenceRefs: { type: 'array', items: { type: 'string' } },
    humanReviewRequired: { type: 'boolean' },
  },
  required: [
    'title', 'category', 'severityHint', 'description', 'expected', 'actual',
    'route', 'reproductionSteps', 'evidenceRefs', 'humanReviewRequired',
  ],
} as const;

export const VERIFICATION_REQUEST_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    checkId: { type: 'string' },
    purpose: { type: 'string' },
    expectedOutcome: { type: 'string' },
    entityRefs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string' },
          visibleReference: { type: 'string' },
        },
        required: ['kind', 'visibleReference'],
      },
    },
  },
  required: ['checkId', 'purpose', 'expectedOutcome', 'entityRefs'],
} as const;

export const ROLE_STEP_DECISION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    decision: { type: 'string', enum: ['action', 'request_help', 'finish'] },
    reason: { type: 'string' },
    action: { anyOf: [SAFE_BROWSER_ACTION_JSON_SCHEMA, { type: 'null' }] },
    expectedObservation: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    meaningfulBusinessAction: { type: 'boolean' },
    verification: { anyOf: [VERIFICATION_REQUEST_JSON_SCHEMA, { type: 'null' }] },
    observations: { type: 'array', items: AGENT_OBSERVATION_JSON_SCHEMA },
    helpQuestion: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    finishStatus: {
      anyOf: [{ type: 'string', enum: ['completed', 'blocked', 'failed'] }, { type: 'null' }],
    },
    finishSummary: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: [
    'decision', 'reason', 'action', 'expectedObservation',
    'meaningfulBusinessAction', 'verification', 'observations', 'helpQuestion',
    'finishStatus', 'finishSummary',
  ],
} as const;

export const OBSERVATION_ANALYSIS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    observations: { type: 'array', items: AGENT_OBSERVATION_JSON_SCHEMA },
  },
  required: ['observations'],
} as const;

export const ROLE_SUMMARY_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['completed', 'blocked', 'failed'] },
    executiveSummary: { type: 'string' },
    completedGoals: { type: 'array', items: { type: 'string' } },
    blockedGoals: { type: 'array', items: { type: 'string' } },
    observations: { type: 'array', items: AGENT_OBSERVATION_JSON_SCHEMA },
    evidenceRefs: { type: 'array', items: { type: 'string' } },
    humanReviewRequired: { type: 'boolean' },
  },
  required: [
    'status', 'executiveSummary', 'completedGoals', 'blockedGoals',
    'observations', 'evidenceRefs', 'humanReviewRequired',
  ],
} as const;
