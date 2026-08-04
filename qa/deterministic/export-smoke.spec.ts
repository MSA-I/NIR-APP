import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { ROLE_CONTRACTS } from '../config/roles.ts';
import { test, expect } from '../browser/fixture.ts';

test('role-owned export downloads the implemented readable file format', async ({
  page,
  qaRole,
  downloadMonitor,
  evidence,
}) => {
  test.skip(!['accountant', 'supplier'].includes(qaRole), 'This smoke belongs to export-capable roles.');
  const accountant = qaRole === 'accountant';
  const route = accountant ? '/reports' : '/my-prices';
  const buttonName = accountant ? 'ייצוא Excel' : 'הורדת תבנית';
  evidence.record('export-smoke', `${route}:${buttonName}`);
  await page.goto(route);
  await expect(page.getByRole('heading', {
    level: 1,
    name: ROLE_CONTRACTS[qaRole].coreRoute.heading,
    exact: true,
  })).toBeVisible();
  const button = page.getByRole('button', { name: buttonName, exact: true });
  await expect(button).toBeEnabled();
  const download = await downloadMonitor.waitForNext(() => button.click());
  expect(download.failure).toBeNull();
  expect(download.path).not.toBeNull();
  expect(download.bytes).toBeGreaterThan(100);
  expect(download.sha256).toMatch(/^[a-f0-9]{64}$/);
  const file = await readFile(download.path!);
  if (accountant) {
    expect(download.fileName.toLowerCase()).toMatch(/\.xlsx$/);
    expect(file.subarray(0, 2).toString('ascii')).toBe('PK');
    const archive = unzipSync(new Uint8Array(file));
    expect(Object.hasOwn(archive, '[Content_Types].xml')).toBe(true);
    expect(Object.hasOwn(archive, 'xl/workbook.xml')).toBe(true);
  } else {
    expect(download.fileName.toLowerCase()).toMatch(/\.csv$/);
    const text = file.toString('utf8').replace(/^\uFEFF/, '');
    expect(text.split(/\r?\n/, 1)[0]).toBe('product_id,product_name,price');
  }
});
