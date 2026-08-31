/**
 * THE one place that writes `profiles.theme`, and the second half of owner ruling #8.
 *
 * The ruling was "device AND account". `localStorage` is the device half and is what the pre-paint
 * script in `index.html` reads; this is the account half, so a person who signs in on a second
 * machine meets the theme they chose rather than the product default.
 *
 * A DELIBERATE MIRROR OF `localePersistence`. Same queue, same three-way split of owner / persisted
 * / reporter, same reasons — written out there in full. Two preferences with the same shape must
 * not have two shapes of solution, and the one thing this file adds is a different failure message.
 *
 * The account copy also covers the case `applyTheme` explicitly tolerates: a private window where
 * `localStorage` throws. The screen still turns, and now the choice still survives.
 */
import { supabase } from './supabase';
import { createPersistQueue } from './persistQueue';
import { readStoredTheme, type Theme } from './appearance';

/**
 * Persists to `profiles.theme` (migration 0268).
 *
 * `.select('id')` and not a bare update, for the reason 0253 discovered the expensive way: PostgREST
 * reports an update that matched ZERO rows as a success, so an RLS policy or a column ACL quietly
 * refusing the row would read here as "saved". Asking for the affected row back is what turns
 * "nothing happened" into something this function can see — and on THIS column that matters more
 * than usual, because the theme is applied by an attribute and remembered in storage, so a failed
 * write is invisible until somebody opens the product on another machine.
 */
export async function saveProfileTheme(profileId: string, theme: Theme): Promise<boolean> {
  const { data, error } = await supabase
    .from('profiles').update({ theme }).eq('id', profileId).select('id');
  return !error && (data?.length ?? 0) === 1;
}

/** Registered by the bridge component; absent before it mounts, and after sign-out. */
let reportFailure: ((theme: Theme) => void) | null = null;

const queue = createPersistQueue<Theme>({
  persist: saveProfileTheme,
  onTerminalFailure: (theme) => reportFailure?.(theme),
});

/** Record the choice. Call AFTER `applyTheme` — the screen turns first, unconditionally. */
export const persistThemeChoice = (theme: Theme): void => queue.submit(theme);

/**
 * Point the queue at the signed-in profile, or at nobody. **Owner changes only** — see
 * `localePersistence.bindLocaleOwner` for why binding the persisted value in the same effect is the
 * bug this split exists to prevent.
 */
export const bindThemeOwner = (profileId: string | null, persisted: Theme | null): void => {
  queue.reset(profileId, persisted);
  // A theme chosen before the profile resolved — on /login, or in the window before auth answers —
  // was dropped by `submit` because there was no owner. Now that there is one, a stored choice that
  // disagrees with the server is submitted once.
  if (profileId === null) return;
  // Through `appearance.readStoredTheme` and not `localStorage` directly: `check:appearance-scope`
  // allows exactly one module to touch the theme key, and the first version of this file tripped
  // that guard — correctly. `null` means this browser remembers no decision, so there is nothing to
  // reconcile.
  const stored = readStoredTheme();
  if (stored !== null && stored !== persisted) queue.submit(stored);
};

/** The server's value changed under us (a profile refetch). Does NOT disturb work in flight. */
export const noteThemePersisted = (persisted: Theme): void => queue.notePersisted(persisted);

/** Where a terminal failure is reported, registered separately from the owner. */
export const setThemeFailureReporter = (onFailure: ((theme: Theme) => void) | null): void => {
  reportFailure = onFailure;
};
