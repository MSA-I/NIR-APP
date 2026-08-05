import { z } from 'zod';
import type { QaRole } from '../config/roles.ts';
import { AgentObservationSchema, type AgentObservation } from './contracts.ts';

export const ObjectiveFindingEvidenceSchema = z.object({
  id: z.string().trim().min(1).max(200),
  source: z.enum([
    'playwright',
    'database',
    'api',
    'audit',
    'network',
    'console',
    'accessibility',
    'export',
    'human',
  ]),
  verified: z.boolean(),
  supportsObservation: z.boolean(),
  summary: z.string().trim().min(1).max(4_000),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).nullable(),
  evidenceRefs: z.array(z.string().trim().min(1).max(500)).max(100),
}).strict();

export type ObjectiveFindingEvidence = z.infer<typeof ObjectiveFindingEvidenceSchema>;

export const FindingReviewInputSchema = z.object({
  role: z.enum(['owner', 'office', 'kitchen', 'payer', 'accountant', 'supplier']),
  scenarioId: z.string().trim().min(1).max(200),
  observation: AgentObservationSchema,
  repeatCount: z.number().int().min(1).max(100),
  objectiveEvidence: z.array(ObjectiveFindingEvidenceSchema).max(100),
  blockedReason: z.string().trim().min(1).max(2_000).nullable(),
}).strict();

export interface FindingReviewInput {
  readonly role: QaRole;
  readonly scenarioId: string;
  readonly observation: AgentObservation;
  readonly repeatCount: number;
  readonly objectiveEvidence: readonly ObjectiveFindingEvidence[];
  readonly blockedReason: string | null;
}

export const ReviewedAgentFindingSchema = z.object({
  role: z.enum(['owner', 'office', 'kitchen', 'payer', 'accountant', 'supplier']),
  scenarioId: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(500),
  category: AgentObservationSchema.shape.category,
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  status: z.enum(['observation', 'probable', 'confirmed', 'blocked', 'false_positive']),
  confidence: z.number().min(0).max(1),
  observation: AgentObservationSchema,
  objectiveEvidence: z.array(ObjectiveFindingEvidenceSchema).max(100),
  evidenceRefs: z.array(z.string().trim().min(1).max(500)).max(200),
  reviewSummary: z.string().trim().min(1).max(4_000),
  humanReviewRequired: z.boolean(),
}).strict();

export type ReviewedAgentFinding = z.infer<typeof ReviewedAgentFindingSchema>;

const severityRank = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
} as const;

type Severity = keyof typeof severityRank;

function strongestSeverity(values: readonly Severity[]): Severity {
  return values.reduce<Severity>(
    (strongest, value) => severityRank[value] > severityRank[strongest] ? value : strongest,
    'info',
  );
}

/**
 * AI output starts as an observation. It becomes confirmed only when at least one independent,
 * verified evidence source supports it. Repetition by AI alone can raise it to probable, never to
 * confirmed, high or critical.
 */
export function reviewAgentFinding(input: FindingReviewInput): ReviewedAgentFinding {
  const parsed = FindingReviewInputSchema.parse(input);
  const supporting = parsed.objectiveEvidence.filter(
    (evidence) => evidence.verified && evidence.supportsObservation,
  );
  const contradicting = parsed.objectiveEvidence.filter(
    (evidence) => evidence.verified && !evidence.supportsObservation,
  );

  let status: ReviewedAgentFinding['status'];
  let confidence: number;
  let reviewSummary: string;
  if (parsed.blockedReason) {
    status = 'blocked';
    confidence = 1;
    reviewSummary = `האימות נחסם: ${parsed.blockedReason}`;
  } else if (supporting.length > 0) {
    status = 'confirmed';
    confidence = contradicting.length > 0 ? 0.75 : Math.min(0.99, 0.85 + supporting.length * 0.04);
    reviewSummary = contradicting.length > 0
      ? 'הממצא נתמך בראיה עצמאית, אך קיימת גם ראיה סותרת ודורש הכרעה אנושית.'
      : 'הממצא אושר באמצעות ראיה עצמאית מאומתת.';
  } else if (contradicting.length > 0) {
    status = 'false_positive';
    confidence = Math.min(0.99, 0.8 + contradicting.length * 0.05);
    reviewSummary = 'ראיה עצמאית מאומתת סותרת את תצפית הסוכן.';
  } else if (parsed.repeatCount >= 2) {
    status = 'probable';
    confidence = Math.min(0.79, 0.55 + parsed.repeatCount * 0.05);
    reviewSummary = 'התצפית חזרה, אך טרם קיבלה אימות אובייקטיבי עצמאי.';
  } else {
    status = 'observation';
    confidence = 0.4;
    reviewSummary = 'זוהי תצפית חקרנית יחידה ללא אימות אובייקטיבי עצמאי.';
  }

  const evidenceSeverity = supporting
    .map(({ severity }) => severity)
    .filter((severity): severity is Severity => severity !== null);
  const severity = status === 'confirmed'
    ? strongestSeverity([parsed.observation.severityHint, ...evidenceSeverity])
    : status === 'false_positive' || status === 'blocked'
    ? 'info'
    : parsed.observation.severityHint;
  const evidenceRefs = [...new Set([
    ...parsed.observation.evidenceRefs,
    ...parsed.objectiveEvidence.flatMap((evidence) => evidence.evidenceRefs),
  ])];

  return ReviewedAgentFindingSchema.parse({
    role: parsed.role,
    scenarioId: parsed.scenarioId,
    title: parsed.observation.title,
    category: parsed.observation.category,
    severity,
    status,
    confidence,
    observation: parsed.observation,
    objectiveEvidence: parsed.objectiveEvidence,
    evidenceRefs,
    reviewSummary,
    humanReviewRequired:
      parsed.observation.humanReviewRequired
      || status === 'observation'
      || status === 'probable'
      || contradicting.length > 0,
  });
}

export function reviewAgentFindings(
  inputs: readonly FindingReviewInput[],
): ReviewedAgentFinding[] {
  return inputs.map(reviewAgentFinding);
}
