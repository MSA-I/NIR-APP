import { readFile } from 'node:fs/promises';
import * as XLSX from 'xlsx';
import { test, expect } from '../browser/fixture.ts';

test('accountant creates and downloads a legal-entity locked snapshot at 390px', async ({
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

  const unitSelect = page.getByLabel('ישות משפטית', { exact: true });
  await expect(unitSelect).toBeVisible();
  let selectedUnitId = await unitSelect.inputValue();
  if (!selectedUnitId) {
    const firstAllowedUnit = await unitSelect.locator('option').nth(1).getAttribute('value');
    expect(firstAllowedUnit, 'The accountant has no authorized legal entity.').toBeTruthy();
    await unitSelect.selectOption(firstAllowedUnit!);
    selectedUnitId = await unitSelect.inputValue();
  }
  expect(selectedUnitId, 'A scoped legal entity must be selected explicitly on the report screen.').not.toBe('');

  await page.getByRole('button', { name: 'יצירת דוח סופי לרו״ח', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'יצירת דוח סופי נעול', exact: true });
  await expect(dialog).toContainText('חודש הדיווח');
  await expect(dialog).toContainText('ארגון');
  await expect(dialog).toContainText('ישות משפטית');
  await expect(dialog).toContainText('זמן יצירה');
  await expect(dialog).toContainText('יוצר הדוח');
  await expect(dialog).toContainText('הגרסה אינה ניתנת לשינוי');

  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/rest/v1/rpc/create_monthly_report_snapshot');
  await dialog.getByRole('button', { name: /יצירת (דוח סופי נעול|גרסה חדשה)/ }).click();
  const response = await responsePromise;
  expect(response.ok(), `snapshot creation returned HTTP ${response.status()}`).toBe(true);
  const snapshot = await response.json() as {
    id: string;
    unit_id: string;
    legal_entity_name: string;
    version: number;
    content_hash: string;
    totals: { invoice_total: number; payment_total: number; bank_total: number };
  };
  expect(snapshot.id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(snapshot.unit_id).toBe(selectedUnitId);
  expect(snapshot.version).toBeGreaterThan(0);
  expect(snapshot.content_hash).toMatch(/^[0-9a-f]{64}$/);

  const downloadButton = page.getByRole('button', { name: `הורדת גרסה ${snapshot.version}`, exact: true });
  await expect(downloadButton).toBeVisible();
  const download = await downloadMonitor.waitForNext(() => downloadButton.click());
  expect(download.failure).toBeNull();
  expect(download.path).not.toBeNull();

  const workbook = XLSX.read(await readFile(download.path!), { type: 'buffer', cellFormula: true });
  const summary = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets['פרטי הדוח']!, { header: 1 });
  expect(summary[0]?.[1]).toBe('דוח סופי נעול');
  expect(summary[2]?.[1]).toBe(snapshot.legal_entity_name);
  expect(summary[4]?.[1]).toBe(snapshot.version);
  expect(summary[9]?.[1]).toBe(snapshot.content_hash);
  expect(summary[13]?.[2]).toBe(snapshot.totals.invoice_total);
  expect(summary[16]?.[2]).toBe(snapshot.totals.payment_total);
  expect(summary[19]?.[2]).toBe(snapshot.totals.bank_total);

  const formulaCells = workbook.SheetNames.flatMap((name) => Object.entries(workbook.Sheets[name] ?? {})
    .filter(([address, cell]) => !address.startsWith('!') && typeof (cell as XLSX.CellObject).f === 'string'));
  expect(formulaCells).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

  evidence.record('monthly-report-snapshot', `${snapshot.id}:${snapshot.unit_id}:v${snapshot.version}`);
  await evidence.screenshot('monthly-report-snapshot-mobile');
});
