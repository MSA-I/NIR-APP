/**
 * Defect 15 — the roster stopped listing accounts that no longer exist as jobs.
 *
 * `/settings` read every profile row into one table, so the three retired personas (`kitchen`,
 * `payer`, `supplier` — `0133`) sat beside the real people and made the roster a false statement
 * about who works here. The screen now partitions one query into three surfaces, and this file
 * pins the partition at the wire level: a real supabase-js client against MSW, the same profile
 * rows PostgREST would return.
 *
 * The third surface is the one worth naming. `!isActiveRole(role) && active` is empty against
 * today's data and is rendered anyway, because it is the only state an owner must resolve by
 * hand — a screen that hid it would hide the defect instead of reporting it.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { ToastProvider } from '../components/ui';
import { ACTIVE_ROLE_LABEL, HISTORICAL_ROLE_LABEL, ROLE_LABEL } from '../lib/status';

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

/** An owner with write access: the only persona that sees the row actions at all. */
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'me', org_id: 'org-test', role: 'owner', full_name: 'בעלת העסק', active: true, supplier_id: null },
    org: { id: 'org-test', name: 'ארגון בדיקה', vat_rate: 18, settings: {} },
    session: {},
    roleLabels: ROLE_LABEL,
    organizationAccess: { mode: 'active', canWrite: true },
    refreshOrganizationAccess: async () => {},
  }),
}));

import Settings from './Settings';

const profile = (over: Partial<Record<string, unknown>>) => ({
  id: 'p', org_id: 'org-test', full_name: '', role: 'office', phone: null, active: true, supplier_id: null, ...over,
});

const OFFICE = profile({ id: 'p-office', full_name: 'רות משרד', role: 'office', active: true });
const PAYER_ARCHIVED = profile({ id: 'p-payer-old', full_name: 'דנה תשלומים', role: 'payer', active: false });
const PAYER_STILL_ACTIVE = profile({ id: 'p-payer-live', full_name: 'עמית תשלומים', role: 'payer', active: true });

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});

function renderSettings(rows: Array<Record<string, unknown>>) {
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/profiles`, () => HttpResponse.json(rows)),
    http.get(`${SUPABASE_URL}/rest/v1/invitations`, () => HttpResponse.json([])),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/organization_offboarding_state`, () => HttpResponse.json([])),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/resolve_export_report_template`, () =>
      HttpResponse.json({ found: false, export_key: 'accountant_monthly_report' })),
  );
  return render(
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-test">
        <ToastProvider>
          <MemoryRouter><Settings /></MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>,
  );
}

const roster = () => screen.getByRole('region', { name: 'טבלת משתמשים והרשאות' });
const archive = () => screen.getByRole('region', { name: 'טבלת ארכיון משתמשים' });

describe('/settings — users, attention strip and archive', () => {
  it('lists only the assignable roles in the roster', async () => {
    renderSettings([OFFICE, PAYER_ARCHIVED, PAYER_STILL_ACTIVE]);

    await screen.findByText('רות משרד');
    const table = roster();
    expect(within(table).getByText('רות משרד')).toBeInTheDocument();
    expect(within(table).getByText(ACTIVE_ROLE_LABEL.office)).toBeInTheDocument();
    // Its actions are intact — which is also what makes the archive's "no buttons" a real claim
    // rather than a query that cannot see inside a table to begin with.
    expect(within(table).getByRole('button', { name: 'שינוי תפקיד' })).toBeInTheDocument();
    expect(within(table).getByRole('button', { name: 'השבתה' })).toBeInTheDocument();
    // Neither historical row belongs to the roster, whatever its active flag says.
    expect(within(table).queryByText('דנה תשלומים')).toBeNull();
    expect(within(table).queryByText('עמית תשלומים')).toBeNull();
  });

  it('archives the deactivated historical account, read-only and folded', async () => {
    renderSettings([OFFICE, PAYER_ARCHIVED, PAYER_STILL_ACTIVE]);
    await screen.findByText('רות משרד');

    const details = screen.getByText('ארכיון משתמשים').closest('details');
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);

    const table = archive();
    expect(within(table).getByText('דנה תשלומים')).toBeInTheDocument();
    // The suffixed label is what makes the row read as history rather than as somebody's job.
    expect(within(table).getByText(HISTORICAL_ROLE_LABEL.payer)).toBeInTheDocument();
    expect(within(table).queryByText('עמית תשלומים')).toBeNull();
    // Read-only: the archive offers no way to reactivate or reassign what already closed.
    expect(within(table).queryAllByRole('button')).toHaveLength(0);

    await userEvent.setup().click(screen.getByText('ארכיון משתמשים'));
    expect(details!.open).toBe(true);
  });

  it('raises the historical-but-active account as work, with both row actions', async () => {
    renderSettings([OFFICE, PAYER_ARCHIVED, PAYER_STILL_ACTIVE]);
    await screen.findByText('רות משרד');

    const strip = screen.getByRole('status').parentElement!;
    expect(within(strip).getByText(/תפקיד היסטורי/)).toBeInTheDocument();
    expect(within(strip).getByText('עמית תשלומים')).toBeInTheDocument();
    expect(within(strip).getByText(HISTORICAL_ROLE_LABEL.payer)).toBeInTheDocument();
    expect(within(strip).queryByText('דנה תשלומים')).toBeNull();
    expect(within(strip).getByRole('button', { name: 'שינוי תפקיד' })).toBeInTheDocument();
    expect(within(strip).getByRole('button', { name: 'השבתה' })).toBeInTheDocument();
  });

  it('opens the reassignment dialog on an active role, which is the way out of the strip', async () => {
    renderSettings([OFFICE, PAYER_ARCHIVED, PAYER_STILL_ACTIVE]);
    await screen.findByText('רות משרד');

    const strip = screen.getByRole('status').parentElement!;
    await userEvent.setup().click(within(strip).getByRole('button', { name: 'שינוי תפקיד' }));

    await screen.findByText('שינוי תפקיד — עמית תשלומים');
    // Preselected on an assignable role: the retired one is not an option the server would take.
    expect((screen.getByLabelText('תפקיד חדש') as HTMLSelectElement).value).toBe('office');
    expect(screen.queryByRole('option', { name: HISTORICAL_ROLE_LABEL.payer })).toBeNull();
  });

  it('shows neither extra surface when every profile holds an assignable role', async () => {
    renderSettings([OFFICE]);
    await screen.findByText('רות משרד');

    expect(screen.queryByText('ארכיון משתמשים')).toBeNull();
    expect(screen.queryByText(/תפקיד היסטורי/)).toBeNull();
  });
});
