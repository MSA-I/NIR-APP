import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

const signIn = vi.hoisted(() => vi.fn());

/**
 * The provider flags are `import.meta.env` reads at module scope, so Vite has already substituted
 * them by the time a test runs and `stubEnv` cannot reach them. The module is mocked instead, which
 * is also the honest shape of the assertion: this screen's job is to draw whatever is configured
 * and to hand off, not to decide what is configured.
 */
const federated = vi.hoisted(() => ({
  providers: [] as ('google' | 'apple')[],
  start: vi.fn(async () => ({ error: null })),
}));

vi.mock('../lib/authProviders', () => ({
  FEDERATED_PROVIDER_LABEL: { google: 'Google', apple: 'Apple' },
  enabledFederatedProviders: () => federated.providers,
  startFederatedSignup: federated.start,
}));

vi.mock('../auth/AuthContext', () => ({
  homeFor: () => '/dashboard',
  useAuth: () => ({
    signIn,
    session: null,
    profile: null,
    loading: false,
  }),
}));

import Login from './Login';

describe('מסך הכניסה', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    signIn.mockReset();
    federated.providers = [];
    federated.start.mockClear();
  });

  it('מציג ומסתיר את הסיסמה בלי לשנות את הערך', () => {
    render(<MemoryRouter><Login /></MemoryRouter>);
    const password = screen.getByLabelText('סיסמה');
    fireEvent.change(password, { target: { value: 'secret-value' } });

    fireEvent.click(screen.getByRole('button', { name: 'הצגת סיסמה' }));
    expect(password).toHaveAttribute('type', 'text');
    expect(password).toHaveValue('secret-value');

    fireEvent.click(screen.getByRole('button', { name: 'הסתרת סיסמה' }));
    expect(password).toHaveAttribute('type', 'password');
  });

  it('מציע מילוי חשבון דמו רק מול הסטאק המקומי', () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:55431');
    vi.stubEnv('VITE_DEMO_PASSWORD_SEED', 'manualgate2026');
    render(<MemoryRouter><Login /></MemoryRouter>);

    fireEvent.click(screen.getByText('חשבונות דמו מקומיים'));
    expect(screen.getAllByRole('button', { name: /^כניסה כ/ }).map((button) => button.textContent))
      .toEqual(['מנהל/בעלים', 'מנהל רכש', 'רואה חשבון']);
    fireEvent.click(screen.getByRole('button', { name: 'כניסה כמנהל/בעלים' }));

    expect(screen.getByLabelText('אימייל')).toHaveValue('owner@demo.supplyflow.local');
    expect(screen.getByLabelText('סיסמה')).toHaveValue('P4!manualgate2026-owner-Aa7');
    expect(screen.queryByText('מנהל מטבח')).not.toBeInTheDocument();
    expect(screen.queryByText('מבצע העברות')).not.toBeInTheDocument();
    expect(screen.queryByText('ספק')).not.toBeInTheDocument();
  });

  it('מציב את השיידר משמאל ואת הטופס מימין בפריסת הדסקטופ', () => {
    render(<MemoryRouter><Login /></MemoryRouter>);

    const visualPanel = screen.getByRole('region', { name: 'זהות InPlace' });
    const formPanel = screen.getByRole('region', { name: 'כניסה לחשבון' });
    const split = visualPanel.parentElement;

    expect(split).toHaveAttribute('dir', 'ltr');
    expect(split?.children[0]).toBe(visualPanel);
    expect(split?.children[1]).toBe(formPanel);
    expect(screen.getByRole('link', { name: 'להרשמה' })).toHaveAttribute('href', '/signup');
  });

  it('אינו מצייר דלת ספק שאינה מוגדרת, ולא מפריד "או" ריק', () => {
    render(<MemoryRouter><Login /></MemoryRouter>);

    expect(screen.queryByRole('button', { name: /פתיחת עסק עם/ })).not.toBeInTheDocument();
    expect(screen.queryByText('או')).not.toBeInTheDocument();
    // The screen still has a way to open an account — it is simply the password one.
    expect(screen.getByRole('link', { name: 'להרשמה' })).toHaveAttribute('href', '/signup');
  });

  it('מוסר את פתיחת העסק לספק המוגדר, ולא לכניסה בסיסמה', async () => {
    federated.providers = ['google', 'apple'];
    render(<MemoryRouter><Login /></MemoryRouter>);

    expect(screen.getAllByRole('button', { name: /פתיחת עסק עם/ })
      .map((button) => button.textContent))
      .toEqual(['פתיחת עסק עם Google', 'פתיחת עסק עם Apple']);

    fireEvent.click(screen.getByRole('button', { name: 'פתיחת עסק עם Google' }));

    await waitFor(() => expect(federated.start).toHaveBeenCalledWith('google'));
    // The federated door must never be mistaken for the password one: this screen signs nobody in.
    expect(signIn).not.toHaveBeenCalled();
  });

  it('אומר במפורש שהדלת הזו פותחת עסק חדש ואינה הצטרפות לעסק קיים', () => {
    federated.providers = ['google'];
    render(<MemoryRouter><Login /></MemoryRouter>);

    expect(screen.getByText('לפתיחת עסק חדש. הצטרפות לעסק קיים נעשית מהזמנה שנשלחה אליך.'))
      .toBeInTheDocument();
  });

  it('מתחבר מיד לחשבון הדמו המקומי שנבחר', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:55431');
    vi.stubEnv('VITE_DEMO_PASSWORD_SEED', 'manualgate2026');
    render(<MemoryRouter><Login /></MemoryRouter>);

    fireEvent.click(screen.getByText('חשבונות דמו מקומיים'));
    fireEvent.click(screen.getByRole('button', { name: 'כניסה כמנהל/בעלים' }));

    await waitFor(() => {
      expect(signIn).toHaveBeenCalledWith(
        'owner@demo.supplyflow.local',
        'P4!manualgate2026-owner-Aa7',
      );
    });
  });

  it('אינו חושף חשבונות דמו כשהאפליקציה מצביעה לייצור', () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://rkftlbctohswhbbiaqin.supabase.co');
    vi.stubEnv('VITE_DEMO_PASSWORD_SEED', 'manualgate2026');
    render(<MemoryRouter><Login /></MemoryRouter>);

    expect(screen.queryByText('חשבונות דמו מקומיים')).not.toBeInTheDocument();
  });
});
