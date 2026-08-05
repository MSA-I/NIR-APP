import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page, Request, Response } from '@playwright/test';
import type { QaRole } from '../config/roles.ts';
import { redactText, safeArtifactName, sensitiveScreenshotMasks } from './redaction.ts';

export type SafeTarget =
  | { readonly kind: 'role'; readonly role: SafeControlRole; readonly name: string; readonly exact?: boolean }
  | { readonly kind: 'label'; readonly label: string; readonly exact?: boolean }
  | { readonly kind: 'text'; readonly text: string; readonly exact?: boolean };

export type SafeControlRole =
  | 'button'
  | 'link'
  | 'textbox'
  | 'spinbutton'
  | 'checkbox'
  | 'radio'
  | 'combobox'
  | 'option'
  | 'menuitem'
  | 'tab'
  | 'heading';

export type SafeKey =
  | 'Tab'
  | 'Shift+Tab'
  | 'Enter'
  | 'Space'
  | 'Escape'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'Home'
  | 'End'
  | 'PageUp'
  | 'PageDown';

export interface VisibleControl {
  readonly role: SafeControlRole;
  readonly name: string;
  readonly disabled: boolean;
  readonly value: string | null;
  readonly checked: boolean | null;
  readonly pressed: boolean | null;
}

export interface VisibleLabeledControl {
  readonly label: string;
  readonly disabled: boolean;
  readonly value: string | null;
  readonly checked: boolean | null;
}

export interface VisibleUiSnapshot {
  readonly contentOrigin: 'untrusted-application-ui';
  readonly url: string;
  readonly title: string;
  readonly heading: string | null;
  readonly visibleText: string;
  readonly controls: readonly VisibleControl[];
  readonly labeledControls: readonly VisibleLabeledControl[];
}

export type BrowserActionType =
  | 'open'
  | 'snapshot'
  | 'click'
  | 'fill'
  | 'select'
  | 'upload'
  | 'press'
  | 'scroll'
  | 'wait_for_text'
  | 'screenshot'
  | 'current_url';

export interface BrowserMutationEntityRef {
  readonly kind: string;
  readonly visibleReference: string;
}

export interface BrowserMutationNetworkEvidence {
  readonly requestId: string;
  readonly method: string;
  readonly pathname: string;
  readonly resourceType: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  readonly status: number | null;
  readonly failure: string | null;
  readonly mutationCandidate: boolean;
  readonly responseBodyParsed: boolean;
  readonly responseFacts: Readonly<Record<string, string | number | boolean | null>>;
  readonly entityRefs: readonly BrowserMutationEntityRef[];
}

export interface BrowserMutationEvidence {
  readonly source: 'browser-action';
  readonly actionId: string;
  readonly step: number;
  readonly role: QaRole;
  readonly scenarioId: string;
  readonly actionType: BrowserActionType;
  readonly description: string;
  readonly expectedMutation: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly routeBefore: string;
  readonly routeAfter: string;
  readonly preScreenshot: string;
  readonly postScreenshot: string;
  readonly notification: {
    readonly kind: 'success' | 'error' | 'none';
    readonly text: string | null;
  };
  readonly network: readonly BrowserMutationNetworkEvidence[];
  readonly entityRefsSource: 'response-body';
  readonly entityRefs: readonly BrowserMutationEntityRef[];
  readonly hasMutationRequest: boolean;
  readonly actionError: string | null;
  readonly evidenceRefs: readonly string[];
}

export interface BrowserMutationCaptureInput {
  readonly actionId: string;
  readonly step: number;
  readonly role: QaRole;
  readonly scenarioId: string;
  readonly actionType: BrowserActionType;
  readonly description: string;
  readonly expectedMutation: string;
  readonly expectMutation: boolean;
}

export interface BrowserMutationCaptureResult<T> {
  readonly value: T | null;
  readonly evidence: BrowserMutationEvidence;
}

