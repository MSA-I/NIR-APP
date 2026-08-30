import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { en } from './dictionaries/en';
import { he } from './dictionaries/he';
import type { Dictionary } from './dictionaries/he';
import { dirFor, resolveLocale, type Locale } from './locale';
import { translate, tryTranslate, type TKey } from './t';
import { toErrorKey } from '../errors';

/**
 * Owns three things and nothing else: which locale this session is in, the copy of that answer in
 * localStorage, and the two attributes on `<html>` that make the whole layout change direction.
 *
 * It deliberately does NOT know about auth, profiles or Supabase. It sits OUTSIDE AuthProvider so
 * that /login — which renders before there is a profile to ask — is already in the right language
 * and the right direction. `ProfileLocaleSync` is the one-way bridge that pushes a signed-in
 * person's saved choice back in; keeping that in its own component is what lets this file stay
 * testable without a session.
 *
 * BOTH DICTIONARIES ARE IMPORTED STATICALLY, and the plan said to load English lazily. Changed
 * deliberately during implementation, because the lazy version buys ~40KB gzipped by showing an
 * English speaker a frame of Hebrew on every cold start — a visible regression aimed exactly at
 * the people this feature exists for. ponytail: two static imports, no async, no flash. Ceiling:
 * if the two dictionaries together pass ~200KB gzipped, or a third language arrives, split them
 * by `import()` and accept the first-frame cost then.
 */
const DICTIONARIES: Record<Locale, Dictionary> = {
  he: he as unknown as Dictionary,
  en,
};

/**
 * The localStorage key. Read before auth resolves, written on every change, and treated as a
 * CACHE of the profile rather than an authority: when a signed-in profile disagrees, the profile
 * wins and this is overwritten.
 */
export const LOCALE_STORAGE_KEY = 'inplace.locale';

/** Storage throws in a private window and in some embedded webviews. A language is not worth a crash. */
function readStored(): string | null {
  try {
    return window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(locale: Locale): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    /* the session still switches; only the memory of it is lost */
  }
}

interface LocaleState {
  locale: Locale;
  dir: 'rtl' | 'ltr';
  /** Compile-checked lookup. A key that is not in the dictionary is a `tsc` error, not a blank. */
  t: (key: TKey, vars?: Record<string, string | number>) => string;
  /**
   * Runtime lookup for keys that only exist once a row has been read — a status enum, an audit
   * action. Returns `null` on a miss so the caller can fall back to the raw stored value, which
   * is the rule `status.ts` already states.
   */
  tDynamic: (key: string, vars?: Record<string, string | number>) => string | null;
  /**
   * The label for a `StatusMeta` — the shape `src/lib/status.ts` hands out, which carries a
   * dictionary key and a tone rather than text.
   *
   * Typed as `{ key: string }` rather than importing `StatusMeta`, so this file stays free of the
   * product's vocabulary. Nothing is lost: the maps in status.ts are checked against `StatusKey`
   * where they are BUILT, which is the only place a typo can enter.
   *
   * `undefined` in, empty string out: a status the map has not caught up with must not render a
   * key at a customer, and `StatusBadge` already declines to draw a badge it has no meta for.
   */
  statusLabel: (metaOrKey: { key: string } | string | null | undefined) => string;
  /**
   * The sentence for a thrown value, in the reader's language. Takes the error itself rather than
   * a key so a call site reads `errorText(e)` — the same shape the code already had — and so the
   * raw message still reaches the console on the way past.
   */
  errorText: (error: unknown) => string;
  /** Switches the screen and remembers it locally. Persisting to the profile is the caller's job. */
  setLocale: (next: Locale) => void;
  /** Adopts a locale that came from somewhere authoritative (a profile) without echoing it back. */
  adoptLocale: (next: Locale | null) => void;
}

