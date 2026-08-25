import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthContext';

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
  const isOwner = profile?.role === 'owner';
  const [plan, setPlan] = useState<SubscriptionSummary | null>(null);

  useEffect(() => {
    if (!isOwner) { setPlan(null); return; }
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase.rpc('my_subscription');
      if (cancelled || error) return;
      setPlan(((data ?? []) as SubscriptionSummary[])[0] ?? null);
    })();
    return () => { cancelled = true; };
  }, [isOwner]);

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
