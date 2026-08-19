import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui';
import { createAppQueryClient } from '../lib/query/client';
import Customers from './Customers';
import type { PlatformCapability, PlatformCustomer } from '../lib/platform';

const fetchMyCapabilities = vi.fn<() => Promise<PlatformCapability[]>>();
const fetchPlatformCustomers = vi.fn();

// ReauthModal reads the session even while closed, and this screen renders it unconditionally.
// The console's real auth shell is not what these tests are about, so the hook is stubbed rather
// than the whole provider tree stood up.
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ session: null }) }));

vi.mock('../lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/platform')>()),
  fetchMyCapabilities: () => fetchMyCapabilities(),
  fetchPlatformCustomers: (request: unknown) => fetchPlatformCustomers(request),
}));

const customer = (over: Partial<PlatformCustomer> = {}): PlatformCustomer => ({
  id: '49000000-0000-4000-8000-000000000001',
  name: 'מסעדת הגפן',
  status: 'active',
  vat_rate: 18,
  created_at: '2026-01-04T08:00:00.000Z',
  active_user_count: 3,
  last_activity_at: '2026-08-18T09:30:00.000Z',
  offboarding_status: null,
  total_count: 1,
  ...over,
});

// useQuery calls both its cached and legacy hooks unconditionally to keep React's hook order
// stable, so a QueryClientProvider is required even for a legacy (uncached) call site.
const renderScreen = () => render(
  <QueryClientProvider client={createAppQueryClient()}>
    <MemoryRouter>
      <ToastProvider><Customers /></ToastProvider>
    </MemoryRouter>
  </QueryClientProvider>,
);

beforeEach(() => {
  fetchMyCapabilities.mockResolvedValue(['customer.view', 'org.lifecycle']);
  fetchPlatformCustomers.mockResolvedValue({ rows: [customer()], total: 1 });
});

describe('רשימת הלקוחות של מסוף התפעול', () => {
  it('מבדילה בין «אין הרשאה» ל«אין נתונים» כשחסרה הרשאת צפייה בלקוחות', async () => {
    // platform_customers() answers an unauthorised operator with zero rows, so an empty-state
    // table here would tell the operator the platform has no customers. It must say why instead.
    fetchMyCapabilities.mockResolvedValue([]);
    fetchPlatformCustomers.mockResolvedValue({ rows: [], total: 0 });
    renderScreen();

    expect(await screen.findByText(/הרשאת צפייה בלקוחות/)).toBeInTheDocument();
    expect(screen.queryByText('אין לקוחות')).not.toBeInTheDocument();
  });

  it('מציגה מקף ללקוח שמעולם לא פעל, לא תאריך ולא אפס', async () => {
    fetchPlatformCustomers.mockResolvedValue({
      rows: [customer({ name: 'לקוח ללא פעילות', last_activity_at: null, active_user_count: 0 })],
      total: 1,
    });
    renderScreen();

    await screen.findAllByText('לקוח ללא פעילות');
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('מסתירה פעולת מחזור חיים ממפעיל שאין לו הרשאה לכך', async () => {
    fetchMyCapabilities.mockResolvedValue(['customer.view']);
    renderScreen();

    await screen.findAllByText('מסעדת הגפן');
    expect(screen.queryByRole('menuitem', { name: /השהיית הארגון/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /השהיית הארגון/ })).not.toBeInTheDocument();
  });

  it('מבקשת מהשרת את העמוד ואת המסננים, ולא מסננת עמוד יחיד בדפדפן', async () => {
    renderScreen();
    await screen.findAllByText('מסעדת הגפן');

    expect(fetchPlatformCustomers).toHaveBeenCalledWith(
      expect.objectContaining({ page: 0, pageSize: 25, attention: null, status: [] }),
    );
  });
});
