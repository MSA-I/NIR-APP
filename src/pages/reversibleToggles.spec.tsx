/**
 * "Act, then offer Undo" — the two toggles that used to be guarded by a confirmation dialog.
 *
 * A confirmation dialog is a tax paid by the ninety-nine correct presses to catch the one wrong
 * one, and it is only worth paying when the action cannot be taken back. Both of these can:
 * `set_product_active` and `manage_profile_access` are the same call with `p_active` flipped. So
 * the dialog is gone and the toast carries the way back.
 *
 * The two screens are NOT symmetric, and that asymmetry is what most of this file is about.
 * `/products` had nothing in front of the RPC but the question. `/settings` had the question AND
 * a password step-up, and only the question was removed: the step-up is the gate that proves who
 * is at the keyboard, and its five-minute freshness window can expire while the Undo toast is
 * still on screen — which is the one case where "offer Undo" has to hand the user back to a
 * dialog instead of a dead red message.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { ToastProvider } from '../components/ui';
import { ROLE_LABEL } from '../lib/status';
import type { Product } from '../lib/types';

vi.mock('../lib/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const { SUPABASE_URL: url } = await import('../test/msw/handlers');
  return {
    supabase: createClient(url, 'test-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  };
});

/**
 * `freshPassword` drives the client half of the step-up. `ReauthModal` skips its prompt only when
 * the access token carries a `password` amr entry under four minutes old, so a token is minted
 * rather than faked: the test flips a real JWT payload, not a boolean the component never reads.
 */
const authState = vi.hoisted(() => ({ freshPassword: true }));

function tokenWithPasswordAt(secondsAgo: number): string {
  const payload = { amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) - secondsAgo }] };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `header.${body}.signature`;
}

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'me', org_id: 'org-test', role: 'owner', full_name: 'בעלת העסק', active: true, supplier_id: null },
    org: { id: 'org-test', name: 'ארגון בדיקה', vat_rate: 18, settings: {} },
    // 30s ago = the prompt is skipped; 10 minutes ago = past even the server's 5-minute window.
    session: { access_token: tokenWithPasswordAt(authState.freshPassword ? 30 : 600), user: { id: 'me', email: 'owner@test.local' } },
    roleLabels: ROLE_LABEL,
    organizationAccess: { mode: 'active', canWrite: true },
    refreshOrganizationAccess: async () => {},
  }),
}));

import Products from './Products';
import Settings from './Settings';

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});

beforeEach(() => { authState.freshPassword = true; });

/** Opens a DataTable row's action menu; the menu portals to <body>, so items are found globally. */
async function openRowMenu(user: ReturnType<typeof userEvent.setup>, label: RegExp) {
  await user.click((await screen.findAllByRole('button', { name: label }))[0]);
}

/* ------------------------------------------------------------------ /products */