/**
 * The default is a live Hebrew state rather than `null`, and that is a decision about the 151
 * existing spec files.
 *
 * Every one of them calls `render()` directly with its own local wrappers — there is no shared
 * test render helper to extend — and they assert on literal Hebrew ON PURPOSE, because a test that
 * looked the string up in the dictionary would pass against a broken dictionary. Making `useT()`
 * throw outside a provider would have meant either editing all 151 files or aliasing
 * `@testing-library/react` to a wrapper module, and a module alias is exactly the kind of thing
 * someone has to decode at 3am.
 *
 * The failure this trades away — a component rendering Hebrew because its provider is missing,
 * which looks identical to one rendering Hebrew correctly — is covered directly instead:
 * `localeProvider.spec.tsx` reads `src/main.tsx` and fails if `<LocaleProvider>` stops wrapping the
 * app. That is a stronger check than a throw, because it fires at the one place it can go wrong
 * rather than at every place it cannot.
 */
/**
 * Accepts a `StatusMeta` or a bare key, because status.ts holds both shapes: the tone-bearing maps
 * hand out `{ key, tone }`, while the label-only ones (credit reasons, exception types, role names)
 * are just `Record<value, key>`. One resolver rather than two spellings of the same lookup.
 */
function resolveStatus(dictionary: Dictionary, metaOrKey: { key: string } | string | null | undefined): string {
  if (!metaOrKey) return '';
  const key = typeof metaOrKey === 'string' ? metaOrKey : metaOrKey.key;
  return tryTranslate(dictionary, `status.${key}`) ?? '';
}

/** Keeps the key-resolution in one place: `toErrorKey` decides WHICH failure, this decides its words. */
function resolveError(dictionary: Dictionary, error: unknown): string {
  const key = toErrorKey(error);
  return tryTranslate(dictionary, `errors.${key}`) ?? dictionary.errors.fallback;
}

const FALLBACK_DICTIONARY = he as unknown as Dictionary;
const LocaleContext = createContext<LocaleState>({
  locale: 'he',
  dir: 'rtl',
  t: (key, vars) => translate(FALLBACK_DICTIONARY, key, vars),
  tDynamic: (key, vars) => tryTranslate(FALLBACK_DICTIONARY, key, vars),
  statusLabel: (metaOrKey) => resolveStatus(FALLBACK_DICTIONARY, metaOrKey),
  errorText: (error) => resolveError(FALLBACK_DICTIONARY, error),
  setLocale: () => {},
  adoptLocale: () => {},
});

export function LocaleProvider({
  children,
  /** Tests and stories pin the locale; the app never passes this. See src/test/setup.ts. */
  initialLocale,
}: {
  children: ReactNode;
  initialLocale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(() =>
    initialLocale ?? resolveLocale({
      stored: readStored(),
      query: window.location.search,
      browser: window.navigator.language,
    }));

  // The same two attributes the supplier portal has always set (src/portal/PortalApp.tsx:69-70).
  // `dir` on the root is what every logical property in index.css resolves against, so this one
  // assignment is the entire layout flip.
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = dirFor(locale);
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    writeStored(next);
  }, []);

  const adoptLocale = useCallback((next: Locale | null) => {
    if (!next) return; // `null` means the person never chose — detection keeps its answer
    setLocaleState(next);
    writeStored(next);
  }, []);

  const value = useMemo<LocaleState>(() => {
    const dictionary = DICTIONARIES[locale];
    return {
      locale,
      dir: dirFor(locale),
      t: (key, vars) => translate(dictionary, key, vars, locale),
      tDynamic: (key, vars) => tryTranslate(dictionary, key, vars, locale),
      statusLabel: (metaOrKey) => resolveStatus(dictionary, metaOrKey),
      errorText: (error) => resolveError(dictionary, error),
      setLocale,
      adoptLocale,
    };
  }, [locale, setLocale, adoptLocale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/**
 * Resolves a key in a NAMED locale rather than the current one.
 *
 * It exists because of an ordering bug the tests caught: a handler that calls `setLocale('en')`
 * and then reports something is still holding the `t` it closed over at render time, which is the
 * OLD language. So the person switches to English and the message about the switch arrives in
 * Hebrew. Anything an event handler says ABOUT a locale change has to be resolved against the
 * locale it is changing to, and this is that lookup.
 */
export const translateIn = (locale: Locale, key: TKey, vars?: Record<string, string | number>): string =>
  translate(DICTIONARIES[locale], key, vars, locale);

/** The one way a component asks what language it is in. See the context default above for why it never throws. */
export const useT = (): LocaleState => useContext(LocaleContext);
