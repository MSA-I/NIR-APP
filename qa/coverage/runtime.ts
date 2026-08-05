import type { Page } from '@playwright/test';

/**
 * The runtime half of the coverage inventory.
 *
 * Everything here answers "what is actually on the screen right now", which is the only thing
 * allowed to confirm or refute the static manifest. The DOM walk runs as a single evaluate so a
 * page with three hundred controls costs one round trip, and it computes the accessible name the
 * same way the static extractor guesses it, so the two can be compared without the comparison
 * itself introducing a difference.
 */

export interface RuntimeControl {
  readonly key: string;
  readonly tag: string;
  readonly semanticRole: string;
  readonly accessibleName: string;
  readonly visibleLabel: string;
  readonly disabled: boolean;
  readonly visible: boolean;
  readonly inputType: string | null;
  readonly testId: string | null;
  readonly value: string | null;
  readonly defaultValue: string | null;
  readonly required: boolean;
}

export interface RuntimeSnapshot {
  readonly controls: readonly RuntimeControl[];
  readonly headings: readonly { level: number; text: string }[];
  readonly truncated: boolean;
  readonly landmarkCount: number;
  readonly tableCount: number;
  readonly formCount: number;
  readonly openDialogCount: number;
}

const MAX_CONTROLS_PER_ROUTE = 400;

/**
 * Read every interactive control the user can reach. `page.evaluate` is used for inspection only:
 * it never clicks, submits or mutates, so a snapshot can never change what it is measuring.
 */
