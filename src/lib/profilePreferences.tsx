import { useEffect, useRef } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useToast } from '../components/ui';
import { translateIn, useT } from './i18n/LocaleProvider';
import { bindLocaleOwner, noteLocalePersisted, setLocaleFailureReporter } from './i18n/localePersistence';
import { applyTheme, readTheme } from './appearance';
import { bindThemeOwner, noteThemePersisted, setThemeFailureReporter } from './appearancePersistence';

/**
 * The bridge between a signed-in profile and the two preferences that belong to a PERSON rather
 * than to a tenant: which language they read in, and which of the two grounds they read on.
 *
 * WHY IT IS ITS OWN COMPONENT. `LocaleProvider` sits OUTSIDE `AuthProvider` — /login has to be in
 * the right language before there is a profile to ask — and the pre-paint script in `index.html`
 * settles the theme before React exists at all. Both therefore need a component that runs INSIDE
 * auth to say "and now that we know who this is, their saved choice wins". Renders nothing.
 *
 * IT WAS `ProfileLocaleSync` UNTIL 31.08.2026. Migration 0283 gave `profiles` a `theme` column
 * beside `locale`, and the two bridges are the same six lines twice: adopt what the server holds,
 * bind the write queue, register a failure report. Keeping the old name while it carried both would
 * have been the kind of quiet lie this repository spends a lot of comments avoiding.
 *
 * `null` MEANS NEVER CHOSE, for both, and that is why neither is adopted when null: detection keeps
 * its answer for the language, the product default keeps its answer for the theme, and the person
 * stays free to choose later. Collapsing null into a value would freeze whatever the first visit
 * happened to resolve. That distinction is the whole reason 0253 and 0283 allow the column to be
 * NULL at all.
 */
export function ProfilePreferencesSync() {
  const { profile } = useAuth();
  const { adoptLocale } = useT();
  const toast = useToast();

  const savedLocale = profile?.locale ?? null;
  const savedTheme = profile?.theme ?? null;
  const profileId = profile?.id ?? null;

  useEffect(() => {
    adoptLocale(savedLocale);
  }, [savedLocale, adoptLocale]);

  /**
   * The theme's own adoption. `applyTheme` and not a bare attribute write, so the account copy goes
   * through exactly the same path as a press of the switch: the transition-suppression flag, the
   * browser-chrome update and the storage write all happen, and `check:appearance-scope` keeps
   * `appearance.ts` the only writer of the attribute.
   *
   * Guarded on the CURRENT theme rather than fired unconditionally: the pre-paint script has almost
   * always already applied the same value from storage, and re-applying it would suppress every
   * transition in the product for two frames on each sign-in for no reason at all.
   */
  useEffect(() => {
    if (savedTheme !== null && savedTheme !== readTheme()) applyTheme(savedTheme);
  }, [savedTheme]);

  /**
   * THREE EFFECTS PER PREFERENCE, and the split is a bug fix rather than tidiness — see
   * `localePersistence.bindLocaleOwner`. In short: an effect that took the owner and the persisted
   * value together re-ran whenever the persisted value changed, which is exactly what a profile
   * refetch does after a write SUCCEEDS, and its cleanup reset the queue and disowned any second
   * write still in the air.
   */
  const savedLocaleRef = useRef(savedLocale);
  savedLocaleRef.current = savedLocale;
  const savedThemeRef = useRef(savedTheme);
  savedThemeRef.current = savedTheme;

  useEffect(() => {
    bindLocaleOwner(profileId, savedLocaleRef.current);
    bindThemeOwner(profileId, savedThemeRef.current);
    return () => {
      bindLocaleOwner(null, null);
      bindThemeOwner(null, null);
    };
  }, [profileId]);

  useEffect(() => {
    if (savedLocale !== null) noteLocalePersisted(savedLocale);
  }, [savedLocale]);

  useEffect(() => {
    if (savedTheme !== null) noteThemePersisted(savedTheme);
  }, [savedTheme]);

  /**
   * `translateIn(locale, …)` and never a captured `t`: these callbacks fire long after the handler
   * that started the write, and the language message is ABOUT the language that was chosen, so it
   * has to be resolved in that language. Reporting a failed switch to English *in Hebrew* is the bug
   * this spelling exists to prevent.
   *
   * The theme report has no such subtlety — a theme is not a language — so it is resolved in
   * whatever language the screen is already in, which is what `translateIn` with the current locale
   * gives us. It is spelled the same way so the two cannot drift apart.
   */
  const { locale } = useT();
  const localeRef = useRef(locale);
  localeRef.current = locale;

  useEffect(() => {
    setLocaleFailureReporter((chosen) => {
      toast(translateIn(chosen, 'settings.languageSaveFailed'), 'error');
    });
    setThemeFailureReporter(() => {
      toast(translateIn(localeRef.current, 'settings.themeSaveFailed'), 'error');
    });
    return () => {
      setLocaleFailureReporter(null);
      setThemeFailureReporter(null);
    };
  }, [toast]);

  return null;
}
