/**
 * THE one place that writes `profiles.locale`, shared by every control that offers the choice.
 *
 * There are two such controls now — the `<select>` on /settings and the row in the account menu /
 * phone drawer — and there is no version of "each of them saves its own choice" that is correct.
 * Two independent writers of one column race on the third quick change, and the loser is silent:
 * the screen is in the language you picked and the account remembers the one you picked before it.
 *
 * So both controls call `persistLocaleChoice`, and the ordering rules live in `createPersistQueue`
 * (see that file for why it coalesces rather than serialises, and why only a *terminal* failure is
 * reported). This module is the wiring: one queue for the process, pointed at the signed-in profile
 * and at a toast.
 *
 * A module-level singleton rather than context, because the queue must survive the unmounting of
 * whichever control started a write — the account menu closes the moment you choose, and the write
 * is still in the air.
 *
 * `saveProfileLocale` lives HERE rather than beside the provider bridge so the imports run one way:
 * `profileLocale` → this file. It used to sit in `profileLocale.tsx`, and leaving it there while
 * that file also imported the binding below would have made the two modules import each other.
 */
import { supabase } from '../supabase';
import { createPersistQueue } from '../persistQueue';
import { LOCALES, type Locale } from './locale';
import { LOCALE_STORAGE_KEY } from './LocaleProvider';

const isLocale = (value: unknown): value is Locale => LOCALES.includes(value as Locale);

/**
 * Persists the choice to `profiles.locale`. Deliberately separate from `setLocale`: the screen must
 * change instantly and unconditionally, and a network round trip must never be in the way of it.
 * The caller switches first, and a failure here means "changed but not saved" — a switch that
 * silently did not happen is worse than one that did not persist.
 *
 * Resolves `false` rather than throwing, because the only sensible response is a toast.
 */
export async function saveProfileLocale(profileId: string, locale: Locale): Promise<boolean> {
  // `.select('id')` and not a bare update: PostgREST reports an update that matched ZERO rows as a
  // success, so an RLS policy quietly filtering the row out would read here as "saved". Asking for
  // the affected row back turns "nothing happened" into something this function can see — which is
  // the difference between a language that did not persist and a language that reported that it did.
  const { data, error } = await supabase
    .from('profiles').update({ locale }).eq('id', profileId).select('id');
  return !error && (data?.length ?? 0) === 1;
}

/** Registered by the bridge component; absent before it mounts, and after sign-out. */
let reportFailure: ((locale: Locale) => void) | null = null;

const queue = createPersistQueue<Locale>({
  persist: saveProfileLocale,
  onTerminalFailure: (locale) => reportFailure?.(locale),
});

/**
 * Record the person's choice. Call AFTER `setLocale` — the screen changes first, unconditionally,
 * and the network is never in the way of it.
 */
export const persistLocaleChoice = (locale: Locale): void => queue.submit(locale);

/**
 * Point the queue at the signed-in profile, or at nobody. **Owner changes only.**
 *
 * SPLIT FROM THE OTHER TWO ON PURPOSE (31.08.2026). This used to be one function that took the
 * owner, the persisted value and the failure reporter together, called from one effect. That effect
 * therefore re-ran whenever the *persisted value* changed — which is precisely what happens after a
 * successful write, when the profile refetches — and its cleanup called `reset`, disowning any
 * second write still in the air. A person switching he → en → he quickly could end with the screen
 * on Hebrew and the account on English: the exact defect the queue exists to prevent, reintroduced
 * by the way it was wired up.
 *
 * `persisted` here is only the seed for a fresh owner. Later changes go through `noteLocalePersisted`.
 */
export const bindLocaleOwner = (profileId: string | null, persisted: Locale | null): void => {
  queue.reset(profileId, persisted);
  // A choice made before the profile resolved — on /login, or in the window before auth answers —
  // was dropped by `submit` because there was no owner to save to, and nothing ever retried it. Now
  // that there is an owner, a stored choice that disagrees with the server is submitted once.
  if (profileId === null) return;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return; // no storage, nothing to reconcile
  }
  if (isLocale(stored) && stored !== persisted) queue.submit(stored);
};

/** The server's value changed under us (a profile refetch). Does NOT disturb work in flight. */
export const noteLocalePersisted = (persisted: Locale): void => queue.notePersisted(persisted);

/**
 * Where a terminal failure is reported. Registered separately from the owner so that a change of
 * reporter identity can never reset the queue.
 */
export const setLocaleFailureReporter = (onFailure: ((locale: Locale) => void) | null): void => {
  reportFailure = onFailure;
};
