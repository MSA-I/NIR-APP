/**
 * The owner-facing webhook screen (#98 / #253).
 *
 * What these assertions are for, and what they are NOT for. They prove the screen refuses,
 * discloses and orders things correctly. They prove NOTHING about whether the RPCs exist — the
 * module is mocked here, and a mock agrees with whatever the UI happens to call. That half is
 * proven in `supabase/tests/p76_owner_webhook_verification.sql`, which resolves every one of
 * these five call sites by exact signature through `to_regprocedure`.
 *
 * The disclosure assertions are the load-bearing ones: #98 says this surface shows the last
 * successful delivery and the pending/failed counts, and never a secret and never a raw error.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../components/ui';
import { ROLE_LABEL } from '../lib/status';
import type { WebhookSubscription } from '../lib/webhooks';

const readWebhookSubscriptions = vi.fn();
const registerWebhookSubscription = vi.fn();
const requestWebhookVerification = vi.fn();
const runWebhookVerification = vi.fn();
const setWebhookSubscriptionActive = vi.fn();

/** Only the five network calls are replaced; every pure helper stays real. */
vi.mock('../lib/webhooks', async () => {
  const actual = await vi.importActual<typeof import('../lib/webhooks')>('../lib/webhooks');
  return {
    ...actual,
    readWebhookSubscriptions: () => readWebhookSubscriptions(),
    registerWebhookSubscription: (input: unknown) => registerWebhookSubscription(input),
    requestWebhookVerification: (id: string, reason: string) => requestWebhookVerification(id, reason),
    runWebhookVerification: (id: string) => runWebhookVerification(id),
    setWebhookSubscriptionActive: (id: string, active: boolean, reason: string) =>
      setWebhookSubscriptionActive(id, active, reason),
  };
});

/**
 * An owner with a JWT that already carries a fresh password proof, so ReauthModal skips.
 *
 * The proof is minted on every `useAuth()` call rather than once when this module loads, and that
 * is load-bearing rather than tidy. `FRESH_PASSWORD_WINDOW_SECONDS` is four minutes, and this file
 * has eleven `userEvent`-heavy tests; on a loaded CI runner it takes longer than that to reach the
 * last one. A timestamp frozen at import time expires part-way through the file, `ReauthModal`
 * stops skipping and asks for a password, and the RPC the final test waits for is never called —
 * which is exactly how it failed in CI while passing locally every time.
 *
 * Freshness EXPIRING is a real behaviour and deserves its own test with a deliberately stale
 * timestamp. What it must not be is an accident of how long the suite took to run.
 */
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => {
    const amr = { method: 'password', timestamp: Math.floor(Date.now() / 1000) };
    const payload = btoa(JSON.stringify({ sub: 'me', amr: [amr] }));
    return {
      profile: { id: 'me', org_id: 'org-1', role: 'owner', full_name: 'בעלת העסק', active: true },
      org: { id: 'org-1', name: 'ארגון', vat_rate: 18, settings: {} },
      session: { access_token: `x.${payload}.y`, user: { id: 'me', email: 'owner@example.com' } },
      roleLabels: ROLE_LABEL,
      organizationAccess: { mode: 'active', canWrite: true },
      refreshOrganizationAccess: async () => {},
    };
  },
}));

import WebhookSettings from './WebhookSettings';

const row = (over: Partial<WebhookSubscription> = {}): WebhookSubscription => ({
  id: 'sub-1',
  target: 'webhook:sub-1',
  url: 'https://hooks.example.com/inplace',
  event_types: ['invoice.approved'],
  active: false,
  description: 'ERP',
  verification_state: 'unverified',
  verified_at: null,
  verification_expires_at: null,
  last_success_at: null,
  last_failure_at: null,
  pending_count: 0,
  failed_attempt_count: 0,
  dead_letter_count: 0,
  created_at: '2026-08-23T09:00:00+00:00',
  updated_at: '2026-08-23T09:00:00+00:00',
  ...over,
});

function renderScreen() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <WebhookSettings />
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  readWebhookSubscriptions.mockResolvedValue([]);
  registerWebhookSubscription.mockResolvedValue({ id: 'sub-new', target: 'webhook:sub-new' });
  requestWebhookVerification.mockResolvedValue({
    verification_id: 'ver-1',
    expires_at: '2026-08-23T09:15:00+00:00',
  });
  runWebhookVerification.mockResolvedValue({ verified: true, code: 'webhook_verification_succeeded' });
  setWebhookSubscriptionActive.mockResolvedValue(undefined);
});

