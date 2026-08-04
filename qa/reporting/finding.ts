import { createHash, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  FindingCategorySchema,
  FindingSchema,
  type Finding,
  type Severity,
} from './schemas.ts';

export interface FindingDraft {
  runId: string;
  source: Finding['source'];
  role: string;
  scenarioId: string;
  scenarioName: string;
  route?: string;
  step?: number;
  title: string;
  category: z.infer<typeof FindingCategorySchema>;
  severity: Severity;
  confidence: number;
  reproducibility: Finding['reproducibility'];
  status: Finding['status'];
  expected?: string;
  actual?: string;
  userImpact: string;
  businessImpact?: string;
  reproductionSteps: string[];
  evidence: Finding['evidence'];
  recommendedFix?: string;
  humanReviewRequired: boolean;
  createdAt?: string;
}

function normalized(value: string | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, ':uuid')
    .replace(/\b\d{3,}\b/g, ':number')
    .replace(/\s+/g, ' ')
    .trim();
}

export function findingFingerprint(input: Pick<FindingDraft,
  'role' | 'scenarioId' | 'category' | 'route' | 'title' | 'actual'>): string {
  const source = [
    normalized(input.route?.split('?')[0]),
    normalized(input.role),
    normalized(input.scenarioId),
    normalized(input.category),
    normalized(input.title),
    normalized(input.actual),
  ].join('|');
  return createHash('sha256').update(source).digest('hex').slice(0, 32);
}

export function createFinding(draft: FindingDraft): Finding {
  const timestamp = draft.createdAt ?? new Date().toISOString();
  return FindingSchema.parse({
    ...draft,
    id: `finding-${randomUUID()}`,
    fingerprint: findingFingerprint(draft),
    createdAt: timestamp,
    affectedRoles: [draft.role],
    affectedScenarios: [draft.scenarioId],
    reproductionCount: 1,
    firstOccurrence: timestamp,
    latestOccurrence: timestamp,
  });
}

export function severityFor(category: FindingDraft['category'], impact: string): Severity {
  const text = impact.toLowerCase();
  if (category === 'authorization' || category === 'security') {
    if (/cross[- ]tenant|another supplier|service.?role|secret|unauthorized financial|rls bypass/.test(text)) return 'critical';
    return 'high';
  }
  if (category === 'data_integrity' && /wrong amount|duplicate payment|corrupt|wrong organization/.test(text)) return 'high';
  if (category === 'functional' && /cannot complete|core workflow|data loss/.test(text)) return 'high';
  if (category === 'accessibility' || category === 'resilience' || category === 'performance') return 'medium';
  if (category === 'visual' || category === 'copy' || category === 'rtl') return 'low';
  return 'info';
}

export function retryClassification(attempts: readonly boolean[]): Finding['reproducibility'] {
  if (attempts.length < 2) return attempts[0] === false ? 'not_retested' : 'single_observation';
  const failures = attempts.filter((passed) => !passed).length;
  if (failures === attempts.length) return 'persistent';
  return failures > 0 ? 'intermittent' : 'not_retested';
}

export function enforceAgentEvidence(finding: Finding): Finding {
  if (finding.source !== 'agent') return finding;
  const evidenceCount = Object.values(finding.evidence).reduce((count, value) => {
    if (Array.isArray(value)) return count + value.length;
    return count + (value ? 1 : 0);
  }, 0);
  if (evidenceCount > 0 && !['critical', 'high'].includes(finding.severity)) return finding;
  return FindingSchema.parse({
    ...finding,
    severity: evidenceCount === 0 ? 'info' : finding.severity,
    status: evidenceCount === 0 ? 'observation' : finding.status,
    humanReviewRequired: true,
  });
}

