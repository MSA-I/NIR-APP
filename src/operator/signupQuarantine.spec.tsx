import { render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui';
import { createAppQueryClient } from '../lib/query/client';
import SignupQuarantine from './SignupQuarantine';
import type {
  AbandonedSignupCandidate, PlatformCapability, QuarantineEntry,
} from '../lib/platform';

const fetchMyCapabilities = vi.fn<() => Promise<PlatformCapability[]>>();
const fetchAbandonedSignupCandidates = vi.fn<() => Promise<AbandonedSignupCandidate[]>>();
const fetchQuarantineQueue = vi.fn<() => Promise<QuarantineEntry[]>>();

vi.mock('../lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/platform')>()),
  fetchMyCapabilities: () => fetchMyCapabilities(),
  fetchAbandonedSignupCandidates: () => fetchAbandonedSignupCandidates(),
  fetchQuarantineQueue: () => fetchQuarantineQueue(),
}));

const candidate = (over: Partial<AbandonedSignupCandidate> = {}): AbandonedSignupCandidate => ({
  org_id: '75000000-0000-4000-8000-000000000011',
  organization_name: 'ארגון ריק',
  created_at: '2026-07-01T08:00:00.000Z',
  days_since_signup: 53,
  owner_verified: false,
  has_activity: false,
  disposition: 'empty_cleanup_eligible',
  quarantined: false,
  reminders_pending: 0,
  reminders_not_sent: 2,
  ...over,
});

const renderScreen = () => render(
  <QueryClientProvider client={createAppQueryClient()}>
    <ToastProvider><SignupQuarantine /></ToastProvider>
  </QueryClientProvider>,
);

beforeEach(() => {
  fetchMyCapabilities.mockResolvedValue(['customer.view', 'customer.edit']);
  fetchAbandonedSignupCandidates.mockResolvedValue([candidate()]);
  fetchQuarantineQueue.mockResolvedValue([]);
});

describe('מסך ההרשמות שלא אושרו', () => {
  it('מבדילה בין «אין הרשאה» ל«אין נתונים»', async () => {
    fetchMyCapabilities.mockResolvedValue([]);
    renderScreen();
    expect(await screen.findByText(/הרשאת צפייה בלקוחות/)).toBeInTheDocument();
  });

  it('מפרידה בין ארגון ריק לארגון עם פעילות, ואינה מציעה מחיקה לאף אחד מהם', async () => {
    // #175: an empty organization is removed by a server-only command with no browser grant, and
    // an organization with activity is never removed automatically. Neither has a button here,
    // and a delete button on this screen would be the finding.
    fetchAbandonedSignupCandidates.mockResolvedValue([
      candidate(),
      candidate({
        org_id: '75000000-0000-4000-8000-000000000012',
        organization_name: 'ארגון עם פעילות',
        has_activity: true,
        disposition: 'quarantine_required',
      }),
    ]);
    renderScreen();

    expect(await screen.findByText('ארגון ריק')).toBeInTheDocument();
    expect(screen.getByText(/פעילות עסקית — בידוד/)).toBeInTheDocument();
    expect(screen.getByText(/ריק — מועמד לניקוי/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /מחיקה/ })).not.toBeInTheDocument();
  });

  it('אומרת שהתזכורות אינן נשלחות, במקום להציג מונה שליחות מזויף', async () => {
    // #236: no email provider is configured. A "sent" counter here would be a number nobody can
    // produce honestly, so the screen states the refusal instead.
    renderScreen();
    expect(await screen.findByText(/אין ספק מייל מוגדר/)).toBeInTheDocument();
    expect(screen.getByText('תזכורות שלא נשלחו')).toBeInTheDocument();
    expect(screen.queryByText('תזכורות שנשלחו')).not.toBeInTheDocument();
  });

  it('מציגה פעולות בידוד רק למי שמחזיק הרשאת עריכת לקוח', async () => {
    fetchMyCapabilities.mockResolvedValue(['customer.view']);
    fetchQuarantineQueue.mockResolvedValue([{
      id: '78000000-0000-4000-8000-000000000001',
      org_id: '75000000-0000-4000-8000-000000000012',
      organization_name: 'ארגון בבידוד',
      reason_code: 'abandoned_signup_with_activity',
      opened_at: '2026-08-20T08:00:00.000Z',
      resolved_at: null,
      resolution: null,
    }]);
    renderScreen();

    expect(await screen.findByText('ארגון בבידוד')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'שחרור' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'הסלמה' })).not.toBeInTheDocument();
  });
});
