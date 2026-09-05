/**
 * `PERM-01`, client half — what the browser ASKS the two account tables for.
 *
 * The finding is that `/settings`' refusal is cosmetic: every row the screen draws is served to
 * office and accountant by the API. Measured against production on 05.09.2026 with a real read as
 * each role, all three read the same six colleague rows, five phone numbers, the whole
 * `organizations` row and every configuration row. Half of that is the database's answer and half
 * is the question: the account bootstrap and the settings roster both asked with `select('*')`,
 * which is not "the columns this screen renders" but "every column the table will ever have" —
 * `profiles.backup_email`, the address a person nominates to recover their ACCOUNT, included.
 *
 * This file measures the QUESTION, on the wire. A real supabase-js client issues the real requests
 * against MSW and the `select` query parameter is read off each one, so the assertion is what
 * PostgREST would receive rather than what a source line looks like. Two claims per read: the
 * parameter is not `*`, and it is EXACTLY the list `src/lib/accountColumns.ts` declares — an
 * equality, so a later widening fails here instead of quietly restoring the leak.
 *
 * It closes nothing on its own. Until migration 0319 revokes the column privileges a crafted
 * PostgREST request still reaches every one of those columns; a narrower client is what makes that
 * revoke deployable without 403-ing every open tab. The database half is suite p112.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { createAppQueryClient } from '../lib/query/client';
import { ToastProvider } from '../components/ui';
import { INVITATION_COLUMNS } from '../lib/invitations';
import { ORGANIZATION_COLUMNS, PROFILE_COLUMNS } from '../lib/accountColumns';

/** PostgREST drops the spaces a readable literal keeps; compare the column SET, not the spelling. */
const columns = (value: string | null) =>
  (value ?? '').split(',').map((part) => part.trim()).filter(Boolean);

const asked: Record<'profiles' | 'organizations' | 'invitations', string[]> = {
  profiles: [], organizations: [], invitations: [],
};

const ORG_ROW = {
  id: 'org-test', name: 'ארגון בדיקה', vat_rate: 18, base_currency: 'ILS', country_code: 'IL',
  status: 'active', logo_path: null, logo_updated_at: null, onboarding_completed_at: null,
  settings: { bank_match_days: 7, bank_match_amount_tolerance: 1 },
};
const PROFILE_ROW = {
  id: 'me', org_id: 'org-test', full_name: 'בעלת העסק', role: 'owner', phone: '050-0000000',
  active: true, supplier_id: null, locale: null, theme: null,
};

/**
 * A real client for the data calls and a stub for `auth`, so the bootstrap runs its real round
 * trips against MSW while the session is supplied rather than negotiated.
 */
const auth = vi.hoisted(() => ({
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
}));
vi.mock('../lib/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const { SUPABASE_URL: url } = await import('../test/msw/handlers');
  const client = createClient(url, 'test-anon-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return {
    supabase: {
      auth,
      from: client.from.bind(client),
      rpc: client.rpc.bind(client),
      functions: client.functions,
      storage: client.storage,
    },
  };
});
vi.mock('../lib/push', () => ({ cleanupPushBeforeSignOut: vi.fn() }));
vi.mock('../lib/offlineDb', () => ({
  getRememberedOfflineBootstrap: vi.fn(async () => null),
  rememberOfflineBootstrap: vi.fn(async () => undefined),
  offlineAccessProjectionFromServer: vi.fn(() => ({})),
  organizationAccessFromOfflineBootstrap: vi.fn(() => ({ canWrite: false, mode: 'active' })),
}));

import { AuthProvider, useAuth } from '../auth/AuthContext';
import Settings from './Settings';

