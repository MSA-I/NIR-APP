/**
 * Package 1 — self-service password recovery (OPEN-DECISIONS #114) and the three active
 * product-account invitation roles.
 *
 * What is pinned here, at the wire level (real supabase-js against MSW):
 *   1. /forgot-password issues POST /auth/v1/recover with the typed address and a
 *      redirect_to that lands on /reset-password — the half of the contract the app owns.
 *   2. The success sentence is the anti-enumeration one, and a rate-limit failure is shown
 *      honestly instead of a false "נשלח".
 *   3. /reset-password with no session says the link is dead — it never shows a password
 *      form that updateUser would reject.
 *   4. With a session, a too-short password never reaches the server, and a valid one goes
 *      out as PUT /auth/v1/user { password }.
 *
 * What is NOT here: the GoTrue token exchange (recovery link → session). That is GoTrue's
 * half, and the quality gate's browser scenario follows a real action_link end to end.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { http, HttpResponse } from 'msw';
import { vi } from 'vitest';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';

/** Real supabase-js against the MSW base URL — the wire behaviour stays real. */
vi.mock('../lib/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const { SUPABASE_URL: url } = await import('../test/msw/handlers');
  return {
    supabase: createClient(url, 'test-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  };
});

import { supabase } from '../lib/supabase';
import ForgotPassword from './ForgotPassword';
import ResetPassword from './ResetPassword';
import { ASSIGNABLE_ROLES, INVITABLE_ROLES } from '../lib/invitations';

describe('invitation role lists', () => {
  it('invites and reassigns only owner, office and accountant', () => {
    expect(INVITABLE_ROLES).toEqual(['owner', 'office', 'accountant']);
    expect(ASSIGNABLE_ROLES).toEqual(INVITABLE_ROLES);
  });

  it('keeps every retired persona out of both invitation and reassignment', () => {
    expect(INVITABLE_ROLES).not.toContain('kitchen');
    expect(INVITABLE_ROLES).not.toContain('payer');
    expect(INVITABLE_ROLES).not.toContain('supplier');
    expect(ASSIGNABLE_ROLES).not.toContain('kitchen');
    expect(ASSIGNABLE_ROLES).not.toContain('payer');
    expect(ASSIGNABLE_ROLES).not.toContain('supplier');
  });
});

describe('/forgot-password', () => {
  it('sends recover with the typed address and a /reset-password redirect, then says the neutral sentence', async () => {
    const captured: { url: string; body: Record<string, unknown> }[] = [];
    server.use(
      http.post(`${SUPABASE_URL}/auth/v1/recover`, async ({ request }) => {
        captured.push({ url: request.url, body: (await request.json()) as Record<string, unknown> });
        return HttpResponse.json({});
      }),
    );

    const user = userEvent.setup();
    render(<MemoryRouter><ForgotPassword /></MemoryRouter>);
    await user.type(screen.getByLabelText('אימייל'), '  office@demo.supplyflow.local  ');
    await user.click(screen.getByRole('button', { name: /שליחת קישור איפוס/ }));

    // The anti-enumeration sentence: identical for registered and unknown addresses.
    await screen.findByText(/אם הכתובת רשומה במערכת/);
    expect(captured).toHaveLength(1);
    expect(captured[0].body.email).toBe('office@demo.supplyflow.local');
    const wire = captured[0].url + JSON.stringify(captured[0].body);
    expect(wire).toContain('reset-password');
  });

  it('shows the rate-limit truth instead of a false "נשלח"', async () => {
    server.use(
      http.post(`${SUPABASE_URL}/auth/v1/recover`, () =>
        HttpResponse.json({ code: 429, msg: 'email rate limit exceeded' }, { status: 429 })),
    );

    const user = userEvent.setup();
    render(<MemoryRouter><ForgotPassword /></MemoryRouter>);
    await user.type(screen.getByLabelText('אימייל'), 'office@demo.supplyflow.local');
    await user.click(screen.getByRole('button', { name: /שליחת קישור איפוס/ }));

    await screen.findByText(/נשלחו יותר מדי בקשות איפוס/);
    expect(screen.queryByText(/אם הכתובת רשומה במערכת/)).toBeNull();
  });
});

describe('/reset-password', () => {
  it('with no session and no tokens, reports a dead link and offers a fresh one', async () => {
    render(<MemoryRouter><ResetPassword /></MemoryRouter>);
    await screen.findByText(/הקישור אינו תקין או שפג תוקפו/);
    expect(screen.getByRole('link', { name: 'שליחת קישור חדש' })).toHaveAttribute('href', '/forgot-password');
    expect(screen.queryByLabelText(/סיסמה חדשה/)).toBeNull();
  });

  it('with a session: a short password never reaches the wire, a valid one is PUT to /auth/v1/user', async () => {
    const updates: Record<string, unknown>[] = [];
    const jwtPayload = btoa(JSON.stringify({ sub: 'user-1', role: 'authenticated' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const fakeJwt = `${btoa(JSON.stringify({ alg: 'none' }))}.${jwtPayload}.x`;
    const authUser = { id: 'user-1', aud: 'authenticated', email: 'office@demo.supplyflow.local' };
    server.use(
      http.post(`${SUPABASE_URL}/auth/v1/token`, () => HttpResponse.json({
        access_token: fakeJwt, token_type: 'bearer', expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'refresh-1', user: authUser,
      })),
      http.put(`${SUPABASE_URL}/auth/v1/user`, async ({ request }) => {
        updates.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(authUser);
      }),
    );

    const signIn = await supabase.auth.signInWithPassword({
      email: 'office@demo.supplyflow.local', password: 'irrelevant-here',
    });
    expect(signIn.error).toBeNull();

    const user = userEvent.setup();
    render(<MemoryRouter><ResetPassword /></MemoryRouter>);
    const passwordField = await screen.findByLabelText(/סיסמה חדשה/);

    await user.type(passwordField, 'short');
    await user.type(screen.getByLabelText('אימות סיסמה'), 'short');
    await user.click(screen.getByRole('button', { name: /החלפת סיסמה/ }));
    await screen.findByText(/הסיסמה חייבת להכיל לפחות/);
    expect(updates).toHaveLength(0);

    await user.clear(passwordField);
    await user.clear(screen.getByLabelText('אימות סיסמה'));
    await user.type(passwordField, 'Aa123456789!');
    await user.type(screen.getByLabelText('אימות סיסמה'), 'Aa123456789!');
    await user.click(screen.getByRole('button', { name: /החלפת סיסמה/ }));

    await screen.findByText(/הסיסמה הוחלפה/);
    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0].password).toBe('Aa123456789!');
  });
});
