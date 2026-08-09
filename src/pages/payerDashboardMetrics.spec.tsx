import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { addCalendarDays, fmtMoneyExact, todayISO } from '../lib/format';

/** Real supabase-js against the MSW base URL — the wire behaviour stays real. */
vi.mock('../lib/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const { SUPABASE_URL: url } = await import('../test/msw/handlers');
  return {
    supabase: createClient(url, 'test-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  };
});

import PayerDashboard from './dashboards/PayerDashboard';

const TODAY = todayISO();
const PENDING_TOTAL = 1000;

const queueRows = [
  { due_date: addCalendarDays(TODAY, -3), amount: 100 },
  { due_date: TODAY, amount: 200 },
  { due_date: addCalendarDays(TODAY, 2), amount: 300 },
  { due_date: null, amount: 400 },
];
const paymentRows = [{ amount: 500, paid_date: TODAY }];

/** Which metric a test wants to break. Every other metric answers normally. */
type Broken = 'none' | 'counts' | 'pending_total' | 'due_amounts' | 'executed_payments';

const failure = (message: string) => HttpResponse.json(
  { message, code: 'PGRST000', details: null, hint: null }, { status: 500 },
);

/**
 * The six independent reads this screen makes, as six independently breakable endpoints.
 *
 * The three counts are `HEAD` requests whose totals arrive in `content-range` — the same protocol
 * `readExactCount` reads, which is why a missing header would surface as `count_unavailable` rather
 * than as a zero.
 */
function usePayerMetrics(broken: Broken = 'none') {
  const requests: string[] = [];
  server.use(
    http.head(`${SUPABASE_URL}/rest/v1/payment_requests`, ({ request }) => {
      const url = new URL(request.url);
      requests.push(`HEAD payment_requests ${url.searchParams.get('due_date') ?? 'all'}`);
      if (broken === 'counts') return failure('count read refused');
      const dueDate = url.searchParams.get('due_date');
      const total = dueDate === `lt.${TODAY}` ? 1 : dueDate === `eq.${TODAY}` ? 1 : queueRows.length;
      return new HttpResponse(null, { status: 200, headers: { 'content-range': `*/${total}` } });
    }),
    http.get(`${SUPABASE_URL}/rest/v1/payment_requests`, () => {
      requests.push('GET payment_requests');
      if (broken === 'due_amounts') return failure('queue row read refused');
      return HttpResponse.json(queueRows);
    }),
    http.get(`${SUPABASE_URL}/rest/v1/payments`, () => {
      requests.push('GET payments');
      if (broken === 'executed_payments') return failure('payment row read refused');
      return HttpResponse.json(paymentRows);
    }),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/p2_active_payment_request_total`, () => {
      requests.push('RPC p2_active_payment_request_total');
      if (broken === 'pending_total') return failure('aggregate refused');
      return HttpResponse.json(PENDING_TOTAL);
    }),
  );
  return requests;
}

function renderDashboard() {
  return render(
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-test">
        <MemoryRouter><PayerDashboard /></MemoryRouter>
      </OrgScopeProvider>
    </QueryClientProvider>,
  );
}

const scorecard = () => screen.getByText('לביצוע היום').closest('.card') as HTMLElement;
/** Scorecard tile anatomy: label div, then the value div (supplier-metrics.tsx:70-75). */
const tile = (label: string) =>
  within(scorecard()).getByText(label).nextElementSibling?.textContent?.trim() ?? '';
/** AttentionZone row anatomy: the count badge is the row link's first span (ui.tsx:199-210). */
const attentionCount = (label: string) => screen.getByText(label)
  .closest('a')?.querySelector('span')?.textContent?.trim() ?? '';

const ready = () => screen.findByRole('heading', { name: 'מרכז הבקרה — ביצוע העברות' });
const partialNote = () => screen.queryByRole('alert')?.textContent ?? '';

beforeAll(() => {
  // charts.tsx:25 reads matchMedia unguarded, and recharts measures with ResizeObserver. Neither
  // exists in jsdom; both are inert stubs here because this suite asserts figures, not pixels.
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as never;
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});

describe('PayerDashboard — six settled metrics, no fabricated zero (PLAN-10 §3)', () => {
  it('reads each metric with its own narrow call and reports a complete picture', async () => {
    const requests = usePayerMetrics();
    renderDashboard();
    await ready();

    await waitFor(() => expect(tile('סה״כ ממתין לביצוע')).toBe(fmtMoneyExact(PENDING_TOTAL)));
    // The counts are HEAD reads — one per decision, plus the server sum. No row body pays for them.
    expect(requests.filter((entry) => entry.startsWith('HEAD'))).toEqual([
      `HEAD payment_requests lt.${TODAY}`,
      `HEAD payment_requests eq.${TODAY}`,
      'HEAD payment_requests all',
    ]);
    expect(requests).toContain('RPC p2_active_payment_request_total');

    expect(tile('באיחור')).toBe(fmtMoneyExact(100));
    expect(tile('לביצוע היום')).toBe(fmtMoneyExact(200));
    expect(tile('בוצע החודש')).toBe(fmtMoneyExact(500));
    expect(attentionCount('תשלומים באיחור')).toBe('1');
    expect(attentionCount('תשלומים לביצוע היום')).toBe('1');
    expect(attentionCount('ממתינים לביצוע העברה')).toBe(String(queueRows.length));
    expect(partialNote()).toBe('');
  });

  it('keeps the counts and the server sum when the per-bucket amount read fails', async () => {
    usePayerMetrics('due_amounts');
    renderDashboard();
    await ready();

    // The metric that failed is named, and the note says what a dash means.
    await waitFor(() => expect(partialNote()).toContain('סכומי ההעברות לפי מועד'));
    expect(partialNote()).toContain('ולא באפס');

    // The amounts that came from those rows are dashes — never ₪0, which would claim nothing is due.
    expect(tile('באיחור')).toBe('—');
    expect(tile('לביצוע היום')).toBe('—');
    // Everything measured by another call survives: the decision counts, the sum, the month.
    expect(attentionCount('תשלומים באיחור')).toBe('1');
    expect(attentionCount('תשלומים לביצוע היום')).toBe('1');
    expect(tile('סה״כ ממתין לביצוע')).toBe(fmtMoneyExact(PENDING_TOTAL));
    expect(tile('בוצע החודש')).toBe(fmtMoneyExact(500));
    // An empty chart must not claim "no transfers waiting" when the truth is "not loaded".
    expect(screen.getByText('לא ניתן לטעון את סכומי ההמתנה')).toBeInTheDocument();
    expect(screen.queryByText('אין העברות ממתינות')).toBeNull();
  });

  it('dashes the waiting total when its aggregate RPC fails, and keeps the rest', async () => {
    usePayerMetrics('pending_total');
    renderDashboard();
    await ready();

    await waitFor(() => expect(partialNote()).toContain('סך ההעברות הממתינות'));
    expect(tile('סה״כ ממתין לביצוע')).toBe('—');
    expect(tile('באיחור')).toBe(fmtMoneyExact(100));
    expect(tile('לביצוע היום')).toBe(fmtMoneyExact(200));
    expect(attentionCount('ממתינים לביצוע העברה')).toBe(String(queueRows.length));
  });

  it('shows an unmeasured count as — so a failed read can never read as an all-clear', async () => {
    usePayerMetrics('counts');
    renderDashboard();
    await ready();

    await waitFor(() => expect(partialNote()).toContain('מספר התשלומים באיחור'));
    expect(partialNote()).toContain('מספר התשלומים לביצוע היום');
    expect(partialNote()).toContain('מספר ההעברות הממתינות');
    expect(attentionCount('תשלומים באיחור')).toBe('—');
    expect(attentionCount('ממתינים לביצוע העברה')).toBe('—');
    // The clear phrasing belongs to a measured zero only; it must not appear for an unknown.
    expect(screen.queryByText('אין תשלומים באיחור')).toBeNull();
    // The amounts came from a different read and are still on screen.
    expect(tile('באיחור')).toBe(fmtMoneyExact(100));
  });

  it('keeps the waiting queue when the executed-payment read fails', async () => {
    usePayerMetrics('executed_payments');
    renderDashboard();
    await ready();

    await waitFor(() => expect(partialNote()).toContain('ההעברות שבוצעו'));
    expect(tile('בוצע החודש')).toBe('—');
    expect(tile('סה״כ ממתין לביצוע')).toBe(fmtMoneyExact(PENDING_TOTAL));
    expect(screen.getByText('לא ניתן לטעון את ההעברות שבוצעו')).toBeInTheDocument();
    expect(screen.queryByText('לא בוצעו העברות בתקופה')).toBeNull();
  });
});
