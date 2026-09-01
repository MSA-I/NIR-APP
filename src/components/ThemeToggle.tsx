import { Moon, Sun } from 'lucide-react';
import { useThemeToggle } from '../lib/useThemeChoice';
import { useT } from '../lib/i18n/LocaleProvider';

/**
 * The light/dark switch.
 *
 * 21st.dev's theme-toggle (@ayushmxxn, catalogue id 1216), ported from `LANDING-PAGE-NIR@5ace2cc`
 * (`src/components/ThemeToggle.tsx`, blob `4cfe7ff`). Its geometry is carried over exactly — a 64x32
 * pill with 4px of padding, two 24px circles held apart by `space-between`, and a 300ms slide that
 * carries each circle 32px so the pair swap places — and the CSS lives beside `.app-glow` in
 * `src/index.css` with the four documented departures.
 *
 * THREE DEPARTURES IN THE COMPONENT ITSELF, all of them inherited from the port's own notes because
 * every one of them applies here too:
 *
 *   1. It is a `<button>`, not a `<div role="button" tabIndex={0}>`. The published component binds
 *      `onClick` and nothing else, so Enter and Space do not work it — and a control in this shell
 *      that cannot be reached from the keyboard is a WCAG failure, not a rough edge.
 *   2. The slide is LOGICAL. `translate-x-8` is a physical direction and a transform is not mirrored
 *      by `dir`, so on the Hebrew screen the knob would travel out of the pill. `--knob` is +1 in
 *      LTR and -1 in RTL, declared in the stylesheet beside the rest of the control.
 *   3. No `cn()`. This repo has no `clsx`, and the state the catalogue expresses as ternaries over
 *      class strings is one `data-theme-state` attribute here, which the stylesheet reads.
 *
 * It is stateless. `useThemeToggle` reads the attribute the pre-paint script in `index.html`
 * already set, so this control can never disagree with the page it is sitting on — and the same hook
 * writes the choice to the account, through the shared queue (owner ruling #8, migration 0283).
 *
 * `aria-pressed` describes DARK, not the control, and the NAME IS STATIC. The first version paired
 * `aria-pressed` with an action label — "Switch to light mode" — which announces as "Switch to light
 * mode, toggle button, pressed": the name describes what pressing does while the state describes
 * what is on, so the two contradict each other out loud. A changing accessible name also breaks
 * voice control, where "click dark mode" has to keep working after you have used it. The APG pattern
 * is a stable name plus `aria-pressed`, and the action phrasing survives as the hover title.
 */
export function ThemeToggle({ surface = 'bar' }: { surface?: 'bar' | 'inverse' }) {
  const [theme, toggle] = useThemeToggle();
  const { t } = useT();
  const dark = theme === 'dark';

  return (
    <button
      type="button"
      className="theme-toggle"
      data-theme-state={theme}
      data-surface={surface === 'inverse' ? 'inverse' : undefined}
      aria-pressed={dark}
      aria-label={t('nav.themeDark')}
      title={dark ? t('nav.themeToLight') : t('nav.themeToDark')}
      onClick={toggle}
    >
      <span className="theme-toggle__track">
        {/* The filled circle carries the icon of the theme you are IN, which is why the two icons
            swap when it travels. */}
        <span className="theme-toggle__knob">
          {dark
            ? <Moon size={16} aria-hidden="true" strokeWidth={1.5} />
            : <Sun size={16} aria-hidden="true" strokeWidth={1.5} />}
        </span>
        <span className="theme-toggle__ghost">
          {dark
            ? <Sun size={16} aria-hidden="true" strokeWidth={1.5} />
            : <Moon size={16} aria-hidden="true" strokeWidth={1.5} />}
        </span>
      </span>
    </button>
  );
}