describe('WebhookSettings — disclosure', () => {
  it('shows the endpoint, the event allowlist and the delivery health', async () => {
    readWebhookSubscriptions.mockResolvedValue([
      row({
        active: true,
        verification_state: 'verified',
        verified_at: '2026-08-23T09:05:00+00:00',
        last_success_at: '2026-08-23T10:30:00+00:00',
        pending_count: 2,
        failed_attempt_count: 5,
      }),
    ]);
    renderScreen();

    const card = await screen.findByRole('article', { name: /hooks\.example\.com/ });
    expect(within(card).getByText('https://hooks.example.com/inplace')).toBeInTheDocument();
    expect(within(card).getByText(/חשבונית אושרה/)).toBeInTheDocument();
    expect(within(card).getByTestId('webhook-pending')).toHaveTextContent('2');
    expect(within(card).getByTestId('webhook-failed')).toHaveTextContent('5');
    expect(within(card).getByTestId('webhook-last-success')).not.toHaveTextContent('—');
  });

  it('says "—" for a delivery that never happened, never a zero', async () => {
    readWebhookSubscriptions.mockResolvedValue([row()]);
    renderScreen();
    const card = await screen.findByRole('article', { name: /hooks\.example\.com/ });
    expect(within(card).getByTestId('webhook-last-success')).toHaveTextContent('—');
  });

  it('never renders secret material or a raw error, whatever the row carries', async () => {
    readWebhookSubscriptions.mockResolvedValue([
      row({ active: true, verification_state: 'verified', verified_at: '2026-08-23T09:05:00+00:00' }),
    ]);
    const { container } = renderScreen();
    await screen.findByRole('article', { name: /hooks\.example\.com/ });
    const text = container.textContent ?? '';
    for (const forbidden of ['secret_id', 'vault', 'ECONNREFUSED', 'stack', 'raw_error']) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(screen.queryByLabelText(/סוד/)).toBeNull();
  });

  it('reports a load failure without echoing the server string', async () => {
    readWebhookSubscriptions.mockRejectedValue(
      new Error('permission denied for relation private.webhook_verification_attempts'),
    );
    renderScreen();
    const note = await screen.findByRole('alert');
    expect(note.textContent ?? '').not.toContain('private.webhook_verification_attempts');
  });
});

