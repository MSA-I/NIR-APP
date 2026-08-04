import { mkdir, writeFile } from 'node:fs/promises';
import type { Page, TestInfo } from '@playwright/test';
import type { QaRole } from '../config/roles.ts';
import type { ConsoleMonitor } from './console-monitor.ts';
import type { DownloadMonitor } from './download-monitor.ts';
import type { NetworkMonitor } from './network-monitor.ts';
import { redactText, safeArtifactName, sensitiveScreenshotMasks } from './redaction.ts';

export interface BrowserActionEvidence {
  readonly step: number;
  readonly at: string;
  readonly action: string;
  readonly detail: string;
}

export class EvidenceCollector {
  private readonly startedAt = Date.now();
  private readonly actions: BrowserActionEvidence[] = [];
  private readonly screenshots: string[] = [];
  private nextStep = 0;

  constructor(
    private readonly page: Page,
    private readonly testInfo: TestInfo,
    private readonly role: QaRole,
    private readonly consoleMonitor: ConsoleMonitor,
    private readonly networkMonitor: NetworkMonitor,
    private readonly downloadMonitor: DownloadMonitor,
  ) {}

  record(action: string, detail: string): void {
    this.actions.push({
      step: ++this.nextStep,
      at: new Date().toISOString(),
      action: safeArtifactName(redactText(action), 'action'),
      detail: redactText(detail).slice(0, 1_000),
    });
  }

  async screenshot(label: string): Promise<string> {
    const name = `${safeArtifactName(redactText(label), 'screenshot')}.png`;
    const path = this.testInfo.outputPath(name);
    await this.page.screenshot({
      path,
      fullPage: true,
      mask: [...sensitiveScreenshotMasks(this.page)],
    });
    this.screenshots.push(name);
    this.record('screenshot', name);
    return path;
  }

  async blockingIssues(): Promise<readonly string[]> {
    const downloadIssues = await this.downloadMonitor.blockingIssues();
    return [...this.consoleMonitor.blockingIssues(), ...this.networkMonitor.blockingIssues(), ...downloadIssues];
  }

  async finalize(outcome: string): Promise<void> {
    this.consoleMonitor.stop();
    this.networkMonitor.stop();
    this.downloadMonitor.stop();
    await this.downloadMonitor.flush();
    const blockingIssues = await this.blockingIssues();
    const currentUrl = (() => {
      try {
        return new URL(this.page.url()).pathname;
      } catch {
        return 'unavailable';
      }
    })();
    const evidence = {
      schemaVersion: 1,
      traceMode: 'playwright-on-first-retry-plus-redacted-event-log',
      runId: redactText(process.env.QA_RUN_ID?.trim() || 'unassigned'),
      test: this.testInfo.title,
      scenario: this.testInfo.titlePath.join(' > '),
      project: this.testInfo.project.name,
      role: this.role,
      currentUrl,
      outcome,
      blockingIssues,
      durationMs: Date.now() - this.startedAt,
      actions: this.actions,
      console: this.consoleMonitor.entries,
      consoleDropped: this.consoleMonitor.droppedCount,
      network: this.networkMonitor.entries,
      networkDropped: this.networkMonitor.droppedCount,
      downloads: this.downloadMonitor.entries.map(({ path: _path, ...entry }) => entry),
      screenshots: this.screenshots,
    };
    const path = this.testInfo.outputPath('evidence.json');
    await mkdir(this.testInfo.outputDir, { recursive: true });
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    await this.testInfo.attach('redacted-browser-evidence', { path, contentType: 'application/json' });
  }
}
