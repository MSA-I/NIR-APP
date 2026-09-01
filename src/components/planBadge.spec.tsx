import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { PlanBadge, planTierClass } from './PlanBadge';

/**
 * The tier mark in the phone top bar (owner report 25.08.2026).
 *
 * Three things this file exists to keep true, each of which the obvious implementation gets wrong:
 *   1. It asks the SERVER which plan it is on. It no longer takes the server's WORD for it, and
 *      that changed on 31.08.2026: `plan_label` arrives spelled in Hebrew, so an English header
 *      wore «פרימיום» (OPEN-DECISIONS #303). `usePlanCatalogue()` resolves `plan_key` against the
 *      dictionary instead.
 *
 *      The objection this line used to make is the right one and is now ANSWERED rather than
 *      ignored. "A local map of rung names would be a second catalogue, and the day a label
 *      changes in `subscription_plans` the chrome would quietly keep the old word" — so
 *      `npm run check:plan-labels` parses the seeding migrations and FAILS on that day, and an
 *      unmapped key still renders the label the server sent. The map is second wording; it is not
 *      an unchecked one. (It caught a real drift on its first run: 0251 renamed the page quota
 *      away from the word OCR and this copy had the pre-rename text.)
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

const renderCompact = () => render(
  <MemoryRouter><OrgScopeProvider org="org-1"><PlanBadge compact /></OrgScopeProvider></MemoryRouter>,
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
      // Its OWN face since 31.08.2026. It wore premium's while the chips were three metals and
      // there was no fourth for it to wear — reuse was the only way for the top rung not to read
      // as a demotion. The card's five faces gave it a violet of its own, and the owner asked for
      // the chips to follow the cards, so the borrowing ended with the reason for it.
      ['business', 'ביזנס', 'plan-badge-business'],
    ] as const) {
      rpc.mockResolvedValue(plan(key, label));
      const { unmount } = renderBadge();
      const badge = await screen.findByTestId('plan-badge');
      expect(badge).toHaveTextContent(label);
      // The CHIP wears the metal; the LINK around it is only the tap target.
      expect(screen.getByTestId('plan-badge-chip').className).toContain(css);
      unmount();
    }
  });

  it('הוא הכניסה למסך המנוי', async () => {
    renderBadge();
    expect(await screen.findByTestId('plan-badge'))
      .toHaveAttribute('href', '/settings/subscription');
  });

  /**
   * The audit measured the chip at ~26px inside a row of 44px controls — both hard to hit and a
   * visible break in the cluster. The height belongs on the LINK: growing the pill itself would
   * produce a badge shaped like a button, which is why the two are separate elements.
   */
  it('שטח הנגיעה הוא הקישור, לא הצ׳יפ', async () => {
    renderBadge();
    const trigger = await screen.findByTestId('plan-badge');
    expect(trigger.className).toContain('plan-badge-trigger');
    expect(trigger.className).not.toContain('plan-badge-free');
    expect(screen.getByTestId('plan-badge-chip').className).not.toContain('plan-badge-trigger');
  });

  /**
   * `compact` is the mark ON A TEXT LINE — the dashboard greeting and the phone header's subtitle
   * — where the trigger's 44px floor punches a hole through a 20px line.
   *
   * Two files were reaching through this component to do it with
   * `[&_.plan-badge-trigger]:min-h-0`, and a rule written twice is a rule that drifts. The prop
   * also does what neither copy could: an outside override can only SUBTRACT the inflation, so it
   * left the target at whatever the label happened to measure. The chip carries its own 24×24
   * floor here — WCAG 2.5.8 Target Size (Minimum), AA.
   */
  it('`compact` מוריד את רצפת ה-44px מהקישור ומצמיד לצ׳יפ רצפת 24×24', async () => {
    renderCompact();
    const trigger = await screen.findByTestId('plan-badge');
    const chip = screen.getByTestId('plan-badge-chip');
    // The 44px inflation is off the LINK…
    expect(trigger.className).toContain('min-h-0');
    expect(trigger.className).toContain('min-w-0');
    // …and the floor moved onto the CHIP rather than disappearing.
    expect(chip.className).toContain('min-h-6');
    expect(chip.className).toContain('min-w-6');
    // The mark is still the mark, and still the way in.
    expect(trigger.className).toContain('plan-badge-trigger');
    expect(chip.className).toContain('plan-badge-free');
    expect(trigger).toHaveAttribute('href', '/settings/subscription');
    expect(trigger).toHaveAccessibleName('המנוי שלי — חינם');
  });

  it('ברירת המחדל אינה נוגעת ברצפת המגע של שורת הפעולות', async () => {
    renderBadge();
    const trigger = await screen.findByTestId('plan-badge');
    expect(trigger.className).toBe('plan-badge-trigger');
    expect(screen.getByTestId('plan-badge-chip').className).not.toContain('min-h-6');
  });

  /**
   * `aria-label` and `title` used to carry the identical string, which a screen reader announces
   * once as the name and again as the description. The label survives because it says what the mark
   * DOES; the tooltip repeated a word already legible in the chip.
   */
  it('נקרא פעם אחת — שם נגיש אחד ולא תיאור שמכפיל אותו', async () => {
    renderBadge();
    const trigger = await screen.findByTestId('plan-badge');
    expect(trigger).toHaveAccessibleName('המנוי שלי — חינם');
    expect(trigger).not.toHaveAttribute('title');
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

/**
 * ONE MAP, ONE FALLBACK — DESIGN.md:503, which says the mark a person taps in the header is the
 * mark they find on their own row in the plans screen.
 *
 * The table used to exist twice, character for character, here and in `OrgSubscriptionPanel`. The
 * copies were identical in the five rungs they both knew and DIFFERENT where it counts: an
 * unrecognised key rendered nothing here and a `plan-badge-free` chip there — so `legacy`, the
 * pre-cutover holding pen (#164), would have been advertised on one surface as if it were the free
 * plan. The export is what makes a second copy impossible; this is what pins the fallback.
 */
describe('מפת המדרגות המשותפת', () => {
  /*
   * `business` USED to reuse premium's mark, and this test asserted it. It stopped on 31.08.2026:
   * the three metals became the card's five faces and business gained a colour of its own, so the
   * reuse would now show two different plans wearing one mark. The assertion is inverted rather
   * than deleted — that the two are DISTINCT is the fact worth pinning, and a silent re-borrow is
   * exactly the regression this file exists to catch.
   */
  it('נותנת חזות לכל מדרגה בסולם, ולכל אחת חזות משלה', () => {
    expect(planTierClass('free')).toBe('plan-badge-free');
    expect(planTierClass('basic')).toBe('plan-badge-basic');
    expect(planTierClass('pro')).toBe('plan-badge-pro');
    expect(planTierClass('premium')).toBe('plan-badge-premium');
    expect(planTierClass('business')).toBe('plan-badge-business');
    expect(planTierClass('business')).not.toBe(planTierClass('premium'));
    // Five rungs, five distinct faces — no two of them share one.
    const faces = ['free', 'basic', 'pro', 'premium', 'business'].map((k) => planTierClass(k));
    expect(new Set(faces).size).toBe(5);
  });

  it('מדרגה שאין לה חזות אינה לובשת חזות מושאלת', () => {
    expect(planTierClass('legacy')).toBeNull();
    expect(planTierClass('whatever')).toBeNull();
  });
});
