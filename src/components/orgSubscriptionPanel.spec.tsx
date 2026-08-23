import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from './ui';
import { OrgSubscriptionPanel } from './OrgSubscriptionPanel';

/**
 * The tenant's own subscription surface, held to OPEN-DECISIONS #194, #199–#204, #208, #216–#225.
 *
 * The load-bearing test in this file is "checkout redirect is not proof". #224 and #217 both say
 * the entitlement moves on a SIGNED SERVER EVENT and nothing else; a browser that came back from
 * a payment page knows only that a browser came back from a payment page.
 */
const rpc = vi.fn();
const invoke = vi.fn();
vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    functions: { invoke: (...args: unknown[]) => invoke(...args) },
  },
}));

const subscription = (over: Record<string, unknown> = {}) => ({
  plan_key: 'free',
  plan_label: 'חינם',
  is_paid_plan: false,
  status: 'active',
  billing_interval: 'monthly',
  current_period_end: null,
  cancel_at_period_end: false,
  scheduled_plan_key: null,
  scheduled_plan_label: null,
  scheduled_interval: null,
  scheduled_effective_at: null,
  delinquent: false,
  billing_country: null,
  billing_country_verified: false,
  catalogue_currency: null,
  checkout_pending: false,
  ...over,
});

interface OptionFixture {
  plan_key: string; label: string; tier_order: number; paid: boolean; contact_sales: boolean;
  currency: string | null; catalogue_version: string | null;
  monthly_amount: number | null; yearly_amount: number | null;
}

const option = (
  plan_key: string, label: string, tier_order: number, over: Partial<OptionFixture> = {},
): OptionFixture => ({
  plan_key, label, tier_order, paid: plan_key !== 'free', contact_sales: false,
  currency: null, catalogue_version: null, monthly_amount: null, yearly_amount: null, ...over,
});

const OPTIONS = [
  option('free', 'חינם', 1),
  option('basic', 'בסיס', 2),
  option('pro', 'פרו', 3),
  option('premium', 'פרימיום', 4),
  // #194 / #201: Business appears here and nowhere else, with no figure of any kind.
  option('business', 'ביזנס', 5, { contact_sales: true }),
];

const priced = (currency: string, amounts: Record<string, number>) =>
  OPTIONS.map((option) => (option.contact_sales
    ? option
    : { ...option, currency, catalogue_version: 'v1', monthly_amount: amounts[option.plan_key] ?? null }));

const USAGE = [
  { metric_key: 'documents.monthly', label: 'מסמכים', used: 180, usage_limit: 200, unlimited: false, measured: true, remaining: 20, percent_used: 90, period_end: '2026-09-04T00:00:00.000Z' },
  { metric_key: 'users.max', label: 'משתמשים', used: null, usage_limit: null, unlimited: false, measured: false, remaining: null, percent_used: null, period_end: null },
];

function mockServer(sub: Record<string, unknown>, options: OptionFixture[] = OPTIONS) {
  rpc.mockImplementation((name: string) => {
    if (name === 'my_subscription') return Promise.resolve({ data: [sub], error: null });
    if (name === 'my_upgrade_options') return Promise.resolve({ data: options, error: null });
    if (name === 'organization_usage_snapshot') return Promise.resolve({ data: USAGE, error: null });
    return Promise.resolve({ data: null, error: null });
  });
}

beforeEach(() => {
  mockServer(subscription());
  invoke.mockResolvedValue({ data: { checkout_url: 'https://pay.example/x', checkout_attempt_id: 'att-1' }, error: null });
  vi.stubGlobal('open', vi.fn());
});

const renderPanel = () => render(<ToastProvider><OrgSubscriptionPanel /></ToastProvider>);
const settle = () => waitFor(() => expect(screen.getByRole('heading', { name: /מסלול ומנוי/ })).toBeInTheDocument());