describe('WebhookSettings — activation is gated on the handshake', () => {
  it('offers no activation for an unverified endpoint, and says why', async () => {
    readWebhookSubscriptions.mockResolvedValue([row()]);
    renderScreen();
    const card = await screen.findByRole('article', { name: /hooks\.example\.com/ });
    expect(within(card).queryByRole('button', { name: 'הפעלה' })).toBeNull();
    expect(within(card).getByText(/לפני הפעלה/)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /אימות נקודת הקצה/ })).toBeInTheDocument();
  });

  it('runs the handshake through the request command and the guarded helper, in that order', async () => {
    readWebhookSubscriptions.mockResolvedValue([row()]);
    const user = userEvent.setup();
    renderScreen();
    const card = await screen.findByRole('article', { name: /hooks\.example\.com/ });

    await user.click(within(card).getByRole('button', { name: /אימות נקודת הקצה/ }));
    await user.type(await screen.findByLabelText(/סיבת הפעולה/), 'חיבור ERP');
    await user.click(screen.getByRole('button', { name: /שליחת אימות/ }));

    await vi.waitFor(() => expect(runWebhookVerification).toHaveBeenCalled(), { timeout: 3_000 });
    expect(requestWebhookVerification).toHaveBeenCalledWith('sub-1', 'חיבור ERP');
    expect(runWebhookVerification).toHaveBeenCalledWith('ver-1');
  });

  it('offers activation once the endpoint is verified, and revocation once it is on', async () => {
    readWebhookSubscriptions.mockResolvedValue([
      row({ verification_state: 'verified', verified_at: '2026-08-23T09:05:00+00:00' }),
    ]);
    const { rerender } = renderScreen();
    let card = await screen.findByRole('article', { name: /hooks\.example\.com/ });
    expect(within(card).getByRole('button', { name: 'הפעלה' })).toBeInTheDocument();

    readWebhookSubscriptions.mockResolvedValue([
      row({ active: true, verification_state: 'verified', verified_at: '2026-08-23T09:05:00+00:00' }),
    ]);
    rerender(
      <MemoryRouter>
        <ToastProvider>
          <WebhookSettings key="second" />
        </ToastProvider>
      </MemoryRouter>,
    );
    card = await screen.findByRole('article', { name: /hooks\.example\.com/ });
    expect(within(card).getByRole('button', { name: 'כיבוי' })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'הפעלה' })).toBeNull();
  });

  it('records a non-empty reason even when the owner leaves the box empty', async () => {
    // The app's decided ConfirmDialog behaviour (owner, 11.08.2026) is that an empty box does
    // not interrogate the user — it records a sentence naming the action. The server rule is
    // unchanged and unconditional: `set_webhook_subscription_active` refuses a blank reason with
    // `webhook_subscription_invalid`. So the invariant worth asserting here is that whatever the
    // owner types, the ledger never receives an empty one.
    readWebhookSubscriptions.mockResolvedValue([
      row({ verification_state: 'verified', verified_at: '2026-08-23T09:05:00+00:00' }),
    ]);
    const user = userEvent.setup();
    renderScreen();
    const card = await screen.findByRole('article', { name: /hooks\.example\.com/ });
    await user.click(within(card).getByRole('button', { name: 'הפעלה' }));
    await user.click(await screen.findByRole('button', { name: /הפעלת החיבור/ }));

    await vi.waitFor(() => expect(setWebhookSubscriptionActive).toHaveBeenCalled(), { timeout: 3_000 });
    const [id, active, reason] = setWebhookSubscriptionActive.mock.calls[0] as [string, boolean, string];
    expect(id).toBe('sub-1');
    expect(active).toBe(true);
    expect(reason.trim()).not.toBe('');
  });
});

describe('WebhookSettings — registration', () => {
  it('refuses a private address before it reaches the server', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('button', { name: /חיבור חדש/ }));

    fireEvent.change(screen.getByLabelText(/כתובת נקודת הקצה/), { target: { value: 'https://169.254.169.254/hook' } });
    fireEvent.change(screen.getByLabelText(/סוד חתימה/), { target: { value: 'a'.repeat(40) } });
    fireEvent.change(screen.getByLabelText(/סיבת הפעולה/), { target: { value: 'ניסיון' } });
    await user.click(screen.getByRole('button', { name: /שמירת החיבור/ }));

    expect(await screen.findByText(/יש להזין שם מארח, לא כתובת IP/)).toBeInTheDocument();
    expect(registerWebhookSubscription).not.toHaveBeenCalled();
  });

  it('refuses a signing secret too short to matter', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('button', { name: /חיבור חדש/ }));

    fireEvent.change(screen.getByLabelText(/כתובת נקודת הקצה/), { target: { value: 'https://hooks.example.com/inplace' } });
    fireEvent.change(screen.getByLabelText(/סוד חתימה/), { target: { value: 'short' } });
    fireEvent.change(screen.getByLabelText(/סיבת הפעולה/), { target: { value: 'ניסיון' } });
    await user.click(screen.getByRole('button', { name: /שמירת החיבור/ }));

    expect(await screen.findByText(/סוד החתימה חייב להיות באורך/)).toBeInTheDocument();
    expect(registerWebhookSubscription).not.toHaveBeenCalled();
  });

  it('registers an inactive subscription and never echoes the secret back', async () => {
    const user = userEvent.setup();
    const { container } = renderScreen();
    await user.click(await screen.findByRole('button', { name: /חיבור חדש/ }));

    fireEvent.change(screen.getByLabelText(/כתובת נקודת הקצה/), { target: { value: 'https://hooks.example.com/inplace' } });
    fireEvent.change(screen.getByLabelText(/סוד חתימה/), { target: { value: 'super-secret-signing-value-0123456789' } });
    fireEvent.change(screen.getByLabelText(/סיבת הפעולה/), { target: { value: 'חיבור ERP' } });
    await user.click(screen.getByRole('button', { name: /שמירת החיבור/ }));

    // The registration follows ReauthModal's recent-proof effect before it reaches this mock.
    // Under the full CI worker pool that effect can settle after waitFor's 1s default even though
    // the focused test is instant; wait for the user-visible chain, not scheduler luck.
    await vi.waitFor(() => expect(registerWebhookSubscription).toHaveBeenCalled(), { timeout: 5_000 });
    expect(registerWebhookSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://hooks.example.com/inplace', reason: 'חיבור ERP' }),
    );
    await vi.waitFor(
      () => expect(container.textContent ?? '').not.toContain('super-secret-signing-value-0123456789'),
      { timeout: 3_000 },
    );
  });
});

