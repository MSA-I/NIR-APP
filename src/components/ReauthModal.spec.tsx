import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session } from '@supabase/supabase-js';
import { toHebrewError } from '../lib/errors';
import { LocaleProvider } from '../lib/i18n/LocaleProvider';

/**
 * The auth surface is mocked as functions, not as MSW traffic, on purpose: the assertions here
 * are about *which* auth calls the modal makes (sign-in with the current identity, sign-out on
 * a mismatch) — observable directly on the mock, with no GoTrue wire format in the way.
 */
const auth = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('../lib/supabase', () => ({ supabase: { auth } }));

const authState = vi.hoisted(() => ({ session: null as unknown }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ session: authState.session }) }));

import {
  ReauthModal,
  hasFreshPasswordAuthentication,
  FRESH_PASSWORD_WINDOW_SECONDS,
  FRESH_PASSWORD_CLOCK_SKEW_SECONDS,
} from './ReauthModal';

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const tokenWithPayload = (payload: object) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.sig`;
const tokenWithAmr = (amr: unknown) => tokenWithPayload({ amr });
const nowSec = () => Math.floor(Date.now() / 1000);
const passwordToken = (ageSeconds: number) =>
  tokenWithAmr([{ method: 'password', timestamp: nowSec() - ageSeconds }]);

const sessionWith = (token: string): Session =>
  ({ access_token: token, user: { id: 'user-1', email: 'owner@example.com' } }) as unknown as Session;

beforeEach(() => {
  auth.signInWithPassword.mockReset();
  auth.signOut.mockReset();
  authState.session = sessionWith(passwordToken(10 * 60));
});

/**
 * The shared dialog layer moves focus to the panel on its first animation frame. Wait for that
 * handoff before typing so the frame cannot interrupt the password interaction.
 */
async function waitForInitialDialogFocus() {
  await waitFor(() => expect(screen.getByRole('dialog')).toHaveFocus());
}

describe('hasFreshPasswordAuthentication — the client mirror of the 0031 assertion', () => {
  it('accepts a password entry inside the window', () => {
    expect(hasFreshPasswordAuthentication(passwordToken(60))).toBe(true);
  });

  it('rejects a password entry older than the window', () => {
    expect(hasFreshPasswordAuthentication(passwordToken(FRESH_PASSWORD_WINDOW_SECONDS + 30))).toBe(false);
  });

  it('tolerates clock skew up to +30s but rejects a further-future timestamp', () => {
    expect(hasFreshPasswordAuthentication(passwordToken(-10))).toBe(true);
    expect(
      hasFreshPasswordAuthentication(passwordToken(-(FRESH_PASSWORD_CLOCK_SKEW_SECONDS + 60))),
    ).toBe(false);
  });

  it('fails closed when amr is not an array', () => {
    expect(hasFreshPasswordAuthentication(tokenWithAmr({ method: 'password', timestamp: nowSec() }))).toBe(false);
    expect(hasFreshPasswordAuthentication(tokenWithPayload({ sub: 'user-1' }))).toBe(false);
  });

  it('counts only password entries — an SSO or refresh entry is not a fresh password', () => {
    expect(hasFreshPasswordAuthentication(tokenWithAmr([{ method: 'oauth', timestamp: nowSec() }]))).toBe(false);
    expect(
      hasFreshPasswordAuthentication(tokenWithAmr([{ method: 'password', timestamp: 'now' }])),
    ).toBe(false);
  });

  it('takes the freshest password entry, like max(timestamp) on the server', () => {
    const token = tokenWithAmr([
      { method: 'password', timestamp: nowSec() - 60 * 60 },
      { method: 'password', timestamp: nowSec() - 30 },
    ]);
    expect(hasFreshPasswordAuthentication(token)).toBe(true);
  });

  it('fails closed on a malformed token', () => {
    expect(hasFreshPasswordAuthentication('not-a-jwt')).toBe(false);
    expect(hasFreshPasswordAuthentication(`${b64url({})}.%%%%.sig`)).toBe(false);
    expect(hasFreshPasswordAuthentication('')).toBe(false);
  });
});

describe('ReauthModal', () => {
  it('renders the stale-session prompt in English', () => {
    render(
      <LocaleProvider initialLocale="en">
        <ReauthModal open onConfirm={vi.fn()} onCancel={vi.fn()} />
      </LocaleProvider>,
    );
    expect(screen.getByRole('dialog', { name: 'Verify identity for a sensitive action' })).toBeInTheDocument();
    expect(screen.getByLabelText('Password for fresh identity verification *')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verify identity' })).toBeInTheDocument();
  });

  it('skips the prompt entirely when the JWT is fresh', async () => {
    const fresh = sessionWith(passwordToken(30));
    authState.session = fresh;
    const onConfirm = vi.fn();
    render(<ReauthModal open onConfirm={onConfirm} onCancel={vi.fn()} />);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(fresh));
    // No dialog, no auth traffic: a user who signed in seconds ago is not asked again.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it('prompts when the JWT is stale and confirms with the fresh session', async () => {
    const user = userEvent.setup();
    const freshSession = { access_token: 'fresh', user: { id: 'user-1' } };
    auth.signInWithPassword.mockResolvedValue({
      data: { user: { id: 'user-1' }, session: freshSession },
      error: null,
    });
    const onConfirm = vi.fn();
    render(<ReauthModal open onConfirm={onConfirm} onCancel={vi.fn()} />);
    await waitForInitialDialogFocus();

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.type(screen.getByLabelText('סיסמה לאימות זהות טרי *'), 'secret-pass');
    await user.click(screen.getByRole('button', { name: /אישור זהות/ }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(freshSession));
    // The identity is always the signed-in user's — never a typed one.
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: 'owner@example.com', password: 'secret-pass' });
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it('keeps prompting a fresh session when skipWhenFresh is false (the emergency path)', () => {
    authState.session = sessionWith(passwordToken(30));
    const onConfirm = vi.fn();
    render(<ReauthModal open skipWhenFresh={false} onConfirm={onConfirm} onCancel={vi.fn()} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('signs the whole session out when a different user answers the password', async () => {
    const user = userEvent.setup();
    auth.signInWithPassword.mockResolvedValue({
      data: { user: { id: 'intruder-2' }, session: { access_token: 'x' } },
      error: null,
    });
    auth.signOut.mockResolvedValue({ error: null });
    const onConfirm = vi.fn();
    render(<ReauthModal open onConfirm={onConfirm} onCancel={vi.fn()} />);
    await waitForInitialDialogFocus();

    await user.type(screen.getByLabelText('סיסמה לאימות זהות טרי *'), 'secret-pass');
    await user.click(screen.getByRole('button', { name: /אישור זהות/ }));

    await waitFor(() => expect(auth.signOut).toHaveBeenCalled());
    expect(onConfirm).not.toHaveBeenCalled();
    expect(await screen.findByText('זהות המשתמש השתנתה בזמן האימות. יש להתחבר מחדש.')).toBeInTheDocument();
  });

  it('maps a wrong password to Hebrew and clears the field', async () => {
    const user = userEvent.setup();
    auth.signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: new Error('Invalid login credentials'),
    });
    render(<ReauthModal open onConfirm={vi.fn()} onCancel={vi.fn()} />);
    await waitForInitialDialogFocus();

    const field = screen.getByLabelText('סיסמה לאימות זהות טרי *');
    await user.type(field, 'wrong-pass');
    await user.click(screen.getByRole('button', { name: /אישור זהות/ }));

    expect(await screen.findByText('אימייל או סיסמה שגויים.')).toBeInTheDocument();
    // Cleared in finally — the password never survives the attempt, success or failure.
    expect(field).toHaveValue('');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('cancels without touching auth', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<ReauthModal open onConfirm={vi.fn()} onCancel={onCancel} />);
    await waitForInitialDialogFocus();
    await user.click(screen.getByRole('button', { name: 'ביטול' }));
    expect(onCancel).toHaveBeenCalled();
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
  });
});

describe('fresh_authentication_required — the Hebrew mapping (migration 0061)', () => {
  it('maps the server error to the sentence a business user can act on', () => {
    expect(toHebrewError(new Error('fresh_authentication_required'))).toBe(
      'נדרש אימות מחדש — הזינו סיסמה כדי לאשר פעולה רגישה.',
    );
  });
});
