// The due-window tile — what the manager sees where the coverage ring used to be.
//
// The ring answered "how many active payment requests carry a due date". It was a true ratio and
// it was useless: a manager cannot pay a percentage, and the figure moved with data hygiene
// rather than with the business. The tile now answers the question the week actually asks — how
// much money has to move, and how much of it is already late (owner review, defect 11).
//
// What is pinned here is the part a refactor can silently break, because both faces look
// plausible on screen: the null-vs-zero policy. `null` means no active request carries a due
// date at all — no measurement was possible, so the tile says so in words. `0` means dated
// requests exist and none of them fall in this window — that IS a measurement, and printing "—"
// for it would hide a genuine "nothing due this week". CLAUDE.md forbids the reverse mistake
// too: a zero standing in for the unknown is a claim about reality nobody made.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { ToastProvider } from '../components/ui';
import { fmtMoneyRounded } from '../lib/format';

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

// jsdom implements neither, and the chart primitives on this screen read both on mount.
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

type PaymentRequestFacts = {
  dueDateCoverage: number;
  activeCount: number;
  overdue: number | null;
  dueToday: number | null;
  overdueAmount: number | null;
  dueWithin7Amount: number | null;
  dueWithin7Count: number | null;
};

/** Everything on the screen except the payment-request facts under test answers empty. */
function snapshotWith(paymentRequests: PaymentRequestFacts) {
  return {
    money: { openBalance: null, openInvoiceCount: 0 },
    paymentRequests: { pendingApproval: 0, drafts: 0, ...paymentRequests },
    credits: { count: 0, sum: null },
    bank: { unmatched: 0, suggested: 0 },
    invoices: { pendingApproval: 0, toReview: 0, notSent: 0 },
    openOrders: { count: 0, committed: null, remaining: 0, noDate: 0, late: 0, awaitingConfirmation: 0 },
    openSupplierCount: 0,
    topBalances: [],
  };
}

