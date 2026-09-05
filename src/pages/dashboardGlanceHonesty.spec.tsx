/**
 * `DASH-09`, `DASH-10`, `DASH-11`, `DASH-13` — four ways the control centre says something it
 * does not mean, all of them on the one surface §12 exists for: the screen a manager reads in
 * seconds and then acts on.
 *
 * Each case below states the condition that is FALSE before the fix and TRUE after, and each is
 * measured off the RENDERED screen rather than off a helper — the defects are all in what reaches
 * the reader, and a helper that formats correctly into markup that reverses it is still a screen
 * that lies.
 *
 * `DASH-09` deserves a word about what jsdom can and cannot see. jsdom has no layout engine, so
 * it cannot tell you which side of the digits the ₪ lands on. What it CAN tell you is the thing
 * that decides it: the bidi context each money figure is rendered in. Measured in Edge on
 * 04.09.2026 against `‏11,582 ‏₪` and `‏300 ‏$` — the exact code-point sequences the sweep
 * recorded — the same string renders the marker AFTER the digits inside `dir="ltr"` and BEFORE
 * them in the document's own RTL, for every currency alike. So the flip is not a property of the
 * currency, as the finding supposed; it is a property of the MARKUP, and the dashboard ships both
 * shapes at once. One context is therefore the whole of the fix, and it is what this file pins.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
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
    org: { settings: {}, base_currency: 'ILS' },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import Dashboard from './Dashboard';

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

/**
 * The tenant the sweep measured on 04.09.2026, reduced to the facts these four cases turn on:
 * ₪11,582 of open invoice balance over 8 invoices, ₪300 of it in dollars so the picker renders,
 * and 8 credits totalling ₪3,381 that no surface has offset yet.
 */
const SNAPSHOT = {
  money: {
    openBalanceByCurrency: [
      { currency: 'ILS', amount: 11582, invoiceCount: 8 },
      { currency: 'USD', amount: 300, invoiceCount: 1 },
    ],
    openInvoiceCount: 9,
  },
  paymentRequests: {
    pendingApproval: 0, drafts: 0, dueDateCoverage: 0, activeCount: 0,
    overdue: null, dueToday: null,
    overdueAmountByCurrency: null, dueWithin7AmountByCurrency: null, dueWithin7Count: null,
  },
  credits: { count: 8, sumByCurrency: [{ currency: 'ILS', amount: 3381 }] },
  bank: { unmatched: 0, suggested: 0 },
  invoices: { pendingApproval: 0, toReview: 0, notSent: 0 },
  openOrders: {
    count: 0, committedByCurrency: null, remainingByCurrency: [],
    noDate: 0, late: 0, awaitingConfirmation: 0,
  },
  openSupplierCount: 0,
  topBalancesByCurrency: [],
};

/**
 * The month's requests, as `purchase_request_items` returns them. One product, bought at 2,344
 * where the dearest available offer is 2,353: a real ₪9 saved out of a ₪2,353 worst case, which
 * is 0.38% — the figure `toFixed(0)` printed as `0`.
 */
const REQUEST_ITEMS = [
  { id: 'ri-1', qty: 1, unit_price: 2344, product_id: 'p-1', request: { currency: 'ILS' } },
];
const OFFERS = [{ id: 'sp-1', product_id: 'p-1', current_price: 2353, currency: 'ILS' }];

