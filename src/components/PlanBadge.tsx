import { useT } from '../lib/i18n/LocaleProvider';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthContext';
import { useOrgScope } from '../lib/query/orgScope';

/**
 * Which plan this business is on, worn in the phone top bar (owner report 25.08.2026).
 *
 * OWNER ONLY, and the same boundary the subscription panel already draws (owner decision
 * 23.08.2026): the commercial plan is the owner's business. `office` and `accountant` see quota
 * facts where quotas bite — the documents gallery — and never a tier mark they cannot act on.
 *
 * IT READS `my_subscription()`, NOT THE ORGANIZATION. `Organization` deliberately carries no plan
 * field: the subscription is a read model assembled from `organization_subscriptions`, the plan
 * catalogue and the billing boundary, and copying its key onto the org object would create a
 * second answer that drifts. One RPC, one truth. `plan_label` comes from the server too, so the
 * Hebrew rung names live in `subscription_plans` and not in this file.
 *
 * IT WAITS FOR THE TENANT SCOPE, NOT FOR A ROLE, and that distinction cost a browser-gate run.
 * The first version fired as soon as `profile.role === 'owner'`, which is true before the Supabase
 * client necessarily has a session attached — so the call could leave as an ANONYMOUS request to a
 * function `anon` holds no EXECUTE on. In CI that surfaced as `HTTP 502` on `my_subscription` in
 * three scenarios, alongside one on `resolve_feature_flags`: the only two bootstrap resolvers with
 * exactly that grant shape. `useFeatureFlags` had already written the rule down —
 * "calling a tenant resolver before auth bootstrap completes creates an anonymous 401" — and this
 * component simply did not follow it. `useOrgScope()` is the same gate, from the same place, and it
 * is null until AuthProvider has an organisation.
 *
 * WHY THIS ONE READ IS STILL NOT ON THE SHARED CACHE, while the subscription screen's are. This
 * component is mounted by the app shell on every route, and `useQuery` from TanStack throws
 * outright when no `QueryClientProvider` is above it — `enabled: false` does not save it, because
 * the client is read before the option is considered. Three `Layout` specs render the shell without
 * one, and they belong to another surface this wave. The duplicate this leaves is one
 * `my_subscription()` call on one screen, on phones only; the duplicate that actually mattered —
 * `organization_usage_snapshot()` fetched twice on the subscription screen, the motivating example
 * in ADR-0003 — is gone. Converting this component is a one-line change plus a provider in those
 * three files, and it should happen the moment they are free.
 *
 * SILENCE, NOT «—», WHEN THERE IS NO ANSWER. The dash rule ("a metric with no data shows —, never
 * 0") is about a MEASUREMENT the reader asked for. Nobody asked this chrome a question, so a dash
 * in the top bar would be a permanent unexplained mark rather than an honest blank. `legacy` is
 * hidden for the same reason: it is not a rung a customer is on, it is the pre-cutover holding
 * pen (#164), and naming it in the chrome would advertise an internal state.
 */
interface SubscriptionSummary {
  plan_key: string;
  plan_label: string;
}

/**
 * The five rungs of #194 mapped to the three metals of the owner's SECOND ruling of 26.08.2026:
 * `basic` silver, `pro` OCEANIC, `premium` onyx — and the travelling sheen moved up to premium with
 * it. Gold left the ladder entirely: it was the one warm note in an Onyx / Wheat / Oceanic wrapper
 * and it read as a sticker rather than as a rung. The three now run cool-neutral → brand → ink,
 * which is the journey the product itself makes. `business` reuses the top rung — it sits ABOVE
 * premium on the ladder, so anything quieter would read as a demotion, and inventing a sixth
 * treatment would put a mark on screen the ladder has no vocabulary for. `free` stays quiet paper.
 *
 * ONE MAP, EXPORTED, WITH ONE FALLBACK — and the fallback is the reason it is exported. This table
 * used to exist twice, character for character, here and in `OrgSubscriptionPanel`, and the two
 * copies had already drifted where it counts: an unrecognised key rendered NOTHING here and a
 * `free` chip there. DESIGN.md:503 requires the mark a person taps in the header to be the mark
 * they then find on their own row in the plans screen, and two answers to "what does an unknown
 * rung look like" is exactly how that promise breaks — `legacy` would have been advertised on one
 * surface as if it were the free plan. `planTierClass` returns `null` for a rung with no look, and
 * both surfaces treat that the same way: no tier mark at all, never a borrowed one.
 */
export const TIER_CLASS: Record<string, string> = {
  free: 'plan-badge-free',
  basic: 'plan-badge-basic',
  pro: 'plan-badge-pro',
  premium: 'plan-badge-premium',
  business: 'plan-badge-premium',
};

/** The single fallback: a rung the ladder has no look for wears no mark. */
export const planTierClass = (planKey: string): string | null => TIER_CLASS[planKey] ?? null;

