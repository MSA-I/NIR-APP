import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageSetting } from './LanguageSetting';
import { LOCALE_STORAGE_KEY, LocaleProvider } from './LocaleProvider';
import { ProfilePreferencesSync } from '../profilePreferences';
import { ToastProvider } from '../../components/ui';

const PROFILE = { id: 'profile-1', org_id: 'org-1', full_name: 'ננ', role: 'owner', phone: null, active: true, supplier_id: null, locale: null };

vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ profile: PROFILE }) }));

/**
 * The write is mocked at the CLIENT, not at `saveProfileLocale`, and that is deliberate as of
 * 31.08.2026. The persistence path now runs through the shared coalescing queue in
 * `localePersistence`, which closes over `saveProfileLocale` inside its own module — so replacing
 * that export would leave the queue calling the real one and prove nothing. Mocking the Supabase
 * client keeps the whole chain under test: control → `useLocaleChoice` → queue → `saveProfileLocale`.
 */
const db = vi.hoisted(() => {
  const writes: { id: string; locale: string }[] = [];
  const outcome = { stored: true };
  const from = () => ({
    update: (payload: { locale: string }) => ({
      eq: (_column: string, id: string) => ({
        select: () => {
          writes.push({ id, locale: payload.locale });
          return Promise.resolve(outcome.stored
            ? { data: [{ id }], error: null }
            : { data: [], error: null });
        },
      }),
    }),
  });
  return { writes, outcome, from };
});

vi.mock('../supabase', () => ({ supabase: { from: db.from } }));

/**
 * `ProfilePreferencesSync` is rendered alongside the control because it is what BINDS the write queue to
 * the signed-in profile. Without it the queue has no owner and writes nothing — which is correct
 * behaviour (there is nobody to save to) but makes the control untestable in isolation. In the app
 * the same pairing holds: `main.tsx` renders the bridge above every screen.
 */
function renderSetting() {
  return render(
    <LocaleProvider>
      <ToastProvider>
        <ProfilePreferencesSync />
        <LanguageSetting />
      </ToastProvider>
    </LocaleProvider>,
  );
}

const comboBox = (name: string) => screen.getByRole('combobox', { name });

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  Object.defineProperty(window.navigator, 'language', { value: 'he-IL', configurable: true });
  document.documentElement.dir = 'rtl';
  db.writes.length = 0;
  db.outcome.stored = true;
});

describe('LanguageSetting', () => {
  it('switches the whole screen to English and saves the choice to the profile', async () => {
    const user = userEvent.setup();
    renderSetting();

    expect(comboBox('שפת הממשק')).toHaveValue('he');
    await user.selectOptions(comboBox('שפת הממשק'), 'en');

    expect(document.documentElement).toHaveAttribute('dir', 'ltr');
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
    expect(comboBox('Interface language')).toHaveValue('en');
    await waitFor(() => expect(db.writes).toEqual([{ id: 'profile-1', locale: 'en' }]));
  });

  it('keeps the screen switched when the save fails, and says so', async () => {
    db.outcome.stored = false;
    const user = userEvent.setup();
    renderSetting();

    await user.selectOptions(comboBox('שפת הממשק'), 'en');

    // The switch is not conditional on the write: the screen is English either way.
    expect(document.documentElement).toHaveAttribute('dir', 'ltr');
    expect(await screen.findByText(/was not saved to your account/)).toBeInTheDocument();
  });

  it('offers each language in its own language, so it is findable by someone who cannot read the other', () => {
    renderSetting();
    const options = screen.getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['עברית', 'English']);
  });

  /**
   * THE CONTRACT CHANGED ON 31.08.2026, and the old assertion was hiding a real gap.
   *
   * It used to read "does not write when the chosen language is the one already showing", which a
   * code review showed to be wrong in the one case that matters: `profiles.locale` is null until a
   * person chooses, and 0213 keeps that null distinct from `'he'` precisely so it can mean "never
   * chose, detection may keep deciding". A Hebrew speaker looking at a Hebrew screen therefore had
   * no way to PIN it — the choice they were trying to make was the one the guard threw away, and on
   * their next device detection got another go.
   *
   * So choosing the displayed language now DOES write, and the redundant case is handled where it
   * belongs: the queue refuses a write whose value already matches what the server holds.
   */
  it('writes the displayed language too, so a person can pin what detection guessed', async () => {
    const user = userEvent.setup();
    renderSetting();

    await user.selectOptions(comboBox('שפת הממשק'), 'he');

    // `PROFILE.locale` is null — nothing is stored yet — so this is a real choice and it is saved.
    await waitFor(() => expect(db.writes).toEqual([{ id: 'profile-1', locale: 'he' }]));
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
  });

  it('stops short of a second write once the server already holds that language', async () => {
    const user = userEvent.setup();
    renderSetting();

    await user.selectOptions(comboBox('שפת הממשק'), 'he');
    await waitFor(() => expect(db.writes).toHaveLength(1));
    // Choosing it again asks for nothing new: the queue compares against what it knows is stored.
    await user.selectOptions(comboBox('שפת הממשק'), 'he');

    expect(db.writes).toHaveLength(1);
  });

  /**
   * The race the queue exists for, driven through the real control rather than the state machine
   * (`persistQueue.spec.ts` owns the state machine). Two changes with no await between them must
   * leave the account holding the LAST one — never the first, and never both in the wrong order.
   */
  it('two quick changes leave the account on the language the person ended on', async () => {
    const user = userEvent.setup();
    renderSetting();

    await user.selectOptions(comboBox('שפת הממשק'), 'en');
    await user.selectOptions(comboBox('Interface language'), 'he');

    await waitFor(() => expect(db.writes.at(-1)).toEqual({ id: 'profile-1', locale: 'he' }));
    expect(comboBox('שפת הממשק')).toHaveValue('he');
    // No stale failure report from the write that was overtaken.
    expect(screen.queryByText(/was not saved to your account/)).not.toBeInTheDocument();
    expect(screen.queryByText(/לא נשמרה בחשבון/)).not.toBeInTheDocument();
  });
});
