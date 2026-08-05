import type { RunReport } from './schemas.ts';

const runLabel: Record<RunReport['runStatus'], string> = {
  COMPLETED: 'הושלמה',
  BLOCKED: 'חסום',
  INFRASTRUCTURE_FAILED: 'כשל תשתית',
};

const qualityLabel: Record<RunReport['productQualityStatus'], string> = {
  PASS: 'עבר',
  PASS_WITH_FINDINGS: 'עבר עם ממצאים',
  FAIL: 'נכשל',
};

function count(report: RunReport, key: string): number {
  return report.statistics.bySeverity[key] ?? 0;
}

function cell(value: string): string {
  return value.replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
}

function findings(
  report: RunReport,
  categories: readonly RunReport['findings'][number]['category'][],
  empty: string,
): string {
  const values = report.findings
    .filter((finding) => categories.includes(finding.category))
    .map((finding) => `- ${finding.severity}: ${finding.title} — ${finding.status}`);
  return values.length ? values.join('\n') : `- ${empty}`;
}

export function executiveSummaryMarkdown(report: RunReport): string {
  const risks = report.findings
    .filter((finding) => finding.status === 'confirmed' && ['critical', 'high'].includes(finding.severity))
    .map((finding) => `- ${finding.title} — ${finding.userImpact}`);
  const scorecard = report.scorecards.map((score) =>
    `| ${score.role} | ${score.status} | ${score.coreTaskCompletion ?? '—'} | ${score.correctPermissions ?? '—'} | ${score.errorRecovery ?? '—'} | ${score.accessibility ?? '—'} | ${score.mobileUsability ?? '—'} | ${score.clarity ?? '—'} | ${score.dataCorrectness ?? '—'} | ${score.stability ?? '—'} |`,
  );
  const workflows = report.scenarios.map((scenario) =>
    `| ${scenario.name} | ${scenario.role} | ${scenario.status} | ${scenario.durationMs}ms |`,
  );
  const categories = Object.entries(report.statistics.byCategory)
    .map(([category, total]) => `${category}: ${total}`)
    .join(', ') || 'אין';
  const coverage = report.coverageExceptions.map((item) =>
    `| \`${cell(item.id)}\` | ${cell(item.name)} | ${cell(item.role)} | ${item.status} | ${item.required ? 'חובה' : 'אופציונלי'} | ${cell(item.reason)} |`,
  );
  return `# דוח QA מנהלים — SupplyFlow\n\n` +
    `**מצב הריצה:** ${runLabel[report.runStatus]}  \n` +
    `**מצב איכות המוצר:** ${qualityLabel[report.productQualityStatus]}  \n` +
    `**מזהה הרצה:** \`${report.runId}\`  \n` +
    `**סביבה:** ${report.environment.projectId} · ${report.environment.baseUrl} · ${report.environment.gitSha}\n\n` +
    `## תמונת מצב\n\n` +
    `- תרחישים שעברו: ${report.statistics.passedScenarios}\n` +
    `- תרחישים שנכשלו: ${report.statistics.failedScenarios}\n` +
    `- תרחישים חסומים: ${report.statistics.blockedScenarios}\n` +
    `- תרחישים שדולגו לפי הגדרה: ${report.statistics.skippedScenarios}\n` +
    `- תרחישים אופציונליים חסומים: ${report.statistics.optionalBlockedScenarios}\n` +
    `- ממצאים: קריטי ${count(report, 'critical')}, גבוה ${count(report, 'high')}, בינוני ${count(report, 'medium')}, נמוך ${count(report, 'low')}, מידע ${count(report, 'info')}\n\n` +
    `**תפקידים שנבדקו:** ${report.roles.map((role) => role.role).join(', ') || 'אין'}  \n` +
    `**ממצאים לפי קטגוריה:** ${categories}  \n` +
    `**תוצאות flaky:** ${report.statistics.flakyScenarios}\n\n` +
    `## סיכונים קריטיים\n\n${risks.length ? risks.join('\n') : '- לא נמצאו ממצאים קריטיים או גבוהים מאומתים.'}\n\n` +
    `## סיכוני הרשאה\n\n${findings(report, ['authorization', 'security'], 'לא נמצאו ממצאי הרשאה או אבטחה.')}\n\n` +
    `## נכונות כספית ושלמות נתונים\n\n${findings(report, ['data_integrity'], 'לא נמצאו ממצאי שלמות נתונים; הדבר אינו מחליף בדיקה חשבונאית אנושית.')}\n\n` +
    `## נגישות\n\n${findings(report, ['accessibility'], 'לא נמצאו ממצאי axe חוסמים; בדיקה אוטומטית אינה כיסוי מלא.')}\n\n` +
    `## כרטיס תפקידים\n\n| תפקיד | מצב | השלמת ליבה | הרשאות | התאוששות | נגישות | מובייל | בהירות | נכונות נתונים | יציבות |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${scorecard.join('\n')}\n\n` +
    `## כרטיס תהליכים מקצה לקצה\n\n| תרחיש | תפקיד | מצב | משך |\n|---|---|---:|---:|\n${workflows.join('\n') || '| אין | — | BLOCKED | — |'}\n\n` +
    `## כיסוי חסום או מדולג\n\n| מזהה | שם | תפקיד | מצב | חיוביות | סיבה |\n|---|---|---|---|---|---|\n${coverage.join('\n') || '| — | אין | — | — | — | — |'}\n\n` +
    `## סדר טיפול מומלץ\n\n` +
    `1. בידוד דיירים, הרשאות ופעולות כספיות לא מורשות.\n` +
    `2. נכונות סכומים, כפילויות ומעברי סטטוס.\n` +
    `3. זרימות ליבה חסומות ואובדן נתונים.\n` +
    `4. נגישות ושימושיות מובייל.\n\n` +
    `## מגבלות\n\n${report.limitations.map((item) => `- ${item}`).join('\n')}\n\n` +
    `## בדיקות אנושיות שעדיין נדרשות\n\n${report.humanTestingRequired.map((item) => `- ${item}`).join('\n')}\n`;
}
