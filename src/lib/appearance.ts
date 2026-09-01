/**
 * Which of the two grounds the product is standing on.
 *
 * A DIFFERENT FILE FROM `src/lib/theme.ts`, deliberately and permanently. That one is
 * `chartTheme()` — resolved chart colours for recharts — and the marketing repository this control
 * was ported from happens to keep its appearance logic in a file of exactly that name. Porting it
 * across without renaming would have overwritten the chart colours with a theme switch, which is
 * the kind of mistake that looks like a merge accident forever afterwards. `appearance` is what
 * this concern is called here.
 *
 * All of the switching happens in CSS: `:root[data-theme='dark']` in `src/index.css` redeclares the
 * same token names, and Tailwind compiles every utility to `var(--color-…)`, so one attribute on
 * `<html>` moves the authored stylesheet and every utility class together. This module therefore
 * does four small things and no more: read the attribute, write the attribute, remember the choice,
 * and let the two kinds of consumer that must KNOW the theme (the switch, and anything that reads
 * resolved colours in JS rather than through CSS) hear about a change.
 *
 * IT DOES NOT PERSIST TO THE ACCOUNT. That is `appearancePersistence` + `useThemeChoice`, kept out
 * of here so this module stays free of Supabase — it is the one `check:appearance-scope` allows to
 * write `data-theme`, and the narrower it is the more that permission is worth.
 *
 * THE FIRST WRITE DOES NOT HAPPEN HERE. It happens in the inline script in `index.html`, before the
 * first paint, because a React effect runs after it and a person who chose dark would watch a white
 * page flash past on every cold start.
 */

import { useEffect, useState } from 'react';
/**
 * The VALUES live in `theme-choice.ts`, which touches nothing; only the side effects live here.
 *
 * That split is not tidiness. `types.ts` needs `Theme` (since `0283`, `profiles.theme` is a column),
 * the assistant's Deno contract tests import `../types`, and Deno type-checks the graph with no
 * `lib: dom` — so when this file owned the type it was pulled into a DOM-free checker and failed on
 * `document`, `HTMLMetaElement` and `requestAnimationFrame`, globals it is entitled to use.
 * `npm run typecheck` passed throughout, because the app's tsconfig includes `lib: dom`.
 * Re-exported here so every existing `from './appearance'` import keeps working.
 */
import { DEFAULT_THEME, THEMES, isTheme, type Theme } from './theme-choice';

export { DEFAULT_THEME, THEMES, isTheme, type Theme };

/** Same shape as the locale key beside it, so the two preferences read alike in devtools. */
export const THEME_STORAGE_KEY = 'inplace.theme';

/**
 * The product's home state is LIGHT — declared in `theme-choice.ts`, reasoned about here.
 *
 * Unlike the marketing page, and the difference is not an oversight: this is a working surface that
 * people sit in front of for whole shifts under office lighting, and `DESIGN.md`'s north star is
 * warm paper. Dark is a choice here, not the default — which also means the entire existing product
 * keeps rendering exactly as it did for anyone who never touches the switch.
 */

/**
 * The browser chrome above the page follows `--color-canvas`, READ FROM THE STYLESHEET rather than
 * transcribed here.
 *
 * The first draft of this file kept the two grounds as hex literals, which `check:tokens` refuses in
 * product source — correctly, and for exactly the reason that matters here: a transcribed colour is
 * a second source of truth that a repaint will forget. Resolving the variable after the attribute is
 * set costs one `getComputedStyle` per press of the switch and can never disagree with the palette.
 *
 * Returns `null` when the variable resolves empty, and the caller then leaves the tag alone: the
 * previous value is a better answer than an empty one.
 */
function chromeColour(): string | null {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--color-canvas').trim();
  return value === '' ? null : value;
}

const EVENT = 'inplace:appearance';

/** What `<html>` currently says, which the pre-paint script has already decided. */
export function readTheme(): Theme {
  if (typeof document === 'undefined') return DEFAULT_THEME;
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : DEFAULT_THEME;
}

/**
 * The choice as STORAGE holds it, which is not the same question as `readTheme`.
 *
 * `readTheme` answers "what is the page showing" and always answers something. This answers "did
 * this browser remember a decision", and `null` is a real answer — nobody chose here yet.
 *
 * It lives in this module rather than in the one that needs it (`appearancePersistence`, to
 * reconcile a choice made before sign-in) because `check:appearance-scope` allows exactly one file
 * to touch the storage key, and that rule is worth more than the convenience of reading it locally.
 * Throws are swallowed: a private window with storage denied has no remembered choice, which is
 * exactly what `null` says.
 */
export function readStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    // `isTheme` rather than an inline comparison: the list of themes has one home, and a third
    // theme would otherwise be accepted by the type and silently rejected by this line.
    return isTheme(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;

  /**
   * A THEME SWAP IS NOT AN ANIMATION, and it plays as one unless it is stopped.
   *
   * Most of this product's controls transition their own `color` and `border-color`, and the grounds
   * behind them do not, so for the length of those transitions the page has already turned and the
   * lettering has not: dark ink on the new dark ground, unreadable, for a third of a second on
   * every press of the switch. The flag below suppresses every transition while the attribute
   * changes and comes off two frames later — long enough for the new colours to be painted, short
   * enough that a hover or focus begun inside that window does not lose its own motion.
   *
   * `delete` rather than `= ''`: an empty data attribute is still present, and would leave the whole
   * product permanently motionless.
   */
  root.dataset.themeSwap = '';
  root.dataset.theme = theme;
  // AFTER the attribute, never before: the value being read is the one the new theme resolves.
  const chrome = chromeColour();
  if (chrome !== null) {
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', chrome);
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // A private window with storage denied still gets the theme it asked for; only the memory of it
    // is lost, and the account copy (see `AppearanceProvider`) covers the next visit anyway.
  }
  window.dispatchEvent(new CustomEvent<Theme>(EVENT, { detail: theme }));
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      delete root.dataset.themeSwap;
    });
  });
}

/** Subscribe to theme changes without owning the value. Returns the active theme. */
export function useThemeValue(): Theme {
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);
  useEffect(() => {
    setTheme(readTheme());
    const sync = () => setTheme(readTheme());
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);
  return theme;
}
