import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/AuthContext', () => ({
  homeFor: () => '/dashboard',
  useAuth: () => ({
    signIn: vi.fn(),
    session: null,
    profile: null,
    loading: false,
  }),
}));

import Login from './Login';

describe('מסך הכניסה', () => {
  afterEach(() => vi.unstubAllEnvs());

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

  it('מציג כפתור Google עתידי שאינו מבצע פעולה', () => {
    render(<MemoryRouter><Login /></MemoryRouter>);

    const googleButton = screen.getByRole('button', { name: 'המשך עם Google' });
    expect(googleButton).toHaveAttribute('aria-disabled', 'true');
    expect(googleButton).toHaveAttribute('title', 'חיבור Google יתווסף בהמשך');
    fireEvent.click(googleButton);
    expect(googleButton).toBeInTheDocument();
  });

  it('מציע מילוי חשבון דמו רק מול הסטאק המקומי', () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:55431');
    vi.stubEnv('VITE_DEMO_PASSWORD_SEED', 'manualgate2026');
    render(<MemoryRouter><Login /></MemoryRouter>);

    fireEvent.click(screen.getByText('חשבונות דמו מקומיים'));
    expect(screen.getAllByRole('button', { name: /^מילוי פרטי/ }).map((button) => button.textContent))
      .toEqual(['מנהל/בעלים', 'מנהל רכש', 'רואה חשבון']);
    fireEvent.click(screen.getByRole('button', { name: 'מילוי פרטי מנהל/בעלים' }));

    expect(screen.getByLabelText('אימייל')).toHaveValue('owner@demo.supplyflow.local');
    expect(screen.getByLabelText('סיסמה')).toHaveValue('P4!manualgate2026-owner-Aa7');
    expect(screen.queryByText('מנהל מטבח')).not.toBeInTheDocument();
    expect(screen.queryByText('מבצע העברות')).not.toBeInTheDocument();
    expect(screen.queryByText('ספק')).not.toBeInTheDocument();
  });

  it('אינו חושף חשבונות דמו כשהאפליקציה מצביעה לייצור', () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://rkftlbctohswhbbiaqin.supabase.co');
    vi.stubEnv('VITE_DEMO_PASSWORD_SEED', 'manualgate2026');
    render(<MemoryRouter><Login /></MemoryRouter>);

    expect(screen.queryByText('חשבונות דמו מקומיים')).not.toBeInTheDocument();
  });
});
