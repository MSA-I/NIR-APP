import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui';
import CustomerSubscription from './CustomerSubscription';
import type {
  BillingEventRow, OrgEntitlement, OrgSubscription, PlatformCapability, SubscriptionPlan,
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
  billingEvents: BillingEventRow[] = [],
) => render(
  <MemoryRouter>
    <ToastProvider>
      <CustomerSubscription
        orgId="51000000-0000-4000-8000-000000000001"
        subscription={sub}
        entitlements={entitlements}
        plans={plans}
        billingEvents={billingEvents}
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

  it('אינו מזהה תקופת חיוב עם תקופת שימוש — #242 הפריד ביניהן', () => {
    // Until #242 this screen said the billing period was what a per-period limit resets against.
    // It is not: the usage period is anchored to the organization's signup timestamp and no
    // billing event resets it, so an operator reading a renewal date must not read a quota reset.
    renderSection(['billing.view']);
    expect(screen.getByText(/מעוגנת לתאריך ההרשמה/)).toBeInTheDocument();
    expect(screen.getByText(/אינם מאפסים/)).toBeInTheDocument();
  });

  it('מסביר מה המשמעות של פיגור תשלום — קריאה בלבד, יציאה רק בתשלום חתום', () => {
    renderSection(['billing.view'], [entitlement()], { ...subscription, status: 'past_due' });
    expect(screen.getByText(/קריאה בלבד/)).toBeInTheDocument();
    expect(screen.getByText(/אירוע תשלום מוצלח וחתום/)).toBeInTheDocument();
    expect(screen.getByText(/אין מעבר אוטומטי/)).toBeInTheDocument();
  });

  /**
   * Every numeric entitlement carries a unit and only `bytes` was ever translated, so `40` appeared
   * where `40 מסמכים` belonged. An operator reading a column of bare integers has to remember which
   * row counts documents and which counts users.
   */
  it('מציג את היחידה של כל הרשאה מספרית, לא רק של בתים', () => {
    renderSection(['billing.view'], [
      entitlement({ unit: 'documents', unlimited: false, numeric_limit: 40 }),
      entitlement({ entitlement_key: 'users.max', label: 'משתמשים', unit: 'users', unlimited: false, numeric_limit: 5 }),
      entitlement({ entitlement_key: 'storage.bytes', label: 'אחסון', unit: 'bytes', unlimited: false, numeric_limit: 1024 }),
    ]);
    expect(screen.getByText('40 מסמכים')).toBeInTheDocument();
    expect(screen.getByText('5 משתמשים')).toBeInTheDocument();
    expect(screen.getByText('1,024 בתים')).toBeInTheDocument();
  });

  it('יחידה שאין לה תרגום מוצגת כמות שהיא, ולא נעלמת', () => {
    renderSection(['billing.view'], [
      entitlement({ unit: 'widgets', unlimited: false, numeric_limit: 7 }),
    ]);
    expect(screen.getByText('7 widgets')).toBeInTheDocument();
  });

  /**
   * A dangling "חיוב " with nothing after it is indistinguishable from a missing value. The column's
   * CHECK constrains the interval today, but the rendering must not depend on that staying true —
   * `CustomerUsage` already had this right with `?? period_source`.
   */
  it('מחזור חיוב שאין לו תרגום אינו מותיר «חיוב» תלוי באוויר', () => {
    // The cast is the point of the test: the TYPE says two intervals, the column's CHECK is what
    // a future migration would widen, and this asserts the renderer survives that day.
    renderSection(['billing.view'], [entitlement()],
      { ...subscription, billing_interval: 'quarterly' as OrgSubscription['billing_interval'] });
    expect(screen.getByText('חיוב quarterly')).toBeInTheDocument();
  });
});

/**
 * B7: the events list printed `subscription.past_due` and `paddle` verbatim into an otherwise
 * Hebrew console — machine keys an operator has to decode on the one panel where the question is
 * usually "did this customer's payment fail, and when".
 */
describe('אירועים מספק החיוב', () => {
  const event = (over: Partial<BillingEventRow> = {}): BillingEventRow => ({
    id: 'evt-1',
    provider: 'paddle',
    event_type: 'subscription.updated',
    status: 'stored',
    received_at: '2026-08-20T09:00:00.000Z',
    correlation_id: null,
    ...over,
  });

  it('מתרגם את סוג האירוע ואת שם הספק', () => {
    renderSection(['billing.view'], [entitlement()], subscription, [
      event(),
      event({ id: 'evt-2', event_type: 'subscription.past_due' }),
    ]);
    expect(screen.getByText('עדכון פרטי מנוי')).toBeInTheDocument();
    expect(screen.getByText('כשל בחיוב חידוש')).toBeInTheDocument();
    expect(screen.getAllByText('Paddle')).toHaveLength(2);
    expect(screen.queryByText('subscription.updated')).not.toBeInTheDocument();
    expect(screen.queryByText('paddle')).not.toBeInTheDocument();
  });

  it('סוג אירוע שאינו מוכר מוצג כמות שהוא — 0187 שולח אותו ל-dead letter, לא מסתיר אותו', () => {
    renderSection(['billing.view'], [entitlement()], subscription, [
      event({ event_type: 'subscription.reincarnated' }),
    ]);
    expect(screen.getByText('subscription.reincarnated')).toBeInTheDocument();
  });

  it('שומר את המפתח הגולמי ב-title, כדי שאפשר יהיה להצליב מול לוח הבקרה של הספק', () => {
    renderSection(['billing.view'], [entitlement()], subscription, [event()]);
    expect(screen.getByTitle('subscription.updated · paddle')).toBeInTheDocument();
  });
});
