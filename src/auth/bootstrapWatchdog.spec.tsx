import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { AuthProvider, BOOTSTRAP_TIMEOUT_MS, BOOTSTRAP_TIMEOUT_KEY, useAuth } from './AuthContext';
import { he } from '../lib/i18n/dictionaries/he';
import { en } from '../lib/i18n/dictionaries/en';

/**
 * The bug this pins: a bootstrap that never settles.
 *
 * supabase-js resolves the auth token before it issues any request, so a wedged token refresh
 * makes every call in the bootstrap hang *without rejecting*. The `finally` that clears
 * `loading` is never reached, and `Guard` (App.tsx) renders PageLoader on every route forever.
 * A stale session held open across the 10.08.2026 deploy did exactly this in production.
 *
 * So the mock below never resolves — that is the whole point. A test whose queries reject would
 * pass against the broken code, because rejection already reached the `catch`.
 */
const auth = vi.hoisted(() => ({
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
}));
const fromFn = vi.hoisted(() => vi.fn());
const rpcFn = vi.hoisted(() => vi.fn());
vi.mock('../lib/supabase', () => ({ supabase: { auth, from: fromFn, rpc: rpcFn } }));
vi.mock('../lib/push', () => ({ cleanupPushBeforeSignOut: vi.fn() }));
vi.mock('../lib/offlineDb', () => ({
  getRememberedOfflineBootstrap: vi.fn(async () => null),
  rememberOfflineBootstrap: vi.fn(async () => undefined),
  offlineAccessProjectionFromServer: vi.fn(() => ({})),
  organizationAccessFromOfflineBootstrap: vi.fn(() => ({ canWrite: false, mode: 'active' })),
}));

const SESSION = { user: { id: 'u1' }, expires_at: Math.floor(Date.now() / 1000) + 3600 };

function Probe() {
  const { loading, bootstrapError } = useAuth();
  return <div>{loading ? 'SPINNING' : `SETTLED:${bootstrapError ?? 'none'}`}</div>;
}

describe('auth bootstrap watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    auth.getSession.mockResolvedValue({ data: { session: SESSION } });
    // Never resolves, never rejects.
    const hang = () => new Promise(() => {});
    fromFn.mockReturnValue({
      select: () => ({ eq: () => ({ maybeSingle: hang }) }),
    });
    rpcFn.mockImplementation(hang);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  /**
   * Flush getSession's promise so the bootstrap effect has actually registered its watchdog.
   * Advancing the clock first would schedule that timer *after* the window being advanced, and
   * the test would report a hang that never happened.
   */
  async function mountAndSettleSession() {
    render(<AuthProvider><Probe /></AuthProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  }

  it('leaves loading true while the bootstrap is merely slow', async () => {
    await mountAndSettleSession();
    await act(async () => { await vi.advanceTimersByTimeAsync(BOOTSTRAP_TIMEOUT_MS - 1000); });
    expect(screen.getByText('SPINNING')).toBeTruthy();
  });

  it('settles into a reportable failure instead of spinning forever', async () => {
    await mountAndSettleSession();
    await act(async () => { await vi.advanceTimersByTimeAsync(BOOTSTRAP_TIMEOUT_MS + 1000); });
    // `loading` false plus a bootstrapError with no profile is the exact condition
    // App.tsx renders <BootstrapUnavailable /> on, which carries retry and sign-out.
    // The watchdog now settles on a KEY, so the state assertion pins the key and the two
    // dictionaries pin the sentence. `App.tsx` is what turns it into words, with `tDynamic`, so a
    // raw server message coming through the same field still reaches support unchanged.
    expect(screen.getByText(`SETTLED:${BOOTSTRAP_TIMEOUT_KEY}`)).toBeTruthy();
    expect(he.app.bootstrapTimeout).toBe('טעינת פרטי החשבון נמשכה זמן רב מדי.');
    expect(en.app.bootstrapTimeout).toBe('Loading the account details took too long.');
  });
});
