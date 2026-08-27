import { Languages } from 'lucide-react';
import { Card, ICON, useToast } from '../../components/ui';
import { useAuth } from '../../auth/AuthContext';
import { translateIn, useT } from './LocaleProvider';
import { saveProfileLocale } from './profileLocale';
import { LOCALES, type Locale } from './locale';

/**
 * The manual switch, on /settings.
 *
 * A `<select>` and not a two-state toggle, because `SupplierCommunicationCard` already uses exactly
 * this control for exactly this kind of choice (the language we write to a supplier in). Two
 * language pickers in one product that look like different mechanisms is confusion, not variety —
 * and they ARE different questions, which is why the copy has to say which one this is.
 *
 * Available to every role. This is a person's own reading language: it grants nothing, it changes
 * nothing anyone else sees, and gating it behind `owner` would leave an English-speaking accountant
 * asking their manager to change the language of their own screen.
 *
 * THE SCREEN SWITCHES FIRST, ALWAYS. Persisting to the profile is a separate step whose failure is
 * reported and nothing more: a switch that silently did not happen reads as a broken control, and
 * the person would click it again. A switch that happened but was not remembered costs them one
 * more click on their next visit.
 */
export function LanguageSetting() {
  const { profile } = useAuth();
  const { locale, setLocale, t } = useT();
  const toast = useToast();

  const choose = (next: Locale) => {
    if (next === locale) return;
    setLocale(next);
    if (!profile) return; // signed out or an operator with no tenant profile — nothing to save to
    void saveProfileLocale(profile.id, next).then((saved) => {
      // `translateIn(next, …)` and not `t(…)`: this handler closed over the OLD language, so a
      // captured `t` would report the switch to English in Hebrew.
      if (!saved) toast(translateIn(next, 'settings.languageSaveFailed'), 'error');
    });
  };

  return (
    <Card className="space-y-4">
      <div>
        <h2 className="section-title flex items-center gap-2">
          <Languages size={ICON.md} aria-hidden="true" /> {t('settings.languageTitle')}
        </h2>
        <p className="mt-1 text-sm text-ink-muted">{t('settings.languageHint')}</p>
      </div>
      <div className="max-w-xs">
        <label className="label" htmlFor="settings-ui-locale">{t('settings.languageTitle')}</label>
        <select
          id="settings-ui-locale"
          className="input"
          value={locale}
          onChange={(event) => choose(event.target.value as Locale)}
        >
          {LOCALES.map((option) => (
            <option key={option} value={option}>
              {option === 'he' ? t('settings.languageOptionHe') : t('settings.languageOptionEn')}
            </option>
          ))}
        </select>
      </div>
    </Card>
  );
}
