/**
 * The menu shows what the plan includes — rendered, not reasoned about.
 *
 * `entitlements.spec.ts` pins the RULE (only a measured refusal withholds anything). This pins the
 * WIRING, which is the half that fails silently: a map nothing reads, or a filter applied to the
 * bar and not to the drawer, both look exactly like a correct implementation from the outside.
 *
 * Owner report 28.08.2026: "צריך לסדר את זה שהקטגוריות מתגלות בהדרגה בהתאם למה שכל מנוי מקבל,
 * למשל מנוי חינמי לא יכול לראות קטגוריות שקשורות להוספת משתמשים או שליחה לרואה חשבון וכדומה."
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';

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
    profile: { role: 'owner', full_name: 'בודק', org_id: 'org-1' },
    org: { name: 'ארגון בדיקה' },
    roleLabels: { owner: 'בעלים' },
    isPlatformAdmin: false,
    organizationAccess: { mode: 'active', canWrite: true },
    accessStatus: 'authoritative',
    signOut: async () => ({ error: null }),
  }),
}));
vi.mock('../lib/useInboxCount', () => ({ useInboxCount: () => null }));
vi.mock('./GlobalSearch', () => ({ default: () => null, canGlobalSearch: () => false }));
vi.mock('./Fab', () => ({ default: () => null }));
vi.mock('./NotificationBell', () => ({ default: () => null }));
vi.mock('./FeedbackButton', () => ({ default: () => null }));
vi.mock('./PlanBadge', () => ({ PlanBadge: () => null, planTierClass: () => null, TIER_CLASS: {} }));
vi.mock('../lib/flags', () => ({ useFeatureFlags: () => ({ isEnabled: () => false }) }));

import Layout from './Layout';
import { ToastProvider } from './ui';

const ENTITLEMENTS = `${SUPABASE_URL}/rest/v1/rpc/my_entitlements`;

const boolean = (entitlement_key: string, value: boolean | null, measured = true) => ({
  entitlement_key, kind: 'boolean', measure: 'current', unit: null, label: entitlement_key,
  plan_key: 'free', subscription_status: 'active', source: 'plan',
  unlimited: false, numeric_limit: null, boolean_value: value, measured,
});

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: true, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

function renderShell(rows: unknown[]) {
  server.use(http.post(ENTITLEMENTS, () => HttpResponse.json(rows)));
  render(
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-1">
        <ToastProvider>
          <MemoryRouter initialEntries={['/dashboard']}>
            <Routes>
              <Route element={<Layout />}>
                <Route path="/dashboard" element={null} />
                <Route path="/bank" element={null} />
                <Route path="/reports" element={null} />
              </Route>
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>,
  );
}

/** The drawer is the surface the owner reported on, so it is the surface asserted. */
async function openDrawer() {
  fireEvent.click(screen.getByRole('button', { name: 'פתיחת תפריט' }));
  return screen.getByRole('dialog', { name: 'תפריט ראשי' });
}

describe('המגירה מציגה את מה שהמסלול כולל', () => {
  it('מסתירה יעדים שהמסלול אינו כולל, בשני המשטחים', async () => {
    renderShell([
      boolean('reports.advanced', false),
      boolean('bank.reconciliation', false),
    ]);

    // Withheld only after the answer lands, so the assertion waits for it rather than for a frame.
    await waitFor(() => expect(screen.queryByRole('link', { name: 'התאמות בנק' })).toBeNull());
    expect(screen.queryByRole('link', { name: 'דוח לרו״ח' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'ביצועי ספקים' })).toBeNull();

    const drawer = await openDrawer();
    expect(within(drawer).queryByRole('link', { name: 'התאמות בנק' })).toBeNull();
    expect(within(drawer).queryByRole('link', { name: 'דוח לרו״ח' })).toBeNull();
    // Everything the plan DOES include is untouched — withholding removes rows, it never rebuilds
    // the menu around them.
    expect(within(drawer).getByRole('link', { name: 'חשבוניות' })).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'מרכז הבקרה' })).toBeInTheDocument();
    // The group survives on its remaining rows rather than vanishing with the withheld ones.
    expect(within(drawer).getByRole('link', { name: 'חריגים' })).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'ריכוז הוצאות' })).toBeInTheDocument();
  });

  it('משאירה את התפריט שלם כשהמסלול כולל הכול', async () => {
    renderShell([
      boolean('reports.advanced', true),
      boolean('bank.reconciliation', true),
    ]);

    const drawer = await openDrawer();
    // The drawer is where every destination is a visible link at once. On the desktop bar these two
    // sit inside group panels that stay out of the accessibility tree until their trigger is
    // pressed, so a bar-wide query would fail here for a reason that has nothing to do with plans.
    await waitFor(() => expect(within(drawer).getByRole('link', { name: 'התאמות בנק' })).toBeInTheDocument());
    expect(within(drawer).getByRole('link', { name: 'דוח לרו״ח' })).toBeInTheDocument();
  });

  it('משאירה את התפריט שלם כשהתשובה אינה נמדדת — פער אצלנו אינו סירוב ללקוח', async () => {
    renderShell([
      boolean('reports.advanced', null, false),
      boolean('bank.reconciliation', null, false),
    ]);

    const drawer = await openDrawer();
    // Nothing is removed, and nothing is waited for: an unmeasured answer must leave the menu
    // exactly as a failed read would.
    expect(within(drawer).getByRole('link', { name: 'התאמות בנק' })).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'דוח לרו״ח' })).toBeInTheDocument();
  });
});
