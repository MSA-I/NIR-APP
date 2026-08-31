import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCALE_STORAGE_KEY, LocaleProvider, useT } from './LocaleProvider';

/** Reports what the provider decided, in a form the assertions can read off the DOM. */
function Probe() {
  const { locale, dir, t, tDynamic, setLocale } = useT();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="dir">{dir}</span>
      <span data-testid="copy">{t('settings.languageTitle')}</span>
      <span data-testid="dynamic">{String(tDynamic('settings.languageTitle'))}</span>
      <span data-testid="dynamic-miss">{String(tDynamic('status.not_a_real_status'))}</span>
      <button type="button" onClick={() => setLocale('en')}>to-en</button>
      <button type="button" onClick={() => setLocale('he')}>to-he</button>
    </div>
  );
}

/** `navigator.language` is read-only; every test states the browser it is pretending to be. */
function pretendBrowser(language: string) {
  Object.defineProperty(window.navigator, 'language', { value: language, configurable: true });
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  pretendBrowser('he-IL');
  document.documentElement.lang = 'he';
  document.documentElement.dir = 'rtl';
});

describe('LocaleProvider — detection', () => {
  it('follows an English browser when nothing was ever chosen', () => {
    pretendBrowser('en-US');
    render(<LocaleProvider><Probe /></LocaleProvider>);
    expect(screen.getByTestId('locale')).toHaveTextContent('en');
    expect(screen.getByTestId('dir')).toHaveTextContent('ltr');
    expect(document.documentElement).toHaveAttribute('dir', 'ltr');
    expect(document.documentElement).toHaveAttribute('lang', 'en');
  });

  it('stays Hebrew for a browser that is neither Hebrew nor English', () => {
    pretendBrowser('fr-FR');
    render(<LocaleProvider><Probe /></LocaleProvider>);
    expect(screen.getByTestId('locale')).toHaveTextContent('he');
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
  });

  it('lets a stored choice beat the browser', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'he');
    pretendBrowser('en-US');
    render(<LocaleProvider><Probe /></LocaleProvider>);
    expect(screen.getByTestId('locale')).toHaveTextContent('he');
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
  });

  it('honours ?lang= for a support link, below a stored choice', () => {
    window.history.replaceState({}, '', '/?lang=en');
    render(<LocaleProvider><Probe /></LocaleProvider>);
    expect(screen.getByTestId('locale')).toHaveTextContent('en');

    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'he');
    render(<LocaleProvider><Probe /></LocaleProvider>);
    expect(screen.getAllByTestId('locale')[1]).toHaveTextContent('he');
  });

  it('survives a localStorage that throws — a language is not worth a crash', () => {
    const getItem = window.localStorage.getItem;
    window.localStorage.getItem = () => { throw new Error('denied'); };
    try {
      pretendBrowser('en-GB');
      render(<LocaleProvider><Probe /></LocaleProvider>);
      expect(screen.getByTestId('locale')).toHaveTextContent('en');
    } finally {
      window.localStorage.getItem = getItem;
    }
  });
});

describe('LocaleProvider — switching', () => {
  it('flips the document direction and remembers the choice', async () => {
    const user = userEvent.setup();
    render(<LocaleProvider><Probe /></LocaleProvider>);
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');

    await user.click(screen.getByRole('button', { name: 'to-en' }));

    expect(screen.getByTestId('locale')).toHaveTextContent('en');
    expect(document.documentElement).toHaveAttribute('dir', 'ltr');
    expect(document.documentElement).toHaveAttribute('lang', 'en');
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
  });

  it('switches the copy, not just the attributes', async () => {
    const user = userEvent.setup();
    render(<LocaleProvider><Probe /></LocaleProvider>);
    expect(screen.getByTestId('copy')).toHaveTextContent('שפת הממשק');

    await user.click(screen.getByRole('button', { name: 'to-en' }));
    expect(screen.getByTestId('copy')).toHaveTextContent('Interface language');
  });

  it('gives a runtime lookup null on a miss so the caller can show the raw stored value', () => {
    render(<LocaleProvider><Probe /></LocaleProvider>);
    expect(screen.getByTestId('dynamic')).toHaveTextContent('שפת הממשק');
    expect(screen.getByTestId('dynamic-miss')).toHaveTextContent('null');
  });
});

