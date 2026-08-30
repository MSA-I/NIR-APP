/**
 * The setup wizard's ending is a FACT ABOUT THE BUSINESS, not a note in this browser.
 *
 * Owner report 30.08.2026: "כשמשתמש פותח חשבון חדש הרי המסך הזה מוצג לו, אם הוא ממלא את הפרטים
 * כמו שצריך אין טעם שהמסך הזה יהיה זמין לו." It was available for ever, and the reason was here:
 * pressing finish wrote `completedAt` into `localStorage`, where the sidebar cannot read it, where
 * the dashboard banner cannot read it, and where a second browser never sees it at all.
 *
 * So the claim under test is not "a flag is set". It is that pressing finish reaches the SERVER,
 * that the shell is told to re-read the organisation while it is still on screen, and that a
 * failure to record it does not walk the owner away as though it had worked.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
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

const refreshOrg = vi.fn(async () => {});

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', org_id: 'org-test', role: 'owner' },
    org: { id: 'org-test', name: 'מטבח הדגמה', settings: {}, onboarding_completed_at: null },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
    refreshOrg,
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
const empty = (endpoint: string) => [
  http.get(endpoint, () => HttpResponse.json([], { headers: { 'content-range': '*/0' } })),
  http.head(endpoint, () => new HttpResponse(null, { headers: { 'content-range': '*/0' } })),
];

beforeEach(() => {
  localStorage.clear();
  refreshOrg.mockClear();
  server.use(...empty(CATEGORIES), ...empty(PRODUCTS), ...empty(SUPPLIER_PRODUCTS), ...empty(SUPPLIERS));
});

/** Opens the wizard on its summary step, which is where the finish button lives. */
function renderSummary() {
  localStorage.setItem('supplyflow.onboarding.org-test', JSON.stringify({ step: 4, skipped: [] }));
  render(
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-test">
        <ToastProvider>
          <MemoryRouter initialEntries={['/onboarding']}>
            <Routes>
              <Route path="/onboarding" element={<Onboarding />} />
              <Route path="/dashboard" element={<div>מרכז הבקרה</div>} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>,
  );
}

/** The primary button, not the header's link of the same name. */
const finishButton = () => screen.findByRole('button', { name: /כניסה למערכת/ });

describe('סיום ההקמה', () => {
  it('נרשם על הארגון, ומרענן את המעטפת שעדיין מציגה את התפריט', async () => {
    const patched: unknown[] = [];
    server.use(http.patch(ORGANIZATIONS, async ({ request }) => {
      patched.push(await request.json());
      return HttpResponse.json([], { status: 204 });
    }));

    renderSummary();
    await userEvent.click(await finishButton());

    // Written to the organisation — the one place the sidebar, the avatar menu and the dashboard
    // banner all read. `localStorage` would have satisfied an older version of this test and left
    // the reported bug exactly where it was.
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(patched[0]).toMatchObject({ onboarding_completed_at: expect.any(String) });

    // The shell is on screen while this happens. Without the re-read it would go on offering the
    // wizard until the next full reload, which is the same complaint in a smaller window.
    expect(refreshOrg).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('מרכז הבקרה')).toBeInTheDocument();
  });

  it('כישלון שמירה משאיר את הבעלים במסך עם הסיבה, ולא מעמיד פנים שהסתיים', async () => {
    server.use(http.patch(ORGANIZATIONS, () => HttpResponse.json(
      { message: 'permission denied for table organizations' }, { status: 403 },
    )));

    renderSummary();
    await userEvent.click(await finishButton());

    // Navigating away here would land the owner on a dashboard that still offers the wizard, with
    // nothing on screen to say why. Truth-reporting (CLAUDE.md): the failure is shown and stays.
    // The toast is asserted first — without it "did not navigate" would also pass for a button
    // that did nothing at all, which is the failure this test is supposed to be able to see.
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(refreshOrg).not.toHaveBeenCalled();
    expect(screen.queryByText('מרכז הבקרה')).toBeNull();
    expect(await finishButton()).toBeEnabled();
  });
});
