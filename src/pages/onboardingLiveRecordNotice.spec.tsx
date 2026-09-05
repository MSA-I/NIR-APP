/**
 * `OWN-14` — the setup wizard is an EDITOR over the business record already in use, and its first
 * button never said so.
 *
 * The plan filed this one as "measure first: confirm the write path", so the measurement is a test
 * and not a paragraph. The first test below presses 'שמירה והמשך' on step 1 and reads the request
 * that leaves: a `PATCH` to `organizations` carrying `name`, `vat_rate` and `settings.business`,
 * scoped to the signed-in organisation. It writes. It writes to the live row. That test passes
 * before and after the fix, which is what makes it a control rather than a claim.
 *
 * The second test is the finding. Step 1 opens pre-filled FROM that row — the name and the VAT
 * rate the business has been trading on for months — under a heading that reads like a form for a
 * business being set up for the first time, and steps 2 to 4 report 'הושלם'. Nothing on the screen
 * distinguishes "fill this in" from "you are about to overwrite what is there". The oracle:
 * a wizard that edits the live business record says so BEFORE the first save.
 *
 * WHY "BEFORE" IS ASSERTED IN DOM ORDER. A warning that renders under the button, or only after
 * the press, is not a warning — it is a receipt. The assertion is that the sentence precedes the
 * button in document order, which is the only reading order both languages share.
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
 * A trading organisation, not a blank one: a name, a VAT rate and the bank-matching keys another
 * screen owns. This is the shape the sweep met — `עסק לדוגמה`, 17.5%, four empty contact fields.
 */
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', org_id: 'org-test', role: 'owner' },
    org: {
      id: 'org-test',
      name: 'עסק לדוגמה',
      vat_rate: 17.5,
      settings: { bank_match_days: 7, bank_match_amount_tolerance: 1 },
      onboarding_completed_at: null,
    },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
    refreshOrg: async () => {},
  }),
}));

import Onboarding from './Onboarding';

const SUPPLIERS = `${SUPABASE_URL}/rest/v1/suppliers`;
const CATEGORIES = `${SUPABASE_URL}/rest/v1/categories`;
const PRODUCTS = `${SUPABASE_URL}/rest/v1/products`;
const SUPPLIER_PRODUCTS = `${SUPABASE_URL}/rest/v1/supplier_products`;
const ORGANIZATIONS = `${SUPABASE_URL}/rest/v1/organizations`;

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});

/** The four counters are `count: 'exact', head: true`, so HEAD needs a handler of its own. */
const counted = (endpoint: string, total: number) => [
  http.get(endpoint, () => HttpResponse.json([], { headers: { 'content-range': `*/${total}` } })),
  http.head(endpoint, () => new HttpResponse(null, { headers: { 'content-range': `*/${total}` } })),
];

const patched: Array<Record<string, unknown>> = [];
const patchedUrls: string[] = [];

beforeEach(() => {
  localStorage.clear();
  patched.length = 0;
  patchedUrls.length = 0;
  // A business with months of data behind it: the steps after the first read 'הושלם', which is
  // exactly why the first one reads as a form for something that does not exist yet.
  server.use(
    ...counted(CATEGORIES, 7), ...counted(SUPPLIERS, 12), ...counted(PRODUCTS, 148), ...counted(SUPPLIER_PRODUCTS, 310),
    http.patch(ORGANIZATIONS, async ({ request }) => {
      patchedUrls.push(request.url);
      patched.push(await request.json() as Record<string, unknown>);
      return HttpResponse.json([], { status: 204 });
    }),
  );
});

/** The wizard on step 1 — the business-details step, where the first writing button lives. */
function renderBusinessStep() {
  localStorage.setItem('supplyflow.onboarding.org-test', JSON.stringify({ step: 0, skipped: [] }));
  render(
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-test">
        <ToastProvider>
          <MemoryRouter initialEntries={['/onboarding']}><Onboarding /></MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>,
  );
}

const saveAndContinue = () => screen.getByRole('button', { name: /שמירה והמשך/ });

describe('/onboarding — the first button writes to the live business record', () => {
  it('MEASUREMENT: pressing it patches the organisation the business is trading on', async () => {
    renderBusinessStep();

    // Pre-filled from the live row, which is the half of the finding that makes the other half
    // matter: the person is looking at real values, not at an empty form.
    const name = await screen.findByLabelText('שם העסק *') as HTMLInputElement;
    expect(name.value).toBe('עסק לדוגמה');
    expect((screen.getByLabelText('שיעור מע״מ (%)') as HTMLInputElement).value).toBe('17.5');

    await userEvent.click(saveAndContinue());

    await waitFor(() => expect(patched).toHaveLength(1));
    // Name, VAT rate and the nested business block — a write, not a draft.
    expect(patched[0]).toMatchObject({ name: 'עסק לדוגמה', vat_rate: 17.5 });
    expect(patched[0]).toHaveProperty('settings.business');
    // Scoped to the signed-in organisation: this is the live row, not a wizard scratch row.
    expect(patchedUrls[0]).toContain('id=eq.org-test');
    // The keys another screen owns travel through the merge untouched.
    expect(patched[0]).toMatchObject({ settings: { bank_match_days: 7, bank_match_amount_tolerance: 1 } });
  });

  it('says so before that button, not after it', async () => {
    renderBusinessStep();
    await screen.findByLabelText('שם העסק *');

    const notice = screen.getByTestId('onboarding-live-record-notice');
    expect(notice).toBeTruthy();

    // Before, in document order. A warning under the button is a receipt, not a warning.
    const order = notice.compareDocumentPosition(saveAndContinue());
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
