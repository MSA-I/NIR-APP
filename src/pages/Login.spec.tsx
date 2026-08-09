import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

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
});
