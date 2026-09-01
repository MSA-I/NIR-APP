import { useCallback } from 'react';
import { useT } from './LocaleProvider';
import { persistLocaleChoice } from './localePersistence';
import type { Locale } from './locale';

/**
 * Choosing a reading language, written once for every control that offers it.
 *
 * Both the `<select>` on /settings and the row in the account menu call this and nothing else, so
 * the two can never drift: same order (screen first, account second), same coalescing queue, same
 * failure reporting. Before this existed each control had its own copy of the handler — and a
 * second copy of a rule is a second chance to get it wrong.
 *
 * THE SCREEN SWITCHES FIRST, ALWAYS, and the persist is a separate step whose failure is reported
 * and nothing more: a switch that silently did not happen reads as a broken control and the person
 * clicks again. A switch that happened but was not remembered costs them one click on their next
 * visit.
 */
export function useLocaleChoice(): (next: Locale) => void {
  const { setLocale } = useT();
  return useCallback((next: Locale) => {
    /**
     * NO EQUALITY GUARD, and its removal is a fix rather than a simplification.
     *
     * `if (next === locale) return` looked harmless and was not: `profiles.locale` is null until a
     * person chooses, and 0213 keeps that null distinct from `'he'` precisely to mean "never chose,
     * detection may keep deciding". So a Hebrew speaker whose browser already resolved to Hebrew
     * could never PIN it — the choice they wanted to make was the one the guard threw away, and on
     * their next device detection got another go and could answer differently.
     *
     * Nothing is spent by dropping it. `setLocale` to the current value is a no-op state write that
     * React bails out of, and the queue already refuses a write that matches the stored value — so
     * the redundant case is handled where it belongs, by the thing that knows what is stored.
     */
    setLocale(next);
    persistLocaleChoice(next);
  }, [setLocale]);
}
