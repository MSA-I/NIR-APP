/**
 * ENTRY-10 / PERM-04 — the entrance has no 404, and a refused route is indistinguishable from
 * a typo.
 *
 * Measured on the live site 2026-09-04: every unknown path answers HTTP 200 and lands the
 * visitor somewhere else. Logged out it is `/login`; logged in it is `/dashboard`. Nothing on
 * either screen says the address did not exist, so a mistyped link and a real screen are the
 * same experience, and a bookmark that has rotted looks like a successful sign-in.
 *
 * `App.tsx:392` is the cause of half of it: `<Route path="*" element={<Navigate to="/" />}>` sits
 * INSIDE the Layout group, whose parent redirects a session-less visitor to `/login`. The other
 * half is `App.tsx:117` — the Guard answers a role refusal with `<Navigate to={homeFor(role)}>`,
 * which is the same silent bounce for a completely different reason.
 *
 * Those two states must read differently, and the oracle asserts exactly that: the path does not
 * change, an alert is present, and the two alerts do not say the same thing. It is written
 * against behaviour rather than against copy, so it was evaluable before the keys existed.
 *
 * The 404 stays CLIENT-SIDE. `public/_redirects` keeps its `/* /index.html 200` catch-all --
 * decided, and recorded in PROGRESS.md and DEBT-REGISTER.md -- and a soft 404 costs nothing on a
 * host that is `noindex` anyway.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from './components/ui';
import { LocaleProvider } from './lib/i18n/LocaleProvider';

const authState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('./auth/AuthContext', () => ({
  useAuth: () => authState.current,
  homeFor: () => '/dashboard',
  ACTIVE_ORGANIZATION_ACCESS: { mode: 'active', canWrite: true },
  isActiveRole: (role: unknown) => role === 'owner' || role === 'office' || role === 'accountant',
}));
vi.mock('./lib/observability', () => ({ reportError: vi.fn() }));
// The Layout is the app shell -- nav, the requires-attention strip, live queries. None of that is
// under test here, and mounting it would drag half the product into a routing assertion.
vi.mock('./components/Layout', () => ({
  default: () => <Outlet />,
}));

import App from './App';

function signedIn(role: string | null) {
  return {
    session: { user: { id: 'user-1' } },
    profile: role ? { id: 'user-1', role, full_name: 'Test' } : null,
    loading: false,
    bootstrapError: null,
    offlineBootstrap: false,
    isPlatformAdmin: false,
    organizationAccess: { mode: 'active', canWrite: true },
    signOut: vi.fn(async () => ({ error: null, pushWarning: null })),
    retryBootstrap: vi.fn(),
  };
}

function signedOut() {
  return { ...signedIn(null), session: null, profile: null };
}

/** Reports the path the router settled on, so "did not bounce" is an assertion, not a hope. */
function Probe() {
  const { pathname } = useLocation();
  return <div data-testid="pathname">{pathname}</div>;
}

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <LocaleProvider initialLocale="en">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <App />
            <Probe />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </LocaleProvider>,
  );
}

describe('an address that does not exist', () => {
  beforeEach(() => { authState.current = signedOut(); });

  it('says so to a signed-out visitor instead of bouncing to the sign-in screen', async () => {
    renderAt('/no-such-screen');

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByTestId('pathname')).toHaveTextContent('/no-such-screen');
  });

  it('says so to a signed-in user instead of bouncing to the dashboard', async () => {
    authState.current = signedIn('owner');
    renderAt('/no-such-screen');

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByTestId('pathname')).toHaveTextContent('/no-such-screen');
  });
});

describe('an address that exists but is not permitted', () => {
  it('reads differently from a wrong address, and does not bounce', async () => {
    // `/settings` exists and is owner-only. An accountant is refused, and today that refusal is
    // the same silent bounce a typo gets.
    authState.current = signedIn('accountant');
    const refused = renderAt('/settings');
    const refusal = (await screen.findByRole('alert')).textContent ?? '';
    expect(screen.getByTestId('pathname')).toHaveTextContent('/settings');
    refused.unmount();

    authState.current = signedIn('accountant');
    renderAt('/no-such-screen');
    const missing = (await screen.findByRole('alert')).textContent ?? '';

    expect(refusal).not.toBe('');
    expect(missing).not.toBe('');
    expect(refusal).not.toBe(missing);
  });
});
