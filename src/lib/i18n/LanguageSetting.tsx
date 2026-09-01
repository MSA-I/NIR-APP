import { Languages } from 'lucide-react';
import { Card, ICON } from '../../components/ui';
import { useT } from './LocaleProvider';
import { useLocaleChoice } from './useLocaleChoice';
import { LOCALES, type Locale } from './locale';

/**
 * The manual switch, on /settings.
 *
 * A `<select>` and not a two-state toggle, because `SupplierCommunicationCard` already uses exactly
 * this control for a language choice (the language we write to a supplier in). Two language pickers
 * in one product that look like different mechanisms is confusion, not variety — and they ARE
 * different questions, which is why the copy has to say which one this is.
 *
 * Available to every role. This is a person's own reading language: it grants nothing, it changes
 * nothing anyone else sees, and gating it behind `owner` would leave an English-speaking accountant
 * asking their manager to change the language of their own screen.
 *
 * The handler moved to `useLocaleChoice` on 31.08.2026, when the account menu gained the same
 * choice. The rule it used to carry — screen first, account second, report a failure in the NEW
 * language — is unchanged; it is simply written once now, above both controls, along with the
 * queue that stops two quick changes from landing out of order.
 */
export function LanguageSetting() {
  const { locale, t } = useT();
  const choose = useLocaleChoice();

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
