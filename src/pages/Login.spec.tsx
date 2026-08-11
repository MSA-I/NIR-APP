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

  it('מציע מילוי חשבון דמו רק מול הסטאק המקומי', () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:55431');
    vi.stubEnv('VITE_DEMO_PASSWORD_SEED', 'manualgate2026');
    render(<MemoryRouter><Login /></MemoryRouter>);

    fireEvent.click(screen.getByText('חשבונות דמו מקומיים'));
    fireEvent.click(screen.getByRole('button', { name: 'מילוי פרטי מנהל/בעלים' }));

    expect(screen.getByLabelText('אימייל')).toHaveValue('owner@demo.supplyflow.local');
    expect(screen.getByLabelText('סיסמה')).toHaveValue('P4!manualgate2026-owner-Aa7');
  });

  it('אינו חושף חשבונות דמו כשהאפליקציה מצביעה לייצור', () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://rkftlbctohswhbbiaqin.supabase.co');
    vi.stubEnv('VITE_DEMO_PASSWORD_SEED', 'manualgate2026');
    render(<MemoryRouter><Login /></MemoryRouter>);

    expect(screen.queryByText('חשבונות דמו מקומיים')).not.toBeInTheDocument();
  });
});
