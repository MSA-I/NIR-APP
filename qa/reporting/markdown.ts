import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunReport } from './schemas.ts';

function list(values: readonly string[], empty = 'אין'): string {
  return values.length ? values.map((value) => `- ${value}`).join('\n') : `- ${empty}`;
}

function evidenceList(root: string, reportDirectory: string, values: readonly string[]): string {
  return values.length
    ? values.map((value, index) => {
        const absolute = path.isAbsolute(value) ? value : path.resolve(root, value);
        const href = path.relative(reportDirectory, absolute).replaceAll('\\', '/');
        return `- [ראיה ${index + 1}](<${href}>)`;
      }).join('\n')
    : '- אין';
}

function cell(value: string): string {
  return value.replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
}

export async function writeRoleMarkdownReports(root: string, report: RunReport): Promise<string[]> {
  const paths: string[] = [];
  for (const role of report.roles) {
    const destination = path.join(root, 'roles', role.role, 'report.he.md');
    const roleScenarios = report.scenarios.filter((scenario) => scenario.role === role.role);
    const evidence = [...new Set([...role.evidence, ...roleScenarios.flatMap((scenario) => scenario.evidence)])];
    const scenarioRows = roleScenarios.map((scenario) =>
      `| \`${cell(scenario.id)}\` | ${cell(scenario.name)} | ${scenario.status} | ${scenario.required ? 'חובה' : 'אופציונלי'} | ${cell(scenario.limitation ?? '—')} |`,
    );
    const content = `# דוח תפקיד — ${role.role}\n\n` +
      `**מטרת התפקיד:** ${role.purpose}  \n**מצב:** ${role.status}\n\n` +
      `## תרחישים שבוצעו\n\n| מזהה | שם | מצב | חיוביות | סיבה/מגבלה |\n|---|---|---|---|---|\n${scenarioRows.join('\n') || '| — | אין | — | — | — |'}\n\n` +
      `## משימות שנוסו\n\n${list(role.tasksAttempted)}\n\n` +
      `## משימות שהושלמו\n\n${list(role.tasksCompleted)}\n\n` +
      `## משימות שנחסמו\n\n${list(role.tasksBlocked)}\n\n` +
      `## אזורים נגישים\n\n${list(role.accessibleAreas)}\n\n` +
      `## אזורים בלתי נגישים באופן בלתי צפוי\n\n${list(role.unexpectedlyInaccessibleAreas)}\n\n` +
      `## אזורים נגישים באופן בלתי צפוי\n\n${list(role.unexpectedlyAccessibleAreas)}\n\n` +
      `## תקלות פונקציונליות\n\n${list(role.functionalDefects)}\n\n` +
      `## תקלות הרשאה\n\n${list(role.permissionDefects)}\n\n` +
      `## ממצאי נגישות\n\n${list(role.accessibilityFindings)}\n\n` +
      `## תצפיות שימושיות\n\n${list(role.usabilityObservations)}\n\n` +
      `## ניסוחים לא ברורים\n\n${list(role.unclearWording)}\n\n` +
      `## בעיות התאוששות\n\n${list(role.recoveryProblems)}\n\n` +
      `## ראיות\n\n${evidenceList(root, path.dirname(destination), evidence)}\n\n` +
      `## ביטחון\n\n- ${role.confidence === null ? 'לא זמין — לא נאספו ממצאים לדירוג.' : `${Math.round(role.confidence * 100)}%`}\n\n` +
      `## המלצות\n\n${list(role.recommendations)}\n\n` +
      `## מגבלות\n\n${list(role.limitations)}\n`;
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, 'utf8');
    paths.push(destination);
  }
  return paths;
}
