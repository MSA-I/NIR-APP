import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two invitation screens, and the round trip PKCE made them need.
 *
 * WHAT CHANGED AND WHY. The client now creates its session with `flowType: 'pkce'`, and every mail
 * links to `/auth/confirm?token_hash=…`. When a project requires e-mail confirmation, signing up on
 * an invitation screen yields no session — the invitee has to confirm first — and the mail has to
 * come BACK to the invitation, carrying the invitation's own token. That is what `emailRedirectTo`
 * is for here: GoTrue puts it in `{{ .RedirectTo }}`, the template hands it to `/auth/confirm` as
 * `next`, and the route returns the browser to this screen with a session in hand.
 *
 * So each screen is pinned twice:
 *   1. Going out — the sign-up names a return address that carries the token, and exactly one query
 *      parameter, because the template interpolates `{{ .RedirectTo }}` unencoded.
 *   2. Coming back — a session for the INVITED address finishes the job without asking for the
 *      password a second time, while a session for somebody else does not open that door.
 */
const signUp = vi.fn();
const signInWithPassword = vi.fn();
const getSession = vi.fn();
const rpc = vi.fn();

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      signUp: (...a: unknown[]) => signUp(...a),
      signInWithPassword: (...a: unknown[]) => signInWithPassword(...a),
      getSession: () => getSession(),
    },
    rpc: (...a: unknown[]) => rpc(...a),
  },
  authCallbackFragment: new URLSearchParams(''),
}));

vi.mock('../auth/AuthContext', () => ({ homeFor: () => '/dashboard' }));

import AcceptInvite from './AcceptInvite';
import AcceptOperatorInvite from './AcceptOperatorInvite';

const INVITED = 'clerk@example.test';
const TOKEN = 'a'.repeat(64);

const sessionFor = (email: string | null) => ({
  data: { session: email ? { user: { id: 'u1', email } } : null },
  error: null,
});

beforeEach(() => {
  signUp.mockReset();
  signInWithPassword.mockReset();
  getSession.mockReset();
  rpc.mockReset();
  getSession.mockResolvedValue(sessionFor(null));
  signUp.mockResolvedValue({ data: { session: null, user: { id: 'u1' } }, error: null });
  rpc.mockResolvedValue({ data: { org_id: 'org-1', role: 'office' }, error: null });
});

function renderTenantInvite() {
  return render(
    <MemoryRouter initialEntries={[`/accept-invite?token=${TOKEN}`]}>
      <Routes><Route path="/accept-invite" element={<AcceptInvite />} /></Routes>
    </MemoryRouter>,
  );
}

function renderOperatorInvite() {
  return render(
    <MemoryRouter initialEntries={[`/operator-invite?token=${TOKEN}`]}>
      <Routes><Route path="/operator-invite" element={<AcceptOperatorInvite />} /></Routes>
    </MemoryRouter>,
  );
}

describe('the tenant invitation', () => {
  beforeEach(() => {
    // `lookup_invitation` is how the screen learns whose invitation this is.
    rpc.mockImplementation((command: string) => {
      if (command === 'lookup_invitation') {
        return Promise.resolve({
          data: { status: 'valid', email: INVITED, org_name: 'מסעדת הגפן', role: 'office' },
          error: null,
        });
      }
      return Promise.resolve({ data: { org_id: 'org-1', role: 'office' }, error: null });
    });
  });

  it('names a return address that carries the token, with one query parameter', async () => {
    const user = userEvent.setup();
    renderTenantInvite();

    await user.type(await screen.findByLabelText('שם מלא'), 'משה כהן');
    await user.type(screen.getByLabelText(/^סיסמה \(/), 'Aa123456789!');
    await user.type(screen.getByLabelText('אימות סיסמה'), 'Aa123456789!');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'השלמת ההצטרפות' }));

    await waitFor(() => expect(signUp).toHaveBeenCalled());
    const options = (signUp.mock.calls[0]![0] as { options?: { emailRedirectTo?: string } }).options;
    const back = new URL(options!.emailRedirectTo!);
    expect(back.pathname).toBe('/accept-invite');
    expect(back.searchParams.get('token')).toBe(TOKEN);
    // One parameter, because `{{ .RedirectTo }}` is interpolated unencoded: a second `&`-separated
    // pair would be read as a parameter of /auth/confirm and the token would be lost on the way.
    expect([...back.searchParams.keys()]).toEqual(['token']);
  });

  it('coming back with a session for the invited address, asks for no password at all', async () => {
    getSession.mockResolvedValue(sessionFor(INVITED.toUpperCase()));
    const user = userEvent.setup();
    renderTenantInvite();

    expect(await screen.findByText(/הכתובת אושרה והסיסמה כבר נבחרה/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^סיסמה \(/)).toBeNull();
    expect(screen.queryByLabelText('אימות סיסמה')).toBeNull();

    await user.type(screen.getByLabelText('שם מלא'), 'משה כהן');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'השלמת ההצטרפות' }));

    // Straight to acceptance: no second account, and no second password.
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('accept_invitation', expect.anything()));
    expect(signUp).not.toHaveBeenCalled();
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it('a session for somebody else is not an entrance', async () => {
    // `accept_invitation` resolves the invitation from the CALLER's confirmed address (0282), so a
    // stranger's session would only produce a refusal one step later — after the form had claimed
    // it would work.
    getSession.mockResolvedValue(sessionFor('someone.else@example.test'));
    renderTenantInvite();
    expect(await screen.findByLabelText(/^סיסמה \(/)).toBeInTheDocument();
    expect(screen.queryByText(/הכתובת אושרה והסיסמה כבר נבחרה/)).toBeNull();
  });
});

describe('the operator invitation', () => {
  beforeEach(() => {
    rpc.mockImplementation((command: string) => {
      if (command === 'lookup_platform_operator_invitation') {
        return Promise.resolve({
          data: { status: 'valid', email: INVITED, role_key: 'support', role_label: 'תמיכה' },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
  });

  it('names a return address that carries the operator token', async () => {
    const user = userEvent.setup();
    renderOperatorInvite();

    await user.type(await screen.findByLabelText('סיסמה'), 'Aa123456789!');
    await user.type(screen.getByLabelText('אימות סיסמה'), 'Aa123456789!');
    await user.click(screen.getByRole('button', { name: 'הצטרפות לצוות' }));

    await waitFor(() => expect(signUp).toHaveBeenCalled());
    const options = (signUp.mock.calls[0]![0] as { options?: { emailRedirectTo?: string } }).options;
    const back = new URL(options!.emailRedirectTo!);
    expect(back.pathname).toBe('/operator-invite');
    expect(back.searchParams.get('token')).toBe(TOKEN);
    expect([...back.searchParams.keys()]).toEqual(['token']);
  });

  it('coming back with a session for the invited address, joins without a password', async () => {
    getSession.mockResolvedValue(sessionFor(INVITED));
    const user = userEvent.setup();
    renderOperatorInvite();

    expect(await screen.findByText(/הכתובת אושרה והסיסמה כבר נבחרה/)).toBeInTheDocument();
    expect(screen.queryByLabelText('סיסמה')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'הצטרפות לצוות' }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('accept_platform_operator_invitation', expect.anything()));
    expect(signUp).not.toHaveBeenCalled();
  });
});
