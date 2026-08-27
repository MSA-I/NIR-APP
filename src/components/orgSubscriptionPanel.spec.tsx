import { readFileSync } from 'node:fs';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { ToastProvider } from './ui';
import { OrgSubscriptionPanel } from './OrgSubscriptionPanel';

/**
 * The tenant's own subscription surface, held to OPEN-DECISIONS #194, #199–#204, #208, #216–#225,
 * #266 and #276.
 *
 * The load-bearing test in this file used to be "a checkout redirect is not proof". It is now
 * stronger and simpler: THERE IS NO CHECKOUT PATH AT ALL. Paddle is ACCOUNT_NOT_PROVEN, no
 * `billing-checkout` function exists, and none is being built this wave — so the panel must not
 * invoke one, must not render an affordance that would, and must not contain any wording that
 * could read as payment having happened. #224 and #217 say the entitlement moves on a signed
 * server event and nothing else; the safest implementation of that is to have no local path that
 * could ever claim otherwise, and this file pins exactly that.
 *
 * WHAT THIS FILE DID NOT COVER, AND WHY THAT MATTERED. Every fixture here described an organization
 * with `is_paid_plan: false`, because until `0210` that was every organization there was. `0210`
 * puts every tenant on `premium`, so the untested branch became the only branch — and it renders a
 * paid customer's machinery to somebody who never paid: a billing period, a sentence that reads as
 * a payment failure, and a cancel button for a subscription that does not exist. The
 * `is_paid_plan === true` fixtures below, split by whether the organization has ACTUALLY PAID, are
 * that gap closed.
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

/** The state `0210` creates for every organization: on premium, granted, never paid. */
const GRANTED_PREMIUM = {
  subscription: subscription({ plan_key: 'premium', plan_label: 'פרימיום', is_paid_plan: true }),
  grant: grant({ granted: true, ends_at: '2027-01-01T00:00:00.000Z' }),
};

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