function renderWith(paymentRequests: PaymentRequestFacts) {
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/:table`, () => HttpResponse.json([])),
    // A live tenant, so the setup-wizard door stays shut and the money tile is what renders. The
    // dashboard counts suppliers with a HEAD request; without this the whole screen fails to load
    // and the tile is missing for a reason that has nothing to do with the tile.
    http.head(`${SUPABASE_URL}/rest/v1/suppliers`, () => new HttpResponse(null, {
      headers: { 'Content-Range': '*/22' },
    })),
    http.post(
      `${SUPABASE_URL}/rest/v1/rpc/management_dashboard_snapshot`,
      () => HttpResponse.json(snapshotWith(paymentRequests)),
    ),
  );
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-1">
        <ToastProvider>
          <MemoryRouter>{children}</MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>
  );
  render(<Dashboard />, { wrapper: Wrapper });
  return screen.findByRole('region', { name: 'לתשלום בשבוע הקרוב' });
}

describe('לתשלום בשבוע הקרוב — הכסף, לא כיסוי התאריכים', () => {
  it('מציג סכום כולל ומפריד ממנו את מה שכבר באיחור', async () => {
    const tile = await renderWith({
      dueDateCoverage: 2, activeCount: 3, overdue: 1, dueToday: 0,
      overdueAmount: 10, dueWithin7Amount: 35, dueWithin7Count: 1,
    });

    // The headline is the whole obligation: what is late PLUS what falls due inside the window.
    // "מתוכם" below only holds if the two lines are parts of this figure.
    expect(tile.textContent).toContain(fmtMoneyRounded(45));
    // The WORD carries the meaning. The alert ink beside it is a repetition, not the carrier —
    // strip the colour and the sentence still says which half of the money is late.
    expect(tile.textContent).toContain('מתוכם באיחור');
    expect(tile.textContent).toContain(fmtMoneyRounded(10));
    expect(tile.textContent).toContain(fmtMoneyRounded(35));
    // Each figure names how many requests stand behind it, so the amount is auditable.
    expect(tile.textContent).toMatch(/1 דרישות/);
  });

  // 25.08.2026. The tile carries one graphic now, and it is the only place on this screen where a
  // width is an ARGUMENT: two inline percentages that claim "this much of the money is already
  // late". A wrong denominator would keep rendering a perfectly plausible bar, so the split is
  // asserted here rather than trusted. The bar itself stays aria-hidden — the two sentences under
  // it already name both amounts, and this test reads the DOM node, not the accessibility tree.
  it('פס הפיצול מחלק לפי הכסף שחייב לזוז, לא לפי מספר הדרישות', async () => {
    const tile = await renderWith({
      dueDateCoverage: 2, activeCount: 3, overdue: 1, dueToday: 0,
      overdueAmount: 10, dueWithin7Amount: 30, dueWithin7Count: 4,
    });

    const segments = [...tile.querySelectorAll('.split-bar > span')].map((s) => (s as HTMLElement).style.width);
    // 10 of 40 is late — a QUARTER of the bar, even though only one request in five is the late
    // one. Counting requests instead of shekels would have drawn 20% here and been wrong quietly.
    expect(segments).toEqual(['25%', '75%']);
  });

  it('חלון בלי כסף — אין פס, ולא פס בחלוקת אפס', async () => {
    const tile = await renderWith({
      dueDateCoverage: 2, activeCount: 3, overdue: 0, dueToday: 0,
      overdueAmount: 0, dueWithin7Amount: 0, dueWithin7Count: 0,
    });

    // Requests exist and are dated, so the tile still shows ₪0 rather than the empty sentence.
    // The bar has nothing to divide by: it must be absent, not a NaN% pair of widths.
    expect(tile.textContent).toContain(fmtMoneyRounded(0));
    expect(tile.querySelector('.split-bar')).toBeNull();
  });

  it('חלון ריק מעל דרישות מתוארכות הוא אפס מדוד, לא "—"', async () => {
    const tile = await renderWith({
      dueDateCoverage: 2, activeCount: 3, overdue: 2, dueToday: 0,
      overdueAmount: 45, dueWithin7Amount: 0, dueWithin7Count: 0,
    });

    expect(tile.textContent).toContain(fmtMoneyRounded(0));
    expect(tile.textContent).toContain('מתוכם באיחור');
    expect(tile.textContent).not.toContain('אין דרישות תשלום פעילות עם תאריך פירעון');
  });

  it('בלי אף דרישה מתוארכת — משפט במקום מספר, אף פעם לא ₪0', async () => {
    const tile = await renderWith({
      dueDateCoverage: 0, activeCount: 2, overdue: null, dueToday: null,
      overdueAmount: null, dueWithin7Amount: null, dueWithin7Count: null,
    });

    expect(tile.textContent).toContain('אין דרישות תשלום פעילות עם תאריך פירעון');
    expect(tile.textContent).not.toContain(fmtMoneyRounded(0));
    // The subtitle still says what the tile MEASURES ("כולל מה שכבר באיחור"); what must not
    // appear is the breakdown line, which would be a claim about an amount nobody measured.
    expect(tile.textContent).not.toContain('מתוכם באיחור');
  });

  // 0168. The tile was the only money figure on this screen with no way out of it, and the
  // destination it now points at has to select exactly the rows the tile counted. The href IS
  // that contract: `due=soon` is the PaymentRequests filter whose window and status set were
  // corrected alongside the aggregate. A link to any other filter would show a different
  // number of rows than the figure the user just clicked.
  it('מקשר לרשימה שמסננת בדיוק את מה שנספר', async () => {
    const tile = await renderWith({
      dueDateCoverage: 2, activeCount: 3, overdue: 1, dueToday: 0,
      overdueAmount: 10, dueWithin7Amount: 35, dueWithin7Count: 1,
    });

    const link = within(tile).getByRole('link', { name: 'כל דרישות התשלום בחלון' });
    expect(link).toHaveAttribute('href', '/payment-requests?due=soon');
  });

  it('בלי נתונים אין קישור — אין לאן ללכת', async () => {
    const tile = await renderWith({
      dueDateCoverage: 0, activeCount: 2, overdue: null, dueToday: null,
      overdueAmount: null, dueWithin7Amount: null, dueWithin7Count: null,
    });

    expect(within(tile).queryByRole('link')).toBeNull();
  });

});
