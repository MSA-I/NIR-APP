/**
 * `PERM-01`, client half — what the browser ASKS the two account tables for, and where a
 * colleague's telephone number comes from once it may no longer come from `profiles`.
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
 * PostgREST would receive rather than what a source line looks like. Three claims per read: the
 * parameter is not `*`, it is EXACTLY the list `src/lib/accountColumns.ts` declares, and it does
 * not name the columns migration 0319 revokes — the last one stated separately because an equality
 * against a constant passes happily if the constant itself is widened.
 *
 * The last describe is the one that could not be written before 0319 exists. A colleague's number
 * is no longer selectable from `profiles` by anyone, so the owner's roster reads it from
 * `organization_people_directory` — a view that runs with its owner's privileges and refuses office
 * and accountant by predicate. That read is an ENRICHMENT and not the roster: between the moment
 * the bundle ships and the moment the migration is applied the view does not exist, and a roster
 * that depended on it would be empty rather than one column short. When it is unavailable the
 * column is ABSENT — not a dash, which would claim nobody has a number on file.
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
import { translateIn } from '../lib/i18n/LocaleProvider';

/** PostgREST drops the spaces a readable literal keeps; compare the column SET, not the spelling. */
const columns = (value: string | null) =>
  (value ?? '').split(',').map((part) => part.trim()).filter(Boolean);

/** The roster's phone header, taken from the dictionary rather than retyped. */
const PHONE_HEADER = translateIn('he', 'settings.text_16');

type Table = 'profiles' | 'organizations' | 'invitations' | 'organization_people_directory';
const asked: Record<Table, string[]> = {
  profiles: [], organizations: [], invitations: [], organization_people_directory: [],
};

/** Flipped per test: `false` is the window between the bundle shipping and 0319 being applied. */
const directory = { available: true };

const ORG_ROW = {
  id: 'org-test', name: 'ארגון בדיקה', vat_rate: 18, base_currency: 'ILS', country_code: 'IL',
  status: 'active', logo_path: null, logo_updated_at: null, onboarding_completed_at: null,
  settings: { bank_match_days: 7, bank_match_amount_tolerance: 1 },
};
const OWNER_ROW = {
  id: 'me', org_id: 'org-test', full_name: 'בעלת העסק', role: 'owner',
  active: true, supplier_id: null, locale: null, theme: null,
};
const COLLEAGUE_ROW = { ...OWNER_ROW, id: 'colleague', full_name: 'פקידת המשרד', role: 'office' };
/** The number lives only here — the roster rows above no longer carry one, and cannot. */
const COLLEAGUE_PHONE = '050-7654321';

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
  asked.organization_people_directory = [];
  directory.available = true;
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  auth.getSession.mockResolvedValue({
    data: { session: { user: { id: 'me' }, expires_at: Math.floor(Date.now() / 1000) + 3600 } },
  });
  // `id=eq.<uuid>` is honoured, because the bootstrap reads its own row with `.maybeSingle()` and
  // a handler that answered two rows would fail the bootstrap for a reason this file is not about.
  const capture = (table: Table, rows: Array<{ id: string }>) =>
    http.get(`${SUPABASE_URL}/rest/v1/${table}`, ({ request }) => {
      const url = new URL(request.url);
      asked[table].push(url.searchParams.get('select') ?? '');
      const filter = url.searchParams.get('id');
      const matching = filter?.startsWith('eq.')
        ? rows.filter((row) => row.id === filter.slice(3))
        : rows;
      return HttpResponse.json(matching);
    });
  server.use(
    capture('profiles', [OWNER_ROW, COLLEAGUE_ROW]),
    capture('organizations', [ORG_ROW]),
    capture('invitations', []),
    // Exactly what PostgREST answers on a tree where 0319 has not been applied yet: the relation
    // does not exist. The roster must survive it.
    http.get(`${SUPABASE_URL}/rest/v1/organization_people_directory`, ({ request }) => {
      asked.organization_people_directory.push(new URL(request.url).searchParams.get('select') ?? '');
      if (!directory.available) {
        return HttpResponse.json({
          message: 'relation "public.organization_people_directory" does not exist',
          code: '42P01', details: null, hint: null,
        }, { status: 404 });
      }
      return HttpResponse.json([{ id: 'me', phone: null }, { id: 'colleague', phone: COLLEAGUE_PHONE }]);
    }),
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
  it('reads profiles by name, and never asks for a column 0319 revokes', async () => {
    renderShell(<Probe />);
    await waitFor(() => expect(screen.getByText('SETTLED:owner')).toBeTruthy());

    expect(asked.profiles.length).toBeGreaterThan(0);
    for (const select of asked.profiles) {
      expect(select).not.toBe('*');
      expect(columns(select)).toEqual(columns(PROFILE_COLUMNS));
      expect(columns(select)).not.toContain('backup_email');
      expect(columns(select)).not.toContain('phone');
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
      expect(columns(select)).not.toContain('phone');
    }
  });

  /**
   * The control. `invitations` was already read by name and neither commit touches it, so it must
   * be green in both RED runs. A red here would mean the harness stopped observing requests, not
   * that the boundary moved.
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

describe("a colleague's number comes from the owner directory, or from nowhere", () => {
  // `getAllByText`, not `getByText`: DataTable renders a desktop table AND a mobile card list, so
  // every cell value legitimately appears twice.
  it('asks the directory for the two columns it needs and draws the number it returns', async () => {
    renderShell(<Settings />);
    await waitFor(() => expect(screen.getAllByText(COLLEAGUE_PHONE).length).toBeGreaterThan(0));

    expect(asked.organization_people_directory.length).toBeGreaterThan(0);
    for (const select of asked.organization_people_directory) {
      expect(select).not.toBe('*');
      expect(columns(select)).toEqual(['id', 'phone']);
    }
    expect(screen.queryByRole('columnheader', { name: PHONE_HEADER })).toBeTruthy();
  });

  /**
   * The deploy window, and the reason the directory is an enrichment rather than the roster: the
   * bundle ships before the migration is applied, and for those minutes the view does not exist.
   * The roster must still list the tenant, and the column must be ABSENT rather than a dash for
   * everybody — a dash is a claim that nobody has a number on file.
   */
  it('drops the column, not the roster, when the directory is not there yet', async () => {
    directory.available = false;
    renderShell(<Settings />);
    await waitFor(() => expect(screen.getAllByText('פקידת המשרד').length).toBeGreaterThan(0));
    await waitFor(() => expect(asked.organization_people_directory.length).toBeGreaterThan(0));

    expect(screen.queryByRole('columnheader', { name: PHONE_HEADER })).toBeNull();
    expect(screen.queryAllByText(COLLEAGUE_PHONE)).toHaveLength(0);
    // The roster itself is intact: both people are listed.
    expect(screen.getAllByText('בעלת העסק').length).toBeGreaterThan(0);
  });
});
