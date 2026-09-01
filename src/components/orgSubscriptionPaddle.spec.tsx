import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { ToastProvider } from './ui';
import { OrgSubscriptionPanel } from './OrgSubscriptionPanel';

/**
 * The panel with Paddle ACTUALLY CONFIGURED — the state production is not in.
 *
 * orgSubscriptionPanel.spec.tsx covers the unconfigured build, where `paddleConfig()` is null and
 * no purchase path is drawn at all. That is production's shape today and it is the important
 * default — but it also means the entire checkout branch would otherwise ship untested, passing by
 * never being reached. This file supplies the missing half.
 *
 * What it pins is not "the button works". It is the four properties that keep a working button
 * from becoming a way to get a plan without paying for it:
 *
 *   1. the request names a rung and a cycle and NOTHING that decides what is charged
 *   2. `checkout.completed` from the overlay does not move the plan, and does not claim to
 *   3. a shut provider still refuses, even with a token present
 *   4. a failed checkout says plainly that nothing was charged
 *
 * The fixtures below are LIFTED from the sibling spec rather than rewritten, deliberately: two
 * specs describing two different servers would let the panel pass both while matching neither.
 */
const rpc = vi.fn();
const invoke = vi.fn();
vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    functions: { invoke: (...args: unknown[]) => invoke(...args) },
  },
}));

/**
 * Paddle.js is stubbed rather than loaded: the real module injects a CDN script tag, and a unit
 * test that depended on Paddle's CDN would be measuring the network. The spy keeps the event
 * callback so `checkout.completed` can be fired deliberately — which is the only way to test that
 * it grants nothing.
 */
