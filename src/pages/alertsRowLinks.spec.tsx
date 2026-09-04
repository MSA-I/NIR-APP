/**
 * `DASH-12` — `/alerts` is the screen the manager is meant to WORK THROUGH, and its rows were
 * `<button onClick={navigate(...)}>`.
 *
 * A button is not a destination. Middle-click does nothing, ⌘/Ctrl-click does nothing, "open in
 * new tab" is absent from the context menu, and the status bar shows nowhere on hover — so the
 * queue can only be walked one item at a time, losing the page on every step. The dashboard's own
 * attention rows already made the opposite decision for rows pointing at the SAME routes, and
 * said so in `ui.tsx`: "Rows are real <Link>s, so keyboard focus, middle-click and open in new tab
 * all work because the dashboard is also a hub."
 *
 * THE ORACLE: every navigating row on `/alerts` is an anchor carrying the href it navigates to.
 * `href` is the whole of it — that single attribute is what the browser gives middle-click, the
 * context menu, the status bar and the modifier-click to.
 *
 * The feed rows below the scan are asserted too, and that is not scope creep: they are the same
 * defect in the same list on the same screen, and their destination is safe to put in an `href`
 * because the server refuses to write one that is not a same-origin path — `0024:82-84`,
 * `0068:255-257` and the `0068` push twin all reject a `target_url` that is empty, does not begin
 * with `/`, or begins with `//`.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { ToastProvider } from '../components/ui';
import type { Summary } from '../lib/summary';
import type { NotificationRow } from '../lib/notifications';

vi.mock('../lib/supabase', () => ({ supabase: {} }));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'u-1', role: 'owner', full_name: 'בודק', org_id: 'org-1' },
    org: { settings: {}, base_currency: 'ILS' },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

/** The four rows the sweep found, with the three routes it named. */
const SUMMARY: Summary = {
  lines: [],
  complete: true,
  failures: [],
  generatedAt: new Date('2026-09-04T02:00:00Z'),
  alerts: [
    {
      code: 'inv-pending', severity: 'warning', to: '/invoices?review=pending_approval',
      title: { key: 'alerts.severityWarning', vars: {} }, detail: { key: 'alerts.severityWarning', vars: {} },
    },
    {
      code: 'pr-overdue', severity: 'critical', to: '/payment-requests?due=overdue',
      title: { key: 'alerts.severityCritical', vars: {} }, detail: { key: 'alerts.severityCritical', vars: {} },
    },
    {
      code: 'orders-late', severity: 'warning', to: '/orders?status=sent',
      title: { key: 'alerts.severityWarning', vars: {} }, detail: { key: 'alerts.severityWarning', vars: {} },
    },
    {
      code: 'prices-up', severity: 'info', to: '/prices?increases=1&days=30',
      title: { key: 'alerts.severityInfo', vars: {} }, detail: { key: 'alerts.severityInfo', vars: {} },
    },
  ],
} as unknown as Summary;

const FEED: NotificationRow[] = [
  {
    id: 'n-1', org_id: 'org-1', user_id: 'u-1', event_code: 'price_up', entity_key: 'sp-1',
    severity: 'info', title: 'עליית מחיר אצל ספק', body: 'מחיר אחד עודכן כלפי מעלה במחירון',
    target_url: '/prices?increases=1', created_at: '2026-09-04T00:40:00Z', read_at: null,
  } as unknown as NotificationRow,
];

vi.mock('../lib/summary', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/summary')>()),
  buildSummary: () => Promise.resolve(SUMMARY),
}));

vi.mock('../lib/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/notifications')>()),
  readNotifications: () => Promise.resolve(FEED),
  markAllNotificationsRead: () => Promise.resolve(),
}));

vi.mock('../components/PushSettings', () => ({ PushSection: () => null }));

import Alerts from './Alerts';

beforeAll(() => {
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = ((query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
});

function renderAlerts() {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-1">
        <ToastProvider><MemoryRouter>{children}</MemoryRouter></ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>
  );
  render(<Alerts />, { wrapper: Wrapper });
}

/** A row is anything in one of the two lists that carries the row layout. */
const rows = () => [...document.querySelectorAll<HTMLElement>('.row-hover')];

describe('DASH-12 — שורות /alerts הן קישורים אמיתיים', () => {
  it('ארבע שורות הסריקה נושאות href לכתובת שהן פותחות', async () => {
    renderAlerts();
    await screen.findByText('דורש טיפול');

    expect(rows().length).toBeGreaterThanOrEqual(4);

    const hrefs = rows().map((el) => el.getAttribute('href'));
    // Every one of them. A single button among four anchors is still a row that cannot be opened
    // in a tab, and it is the row the reader happens to want.
    expect(hrefs.filter((href) => href == null)).toEqual([]);
    expect(hrefs).toEqual(expect.arrayContaining([
      '/invoices?review=pending_approval',
      '/payment-requests?due=overdue',
      '/orders?status=sent',
      '/prices?increases=1&days=30',
    ]));
  });

  it('אין שורת ניווט שהיא <button> — כפתור אינו יעד', async () => {
    renderAlerts();
    await screen.findByText('דורש טיפול');
    expect(rows().map((el) => el.tagName)).toEqual(rows().map(() => 'A'));
  });

  it('גם שורות הפיד מובילות דרך href — אותה רשימה, אותו מסך', async () => {
    renderAlerts();
    await screen.findByText('עליית מחיר אצל ספק');
    const feedRow = rows().find((el) => el.textContent?.includes('עליית מחיר אצל ספק'));
    expect(feedRow).toBeDefined();
    expect(feedRow).toHaveAttribute('href', '/prices?increases=1');
  });
});
