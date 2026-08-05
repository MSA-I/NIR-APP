import type {
  CoverageException,
  Finding,
  RoleResult,
  RoleScore,
  RunReport,
  ScenarioResult,
} from './schemas.ts';

function countBy(values: readonly string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function percent(results: readonly ScenarioResult[]): number | null {
  const measured = results.filter((result) =>
    result.status !== 'SKIPPED_BY_CONFIGURATION' && result.status !== 'OPTIONAL_BLOCKED');
  if (!measured.length) return null;
  return Math.round((measured.filter((result) => result.status === 'PASSED').length / measured.length) * 100);
}

function subset(results: readonly ScenarioResult[], pattern: RegExp): ScenarioResult[] {
  return results.filter((result) => pattern.test(`${result.id} ${result.name}`));
}

export function roleScorecards(
  roles: readonly RoleResult[],
  scenarios: readonly ScenarioResult[],
  findings: readonly Finding[],
): RoleScore[] {
  return roles.map((role) => {
    const roleScenarios = scenarios.filter((scenario) => scenario.role === role.role);
    const roleFindings = findings.filter((finding) => finding.affectedRoles.includes(role.role) || finding.role === role.role);
    const critical = roleFindings.some((finding) => finding.status === 'confirmed' && finding.severity === 'critical');
    const high = roleFindings.some((finding) => finding.status === 'confirmed' && finding.severity === 'high');
    const status: RoleScore['status'] = critical
      ? 'BLOCKED_BY_CRITICAL'
      : high
        ? 'BLOCKED_BY_HIGH'
        : roleScenarios.some((scenario) =>
          scenario.status !== 'SKIPPED_BY_CONFIGURATION' && scenario.status !== 'OPTIONAL_BLOCKED')
          ? roleScenarios.some((scenario) => scenario.status !== 'PASSED') ? 'DEGRADED' : 'OK'
          : 'NO_EVIDENCE';
    return {
      role: role.role,
      status,
      coreTaskCompletion: percent(subset(roleScenarios, /core|workflow|flow|מסע/i)),
      correctPermissions: percent(subset(roleScenarios, /authorization|permission|הרשא/i)),
      errorRecovery: percent(subset(roleScenarios, /recovery|resilience|failure|retry|כשל/i)),
      accessibility: percent(subset(roleScenarios, /accessibility|keyboard|axe|נגיש/i)),
      mobileUsability: percent(subset(roleScenarios, /mobile|390|receiving|מובייל/i)),
      clarity: null,
      dataCorrectness: percent(subset(roleScenarios, /database|verifier|integrity|export|נתונ/i)),
      stability: percent(roleScenarios),
    };
  });
}

export function statistics(scenarios: readonly ScenarioResult[], findings: readonly Finding[]): RunReport['statistics'] {
  return {
    bySeverity: countBy(findings.map((finding) => finding.severity)),
    byCategory: countBy(findings.map((finding) => finding.category)),
    byStatus: countBy(findings.map((finding) => finding.status)),
    passedScenarios: scenarios.filter((scenario) => scenario.status === 'PASSED').length,
    failedScenarios: scenarios.filter((scenario) => scenario.status === 'FAILED').length,
    blockedScenarios: scenarios.filter((scenario) => scenario.status === 'BLOCKED').length,
    skippedScenarios: scenarios.filter((scenario) => scenario.status === 'SKIPPED_BY_CONFIGURATION').length,
    optionalBlockedScenarios: scenarios.filter((scenario) => scenario.status === 'OPTIONAL_BLOCKED').length,
    flakyScenarios: findings.filter((finding) => finding.reproducibility === 'intermittent').length,
  };
}

export function coverageExceptions(scenarios: readonly ScenarioResult[]): CoverageException[] {
  return scenarios.flatMap((scenario) => {
    if (scenario.status !== 'BLOCKED'
        && scenario.status !== 'SKIPPED_BY_CONFIGURATION'
        && scenario.status !== 'OPTIONAL_BLOCKED') return [];
    return [{
      id: scenario.id,
      name: scenario.name,
      role: scenario.role,
      reason: scenario.limitation?.trim()
        || scenario.steps.find((step) => step.status !== 'PASSED')?.message?.trim()
        || 'לא נרשמה סיבת ביצוע.',
      required: scenario.required,
      status: scenario.status,
      blockerType: scenario.blockerType
        ?? (scenario.status === 'BLOCKED' ? 'INFRASTRUCTURE' : 'CONFIGURATION'),
    }];
  });
}

export function exitDecision(
  scenarios: readonly ScenarioResult[],
  findings: readonly Finding[],
  failOnMedium: boolean,
): RunReport['exitDecision'] {
  const infrastructureFailures = scenarios.filter((scenario) =>
    scenario.required && scenario.status === 'FAILED' && scenario.blockerType === 'INFRASTRUCTURE');
  const executionBlockers = scenarios.filter((scenario) =>
    scenario.required
      && ['BLOCKED', 'SKIPPED_BY_CONFIGURATION', 'OPTIONAL_BLOCKED'].includes(scenario.status)
      && scenario.blockerType !== 'PRODUCT');
  const productScenarioFailures = scenarios.filter((scenario) =>
    (scenario.status === 'FAILED' && scenario.blockerType !== 'INFRASTRUCTURE')
      || (scenario.status === 'BLOCKED' && scenario.blockerType === 'PRODUCT'));
  const highFindings = findings.filter((finding) =>
    finding.status === 'confirmed' && ['critical', 'high'].includes(finding.severity));
  const mediumGateFindings = failOnMedium
    ? findings.filter((finding) => finding.status === 'confirmed' && finding.severity === 'medium')
    : [];

  const runStatus = infrastructureFailures.length
    ? 'INFRASTRUCTURE_FAILED' as const
    : executionBlockers.length
      ? 'BLOCKED' as const
      : 'COMPLETED' as const;
  const productQualityStatus = productScenarioFailures.length || highFindings.length || mediumGateFindings.length
    ? 'FAIL' as const
    : findings.some((finding) => finding.status !== 'false_positive')
      ? 'PASS_WITH_FINDINGS' as const
      : 'PASS' as const;
  const reasons = [
    ...infrastructureFailures.map((scenario) => `כשל תשתית: ${scenario.id}`),
    ...executionBlockers.map((scenario) => `כיסוי חובה נחסם: ${scenario.id}`),
    ...productScenarioFailures.map((scenario) => `תרחיש מוצר נכשל: ${scenario.id}`),
    ...(highFindings.length ? ['קיים ממצא מוצר מאומת בחומרה גבוהה או קריטית'] : []),
    ...(mediumGateFindings.length ? ['ממצא בינוני מאומת הוגדר כמכשיל את שער האיכות'] : []),
  ];
  const exitCode = runStatus === 'INFRASTRUCTURE_FAILED'
    ? 1
    : runStatus === 'BLOCKED'
      ? 2
      : productQualityStatus === 'FAIL' ? 1 : 0;
  return { runStatus, productQualityStatus, exitCode, reasons };
}
