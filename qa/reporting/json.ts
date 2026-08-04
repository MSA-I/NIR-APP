import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RunReportSchema, type RunReport } from './schemas.ts';
import { safeJson } from './redact.ts';

export async function writeJsonReport(filePath: string, report: RunReport): Promise<void> {
  const parsed = RunReportSchema.parse(report);
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, `${safeJson(parsed)}\n`, 'utf8');
  await rename(temporary, filePath);
}