let lastCheckout: { transactionId: string; onEvent?: (event: { name: string }) => void } | null = null;
let checkoutOpens = true;
vi.mock('../lib/paddle', () => ({
  paddleConfig: () => ({ token: 'test_stub_client_token', environment: 'sandbox' as const }),
  openPaddleCheckout: (transactionId: string, onEvent?: (event: { name: string }) => void) => {
    lastCheckout = { transactionId, onEvent };
    return Promise.resolve(checkoutOpens);
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
  billing_provider_enabled: true,
  ...over,
});

/**
 * `my_plan_grant()` (0212). `has_paid` is the existence of a real billing period and nothing
 * softer, which is why it — and not `is_paid_plan` — decides whether this screen shows a person the
 * apparatus of a paying customer.
 */
const grant = (over: Record<string, unknown> = {}) => ({
  granted: false,
  ends_at: null,
  reverts_to_plan_key: 'free',
  reverts_to_label: 'חינם',
  has_paid: false,
  ...over,
});

/* The sibling spec's `GRANTED_PREMIUM` fixture is deliberately not carried over: the granted-but-
   never-paid state is its subject, not this file's, and an unused fixture here would be a claim
   about coverage this spec does not make. */

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

const priced = (
  currency: string, monthly: Record<string, number>, yearly: Record<string, number> = {},
) => OPTIONS.map((option) => (option.contact_sales
  ? option
  : {
    ...option,
    currency,
    catalogue_version: 'v1',
    monthly_amount: monthly[option.plan_key] ?? null,
    yearly_amount: yearly[option.plan_key] ?? null,
  }));

/**
 * `get_public_plan_quotas()` — the SAME server function the public ladder reads, which is why the
 * cards can compare rungs without a second source of numbers. Only `documents.monthly` is
 * published (#266); `users.max` rides along unmeasured so the card's dash path is exercised too.
 */
const PLAN_QUOTAS = [
  { plan_key: 'free', entitlement_key: 'documents.monthly', label: 'מסמכים', unit: 'מסמכים', unlimited: false, numeric_limit: 20, measured: true },
  { plan_key: 'basic', entitlement_key: 'documents.monthly', label: 'מסמכים', unit: 'מסמכים', unlimited: false, numeric_limit: 40, measured: true },
  { plan_key: 'pro', entitlement_key: 'documents.monthly', label: 'מסמכים', unit: 'מסמכים', unlimited: false, numeric_limit: 150, measured: true },
  { plan_key: 'premium', entitlement_key: 'documents.monthly', label: 'מסמכים', unit: 'מסמכים', unlimited: false, numeric_limit: 375, measured: true },
  ...['free', 'basic', 'pro', 'premium'].map((plan_key, index) => ({
    plan_key, entitlement_key: 'users.max', label: 'משתמשים', unit: 'משתמשים',
    unlimited: false, numeric_limit: [1, 5, 15, 30][index], measured: true,
  })),
  ...['free', 'basic', 'pro', 'premium'].map((plan_key, index) => ({
    plan_key, entitlement_key: 'branches.max', label: 'סניפים', unit: 'סניפים',
    unlimited: false, numeric_limit: [1, 1, 1, 10][index], measured: true,
  })),
];

const PRICE_CATALOGUE = [
  ...priced('ILS', { free: 0, basic: 69, pro: 249, premium: 449 },
    { free: 0, basic: 690, pro: 2490, premium: 4490 }).filter((row) => !row.contact_sales),
  ...priced('USD', { free: 0, basic: 20, pro: 79, premium: 149 },
    { free: 0, basic: 200, pro: 790, premium: 1490 }).filter((row) => !row.contact_sales),
];

const PLAN_FEATURES = OPTIONS.flatMap((plan) => [
  {
    plan_key: plan.plan_key,
    entitlement_key: 'documents.automation',
    label: 'קריאה אוטומטית של מסמכים',
    display_order: 10,
    included: plan.tier_order >= 2,
    intro_included: plan.plan_key === 'free',
  },
  {
    plan_key: plan.plan_key,
    entitlement_key: 'bank.reconciliation',
    label: 'התאמות בנק',
    display_order: 60,
    included: plan.tier_order >= 3,
    intro_included: false,
  },
]);

const USAGE = [
  { metric_key: 'documents.monthly', label: 'מסמכים', used: 180, usage_limit: 200, unlimited: false, measured: true, remaining: 20, percent_used: 90, period_end: '2026-09-04T00:00:00.000Z' },
  { metric_key: 'users.max', label: 'משתמשים', used: null, usage_limit: null, unlimited: false, measured: false, remaining: null, percent_used: null, period_end: null },
];

function mockServer(
  sub: Record<string, unknown> | null,
  options: OptionFixture[] = OPTIONS,
  planGrant: Record<string, unknown> | null = grant(),
  catalogue: OptionFixture[] = PRICE_CATALOGUE,
) {
  rpc.mockImplementation((name: string) => {
    if (name === 'my_subscription') return Promise.resolve({ data: sub ? [sub] : [], error: null });
    if (name === 'my_upgrade_options') return Promise.resolve({ data: options, error: null });
    if (name === 'my_plan_grant') return Promise.resolve({ data: planGrant, error: null });
    if (name === 'organization_usage_snapshot') return Promise.resolve({ data: USAGE, error: null });
    if (name === 'get_public_plan_quotas') return Promise.resolve({ data: PLAN_QUOTAS, error: null });
    if (name === 'my_plan_features') return Promise.resolve({ data: PLAN_FEATURES, error: null });
    if (name === 'get_public_plan_catalogue') return Promise.resolve({ data: catalogue, error: null });
    return Promise.resolve({ data: null, error: null });
  });
}

/**
 * `retry: false`, unlike the app client's two attempts. The error branch below is a real assertion
 * about what the reader sees, and letting TanStack retry it twice with a backoff would turn a
 * one-line test into a flaky four-second one that proves the same thing.
 */
const testClient = () => new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: 0 } },
});

beforeEach(() => {
  document.documentElement.lang = 'he';
  mockServer(subscription());
  invoke.mockResolvedValue({ data: { checkout_url: 'https://pay.example/x', checkout_attempt_id: 'att-1' }, error: null });
  vi.stubGlobal('open', vi.fn());
});

const renderPanel = (org: string | null = 'org-1') => render(
  <QueryClientProvider client={testClient()}>
    <OrgScopeProvider org={org}>
      <ToastProvider><OrgSubscriptionPanel /></ToastProvider>
    </OrgScopeProvider>
  </QueryClientProvider>,
);
const settle = () => screen.findByTestId('plan-cards');

