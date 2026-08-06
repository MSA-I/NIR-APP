import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { executiveSummaryMarkdown } from './executive-summary.ts';
import { writeHtmlReport } from './html.ts';
import { writeJsonReport } from './json.ts';
import { writeRoleMarkdownReports } from './markdown.ts';
import { redactUnknown } from './redact.ts';
import { RunReportSchema, type RunReport } from './schemas.ts';

export async function generateReports(root: string, input: RunReport): Promise<string[]> {
  const report = RunReportSchema.parse(redactUnknown(RunReportSchema.parse(input)));
  await mkdir(root, { recursive: true });
  const jsonPath = path.join(root, 'report.json');
  const executivePath = path.join(root, 'executive.he.md');
  const htmlPath = path.join(root, 'report.html');
  await writeJsonReport(jsonPath, report);
  await writeFile(executivePath, executiveSummaryMarkdown(report), 'utf8');
  await writeHtmlReport(htmlPath, report);
  return [jsonPath, executivePath, htmlPath, ...await writeRoleMarkdownReports(root, report)];
}
