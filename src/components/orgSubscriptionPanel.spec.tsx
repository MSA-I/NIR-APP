import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from './ui';
import { OrgSubscriptionPanel } from './OrgSubscriptionPanel';

/**
 * The tenant's own subscription surface, held to OPEN-DECISIONS #194, #199–#204, #208, #216–#225.
 *
 * The load-bearing test in this file used to be "a checkout redirect is not proof". It is now
 * stronger and simpler: THERE IS NO CHECKOUT PATH AT ALL. Paddle is ACCOUNT_NOT_PROVEN, no
 * `billing-checkout` function exists, and none is being built this wave — so the panel must not
 * invoke one, must not render an affordance that would, and must not contain any wording that
 * could read as payment having happened. #224 and #217 say the entitlement moves on a signed
 * server event and nothing else; the safest implementation of that is to have no local path that
 * could ever claim otherwise, and this file pins exactly that.
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
  billing_provider_enabled: false,
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

  it('אין שום נתיב רכישה — לא כפתור, לא קריאה לפונקציה, ולא מילה שנשמעת כמו תשלום שבוצע', async () => {
    renderPanel();
    await settle();
    // No affordance that would start a checkout.
    expect(screen.queryByRole('button', { name: /מעבר לתשלום/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /רכישה|תשלום/ })).not.toBeInTheDocument();
    // No Edge function is called, ever, from this panel.
    expect(invoke).not.toHaveBeenCalled();
    // And nothing on screen could be read as money having moved.
    expect(screen.queryByText(/התשלום בוצע|שולם|שודרג|ממתין לאישור/)).not.toBeInTheDocument();
    expect(screen.getByTestId('current-plan')).toHaveTextContent('חינם');
  });

  it('ספק סליקה שאינו פעיל — אומר שרכישה אינה זמינה עדיין, כעובדה', async () => {
    renderPanel();
    await settle();
    expect(await screen.findByTestId('billing-availability')).toHaveTextContent(/אינה זמינה עדיין/);
  });

  it('ספק סליקה פעיל — אומר משהו אחר, ולא ממציא כפתור שאין מאחוריו נתיב', async () => {
    mockServer(subscription({ billing_provider_enabled: true }));
    renderPanel();
    await settle();
    const note = await screen.findByTestId('billing-availability');
    expect(note).not.toHaveTextContent(/אינה זמינה עדיין/);
    expect(screen.queryByRole('button', { name: /מעבר לתשלום/ })).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('דגל שאינו בוליאני הוא «לא ידוע» — מצב שלישי, ולעולם לא «לא זמין»', async () => {
    // 0189 guarantees the key is present and non-null, so this is defence in depth: "we could not
    // determine" must never be rendered as "no", the same distinction as `measured:false` -> «—».
    mockServer(subscription({ billing_provider_enabled: null }));
    renderPanel();
    await settle();
    const note = await screen.findByTestId('billing-availability');
    expect(note).toHaveTextContent(/לא ניתן לקבוע/);
    expect(note).not.toHaveTextContent(/אינה זמינה עדיין/);
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
    // #220's disclosure survives even though the transition itself does not exist yet: the
    // control stays reachable per #204, and the confirm step says plainly that it cannot be
    // completed rather than calling nothing and looking like it worked.
    expect(screen.getByRole('button', { name: /ביטול בסוף התקופה/ })).toBeDisabled();
    expect(screen.getByText(/אינו זמין עדיין/)).toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalledWith('cancel_subscription_at_period_end', expect.anything());
  });

  it('מנוי שסומן לביטול מציע לחזור ממנו, ואומר עד מתי הגישה מלאה', async () => {
    mockServer(subscription({
      plan_key: 'pro', plan_label: 'פרו', is_paid_plan: true, cancel_at_period_end: true,
      current_period_end: '2026-09-15T00:00:00.000Z',
    }));
    renderPanel();
    await settle();
    // Visible, never hidden (#204) — and disabled rather than silently doing nothing, because
    // `resume_subscription` does not exist this wave.
    expect(await screen.findByRole('button', { name: /חזרה מהביטול/ })).toBeDisabled();
    expect(screen.getByText(/גישה מלאה עד/)).toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalledWith('resume_subscription', expect.anything());
  });

  it('במסלול חינם אין מה לבטל', async () => {
    renderPanel();
    await settle();
    expect(screen.queryByRole('button', { name: /ביטול המנוי/ })).not.toBeInTheDocument();
  });
});
