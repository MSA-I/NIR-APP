import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { redactText, safeArtifactName, sensitiveScreenshotMasks } from './redaction.ts';

export type SafeTarget =
  | { readonly kind: 'role'; readonly role: SafeControlRole; readonly name: string; readonly exact?: boolean }
  | { readonly kind: 'label'; readonly label: string; readonly exact?: boolean }
  | { readonly kind: 'text'; readonly text: string; readonly exact?: boolean };

export type SafeControlRole =
  | 'button'
  | 'link'
  | 'textbox'
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
}

export interface VisibleUiSnapshot {
  readonly contentOrigin: 'untrusted-application-ui';
  readonly url: string;
  readonly title: string;
  readonly heading: string | null;
  readonly visibleText: string;
  readonly controls: readonly VisibleControl[];
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
}

export interface BrowserToolsOptions {
  readonly page: Page;
  readonly baseUrl: string;
  readonly allowedRoutes: readonly string[];
  readonly fixtures: Readonly<Record<string, string>>;
  readonly screenshotDirectory: string;
  readonly record?: (action: string, detail: string) => void;
}

const SNAPSHOT_LIMIT = 12_000;
const CONTROL_LIMIT = 100;
const CONTROL_ROLES: readonly SafeControlRole[] = [
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'menuitem', 'tab',
];

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
  return `${url.pathname}${url.search}`;
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

  private locator(target: SafeTarget): Locator {
    if (target.kind === 'role') {
      return this.options.page.getByRole(target.role, { name: target.name, exact: target.exact });
    }
    if (target.kind === 'label') {
      return this.options.page.getByLabel(target.label, { exact: target.exact });
    }
    return this.options.page.getByText(target.text, { exact: target.exact });
  }

  private async unique(target: SafeTarget): Promise<Locator> {
    const locator = this.locator(target);
    await locator.first().waitFor({ state: 'visible' });
    const visible = await locator.filter({ visible: true }).count();
    if (visible !== 1) throw new Error(`Safe browser target is not unique: ${targetDescription(target)}`);
    return locator.filter({ visible: true });
  }

  async open(route: string): Promise<VisibleUiSnapshot> {
    const path = safeRoute(route, this.options.baseUrl, this.options.allowedRoutes);
    this.options.record?.('open', path);
    await this.options.page.goto(path, { waitUntil: 'domcontentloaded' });
    await this.options.page.locator('#main').waitFor({ state: 'visible' });
    return this.snapshot();
  }

  async snapshot(): Promise<VisibleUiSnapshot> {
    this.assertCurrentRouteAllowed();
    const main = this.options.page.locator('#main');
    const controls: VisibleControl[] = [];
    for (const role of CONTROL_ROLES) {
      const candidates = await this.options.page.getByRole(role).all();
      for (const candidate of candidates.slice(0, Math.max(0, CONTROL_LIMIT - controls.length))) {
        if (!(await candidate.isVisible())) continue;
        const name = (await candidate.getAttribute('aria-label'))
          ?? (await candidate.getAttribute('placeholder'))
          ?? (await candidate.innerText().catch(() => ''))
          ?? '';
        controls.push({ role, name: redactText(name.trim()).slice(0, 300), disabled: await candidate.isDisabled() });
      }
      if (controls.length >= CONTROL_LIMIT) break;
    }
    const heading = await main.getByRole('heading', { level: 1 }).first().textContent().catch(() => null);
    return {
      contentOrigin: 'untrusted-application-ui',
      url: await this.currentUrl(),
      title: redactText(await this.options.page.title()),
      heading: heading ? redactText(heading.trim()) : null,
      visibleText: redactText((await main.innerText()).slice(0, SNAPSHOT_LIMIT)),
      controls,
    };
  }

  async click(target: SafeTarget): Promise<VisibleUiSnapshot> {
    this.options.record?.('click', targetDescription(target));
    await (await this.unique(target)).click();
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
    await (await this.unique(target)).setInputFiles(path);
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
    await this.options.page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: timeoutMs });
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

  async currentUrl(): Promise<string> {
    return this.assertCurrentRouteAllowed();
  }
}

export function createSafeBrowserTools(options: BrowserToolsOptions): SafeBrowserTools {
  return new SafeBrowserToolsImpl(options);
}

export type BrowserTools = SafeBrowserTools;
export const createBrowserTools = createSafeBrowserTools;