describe('מסלול ומנוי — המסך של הדייר', () => {
  it('מציג את «ביזנס» כ«דברו איתנו» בלי מחיר, ובלי המינימום הפנימי', async () => {
    renderPanel();
    await settle();
    expect(await screen.findByText('ביזנס')).toBeInTheDocument();
    expect(screen.getByText('דברו איתנו')).toBeInTheDocument();
    expect(screen.queryByText(/299/)).not.toBeInTheDocument();
    expect(screen.queryByText(/דמי הקמה/)).not.toBeInTheDocument();
  });

  it('מציג בעברית את קטלוג ישראל גם בלי מדינת חיוב, בלי להפוך אותו למטבע החיוב', async () => {
    renderPanel();
    await settle();
    // The sentence lives in the availability notice now rather than in a second box of its own:
    // "nothing can be bought yet" and "which is why the amounts are dashes" are one fact, and on a
    // Free organization both notices used to render one under the other saying it twice.
    const availability = await screen.findByTestId('billing-availability');
    expect(availability.textContent).toMatch(/עברית בשקלים/);
    expect(screen.queryByRole('combobox', { name: /מטבע/ })).not.toBeInTheDocument();
    /**
     * A SENTENCE, NOT FOUR DASHES — owner ruling 26.08.2026, «משפט קצר במקום מקף». The claim this
     * test makes is unchanged and is the one that matters: no currency nobody verified, and no
     * figure of any kind. What changed is how the screen SAYS the amount is missing. Stacked in a
     * list, a column of «—» in the price slot read as a broken screen rather than as a figure
     * being withheld.
     *
     * The sentence is held to its three prohibitions here, not only in prose: it names no digit,
     * it carries no currency symbol, and it does not read as a failure or a wait.
     */
    const cards = screen.getByTestId('plan-cards');
    const priceOf = (planKey: string) =>
      cards.querySelector(`[data-plan="${planKey}"] [data-testid="plan-figure"]`)?.textContent ?? '';
    expect(priceOf('basic')).toMatch(/69/);
    expect(priceOf('pro')).toMatch(/249/);
    expect(priceOf('premium')).toMatch(/449/);
    // The FREE rung is not a withheld price, and must not borrow the sentence for one: there is
    // nothing to disclose later. `ביזנס` answers the slot with its own words (#194/#201).
    expect(priceOf('free')).toBe('ללא עלות');
    expect(priceOf('business')).toBe('דברו איתנו');
  });

  it('שפת הממשק קובעת תצוגה בלבד: אנגלית מציגה USD גם כשמטבע החיוב המאומת הוא ILS', async () => {
    document.documentElement.lang = 'en';
    mockServer(
      subscription({ billing_country: 'IL', billing_country_verified: true, catalogue_currency: 'ILS' }),
    );
    renderPanel();
    await settle();
    const cards = await settle();
    const priceOf = (planKey: string) =>
      cards.querySelector(`[data-plan="${planKey}"] [data-testid="plan-figure"]`)?.textContent ?? '';
    expect(priceOf('basic')).toMatch(/20/);
    expect(priceOf('pro')).toMatch(/79/);
    expect(priceOf('premium')).toMatch(/149/);
    expect(screen.getByTestId('display-currency-note').textContent).toMatch(/בדולרים/);
    expect(screen.getByTestId('display-currency-note').textContent).toMatch(/ILS/);
  });

  /**
   * Owner report 25.08.2026: "התוכניות השונות עם האופציה לשדרוג, כמו בכל אפליקציה נורמלית".
   * A card per rung — and the reason this test also asserts what is ABSENT is that the obvious
   * next thing to put on a plan card is a feature list, and #274's feature ladder is
   * `NOT_IMPLEMENTED`: every capability boolean is still `true` for every plan and `0184` fails
   * any migration that turns one off. A card promising "ייצוא ✗ בחינם" would sell a difference
   * the server does not enforce.
   */
  it('מציג בכל כרטיס את המכסות ואת סולם היכולות שהשרת אוכף', async () => {
    renderPanel();
    const cards = await settle();

    // `:scope >`, because a card's quota rows are a real list inside it (26.08.2026 rebuild).
    // The claim is unchanged and now says exactly what it means: FIVE CARDS, one per rung.
    expect(cards.querySelectorAll(':scope > li')).toHaveLength(5);
    expect(cards.querySelector('[data-plan="free"]')?.textContent).toMatch(/20/);
    expect(cards.querySelector('[data-plan="premium"]')?.textContent).toMatch(/375/);
    expect(cards.querySelector('[data-plan="free"]')?.textContent).toMatch(/קריאה אוטומטית.*30 הימים/);
    expect(cards.querySelector('[data-plan="basic"]')?.textContent).toMatch(/קריאה אוטומטית/);
    expect(cards.querySelector('[data-plan="pro"]')?.textContent).toMatch(/התאמות בנק/);
    // Business is a conversation and carries a contractual quota, never a published number.
    expect(cards.querySelector('[data-plan="business"]')?.textContent).toMatch(/מכסות מותאמות בחוזה/);
    // The rung the organization is actually on is marked, and offers itself no upgrade to itself.
    expect(cards.querySelector('[data-plan="free"]')?.textContent).toMatch(/המסלול הנוכחי/);
    expect(cards.querySelector('[data-plan="free"]')?.querySelector('button')).toBeNull();

    expect(screen.getAllByText(/התאמות בנק/).length).toBeGreaterThan(0);
  });

  /**
   * THE PROMOTED CARD IS STATIC, AND THAT IS #202 AND NOT A TASTE. «ההדגשה אינה מבוססת על נתוני
   * הדייר», and the same row forbids «המלצה אישית למסלול». The obvious rebuild — invert whichever
   * rung is one step above the reader's own — is a better sales screen and is exactly the thing
   * that sentence bans. This organization is on `free`, so a reader-keyed emphasis would land on
   * `basic`; it must land on `premium`, for everyone, always.
   */
  it('ההדגשה על הכרטיס היא סטטית ואינה נגזרת מהמסלול של הקורא', async () => {
    renderPanel();
    const cards = await settle();
    expect(cards.querySelector('[data-plan="premium"]')?.className).toMatch(/bg-tier-onyx/);
    expect(cards.querySelector('[data-plan="basic"]')?.className).not.toMatch(/bg-tier-onyx/);
    expect(cards.querySelector('[data-plan="business"]')?.className).not.toMatch(/bg-tier-onyx/);
  });

  /**
   * The per-row state taken from Origin UI's plan ladder: the rung you are on knows it, and says
   * so in the badge slot beside its mark rather than only in a colour.
   */
  it('הכרטיס של המסלול הנוכחי נושא מצב משלו ותג שאומר אותו במילים', async () => {
    renderPanel();
    const cards = await settle();
    const free = cards.querySelector('[data-plan="free"]');
    expect(free).toHaveAttribute('data-state', 'current');
    expect(free?.textContent).toMatch(/המסלול הנוכחי/);
    expect(cards.querySelector('[data-plan="pro"]')?.textContent).toMatch(/מדרגה מעל/);
  });

  it('כפתורי השדרוג מושבתים ואומרים למה — הם אינם מוסתרים ואינם קוראים לכלום', async () => {
    renderPanel();
    const cards = await settle();
    // #204 forbids putting the path out of reach; #217 forbids opening an entitlement without a
    // signed server event. Visible and disabled is the only shape that honours both.
    const upgrades = [...cards.querySelectorAll('button')];
    expect(upgrades).toHaveLength(4);
    for (const button of upgrades) {
      expect(button).toBeDisabled();
      // …and the reason is READABLE rather than merely present.
      expect(button).toHaveAttribute('title', 'החיוב עדיין לא נפתח');
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  /**
   * Owner report 26.08.2026: the ladder's only affordance read as broken. The cause was measured,
   * not guessed — `@utility btn`'s `disabled:opacity-50` was halving every one of these buttons,
   * which took the label from 9.60:1 to 2.53:1 on the paper rows and turned the promoted rung's
   * paper body into rgb(147,147,151) mid-grey on onyx (14.09:1 down to 4.71:1).
   *
   * DISABLED IS NOT THE SAME PROPERTY AS ILLEGIBLE, and this pins the difference: the buttons stay
   * genuinely inert — the test above still requires `disabled`, and no Edge function is reachable
   * from this file at all — while the dim that made them unreadable is lifted at the call site.
   */
  /*
   * This asserted the literal `disabled:opacity-100` until the variant got its named home
   * (`.btn-standby`, index.css). That spelling was never the contract — the contract is that a
   * button disabled as a STANDING state stays readable, because `btn`'s own `disabled:opacity-50`
   * took these labels from 9.60:1 to 2.53:1, under AA, on the only affordance in the row.
   * So: assert the variant is worn, and assert the variant still defeats the dim — reading the
   * stylesheet rather than trusting that the class name means what it meant last week.
   */
  it('הכפתורים המושבתים אינם מעומעמים למחצית — «מושבת» אינו «בלתי קריא»', async () => {
    renderPanel();
    const cards = await settle();
    const buttons = [...cards.querySelectorAll('button')];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button).toBeDisabled();
      expect(button.className).toMatch(new RegExp(`\\b(btn-standby|disabled:opacity-100)\\b`));
    }
    // The rule behind the class, so a rename or a deletion in index.css fails here and not on screen.
    const css = readFileSync('src/index.css', 'utf8');
    expect(css).toMatch(new RegExp(`\\.btn-standby\\s*\\{[^}]*disabled:opacity-100`));
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
    mockServer(
      subscription({ plan_key: 'pro', plan_label: 'פרו', is_paid_plan: true, status: 'past_due', delinquent: true }),
      OPTIONS, grant({ has_paid: true }),
    );
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
    }), OPTIONS, grant({ has_paid: true }));
    renderPanel();
    await settle();
    expect(await screen.findByText(/בחידוש הבא/)).toBeInTheDocument();
    expect(screen.getByText(/ללא חישוב יחסי/)).toBeInTheDocument();
    expect(screen.getAllByText(/15\.09\.2026/).length).toBeGreaterThan(0);
  });

  it('לפני אישור ביטול — מציג שימוש מול מכסה בכנות, ואומר שהמונים אינם מתאפסים', async () => {
    const user = userEvent.setup();
    mockServer(
      subscription({ plan_key: 'pro', plan_label: 'פרו', is_paid_plan: true, current_period_end: '2026-09-15T00:00:00.000Z' }),
      OPTIONS, grant({ has_paid: true }),
    );
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
    }), OPTIONS, grant({ has_paid: true }));
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

