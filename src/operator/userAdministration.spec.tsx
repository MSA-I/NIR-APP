import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui';
import { createAppQueryClient } from '../lib/query/client';
import Users from './Users';
import UserDetail from './UserDetail';
import Team from './Team';
import type {
  PlatformCapability, PlatformOperator, PlatformRole, PlatformUser, PlatformUserDetail,
} from '../lib/platform';

const fetchMyCapabilities = vi.fn<() => Promise<PlatformCapability[]>>();
const fetchPlatformUsers = vi.fn();
const fetchPlatformUserDetail = vi.fn();
const fetchPlatformUserEvents = vi.fn();
const fetchPlatformOperators = vi.fn<() => Promise<PlatformOperator[]>>();
const fetchPlatformRoles = vi.fn<() => Promise<PlatformRole[]>>();
const fetchOperatorEvents = vi.fn();
const fetchOperatorInvitations = vi.fn();

const ME = '79100000-0000-4000-8000-000000000004';

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ session: { user: { id: ME } } }) }));

vi.mock('../lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/platform')>()),
  fetchMyCapabilities: () => fetchMyCapabilities(),
  fetchPlatformUsers: (request: unknown) => fetchPlatformUsers(request),
  fetchPlatformUserDetail: (id: string) => fetchPlatformUserDetail(id),
  fetchPlatformUserEvents: (id: string) => fetchPlatformUserEvents(id),
  fetchPlatformOperators: () => fetchPlatformOperators(),
  fetchPlatformRoles: () => fetchPlatformRoles(),
  fetchOperatorEvents: () => fetchOperatorEvents(),
  fetchOperatorInvitations: () => fetchOperatorInvitations(),
}));

vi.mock('../components/ReauthModal', () => ({
  ReauthModal: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) =>
    (open ? <button type="button" onClick={onConfirm}>אישור אימות</button> : null),
}));

const user = (over: Partial<PlatformUser> = {}): PlatformUser => ({
  id: '79100000-0000-4000-8000-000000000002',
  org_id: '79000000-0000-4000-8000-000000000001',
  org_name: 'מסעדת הגפן',
  org_status: 'active',
  full_name: 'דנה כהן',
  email: 'dana@example.test',
  role: 'office',
  active: true,
  created_at: '2026-02-01T08:00:00.000Z',
  last_sign_in_at: '2026-08-20T09:00:00.000Z',
  is_operator: false,
  total_count: 1,
  ...over,
});

const detail = (over: Partial<PlatformUserDetail> = {}): PlatformUserDetail => ({
  id: '79100000-0000-4000-8000-000000000002',
  org_id: '79000000-0000-4000-8000-000000000001',
  org_name: 'מסעדת הגפן',
  org_status: 'active',
  full_name: 'דנה כהן',
  email: 'dana@example.test',
  phone: null,
  role: 'office',
  active: true,
  supplier_id: null,
  created_at: '2026-02-01T08:00:00.000Z',
  last_sign_in_at: '2026-08-20T09:00:00.000Z',
  email_confirmed: true,
  is_operator: false,
  operator_roles: [],
  org_owner_count: 2,
  ...over,
});

const shell = (ui: React.ReactNode, path = '/') => render(
  <QueryClientProvider client={createAppQueryClient()}>
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>{ui}</ToastProvider>
    </MemoryRouter>
  </QueryClientProvider>,
);

