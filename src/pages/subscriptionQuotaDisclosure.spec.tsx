/**
 * `OWN-06` and the `/settings` half of `ASSIST-03` — the screen that promises a meter, and the
 * metered feature that has none.
 *
 * WHAT THE SWEEP MEASURED (04.09.2026, screenshot `42-subscription.png`). The header of
 * `/settings/subscription` says, in the route catalogue's own words, «המסלול שהעסק נמצא בו, מה
 * כולל כל אחד מהמסלולים, וכמה מהמכסה נוצל בתקופה הזו» — three promises. The page then rendered the
 * plan badge and the five-rung ladder and stopped. There was no consumption figure anywhere in the
 * page text, and the organisation's own rung — `legacy`, «לקוח ותיק» — is not one of the five
 * cards, so the second promise had nothing to answer it either.
 *
 * AND THE ASSISTANT IS THE SHARPEST CASE OF THE SAME GAP. It is metered at 20–70 questions per
 * period and its ceiling appeared nowhere in the product: not on `/pricing`, not here, and the
 * only sentence a person ever saw about it was the refusal itself. A meter that exists only at the
 * moment of refusal is not a meter.
 *
 * WHAT THIS FILE ASSERTS, AND WHY EACH LINE IS THE HONEST FORM OF IT:
 *
 *   * The period's consumption is on the screen, from `organization_usage_snapshot()` — the read
 *     model that already exists, is already granted to `authenticated`, and is already fetched by
 *     the cancellation dialog on this very screen. Nothing new is asked of the server.
 *   * The assistant appears in that list BY NAME, so the manager can see what the metered feature
 *     costs him before he hits the wall (§12).
 *   * An unmeasured ceiling renders «—» and NEVER `0`. The fixture below is the exact organisation
 *     the sweep measured: on `legacy`, whose `assistant_runs.monthly` resolves unmeasured, with 37
 *     questions actually counted this period. «0 מתוך 50» would be a claim about the customer's
 *     behaviour; «37» beside «—» is the truth about ours.
 *   * What the organisation actually receives is listed from `my_entitlements()` — the resolver
 *     that answers for the caller's OWN organisation, override over plan over nothing. That is the
 *     only source that can describe a rung with no card, which is why the second promise is
 *     answered from there rather than from the ladder.
 *
 * WHAT IT DELIBERATELY DOES NOT ASSERT. Not the `/pricing` plan cards: publishing the assistant
 * quota per rung means widening `get_public_plan_quotas()`'s three-key publish list, which is a
 * migration, and `ASSIST-03` stays open on that half. Not the intro allowance: while an
 * introductory window is open the binding ceiling comes from `private.assistant_effective_quota`,
 * which no read model exposes — that is `ASSIST-10`'s mechanism and its migration.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { ToastProvider } from '../components/ui';

const rpc = vi.fn();
const invoke = vi.fn();
vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    functions: { invoke: (...args: unknown[]) => invoke(...args) },
  },
}));

import Subscription from './Subscription';

/** The rung the sweep's organisation is on. It is retired, so it appears in no ladder. */
const SUBSCRIPTION = {
  plan_key: 'legacy',
  plan_label: 'לקוח ותיק',
  is_paid_plan: true,
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
};

const OPTIONS = [
  { plan_key: 'free', label: 'חינם', tier_order: 1, paid: false, contact_sales: false, currency: null, catalogue_version: null, monthly_amount: null, yearly_amount: null },
  { plan_key: 'premium', label: 'פרימיום', tier_order: 4, paid: true, contact_sales: false, currency: null, catalogue_version: null, monthly_amount: null, yearly_amount: null },
];

/**
 * `organization_usage_snapshot()` as `private.usage_rows` builds it: `used` is the period counter
 * and exists whenever the metric is counted per period, while `measured` needs BOTH a known
 * entitlement and a counter. The assistant row is the pair that matters — a real count against an
 * unstated ceiling.
 */
const USAGE = [
  { metric_key: 'documents.monthly', label: 'מסמכים בחודש', unit: 'מסמכים', measure: 'per_period', used: 180, usage_limit: 200, unlimited: false, measured: true, remaining: 20, percent_used: 90, period_start: '2026-08-13T00:00:00.000Z', period_end: '2026-09-13T00:00:00.000Z', period_source: 'signup' },
  { metric_key: 'assistant_runs.monthly', label: 'שאלות עוזר בחודש', unit: 'שאלות', measure: 'per_period', used: 37, usage_limit: null, unlimited: false, measured: false, remaining: null, percent_used: null, period_start: '2026-08-13T00:00:00.000Z', period_end: '2026-09-13T00:00:00.000Z', period_source: 'signup' },
  { metric_key: 'users.max', label: 'משתמשים פעילים', unit: 'משתמשים', measure: 'concurrent', used: null, usage_limit: 5, unlimited: false, measured: false, remaining: null, percent_used: null, period_start: '2026-08-13T00:00:00.000Z', period_end: '2026-09-13T00:00:00.000Z', period_source: 'signup' },
];

