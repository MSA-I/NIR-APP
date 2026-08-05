import type { ConsoleMessage, Page } from '@playwright/test';
import { redactText, redactUrl } from './redaction.ts';

export interface ConsoleEvidence {
  readonly kind: 'console' | 'pageerror';
  readonly type: string;
  readonly text: string;
  readonly url: string | null;
  readonly line: number | null;
  readonly column: number | null;
}

const MAX_CONSOLE_ENTRIES = 1_000;

function intentionallyIgnored(text: string): boolean {
  return text.startsWith('Failed to load resource:') || text.includes('/realtime/v1/websocket');
}

export class ConsoleMonitor {
  readonly entries: ConsoleEvidence[] = [];
  private readonly page: Page;
  private droppedEntries = 0;
  private readonly onConsole = (message: ConsoleMessage): void => {
    const location = message.location();
    const text = redactText(message.text()).slice(0, 2_000);
    if (intentionallyIgnored(text)) return;
    this.push({
      kind: 'console',
      type: message.type(),
      text,
      url: location.url ? redactUrl(location.url) : null,
      line: location.lineNumber ?? null,
      column: location.columnNumber ?? null,
    });
  };
  private readonly onPageError = (error: Error): void => {
    this.push({
      kind: 'pageerror',
      type: 'error',
      text: redactText(error.message).slice(0, 2_000),
      url: null,
      line: null,
      column: null,
    });
  };

  constructor(page: Page) {
    this.page = page;
    page.on('console', this.onConsole);
    page.on('pageerror', this.onPageError);
  }

  private push(entry: ConsoleEvidence): void {
    if (this.entries.length < MAX_CONSOLE_ENTRIES) this.entries.push(entry);
    else this.droppedEntries += 1;
  }

  get droppedCount(): number {
    return this.droppedEntries;
  }

  blockingIssues(): readonly string[] {
    const issues = this.entries
      .filter(({ kind, type }) => kind === 'pageerror' || type === 'error')
      .map(({ kind, text }) => `${kind}: ${text}`);
    if (this.droppedEntries > 0) issues.push(`console evidence limit exceeded by ${this.droppedEntries} entries`);
    return issues;
  }

  stop(): void {
    this.page.off('console', this.onConsole);
    this.page.off('pageerror', this.onPageError);
  }
}
