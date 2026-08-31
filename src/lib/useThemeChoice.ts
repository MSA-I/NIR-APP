import { useCallback } from 'react';
import { applyTheme, readTheme, useThemeValue, type Theme } from './appearance';
import { persistThemeChoice } from './appearancePersistence';

/**
 * Choosing an appearance, written once for every control that offers it.
 *
 * The exact mirror of `useLocaleChoice`, and for the same reason: two preferences of the same shape
 * must not have two shapes of solution. Screen first, unconditionally; account second, through the
 * coalescing queue, whose failure is reported and nothing more.
 *
 * NO EQUALITY GUARD, same as the language. `profiles.theme` is null until a person chooses, and
 * 0268 keeps that null distinct from `'light'` so the product default stays free to change. A guard
 * on "you already see light" would make pinning light unreachable — the one choice that person was
 * trying to express. The queue refuses a write that matches what the server already holds, which is
 * where that decision belongs.
 */
/** Not exported: `useThemeToggle` below is the only caller today, and an exported hook with no
    consumer is dead code that `check:dead-code` would rightly flag. Export it the day a
    settings row wants to set a theme directly rather than flip it. */
function useThemeChoice(): [Theme, (next: Theme) => void] {
  const theme = useThemeValue();
  const choose = useCallback((next: Theme) => {
    applyTheme(next);
    persistThemeChoice(next);
  }, []);
  return [theme, choose];
}

/** The switch's own affordance: flip to the other ground. Reads the attribute, never React state. */
export function useThemeToggle(): [Theme, () => void] {
  const [theme, choose] = useThemeChoice();
  return [theme, () => choose(readTheme() === 'dark' ? 'light' : 'dark')];
}
