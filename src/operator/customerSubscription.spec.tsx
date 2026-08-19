import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui';
import CustomerSubscription from './CustomerSubscription';
import type {
  OrgEntitlement, OrgSubscription, PlatformCapability, SubscriptionPlan,
} from '../lib/platform';

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ session: null }) }));

const subscription: OrgSubscription = {
  org_id: '51000000-0000-4000-8000-000000000001',
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

const entitlement = (over: Partial<OrgEntitlement> = {}): OrgEntitlement => ({
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
  ...over,
});

const plans: SubscriptionPlan[] = [
  { plan_key: 'legacy', label: 'לקוח ותיק', tier_order: 0, active: false },
  { plan_key: 'free', label: 'Free', tier_order: 1, active: true },
  { plan_key: 'pro', label: 'Pro', tier_order: 2, active: true },
];

const renderSection = (
  capabilities: PlatformCapability[],
  entitlements: OrgEntitlement[] = [entitlement()],
  sub: OrgSubscription | null = subscription,
) => render(
  <MemoryRouter>
    <ToastProvider>
      <CustomerSubscription
        orgId="51000000-0000-4000-8000-000000000001"
        subscription={sub}
        entitlements={entitlements}
        plans={plans}
        billingEvents={[]}
        may={(capability) => capabilities.includes(capability)}
        busy={false}
        run={() => {}}
      />
    </ToastProvider>
  </MemoryRouter>,
);

describe('מנוי והרשאות בכרטיס הלקוח', () => {
  it('מציג «ללא הגבלה» כמילה, לא כמספר גדול', () => {
    renderSection(['billing.view']);
    expect(screen.getByText('ללא הגבלה')).toBeInTheDocument();
  });

  it('מציג מקף להרשאה שאין לה מגבלה מוגדרת, ומסביר שהפעולה תיחסם', () => {
    // measured:false means the platform cannot state the entitlement. Rendering a zero there
    // would be a claim the data does not support, and would read as "entitled to nothing".
    renderSection(['billing.view'], [entitlement({ measured: false, unlimited: false })]);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText(/ללא מגבלה מוגדרת/)).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('מסמן הרשאה שנקבעה בחריג ומציע לבטלו במקום להוסיף חריג שני', () => {
    renderSection(
      ['billing.view', 'entitlement.override'],
      [entitlement({ source: 'override', unlimited: false, numeric_limit: 250, override_id: 'ov-1' })],
    );
    expect(screen.getByText('חריג')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ביטול החריג/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^חריג$/ })).not.toBeInTheDocument();
  });

  it('מסתיר את פעולות הכסף ממפעיל שיש לו רק צפייה', () => {
    renderSection(['billing.view']);
    expect(screen.queryByRole('button', { name: /שינוי מנוי/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /חריג/ })).not.toBeInTheDocument();
  });

  it('אומר שתקופת החיוב לא התקבלה, במקום להמציא חודש', () => {
    renderSection(['billing.view']);
    expect(screen.getByText(/תקופת חיוב לא התקבלה/)).toBeInTheDocument();
  });
});