export interface SafeBrowserTools {
  open(route: string): Promise<VisibleUiSnapshot>;
  snapshot(): Promise<VisibleUiSnapshot>;
  click(target: SafeTarget): Promise<VisibleUiSnapshot>;
  fill(target: SafeTarget, value: string): Promise<VisibleUiSnapshot>;
  select(target: SafeTarget, option: string): Promise<VisibleUiSnapshot>;
  upload(target: SafeTarget, fixtureId: string): Promise<VisibleUiSnapshot>;
  press(key: SafeKey): Promise<VisibleUiSnapshot>;
  scroll(direction: 'up' | 'down'): Promise<VisibleUiSnapshot>;
  waitForText(text: string, timeoutMs?: number): Promise<VisibleUiSnapshot>;
  screenshot(label: string): Promise<string>;
  currentUrl(): Promise<string>;
  /** Trusted harness boundary. The role model can request an action but cannot provide evidence. */
  capturePotentialMutation?<T>(
    input: BrowserMutationCaptureInput,
    action: () => Promise<T>,
  ): Promise<BrowserMutationCaptureResult<T>>;
}

export interface BrowserToolsOptions {
  readonly page: Page;
  readonly baseUrl: string;
  readonly allowedRoutes: readonly string[];
  readonly fixtures: Readonly<Record<string, string>>;
  readonly screenshotDirectory: string;
  readonly actionEvidenceDirectory?: string;
  readonly protectedSearches?: ReadonlyMap<string, string>;
  readonly record?: (action: string, detail: string) => void;
}

const SNAPSHOT_LIMIT = 12_000;
const CONTROL_LIMIT = 100;
const SNAPSHOT_CONTROL_TIMEOUT_MS = 1_000;
const CONTROL_ROLES: readonly SafeControlRole[] = [
  'button', 'link', 'textbox', 'spinbutton', 'checkbox', 'radio', 'combobox', 'menuitem', 'tab',
];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENTITY_KEYS: Readonly<Record<string, string>> = {
  submission_id: 'supplier_price_submission',
  receipt_id: 'goods_receipt',
  invoice_id: 'invoice',
  invoice_ids: 'invoice',
  payment_request_id: 'payment_request',
  payment_request_ids: 'payment_request',
  payment_id: 'payment',
  payment_ids: 'payment',
  document_id: 'document',
  import_id: 'bank_import',
  bank_transaction_id: 'bank_transaction',
  bank_transaction_ids: 'bank_transaction',
};
const TABLE_ENTITY_KINDS: Readonly<Record<string, string>> = {
  supplier_price_submissions: 'supplier_price_submission',
  goods_receipts: 'goods_receipt',
  invoices: 'invoice',
  payment_requests: 'payment_request',
  payments: 'payment',
  documents: 'document',
  bank_imports: 'bank_import',
  bank_transactions: 'bank_transaction',
};
const RESPONSE_FACT_KEYS = new Set([
  'status', 'review_status', 'order_status', 'idempotent', 'row_count',
  'accepted_count', 'rejected_count', 'unchanged_count', 'credit_count', 'number',
  'open_credit_override',
]);
const READ_ONLY_RPC = /^(?:invoice_financial_check_signals|payment_request_financial_check_signals|supplier_portal_context|global_search|is_platform_admin|platform_orgs|p[02]_)/;
const NETWORK_QUIET_MS = 300;
const NETWORK_CAPTURE_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BODY_CHARS = 200_000;

export function networkCaptureSettled(
  expectMutation: boolean,
  mutationObserved: boolean,
  pending: boolean,
  quietForMs: number,
): boolean {
  return !pending && (!expectMutation || mutationObserved) && quietForMs >= NETWORK_QUIET_MS;
}

interface MutableNetworkEvidence {
  requestId: string;
  method: string;
  pathname: string;
  resourceType: string;
  startedAt: string;
  startedAtMs: number;
  completedAt: string | null;
  durationMs: number | null;
  status: number | null;
  failure: string | null;
  mutationCandidate: boolean;
  responseBodyParsed: boolean;
  responseFacts: Record<string, string | number | boolean | null>;
  entityRefs: BrowserMutationEntityRef[];
}

export function hasObservedMutationRequest(
  entries: readonly Pick<BrowserMutationNetworkEvidence, 'mutationCandidate' | 'status'>[],
): boolean {
  return entries.some(({ mutationCandidate }) => mutationCandidate);
}

