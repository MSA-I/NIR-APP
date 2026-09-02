import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/auth/confirm` — the landing pad every Auth e-mail points at, and `/set-password` behind it.
 *
 * WHAT IS PINNED HERE, and why it is worth a test rather than a read-through:
 *   1. The hash from the mail is spent EXACTLY ONCE, with the type the link declared, and nothing
 *      else is sent to `verifyOtp`.
 *   2. A fresh owner who owes a password lands on `/set-password` even though the mail carried the
 *      site root as its destination — which is what GoTrue substitutes when no redirect_to was
 *      given, and which is exactly the sign-up confirmation.
 *   3. An invitation gets back to the invitation, token intact.
 *   4. A destination on another origin is discarded rather than followed with a live session.
 *   5. A dead link says so and offers a fresh one, instead of spinning.
 *   6. `/set-password` sets the password and clears the flag IN ONE CALL — two calls would leave a
 *      window where the account has a password and still claims to be waiting for one.
 */
const verifyOtp = vi.fn();
const getSession = vi.fn();
const updateUser = vi.fn();

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      verifyOtp: (...a: unknown[]) => verifyOtp(...a),
      getSession: () => getSession(),
      updateUser: (...a: unknown[]) => updateUser(...a),
    },
  },
  authCallbackFragment: new URLSearchParams(''),
}));

import AuthConfirm from './AuthConfirm';
import SetPassword from './SetPassword';

const sessionFor = (metadata: Record<string, unknown>) => ({
  data: {
    session: { user: { id: 'u1', email: 'owner@example.test', user_metadata: metadata } },
    user: { id: 'u1', email: 'owner@example.test', user_metadata: metadata },
  },
  error: null,
});

/** The whole surface under one router, so a redirect is proved by what renders after it. */
function renderConfirm(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/auth/confirm${search}`]}>
      <Routes>
        <Route path="/auth/confirm" element={<AuthConfirm />} />
        <Route path="/set-password" element={<SetPassword />} />
        <Route path="/reset-password" element={<div>landed on reset</div>} />
        <Route path="/accept-invite" element={<div>landed on the invitation</div>} />
        <Route path="/" element={<div>landed on the product</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  verifyOtp.mockReset();
  getSession.mockReset();
  updateUser.mockReset();
  verifyOtp.mockResolvedValue(sessionFor({ password_pending: true }));
  getSession.mockResolvedValue(sessionFor({ password_pending: true }));
  updateUser.mockResolvedValue({ data: {}, error: null });
});

describe('/auth/confirm', () => {
  it('spends the token hash once, with the type the link declared and nothing else', async () => {
    renderConfirm('?token_hash=hash-1&type=signup');
    await waitFor(() => expect(verifyOtp).toHaveBeenCalledTimes(1));
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'hash-1', type: 'signup' });
  });

  it('sends a fresh owner who owes a password to the screen that takes one', async () => {
    // `next` is the project Site URL — this origin's ROOT — because public-signup deliberately
    // passes no redirect_to and GoTrue substitutes the Site URL. Built from the live origin so the
    // case is "same origin, bare root" and not "a foreign host that happened to be discarded".
    renderConfirm(`?token_hash=hash-1&type=signup&next=${window.location.origin}/`);
    expect(await screen.findByLabelText(/סיסמה חדשה/)).toBeInTheDocument();
  });

  it('carries an invitation back to the invitation, token intact', async () => {
    verifyOtp.mockResolvedValue(sessionFor({}));
    renderConfirm(`?token_hash=hash-2&type=invite&next=${window.location.origin}/accept-invite?token=abc`);
    expect(await screen.findByText('landed on the invitation')).toBeInTheDocument();
  });

  it('sends a recovery link to the reset screen whatever next says', async () => {
    verifyOtp.mockResolvedValue(sessionFor({}));
    renderConfirm(`?token_hash=hash-3&type=recovery&next=${window.location.origin}/accept-invite?token=abc`);
    expect(await screen.findByText('landed on reset')).toBeInTheDocument();
  });

  it('discards a destination on another origin rather than following it with a live session', async () => {
    verifyOtp.mockResolvedValue(sessionFor({}));
    renderConfirm('?token_hash=hash-4&type=magiclink&next=https://evil.example/steal');
    expect(await screen.findByText('landed on the product')).toBeInTheDocument();
  });

  it('says a dead link is dead, and offers a fresh one instead of spinning', async () => {
    verifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: { message: 'expired' } });
    renderConfirm('?token_hash=spent&type=signup');
    expect(await screen.findByText(/הקישור אינו תקין/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'שליחת קישור חדש' })).toHaveAttribute('href', '/forgot-password');
  });

  it('refuses a link with no hash or an unknown type without calling the server', async () => {
    renderConfirm('?type=signup');
    expect(await screen.findByText(/הקישור אינו תקין/)).toBeInTheDocument();

    renderConfirm('?token_hash=hash-9&type=sms');
    await waitFor(() => expect(screen.getAllByText(/הקישור אינו תקין/).length).toBe(2));
    expect(verifyOtp).not.toHaveBeenCalled();
  });
});

describe('/set-password', () => {
  const renderScreen = () => render(
    <MemoryRouter initialEntries={['/set-password']}>
      <Routes><Route path="/set-password" element={<SetPassword />} /></Routes>
    </MemoryRouter>,
  );

  it('sets the password and clears the pending flag in ONE call', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    renderScreen();

    const field = await screen.findByLabelText(/סיסמה חדשה/);
    await user.type(field, 'short');
    await user.type(screen.getByLabelText('אימות סיסמה'), 'short');
    await user.click(screen.getByRole('button', { name: 'שמירת הסיסמה' }));
    // A password the client already knows is too short never reaches the wire.
    expect(await screen.findByText(/הסיסמה חייבת להכיל לפחות/)).toBeInTheDocument();
    expect(updateUser).not.toHaveBeenCalled();

    await user.clear(field);
    await user.clear(screen.getByLabelText('אימות סיסמה'));
    await user.type(field, 'Aa123456789!');
    await user.type(screen.getByLabelText('אימות סיסמה'), 'Aa123456789!');
    await user.click(screen.getByRole('button', { name: 'שמירת הסיסמה' }));

    await waitFor(() => expect(updateUser).toHaveBeenCalledTimes(1));
    expect(updateUser).toHaveBeenCalledWith({
      password: 'Aa123456789!',
      data: { password_pending: false },
    });
  });

  it('with no session, says the link is what opens this screen', async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null });
    renderScreen();
    expect(await screen.findByText(/כדי לבחור סיסמה צריך להגיע מקישור האישור/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/סיסמה חדשה/)).toBeNull();
  });
});
