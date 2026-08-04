import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunReport } from './schemas.ts';

function list(values: readonly string[], empty = 'אין'): string {
  return values.length ? values.map((value) => `- ${value}`).join('\n') : `- ${empty}`;
}

function evidenceList(values: readonly string[]): string {
  return values.length
    ? values.map((value, index) => `- [ראיה ${index + 1}](<${value.replace(/\\/g, '/')}>)`).join('\n')
    : '- אין';
}

export async function writeRoleMarkdownReports(root: string, report: RunReport): Promise<string[]> {
  const paths: string[] = [];
  for (const role of report.roles) {
    const roleScenarios = report.scenarios.filter((scenario) => scenario.role === role.role);
    const roleFindings = report.findings.filter((finding) =>
      finding.role === role.role || finding.affectedRoles.includes(role.role));
    const byCategory = (category: string) => roleFindings.filter((finding) => finding.category === category);
    const evidence = [...new Set([...role.evidence, ...roleScenarios.flatMap((scenario) => scenario.evidence)])];
    const content = `# דוח תפקיד — ${role.role}\n\n` +
      `**מטרת התפקיד:** ${role.purpose}  \n**מצב:** ${role.status}\n\n` +
      `## תרחישים שבוצעו\n\n${list(roleScenarios.map((scenario) => `${scenario.name} — ${scenario.status}`))}\n\n` +
      `## פעולות שהושלמו\n\n${list(role.successfulTasks)}\n\n` +
      `## פעולות חסומות\n\n${list(role.blockedTasks)}\n\n` +
      `## תקלות פונקציונליות\n\n${list(byCategory('functional').map((finding) => `${finding.severity}: ${finding.title}`))}\n\n` +
      `## תקלות הרשאה\n\n${list(byCategory('authorization').map((finding) => `${finding.severity}: ${finding.title}`))}\n\n` +
      `## נגישות\n\n${list(byCategory('accessibility').map((finding) => `${finding.severity}: ${finding.title}`))}\n\n` +
      `## תצפיות שימושיות\n\n${list(roleFindings.filter((finding) => finding.status === 'observation').map((finding) => finding.title))}\n\n` +
      `## אזורים שלא היו נגישים או לא התגלו\n\n${list(role.inaccessibleAreas)}\n\n` +
      `## אזורים שנגישו באופן בלתי צפוי\n\n${list(role.unexpectedAccessibleAreas)}\n\n` +
      `## ראיות\n\n${evidenceList(evidence)}\n\n` +
      `## המלצות מתועדפות\n\n${list(roleFindings.filter((finding) => finding.recommendedFix).map((finding) => finding.recommendedFix ?? ''))}\n\n` +
      `## ביטחון ומגבלות\n\n${list(roleFindings.map((finding) => `${finding.title}: ${Math.round(finding.confidence * 100)}%`), 'אין ממצאים לדירוג ביטחון')}\n\n${list(role.limitations)}\n`;
    const destination = path.join(root, 'roles', role.role, 'report.he.md');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, 'utf8');
    paths.push(destination);
  }
  return paths;
}
