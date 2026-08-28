/**
 * The setup wizard stops requiring a file.
 *
 * Owner report 28.08.2026: "שתהיה אופציה לבחור שם ספק ולמלא ידנית, ואז המחירים והמוצרים יתעדכנו
 * בהעלאת חשבונית של הספק. כי לא תמיד יש מחירון של ספק." The suppliers step accepted a spreadsheet
 * and nothing else, so a business whose suppliers are four names and no file had to leave the
 * wizard to enter them — and the products step read as unfinished work rather than as optional.
 *
 * Two claims are asserted, because both are what makes the wizard finishable without a file: the
 * manual door exists on the suppliers step, and the price list is stated to be optional with the
 * reason it is (an invoice builds the catalogue on arrival).
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

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', org_id: 'org-test', role: 'owner' },
    org: { id: 'org-test', name: 'מטבח הדגמה', settings: {} },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import Onboarding from './Onboarding';

const SUPPLIERS = `${SUPABASE_URL}/rest/v1/suppliers`;
const CATEGORIES = `${SUPABASE_URL}/rest/v1/categories`;
const PRODUCTS = `${SUPABASE_URL}/rest/v1/products`;
const SUPPLIER_PRODUCTS = `${SUPABASE_URL}/rest/v1/supplier_products`;

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});

/**
 * The wizard's four counters are `count: 'exact', head: true`, which supabase-js sends as HEAD.
 * A GET-only handler leaves the page on its skeleton forever — the first draft of this suite did
 * exactly that and read as "the button is missing".
 */
const empty = (endpoint: string) => [
  http.get(endpoint, () => HttpResponse.json([], { headers: { 'content-range': '*/0' } })),
  http.head(endpoint, () => new HttpResponse(null, { headers: { 'content-range': '*/0' } })),
];

beforeEach(() => {
  localStorage.clear();
  server.use(...empty(CATEGORIES), ...empty(PRODUCTS), ...empty(SUPPLIER_PRODUCTS), ...empty(SUPPLIERS));
});

/** Opens the wizard on a chosen step by writing the cursor the wizard reads on mount. */
function renderWizardAt(step: number) {
  localStorage.setItem('supplyflow.onboarding.org-test', JSON.stringify({ step, skipped: [], completedAt: null }));
  render(
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-test">
        <ToastProvider>
          <MemoryRouter><Onboarding /></MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>,
  );
}

describe('a business with no supplier file can still finish the setup', () => {
  it('offers a manual door on the suppliers step and promises what replaces the price list', async () => {
    renderWizardAt(2);

    const add = await screen.findByRole('button', { name: /הוספת ספק/ });
    expect(add).toBeInTheDocument();
    // The promise is the reason the door is enough on its own — a supplier with no price list is
    // not half-configured, because the first invoice from them builds the catalogue.
    expect(screen.getByText(/בפעם הראשונה שתעלו חשבונית מהספק הזה/)).toBeInTheDocument();

    await userEvent.click(add);
    // The reused dialog, and — asserted structurally rather than by comment — still without the
    // one field that must never spread to a second surface (DEBT §11 / #106).
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('ספק חדש');
    expect(screen.queryByLabelText(/בנק|חשבון/)).toBeNull();
  });

  it('states on the products step that a price list is optional, and why', async () => {
    renderWizardAt(3);

    await waitFor(() => expect(screen.getByText(/אפשר לדלג על השלב הזה/)).toBeInTheDocument());
    expect(screen.getByText(/המוצרים שבה נוצרים/)).toBeInTheDocument();
  });
});
