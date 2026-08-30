/**
 * The one source of truth for "which language is this session in".
 *
 * The precedence chain is deliberate and each rung answers a case that actually occurs:
 *   stored  — the person went to Settings and chose. Nothing overrides a choice.
 *   query   — `?lang=` — how the supplier portal has always worked (src/portal/i18n.ts:99),
 *             and how a support link can pin a language for a screenshot.
 *   browser — `navigator.language`. The automatic detection this feature was asked for.
 *   he      — the product's base language. An unknown language is not a reason to guess.
 *
 * `stored` is read from localStorage BEFORE auth resolves and from `profiles.locale` after,
 * because /login renders before there is a profile to ask — without the local copy an English
 * speaker meets a Hebrew login screen on every cold start.
 *
 * This module is deliberately free of React, storage and DOM access: it is a pure decision, so
 * the provider that owns the side effects can be tested against it rather than around it.
 */
export const LOCALES = ['he', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

/** The product's base language. Keys are born in Hebrew and English must cover them. */
export const BASE_LOCALE: Locale = 'he';

const isLocale = (value: unknown): value is Locale => LOCALES.includes(value as Locale);

/**
 * BCP 47 tags for `Intl`. Kept as data rather than derived, because `en` is deliberately
 * `en-US` and not `en-GB`: the two disagree on date order, and picking one silently from the
 * two-letter code would make the choice invisible.
 */
export const INTL_LOCALE: Record<Locale, string> = { he: 'he-IL', en: 'en-US' };

export const dirFor = (locale: Locale): 'rtl' | 'ltr' => (locale === 'he' ? 'rtl' : 'ltr');

export function resolveLocale(input: {
  stored: string | null;
  query: string;
  browser: string;
}): Locale {
  if (isLocale(input.stored)) return input.stored;
  const requested = new URLSearchParams(input.query).get('lang')?.toLowerCase();
  if (isLocale(requested)) return requested;
  return input.browser.toLowerCase().startsWith('en') ? 'en' : BASE_LOCALE;
}
