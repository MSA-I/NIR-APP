import { useEffect } from 'react';
import { supabase } from '../supabase';
import { useAuth } from '../../auth/AuthContext';
import { useT } from './LocaleProvider';
import type { Locale } from './locale';

/**
 * The one-way bridge from a signed-in profile into the locale provider.
 *
 * It exists as its own component so that `LocaleProvider` can sit OUTSIDE `AuthProvider` — /login
 * has to be in the right language before there is a profile to ask — while a person's saved choice
 * still wins the moment they are known. Rendered as a child of `AuthProvider`, renders nothing.
 *
 * `profile.locale === null` means "never chose", so it is not adopted: detection keeps its answer
 * and the person is free to choose later. That is the whole reason 0213 kept `null` distinct from
 * `'he'`.
 */
export function ProfileLocaleSync() {
  const { profile } = useAuth();
  const { adoptLocale } = useT();
  const saved = profile?.locale ?? null;

  useEffect(() => {
    adoptLocale(saved);
  }, [saved, adoptLocale]);

  return null;
}

/**
 * Persists the choice to `profiles.locale`. Separate from `setLocale` on purpose: the screen must
 * change instantly and unconditionally, and a network round trip must never be in the way of it.
 * The caller switches first and reports a failure here as "changed but not saved" — a switch that
 * silently did not happen is worse than one that did not persist.
 *
 * Resolves `false` rather than throwing, because the only sensible caller response is a toast.
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