/** `my_entitlements()` — the caller's own organisation, override over plan over nothing. */
const ENTITLEMENTS = [
  { entitlement_key: 'documents.monthly', kind: 'numeric', measure: 'per_period', unit: 'מסמכים', label: 'מסמכים בחודש', plan_key: 'legacy', subscription_status: 'active', source: 'plan', unlimited: false, numeric_limit: 200, boolean_value: null, measured: true },
  { entitlement_key: 'assistant_runs.monthly', kind: 'numeric', measure: 'per_period', unit: 'שאלות', label: 'שאלות עוזר בחודש', plan_key: 'legacy', subscription_status: 'active', source: 'unavailable', unlimited: false, numeric_limit: null, boolean_value: null, measured: false },
  { entitlement_key: 'bank.reconciliation', kind: 'boolean', measure: 'capability', unit: null, label: 'התאמות בנק', plan_key: 'legacy', subscription_status: 'active', source: 'override', unlimited: false, numeric_limit: null, boolean_value: true, measured: true },
];

beforeEach(() => {
  document.documentElement.lang = 'he';
  rpc.mockImplementation((name: string) => {
    if (name === 'my_subscription') return Promise.resolve({ data: [SUBSCRIPTION], error: null });
    if (name === 'my_upgrade_options') return Promise.resolve({ data: OPTIONS, error: null });
    if (name === 'my_plan_grant') {
      return Promise.resolve({
        data: { granted: false, ends_at: null, reverts_to_plan_key: 'free', reverts_to_label: 'חינם', has_paid: false },
        error: null,
      });
    }
    if (name === 'organization_usage_snapshot') return Promise.resolve({ data: USAGE, error: null });
    if (name === 'my_entitlements') return Promise.resolve({ data: ENTITLEMENTS, error: null });
    if (name === 'get_public_plan_quotas') return Promise.resolve({ data: [], error: null });
    if (name === 'my_plan_features') return Promise.resolve({ data: [], error: null });
    if (name === 'get_public_plan_catalogue') return Promise.resolve({ data: [], error: null });
    return Promise.resolve({ data: null, error: null });
  });
});

const testClient = () => new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: 0 } },
});

const renderScreen = () => render(
  <QueryClientProvider client={testClient()}>
    <OrgScopeProvider org="org-1">
      <ToastProvider>
        <MemoryRouter initialEntries={['/settings/subscription']}><Subscription /></MemoryRouter>
      </ToastProvider>
    </OrgScopeProvider>
  </QueryClientProvider>,
);

describe('/settings/subscription — the screen states what its header promises', () => {
  it('שמראה כמה מהמכסה נוצל בתקופה הזו, ולא רק את סולם המסלולים', async () => {
    renderScreen();
    const usage = await screen.findByTestId('period-usage');
    const documents = within(usage).getByTestId('period-usage-documents.monthly');
    expect(documents).toHaveTextContent('180');
    expect(documents).toHaveTextContent('200');
  });

  it('שמונה את העוזר בשמו — התכונה הנמדדת שלא הופיעה בשום מקום במוצר', async () => {
    renderScreen();
    const usage = await screen.findByTestId('period-usage');
    const assistant = within(usage).getByTestId('period-usage-assistant_runs.monthly');
    expect(assistant).toHaveTextContent('שאלות עוזר בחודש');
    // The count is real; the ceiling is not stated for this rung.
    expect(assistant).toHaveTextContent('37');
  });

  it('שמציג «—» ולא «0» לתקרה שאיש לא קבע', async () => {
    renderScreen();
    const usage = await screen.findByTestId('period-usage');
    const assistant = within(usage).getByTestId('period-usage-assistant_runs.monthly');
    expect(assistant).toHaveTextContent('—');
    expect(assistant.textContent).not.toMatch(/(^|\D)0(\D|$)/);
  });

  it('שמפרט מה הארגון מקבל בפועל, גם כשהמסלול שלו אינו אחד הכרטיסים', async () => {
    renderScreen();
    const includes = await screen.findByTestId('current-plan-includes');
    expect(within(includes).getByTestId('plan-includes-assistant_runs.monthly'))
      .toHaveTextContent('שאלות עוזר בחודש');
    expect(within(includes).getByTestId('plan-includes-documents.monthly'))
      .toHaveTextContent('200');
    // The rung itself is retired and has no card; the screen still names it.
    expect(screen.getByTestId('current-plan')).toHaveTextContent('לקוח ותיק');
  });
});
