// Which regions of מרכז הבקרה are cards, which are bare, and where the dark tile lives (T7).
//
// The T7 owner redesign (18.08.2026, Crextio-reference layout) redrew the division: the money
// strip lost its card and its three hero figures sit straight on the wheat canvas; the working
// tiles — attention, deliveries, each trend chart, the operational snapshot — are borderless
// cards; and the role queues moved out of the folded snapshot into the dashboard's single dark
// Onyx card. What is pinned here is precisely that:
//
//   1. The heading order the browser gate measures (`#main .dash-enter h2`) is unchanged, so a
//      future refactor cannot quietly reorder the zones and only find out in CI.
//   2. The money strip is NOT a card any more — three bare segments, separation by spacing.
//   3. Attention and deliveries are cards; the trends and snapshot headings sit on the canvas
//      with their content in cards below them.
//   4. The page header no longer repeats the attention count that AttentionZone's own header
//      already carries roughly 40px below it.
//   5. "משימות לפי תפקיד" renders exactly once, inside the dark shell card — not in the fold.

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
  // No active request carries a due date here, so every due-date figure — counts and money
  // alike — is unknown rather than zero, and the due-window tile renders its sentence.
  paymentRequests: {
    pendingApproval: 2, drafts: 0, dueDateCoverage: 0, activeCount: 2, overdue: null, dueToday: null,
    overdueAmount: null, dueWithin7Amount: null, dueWithin7Count: null,
  },
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
  // The first-run probe is a HEAD count — the total rides Content-Range, no rows come back.
  // 22 keeps this fixture describing a live tenant, so the setup-wizard note stays out of the
  // layout assertions below; the empty-org case gets its own suite with `*/0`.
  http.head(`${SUPABASE_URL}/rest/v1/suppliers`, () => new HttpResponse(null, {
    headers: { 'Content-Range': '*/22' },
  })),
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

  it('פס הכסף הוא שלושה כרטיסים נפרדים — אחד לכל מדד (T7.3c)', async () => {
    server.use(...traffic);
    renderDashboard();

    // On a phone they stack as three tiles (owner report: one merged block read as a bug);
    // on desktop they are the reference's stat-card row. Each figure owns its card.
    const first = (await screen.findByText('יתרת חשבוניות פתוחות')).closest('.card');
    expect(first).not.toBeNull();
    expect(first!.textContent).not.toContain('שולם לספקים החודש');
    expect((await screen.findByText('שולם לספקים החודש')).closest('.card')).not.toBeNull();
    expect((await screen.findByText('נרכש החודש')).closest('.card')).not.toBeNull();
  });

  it('אריחי העבודה הם כרטיסים; כותרות המגמות והתמונה התפעולית יושבות על הקנבס', async () => {
    server.use(...traffic);
    renderDashboard();

    // Region headings on the canvas, content in cards below them.
    for (const title of ['מגמות', 'תמונת מצב תפעולית']) {
      const heading = await screen.findByText(title);
      expect(heading).toBeVisible();
      expect(heading.closest('.card')).toBeNull();
    }
    // The decision surfaces carry their box: attention and deliveries are cards.
    expect((await screen.findByText(/דורש טיפול היום/)).closest('.card')).not.toBeNull();
    expect((await screen.findByText('אספקות היום ומחר')).closest('.card')).not.toBeNull();
    // Each trend chart is its own card tile.
    expect((await screen.findByText('הוצאות רכש לפי חודש')).closest('.card')).not.toBeNull();
    expect((await screen.findByText('תמהיל הרכש החודש')).closest('.card')).not.toBeNull();
    // The folded snapshot rows live inside one card under the bare heading.
    expect((await screen.findByText('אין חריגים פתוחים כרגע')).closest('.card')).not.toBeNull();
  });

  it('משימות לפי תפקיד מרונדרות פעם אחת — בכרטיס הכהה, לא בקיפול התפעולי', async () => {
    server.use(...traffic);
    renderDashboard();

    const heading = await screen.findByText('משימות לפי תפקיד');
    const darkCard = heading.closest('section');
    expect(darkCard).not.toBeNull();
    expect(darkCard!.className).toContain('bg-shell');
    // The queues render once: their labels exist only inside the dark card.
    expect(screen.getAllByText('משימות לפי תפקיד')).toHaveLength(1);
    expect(screen.getByText('דרישות לאישור הנהלה').closest('section')).toBe(darkCard);
  });

  it('כותרת הדף אינה חוזרת על ספירת הטיפול שכבר מופיעה מתחתיה', async () => {
    server.use(...traffic);
    renderDashboard();
    await screen.findByText('אספקות היום ומחר');

    expect(screen.queryByText(/סוגי טיפול שדורשים תשומת לב/)).not.toBeInTheDocument();
    // …and the count itself did not disappear with the sentence: AttentionZone still reports it.
    expect(screen.getByText(/סוגי טיפול/)).toBeVisible();
  });

  it('שלושת אזורי הפירוט עדיין קיימים תחת כותרת אחת', async () => {
    server.use(...traffic);
    renderDashboard();
    await screen.findByText('תמונת מצב תפעולית');

    // All three folded subjects are all-clear against this fixture and say so by name — proof the
    // subjects survived T7. The fourth former subject (role queues) is asserted above, in the
    // dark-card test, so nothing here counts it twice.
    for (const label of ['אין חריגים פתוחים כרגע', 'אין התייקרויות אחרונות', 'אין יתרות פתוחות']) {
      expect(screen.getByText(label)).toBeVisible();
    }
  });
});

