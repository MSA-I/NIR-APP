import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui';
import { createAppQueryClient } from '../lib/query/client';
import CustomerDetail from './CustomerDetail';
import CustomerOnboarding from './CustomerOnboarding';
import CustomerSubscription from './CustomerSubscription';
import type {
  CustomerDetail as Detail, OnboardingStep, OrgEntitlement, OrgSubscription, PlatformCapability,
  SubscriptionPlan,
} from '../lib/platform';

/**
 * The operator console's reason boxes stopped blocking the button (owner ruling 11.08.2026), and
 * the risk of that change is not the missing gate — it is a blank string reaching a server command
 * that raises `reason_required`, turning a removed nag into a failed save. What has to hold is
 * narrower and testable: the button opens without a word typed, AND the RPC still receives a
 * non-blank sentence from `reasonOr`.
 *
 * Where a password step-up guards the action, the test also asserts that nothing reaches the RPC
 * before it — removing the typing gate must not have quietly removed the identity gate with it.
 */

/** Every command under test takes one object and always carries a `reason`; that is all the spy
    needs to know about the payload, and it keeps `mock.calls[0][0]` readable without casts. */
interface Command { reason: string; [field: string]: unknown }
const command = () => vi.fn<(input: Command) => Promise<unknown>>(() => Promise.resolve(null));

const setCustomerAccount = command();
const upsertCustomerContact = command();
const setOnboardingStep = command();
const setOrgSubscription = command();
const grantEntitlementOverride = command();

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
  setCustomerAccount: (input: Command) => setCustomerAccount(input),
  upsertCustomerContact: (input: Command) => upsertCustomerContact(input),
  setOnboardingStep: (input: Command) => setOnboardingStep(input),
  setOrgSubscription: (input: Command) => setOrgSubscription(input),
  grantEntitlementOverride: (input: Command) => grantEntitlementOverride(input),
}));

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ session: null }) }));

// The step-up itself is exercised by its own suite; here it stands in as an explicit button so the
// test can prove the RPC waits for it rather than firing when the modal's save is pressed.
vi.mock('../components/ReauthModal', () => ({
  ReauthModal: ({ open, onConfirm }: { open: boolean; onConfirm: (session: never) => void }) =>
    (open ? <button type="button" onClick={() => onConfirm(null as never)}>אישור זהות</button> : null),
}));

const ORG_ID = '50000000-0000-4000-8000-000000000001';

const detail = (): Detail => ({
  org_id: ORG_ID,
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
});

const renderCustomerDetail = () => render(
  <QueryClientProvider client={createAppQueryClient()}>
    <MemoryRouter initialEntries={[`/admin/customers/${ORG_ID}`]}>
      <ToastProvider>
        <Routes>
          <Route path="/admin/customers/:orgId" element={<CustomerDetail />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>
  </QueryClientProvider>,
);

beforeEach(() => {
  vi.clearAllMocks();
  fetchMyCapabilities.mockResolvedValue(['customer.view', 'customer.edit']);
  fetchCustomerDetail.mockResolvedValue(detail());
  fetchCustomerContacts.mockResolvedValue([]);
  fetchCustomerNotes.mockResolvedValue([]);
  fetchCustomerTimeline.mockResolvedValue([]);
  fetchPlatformOperators.mockResolvedValue([]);
  fetchCustomerOnboarding.mockResolvedValue([]);
  fetchCustomerHealth.mockResolvedValue(null);
});

describe('כרטיס הלקוח — סיבה שאינה חוסמת', () => {
  it('שומר פרטי חשבון בלי סיבה, ורושם ביומן משפט אמת במקום מחרוזת ריקה', async () => {
    const user = userEvent.setup();
    renderCustomerDetail();
    await screen.findByRole('heading', { level: 1, name: /מסעדת הגפן/ });

    await user.click(screen.getByRole('button', { name: /עריכת פרטי החשבון/ }));
    const save = screen.getByRole('button', { name: 'שמירה' });
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => expect(setCustomerAccount).toHaveBeenCalledTimes(1));
    const payload = setCustomerAccount.mock.calls[0][0];
    expect(payload.orgId).toBe(ORG_ID);
    expect(payload.reason).toContain('ללא הערה');
  });

  it('שומר איש קשר בלי סיבה — אך עדיין דורש שם ודרך ליצירת קשר', async () => {
    const user = userEvent.setup();
    renderCustomerDetail();
    await screen.findByRole('heading', { level: 1, name: /מסעדת הגפן/ });

    // The primary contact has no record yet, so the first row offers "הוספה".
    await user.click(screen.getAllByRole('button', { name: /הוספה/ })[0]);

    // The gates that survived: an unnamed, unreachable contact is refused by the server too.
    expect(screen.getByRole('button', { name: 'שמירה' })).toBeDisabled();
    await user.type(screen.getByLabelText('שם'), 'רות כהן');
    await user.type(screen.getByLabelText('אימייל'), 'ruth@example.test');

    const save = screen.getByRole('button', { name: 'שמירה' });
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => expect(upsertCustomerContact).toHaveBeenCalledTimes(1));
    const payload = upsertCustomerContact.mock.calls[0][0];
    expect(payload.name).toBe('רות כהן');
    expect(payload.reason).toContain('ללא הערה');
  });
});

