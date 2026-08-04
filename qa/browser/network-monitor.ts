import type { Page, Request, Response } from '@playwright/test';
import { redactText, redactUrl } from './redaction.ts';

export interface NetworkEvidence {
  readonly method: string;
  readonly url: string;
  readonly resourceType: string;
  readonly status: number | null;
  readonly durationMs: number | null;
  readonly failure: string | null;
  readonly expectedDenial: boolean;
}

export interface ExpectedNetworkDenial {
  readonly method: string;
  readonly pathname: string;
  readonly status: 401 | 403;
}

export function matchesExpectedNetworkDenial(
  method: string,
  url: string,
  status: number,
  expected: readonly ExpectedNetworkDenial[],
): boolean {
  const pathname = new URL(url).pathname;
  return expected.some((item) => item.method.toUpperCase() === method.toUpperCase()
    && item.pathname === pathname && item.status === status);
}

const MAX_NETWORK_ENTRIES = 1_500;
const STALLED_REQUEST_MS = 15_000;
const EXCESSIVE_REPEAT_COUNT = 20;

export class NetworkMonitor {
  readonly entries: NetworkEvidence[] = [];
  private readonly page: Page;
  private readonly expectedDenials: ExpectedNetworkDenial[] = [];
  private readonly observedExpectedDenials = new Set<number>();
  private readonly startedAt = new Map<Request, number>();
  private droppedEntries = 0;
  private readonly onRequest = (request: Request): void => {
    this.startedAt.set(request, Date.now());
  };
  private readonly onResponse = (response: Response): void => {
    const request = response.request();
    const durationMs = this.duration(request);
    this.startedAt.delete(request);
    const expectedDenialIndex = this.expectedDenials.findIndex((item, index) =>
      !this.observedExpectedDenials.has(index)
      && matchesExpectedNetworkDenial(request.method(), response.url(), response.status(), [item]));
    if (expectedDenialIndex >= 0) this.observedExpectedDenials.add(expectedDenialIndex);
    this.push({
      method: request.method(),
      url: redactUrl(response.url()),
      resourceType: request.resourceType(),
      status: response.status(),
      durationMs,
      failure: null,
      expectedDenial: expectedDenialIndex >= 0,
    });
  };
  private readonly onRequestFailed = (request: Request): void => {
    const failure = request.failure()?.errorText ?? 'unknown network failure';
    const durationMs = this.duration(request);
    this.startedAt.delete(request);
    if (failure === 'net::ERR_ABORTED' || request.url().includes('/realtime/v1/websocket')) return;
    this.push({
      method: request.method(),
      url: redactUrl(request.url()),
      resourceType: request.resourceType(),
      status: null,
      durationMs,
      failure: redactText(failure),
      expectedDenial: false,
    });
  };

  constructor(page: Page) {
    this.page = page;
    page.on('request', this.onRequest);
    page.on('response', this.onResponse);
    page.on('requestfailed', this.onRequestFailed);
  }

  private duration(request: Request): number | null {
    const started = this.startedAt.get(request);
    return started === undefined ? null : Date.now() - started;
  }

  private push(entry: NetworkEvidence): void {
    if (this.entries.length < MAX_NETWORK_ENTRIES) this.entries.push(entry);
    else this.droppedEntries += 1;
  }

  get droppedCount(): number {
    return this.droppedEntries;
  }

  expectDenial(input: ExpectedNetworkDenial): void {
    if (!input.pathname.startsWith('/') || input.pathname.includes('?') || input.pathname.includes('#')) {
      throw new Error('Expected denial pathname must be an absolute application/API path without query or fragment.');
    }
    this.expectedDenials.push({ ...input, method: input.method.toUpperCase() });
  }

  blockingIssues(): readonly string[] {
    const issues = this.entries
      .filter(({ status, failure, durationMs, expectedDenial }) => failure !== null
        || (status !== null && status >= 400 && !expectedDenial)
        || (status !== null && status >= 300 && status < 400 && status !== 304)
        || (durationMs !== null && durationMs >= STALLED_REQUEST_MS))
      .map(({ method, url, status, failure, durationMs }) => {
        if (failure) return `${method} ${url}: ${failure}`;
        if (status !== null && status >= 400) return `${method} ${url}: HTTP ${status}`;
        if (status !== null && status >= 300 && status < 400) return `${method} ${url}: unexpected redirect HTTP ${status}`;
        return `${method} ${url}: stalled for ${durationMs ?? 0}ms`;
      });

    const now = Date.now();
    for (const [request, started] of this.startedAt) {
      if (request.url().includes('/realtime/v1/websocket')) continue;
      const durationMs = now - started;
      if (durationMs >= STALLED_REQUEST_MS) {
        issues.push(`${request.method()} ${redactUrl(request.url())}: still pending after ${durationMs}ms`);
      }
    }

    const counts = new Map<string, number>();
    for (const { method, url } of this.entries) {
      const key = `${method} ${url}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [request, count] of counts) {
      if (count > EXCESSIVE_REPEAT_COUNT) issues.push(`${request}: repeated ${count} times`);
    }
    if (this.droppedEntries > 0) issues.push(`network evidence limit exceeded by ${this.droppedEntries} entries`);
    for (const [index, expected] of this.expectedDenials.entries()) {
      if (!this.observedExpectedDenials.has(index)) {
        issues.push(`${expected.method} ${expected.pathname}: expected HTTP ${expected.status} denial was not observed`);
      }
    }
    return issues;
  }

  stop(): void {
    this.page.off('request', this.onRequest);
    this.page.off('response', this.onResponse);
    this.page.off('requestfailed', this.onRequestFailed);
  }
}
