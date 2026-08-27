import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

import { resolveResultsDir } from '../src/paths.mjs';
import { createOwnerDecisionServer } from '../src/server.mjs';

const rootDir = path.resolve(import.meta.dirname, '..', '..', '..');
const candidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

async function browserExecutable() {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error('No Chrome or Edge executable found');
}

const resultsDir = await mkdtemp(path.join(tmpdir(), 'owner-decisions-browser-'));
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8', windowsHide: true }).trim();
const server = createOwnerDecisionServer({ rootDir, resultsDir, port: 0, sourceCommit });
const { url, catalog } = await server.start();
const browser = await chromium.launch({ executablePath: await browserExecutable(), headless: true });
const verificationDir = path.join(await resolveResultsDir(rootDir), 'verification');
await mkdir(verificationDir, { recursive: true });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(url, { waitUntil: 'networkidle' });
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('href')), '#decision-list');
  await page.keyboard.press('Enter');
  await page.locator('#page-title').waitFor();
  await assert.doesNotReject(() => page.locator('text=264 הכרעות · 51 חובות').waitFor());
  assert.equal(await page.locator('.decision-card.needs-owner-decision').count(), 4);

  const required = catalog.items.filter((candidate) => candidate.requiresOwnerDecision);
  const firstItem = required[0];
  const firstChoice = firstItem.recommendation || firstItem.options[0].id;
  const firstRadio = page.locator(`input[data-answer-key="${firstItem.key}"][value="${firstChoice}"]`);
  await firstRadio.focus();
  await page.keyboard.press('Space');
  await page.locator('#save-indicator').filter({ hasText: 'נשמר אוטומטית' }).waitFor();
  assert.equal(await page.evaluate(({ key, value }) => document.activeElement?.dataset.answerKey === key && document.activeElement?.value === value, { key: firstItem.key, value: firstChoice }), true);

  for (const item of required.slice(1)) {
    const choice = item.recommendation || item.options[0].id;
    await page.locator(`input[data-answer-key="${item.key}"][value="${choice}"]`).check();
  }

  await page.locator('#progress-label').filter({ hasText: '4 מתוך 4' }).waitFor();
  const debtPriority = page.locator('input[data-debt-priority-key][value="follow_recommendation"]').first();
  await debtPriority.check();
  await page.locator('#save-indicator').filter({ hasText: 'נשמר אוטומטית' }).waitFor();
  const debtCard = debtPriority.locator('xpath=ancestor::article[1]');
  await debtCard.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(verificationDir, 'owner-decisions-technical-debt.png') });
  assert.equal(await page.locator('#finalize').isEnabled(), true);
  await page.locator('#finalize').click();
  await page.locator('#progress-label').filter({ hasText: 'מוכנות לקריאת הסוכן' }).waitFor();

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(verificationDir, 'owner-decisions-desktop.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.locator('.decision-card.needs-owner-decision').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(verificationDir, 'owner-decisions-desktop-decision.png') });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.evaluate(() => window.scrollTo(0, 0));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: path.join(verificationDir, 'owner-decisions-mobile.png') });
  await page.locator('.decision-card.needs-owner-decision').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(verificationDir, 'owner-decisions-mobile-decision.png') });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

  assert.equal(consoleErrors.length, 0, consoleErrors.join('\n'));
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
  const diskState = JSON.parse(await readFile(path.join(resultsDir, 'current.json'), 'utf8'));
  assert.equal(diskState.status, 'ready_for_planning');
  assert.equal(Object.keys(diskState.answers).length, 4);
  assert.equal(Object.values(diskState.debtPriorities).filter((entry) => entry.priority === 'follow_recommendation' && entry.resolvedPriority).length, 1);
} finally {
  await browser.close();
  await server.close();
}

console.log('owner-decisions browser verified');
