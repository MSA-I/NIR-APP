import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Signup from './Signup';

const invoke = vi.fn();
const getSession = vi.fn();
const signInWithOAuth = vi.fn();
vi.mock('../lib/supabase', () => ({
  supabase: {
    functions: { invoke: (...a: unknown[]) => invoke(...a) },
    auth: {
      getSession: () => getSession(),
      signInWithOAuth: (...a: unknown[]) => signInWithOAuth(...a),
    },
  },
}));

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

/** A session as the auth server reports one: the provider lives in app_metadata, never in user_metadata. */
const googleSession = (over: Record<string, unknown> = {}) => ({
  data: {
    session: {
      user: {
        email: 'owner@gmail.test',
        app_metadata: { provider: 'google' },
        user_metadata: { full_name: 'משה כהן' },
        ...over,
      },
    },
  },
});

beforeEach(() => {
  invoke.mockResolvedValue({ data: { status: 'pending_confirmation', message: NEUTRAL }, error: null });
  getSession.mockResolvedValue({ data: { session: null } });
  signInWithOAuth.mockResolvedValue({ error: null });
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

  it('כפתור Google מוסתר כשהספק אינו מוגדר', async () => {
    renderScreen();
    await waitFor(() => expect(getSession).toHaveBeenCalled());
    // The flag is off in the test environment, and a door that leads to "provider not enabled"
    // is worse than no door.
    expect(screen.queryByRole('button', { name: 'המשך עם Google' })).toBeNull();
  });

  it('חזרה מ-Google מבקשת שם עסק בלבד — לא אימייל ולא סיסמה', async () => {
    getSession.mockResolvedValue(googleSession());
    renderScreen();

    await screen.findByText(/מחובר כ/);
    expect(screen.getByLabelText('שם העסק')).toBeInTheDocument();
    // Google proved the address; asking for it again, or for a password, would be theatre.
    expect(screen.queryByLabelText('אימייל')).toBeNull();
    expect(screen.queryByLabelText('סיסמה')).toBeNull();
  });

  it('המסלול הפדרטיבי שולח identity=google ולעולם לא סיסמה', async () => {
    getSession.mockResolvedValue(googleSession());
    const user = userEvent.setup();
    renderScreen();
    await screen.findByText(/מחובר כ/);
    await user.type(screen.getByLabelText('שם העסק'), 'מסעדת הגפן');
    await user.click(screen.getByRole('button', { name: 'פתיחת חשבון' }));

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    const body = invoke.mock.calls[0]![1].body as Record<string, unknown>;
    expect(body.identity).toBe('google');
    expect(body.organization_name).toBe('מסעדת הגפן');
    expect(body).not.toHaveProperty('password');
    // The address is the server's to read from the token, not the form's to assert.
    expect(body).not.toHaveProperty('email');
  });

  it('סשן שמצהיר על Google ב-user_metadata בלבד אינו נחשב Google', async () => {
    // user_metadata is self-asserted. If this branch could be entered by writing a value into it,
    // the whole owner-only rule would rest on a field the user controls.
    getSession.mockResolvedValue(googleSession({
      app_metadata: { provider: 'email' },
      user_metadata: { full_name: 'משה כהן', provider: 'google' },
    }));
    renderScreen();

    await waitFor(() => expect(getSession).toHaveBeenCalled());
    expect(screen.queryByText(/מחובר כ/)).toBeNull();
    expect(screen.getByLabelText('סיסמה')).toBeInTheDocument();
  });
});