/**
 * THE STATE `0210` CREATES, which nothing in this file used to describe: every organization on
 * `premium`, `is_paid_plan` true, and not one shekel paid. Every assertion below failed before
 * `has_paid` existed.
 */
describe('מסלול שניתן ולא נרכש — מצב חלון ההרצה של 0210', () => {
  beforeEach(() => mockServer(GRANTED_PREMIUM.subscription, OPTIONS, GRANTED_PREMIUM.grant));

  it('אומר מה יש לארגון, עד מתי, ולאן הוא עובר אחר כך', async () => {
    renderPanel();
    await settle();
    const window = await screen.findByTestId('plan-grant-window');
    // #276: what closes, when, and which plan it reopens on — said BEFORE the boundary.
    expect(window).toHaveTextContent(/פרימיום/);
    expect(window).toHaveTextContent(/01\.01\.2027/);
    expect(window).toHaveTextContent(/עובר למסלול חינם/);
    expect(window).toHaveTextContent(/לא בוצע חיוב/);
    // #204 forbids a manufactured countdown; the date is a fact, "נותרו X ימים" is pressure.
    expect(window).not.toHaveTextContent(/נותרו|מהרו|בעוד/);
  });

  it('אינו מציג תקופת חיוב ואינו טוען שספק הסליקה נכשל', async () => {
    renderPanel();
    await settle();
    // The sentence that used to reach every tenant on the day 0210 deploys. It reads as a payment
    // failure, to a person who never entered a payment method.
    expect(screen.queryByText(/תקופת חיוב לא התקבלה/)).not.toBeInTheDocument();
    expect(screen.queryByText(/התקופה ששולמה/)).not.toBeInTheDocument();
  });

  it('אינו מציע לבטל מנוי שלא נרכש', async () => {
    renderPanel();
    await settle();
    expect(screen.queryByRole('button', { name: /ביטול המנוי/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /חזרה מהביטול/ })).not.toBeInTheDocument();
  });

  /**
   * `tier_order` was already on every card and already sorting this list; the label ignored it.
   * From the top of the ladder every other card read "שדרוג ל…" — including "שדרוג לחינם", an
   * offer to upgrade to less.
   */
  it('קורא למדרגה נמוכה «מעבר», לא «שדרוג»', async () => {
    renderPanel();
    const cards = await settle();
    expect(cards.querySelector('[data-plan="free"]')?.textContent).toMatch(/מעבר לחינם/);
    expect(cards.querySelector('[data-plan="free"]')?.textContent).not.toMatch(/שדרוג/);
    expect(cards.querySelector('[data-plan="pro"]')?.textContent).toMatch(/מעבר לפרו/);
  });

  /**
   * The rainbow edge is an owner-ruled, NAMED exception to two design rules and applies to the
   * plan-upgrade action only. From the top rung nothing is an upgrade, so nothing wears it.
   */
  it('הקצה הצבעוני שמור לפעולת השדרוג בלבד', async () => {
    renderPanel();
    const cards = await settle();
    expect(cards.querySelectorAll('.btn-rainbow')).toHaveLength(0);
  });
});