beforeEach(() => {
  asked.profiles = [];
  asked.organizations = [];
  asked.invitations = [];
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  auth.getSession.mockResolvedValue({
    data: { session: { user: { id: 'me' }, expires_at: Math.floor(Date.now() / 1000) + 3600 } },
  });
  const capture = (table: keyof typeof asked, rows: unknown[]) =>
    http.get(`${SUPABASE_URL}/rest/v1/${table}`, ({ request }) => {
      asked[table].push(new URL(request.url).searchParams.get('select') ?? '');
      return HttpResponse.json(rows);
    });
  server.use(
    capture('profiles', [PROFILE_ROW]),
    capture('organizations', [ORG_ROW]),
    capture('invitations', []),
    http.get(`${SUPABASE_URL}/rest/v1/platform_admins`, () => HttpResponse.json([])),
    http.get(`${SUPABASE_URL}/rest/v1/currencies`, () => HttpResponse.json([])),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/organization_access_state`, () =>
      HttpResponse.json([{ access_mode: 'active' }])),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/organization_offboarding_state`, () => HttpResponse.json([])),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/resolve_export_report_template`, () =>
      HttpResponse.json({ found: false, export_key: 'accountant_monthly_report' })),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/my_subscription`, () => HttpResponse.json([])),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/my_upgrade_options`, () => HttpResponse.json([])),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/organization_usage_snapshot`, () => HttpResponse.json([])),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/currencies_in_use`, () => HttpResponse.json([])),
  );
});

function Probe() {
  const { loading, profile } = useAuth();
  return <div>{loading ? 'SPINNING' : `SETTLED:${profile?.role ?? 'none'}`}</div>;
}

/** The whole shell: the bootstrap runs for real and the screen it feeds is the real screen. */
const renderShell = (children: React.ReactNode) => render(
  <QueryClientProvider client={createAppQueryClient()}>
    <ToastProvider>
      <MemoryRouter><AuthProvider>{children}</AuthProvider></MemoryRouter>
    </ToastProvider>
  </QueryClientProvider>,
);

describe('the account bootstrap asks the two account tables for named columns', () => {
  it('reads profiles by name, and never asks for backup_email', async () => {
    renderShell(<Probe />);
    await waitFor(() => expect(screen.getByText('SETTLED:owner')).toBeTruthy());

    expect(asked.profiles.length).toBeGreaterThan(0);
    for (const select of asked.profiles) {
      expect(select).not.toBe('*');
      expect(columns(select)).toEqual(columns(PROFILE_COLUMNS));
      expect(columns(select)).not.toContain('backup_email');
    }
  });

  it('reads the organisation by name, and never asks for the commercial columns', async () => {
    renderShell(<Probe />);
    await waitFor(() => expect(screen.getByText('SETTLED:owner')).toBeTruthy());

    expect(asked.organizations.length).toBeGreaterThan(0);
    for (const select of asked.organizations) {
      expect(select).not.toBe('*');
      expect(columns(select)).toEqual(columns(ORGANIZATION_COLUMNS));
      expect(columns(select)).not.toContain('trial_ends_at');
      expect(columns(select)).not.toContain('created_at');
    }
  });
});

describe('the settings roster asks for named columns', () => {
  it('reads profiles by name rather than with a star', async () => {
    renderShell(<Settings />);
    await waitFor(() => expect(asked.profiles.length).toBeGreaterThan(1));

    for (const select of asked.profiles) {
      expect(select).not.toBe('*');
      expect(columns(select)).toEqual(columns(PROFILE_COLUMNS));
      expect(columns(select)).not.toContain('backup_email');
    }
  });

  /**
   * The control. `invitations` was already read by name and this change does not touch it, so it
   * must be green in the RED run too. A red here would mean the harness stopped observing
   * requests, not that the boundary moved.
   */
  it('control: the invitations read was already named and is unchanged', async () => {
    renderShell(<Settings />);
    await waitFor(() => expect(asked.invitations.length).toBeGreaterThan(0));

    for (const select of asked.invitations) {
      expect(select).not.toBe('*');
      expect(columns(select)).toEqual(columns(INVITATION_COLUMNS));
    }
  });
});
