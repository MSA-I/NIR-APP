import type { Finding, RoleResult, RoleScore, RunReport, RunStatus, ScenarioResult } from './schemas.ts';

function countBy(values: readonly string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function percent(results: readonly ScenarioResult[]): number | null {
  const measured = results.filter((result) => result.status !== 'SKIPPED_BY_CONFIGURATION');
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
        : roleScenarios.length
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
    flakyScenarios: findings.filter((finding) => finding.reproducibility === 'intermittent').length,
  };
}

export function exitDecision(
  scenarios: readonly ScenarioResult[],
  findings: readonly Finding[],
  failOnMedium: boolean,
): RunReport['exitDecision'] {
  const failures: string[] = [];
  const blocked: string[] = [];
  if (scenarios.some((scenario) => scenario.status === 'FAILED')) failures.push('תרחיש דטרמיניסטי נכשל');
  if (scenarios.some((scenario) => scenario.required && scenario.status === 'BLOCKED')) blocked.push('תרחיש חובה חסום');
  if (findings.some((finding) => finding.status === 'confirmed' && ['critical', 'high'].includes(finding.severity))) {
    failures.push('קיים ממצא מאומת בחומרה גבוהה או קריטית');
  }
  if (failOnMedium && findings.some((finding) => finding.status === 'confirmed' && finding.severity === 'medium')) {
    failures.push('הוגדר כשל CI על ממצא בינוני מאומת');
  }
  const status: RunStatus = failures.length ? 'FAILED' : blocked.length ? 'BLOCKED' : 'PASSED';
  const reasons = [...failures, ...blocked];
  return { status, exitCode: status === 'PASSED' ? 0 : 1, reasons };
}
