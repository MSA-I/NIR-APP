/**
 * `OWN-13` — two number fields sit side by side on `/settings` and only one of them is bounded.
 *
 * Measured on a live load during the sweep of 04.09.2026: `#settings-vat-rate` reported
 * `{min:'0', max:'100', step:'0.5'}` and `#settings-match-days` reported `{min:'', max:'', step:''}`.
 * The VAT rate is bounded because `0295` gave it a CHECK and `inputBounds.ts` mirrors that CHECK
 * on the screen. The bank-matching window got neither, so the box accepts `-30` and `7.5` and
 * `Number('')` — which `saveOrg` writes to `organizations.settings` as a plain `0`.
 *
 * WHAT THIS FILE ASSERTS, AND WHAT IT DELIBERATELY DOES NOT. It asserts a bound in the DOM and a
 * refusal in the save path. It does NOT assert a maximum, because there is no server bound and no
 * owner decision that could supply one, and a `max` invented on this screen would be a business
 * answer nobody gave — `docs/OPEN-DECISIONS.md` row 3 records the DEFAULT (±7 days) and no ceiling.
 * The floor and the unit are not invented: `addCalendarDays(tx.tx_date, -days)` and `+days` build
 * the window in `Bank.tsx`, so a negative value inverts it into a window no date can fall inside,
 * and `Date.UTC` truncates a fractional day, so half a day is a value the code cannot honour.
 *
 * The finding was reported from the DOM rather than by typing an out-of-range value, because bank
 * matching is shared state on the live stack. Nothing here touches it: this is jsdom against MSW,
 * and the refusal is asserted by the PATCH that never leaves.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { ROLE_LABEL } from '../lib/status';

vi.mock('../lib/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const { SUPABASE_URL: url } = await import('../test/msw/handlers');
  return {
    supabase: createClient(url, 'test-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  };
});

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'me', org_id: 'org-test', role: 'owner', full_name: 'בעלת העסק', active: true, supplier_id: null },
    org: { id: 'org-test', name: 'ארגון בדיקה', vat_rate: 18, settings: { bank_match_days: 7 } },
    session: {},
    roleLabels: ROLE_LABEL,
    organizationAccess: { mode: 'active', canWrite: true },
    refreshOrganizationAccess: async () => {},
  }),
}));

import Settings from './Settings';

const ORGANIZATIONS = `${SUPABASE_URL}/rest/v1/organizations`;

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});

/** Everything the screen reads on mount, answered empty — this file is about two input boxes. */
const patched: unknown[] = [];
beforeEach(() => {
  patched.length = 0;
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/profiles`, () => HttpResponse.json([])),
    http.get(`${SUPABASE_URL}/rest/v1/invitations`, () => HttpResponse.json([])),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/organization_offboarding_state`, () => HttpResponse.json([])),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/resolve_export_report_template`, () =>
      HttpResponse.json({ found: false, export_key: 'accountant_monthly_report' })),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/my_subscription`, () => HttpResponse.json([{
      plan_key: 'free', plan_label: 'חינם', is_paid_plan: false, status: 'active',
      billing_interval: 'monthly', current_period_end: null, cancel_at_period_end: false,
      scheduled_plan_key: null, scheduled_plan_label: null, scheduled_interval: null,
      scheduled_effective_at: null, delinquent: false, billing_country: null,
      billing_country_verified: false, catalogue_currency: null, billing_provider_enabled: false,
    }])),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/my_upgrade_options`, () => HttpResponse.json([])),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/organization_usage_snapshot`, () => HttpResponse.json([])),
    http.patch(ORGANIZATIONS, async ({ request }) => {
      patched.push(await request.json());
      return HttpResponse.json([], { status: 204 });
    }),
  );
});

function renderSettings() {
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

const matchDays = () => document.getElementById('settings-match-days') as HTMLInputElement;
const vatRate = () => document.getElementById('settings-vat-rate') as HTMLInputElement;

/**
 * The business card's own save button. Scoped to the card the two inputs live in, because
 * "שמירה" is also the label of the tolerances panel's button further down the screen.
 */
const saveOrgButton = () => {
  const card = matchDays().closest('.card') as HTMLElement;
  return within(card).getByRole('button', { name: 'שמירה' });
};

describe('/settings — the bank-matching window carries a bound, as the field beside it does', () => {
  it('states a floor and a unit in the DOM', async () => {
    renderSettings();
    await screen.findByLabelText('טווח ימים להתאמת בנק');

    // The control: the field beside it, bounded since 0295. It passes before and after.
    expect(vatRate().getAttribute('min')).toBe('0');
    expect(vatRate().getAttribute('max')).toBe('100');

    // A day window measured in whole days that cannot run backwards.
    expect(matchDays().getAttribute('min')).toBe('0');
    expect(matchDays().getAttribute('step')).toBe('1');
  });

  it('refuses a negative window instead of writing one', async () => {
    renderSettings();
    await screen.findByLabelText('טווח ימים להתאמת בנק');

    await userEvent.clear(matchDays());
    await userEvent.type(matchDays(), '-30');
    await userEvent.click(saveOrgButton());

    // A negative window makes `fromDate > toDate` in Bank.tsx, so no payment date can ever fall
    // inside it and the date signal silently stops firing. Nothing may reach the row.
    expect(patched).toEqual([]);
  });

  it('refuses a fractional day, which the calendar arithmetic cannot honour', async () => {
    renderSettings();
    await screen.findByLabelText('טווח ימים להתאמת בנק');

    await userEvent.clear(matchDays());
    await userEvent.type(matchDays(), '7.5');
    await userEvent.click(saveOrgButton());

    expect(patched).toEqual([]);
  });

  it('refuses an empty box rather than storing the zero `Number("")` produces', async () => {
    renderSettings();
    await screen.findByLabelText('טווח ימים להתאמת בנק');

    await userEvent.clear(matchDays());
    await userEvent.click(saveOrgButton());

    // `Number('')` is 0, and a zero window is a claim — "only a payment dated the same day counts"
    // — not an absence. An empty box has said nothing, so nothing is written.
    expect(patched).toEqual([]);
  });

  it('still saves an ordinary window, which is the point of the screen', async () => {
    renderSettings();
    await screen.findByLabelText('טווח ימים להתאמת בנק');

    await userEvent.clear(matchDays());
    await userEvent.type(matchDays(), '14');
    await userEvent.click(saveOrgButton());

    await vi.waitFor(() => expect(patched).toHaveLength(1));
    expect(patched[0]).toMatchObject({ settings: { bank_match_days: 14 } });
  });
});