function contextualEntityKind(pathname: string): string | null {
  const match = /^\/rest\/v1\/([a-z_]+)$/.exec(pathname);
  return match ? TABLE_ENTITY_KINDS[match[1] ?? ''] ?? null : null;
}

function addEntityRef(
  refs: BrowserMutationEntityRef[],
  seen: Set<string>,
  kind: string,
  candidate: unknown,
): void {
  if (typeof candidate !== 'string' || !UUID_PATTERN.test(candidate)) return;
  const key = `${kind}:${candidate.toLowerCase()}`;
  if (seen.has(key)) return;
  seen.add(key);
  refs.push({ kind, visibleReference: candidate });
}

/** Extracts only allowlisted UUID fields from an actual JSON response body. */
export function extractResponseEntityRefs(
  value: unknown,
  pathname: string,
): BrowserMutationEntityRef[] {
  const refs: BrowserMutationEntityRef[] = [];
  const seen = new Set<string>();
  const contextualKind = contextualEntityKind(pathname);
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > 8 || candidate === null || typeof candidate !== 'object') return;
    if (Array.isArray(candidate)) {
      for (const item of candidate.slice(0, 200)) visit(item, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(candidate as Record<string, unknown>)) {
      const kind = ENTITY_KEYS[key] ?? (key === 'id' ? contextualKind : null);
      if (kind) {
        if (Array.isArray(child)) {
          for (const item of child.slice(0, 100)) addEntityRef(refs, seen, kind, item);
        } else addEntityRef(refs, seen, kind, child);
      }
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
  return refs;
}

function extractResponseFacts(value: unknown): Record<string, string | number | boolean | null> {
  const facts: Record<string, string | number | boolean | null> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return facts;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (!RESPONSE_FACT_KEYS.has(key)) continue;
    if (child === null || typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean') {
      facts[key] = typeof child === 'string' ? redactText(child).slice(0, 300) : child;
    }
  }
  return facts;
}

export function networkClassification(
  request: Pick<Request, 'method' | 'url'>,
): { capture: boolean; mutationCandidate: boolean } {
  const method = request.method().toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return { capture: false, mutationCandidate: false };
  }
  const pathname = new URL(request.url()).pathname;
  const rpc = /^\/rest\/v1\/rpc\/([a-z0-9_]+)$/i.exec(pathname);
  if (rpc) return { capture: true, mutationCandidate: !READ_ONLY_RPC.test(rpc[1] ?? '') };
  if (/^\/storage\/v1\/object\/sign(?:\/|$)/.test(pathname)) {
    return { capture: true, mutationCandidate: false };
  }
  const capture = /^\/(?:rest|functions|storage)\/v1\//.test(pathname);
  return { capture, mutationCandidate: capture };
}

export function matchesAllowedRoute(path: string, allowed: string): boolean {
  if (allowed.endsWith('/*')) {
    const prefix = allowed.slice(0, -1);
    return path.startsWith(prefix);
  }
  const actualSegments = path.split('/');
  const allowedSegments = allowed.split('/');
  if (actualSegments.length !== allowedSegments.length) return false;
  return allowedSegments.every((segment, index) => {
    const actual = actualSegments[index] ?? '';
    if (!segment.startsWith(':')) return segment === actual;
    if (!/^:[A-Za-z][A-Za-z0-9_]*$/.test(segment)) return false;
    return actual.length > 0 && !/%(?:2f|5c)/i.test(actual);
  });
}

function safeRoute(route: string, baseUrl: string, allowedRoutes: readonly string[]): string {
  if (!route.startsWith('/') || route.startsWith('//')) throw new Error('Browser tool routes must be relative application paths.');
  const url = new URL(route, baseUrl);
  if (url.origin !== new URL(baseUrl).origin || !allowedRoutes.some((allowed) => matchesAllowedRoute(url.pathname, allowed))) {
    throw new Error(`Browser tool route is outside the scenario allowlist: ${url.pathname}`);
  }
  return `${url.origin}${url.pathname}${url.search}`;
}

function targetDescription(target: SafeTarget): string {
  if (target.kind === 'role') return `${target.role}:${target.name}`;
  return target.kind === 'label' ? `label:${target.label}` : `text:${target.text}`;
}

