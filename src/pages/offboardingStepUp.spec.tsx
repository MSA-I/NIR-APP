/**
 * `OWN-01` / `RTL-A11Y-01` — the org-wide switch to read-only that fired from one click.
 *
 * The owner's offboarding ruling — `OPEN-DECISIONS.md` → "הכרעת בעלים ל־Offboarding וייצוא דייר",
 * a prose section rather than a numbered table row, so it is cited here by title — requires the
 * closure request and its cancellation to happen "לאחר אימות מחדש".
 * `Settings.tsx` handed `ReauthModal` no `skipWhenFresh`, and the component defaults it to `true`:
 * a JWT carrying a `password` AMR entry younger than `FRESH_PASSWORD_WINDOW_SECONDS` made the
 * dialog return `null` and fire `onConfirm` from an effect before paint. The re-authentication the
 * ruling demands was therefore skipped **exactly** when someone had just signed in and walked to
 * settings — one click, no dialog, the whole organisation read-only for thirty days.
 *
 * This file is the oracle, not a code re-read: it mounts the real screen with a real supabase-js
 * client over MSW, clicks the real button, and watches the wire. `request_organization_offboarding`
 * either reached PostgREST or it did not.
 *
 * The `download` branch is here for the opposite reason. One `ReauthModal` serves all three
 * actions, so the fix is a conditional prop rather than a constant — and an export fetch is not the
 * read-only switch. Its skip is pinned so a later "tighten everything" edit cannot quietly take it
 * away, and so the fix cannot be mistaken for `skipWhenFresh={false}` everywhere.
 *
 * The last case is ruling #355: an owner who signed in through Google has no password identity at
 * all, so `assert_recent_password_authentication()` can never be satisfied and a password box is a
 * dead end. In place of it the dialog says so, and names where a password is set.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

/** Real supabase-js against the MSW base URL — the RPC either goes out on the wire or it does not. */
vi.mock('../lib/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const { SUPABASE_URL: url } = await import('../test/msw/handlers');
  return {
    supabase: createClient(url, 'test-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  };
});

const authState = vi.hoisted(() => ({ session: null as unknown }));

/** An owner with write access — the only persona the closure panel renders for. */
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'me', org_id: 'org-test', role: 'owner', full_name: 'בעלת העסק', active: true, supplier_id: null },
    org: { id: 'org-test', name: 'ארגון בדיקה', vat_rate: 18, settings: {} },
    session: authState.session,
    roleLabels: ROLE_LABEL,
    organizationAccess: { mode: 'active', canWrite: true },
    refreshOrganizationAccess: async () => {},
  }),
}));

import Settings from './Settings';

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const nowSec = () => Math.floor(Date.now() / 1000);
/** The same shape `ReauthModal.spec.tsx` builds: a signed-looking JWT whose `amr` is what matters. */
const passwordToken = (ageSeconds: number) =>
  `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ amr: [{ method: 'password', timestamp: nowSec() - ageSeconds }] })}.sig`;

const EMAIL_IDENTITY = [{ provider: 'email' }];
const GOOGLE_IDENTITY = [{ provider: 'google' }];

const sessionWith = (token: string, identities: Array<{ provider: string }> = EMAIL_IDENTITY) =>
  ({ access_token: token, user: { id: 'me', email: 'owner@gamos.demo', identities } });

/** The open request an owner can still cancel — 30 days is the window `0103:89` writes into the row. */
const OPEN_REQUEST = {
  id: 'req-1',
  status: 'requested',
  requested_at: '2026-09-01T08:00:00Z',
  approved_at: null,
  cancellation_deadline: '2026-10-01T08:00:00Z',
  platform_reactivation_deadline: '2026-11-01T08:00:00Z',
  operational_purge_eligible_at: '2026-10-01T08:00:00Z',
  security_logs_retain_until: '2027-09-01T08:00:00Z',
  financial_records_retain_until: '2033-09-01T08:00:00Z',
  export_completed_at: null,
  export_size_bytes: null,
  export_file_count: null,
  export_parts_total: 0,
  export_parts_completed: 0,
  last_export_error: null,
  can_owner_cancel: true,
};

