import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui';
import { createAppQueryClient } from '../lib/query/client';
import Customers from './Customers';
import type {
  LifecycleReasonCode, PlatformCapability, PlatformCustomer,
} from '../lib/platform';

const fetchMyCapabilities = vi.fn<() => Promise<PlatformCapability[]>>();
const fetchPlatformCustomers = vi.fn();
const fetchLifecycleReasonCodes = vi.fn<() => Promise<LifecycleReasonCode[]>>();
const setOrganizationLifecycle = vi.fn();

// ReauthModal reads the session even while closed, and this screen renders it unconditionally.
// The console's real auth shell is not what these tests are about, so the hook is stubbed rather
// than the whole provider tree stood up.
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ session: null }) }));

vi.mock('../lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/platform')>()),
  fetchMyCapabilities: () => fetchMyCapabilities(),
  fetchPlatformCustomers: (request: unknown) => fetchPlatformCustomers(request),
  fetchLifecycleReasonCodes: () => fetchLifecycleReasonCodes(),
  setOrganizationLifecycle: (input: unknown) => setOrganizationLifecycle(input),
}));

// The step-up modal is a separate, owned surface; these tests are about which field the
// operator's text lands in, so it is stubbed down to an immediate confirm.
vi.mock('../components/ReauthModal', () => ({
  ReauthModal: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) =>
    (open ? <button type="button" onClick={onConfirm}>אישור אימות</button> : null),
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
/** Row actions live behind the table's action menu, so the menu is opened first. */
const openSuspend = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click((await screen.findAllByRole('button', { name: /פעולות עבור/ }))[0]);
  await user.click(await screen.findByRole('menuitem', { name: /השהיית הארגון/ }));
};

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
  fetchLifecycleReasonCodes.mockResolvedValue([
    { reason_code: 'organization_suspended', applies_to_status: 'suspended',
      tenant_label: 'הגישה לארגון הושהתה' },
    { reason_code: 'organization_reactivated', applies_to_status: 'active',
      tenant_label: 'הארגון הופעל מחדש' },
  ]);
  setOrganizationLifecycle.mockReset();
  setOrganizationLifecycle.mockResolvedValue(undefined);
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

  // #20. The screen is not the security boundary -- 0195 is -- but an operator who cannot tell
  // the two boxes apart will put the commercial note in the tenant-readable one, and then the
  // boundary never gets a chance to help.
  it('שולחת את ההערה הפנימית בשדה נפרד ולא בסיבה שהדייר קורא', async () => {
    const user = userEvent.setup();
    renderScreen();
    await screen.findAllByText('מסעדת הגפן');

    await openSuspend(user);

    const publicBox = await screen.findByLabelText('סיבה גלויה לדייר');
    const internalBox = await screen.findByLabelText(/הערה פנימית/);
    await user.type(publicBox, 'התשלום לא הוסדר');
    await user.type(internalBox, 'unpaid bill 4417 - do not extend credit');

    await user.click(screen.getByRole('button', { name: 'השהיה' }));
    await user.click(await screen.findByRole('button', { name: 'אישור אימות' }));

    expect(setOrganizationLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      status: 'suspended',
      publicReason: 'התשלום לא הוסדר',
      publicReasonCode: 'organization_suspended',
      internalNote: 'unpaid bill 4417 - do not extend credit',
    }));
    const [call] = setOrganizationLifecycle.mock.calls as [[{ publicReason: string }]];
    expect(call[0].publicReason).not.toContain('do not extend credit');
  });

  it('אומרת במפורש מי קורא כל שדה, כדי שהמפעיל לא יחליף ביניהם', async () => {
    const user = userEvent.setup();
    renderScreen();
    await screen.findAllByText('מסעדת הגפן');
    await openSuspend(user);

    expect(await screen.findByText(/בעל הארגון ורואה החשבון שלו יכולים לקרוא/))
      .toBeInTheDocument();
    expect(screen.getByText(/לא נכנסת ליומן של הדייר/)).toBeInTheDocument();
  });

  it('דורשת אימות סיסמה גם בהשהיה, לא רק בהפעלה מחדש', async () => {
    // 0134:176 added assert_recent_password_authentication to BOTH directions. Asking only on
    // the way back left the operator with a step-up error they had no way to answer.
    const user = userEvent.setup();
    renderScreen();
    await screen.findAllByText('מסעדת הגפן');
    await openSuspend(user);
    await user.click(await screen.findByRole('button', { name: 'השהיה' }));

    expect(await screen.findByRole('button', { name: 'אישור אימות' })).toBeInTheDocument();
    expect(setOrganizationLifecycle).not.toHaveBeenCalled();
  });

  it('מבקשת מהשרת את העמוד ואת המסננים, ולא מסננת עמוד יחיד בדפדפן', async () => {
    renderScreen();
    await screen.findAllByText('מסעדת הגפן');

    expect(fetchPlatformCustomers).toHaveBeenCalledWith(
      expect.objectContaining({ page: 0, pageSize: 25, attention: null, status: [] }),
    );
  });
});
