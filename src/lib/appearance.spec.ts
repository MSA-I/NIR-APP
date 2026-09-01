/**
 * The appearance module, and specifically the four things about it that fail SILENTLY.
 *
 * A theme is unusually good at breaking without complaining: nothing throws, nothing logs, the page
 * just looks wrong. These tests pin the parts where that is true —
 *
 *   · the `data-theme-swap` flag must come OFF. It suppresses every transition in the product while
 *     it is set, so a flag that sticks leaves the whole application permanently motionless, and no
 *     error is raised at any point.
 *   · a throwing `localStorage` (a private window, storage denied) must not stop the theme being
 *     applied. The memory of the choice is expendable; the choice itself is not.
 *   · `readTheme` must treat anything that is not exactly `'dark'` as light, because the attribute
 *     is written by an inline script in `index.html` that this module never sees.
 *   · the browser chrome must follow the palette rather than a transcribed copy of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_THEME, THEME_STORAGE_KEY, applyTheme, readTheme } from './appearance';

/** Two frames, which is what `applyTheme` waits before dropping the swap flag. */
const twoFrames = () => new Promise<void>((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
});

beforeEach(() => {
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themeSwap;
  window.localStorage.clear();
  document.head.querySelector('meta[name="theme-color"]')?.remove();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readTheme', () => {
  it('is light when the attribute is absent — the documented default', () => {
    expect(readTheme()).toBe('light');
    expect(DEFAULT_THEME).toBe('light');
  });

  it('is dark only for exactly "dark"', () => {
    document.documentElement.dataset.theme = 'dark';
    expect(readTheme()).toBe('dark');
    // The attribute is written by a hand-rolled inline script in index.html; anything it could
    // conceivably put there other than 'dark' has to land on the safe side.
    document.documentElement.dataset.theme = 'Dark';
    expect(readTheme()).toBe('light');
    document.documentElement.dataset.theme = '';
    expect(readTheme()).toBe('light');
  });
});

describe('applyTheme', () => {
  it('sets the attribute, remembers the choice and announces the change', () => {
    const heard: string[] = [];
    const listener = (event: Event) => heard.push((event as CustomEvent<string>).detail);
    window.addEventListener('inplace:appearance', listener);

    applyTheme('dark');

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(heard).toEqual(['dark']);
    window.removeEventListener('inplace:appearance', listener);
  });

  it('raises the transition-suppression flag and TAKES IT OFF AGAIN', async () => {
    applyTheme('dark');
    // While it is set, `:root[data-theme-swap] *` kills every transition in the product.
    expect(document.documentElement.hasAttribute('data-theme-swap')).toBe(true);

    await twoFrames();

    // `delete`, not `= ''`: an empty data attribute still matches the selector, which would leave
    // the entire application without motion for the rest of the session.
    expect(document.documentElement.hasAttribute('data-theme-swap')).toBe(false);
  });

  it('still applies the theme when storage refuses', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });

    expect(() => applyTheme('dark')).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('points the browser chrome at the resolved --color-canvas, not at a copy of it', () => {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    meta.setAttribute('content', 'stale');
    document.head.appendChild(meta);
    // jsdom resolves no stylesheet, so the variable comes from the element itself — which is enough
    // to prove the value is READ rather than transcribed.
    document.documentElement.style.setProperty('--color-canvas', 'oklch(13% 0.028 209)');

    applyTheme('dark');

    expect(meta.getAttribute('content')).toBe('oklch(13% 0.028 209)');
    document.documentElement.style.removeProperty('--color-canvas');
  });

  it('leaves the chrome alone rather than blanking it when the variable resolves empty', () => {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    meta.setAttribute('content', 'oklch(96.88% 0.0028 128)');
    document.head.appendChild(meta);

    applyTheme('dark');

    // A previous colour is a better answer than an empty one.
    expect(meta.getAttribute('content')).toBe('oklch(96.88% 0.0028 128)');
  });
});
