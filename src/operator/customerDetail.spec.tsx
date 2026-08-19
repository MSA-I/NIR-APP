import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui';
import { createAppQueryClient } from '../lib/query/client';
import CustomerDetail from './CustomerDetail';
import type {
  CustomerContact, CustomerDetail as Detail, CustomerNote, PlatformCapability,
} from '../lib/platform';

const fetchMyCapabilities = vi.fn<() => Promise<PlatformCapability[]>>();
const fetchCustomerDetail = vi.fn();
const fetchCustomerContacts = vi.fn();
const fetchCustomerNotes = vi.fn();
const fetchCustomerTimeline = vi.fn();
const fetchPlatformOperators = vi.fn();
const fetchCustomerOnboarding = vi.fn();
const fetchCustomerHealth = vi.fn();

vi.mock('../lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/platform')>()),
  fetchMyCapabilities: () => fetchMyCapabilities(),
  fetchCustomerDetail: () => fetchCustomerDetail(),
  fetchCustomerContacts: () => fetchCustomerContacts(),
  fetchCustomerNotes: () => fetchCustomerNotes(),
  fetchCustomerTimeline: () => fetchCustomerTimeline(),
  fetchPlatformOperators: () => fetchPlatformOperators(),
  fetchCustomerOnboarding: () => fetchCustomerOnboarding(),
  fetchCustomerHealth: () => fetchCustomerHealth(),
}));

const detail = (over: Partial<Detail> = {}): Detail => ({
  org_id: '50000000-0000-4000-8000-000000000001',
  name: 'מסעדת הגפן',
  status: 'active',
  vat_rate: 18,
  created_at: '2026-01-04T08:00:00.000Z',
  access_mode: 'active',
  active_user_count: 4,
  last_activity_at: '2026-08-18T09:30:00.000Z',
  internal_owner: null,
  internal_owner_email: null,
  customer_since: null,
  open_follow_up_count: 0,
  offboarding_status: null,
  ...over,
});

const note = (over: Partial<CustomerNote> = {}): CustomerNote => ({
  id: 'note-1',
  kind: 'support',
  body: 'הלקוח דיווח על איטיות בקליטת מחירונים.',
  author_email: 'support@inplace.test',
  created_at: '2026-08-18T10:00:00.000Z',
  follow_up_due_at: null,
  resolved_at: null,
  resolved_by_email: null,
  resolution: null,
  total_count: 1,
  ...over,
});

const contact: CustomerContact = {
  id: 'contact-1',
  kind: 'billing',
  name: 'רות כהן',
  title: 'הנהלת חשבונות',
  email: 'billing@example.test',
  phone: null,
  preferred_channel: 'email',
  updated_at: '2026-08-18T10:00:00.000Z',
};

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ session: null }) }));

const renderScreen = () => render(
  <QueryClientProvider client={createAppQueryClient()}>
    <MemoryRouter initialEntries={['/admin/customers/50000000-0000-4000-8000-000000000001']}>
      <ToastProvider>
        <Routes>
          <Route path="/admin/customers/:orgId" element={<CustomerDetail />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>
  </QueryClientProvider>,
);

beforeEach(() => {
  fetchMyCapabilities.mockResolvedValue(['customer.view', 'customer.edit', 'notes.view', 'notes.add']);
  fetchCustomerDetail.mockResolvedValue(detail());
  fetchCustomerContacts.mockResolvedValue([contact]);
  fetchCustomerNotes.mockResolvedValue([note()]);
  fetchCustomerTimeline.mockResolvedValue([]);
  fetchPlatformOperators.mockResolvedValue([{ user_id: 'op-1', email: 'ops@inplace.test', note: null, roles: ['customer_ops'] }]);
  fetchCustomerOnboarding.mockResolvedValue([]);
  fetchCustomerHealth.mockResolvedValue(null);
});

describe('כרטיס הלקוח של מסוף התפעול', () => {
  it('אומר במפורש מה עדיין אינו נמדד, במקום להציג אפס', async () => {
    renderScreen();
    await screen.findByRole('heading', { level: 1, name: /מסעדת הגפן/ });

    // The card names its own blind spot rather than leaving an empty panel that reads like a
    // measurement returning nothing. The sentence moved as waves landed; the claim did not.
    expect(screen.getByText(/אינן ניתנות למדידה/)).toBeInTheDocument();
    // A customer with no start date recorded shows a dash, not today's date and not a zero.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('אינו מציג הערות פנימיות למפעיל שאין לו הרשאת צפייה בהן', async () => {
    fetchMyCapabilities.mockResolvedValue(['customer.view']);
    fetchCustomerNotes.mockResolvedValue([]);
    renderScreen();
    await screen.findByRole('heading', { level: 1, name: /מסעדת הגפן/ });

    expect(screen.queryByRole('heading', { name: 'הערות פנימיות' })).not.toBeInTheDocument();
    expect(screen.queryByText(/איטיות בקליטת מחירונים/)).not.toBeInTheDocument();
  });

  it('מסתיר עריכת פרטי חשבון ואנשי קשר ממפעיל ללא הרשאת עריכה', async () => {
    fetchMyCapabilities.mockResolvedValue(['customer.view', 'notes.view']);
    renderScreen();
    await screen.findByRole('heading', { level: 1, name: /מסעדת הגפן/ });

    expect(screen.queryByRole('button', { name: /עריכת פרטי החשבון/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /הסרה/ })).not.toBeInTheDocument();
  });

  it('מתריע על משימות מעקב פתוחות', async () => {
    fetchCustomerDetail.mockResolvedValue(detail({ open_follow_up_count: 2 }));
    fetchCustomerNotes.mockResolvedValue([
      note({ id: 'note-2', kind: 'follow_up', body: 'לחזור ללקוח.', follow_up_due_at: '2026-08-25T00:00:00.000Z' }),
    ]);
    renderScreen();

    expect(await screen.findByText(/משימות מעקב פתוחות/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'סגירת המעקב' })).toBeInTheDocument();
  });

  it('אינו מציג את כרטיס הלקוח כלל למפעיל ללא הרשאת צפייה', async () => {
    fetchMyCapabilities.mockResolvedValue([]);
    fetchCustomerDetail.mockResolvedValue(null);
    renderScreen();

    expect(await screen.findByText(/הרשאת צפייה בלקוחות/)).toBeInTheDocument();
    expect(screen.queryByText('מסעדת הגפן')).not.toBeInTheDocument();
  });
});
