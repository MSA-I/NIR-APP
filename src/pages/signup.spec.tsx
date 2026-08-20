import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Signup from './Signup';

const invoke = vi.fn();
vi.mock('../lib/supabase', () => ({ supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) } } }));

const NEUTRAL = 'אם הכתובת אינה רשומה עדיין — נשלח אליה מייל אישור';

const renderScreen = () => render(<MemoryRouter><Signup /></MemoryRouter>);

const fill = async () => {
  const user = userEvent.setup();
  renderScreen();
  await user.type(screen.getByLabelText('שם העסק'), 'מסעדת הגפן');
  await user.type(screen.getByLabelText('שם מלא'), 'משה כהן');
  await user.type(screen.getByLabelText('אימייל'), 'owner@example.test');
  await user.type(screen.getByLabelText('סיסמה'), 'a-long-enough-password');
  return user;
};

beforeEach(() => {
  invoke.mockResolvedValue({ data: { status: 'pending_confirmation', message: NEUTRAL }, error: null });
});

describe('פתיחת חשבון', () => {
  it('שולח ארבעה שדות בלבד — מסלול, סטטוס ומע״מ אינם של הנרשם', async () => {
    // A form that could ask for a plan would be a free upgrade. The edge function reads exactly
    // these four keys, and sending more would change nothing — but offering them would mislead.
    const user = await fill();
    await user.click(screen.getByRole('button', { name: 'פתיחת חשבון' }));

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    const body = invoke.mock.calls[0]![1].body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['email', 'full_name', 'organization_name', 'password']);
  });

  it('מציג את אותה תשובה בדיוק גם כשהכתובת כבר רשומה', async () => {
    // The endpoint answers a duplicate address identically to a fresh signup, so this screen must
    // not add a distinction of its own and turn the page into an account-enumeration tool.
    const user = await fill();
    await user.click(screen.getByRole('button', { name: 'פתיחת חשבון' }));
    expect(await screen.findByText(/בדקו את תיבת הדואר/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(NEUTRAL))).toBeInTheDocument();
  });

  it('אינו מאפשר שליחה עם סיסמה קצרה מדי', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.type(screen.getByLabelText('שם העסק'), 'עסק');
    await user.type(screen.getByLabelText('שם מלא'), 'משה');
    await user.type(screen.getByLabelText('אימייל'), 'owner@example.test');
    await user.type(screen.getByLabelText('סיסמה'), 'short');
    expect(screen.getByRole('button', { name: 'פתיחת חשבון' })).toBeDisabled();
  });

  it('מציג את הודעת הסירוב של השרת כשההרשמה נחסמה בקצב', async () => {
    invoke.mockResolvedValue({
      data: null,
      error: {
        message: 'non-2xx',
        context: {
          json: async () => ({ error: { code: 'rate_limited', message: 'התקבלו יותר מדי בקשות הרשמה. יש לנסות שוב מאוחר יותר.' } }),
        },
      },
    });
    const user = await fill();
    await user.click(screen.getByRole('button', { name: 'פתיחת חשבון' }));
    expect(await screen.findByText(/יותר מדי בקשות הרשמה/)).toBeInTheDocument();
  });
});
