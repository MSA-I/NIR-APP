/**
 * The control that replaced `<input type="month">` on five screens.
 *
 * The native input was replaced for one reason: it renders the month NAME, and it takes that name
 * from the browser's own UI language, which nothing the app sets can reach. An English reader saw
 * `אוגוסט 2026` in the invoice filter. So the first test here is the one that says the replacement
 * was worth making — the month name follows the interface language — and the rest pin the parts a
 * native input used to handle for free.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MonthPicker } from './ui';
import { LOCALE_STORAGE_KEY, LocaleProvider } from '../lib/i18n/LocaleProvider';

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ profile: null }) }));

function renderPicker(props: Partial<Parameters<typeof MonthPicker>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <LocaleProvider>
      <MonthPicker label="סינון" value="" onChange={onChange} {...props} />
    </LocaleProvider>,
  );
  return onChange;
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  Object.defineProperty(window.navigator, 'language', { value: 'he-IL', configurable: true });
});

describe('MonthPicker', () => {
  it('names the months in the interface language, which is the whole reason it exists', async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    renderPicker({ value: '2026-08' });

    const month = screen.getByRole('combobox', { name: /^Month/ });
    await waitFor(() => expect((month as HTMLSelectElement).selectedOptions[0].textContent).toBe('August'));
  });

  it('names them in Hebrew when the interface is Hebrew', async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'he');
    renderPicker({ value: '2026-08' });

    const month = screen.getByRole('combobox', { name: /^חודש/ });
    await waitFor(() => expect((month as HTMLSelectElement).selectedOptions[0].textContent).toBe('אוגוסט'));
  });

  it('emits YYYY-MM, the same string the native input gave the queries behind it', async () => {
    const user = userEvent.setup();
    const onChange = renderPicker({ value: '2026-08' });

    await user.selectOptions(screen.getByRole('combobox', { name: /^חודש/ }), '03');
    expect(onChange).toHaveBeenLastCalledWith('2026-03');
  });

  // A year with no month is not a filter this app has, so emptying either half must clear the whole
  // value rather than leave a half-formed one for `safeMonthISO` to reject downstream.
  it('clearing either half clears the filter, not half of it', async () => {
    const user = userEvent.setup();
    const onChange = renderPicker({ value: '2026-08', allowEmpty: true });

    await user.selectOptions(screen.getByRole('combobox', { name: /^חודש/ }), '');
    expect(onChange).toHaveBeenLastCalledWith('');

    await user.selectOptions(screen.getByRole('combobox', { name: /^שנה/ }), '');
    expect(onChange).toHaveBeenLastCalledWith('');
  });

  it('offers no blank option where a month is required', () => {
    renderPicker({ value: '2026-08' });

    const month = screen.getByRole('combobox', { name: /^חודש/ }) as HTMLSelectElement;
    expect([...month.options].some((option) => option.value === '')).toBe(false);
    expect(month.options).toHaveLength(12);
  });

  /**
   * A stored filter older than the window would otherwise vanish from its own control: the reader
   * would see a blank where their choice was, and touching the month would silently move the year.
   */
  it('keeps a chosen year that falls outside the offered window', () => {
    renderPicker({ value: '1999-08' });

    const year = screen.getByRole('combobox', { name: /^שנה/ }) as HTMLSelectElement;
    expect(year.value).toBe('1999');
    expect([...year.options].map((option) => option.value)).toContain('1999');
  });

  it('disables both halves together', () => {
    renderPicker({ value: '2026-08', disabled: true });

    expect(screen.getByRole('combobox', { name: /^חודש/ })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: /^שנה/ })).toBeDisabled();
  });
});
