import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageSetting } from './LanguageSetting';
import { LOCALE_STORAGE_KEY, LocaleProvider } from './LocaleProvider';
import { ToastProvider } from '../../components/ui';

const PROFILE = { id: 'profile-1', org_id: 'org-1', full_name: 'ננ', role: 'owner', phone: null, active: true, supplier_id: null, locale: null };

vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ profile: PROFILE }) }));

const saveProfileLocale = vi.fn(async () => true);
vi.mock('./profileLocale', () => ({ saveProfileLocale: (...args: unknown[]) => saveProfileLocale(...(args as [])) }));

function renderSetting() {
  return render(
    <LocaleProvider>
      <ToastProvider><LanguageSetting /></ToastProvider>
    </LocaleProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  Object.defineProperty(window.navigator, 'language', { value: 'he-IL', configurable: true });
  document.documentElement.dir = 'rtl';
  saveProfileLocale.mockClear();
  saveProfileLocale.mockResolvedValue(true);
});

describe('LanguageSetting', () => {
  it('switches the whole screen to English and saves the choice to the profile', async () => {
    const user = userEvent.setup();
    renderSetting();

    expect(screen.getByRole('combobox', { name: 'שפת הממשק' })).toHaveValue('he');
    await user.selectOptions(screen.getByRole('combobox', { name: 'שפת הממשק' }), 'en');

    expect(document.documentElement).toHaveAttribute('dir', 'ltr');
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
    expect(screen.getByRole('combobox', { name: 'Interface language' })).toHaveValue('en');
    await waitFor(() => expect(saveProfileLocale).toHaveBeenCalledWith('profile-1', 'en'));
  });

  it('keeps the screen switched when the save fails, and says so', async () => {
    saveProfileLocale.mockResolvedValue(false);
    const user = userEvent.setup();
    renderSetting();

    await user.selectOptions(screen.getByRole('combobox', { name: 'שפת הממשק' }), 'en');

    // The switch is not conditional on the write: the screen is English either way.
    expect(document.documentElement).toHaveAttribute('dir', 'ltr');
    expect(await screen.findByText(/was not saved to your account/)).toBeInTheDocument();
  });

  it('offers each language in its own language, so it is findable by someone who cannot read the other', () => {
    renderSetting();
    const options = screen.getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['עברית', 'English']);
  });

  it('does not write to the profile when the chosen language is the one already showing', async () => {
    const user = userEvent.setup();
    renderSetting();
    await user.selectOptions(screen.getByRole('combobox', { name: 'שפת הממשק' }), 'he');
    expect(saveProfileLocale).not.toHaveBeenCalled();
  });
});