/** Route the PostgREST reads this screen makes; everything not named answers empty. */
function installHandlers() {
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/purchase_request_items`, () => HttpResponse.json(REQUEST_ITEMS)),
    http.get(`${SUPABASE_URL}/rest/v1/supplier_products`, ({ request }) =>
      // Two different reads hit this table: the 30-day price-change list (it filters on
      // `price_effective_date`) and the available-offer list the saving is compared against.
      HttpResponse.json(new URL(request.url).searchParams.has('price_effective_date') ? [] : OFFERS)),
    http.get(`${SUPABASE_URL}/rest/v1/:table`, () => HttpResponse.json([])),
    http.head(`${SUPABASE_URL}/rest/v1/suppliers`, () => new HttpResponse(null, {
      headers: { 'Content-Range': '*/22' },
    })),
    http.post(
      `${SUPABASE_URL}/rest/v1/rpc/management_dashboard_snapshot`,
      () => HttpResponse.json(SNAPSHOT),
    ),
  );
}

/** Reports the live URL, so `DASH-13` can read what the picker put there. */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="where">{`${location.pathname}${location.search}`}</span>;
}

function renderDashboard(initialEntry = '/dashboard') {
  installHandlers();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-1">
        <ToastProvider>
          <MemoryRouter initialEntries={[initialEntry]}>
            <LocationProbe />
            <Routes><Route path="/dashboard" element={children} /></Routes>
          </MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>
  );
  render(<Dashboard />, { wrapper: Wrapper });
}

/**
 * Every element on screen whose whole text is one rendered money figure.
 *
 * Queried off the DOM rather than through `getByText`, and deliberately: a formatted figure
 * carries U+200F and U+00A0, which Testing Library's normaliser collapses on one side of the
 * comparison only. Comparing the formatter's own output to `textContent` keeps both sides exact.
 */
function moneyFigures(): HTMLElement[] {
  const printed = new Set([
    fmtMoneyRounded(11582, 'ILS'), fmtMoneyRounded(300, 'USD'), fmtMoneyRounded(3381, 'ILS'),
  ]);
  return [...document.querySelectorAll<HTMLElement>('*')]
    .filter((el) => printed.has((el.textContent ?? '').trim()))
    // Only the innermost carrier: an ancestor whose whole text happens to be the figure is
    // reporting its child's context, not its own.
    .filter((el) => ![...el.children].some((child) => printed.has((child.textContent ?? '').trim())));
}

/** The money band has painted its figure — the screen is loaded and the fixture arrived. */
const bandIsUp = () => screen.findByText('יתרת חשבוניות פתוחות');

/** The direction a figure is actually laid out in: nearest `dir` at or above it. */
const bidiContextOf = (el: HTMLElement) => el.closest('[dir]')?.getAttribute('dir') ?? 'inherited-rtl';

describe('DASH-09 — סימן המטבע יושב בצד אחד בכל המסך', () => {
  it('כל סכום על מסך המבט נמצא באותו הקשר דו-כיווני', async () => {
    renderDashboard();
    await bandIsUp();

    const figures = moneyFigures();
    // The fixture puts both shapes on screen at once: the money band's own figure and the credits
    // row's, drawn by MoneyByCurrency. If they disagree the reader sees the marker move.
    expect(figures.length).toBeGreaterThan(1);
    const contexts = [...new Set(figures.map(bidiContextOf))];
    expect(contexts).toHaveLength(1);
  });

  it('אין סכום שנושא dir="ltr" — זה שמור למזהים אטומיים בלבד (DESIGN.md)', async () => {
    renderDashboard();
    await bandIsUp();
    // DESIGN.md, "מספרים": `.tech-id` is the only exception — "מזהים אטומיים מקבלים dir=ltr;
    // סכומים, כמויות, אחוזים, תאריכים... נשארים". A sum is not an identifier.
    expect(moneyFigures().filter((el) => bidiContextOf(el) === 'ltr')).toEqual([]);
  });
});

describe('DASH-11 — חיסכון אמיתי לא מדווח כאפס אחוז', () => {
  it('₪9 מתוך ₪2,353 אינו "0%"', async () => {
    renderDashboard();
    const saving = await screen.findByText(/חיסכון משוער/);
    // The amount is exact; the percentage beside it must be able to express what the amount says.
    expect(saving.textContent).toContain(fmtMoneyRounded(9, 'ILS'));
    expect(saving.textContent).not.toMatch(/·\s*0%/);
    // 9 / 2353 = 0.3825…% — one decimal is the precision that can say it.
    expect(saving.textContent).toMatch(/0\.4%/);
  });
});

describe('DASH-10 — התווית מנקבת את הקבוצה שהיא סופרת', () => {
  it('שורת הזיכויים אינה קוראת לזיכוי שהמוצר צובע כ"התקבל" פתוח', async () => {
    renderDashboard();
    await bandIsUp();
    // `0218`'s `credit_metrics` counts `status in ('open','requested','received')` — and `received`
    // is painted `done` by status.ts, badge text התקבל. The population is not wrong; the word
    // over it is. What all three states share is that nothing has been offset yet.
    const row = await screen.findByText(/זיכויים שטרם קוזזו/);
    expect(row).toBeInTheDocument();
    expect(screen.queryByText('זיכויים פתוחים')).toBeNull();
  });
});

describe('DASH-13 — בחירת המטבע שורדת רענון', () => {
  it('הבחירה נכתבת ל-URL ולכן ניתנת לשיתוף, לסימניה ולרענון', async () => {
    renderDashboard();
    await bandIsUp();

    await userEvent.click(screen.getByTestId('dashboard-currency-USD'));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toContain('currency=USD'));
  });

  it('טעינה עם ?currency=USD פותחת את המסך בדולר, לא בשקל', async () => {
    renderDashboard('/dashboard?currency=USD');
    // The dollar figure, not the shekel one: a reload that lands on the base currency is exactly
    // the defect — same layout, same labels, different money.
    await bandIsUp();
    await waitFor(() => expect(document.body.textContent).toContain(fmtMoneyRounded(300, 'USD')));
    expect(document.body.textContent).not.toContain(fmtMoneyRounded(11582, 'ILS'));
  });
});