describe('הקמה והפעלה — רישום שלב בלי הערה', () => {
  const step: OnboardingStep = {
    step_key: 'suppliers_imported',
    label: 'ייבוא ספקים',
    sort_order: 3,
    state: 'not_started',
    source: 'none',
    achieved_at: null,
    reason: null,
    recorded_by_email: null,
    recorded_at: null,
  };

  it('רושם את השלב בלי שנכתב דבר, ושומר ביומן את שם השלב', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <CustomerOnboarding
          orgId={ORG_ID}
          steps={[step]}
          may={() => true}
          busy={false}
          run={(action) => { void action(); }}
        />
      </ToastProvider>,
    );

    await user.click(screen.getByRole('button', { name: /רישום/ }));
    const save = screen.getByRole('button', { name: 'שמירה' });
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => expect(setOnboardingStep).toHaveBeenCalledTimes(1));
    const payload = setOnboardingStep.mock.calls[0][0];
    expect(payload.reason).toContain('ללא הערה');
    expect(payload.reason).toContain('ייבוא ספקים');
  });
});

describe('מנוי והרשאות — סיבה שאינה חוסמת, אימות זהות שנשאר', () => {
  const subscription: OrgSubscription = {
    org_id: ORG_ID,
    plan_key: 'pro',
    plan_label: 'Pro',
    plan_active: true,
    tier_order: 2,
    status: 'active',
    billing_interval: 'monthly',
    started_at: '2026-01-01T00:00:00.000Z',
    current_period_start: null,
    current_period_end: null,
    renews_at: null,
    canceled_at: null,
    provider: 'manual',
    has_provider_link: false,
  };

  const entitlement: OrgEntitlement = {
    entitlement_key: 'documents.monthly',
    kind: 'numeric',
    measure: 'per_period',
    unit: 'documents',
    label: 'מסמכים בחודש',
    source: 'plan',
    unlimited: true,
    numeric_limit: null,
    boolean_value: null,
    measured: true,
    override_id: null,
    override_expires_at: null,
  };

  const plans: SubscriptionPlan[] = [
    { plan_key: 'free', label: 'Free', tier_order: 1, active: true },
    { plan_key: 'pro', label: 'Pro', tier_order: 2, active: true },
  ];

  const renderSection = () => render(
    <MemoryRouter>
      <ToastProvider>
        <CustomerSubscription
          orgId={ORG_ID}
          subscription={subscription}
          entitlements={[entitlement]}
          plans={plans}
          billingEvents={[]}
          may={() => true}
          busy={false}
          run={(action) => { void action(); }}
        />
      </ToastProvider>
    </MemoryRouter>,
  );

  it('משנה מנוי בלי סיבה — אך רק אחרי אימות זהות', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: /שינוי מנוי/ }));
    const proceed = screen.getByRole('button', { name: 'המשך לאימות' });
    expect(proceed).toBeEnabled();
    await user.click(proceed);

    // The typing gate is gone; the identity gate is not.
    expect(setOrgSubscription).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'אישור זהות' }));

    await waitFor(() => expect(setOrgSubscription).toHaveBeenCalledTimes(1));
    const payload = setOrgSubscription.mock.calls[0][0];
    expect(payload.orgId).toBe(ORG_ID);
    expect(payload.reason).toContain('ללא הערה');
  });

  it('מעניק חריג בלי סיבה — אך עדיין דורש מגבלה מספרית', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: /^חריג$/ }));

    // A numeric override with no number has nothing to grant, so that gate stayed.
    expect(screen.getByRole('button', { name: 'המשך לאימות' })).toBeDisabled();
    await user.type(screen.getByLabelText('המגבלה'), '250');

    const proceed = screen.getByRole('button', { name: 'המשך לאימות' });
    expect(proceed).toBeEnabled();
    await user.click(proceed);

    expect(grantEntitlementOverride).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'אישור זהות' }));

    await waitFor(() => expect(grantEntitlementOverride).toHaveBeenCalledTimes(1));
    const payload = grantEntitlementOverride.mock.calls[0][0];
    expect(payload.numericLimit).toBe(250);
    expect(payload.reason).toContain('ללא הערה');
    expect(payload.reason).toContain('מסמכים בחודש');
  });
});