// The screen a paying trial customer sees in their first five seconds. Nothing here is about
// density — it is about a brand-new organization not looking broken: the largest card must say
// something, and the screen must name the next step.
describe('ארגון ריק — הריצה הראשונה', () => {
  const EMPTY_SNAPSHOT = {
    ...SNAPSHOT,
    money: { openBalance: null, openInvoiceCount: 0 },
    // The two rows the RPC cannot measure with no due-dated request in the org (0100:126-134).
    // They are what used to make the attention card render an empty body.
    paymentRequests: { pendingApproval: 0, drafts: 0, dueDateCoverage: 0, activeCount: 0, overdue: null, dueToday: null },
    invoices: { pendingApproval: 0, toReview: 0, notSent: 0 },
  };
  const emptyTraffic = (supplierCount: number) => [
    http.get(`${SUPABASE_URL}/rest/v1/:table`, () => HttpResponse.json([])),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/management_dashboard_snapshot`, () => HttpResponse.json(EMPTY_SNAPSHOT)),
    http.head(`${SUPABASE_URL}/rest/v1/suppliers`, () => new HttpResponse(null, {
      headers: { 'Content-Range': `*/${supplierCount}` },
    })),
  ];

  it('כרטיס „דורש טיפול” אומר משהו, ומסך הבית מפנה לאשף ההקמה', async () => {
    server.use(...emptyTraffic(0));
    renderDashboard();

    // The card body: neutral, not a green all-clear it is not entitled to claim.
    expect(await screen.findByText(/אין משימות דחופות מבין המדדים שנמדדו/)).toBeVisible();
    expect(screen.queryByText('אין משימות דחופות כרגע')).not.toBeInTheDocument();

    // …and the next step is on the screen, not buried in the account menu.
    const wizard = screen.getByRole('link', { name: /אשף ההקמה/ });
    expect(wizard).toHaveAttribute('href', '/onboarding');
  });

  it('עסק שכבר יש בו ספקים אינו רואה את הפנייה לאשף', async () => {
    server.use(...emptyTraffic(22));
    renderDashboard();
    await screen.findByText('אספקות היום ומחר');

    expect(screen.queryByRole('link', { name: /אשף ההקמה/ })).not.toBeInTheDocument();
  });
});