const detailShell = () => render(
  <QueryClientProvider client={createAppQueryClient()}>
    <MemoryRouter initialEntries={['/admin/users/79100000-0000-4000-8000-000000000002']}>
      <ToastProvider>
        <Routes>
          <Route path="/admin/users/:userId" element={<UserDetail />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>
  </QueryClientProvider>,
);

beforeEach(() => {
  vi.clearAllMocks();
  fetchPlatformUsers.mockResolvedValue({ rows: [user()], total: 1 });
  fetchPlatformUserDetail.mockResolvedValue(detail());
  fetchPlatformUserEvents.mockResolvedValue([]);
  fetchOperatorEvents.mockResolvedValue([]);
  fetchOperatorInvitations.mockResolvedValue([
    {
      id: 'inv-1', email: 'newcomer@inplace.test', role_key: 'support', role_label: 'תמיכה',
      status: 'pending', expires_at: '2026-08-28T10:15:00.000Z',
      created_at: '2026-08-28T10:00:00.000Z', invited_by: 'me@inplace.test',
    },
  ]);
  fetchPlatformRoles.mockResolvedValue([
    { role_key: 'support', label: 'תמיכה', description: 'קריאה ורישום פניות' },
    { role_key: 'super_admin', label: 'מנהל פלטפורמה ראשי', description: 'כל היכולות' },
  ]);
  fetchPlatformOperators.mockResolvedValue([
    { user_id: ME, email: 'me@inplace.test', note: 'אני', roles: ['super_admin'] },
    { user_id: 'other', email: 'colleague@inplace.test', note: null, roles: ['support'] },
  ]);
});

describe('the cross-tenant user directory', () => {
  it('tells an operator without user.view that this is a permission answer, not an empty platform', async () => {
    fetchMyCapabilities.mockResolvedValue(['customer.view']);
    shell(<Users />);
    expect(await screen.findByText(/פתוחה למפעילים בעלי הרשאת צפייה במשתמשים/)).toBeInTheDocument();
    expect(screen.queryByText('דנה כהן')).not.toBeInTheDocument();
  });

  it('lists users with their organization once user.view is held', async () => {
    fetchMyCapabilities.mockResolvedValue(['user.view']);
    shell(<Users />);
    // DataTable renders a table and a card list from the same rows, so a row's text is present
    // twice by design; the assertions are about presence, not about the count.
    expect(await screen.findAllByText('דנה כהן')).not.toHaveLength(0);
    expect(screen.getAllByText('מסעדת הגפן')).not.toHaveLength(0);
  });

  it('says an account was never used, rather than printing an empty date', async () => {
    fetchMyCapabilities.mockResolvedValue(['user.view']);
    fetchPlatformUsers.mockResolvedValue({ rows: [user({ last_sign_in_at: null })], total: 1 });
    shell(<Users />);
    expect(await screen.findAllByText('לא נכנס מעולם')).not.toHaveLength(0);
  });
});

describe('the user card', () => {
  it('offers no action at all to an operator holding only user.view', async () => {
    fetchMyCapabilities.mockResolvedValue(['user.view']);
    detailShell();
    expect(await screen.findByText(/שינוי גישה דורש הרשאת ניהול משתמשים/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /השהיית גישה/ })).not.toBeInTheDocument();
  });

  it('offers suspension once user.access is held', async () => {
    fetchMyCapabilities.mockResolvedValue(['user.view', 'user.access']);
    detailShell();
    expect(await screen.findByRole('button', { name: /השהיית גישה/ })).toBeEnabled();
  });

  it('refuses to suspend the last active owner, and says why before the attempt', async () => {
    fetchMyCapabilities.mockResolvedValue(['user.view', 'user.access']);
    fetchPlatformUserDetail.mockResolvedValue(detail({ role: 'owner', org_owner_count: 1 }));
    detailShell();
    expect(await screen.findByRole('button', { name: /השהיית גישה/ })).toBeDisabled();
    expect(screen.getByText(/הבעלים הפעיל היחיד בארגון/)).toBeInTheDocument();
  });

  it('will not restore an account that holds a retired persona', async () => {
    fetchMyCapabilities.mockResolvedValue(['user.view', 'user.access']);
    fetchPlatformUserDetail.mockResolvedValue(detail({ role: 'kitchen', active: false }));
    detailShell();
    expect(await screen.findByRole('button', { name: /החזרת גישה/ })).toBeDisabled();
    expect(screen.getByText(/תפקיד שפרש מהמוצר/)).toBeInTheDocument();
  });
});

describe('the operator roster', () => {
  it('is readable without operator.manage but offers no way to change it', async () => {
    fetchMyCapabilities.mockResolvedValue(['user.view']);
    shell(<Team />);
    expect(await screen.findAllByText('colleague@inplace.test')).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: /הזמנת מפעיל/ })).not.toBeInTheDocument();
    expect(screen.getByText(/שינוי הרכב הצוות שמור למנהל פלטפורמה ראשי/)).toBeInTheDocument();
  });

  it('states the self rule on your own row instead of offering buttons that would be refused', async () => {
    fetchMyCapabilities.mockResolvedValue(['user.view', 'operator.manage']);
    shell(<Team />);
    expect(await screen.findByRole('button', { name: /הזמנת מפעיל/ })).toBeInTheDocument();
    expect(screen.getAllByText('אי אפשר לשנות את ההרשאות של עצמך')).not.toHaveLength(0);
    // The colleague's row keeps its actions, so the absence above is about identity and not
    // about the capability.
    expect(screen.getAllByRole('button', { name: 'תפקידים' })).not.toHaveLength(0);
  });
});

describe('operator invitations', () => {
  it('offers no invitation door to an operator without operator.manage, and still shows the queue', async () => {
    fetchMyCapabilities.mockResolvedValue(['user.view']);
    shell(<Team />);
    expect(await screen.findAllByText('newcomer@inplace.test')).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: /הזמנת מפעיל/ })).not.toBeInTheDocument();
    // A pending invitation is roster information; cancelling one is authority.
    expect(screen.queryByRole('button', { name: 'ביטול' })).not.toBeInTheDocument();
  });

  it('separates the two doors: invite a person with no account, add one who already has one', async () => {
    fetchMyCapabilities.mockResolvedValue(['user.view', 'operator.manage']);
    shell(<Team />);
    expect(await screen.findByRole('button', { name: /הזמנת מפעיל/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /חשבון קיים/ })).toBeInTheDocument();
  });

  it('says an invitation is pending and offers to cancel it', async () => {
    fetchMyCapabilities.mockResolvedValue(['user.view', 'operator.manage']);
    shell(<Team />);
    expect(await screen.findAllByText('ממתינה')).not.toHaveLength(0);
    expect(screen.getAllByRole('button', { name: 'ביטול' })).not.toHaveLength(0);
  });

  it('reports an expired or spent invitation without an expiry date to read', async () => {
    fetchMyCapabilities.mockResolvedValue(['user.view', 'operator.manage']);
    fetchOperatorInvitations.mockResolvedValue([{
      id: 'inv-2', email: 'late@inplace.test', role_key: 'support', role_label: 'תמיכה',
      status: 'expired', expires_at: '2026-08-28T10:15:00.000Z',
      created_at: '2026-08-28T10:00:00.000Z', invited_by: 'me@inplace.test',
    }]);
    shell(<Team />);
    expect(await screen.findAllByText('פג תוקף')).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'ביטול' })).not.toBeInTheDocument();
  });
});
