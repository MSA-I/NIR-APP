import { Languages } from 'lucide-react';
import { useId } from 'react';
import { ICON } from '../../components/ui';
import { useT } from './LocaleProvider';
import { useLocaleChoice } from './useLocaleChoice';
import { LOCALES, type Locale } from './locale';

/**
 * The reading language, in the shell — one row in the account menu on desktop and in the phone
 * drawer, per the owner's placement ruling of 31.08.2026 (option א: the theme switch is a visible
 * button because it is flipped by time of day; the language is set once and lives in the menu).
 *
 * A REAL `<select>`, not a menu built by hand. The marketing site's switcher is a `role="menu"` of
 * links between two prerendered pages, and copying its mechanism here would have been wrong twice:
 * this product changes locale in place, and a hand-built menu owes the full APG keyboard contract —
 * ArrowUp/Down/Home/End, roving focus, focus return, an Escape that does not also close the drawer
 * around it. A native select is handed all of that by the browser, in every assistive technology,
 * for free. It is also what /settings and `SupplierCommunicationCard` already use, so the product
 * has one mechanism for this question rather than two that look different.
 *
 * NO FLAG, and that is a deliberate departure from the ported design. Three reasons, in order of
 * weight: the options already name themselves in their own language ("עברית" / "English"), which is
 * the thing a person who cannot read the other one needs; a flag is a country and not a language,
 * so it makes a claim neither option wants to make; and `check:tokens` forbids colour literals in
 * product source, so the drawn flags would have had to become static assets — two files and a
 * request each to add decoration next to text that already says it. The marketing page needed marks
 * because its trigger is compact; this row has room for words.
 *
 * It renders on two grounds and therefore takes `surface`, exactly like the sign-out and product-
 * guide rows beside it: `panel` is the light paper of the desktop account menu, `shell` the onyx of
 * the phone drawer. The `<option>` list is pinned to the light pair on BOTH grounds — the popup is
 * drawn by the operating system from the select's own colours, and a translucent light-on-dark
 * select renders an unreadable popup on Windows.
 */
export function LanguageMenuRow({ surface = 'panel' }: { surface?: 'panel' | 'shell' }) {
  const { locale, t } = useT();
  const choose = useLocaleChoice();
  const id = useId();
  const onShell = surface === 'shell';

  return (
    <div className={`flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 text-sm ${
      onShell ? 'text-inverse-ink-soft' : 'text-ink-soft'
    }`}>
      <Languages size={ICON.md} aria-hidden="true" />
      {/* `nav.language` ("שפה" / "Language") and not `settings.languageTitle` ("שפת הממשק" /
          "Interface language"): the account menu is `w-64`, and the long form measured as
          "Interface la…" beside the select — a truncated label is a worse label than a short one.
          The icon and the select's own value carry what the words drop, which is not true on
          /settings, where the row stands alone on a wide card and keeps the full name. */}
      <label htmlFor={id} className="min-w-0 flex-1 truncate">{t('nav.language')}</label>
      <select
        id={id}
        value={locale}
        onChange={(event) => choose(event.target.value as Locale)}
        /* THE FOCUS RING FOLLOWS THE GROUND. On the drawer this select sits on `inverse`, and
           `--color-focus` cannot serve that ground as well as paper — measured, the ring fell to
           1.21:1 there in the dark theme. `inverse-ink` is the drawer's own ink and is measured
           against `inverse` at text strength, so the keyboard ring is unmistakable in both. */
        className={`min-h-9 rounded-lg border px-2 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 [&>option]:bg-surface [&>option]:text-ink ${
          onShell
            ? 'border-inverse-ink/30 bg-inverse text-inverse-ink hover:bg-inverse-ink/10 focus-visible:ring-inverse-ink'
            : 'border-line-strong bg-surface text-ink hover:bg-surface-hover focus-visible:ring-focus'
        }`}
      >
        {LOCALES.map((option) => (
          <option key={option} value={option}>
            {option === 'he' ? t('settings.languageOptionHe') : t('settings.languageOptionEn')}
          </option>
        ))}
      </select>
    </div>
  );
}