export function PlanBadge({ compact = false }: {
  /**
   * THE MARK ON A TEXT LINE, not in a row of targets.
   *
   * `.plan-badge-trigger` inflates the LINK to a 44px touch floor, and that floor is right where
   * it was written: the phone ACTION ROW, where the chip stood among other 44px controls and a
   * 26px one was both hard to hit and a visible break in the cluster. The mark now also sits
   * INLINE on a 20px text line — the dashboard greeting and the phone header's subtitle — and a
   * 44px floor on a 20px line punches a 24px hole through it.
   *
   * `compact` drops the LINK's inflation and pins the CHIP's own hit area instead: `min-h-6
   * min-w-6` is 24×24 CSS px — WCAG 2.5.8 Target Size (Minimum), AA. The link, its `href` and its
   * accessible name are untouched; this changes geometry and nothing else.
   *
   * 24 IS THE FLOOR, AND TODAY IT NEVER BINDS — which is the point of it rather than an argument
   * against it. Measured against the built stylesheet: `.plan-badge-free` is flat paper and comes
   * out at exactly 24.0 tall, while `basic`, `pro` and `premium` each carry
   * `border: 1px solid var(--color-tier-*-deep)` — the shadowed edge that makes the three read as
   * metal — and measure 26.0. On width the narrowest rung name in the catalogue is «פרו» at 39.4,
   * and even a synthetic one-glyph label measures 29.8. So nothing #194 can name is actually
   * raised by this floor: it is a REGRESSION GUARD pinning the AA minimum against a future
   * padding, font or border change, not a constraint doing work now. An earlier draft of this
   * comment justified it with "a one-glyph rung name would fall under the floor" — that was never
   * measured, and it is wrong.
   *
   * AND 24 IS NOT THE CHIP'S HEIGHT. `free` is 24, the three metals are 26, and that 2px will bite
   * whoever aligns to a single number. `TIER_CLASS` below compounds the same trap on WIDTH:
   * `business` and `premium` deliberately map to ONE look, but width comes from the LABEL, so
   * «ביזנס» measures 49.3 and «פרימיום» 62.9 — a HIGHER rung with a NARROWER chip. Never read a
   * dimension off the CSS class; measure the element.
   *
   * IT IS A PROP AND NOT A REACH-IN, and that is the whole point of adding it. `Layout.tsx` and
   * `Dashboard.tsx` each carried
   * `[&_.plan-badge-trigger]:min-h-0 [&_.plan-badge-trigger]:min-w-0` — the same override, written
   * twice, reaching through this component into a class it does not own. Two copies of a rule is
   * how one of them drifts, and neither copy could have pinned the 24px floor the way this does:
   * an outside override can only subtract the inflation, it cannot add the guarantee back.
   */
  compact?: boolean;
} = {}) {
  const { t } = useT();
  const { profile } = useAuth();
  const org = useOrgScope();
  const isOwner = profile?.role === 'owner';
  const [plan, setPlan] = useState<SubscriptionSummary | null>(null);

  useEffect(() => {
    if (!isOwner || org === null) { setPlan(null); return; }
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase.rpc('my_subscription');
      if (cancelled || error) return;
      setPlan(((data ?? []) as SubscriptionSummary[])[0] ?? null);
    })();
    return () => { cancelled = true; };
  }, [isOwner, org]);

  if (!isOwner || !plan) return null;
  const tierClass = planTierClass(plan.plan_key);
  if (!tierClass) return null;

  return (
    // The TAP TARGET is the link, the CHIP is the span inside it. The audit measured the mark at
    // ~26px in a row of 44px controls — both hard to hit and a visible break in the cluster — and
    // the obvious fix, growing the chip, would have produced a badge shaped like a button. So the
    // height lives on the link and the pill is untouched.
    //
    // ONE ACCESSIBLE NAME, NOT TWO. `aria-label` and `title` carried the identical string, which a
    // screen reader announces as a name and then again as a description. The label stays because it
    // says what the mark DOES (opens my subscription); the tooltip repeating it added nothing a
    // sighted user could not already read in the chip.
    <Link to="/settings/subscription" data-testid="plan-badge" data-plan={plan.plan_key}
      data-compact={compact ? '' : undefined}
      // `min-h-0` beats `.plan-badge-trigger`'s `min-h-11` on layer order alone — the trigger is a
      // `@layer components` rule and these are utilities, which Tailwind v4 emits after it. No
      // `!`, and no arbitrary-variant reach-in from outside.
      className={`plan-badge-trigger${compact ? ' min-h-0 min-w-0' : ''}`}
      aria-label={t('planBadge.ariaLabel', { plan: plan.plan_label })}>
      <span data-testid="plan-badge-chip"
        // `justify-center` so a label narrower than 24px sits in the middle of its floor rather
        // than against the start edge; `badge` already centres vertically.
        className={`plan-badge ${tierClass}${compact ? ' min-h-6 min-w-6 justify-center' : ''}`}>
        {plan.plan_label}
      </span>
    </Link>
  );
}