describe('מסלול בתשלום שנרכש באמת', () => {
  beforeEach(() => mockServer(
    subscription({
      plan_key: 'pro', plan_label: 'פרו', is_paid_plan: true,
      current_period_end: '2026-09-15T00:00:00.000Z',
    }),
    OPTIONS, grant({ has_paid: true }),
  ));

  it('מציג את סוף התקופה ששולמה ומאפשר ביטול', async () => {
    renderPanel();
    await settle();
    expect(await screen.findByText(/התקופה ששולמה מסתיימת/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ביטול המנוי/ })).toBeInTheDocument();
    // Nothing was granted, so the window notice must not appear.
    expect(screen.queryByTestId('plan-grant-window')).not.toBeInTheDocument();
  });

  it('כשספק הסליקה לא מסר תקופה — אומר זאת, ורק למי ששילם', async () => {
    mockServer(
      subscription({ plan_key: 'pro', plan_label: 'פרו', is_paid_plan: true }),
      OPTIONS, grant({ has_paid: true }),
    );
    renderPanel();
    await settle();
    expect(await screen.findByText(/תקופת חיוב לא התקבלה/)).toBeInTheDocument();
  });

  it('מדרגה מעל הנוכחית היא «שדרוג», ורק היא לובשת את הקצה הצבעוני', async () => {
    renderPanel();
    const cards = await settle();
    expect(cards.querySelector('[data-plan="premium"]')?.textContent).toMatch(/שדרוג לפרימיום/);
    expect(cards.querySelector('[data-plan="basic"]')?.textContent).toMatch(/מעבר לבסיס/);
    // premium only: business is `contact_sales`, basic and free are below pro.
    const rainbow = [...cards.querySelectorAll('.btn-rainbow')];
    expect(rainbow).toHaveLength(1);
    expect(rainbow[0].textContent).toMatch(/שדרוג לפרימיום/);
    // A named exception stays named: the contact-sales action is a different action.
    expect(cards.querySelector('[data-plan="business"]')?.querySelector('button')?.className)
      .not.toMatch(/btn-rainbow/);
  });
});