class SafeBrowserToolsImpl implements SafeBrowserTools {
  private screenshotSequence = 0;
  private readonly options: BrowserToolsOptions;
  private readonly onPopup = (popup: Page): void => {
    this.options.record?.('popup-blocked', 'The constrained browser tool does not expose secondary pages.');
    void popup.close();
  };

  constructor(options: BrowserToolsOptions) {
    this.options = options;
    this.options.page.on('popup', this.onPopup);
  }

  private assertCurrentRouteAllowed(): string {
    const current = new URL(this.options.page.url());
    const expectedOrigin = new URL(this.options.baseUrl).origin;
    if (current.origin !== expectedOrigin
        || !this.options.allowedRoutes.some((allowed) => matchesAllowedRoute(current.pathname, allowed))) {
      throw new Error('Browser page escaped the scenario route allowlist.');
    }
    return current.pathname;
  }

  private async interactionRoot(): Promise<Locator> {
    const dialogs = this.options.page.locator('[role="dialog"][aria-modal="true"]:visible');
    return await dialogs.count() > 0 ? dialogs.last() : this.options.page.locator('#main');
  }

  private locator(root: Locator, target: SafeTarget): Locator {
    if (target.kind === 'role') {
      return root.getByRole(target.role, { name: target.name, exact: target.exact });
    }
    if (target.kind === 'label') {
      return root.getByLabel(target.label, { exact: target.exact });
    }
    return root.getByText(target.text, { exact: target.exact });
  }

  private async unique(target: SafeTarget): Promise<Locator> {
    const locator = this.locator(await this.interactionRoot(), target);
    await locator.first().waitFor({ state: 'visible' });
    const visible = await locator.filter({ visible: true }).count();
    if (visible !== 1) throw new Error(`Safe browser target is not unique: ${targetDescription(target)}`);
    return locator.filter({ visible: true });
  }