export async function snapshotControls(page: Page, limit = MAX_CONTROLS_PER_ROUTE): Promise<RuntimeSnapshot> {
  return page.evaluate((maxControls: number) => {
    const SELECTOR = [
      'button',
      'a[href]',
      'input',
      'select',
      'textarea',
      'summary',
      '[role="button"]',
      '[role="link"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="switch"]',
      '[role="combobox"]',
      '[role="searchbox"]',
      '[contenteditable="true"]',
    ].join(',');

    const text = (node: Element | null): string => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();

    const implicitRole = (element: Element): string => {
      const tag = element.tagName.toLowerCase();
      if (tag === 'a') return element.hasAttribute('href') ? 'link' : 'generic';
      if (tag === 'button' || tag === 'summary') return 'button';
      if (tag === 'select') return (element as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        const type = ((element as HTMLInputElement).type || 'text').toLowerCase();
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
        if (type === 'search') return 'searchbox';
        if (type === 'file') return 'button';
        return 'textbox';
      }
      return 'generic';
    };

    // Mirrors the static extractor's precedence so a mismatch means the UI differs, not the rule.
    const accessibleName = (element: Element): string => {
      const label = element.getAttribute('aria-label');
      if (label && label.trim()) return label.trim();
      const labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy) {
        const parts = labelledBy
          .split(/\s+/)
          .map((id) => text(document.getElementById(id)))
          .filter(Boolean);
        if (parts.length) return parts.join(' ');
      }
      const id = element.getAttribute('id');
      if (id) {
        const explicit = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (explicit && text(explicit)) return text(explicit);
      }
      const wrapping = element.closest('label');
      if (wrapping && text(wrapping)) return text(wrapping);
      const own = text(element);
      if (own) return own;
      const placeholder = element.getAttribute('placeholder');
      if (placeholder && placeholder.trim()) return placeholder.trim();
      const title = element.getAttribute('title');
      if (title && title.trim()) return title.trim();
      const alt = element.querySelector('img[alt]')?.getAttribute('alt');
      if (alt && alt.trim()) return alt.trim();
      return '';
    };

    const isVisible = (element: Element): boolean => {
      const style = window.getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
      if (element.getAttribute('aria-hidden') === 'true') return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const elements = [...document.querySelectorAll(SELECTOR)];
    const truncated = elements.length > maxControls;
    const seen = new Map<string, number>();
    const controls = elements.slice(0, maxControls).map((element) => {
      const tag = element.tagName.toLowerCase();
      const role = element.getAttribute('role') ?? implicitRole(element);
      const name = accessibleName(element);
      const base = `${role}|${name}`;
      const ordinal = (seen.get(base) ?? 0) + 1;
      seen.set(base, ordinal);
      const input = element as HTMLInputElement;
      const isField = tag === 'input' || tag === 'textarea' || tag === 'select';
      return {
        key: `${base}|${ordinal}`,
        tag,
        semanticRole: role,
        accessibleName: name,
        visibleLabel: text(element),
        disabled:
          element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
        visible: isVisible(element),
        inputType: tag === 'input' ? (input.type || 'text').toLowerCase() : null,
        testId: element.getAttribute('data-testid'),
        // Field values can carry business data. Only presence and length are reported.
        value: isField ? (input.value ? `«${input.value.length} תווים»` : '') : null,
        defaultValue: isField ? (input.defaultValue ? `«${input.defaultValue.length} תווים»` : '') : null,
        required: element.hasAttribute('required') || element.getAttribute('aria-required') === 'true',
      };
    });

    return {
      controls,
      headings: [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
        .slice(0, 60)
        .map((heading) => ({ level: Number(heading.tagName.slice(1)), text: text(heading) })),
      truncated,
      landmarkCount: document.querySelectorAll('main,nav,header,footer,[role="main"],[role="navigation"]').length,
      tableCount: document.querySelectorAll('table,[role="table"],[role="grid"]').length,
      formCount: document.querySelectorAll('form').length,
      openDialogCount: document.querySelectorAll('[role="dialog"],dialog[open]').length,
    };
  }, limit);
}

/** Horizontal overflow is the responsive defect that actually hides controls from a user. */
export async function measureOverflow(page: Page): Promise<{ scrollWidth: number; clientWidth: number; overflow: boolean }> {
  return page.evaluate(() => {
    const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    const clientWidth = document.documentElement.clientWidth;
    // A single pixel of rounding is not a defect; anything a finger can feel is.
    return { scrollWidth, clientWidth, overflow: scrollWidth - clientWidth > 2 };
  });
}

/**
 * Touch targets below the platform minimum, measured the way the existing gate measures them.
 *
 * Scope and threshold are copied from qa/deterministic/accessibility.spec.ts on purpose: inside
 * `#main`, enabled controls only, 44px. Measuring the whole document at 40px instead flags the
 * skip link — which is off-screen until it receives focus — and produces a contradiction with a
 * gate assertion that passes. Two methods disagreeing is not two findings; it is one wrong method.
 */
export async function undersizedTouchTargets(page: Page, minimum = 44): Promise<string[]> {
  return page.evaluate((min: number) => {
    const results: string[] = [];
    const scope = document.querySelector('#main') ?? document.body;
    for (const element of [...scope.querySelectorAll('#main button:not([disabled]), #main a[href], button:not([disabled]), a[href]')]) {
      if (!scope.contains(element)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = window.getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      // Off-canvas helpers (skip links) are positioned outside the viewport until focused.
      if (rect.bottom < 0 || rect.right < 0 || rect.left > window.innerWidth) continue;
      if (rect.height < min || rect.width < min) {
        const name = (element.getAttribute('aria-label') ?? element.textContent ?? '').replace(/\s+/g, ' ').trim();
        results.push(`${element.tagName.toLowerCase()}:${name.slice(0, 40)}:${Math.round(rect.width)}x${Math.round(rect.height)}`);
      }
    }
    return results.slice(0, 25);
  }, minimum);
}

export interface ServerProbeResult {
  readonly endpoint: string;
  readonly status: number;
  readonly rows: number | null;
  readonly error: string | null;
}

/**
 * Ask the API the same question the screen would, using the signed-in role's own token.
 *
 * The request is issued from inside the page so the access token never crosses into the test
 * process, the report or a trace; only the status code and a row count come back. This is what
 * turns "the button is hidden" into "the server also refuses", which is the difference between a
 * tidy UI and an actual authorization boundary.
 */
export async function probeServerAccess(
  page: Page,
  supabaseUrl: string,
  anonKey: string,
  table: string,
): Promise<ServerProbeResult> {
  return page.evaluate(
    async ([base, key, target]: [string, string, string]) => {
      const endpoint = `${base}/rest/v1/${target}?select=id&limit=1`;
      const token = (() => {
        for (let index = 0; index < window.localStorage.length; index += 1) {
          const storageKey = window.localStorage.key(index);
          if (!storageKey || !storageKey.startsWith('sb-')) continue;
          try {
            const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? 'null');
            if (parsed && typeof parsed.access_token === 'string') return parsed.access_token as string;
          } catch {
            continue;
          }
        }
        return null;
      })();
      if (!token) return { endpoint: `/rest/v1/${target}`, status: -1, rows: null, error: 'no-session-token' };
      try {
        const response = await fetch(endpoint, {
          headers: { apikey: key, Authorization: `Bearer ${token}`, Accept: 'application/json' },
        });
        const status = response.status;
        let rows: number | null = null;
        try {
          const body: unknown = await response.json();
          rows = Array.isArray(body) ? body.length : null;
        } catch {
          rows = null;
        }
        // Never return the body: it is tenant data. Only the shape of the answer travels back.
        return { endpoint: `/rest/v1/${target}`, status, rows, error: null };
      } catch (error) {
        return {
          endpoint: `/rest/v1/${target}`,
          status: -1,
          rows: null,
          error: error instanceof Error ? error.name : 'fetch-failed',
        };
      }
    },
    [supabaseUrl, anonKey, table] as [string, string, string],
  );
}

/** Focus behaviour of an open dialog, which is what makes a modal usable with a keyboard. */
export async function inspectOpenDialog(page: Page): Promise<{
  present: boolean;
  focusInsideDialog: boolean;
  focusableCount: number;
  hasAccessibleName: boolean;
  hasCloseControl: boolean;
}> {
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"],dialog[open]');
    if (!dialog) {
      return { present: false, focusInsideDialog: false, focusableCount: 0, hasAccessibleName: false, hasCloseControl: false };
    }
    const focusable = dialog.querySelectorAll(
      'button,a[href],input,select,textarea,[tabindex]:not([tabindex="-1"])',
    );
    const label = dialog.getAttribute('aria-label');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    const named = Boolean(
      (label && label.trim()) || (labelledBy && document.getElementById(labelledBy)?.textContent?.trim()),
    );
    const closeControl = [...dialog.querySelectorAll('button')].some((button) => {
      const name = (button.getAttribute('aria-label') ?? button.textContent ?? '').trim();
      return /סגור|סגירה|ביטול|close/i.test(name);
    });
    return {
      present: true,
      focusInsideDialog: document.activeElement ? dialog.contains(document.activeElement) : false,
      focusableCount: focusable.length,
      hasAccessibleName: named,
      hasCloseControl: closeControl,
    };
  });
}

