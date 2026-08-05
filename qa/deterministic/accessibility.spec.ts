import { AxeBuilder } from '@axe-core/playwright';
import { createQaConfig } from '../config/qa.config.ts';
import { ROLE_CONTRACTS } from '../config/roles.ts';
import { test, expect } from '../browser/fixture.ts';
import { redactText } from '../browser/redaction.ts';
import { loadReadyQaState } from '../runner/runtime-state.ts';

const qa = createQaConfig();

test('core route is Hebrew RTL and has no blocking axe violations', async ({ page, qaRole, evidence }, testInfo) => {
  const route = ROLE_CONTRACTS[qaRole].coreRoute;
  evidence.record('accessibility-scan', route.path);
  await page.goto(route.path);
  await expect(page.getByRole('heading', { level: 1, name: route.heading, exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'he');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const summary = result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    targets: violation.nodes.flatMap((node) => node.target.map((target) => redactText(String(target)))),
  }));
  await testInfo.attach('axe-summary', {
    body: Buffer.from(`${JSON.stringify(summary, null, 2)}\n`, 'utf8'),
    contentType: 'application/json',
  });
  const blocking = result.violations.filter((violation) =>
    violation.impact !== null && qa.blockingAxeImpacts.includes(violation.impact as 'serious' | 'critical'));
  expect(blocking.length, `Blocking axe violations: ${blocking.map(({ id }) => id).join(', ')}`).toBe(0);
});

test('keyboard entry bypasses the persistent shell through route focus or the skip link', async ({ page, evidence }) => {
  evidence.record('keyboard', 'main-or-skip-link');
  await page.goto('/dashboard');
  const skip = page.getByRole('link', { name: 'דלג לתוכן', exact: true });
  const main = page.locator('#main');
  if (await main.evaluate((element) => document.activeElement === element)) {
    await expect(main).toBeFocused();
    return;
  }
  await page.keyboard.press('Tab');
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(main).toBeFocused();
});

test('bank import reason exposes its visible label as the accessible name', async ({ page, qaRole, evidence }) => {
  test.skip(qaRole !== 'accountant', 'Bank import belongs to the accountant role.');
  const state = await loadReadyQaState();
  const bankFile = state.fixtureFiles['bank-csv'];
  expect(bankFile, 'The bank CSV fixture must exist after QA setup.').toBeTruthy();

  evidence.record('accessible-name', 'bank-import-reason');
  await page.goto('/bank');
  await page.getByRole('button', { name: 'ייבוא תדפיס בנק', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'ייבוא תדפיס בנק', exact: true });
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    dialog.getByRole('button', { name: 'בחירת קובץ', exact: true }).click(),
  ]);
  await chooser.setFiles(bankFile!);
  await expect(dialog.getByRole('textbox', { name: 'סיבת הייבוא *', exact: true })).toBeVisible();
});

test('kitchen receiving remains usable at the mobile contract viewport', async ({ page, qaRole, evidence }) => {
  test.skip(qaRole !== 'kitchen', 'The mobile operational contract belongs to the kitchen role.');
  await page.setViewportSize({ width: 390, height: 844 });
  evidence.record('mobile-route', '/receiving at 390x844');
  await page.goto('/receiving');
  await expect(page.getByRole('heading', { level: 1, name: 'קבלת סחורה', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'פתיחת תפריט', exact: true })).toBeVisible();
  const metrics = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    undersized: [...document.querySelectorAll<HTMLElement>('#main button:not([disabled]), #main a[href]')]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44);
      })
      .map((element) => element.getAttribute('aria-label') || element.textContent?.trim() || element.tagName),
  }));
  expect(metrics.overflow).toBeLessThanOrEqual(1);
  expect(metrics.undersized, `Touch targets below 44px: ${metrics.undersized.join(', ')}`).toEqual([]);
});
