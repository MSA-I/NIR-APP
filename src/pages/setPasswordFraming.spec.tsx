import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * RC9 of the 03.09.2026 remediation plan: `/set-password` is a PUBLIC route, so a signed-in reader
 * who already has a password can open it by typing the address — and used to be greeted with "the
 * address is confirmed, now choose a password", which is false for them.
 *
 * WHAT THIS PINS, and just as importantly what it refuses to pin:
 *   1. A pending owner still reads the first-password framing, unchanged.
 *   2. A reader who is NOT pending reads a different heading and a different intro — a password
 *      change, described as one.
 *   3. That reader is still allowed to change the password, through the SAME single call. The
 *      defect was a misleading context, not an authorization hole: a signed-in user replaces their
 *      password with no current-password field from `Settings.tsx` and from `/reset-password`
 *      already, so a refusal here would close nothing and would claim a protection that does not
 *      exist. A test asserting a refusal would pin a lie into the codebase.
 *   4. Closing the screen still loses nothing — which is why the second framing, and only it,
 *      offers the way back into the product.
 */
const getSession = vi.fn();
const updateUser = vi.fn();

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => getSession(),
      updateUser: (...a: unknown[]) => updateUser(...a),
    },
  },
  authCallbackFragment: new URLSearchParams(''),
}));

import { he } from '../lib/i18n/dictionaries/he';
import SetPassword from './SetPassword';

const sessionFor = (metadata: Record<string, unknown>) => ({
  data: { session: { user: { id: 'u1', email: 'owner@example.test', user_metadata: metadata } } },
  error: null,
});

const renderScreen = () => render(
  <MemoryRouter initialEntries={['/set-password']}>
    <Routes><Route path="/set-password" element={<SetPassword />} /></Routes>
  </MemoryRouter>,
);

const headingText = () => screen.getByRole('heading', { level: 1 }).textContent ?? '';

/** The form only appears once the session check has answered, so it marks "settled". */
const settled = () => waitFor(() => expect(screen.getByRole('button')).toBeInTheDocument());

const backToAppLink = () =>
  screen.queryAllByRole('link').find((link) => link.getAttribute('href') === '/');

beforeEach(() => {
  getSession.mockReset();
  updateUser.mockReset();
  updateUser.mockResolvedValue({ data: {}, error: null });
});

describe('/set-password framing', () => {
  it('greets a pending owner with the first-password wording and no way out', async () => {
    getSession.mockResolvedValue(sessionFor({ password_pending: true }));
    renderScreen();
    await settled();

    expect(screen.getByText(he.setPassword.intro)).toBeInTheDocument();
    expect(headingText()).toBe(he.setPassword.title);
    expect(screen.getByRole('button')).toHaveTextContent(he.setPassword.action);
    expect(backToAppLink()).toBeUndefined();
  });

  it('says something different to a reader who already has a password', async () => {
    getSession.mockResolvedValue(sessionFor({ password_pending: true }));
    renderScreen();
    await settled();
    const pendingHeading = headingText();
    cleanup();

    getSession.mockResolvedValue(sessionFor({}));
    renderScreen();
    await settled();

    expect(headingText()).not.toBe(pendingHeading);
    expect(headingText()).not.toBe(he.setPassword.title);
    expect(screen.queryByText(he.setPassword.intro)).toBeNull();
    expect(screen.getByRole('button')).not.toHaveTextContent(he.setPassword.action);
    expect(backToAppLink()).toBeDefined();
  });

  it('still lets that reader change the password, through the same single call', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    getSession.mockResolvedValue(sessionFor({}));
    renderScreen();

    const field = await screen.findByLabelText(/סיסמה חדשה/);
    await user.type(field, 'Aa123456789!');
    await user.type(screen.getByLabelText('אימות סיסמה'), 'Aa123456789!');
    await user.click(screen.getByRole('button'));

    await waitFor(() => expect(updateUser).toHaveBeenCalledTimes(1));
    expect(updateUser).toHaveBeenCalledWith({
      password: 'Aa123456789!',
      data: { password_pending: false },
    });
  });

  it('leaves the no-session answer exactly as it was', async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null });
    renderScreen();

    expect(await screen.findByText(he.setPassword.needsConfirmedLink)).toBeInTheDocument();
    expect(screen.queryByLabelText(/סיסמה חדשה/)).toBeNull();
    expect(headingText()).toBe(he.setPassword.title);
  });
});
