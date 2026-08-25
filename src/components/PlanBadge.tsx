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
 * The five rungs of #194 mapped to the four looks the owner asked for. `business` reuses the gold:
 * it sits ABOVE premium on the ladder, so anything quieter would read as a demotion, and inventing
 * a sixth treatment would put a mark on screen that the ladder has no vocabulary for.
 */
const TIER_CLASS: Record<string, string> = {
  free: 'plan-badge-free',
  basic: 'plan-badge-basic',
  pro: 'plan-badge-pro',
  premium: 'plan-badge-premium',
  business: 'plan-badge-premium',
};

export function PlanBadge() {
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
  const tierClass = TIER_CLASS[plan.plan_key];
  if (!tierClass) return null;

  return (
    <Link to="/settings/subscription" data-testid="plan-badge" data-plan={plan.plan_key}
      className={`plan-badge ${tierClass}`}
      aria-label={`המנוי שלי — ${plan.plan_label}`} title={`המנוי שלי — ${plan.plan_label}`}>
      {plan.plan_label}
    </Link>
  );
}