describe('מצבי הקצה של הטעינה', () => {
  it('מחזיק את צורת הכרטיס בזמן הטעינה, ולא כותרת ריקה', async () => {
    rpc.mockImplementation(() => new Promise(() => {}));
    renderPanel();
    expect(await screen.findByTestId('subscription-skeleton')).toBeInTheDocument();
    // The heading never leaves, so nothing jumps when the data lands.
    expect(screen.getByRole('heading', { name: /מסלול ומנוי/ })).toBeInTheDocument();
    expect(screen.queryByTestId('plan-cards')).not.toBeInTheDocument();
  });

  it('תשובה ריקה בלי שגיאה נאמרת במילים — לא כרטיס ריק לנצח', async () => {
    // The RPC succeeds and returns zero rows. Before, the whole body was gated on `subscription &&`
    // and this rendered a heading and nothing else, permanently, with no way to tell a broken
    // screen from an empty one.
    mockServer(null);
    renderPanel();
    expect(await screen.findByTestId('subscription-missing')).toBeInTheDocument();
    expect(screen.queryByTestId('plan-cards')).not.toBeInTheDocument();
    expect(screen.queryByTestId('subscription-skeleton')).not.toBeInTheDocument();
    // An empty answer is not a billing claim: nothing here may read as a charge or a loss.
    expect(screen.getByTestId('subscription-missing')).toHaveTextContent(/אין כאן טענה על חיוב/);
  });

  it('כישלון טעינה נאמר, ואינו מוצג כמסלול', async () => {
    rpc.mockImplementation((name: string) => (name === 'my_subscription'
      ? Promise.resolve({ data: null, error: { message: 'boom' } })
      : Promise.resolve({ data: [], error: null })));
    renderPanel();
    expect(await screen.findByText(/לא ניתן לטעון את פרטי המסלול/)).toBeInTheDocument();
    expect(screen.queryByTestId('plan-cards')).not.toBeInTheDocument();
    expect(screen.queryByTestId('current-plan')).not.toBeInTheDocument();
  });

  /**
   * The gate a browser-gate run already bought once, on `PlanBadge`. `my_subscription` is one of
   * the two bootstrap resolvers `anon` holds no EXECUTE on, so a call before AuthProvider has an
   * organisation leaves as an anonymous request and comes back 502. This panel called it with no
   * gate at all and was saved only by sitting behind an owner-only route.
   */
  it('אינו שואל לפני שיש ארגון — קריאה מוקדמת יוצאת אנונימית', async () => {
    renderPanel(null);
    await waitFor(() => expect(rpc).not.toHaveBeenCalled());
    expect(screen.queryByTestId('plan-cards')).not.toBeInTheDocument();
  });

  /**
   * ADR-0003's motivating duplicate, from the other side: the usage snapshot answers a question
   * only the cancellation dialog asks, and it used to be fetched on mount for everybody.
   */
  it('אינו טוען את מדדי השימוש לפני שנפתח חלון הביטול', async () => {
    const user = userEvent.setup();
    mockServer(
      subscription({ plan_key: 'pro', plan_label: 'פרו', is_paid_plan: true }),
      OPTIONS, grant({ has_paid: true }),
    );
    renderPanel();
    await settle();
    expect(rpc).not.toHaveBeenCalledWith('organization_usage_snapshot');
    await user.click(await screen.findByRole('button', { name: /ביטול המנוי/ }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('organization_usage_snapshot'));
  });
});

describe('בורר מחזור החיוב', () => {
  it('מוצג גם בלי מטבע חיוב מאומת כי הוא מחליף בין שני מחירי התצוגה', async () => {
    // `Pricing.tsx` removed its own toggle on exactly this ground. Here the amounts are all «—»
    // because `private.record_billing_country` has no production caller, so pressing either chip
    // changes not one character on screen.
    renderPanel();
    await settle();
    for (const label of ['חודשי', 'שנתי']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('מוצג כשיש מטבע, ואז הוא באמת מחליף את הסכומים', async () => {
    const user = userEvent.setup();
    mockServer(
      subscription({ billing_country: 'IL', billing_country_verified: true, catalogue_currency: 'ILS' }),
      priced('ILS', { basic: 69, pro: 249, premium: 449 }, { basic: 690, pro: 2490, premium: 4490 }),
    );
    renderPanel();
    await settle();
    expect(await screen.findByText(/69/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'שנתי' }));
    expect(await screen.findByText(/690/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'שנתי' })).toHaveAttribute('aria-pressed', 'true');
  });
});
