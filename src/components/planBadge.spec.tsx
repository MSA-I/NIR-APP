import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { PlanBadge } from './PlanBadge';

/**
 * The tier mark in the phone top bar (owner report 25.08.2026).
 *
 * Three things this file exists to keep true, each of which the obvious implementation gets wrong:
 *   1. It asks the SERVER which plan and what to call it. A local map of rung names would be a
 *      second catalogue, and the day a label changes in `subscription_plans` the chrome would
 *      quietly keep the old word.
 *   2. It is silent, not «—», when there is no answer. The dash rule is for a measurement someone
 *      asked for; a permanent dash in the top bar is just an unexplained mark.
 *   3. It is owner-only, matching the screen it opens.
 */
const rpc = vi.fn();
vi.mock('../lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => rpc(...args) } }));

let role = 'owner';
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ profile: { role, org_id: 'org-1' } }),
}));

const plan = (plan_key: string, plan_label: string) => ({
  data: [{ plan_key, plan_label }], error: null,
});

const renderBadge = (org: string | null = 'org-1') => render(
  <MemoryRouter><OrgScopeProvider org={org}><PlanBadge /></OrgScopeProvider></MemoryRouter>,
);

beforeEach(() => {
  role = 'owner';
  rpc.mockResolvedValue(plan('free', 'חינם'));
});

describe('תג דרגת המנוי', () => {
  it('לובש חזות משלו לכל מדרגה, ונושא את השם שהשרת נתן לה', async () => {
    for (const [key, label, css] of [
      ['free', 'חינם', 'plan-badge-free'],
      ['basic', 'בסיס', 'plan-badge-basic'],
      ['pro', 'פרו', 'plan-badge-pro'],
      ['premium', 'פרימיום', 'plan-badge-premium'],
      // Above premium on the ladder, so it wears the gold rather than a quieter sixth treatment
      // that would read as a demotion.
      ['business', 'ביזנס', 'plan-badge-premium'],
    ] as const) {
      rpc.mockResolvedValue(plan(key, label));
      const { unmount } = renderBadge();
      const badge = await screen.findByTestId('plan-badge');
      expect(badge).toHaveTextContent(label);
      expect(badge.className).toContain(css);
      unmount();
    }
  });

  it('הוא הכניסה למסך המנוי', async () => {
    renderBadge();
    expect(await screen.findByTestId('plan-badge'))
      .toHaveAttribute('href', '/settings/subscription');
  });

  it('אינו מוצג למי שאינו בעלים, ואינו שואל את השרת בכלל', async () => {
    role = 'office';
    renderBadge();
    await waitFor(() => expect(rpc).not.toHaveBeenCalled());
    expect(screen.queryByTestId('plan-badge')).toBeNull();
  });

  /**
   * The gate a browser-gate run bought. `profile.role` can be 'owner' before the Supabase client
   * has a session attached, and `my_subscription` is one of the two bootstrap resolvers `anon`
   * holds no EXECUTE on -- so an early call left as an anonymous request and came back 502. The
   * org scope is null until AuthProvider has an organisation, which is the same gate
   * `useFeatureFlags` uses and documents.
   */
  it('אינו שואל לפני שיש ארגון — קריאה מוקדמת יוצאת אנונימית', async () => {
    renderBadge(null);
    await waitFor(() => expect(rpc).not.toHaveBeenCalled());
    expect(screen.queryByTestId('plan-badge')).toBeNull();
  });

  it('שותק כשאין תשובה — לא «—» ולא מדרגה שהומצאה', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    renderBadge();
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(screen.queryByTestId('plan-badge')).toBeNull();
    expect(screen.queryByText('—')).toBeNull();
  });

  it('אינו מפרסם את `legacy` — זו לא מדרגה שלקוח נמצא בה', async () => {
    rpc.mockResolvedValue(plan('legacy', 'מסלול קודם'));
    renderBadge();
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(screen.queryByTestId('plan-badge')).toBeNull();
  });
});
