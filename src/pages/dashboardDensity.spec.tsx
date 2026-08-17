// Which regions of מרכז הבקרה are still cards, and which stopped being cards.
//
// The control room had grown five stacked panels: attention, deliveries, the money strip, the
// trends board and the operational snapshot — each with its own border, radius, padded header,
// explanatory caption and dashboard shadow. When every region is a card, being a card stops saying
// anything, and the two surfaces that genuinely carry a decision — "what needs handling" and "what
// the money looks like" — read exactly as loudly as a chart board and a stack of folded detail.
//
// So the boxes came off the three secondary zones, and nothing else moved: same headings, same
// order, same rows, same counts. What is pinned here is precisely that:
//
//   1. The heading order the browser gate measures (`#main .dash-enter h2`) is unchanged, so a
//      future refactor cannot quietly reorder the zones and only find out in CI.
//   2. The money strip is still one card holding its three segments.
//   3. The trends board, the deliveries zone and the operational snapshot are NOT inside a card,
//      and are still on the page under their own headings — unwrapped, not deleted.
//   4. The page header no longer repeats the attention count that AttentionZone's own header
//      already carries roughly 40px below it.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
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
    profile: { id: 'u-1', role: 'owner', full_name: 'בודק', org_id: 'org-1' },
    org: { settings: {} },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import Dashboard from './Dashboard';

// jsdom implements neither of these, and the chart primitives read both on mount:
// `useReducedMotion` calls matchMedia unguarded, and the draw-in animation is gated on an
// IntersectionObserver. Stubbed locally rather than in the shared setup file so no other suite
// silently inherits a motion preference it never asked about.
beforeAll(() => {
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
  if (typeof window.IntersectionObserver !== 'function') {
    window.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
      readonly root = null;
      readonly rootMargin = '';
      readonly thresholds = [];
    } as unknown as typeof window.IntersectionObserver;
  }
});

/** The one server-side aggregate the screen cannot render without. Two waiting queues are set so
 *  the attention tier has real action rows — the header duplication under test only appeared when
 *  the count was greater than zero. */
const SNAPSHOT = {
  money: { openBalance: 1200, openInvoiceCount: 3 },
  paymentRequests: { pendingApproval: 2, drafts: 0, dueDateCoverage: 0, activeCount: 2, overdue: null, dueToday: null },
  credits: { count: 0, sum: null },
  bank: { unmatched: 0, suggested: 0 },
  invoices: { pendingApproval: 1, toReview: 0, notSent: 0 },
  openOrders: { count: 0, committed: null, remaining: 0, noDate: 0, late: 0, awaitingConfirmation: 0 },
  openSupplierCount: 0,
  topBalances: [],
};

// Every table read answers empty: none of them is under test, and the zones must render their
// honest empty/all-clear faces rather than depend on a fixture written for some other assertion.
const traffic = [
  http.get(`${SUPABASE_URL}/rest/v1/:table`, () => HttpResponse.json([])),
  http.post(`${SUPABASE_URL}/rest/v1/rpc/management_dashboard_snapshot`, () => HttpResponse.json(SNAPSHOT)),
];

function renderDashboard() {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-1">
        <ToastProvider>
          <MemoryRouter>{children}</MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>
  );
  return render(<Dashboard />, { wrapper: Wrapper });
}

describe('מרכז הבקרה — מה עדיין כרטיס ומה כבר לא', () => {
  it('סדר הכותרות שהשער מודד נשמר: דורש טיפול, ואז אספקות היום ומחר', async () => {
    server.use(...traffic);
    const { container } = renderDashboard();
    await screen.findByText('אספקות היום ומחר');

    // The exact selector check-browser-smoke.cjs uses on the live tenant.
    const headings = Array.from(container.querySelectorAll('.dash-enter h2')).map((node) => node.textContent ?? '');
    expect(headings[0]).toContain('דורש טיפול');
    expect(headings[1]).toContain('אספקות היום ומחר');
  });

  it('פס הכסף נשאר כרטיס אחד המחזיק את שלושת המקטעים', async () => {
    server.use(...traffic);
    renderDashboard();

    const band = (await screen.findByText('יתרת חשבוניות פתוחות')).closest('.card');
    expect(band).not.toBeNull();
    expect(band!.textContent).toContain('שולם לספקים החודש');
    expect(band!.textContent).toContain('נרכש החודש');
    expect(band!.querySelectorAll('.card')).toHaveLength(0);
  });

  it('אזורי האספקות, המגמות והתמונה התפעולית נשארים על המסך — בלי כרטיס סביבם', async () => {
    server.use(...traffic);
    renderDashboard();

    for (const title of ['אספקות היום ומחר', 'מגמות', 'תמונת מצב תפעולית']) {
      const heading = await screen.findByText(title);
      expect(heading).toBeVisible();
      expect(heading.closest('.card')).toBeNull();
    }

    // The zone that still earns its box: "דורש טיפול היום" is the screen's decision surface.
    expect((await screen.findByText(/דורש טיפול היום/)).closest('.card')).not.toBeNull();
  });

  it('כותרת הדף אינה חוזרת על ספירת הטיפול שכבר מופיעה מתחתיה', async () => {
    server.use(...traffic);
    renderDashboard();
    await screen.findByText('אספקות היום ומחר');

    expect(screen.queryByText(/סוגי טיפול שדורשים תשומת לב/)).not.toBeInTheDocument();
    // …and the count itself did not disappear with the sentence: AttentionZone still reports it.
    expect(screen.getByText(/סוגי טיפול/)).toBeVisible();
  });

  it('ארבעת אזורי הפירוט עדיין קיימים תחת כותרת אחת', async () => {
    server.use(...traffic);
    renderDashboard();
    await screen.findByText('תמונת מצב תפעולית');

    // Three subjects are all-clear against this fixture and say so by name; the fourth has two
    // waiting payment requests, so it renders as a counted, folded row. Either face proves the
    // subject survived the unwrapping.
    for (const label of ['אין חריגים פתוחים כרגע', 'אין התייקרויות אחרונות', 'אין יתרות פתוחות', 'משימות לפי תפקיד']) {
      expect(screen.getByText(label)).toBeVisible();
    }
  });
});
