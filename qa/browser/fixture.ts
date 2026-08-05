import { test as base, expect } from '@playwright/test';
import { roleFromProjectName, type QaRole } from '../config/roles.ts';
import { ConsoleMonitor } from './console-monitor.ts';
import { DownloadMonitor } from './download-monitor.ts';
import { EvidenceCollector } from './evidence.ts';
import { NetworkMonitor } from './network-monitor.ts';

interface QaFixtures {
  readonly qaRole: QaRole;
  readonly consoleMonitor: ConsoleMonitor;
  readonly networkMonitor: NetworkMonitor;
  readonly downloadMonitor: DownloadMonitor;
  readonly evidence: EvidenceCollector;
  readonly evidenceLifecycle: void;
}

export const test = base.extend<QaFixtures>({
  qaRole: async ({}, use, testInfo) => {
    await use(roleFromProjectName(testInfo.project.name));
  },
  consoleMonitor: async ({ page }, use) => {
    await use(new ConsoleMonitor(page));
  },
  networkMonitor: async ({ page }, use) => {
    await use(new NetworkMonitor(page));
  },
  downloadMonitor: async ({ page }, use, testInfo) => {
    await use(new DownloadMonitor(page, testInfo.outputPath('downloads')));
  },
  evidence: async ({ page, qaRole, consoleMonitor, networkMonitor, downloadMonitor }, use, testInfo) => {
    await use(new EvidenceCollector(page, testInfo, qaRole, consoleMonitor, networkMonitor, downloadMonitor));
  },
  evidenceLifecycle: [async ({ evidence }, use, testInfo) => {
    await use();
    const issues = await evidence.blockingIssues();
    const otherwisePassing = testInfo.status === testInfo.expectedStatus && testInfo.status === 'passed';
    const needsFailureScreenshot = testInfo.status !== 'passed' && testInfo.status !== 'skipped';
    if (needsFailureScreenshot || issues.length > 0) {
      await evidence.screenshot('failure').catch(() => undefined);
    }
    await evidence.finalize(otherwisePassing && issues.length ? 'failed' : (testInfo.status ?? 'interrupted'));
    if (otherwisePassing && issues.length) {
      throw new Error(`Browser evidence contains unexpected failures: ${issues.slice(0, 5).join('; ')}`);
    }
  }, { auto: true }],
});

export { expect };