describe('מסלול ומנוי — המסך של הדייר', () => {
  it('מציג את «ביזנס» כ«דברו איתנו» בלי מחיר, ובלי המינימום הפנימי', async () => {
    renderPanel();
    await settle();
    expect(await screen.findByText('ביזנס')).toBeInTheDocument();
    expect(screen.getByText('דברו איתנו')).toBeInTheDocument();
    expect(screen.queryByText(/299/)).not.toBeInTheDocument();
    expect(screen.queryByText(/דמי הקמה/)).not.toBeInTheDocument();
  });

  it('בלי מדינת חיוב מאומתת — אינו טוען מטבע ואינו מציג מחיר מנוחש', async () => {
    renderPanel();
    await settle();
    expect(await screen.findByText(/כתובת חיוב מאומתת/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /מטבע/ })).not.toBeInTheDocument();
    // Every priced plan shows an em dash rather than a currency nobody verified.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(4);
  });

  it('עם מדינת חיוב מאומתת בישראל — מציג את קטלוג השקלים בלבד', async () => {
    mockServer(
      subscription({ billing_country: 'IL', billing_country_verified: true, catalogue_currency: 'ILS' }),
      priced('ILS', { basic: 69, pro: 249, premium: 449 }),
    );
    renderPanel();
    await settle();
    expect(await screen.findByText(/69/)).toBeInTheDocument();
    expect(screen.getByText(/249/)).toBeInTheDocument();
    expect(screen.getByText(/449/)).toBeInTheDocument();
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });

  it('חזרה מדף התשלום אינה הצלחה — המסלול נשאר מה שהשרת אומר, והמצב הוא «ממתין לאישור»', async () => {
    const user = userEvent.setup();
    renderPanel();
    await settle();
    await user.click(await screen.findByRole('button', { name: /מעבר לתשלום — פרו/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('billing-checkout', expect.objectContaining({
      body: expect.objectContaining({ plan_key: 'pro', billing_interval: 'monthly' }),
    })));
    // The browser was sent to the provider. That is ALL that happened.
    expect(await screen.findByText(/ממתין לאישור/)).toBeInTheDocument();
    expect(screen.getByText(/אירוע תשלום חתום/)).toBeInTheDocument();
    expect(screen.queryByText(/התשלום בוצע|המסלול שודרג|שולם בהצלחה/)).not.toBeInTheDocument();
    // The current plan still reads what the server reports, which is still Free.
    expect(screen.getByTestId('current-plan')).toHaveTextContent('חינם');
  });

  it('מצב «ממתין לאישור» שהשרת מדווח מוצג גם בלי לחיצה בדפדפן הזה', async () => {
    mockServer(subscription({ checkout_pending: true }));
    renderPanel();
    await settle();
    expect(await screen.findByText(/ממתין לאישור/)).toBeInTheDocument();
  });

  it('מצב פיגור תשלום — קריאה בלבד, יציאה רק בתשלום חתום, בלי מחיקה ובלי שנמוך אוטומטי', async () => {
    mockServer(subscription({ plan_key: 'pro', plan_label: 'פרו', is_paid_plan: true, status: 'past_due', delinquent: true }));
    renderPanel();
    await settle();
    expect(await screen.findByText(/קריאה בלבד/)).toBeInTheDocument();
    expect(screen.getByText(/אירוע תשלום מוצלח וחתום/)).toBeInTheDocument();
    expect(screen.getByText(/אינו נמחק/)).toBeInTheDocument();
    expect(screen.getByText(/אין מעבר אוטומטי/)).toBeInTheDocument();
  });

  it('שינוי בין מסלולים בתשלום נכנס בחידוש הבא, בלי חישוב יחסי', async () => {
    mockServer(subscription({
      plan_key: 'pro', plan_label: 'פרו', is_paid_plan: true, current_period_end: '2026-09-15T00:00:00.000Z',
      scheduled_plan_key: 'premium', scheduled_plan_label: 'פרימיום', scheduled_interval: 'monthly',
      scheduled_effective_at: '2026-09-15T00:00:00.000Z',
    }));
    renderPanel();
    await settle();
    expect(await screen.findByText(/בחידוש הבא/)).toBeInTheDocument();
    expect(screen.getByText(/ללא חישוב יחסי/)).toBeInTheDocument();
    expect(screen.getAllByText(/15\.09\.2026/).length).toBeGreaterThan(0);
  });

  it('לפני אישור ביטול — מציג שימוש מול מכסה בכנות, ואומר שהמונים אינם מתאפסים', async () => {
    const user = userEvent.setup();
    mockServer(subscription({ plan_key: 'pro', plan_label: 'פרו', is_paid_plan: true, current_period_end: '2026-09-15T00:00:00.000Z' }));
    renderPanel();
    await settle();
    await user.click(await screen.findByRole('button', { name: /ביטול המנוי/ }));
    expect(await screen.findByText(/180/)).toBeInTheDocument();
    expect(screen.getByText(/200/)).toBeInTheDocument();
    expect(screen.getByText(/אינם מתאפסים/)).toBeInTheDocument();
    expect(screen.getByText(/בסוף התקופה ששולמה/)).toBeInTheDocument();
    // An unmeasured metric is an em dash inside the cancellation summary too, never a zero.
    expect(screen.getByTestId('cancel-usage-users.max')).toHaveTextContent('—');
  });

  it('מנוי שסומן לביטול מציע לחזור ממנו, ואומר עד מתי הגישה מלאה', async () => {
    mockServer(subscription({
      plan_key: 'pro', plan_label: 'פרו', is_paid_plan: true, cancel_at_period_end: true,
      current_period_end: '2026-09-15T00:00:00.000Z',
    }));
    renderPanel();
    await settle();
    expect(await screen.findByRole('button', { name: /חזרה מהביטול/ })).toBeInTheDocument();
    expect(screen.getByText(/גישה מלאה עד/)).toBeInTheDocument();
  });

  it('במסלול חינם אין מה לבטל', async () => {
    renderPanel();
    await settle();
    expect(screen.queryByRole('button', { name: /ביטול המנוי/ })).not.toBeInTheDocument();
  });
});
