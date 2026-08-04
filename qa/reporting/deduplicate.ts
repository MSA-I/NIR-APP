import { FindingSchema, type Finding } from './schemas.ts';

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function mergeEvidence(left: Finding['evidence'], right: Finding['evidence']): Finding['evidence'] {
  return {
    screenshots: unique([...(left.screenshots ?? []), ...(right.screenshots ?? [])]),
    trace: left.trace ?? right.trace,
    console: unique([...(left.console ?? []), ...(right.console ?? [])]),
    network: unique([...(left.network ?? []), ...(right.network ?? [])]),
    database: unique([...(left.database ?? []), ...(right.database ?? [])]),
    accessibility: unique([...(left.accessibility ?? []), ...(right.accessibility ?? [])]),
    downloads: unique([...(left.downloads ?? []), ...(right.downloads ?? [])]),
    actionTrace: left.actionTrace ?? right.actionTrace,
  };
}

export function deduplicateFindings(findings: readonly Finding[]): Finding[] {
  const merged = new Map<string, Finding>();
  for (const finding of findings) {
    const current = merged.get(finding.fingerprint);
    if (!current) {
      merged.set(finding.fingerprint, finding);
      continue;
    }
    merged.set(finding.fingerprint, FindingSchema.parse({
      ...current,
      role: current.role,
      affectedRoles: unique([...current.affectedRoles, current.role, ...finding.affectedRoles, finding.role]),
      affectedScenarios: unique([
        ...current.affectedScenarios,
        current.scenarioId,
        ...finding.affectedScenarios,
        finding.scenarioId,
      ]),
      reproductionSteps: unique([...current.reproductionSteps, ...finding.reproductionSteps]),
      evidence: mergeEvidence(current.evidence, finding.evidence),
      reproductionCount: current.reproductionCount + finding.reproductionCount,
      firstOccurrence: current.firstOccurrence < finding.firstOccurrence ? current.firstOccurrence : finding.firstOccurrence,
      latestOccurrence: current.latestOccurrence > finding.latestOccurrence ? current.latestOccurrence : finding.latestOccurrence,
      confidence: Math.max(current.confidence, finding.confidence),
      humanReviewRequired: current.humanReviewRequired || finding.humanReviewRequired,
    }));
  }
  return [...merged.values()];
}