describe('errorText', () => {
  function Boom({ thrown }: { thrown: unknown }) {
    const { errorText } = useT();
    return <span data-testid="failure">{errorText(thrown)}</span>;
  }

  it('reads a failure in the language the reader is actually using', () => {
    render(<LocaleProvider initialLocale="he"><Boom thrown={new Error('not_authorized')} /></LocaleProvider>);
    expect(screen.getByTestId('failure')).toHaveTextContent('אין לך הרשאה לבצע את הפעולה הזו.');

    render(<LocaleProvider initialLocale="en"><Boom thrown={new Error('not_authorized')} /></LocaleProvider>);
    expect(screen.getAllByTestId('failure')[1]).toHaveTextContent('You do not have permission to do this.');
  });

  it('falls back to a sentence, never to a raw key or a blank', () => {
    render(<LocaleProvider initialLocale="en"><Boom thrown={new Error('something nobody mapped')} /></LocaleProvider>);
    const text = screen.getByTestId('failure').textContent ?? '';
    expect(text).toBe('That did not work. If it keeps happening, contact support.');
    expect(text).not.toMatch(/^[a-z_]+$/);
  });

  it('keeps the raw message out of the user sentence and in the console, where a developer needs it', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(<LocaleProvider initialLocale="en"><Boom thrown={new Error('duplicate key value violates unique constraint')} /></LocaleProvider>);
      expect(screen.getByTestId('failure')).toHaveTextContent('That record already exists.');
      expect(spy).toHaveBeenCalledWith('[supplyflow]', 'duplicate key value violates unique constraint');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('LocaleProvider — the profile bridge', () => {
  it('adopts a saved choice, and ignores null because null means never chose', () => {
    pretendBrowser('en-US');
    function Bridge({ saved }: { saved: 'he' | 'en' | null }) {
      const { adoptLocale } = useT();
      return <button type="button" onClick={() => adoptLocale(saved)}>adopt</button>;
    }

    const view = render(
      <LocaleProvider><Probe /><Bridge saved={null} /></LocaleProvider>,
    );
    act(() => { screen.getByRole('button', { name: 'adopt' }).click(); });
    expect(screen.getByTestId('locale')).toHaveTextContent('en'); // detection kept its answer

    view.rerender(<LocaleProvider><Probe /><Bridge saved="he" /></LocaleProvider>);
    act(() => { screen.getByRole('button', { name: 'adopt' }).click(); });
    expect(screen.getByTestId('locale')).toHaveTextContent('he');
  });
});

describe('the provider is actually mounted in the app', () => {
  /**
   * `useT()` deliberately does not throw outside a provider, so that the 151 existing spec files
   * keep rendering components directly and keep asserting on literal Hebrew. This is the check
   * that pays for that decision: it fires at the one place the wiring can actually go wrong.
   */
  it('main.tsx wraps the app in LocaleProvider, outside AuthProvider', () => {
    // `process.cwd()`, the idiom productDisplayName.spec.ts already uses for the same job:
    // under jsdom `import.meta.url` is an http URL and `readFileSync` refuses it.
    const main = readFileSync(join(process.cwd(), 'src', 'main.tsx'), 'utf8');
    expect(main).toContain('<LocaleProvider>');
    /* `<ProfileLocaleSync />` until 31.08.2026, when the appearance switch arrived and the same
       adopt-then-persist wiring had to carry a second preference. One component now owns both, so
       the name moved — the assertion is unchanged in substance: the sync is MOUNTED. */
    expect(main).toContain('<ProfilePreferencesSync />');
    expect(main.indexOf('<LocaleProvider>')).toBeLessThan(main.indexOf('<AuthProvider>'));
  });
});