const READY_EXPORT = { ...OPEN_REQUEST, status: 'export_ready', export_completed_at: '2026-09-02T08:00:00Z' };

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});

/** Every offboarding-side call the screen can make, counted by name. Nothing else may fire. */
const sensitive = {
  request: 0,
  cancel: 0,
  export: 0,
  signIn: 0,
};

beforeEach(() => {
  sensitive.request = 0;
  sensitive.cancel = 0;
  sensitive.export = 0;
  sensitive.signIn = 0;
  authState.session = sessionWith(passwordToken(10));
  window.sessionStorage.clear();
});

function renderSettings(offboardingRows: Array<Record<string, unknown>>) {
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/profiles`, () => HttpResponse.json([])),
    http.get(`${SUPABASE_URL}/rest/v1/invitations`, () => HttpResponse.json([])),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/organization_offboarding_state`, () =>
      HttpResponse.json(offboardingRows)),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/resolve_export_report_template`, () =>
      HttpResponse.json({ found: false, export_key: 'accountant_monthly_report' })),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/my_subscription`, () => HttpResponse.json([{
      plan_key: 'free', plan_label: 'חינם', is_paid_plan: false, status: 'active',
      billing_interval: 'monthly', current_period_end: null, cancel_at_period_end: false,
      scheduled_plan_key: null, scheduled_plan_label: null, scheduled_interval: null,
      scheduled_effective_at: null, delinquent: false, billing_country: null,
      billing_country_verified: false, catalogue_currency: null, billing_provider_enabled: false,
    }])),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/my_upgrade_options`, () => HttpResponse.json([
      { plan_key: 'free', label: 'חינם', tier_order: 1, paid: false, contact_sales: false, currency: null, catalogue_version: null, monthly_amount: null, yearly_amount: null },
    ])),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/organization_usage_snapshot`, () => HttpResponse.json([])),
    // CurrencyTolerancesPanel's own two reads. Declared so the run carries no unhandled-request noise.
    http.post(`${SUPABASE_URL}/rest/v1/rpc/currencies_in_use`, () => HttpResponse.json([])),
    http.get(`${SUPABASE_URL}/rest/v1/currencies`, () => HttpResponse.json([])),

    // The three calls this oracle is about. Each one records that it happened.
    http.post(`${SUPABASE_URL}/rest/v1/rpc/request_organization_offboarding`, () => {
      sensitive.request += 1;
      return HttpResponse.json(null);
    }),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/cancel_organization_offboarding`, () => {
      sensitive.cancel += 1;
      return HttpResponse.json(null);
    }),
    http.post(`${SUPABASE_URL}/functions/v1/tenant-export`, () => {
      sensitive.export += 1;
      return HttpResponse.json({ signed_url: 'https://example.test/export.zip', expires_at: '2026-09-09T08:00:00Z' });
    }),
    // The password the dialog actually verifies. Counted so "the gate was satisfied" is a
    // measurement rather than an inference from the RPC that followed it.
    http.post(`${SUPABASE_URL}/auth/v1/token`, () => {
      sensitive.signIn += 1;
      return HttpResponse.json({
        access_token: passwordToken(0),
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: nowSec() + 3600,
        refresh_token: 'refresh-1',
        user: { id: 'me', email: 'owner@gamos.demo', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' },
      });
    }),
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

const click = async (name: string) => {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name }));
};

/**
 * Wait until the click has resolved one way or the other — a dialog painted, or a call gone out —
 * and only then judge which. A fixed sleep before a negative assertion measures the machine; this
 * measures the screen, and it is what makes "the RPC fired from one click" the sentence the RED
 * output actually prints.
 */
async function settle() {
  await waitFor(() => {
    const calls = sensitive.request + sensitive.cancel + sensitive.export;
    if (calls === 0 && screen.queryByRole('dialog') === null) {
      throw new Error('neither a dialog nor a server call yet');
    }
  });
}

describe('/settings — the closure step-up survives a fresh sign-in (OWN-01)', () => {
  it('asks for the password before requesting closure, even seconds after signing in', async () => {
    renderSettings([]);

    await click('בקשת סיום שירות');
    await settle();

    // The whole finding, in one number: one click, and the organisation is read-only for 30 days.
    expect(sensitive.request).toBe(0);
    const dialog = await screen.findByRole('dialog', { name: 'אימות זהות לפני בקשת סיום שירות' });
    // And the dialog must say what is about to change — not only that a password is wanted.
    expect(dialog).toHaveTextContent('קריאה בלבד');
    expect(dialog).toHaveTextContent('30');
  });

  it('sends the request only once the password has actually been verified', async () => {
    const user = userEvent.setup();
    renderSettings([]);

    await click('בקשת סיום שירות');
    await screen.findByRole('dialog', { name: 'אימות זהות לפני בקשת סיום שירות' });

    await user.type(screen.getByLabelText('סיסמה לאימות זהות טרי *'), 'correct-horse');
    await user.click(screen.getByRole('button', { name: /אישור זהות/ }));

    await waitFor(() => expect(sensitive.request).toBe(1));
    // The password was verified against GoTrue — the gate was satisfied, not bypassed.
    expect(sensitive.signIn).toBe(1);
  });

  it('asks again before cancelling an open request', async () => {
    renderSettings([OPEN_REQUEST]);

    await click('ביטול בקשת הסיום');
    await settle();

    expect(sensitive.cancel).toBe(0);
    const dialog = await screen.findByRole('dialog', { name: 'אימות זהות לפני ביטול בקשת הסיום' });
    expect(dialog).toHaveTextContent('קריאה בלבד');
  });

  it('still skips the prompt for the export link — a download is not the read-only switch', async () => {
    renderSettings([READY_EXPORT]);

    await click('יצירת קישור הורדה');

    // Fresh JWT, so the export fetch goes straight out: this branch keeps `skipWhenFresh`.
    await waitFor(() => expect(sensitive.export).toBe(1));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sensitive.request).toBe(0);
    expect(sensitive.cancel).toBe(0);
  });

  it('prompts a stale session too — the fix must not depend on the JWT being fresh', async () => {
    authState.session = sessionWith(passwordToken(60 * 60));
    renderSettings([]);

    await click('בקשת סיום שירות');

    expect(await screen.findByRole('dialog', { name: 'אימות זהות לפני בקשת סיום שירות' })).toBeInTheDocument();
    expect(sensitive.request).toBe(0);
  });
});

describe('/settings — an owner with no password identity is told so (#355)', () => {
  it('replaces the password box with the sentence that names where a password is set', async () => {
    authState.session = sessionWith(passwordToken(10), GOOGLE_IDENTITY);
    renderSettings([]);

    await click('בקשת סיום שירות');
    await settle();

    expect(sensitive.request).toBe(0);
    const dialog = await screen.findByRole('dialog', { name: 'אימות זהות לפני בקשת סיום שירות' });
    // No box they cannot fill…
    expect(screen.queryByLabelText('סיסמה לאימות זהות טרי *')).toBeNull();
    // …and a sentence that says why, and names where a password is set.
    expect(dialog).toHaveTextContent('החלפת הסיסמה שלך');
    expect(sensitive.signIn).toBe(0);
  });

  it('keeps the password box when the identity list is absent — unknown is not "no password"', async () => {
    authState.session = { access_token: passwordToken(60 * 60), user: { id: 'me', email: 'owner@gamos.demo' } };
    renderSettings([]);

    await click('בקשת סיום שירות');

    await screen.findByRole('dialog', { name: 'אימות זהות לפני בקשת סיום שירות' });
    expect(screen.getByLabelText('סיסמה לאימות זהות טרי *')).toBeInTheDocument();
  });
});
