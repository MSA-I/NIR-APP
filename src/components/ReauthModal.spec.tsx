import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session } from '@supabase/supabase-js';
import { toHebrewError } from '../lib/errors';

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
  it('skips the prompt entirely when the JWT is fresh', async () => {
    const fresh = sessionWith(passwordToken(30));
    authState.session = fresh;
    const onConfirm = vi.fn();
    render(<ReauthModal open onConfirm={onConfirm} onCancel={vi.fn()} />);
    // Second argument: the optional reason, empty because the dialog never painted a box to type in.
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(fresh, ''));
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

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(freshSession, ''));
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

/**
 * #290 collapsed the supplier bank flow's two consecutive dialogs into this one, by letting the
 * step-up carry an optional reason. The risk of that is a gate that quietly softened while a field
 * was being added, so what is measured here is both: the field behaves like #290 requires, and
 * every password rule above is untouched by its presence.
 */
describe('ReauthModal — the optional reason field', () => {
  const REASON_LABEL = 'למה משנים? (רשות)';

  it('has no reason box at all unless a label is given', () => {
    render(<ReauthModal open onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('hands back what was typed, and never blocks the button when nothing was', async () => {
    const user = userEvent.setup();
    const freshSession = { access_token: 'fresh', user: { id: 'user-1' } };
    auth.signInWithPassword.mockResolvedValue({
      data: { user: { id: 'user-1' }, session: freshSession },
      error: null,
    });
    const onConfirm = vi.fn();
    render(<ReauthModal open reasonLabel={REASON_LABEL} onConfirm={onConfirm} onCancel={vi.fn()} />);
    await waitForInitialDialogFocus();

    // An empty reason does not disable anything; an empty PASSWORD still does.
    const confirm = screen.getByRole('button', { name: /אישור זהות/ });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText('סיסמה לאימות זהות טרי *'), 'secret-pass');
    expect(confirm).toBeEnabled();

    await user.type(screen.getByLabelText(REASON_LABEL), 'החלפת חשבון לפי מכתב מהספק');
    await user.click(confirm);

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(freshSession, 'החלפת חשבון לפי מכתב מהספק'));
  });

  it('confirms with an empty reason when the box is left alone', async () => {
    const user = userEvent.setup();
    const freshSession = { access_token: 'fresh', user: { id: 'user-1' } };
    auth.signInWithPassword.mockResolvedValue({
      data: { user: { id: 'user-1' }, session: freshSession },
      error: null,
    });
    const onConfirm = vi.fn();
    render(<ReauthModal open reasonLabel={REASON_LABEL} onConfirm={onConfirm} onCancel={vi.fn()} />);
    await waitForInitialDialogFocus();

    await user.type(screen.getByLabelText('סיסמה לאימות זהות טרי *'), 'secret-pass');
    await user.click(screen.getByRole('button', { name: /אישור זהות/ }));

    // '' is what the caller runs through `reasonOr` — the modal does not invent a sentence itself.
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(freshSession, ''));
  });

  it('does not let the reason field open a door around the password', async () => {
    const user = userEvent.setup();
    auth.signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: new Error('Invalid login credentials'),
    });
    const onConfirm = vi.fn();
    render(<ReauthModal open reasonLabel={REASON_LABEL} onConfirm={onConfirm} onCancel={vi.fn()} />);
    await waitForInitialDialogFocus();

    // A filled reason and a wrong password: nothing is confirmed, and the dialog stays.
    await user.type(screen.getByLabelText(REASON_LABEL), 'סיבה משכנעת מאוד');
    await user.type(screen.getByLabelText('סיסמה לאימות זהות טרי *'), 'wrong-pass');
    await user.click(screen.getByRole('button', { name: /אישור זהות/ }));

    expect(await screen.findByText('אימייל או סיסמה שגויים.')).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('forgets the typed reason once the dialog closes', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ReauthModal open reasonLabel={REASON_LABEL} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    await waitForInitialDialogFocus();
    await user.type(screen.getByLabelText(REASON_LABEL), 'טיוטה שלא נשלחה');

    rerender(<ReauthModal open={false} reasonLabel={REASON_LABEL} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    rerender(<ReauthModal open reasonLabel={REASON_LABEL} onConfirm={vi.fn()} onCancel={vi.fn()} />);

    // Same rule the password field has always had: nothing survives a closed dialog.
    expect(screen.getByLabelText(REASON_LABEL)).toHaveValue('');
  });

  it('says what is about to change when the caller supplies the sentence', () => {
    render(
      <ReauthModal open details="פרטי הבנק של ״ספק בדיקה״ יעודכנו." onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('פרטי הבנק של ״ספק בדיקה״ יעודכנו.');
    // The shared explanation is not replaced by it — both sentences are shown.
    expect(dialog).toHaveTextContent('הפעולה רגישה ודורשת אימות סיסמה טרי');
  });
});

describe('fresh_authentication_required — the Hebrew mapping (migration 0061)', () => {
  it('maps the server error to the sentence a business user can act on', () => {
    expect(toHebrewError(new Error('fresh_authentication_required'))).toBe(
      'נדרש אימות מחדש — הזינו סיסמה כדי לאשר פעולה רגישה.',
    );
  });
});
