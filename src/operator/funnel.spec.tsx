import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui';
import { createAppQueryClient } from '../lib/query/client';
import Funnel from './Funnel';
import type { BillingDeadLetter, FunnelMetric, PlatformCapability } from '../lib/platform';

const fetchMyCapabilities = vi.fn<() => Promise<PlatformCapability[]>>();
const fetchFunnelMetrics = vi.fn();
const fetchBillingDeadLetters = vi.fn();

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ session: null }) }));
vi.mock('../lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/platform')>()),
  fetchMyCapabilities: () => fetchMyCapabilities(),
  fetchFunnelMetrics: (days: number) => fetchFunnelMetrics(days),
  fetchBillingDeadLetters: () => fetchBillingDeadLetters(),
}));

const metric = (over: Partial<FunnelMetric> = {}): FunnelMetric => ({
  metric_key: 'organizations_created',
  label: 'ארגונים חדשים בתקופה',
  value: 12,
  measured: true,
  note: null,
  ...over,
});

const deadLetter: BillingDeadLetter = {
  id: 'dl-1',
  provider: 'manual',
  event_type: 'invoice.paid',
  provider_customer_id: 'cus_unknown',
  dead_letter_reason: 'no organization is linked to this provider customer id',
  received_at: '2026-08-19T12:00:00.000Z',
};

const renderScreen = () => render(
  <QueryClientProvider client={createAppQueryClient()}>
    <MemoryRouter><ToastProvider><Funnel /></ToastProvider></MemoryRouter>
  </QueryClientProvider>,
);

beforeEach(() => {
  fetchMyCapabilities.mockResolvedValue(['usage.view', 'billing.view']);
  fetchFunnelMetrics.mockResolvedValue([metric()]);
  fetchBillingDeadLetters.mockResolvedValue([]);
});

describe('משפך ההצטרפות', () => {
  it('מציג שלב שאינו נמדד עם ההסבר, ולא כאפס', async () => {
    fetchFunnelMetrics.mockResolvedValue([
      metric(),
      metric({
        metric_key: 'checkout_started', label: 'התחלות תשלום',
        value: null, measured: false, note: 'אין מסלול תשלום במערכת',
      }),
    ]);
    renderScreen();

    expect(await screen.findByText('שלבים שאינם נמדדים')).toBeInTheDocument();
    expect(screen.getByText('אין מסלול תשלום במערכת')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('אינו מציג תור אירועים לא-משויכים כשאין כאלה', async () => {
    renderScreen();
    await screen.findByRole('heading', { level: 1, name: /משפך ההצטרפות/ });
    expect(screen.queryByText(/שלא שויכו ללקוח/)).not.toBeInTheDocument();
  });

  it('מציג את תור האירועים הלא-משויכים מעל המדדים, עם הסיבה', async () => {
    // An unattributable money event is a work queue, not a statistic, so it sits above the
    // numbers — and only on a day that has one.
    fetchBillingDeadLetters.mockResolvedValue([deadLetter]);
    renderScreen();

    expect(await screen.findByText(/שלא שויכו ללקוח/)).toBeInTheDocument();
    expect(screen.getByText(/no organization is linked/)).toBeInTheDocument();
    expect(screen.getByText(/לא בוצעה בהם שום פעולה/)).toBeInTheDocument();
  });

  it('אינו מציג את המשפך למפעיל ללא הרשאת צפייה בשימוש', async () => {
    fetchMyCapabilities.mockResolvedValue(['customer.view']);
    renderScreen();
    expect(await screen.findByText(/הרשאת צפייה בשימוש/)).toBeInTheDocument();
    expect(screen.queryByText('מדדים')).not.toBeInTheDocument();
  });

  it('אינו קורא את תור החיוב למפעיל ללא הרשאת צפייה בחיוב', async () => {
    fetchMyCapabilities.mockResolvedValue(['usage.view']);
    renderScreen();
    await screen.findByRole('heading', { level: 1, name: /משפך ההצטרפות/ });
    expect(fetchBillingDeadLetters).not.toHaveBeenCalled();
  });
});
