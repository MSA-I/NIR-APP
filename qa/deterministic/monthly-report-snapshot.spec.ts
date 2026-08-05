import { readFile } from 'node:fs/promises';
import * as XLSX from 'xlsx';
import { test, expect } from '../browser/fixture.ts';

test('accountant creates and downloads a locked monthly report snapshot at 390px', async ({
  page,
  qaRole,
  downloadMonitor,
  evidence,
}) => {
  test.skip(qaRole !== 'accountant', 'The final accountant snapshot is exercised by its authorized role.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/reports');

  await expect(page.getByText('דוח חי', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'דוחות סופיים נעולים', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'יצירת דוח סופי לרו״ח', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'יצירת דוח סופי נעול', exact: true });
  await expect(dialog).toContainText('חודש הדיווח');
  await expect(dialog).toContainText('ארגון');
  await expect(dialog).toContainText('זמן יצירה');
  await expect(dialog).toContainText('יוצר הדוח');
  await expect(dialog).toContainText('הגרסה אינה ניתנת לשינוי');

  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/rest/v1/rpc/create_monthly_report_snapshot');
  await dialog.getByRole('button', { name: 'יצירת דוח סופי נעול', exact: true }).click();
  const response = await responsePromise;
  expect(response.ok(), `snapshot creation returned HTTP ${response.status()}`).toBe(true);
  const snapshot = await response.json() as { id: string; version: number };
  expect(snapshot.id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(snapshot.version).toBeGreaterThan(0);

  const downloadButton = page.getByRole('button', { name: `הורדת גרסה ${snapshot.version}`, exact: true });
  await expect(downloadButton).toBeVisible();
  const download = await downloadMonitor.waitForNext(() => downloadButton.click());
  expect(download.failure).toBeNull();
  expect(download.path).not.toBeNull();
  const workbook = XLSX.read(await readFile(download.path!), { type: 'buffer' });
  const summary = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets['פרטי הדוח']!, { header: 1 });
  expect(summary[0]?.[1]).toBe('דוח סופי נעול');
  expect(summary[3]?.[1]).toBe(snapshot.version);

  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  evidence.record('monthly-report-snapshot', `${snapshot.id}:v${snapshot.version}`);
  await evidence.screenshot('monthly-report-snapshot-mobile');
});