/* Runs AFTER the lifted block's own beforeEach, which is why it can restate `invoke`: that one
   returns the pre-31.08.2026 checkout shape, and this one replaces it with the shape
   billing-checkout actually answers with. */
beforeEach(() => {
  lastCheckout = null;
  checkoutOpens = true;
  mockServer(subscription());
  invoke.mockResolvedValue({
    data: { checkout: { kind: 'provider_transaction', provider: 'paddle', transaction_id: 'txn_e2e_1' } },
    error: null,
  });
});

describe('מסלול ומנוי — כאשר Paddle מוגדר בבנייה', () => {
  it('הבקשה נושאת מסלול ומחזור בלבד — לא מחיר, לא סכום, לא לקוח ולא ארגון', async () => {
    const user = userEvent.setup();
    renderPanel();
    const cards = await settle();
    await user.click(cards.querySelector('[data-plan="pro"] button') as HTMLElement);

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    const [fn, options] = invoke.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(fn).toBe('billing-checkout');
    /* THE ASSERTION THAT MATTERS is the exact key SET, not the presence of the two keys we expect.
       A body that grew `provider_price_id`, `amount` or `org_id` would be a browser deciding what
       it is charged and whose plan changes — and it would sail through a `toMatchObject` that only
       looked for what it already knew about. */
    expect(Object.keys(options.body).sort()).toEqual(['action', 'billing_interval', 'plan_key']);
    expect(options.body).toMatchObject({ action: 'checkout', plan_key: 'pro', billing_interval: 'monthly' });
  });

  it('התשלום נפתח עם מזהה העסקה שהשרת יצר', async () => {
    const user = userEvent.setup();
    renderPanel();
    const cards = await settle();
    await user.click(cards.querySelector('[data-plan="premium"] button') as HTMLElement);
    await waitFor(() => expect(lastCheckout?.transactionId).toBe('txn_e2e_1'));
  });

  it('סיום התשלום בדפדפן אינו הוכחת תשלום — המסלול לא זז, והמסך אומר שממתינים לספק', async () => {
    const user = userEvent.setup();
    renderPanel();
    const cards = await settle();
    await user.click(cards.querySelector('[data-plan="pro"] button') as HTMLElement);
    await waitFor(() => expect(lastCheckout).not.toBeNull());

    /* Paddle's overlay reports completion the instant the card clears. #217/#224 put entitlement
       behind a signed SERVER event, so this must change nothing about the plan. */
    lastCheckout?.onEvent?.({ name: 'checkout.completed' });

    expect(await screen.findByTestId('billing-awaiting-provider')).toBeInTheDocument();
    expect(screen.getByTestId('current-plan')).toHaveTextContent('חינם');
    expect(screen.queryByText(/התשלום בוצע|שולם|שודרג|המסלול עודכן/)).not.toBeInTheDocument();
  });

  it('ביזנס לעולם אינו נפתח לתשלום — התשובה שלו היא שיחה (#201)', async () => {
    renderPanel();
    const cards = await settle();
    expect(cards.querySelector('[data-plan="business"] button')).toBeDisabled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('ספק סליקה כבוי — הכפתור מושבת גם כשיש טוקן, ושום פונקציה אינה נקראת', async () => {
    mockServer(subscription({ billing_provider_enabled: false }));
    renderPanel();
    const cards = await settle();
    expect(cards.querySelector('[data-plan="pro"] button')).toBeDisabled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('כשלון בפתיחת התשלום נאמר במפורש שלא בוצע חיוב', async () => {
    invoke.mockResolvedValue({ data: null, error: { message: 'refused' } });
    const user = userEvent.setup();
    renderPanel();
    const cards = await settle();
    await user.click(cards.querySelector('[data-plan="pro"] button') as HTMLElement);
    /* A customer whose checkout failed must be TOLD nothing was taken. Silence here is read as
       "it probably went through", and the next thing they do is pay again. */
    expect(await screen.findByTestId('billing-checkout-failed')).toHaveTextContent(/לא בוצע חיוב/);
  });
});