  private async visibleElementState(candidate: Locator): Promise<{
    name: string;
    label: string;
    disabled: boolean;
    value: string | null;
    checked: boolean | null;
    pressed: boolean | null;
  }> {
    return candidate.evaluate((element) => {
      const labelledBy = (element.getAttribute('aria-labelledby') ?? '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
        .filter(Boolean)
        .join(' ');
      const associatedLabels = 'labels' in element
        ? Array.from((element as HTMLInputElement).labels ?? [])
          .map((label) => label.textContent?.trim() ?? '')
          .filter(Boolean)
          .join(' ')
        : '';
      const label = labelledBy || element.getAttribute('aria-label')?.trim() || associatedLabels;
      const innerText = element instanceof HTMLElement ? element.innerText.trim() : '';
      const name = label || innerText || element.getAttribute('placeholder')?.trim() || '';
      const value = element instanceof HTMLSelectElement
        ? element.selectedOptions[0]?.textContent?.trim() ?? element.value
        : element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? element.value
          : null;
      const checked = element instanceof HTMLInputElement
        && (element.type === 'checkbox' || element.type === 'radio')
        ? element.checked
        : null;
      const pressedAttribute = element.getAttribute('aria-pressed');
      const disabled = 'disabled' in element
        ? Boolean((element as HTMLButtonElement).disabled)
        : element.getAttribute('aria-disabled') === 'true';
      return {
        name,
        label,
        disabled,
        value,
        checked,
        pressed: pressedAttribute === null ? null : pressedAttribute === 'true',
      };
    }, undefined, { timeout: SNAPSHOT_CONTROL_TIMEOUT_MS });
  }

  async open(route: string): Promise<VisibleUiSnapshot> {
    const requested = new URL(safeRoute(route, this.options.baseUrl, this.options.allowedRoutes));
    const current = new URL(this.options.page.url());
    const protectedSearch = this.options.protectedSearches?.get(requested.pathname);
    if (protectedSearch) {
      if (requested.search && requested.search !== protectedSearch) {
        throw new Error(`Browser tool cannot replace the protected query scope for ${requested.pathname}.`);
      }
      requested.search = protectedSearch;
    } else if (!requested.search && requested.pathname === current.pathname) {
      requested.search = current.search;
    }
    const path = requested.toString();
    this.options.record?.('open', path);
    await this.options.page.goto(path, { waitUntil: 'domcontentloaded' });
    await this.options.page.locator('#main').waitFor({ state: 'visible' });
    return this.snapshot();
  }

  async snapshot(): Promise<VisibleUiSnapshot> {
    this.assertCurrentRouteAllowed();
    const main = await this.interactionRoot();
    const controls: VisibleControl[] = [];
    for (const role of CONTROL_ROLES) {
      const candidates = await main.getByRole(role).all();
      for (const candidate of candidates.slice(0, Math.max(0, CONTROL_LIMIT - controls.length))) {
        try {
          if (!(await candidate.isVisible())) continue;
          const state = await this.visibleElementState(candidate);
          controls.push({
            role,
            name: redactText(state.name).slice(0, 300),
            disabled: state.disabled,
            value: state.value === null ? null : redactText(state.value).slice(0, 500),
            checked: state.checked,
            pressed: state.pressed,
          });
        } catch {
          // The action may replace the current screen while this snapshot is being collected.
        }
      }
      if (controls.length >= CONTROL_LIMIT) break;
    }
    const labeledControls: VisibleLabeledControl[] = [];
    const labelCandidates = await main.locator('input:not([type="hidden"]), select, textarea').all();
    for (const candidate of labelCandidates.slice(0, CONTROL_LIMIT)) {
      try {
        if (!(await candidate.isVisible())) continue;
        const state = await this.visibleElementState(candidate);
        if (!state.label) continue;
        labeledControls.push({
          label: redactText(state.label).slice(0, 300),
          disabled: state.disabled,
          value: state.value === null ? null : redactText(state.value).slice(0, 500),
          checked: state.checked,
        });
      } catch {
        // Ignore controls detached by a concurrent React render; the next snapshot sees the new DOM.
      }
    }
    const heading = await main.getByRole('heading').first()
      .textContent({ timeout: SNAPSHOT_CONTROL_TIMEOUT_MS }).catch(() => null);
    return {
      contentOrigin: 'untrusted-application-ui',
      url: await this.currentUrl(),
      title: redactText(await this.options.page.title()),
      heading: heading ? redactText(heading.trim()) : null,
      visibleText: redactText((await main.innerText({ timeout: SNAPSHOT_CONTROL_TIMEOUT_MS }).catch(() => '')).slice(0, SNAPSHOT_LIMIT)),
      controls,
      labeledControls,
    };
  }

  async click(target: SafeTarget): Promise<VisibleUiSnapshot> {
    this.options.record?.('click', targetDescription(target));
    let fileChooserOpened = false;
    const markFileChooser = () => { fileChooserOpened = true; };
    this.options.page.on('filechooser', markFileChooser);
    try {
      await (await this.unique(target)).click();
    } finally {
      this.options.page.off?.('filechooser', markFileChooser);
    }
    if (fileChooserOpened) throw new Error('file_chooser_requires_upload_action');
    return this.snapshot();
  }

  async fill(target: SafeTarget, value: string): Promise<VisibleUiSnapshot> {
    this.options.record?.('fill', `${targetDescription(target)} (${value.length} chars)`);
    await (await this.unique(target)).fill(value);
    return this.snapshot();
  }

  async select(target: SafeTarget, option: string): Promise<VisibleUiSnapshot> {
    this.options.record?.('select', `${targetDescription(target)} (${option.length} chars)`);
    const locator = await this.unique(target);
    await locator.selectOption({ label: option }).catch(() => locator.selectOption(option));
    return this.snapshot();
  }

  async upload(target: SafeTarget, fixtureId: string): Promise<VisibleUiSnapshot> {
    const path = this.options.fixtures[fixtureId];
    if (!path) throw new Error(`Unknown synthetic fixture id: ${fixtureId}`);
    this.options.record?.('upload', `${targetDescription(target)} fixture=${safeArtifactName(fixtureId, 'fixture')}`);
    const control = await this.unique(target);
    const [chooser] = await Promise.all([
      this.options.page.waitForEvent('filechooser'),
      control.click(),
    ]);
    await chooser.setFiles(path);
    return this.snapshot();
  }

  async press(key: SafeKey): Promise<VisibleUiSnapshot> {
    this.options.record?.('press', key);
    await this.options.page.keyboard.press(key);
    return this.snapshot();
  }

  async scroll(direction: 'up' | 'down'): Promise<VisibleUiSnapshot> {
    this.options.record?.('scroll', direction);
    await this.options.page.mouse.wheel(0, direction === 'down' ? 600 : -600);
    return this.snapshot();
  }

  async waitForText(text: string, timeoutMs = 10_000): Promise<VisibleUiSnapshot> {
    this.options.record?.('waitForText', `${text.length} chars`);
    await (await this.interactionRoot()).getByText(text, { exact: false }).first()
      .waitFor({ state: 'visible', timeout: timeoutMs });
    return this.snapshot();
  }

  async screenshot(label: string): Promise<string> {
    this.assertCurrentRouteAllowed();
    await mkdir(this.options.screenshotDirectory, { recursive: true });
    const sequence = String(++this.screenshotSequence).padStart(3, '0');
    const safeLabel = safeArtifactName(redactText(label), 'screenshot');
    const path = join(this.options.screenshotDirectory, `${sequence}-${safeLabel}.png`);
    await this.options.page.screenshot({
      path,
      fullPage: true,
      mask: [...sensitiveScreenshotMasks(this.options.page)],
    });
    this.options.record?.('screenshot', `${sequence}-${safeLabel}`);
    return path;
  }

  private async visibleNotifications(): Promise<Array<{
    kind: 'success' | 'error';
    text: string;
  }>> {
    const candidates = await this.options.page.locator('[role="alert"], [role="status"], [aria-live]').all();
    const notifications: Array<{ kind: 'success' | 'error'; text: string }> = [];
    for (const candidate of candidates.slice(0, 50)) {
      if (!await candidate.isVisible().catch(() => false)) continue;
      const text = redactText((await candidate.innerText().catch(() => '')).trim()).slice(0, 1_000);
      if (!text) continue;
      const role = await candidate.getAttribute('role');
      const live = await candidate.getAttribute('aria-live');
      notifications.push({
        kind: role === 'alert' || live === 'assertive' ? 'error' : 'success',
        text,
      });
    }
    return notifications;
  }

  async capturePotentialMutation<T>(
    input: BrowserMutationCaptureInput,
    action: () => Promise<T>,
  ): Promise<BrowserMutationCaptureResult<T>> {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const routeBefore = await this.currentUrl();
    const preNotifications = await this.visibleNotifications();
    const preNotificationKeys = new Set(preNotifications.map(({ kind, text }) => `${kind}:${text}`));
    const preScreenshot = await this.screenshot(`${input.actionId}-pre`);
    const entries: MutableNetworkEvidence[] = [];
    const byRequest = new Map<Request, MutableNetworkEvidence>();
    const bodyTasks = new Set<Promise<void>>();
    let lastNetworkActivity = Date.now();

    const onRequest = (request: Request): void => {
      const classification = networkClassification(request);
      if (!classification.capture) return;
      const now = Date.now();
      const entry: MutableNetworkEvidence = {
        requestId: `${input.actionId}:${entries.length + 1}`,
        method: request.method().toUpperCase(),
        pathname: new URL(request.url()).pathname,
        resourceType: request.resourceType(),
        startedAt: new Date(now).toISOString(),
        startedAtMs: now,
        completedAt: null,
        durationMs: null,
        status: null,
        failure: null,
        mutationCandidate: classification.mutationCandidate,
        responseBodyParsed: false,
        responseFacts: {},
        entityRefs: [],
      };
      entries.push(entry);
      byRequest.set(request, entry);
      lastNetworkActivity = now;
    };
    const onResponse = (response: Response): void => {
      const entry = byRequest.get(response.request());
      if (!entry) return;
      const now = Date.now();
      entry.completedAt = new Date(now).toISOString();
      entry.durationMs = now - entry.startedAtMs;
      entry.status = response.status();
      lastNetworkActivity = now;
      const contentType = response.headers()['content-type'] ?? '';
      if (!/\b(?:application\/json|[^;]+\+json)\b/i.test(contentType)) return;
      const task = (async () => {
        try {
          const body = await response.text();
          if (body.length > MAX_RESPONSE_BODY_CHARS) return;
          const parsed: unknown = JSON.parse(body);
          entry.responseBodyParsed = true;
          entry.entityRefs = extractResponseEntityRefs(parsed, entry.pathname);
          entry.responseFacts = extractResponseFacts(parsed);
        } catch {
          // A body that Playwright cannot retain is evidence-unavailable, never inferred success.
        }
      })();
      bodyTasks.add(task);
      void task.finally(() => bodyTasks.delete(task));
    };
    const onRequestFailed = (request: Request): void => {
      const entry = byRequest.get(request);
      if (!entry) return;
      const now = Date.now();
      entry.completedAt = new Date(now).toISOString();
      entry.durationMs = now - entry.startedAtMs;
      entry.failure = redactText(request.failure()?.errorText ?? 'unknown network failure');
      lastNetworkActivity = now;
    };

    this.options.page.on('request', onRequest);
    this.options.page.on('response', onResponse);
    this.options.page.on('requestfailed', onRequestFailed);
    let value: T | null = null;
    let actionError: string | null = null;
    try {
      value = await action();
    } catch (error) {
      actionError = redactText(error instanceof Error ? error.message : 'browser action failed').slice(0, 1_000);
    }
    const deadline = Date.now() + NETWORK_CAPTURE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const pending = [...byRequest.values()].some(({ completedAt }) => completedAt === null);
      const mutationObserved = entries.some(({ mutationCandidate }) => mutationCandidate);
      if (networkCaptureSettled(
        input.expectMutation,
        mutationObserved,
        pending,
        Date.now() - lastNetworkActivity,
      )) break;
      await this.options.page.waitForTimeout(50);
    }
    await Promise.allSettled([...bodyTasks]);
    this.options.page.off('request', onRequest);
    this.options.page.off('response', onResponse);
    this.options.page.off('requestfailed', onRequestFailed);

    const routeAfter = await this.currentUrl();
    const postNotifications = await this.visibleNotifications();
    const notification = [...postNotifications].reverse().find(
      ({ kind, text }) => !preNotificationKeys.has(`${kind}:${text}`),
    ) ?? null;
    const postScreenshot = await this.screenshot(`${input.actionId}-post`);
    const entityRefs: BrowserMutationEntityRef[] = [];
    const entityKeys = new Set<string>();
    for (const entry of entries) {
      if (entry.status === null || entry.status < 200 || entry.status >= 300) continue;
      for (const ref of entry.entityRefs) {
        const key = `${ref.kind}:${ref.visibleReference.toLowerCase()}`;
        if (entityKeys.has(key)) continue;
        entityKeys.add(key);
        entityRefs.push(ref);
      }
    }
    const actionDirectory = this.options.actionEvidenceDirectory
      ?? join(this.options.screenshotDirectory, '..', 'actions');
    await mkdir(actionDirectory, { recursive: true });
    const artifactPath = join(actionDirectory, `${input.actionId}.json`);
    const evidence: BrowserMutationEvidence = {
      source: 'browser-action',
      actionId: input.actionId,
      step: input.step,
      role: input.role,
      scenarioId: input.scenarioId,
      actionType: input.actionType,
      description: redactText(input.description).slice(0, 1_000),
      expectedMutation: redactText(input.expectedMutation).slice(0, 4_000),
      startedAt,
      completedAt: new Date().toISOString(),
      routeBefore,
      routeAfter,
      preScreenshot,
      postScreenshot,
      notification: notification ?? { kind: 'none', text: null },
      network: entries.map(({ startedAtMs: _startedAtMs, ...entry }) => entry),
      entityRefsSource: 'response-body',
      entityRefs,
      hasMutationRequest: hasObservedMutationRequest(entries),
      actionError,
      evidenceRefs: [preScreenshot, postScreenshot, artifactPath],
    };
    await writeFile(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    this.options.record?.('action-verification', input.actionId);
    return { value, evidence };
  }

  async currentUrl(): Promise<string> {
    return this.assertCurrentRouteAllowed();
  }
}

export function createSafeBrowserTools(options: BrowserToolsOptions): SafeBrowserTools {
  return new SafeBrowserToolsImpl(options);
}

export type BrowserTools = SafeBrowserTools;
export const createBrowserTools = createSafeBrowserTools;
