import { z } from 'zod';

export const QaRoleSchema = z.enum([
  'owner',
  'office',
  'kitchen',
  'payer',
  'accountant',
  'supplier',
  'platform',
  'all',
]);
export type QaRole = z.infer<typeof QaRoleSchema>;

export const ScenarioIdSchema = z.enum([
  'supplier-price-list',
  'kitchen-receiving',
  'office-invoice-review',
  'owner-payment-approval',
  'payer-transfer-execution',
  'accountant-reconciliation',
  'authorization-matrix',
  'platform-admin',
  'accessibility-keyboard',
]);
export type ScenarioId = z.infer<typeof ScenarioIdSchema>;

export const EvidenceKindSchema = z.enum([
  'screenshot',
  'action-trace',
  'console',
  'network',
  'database',
  'audit',
  'download',
  'accessibility',
]);

export const FixtureKindSchema = z.enum([
  'demo-seed',
  'bank-csv',
  'price-list-xlsx',
  'invoice-pdf',
  'receipt-jpg',
  'platform-admin-auth',
]);

export const RouteExpectationSchema = z.object({
  role: QaRoleSchema.exclude(['all']),
  allowed: z.array(z.string().startsWith('/')).default([]),
  forbidden: z.array(z.string().startsWith('/')).default([]),
}).strict();

export const ScenarioStepSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  actorRole: QaRoleSchema.exclude(['all']),
  route: z.string().startsWith('/'),
  action: z.string().min(1),
  expected: z.string().min(1),
  verifierIds: z.array(z.string().regex(/^[a-z0-9-]+$/)).min(1),
  mutatesData: z.boolean(),
}).strict();
export type ScenarioStep = z.infer<typeof ScenarioStepSchema>;

export const ScenarioDefinitionSchema = z.object({
  id: ScenarioIdSchema,
  sequence: z.number().int().min(1).max(9),
  title: z.string().min(1),
  purpose: z.string().min(1),
  roles: z.array(QaRoleSchema).min(1),
  status: z.enum(['READY', 'BLOCKED']),
  blockedReason: z.string().min(1).optional(),
  viewport: z.enum(['desktop', 'mobile', 'both']),
  fixtures: z.array(FixtureKindSchema),
  dependsOn: z.array(ScenarioIdSchema),
  routeExpectations: z.array(RouteExpectationSchema),
  steps: z.array(ScenarioStepSchema).min(1),
  verifierIds: z.array(z.string().regex(/^[a-z0-9-]+$/)).min(1),
  evidence: z.array(EvidenceKindSchema).min(1),
  maxAgentSteps: z.number().int().min(1).max(60).default(30),
  maxRetries: z.number().int().min(0).max(3).default(2),
}).strict().superRefine((scenario, context) => {
  if (scenario.status === 'BLOCKED' && !scenario.blockedReason) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['blockedReason'], message: 'BLOCKED requires a reason.' });
  }
  if (scenario.status === 'READY' && scenario.blockedReason) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['blockedReason'], message: 'READY cannot have a blocked reason.' });
  }
  const stepIds = scenario.steps.map((step) => step.id);
  if (new Set(stepIds).size !== stepIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['steps'], message: 'Step ids must be unique.' });
  }
});

export type ScenarioDefinition = z.infer<typeof ScenarioDefinitionSchema>;
