import { CreditCard } from 'lucide-react';
import { PageHeader } from '../components/ui';
import { OrgSubscriptionPanel } from '../components/OrgSubscriptionPanel';
import { PlanLimitNote } from '../components/PlanLimitNote';

/**
 * The subscription its own screen (owner report 25.08.2026: "צריך ליצור קטגוריה בפני עצמה בתפריט
 * עבור ניהול המנוי והאופציה לשדרג").
 *
 * It is a MOVE, not a rewrite. `OrgSubscriptionPanel` already held the whole contract — what the
 * organization is on, what else exists, what a downgrade costs, and the four rules that keep this
 * surface from claiming money moved. It was mounted eight cards deep inside "הגדרות מערכת", where
 * "the plan I am on" is a thing you find by scrolling past VAT rates and the logo uploader. The
 * panel is unchanged in what it is allowed to say; only its address changed.
 *
 * Owner-only, matching the mount it came from (owner decision 23.08.2026) and the route guard.
 * `office` and `accountant` still meet quota facts where quotas actually bite — the documents
 * gallery — rather than on a commercial screen they cannot act on.
 *
 * The usage note is here rather than inside the panel because it answers a different question.
 * The panel says what each rung includes; `PlanLimitNote` says how much of THIS period is gone,
 * and only once that is worth saying (60%, #202). Below the threshold it renders nothing, which
 * is the right amount of screen for "you are nowhere near the limit".
 */
export default function Subscription() {
  return (
    <div className="max-w-4xl space-y-5">
      {/* No `meta`: `PageHeader` already prints the route's own description from the shared
          catalogue, and a second line saying the same thing in different words was exactly the
          cramped duplicated prose this package went out to remove. */}
      <PageHeader title={<span className="flex items-center gap-2"><CreditCard size={22} /> המנוי שלי</span>} />
      <PlanLimitNote metricKey="documents.monthly" />
      <OrgSubscriptionPanel />
    </div>
  );
}