describe('WebhookSettings — a handshake the server settled as failed (OWN-03)', () => {
  /**
   * The sweep watched the wire answer `{"verified":false,"code":"webhook_verification_status_405"}`
   * and the screen answer "a verification request is open until 02:54". Both halves of that are
   * asserted here, and both are scoped INSIDE the card on purpose: a toast carries the same
   * sentence for a few seconds and then leaves, and a screen that only ever said it in a toast is
   * the defect, not the fix.
   */
  it('shows the failure on the card and stops showing an open verification window', async () => {
    readWebhookSubscriptions
      .mockResolvedValueOnce([row({
        verification_state: 'pending',
        verification_expires_at: '2026-08-23T09:15:00+00:00',
      })])
      // What `read_webhook_subscriptions` returns once the attempt is settled: the lateral join
      // in 0198 only calls a subscription 'pending' while an attempt is BOTH pending and unexpired.
      .mockResolvedValue([row()]);
    runWebhookVerification.mockResolvedValue({
      verified: false,
      code: 'webhook_verification_status_405',
    });

    const user = userEvent.setup();
    renderScreen();
    const opened = await screen.findByRole('article', { name: /hooks\.example\.com/ });
    expect(within(opened).getByText(/בקשת אימות פתוחה/)).toBeInTheDocument();

    await user.click(within(opened).getByRole('button', { name: /אימות נקודת הקצה/ }));
    await user.type(await screen.findByLabelText(/סיבת הפעולה/), 'חיבור ERP');
    await user.click(screen.getByRole('button', { name: /שליחת אימות/ }));

    await vi.waitFor(() => expect(runWebhookVerification).toHaveBeenCalled(), { timeout: 5_000 });

    const settled = await screen.findByRole('article', { name: /hooks\.example\.com/ });
    await vi.waitFor(
      () => expect(within(settled).getByText(/החזירה סטטוס 405/)).toBeInTheDocument(),
      { timeout: 5_000 },
    );
    expect(within(settled).getByText(/לשלוח אימות מחדש/)).toBeInTheDocument();
    expect(within(settled).queryByText(/בקשת אימות פתוחה/)).toBeNull();
  }, 20_000);
});

describe('WebhookSettings — the URL refusal arrives while typing (OWN-15)', () => {
  /**
   * `webhooks.ts` says why `webhookUrlRejection` exists: "so the owner learns that address is not
   * reachable from here WHILE TYPING, instead of after a round trip". The field used to compute
   * that rejection and then throw the code away, keeping only a boolean that recoloured one static
   * sentence — identical text for a valid address and for all seven refused classes.
   */
  it('names which class the typed address falls into, and takes it back when it is fixed', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('button', { name: /חיבור חדש/ }));
    const url = screen.getByLabelText(/כתובת נקודת הקצה/);

    fireEvent.change(url, { target: { value: 'http://hooks.example.com/inplace' } });
    expect(await screen.findByText(/רק כתובת HTTPS מתקבלת/)).toBeInTheDocument();

    fireEvent.change(url, { target: { value: 'https://127.0.0.1/hook' } });
    expect(await screen.findByText(/יש להזין שם מארח, לא כתובת IP/)).toBeInTheDocument();

    fireEvent.change(url, { target: { value: 'https://hooks.example.com:8443/inplace' } });
    expect(await screen.findByText(/רק פורט 443 מתקבל/)).toBeInTheDocument();

    fireEvent.change(url, { target: { value: 'https://hooks.example.com/inplace' } });
    await vi.waitFor(() => expect(screen.queryByText(/רק פורט 443 מתקבל/)).toBeNull());
    expect(screen.getByText(/רק HTTPS על פורט 443/)).toBeInTheDocument();

    expect(registerWebhookSubscription).not.toHaveBeenCalled();
  });
});