describe('/products — השבתת מוצר פועלת מיד ומציעה ביטול', () => {
  const PRODUCT: Product = {
    id: 'p-1', org_id: 'org-test', name: 'עגבניות שרי', display_name: 'עגבניות שרי', unit: 'ק״ג',
    category_id: null, sku: null, barcode: null, notes: null, active: true, min_stock: null,
  };

  const RPC = `${SUPABASE_URL}/rest/v1/rpc/set_product_active`;

  /** Records every write to the one door, so "which value was sent" is an assertion. */
  function wire(products: Product[], failures: string[] = []) {
    const calls: Record<string, unknown>[] = [];
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/products`, () => HttpResponse.json(products)),
      http.get(`${SUPABASE_URL}/rest/v1/supplier_products`, () => HttpResponse.json([])),
      http.get(`${SUPABASE_URL}/rest/v1/categories`, () => HttpResponse.json([])),
      http.post(`${SUPABASE_URL}/rest/v1/rpc/get_product_name_repair_queue`,
        () => HttpResponse.json({ has_dry_run: false, dry_run_count: 0, latest_dry_run_at: null, candidates: [] })),
      http.post(RPC, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        calls.push(body);
        const failure = failures[calls.length - 1];
        return failure
          ? HttpResponse.json({ message: failure }, { status: 400 })
          : HttpResponse.json({ product_id: body.p_product_id, active: body.p_active });
      }),
    );
    return calls;
  }

  function renderProducts() {
    render(
      <QueryClientProvider client={createAppQueryClient()}>
        <OrgScopeProvider org="org-test">
          <ToastProvider>
            <MemoryRouter initialEntries={['/products']}><Products /></MemoryRouter>
          </ToastProvider>
        </OrgScopeProvider>
      </QueryClientProvider>,
    );
  }

  it('פועל בלי דיאלוג אישור, ורושם ביומן סיבה שמכנה את הכיוון', async () => {
    const user = userEvent.setup();
    const calls = wire([PRODUCT]);
    renderProducts();

    await openRowMenu(user, /פעולות עבור מוצר עגבניות שרי/);
    await user.click(await screen.findByRole('menuitem', { name: 'השבתה' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].p_product_id).toBe('p-1');
    expect(calls[0].p_active).toBe(false);
    // The reason is no longer typed, so the ledger must still say which direction was taken.
    expect(calls[0].p_reason).toContain('השבתת מוצר');
    // Nothing asked first — the whole point.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('הביטול שולח את הערך ההפוך, עם משפט ביקורת משלו', async () => {
    const user = userEvent.setup();
    const calls = wire([PRODUCT]);
    renderProducts();

    await openRowMenu(user, /פעולות עבור מוצר עגבניות שרי/);
    await user.click(await screen.findByRole('menuitem', { name: 'השבתה' }));

    const toast = await screen.findByRole('status');
    expect(toast).toHaveTextContent('המוצר הושבת');
    await user.click(screen.getByRole('button', { name: 'ביטול הפעולה' }));

    await waitFor(() => expect(calls).toHaveLength(2));
    // Same RPC, flipped flag. `set_product_active` is idempotent on the value it already holds,
    // so a second press could only be a no-op — never a second toggle.
    expect(calls[1].p_active).toBe(true);
    expect(calls[1].p_reason).toContain('ביטול השבתת מוצר');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('ההשבתה בוטלה'));
  });

  it('ביטול שנכשל אומר זאת — לא נכשל בשקט', async () => {
    const user = userEvent.setup();
    const calls = wire([PRODUCT], ['', 'product_active_not_authorized']);
    renderProducts();

    await openRowMenu(user, /פעולות עבור מוצר עגבניות שרי/);
    await user.click(await screen.findByRole('menuitem', { name: 'השבתה' }));
    await screen.findByRole('button', { name: 'ביטול הפעולה' });
    await user.click(screen.getByRole('button', { name: 'ביטול הפעולה' }));

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ /settings */

describe('/settings — השבתת משתמש: השאלה ירדה, אימות הסיסמה נשאר', () => {
  const RPC = `${SUPABASE_URL}/rest/v1/rpc/manage_profile_access`;

  const OFFICE = {
    id: 'p-office', org_id: 'org-test', full_name: 'רות משרד', role: 'office',
    phone: null, active: true, supplier_id: null,
  };

  function wire(failures: string[] = []) {
    const calls: Record<string, unknown>[] = [];
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/profiles`, () => HttpResponse.json([OFFICE])),
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
      // The settings page carries the currency tolerances panel since 0243. An empty list is the
      // honest answer for this fixture's organization: it trades in one currency and has nothing
      // to configure, which is the state the panel is meant to render as "nothing to decide".
      http.post(`${SUPABASE_URL}/rest/v1/rpc/currencies_in_use`, () => HttpResponse.json([])),
      http.post(RPC, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        calls.push(body);
        const failure = failures[calls.length - 1];
        return failure
          ? HttpResponse.json({ message: failure }, { status: 400 })
          : HttpResponse.json({ profile_id: body.p_profile_id, active: body.p_active });
      }),
    );
    return calls;
  }

  function renderSettings() {
    render(
      <QueryClientProvider client={createAppQueryClient()}>
        <OrgScopeProvider org="org-test">
          <ToastProvider>
            <MemoryRouter><Settings /></MemoryRouter>
          </ToastProvider>
        </OrgScopeProvider>
      </QueryClientProvider>,
    );
  }

  const stepUp = () => screen.queryByRole('dialog', { name: /אימות זהות לשינוי הרשאות/ });

  it('בלי סיסמה טרייה הצעד הראשון נעצר על הדיאלוג — ואף קריאה לא יצאה', async () => {
    authState.freshPassword = false;
    const user = userEvent.setup();
    const calls = wire();
    renderSettings();

    await openRowMenu(user, /פעולות עבור רות משרד/);
    await user.click(await screen.findByRole('menuitem', { name: 'השבתה' }));

    // The step-up is the gate the migration to Undo did NOT remove.
    await waitFor(() => expect(stepUp()).not.toBeNull());
    expect(within(stepUp()!).getByLabelText(/סיסמה לאימות זהות טרי/)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('עם סיסמה טרייה אין שאלה נוספת, והביטול שולח את הערך ההפוך', async () => {
    const user = userEvent.setup();
    const calls = wire();
    renderSettings();

    await openRowMenu(user, /פעולות עבור רות משרד/);
    await user.click(await screen.findByRole('menuitem', { name: 'השבתה' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].p_active).toBe(false);
    expect(calls[0].p_role).toBe('office');
    expect(calls[0].p_reason).toContain('השבתת משתמש');
    expect(stepUp()).toBeNull();

    await user.click(await screen.findByRole('button', { name: 'ביטול הפעולה' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].p_active).toBe(true);
    // The role and the supplier link are carried through unchanged — a reversal of access is not
    // a role change, and `manage_profile_access` would happily make it one if asked.
    expect(calls[1].p_role).toBe('office');
    expect(calls[1].p_supplier_id).toBeNull();
    expect(calls[1].p_reason).toContain('ביטול השבתת משתמש');
  });

  /*
   * The five-minute window is the whole reason this path exists. The toast can outlive the
   * server's freshness assertion — a hover holds it open indefinitely — and when it does,
   * `manage_profile_access` answers `fresh_authentication_required`. A red toast there would be
   * the app reporting a lock it is holding the key to.
   */
  it('ביטול שנדחה על אימות ישן פותח מחדש את הצעד — לא מציג שגיאה מתה', async () => {
    const user = userEvent.setup();
    const calls = wire(['', 'fresh_authentication_required']);
    renderSettings();

    await openRowMenu(user, /פעולות עבור רות משרד/);
    await user.click(await screen.findByRole('menuitem', { name: 'השבתה' }));
    await waitFor(() => expect(calls).toHaveLength(1));

    // The window lapses while the toast is on screen.
    authState.freshPassword = false;
    await user.click(await screen.findByRole('button', { name: 'ביטול הפעולה' }));

    await waitFor(() => expect(calls).toHaveLength(2));
    await waitFor(() => expect(stepUp()).not.toBeNull());
    expect(within(stepUp()!).getByLabelText(/סיסמה לאימות זהות טרי/)).toBeInTheDocument();
    // No dead end: the refusal became a prompt, not a red message.
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