/** Heading order, table semantics and unlabelled fields — the checks Axe reports weakly or not at all. */
export async function inspectSemantics(page: Page): Promise<{
  headingOrderJumps: string[];
  h1Count: number;
  tablesWithoutHeaders: number;
  fieldsWithoutNames: string[];
  imagesWithoutAlt: number;
}> {
  return page.evaluate(() => {
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')];
    const jumps: string[] = [];
    let previous = 0;
    for (const heading of headings) {
      const level = Number(heading.tagName.slice(1));
      if (previous && level > previous + 1) {
        jumps.push(`h${previous}→h${level}: ${(heading.textContent ?? '').trim().slice(0, 40)}`);
      }
      previous = level;
    }
    const tablesWithoutHeaders = [...document.querySelectorAll('table')].filter(
      (table) => table.querySelectorAll('th').length === 0,
    ).length;
    const fieldsWithoutNames = [...document.querySelectorAll('input,select,textarea')]
      .filter((field) => {
        const input = field as HTMLInputElement;
        if (input.type === 'hidden') return false;
        // A field with display:none is not in the accessibility tree at all. The hidden file
        // input behind an upload button is the common case, and calling it an unlabelled field
        // reports one shell control once per route as if it were a finding on every screen.
        const style = window.getComputedStyle(field);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (field.getAttribute('aria-hidden') === 'true') return false;
        if (field.getAttribute('aria-label')?.trim()) return false;
        if (field.getAttribute('aria-labelledby')) return false;
        const id = field.getAttribute('id');
        if (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) return false;
        if (field.closest('label')) return false;
        return true;
      })
      .map((field) => {
        const placeholder = field.getAttribute('placeholder')?.trim();
        // Distinguish "nothing at all" from "placeholder only", which is weaker but not silent.
        const suffix = placeholder ? ` (placeholder בלבד: "${placeholder.slice(0, 30)}")` : ' (ללא שם כלל)';
        return `${field.tagName.toLowerCase()}#${field.getAttribute('id') ?? 'anonymous'}${suffix}`;
      })
      .slice(0, 15);
    return {
      headingOrderJumps: jumps.slice(0, 10),
      h1Count: document.querySelectorAll('h1').length,
      tablesWithoutHeaders,
      fieldsWithoutNames,
      imagesWithoutAlt: [...document.querySelectorAll('img')].filter((image) => !image.hasAttribute('alt')).length,
    };
  });
}
