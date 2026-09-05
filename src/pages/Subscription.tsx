import { useT } from '../lib/i18n/LocaleProvider';
import { CreditCard } from 'lucide-react';
import { ICON, PageHeader } from '../components/ui';
import { OrgSubscriptionPanel } from '../components/OrgSubscriptionPanel';
import { PlanLimitNote } from '../components/PlanLimitNote';
import { PlanUsagePanel } from '../components/PlanUsagePanel';
import { SupportContact } from '../components/SupportContact';

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
  const { t } = useT();
  return (
    /* `max-w-7xl`, and the width is the ladder's, not the prose's. At `4xl` five plan cards were
       178px wide on a laptop — narrower than the button inside them — which is half of why they
       read as boxes rather than as products. `6xl` (72rem) was enough while the ladder was a
       column of rows; the grid of 26.08.2026 needs five tracks side by side, and 80rem is what
       gives each of them ~14rem after the gaps. The state card and the usage note above still hold
       their own measure through their internal `card-pad`, so nothing else stretches. */
    <div className="max-w-7xl space-y-5">
      {/* No `meta`: `PageHeader` already prints the route's own description from the shared
          catalogue, and a second line saying the same thing in different words was exactly the
          cramped duplicated prose this package went out to remove. */}
      <PageHeader title={<span className="flex items-center gap-2"><CreditCard size={ICON.xl} /> {t('subscriptionPage.title')}</span>} />
      <PlanLimitNote metricKey="documents.monthly" />
      {/* THE THIRD PROMISE IN THE HEADER, ANSWERED — and answered BEFORE the ladder.
          `OWN-06`: the route description says this screen shows how much of the period's quota is
          used, and the page rendered a plan badge and five cards and stopped. It is above
          `OrgSubscriptionPanel` because §12 puts "what is my position right now" ahead of "what
          else could I buy", and because the ladder is five cards tall — a consumption figure below
          it is a figure nobody scrolls to. `PlanLimitNote` above it is not the same thing: that one
          speaks only past 60% and only about documents, which is the right amount of screen for a
          warning and no amount at all for a meter. */}
      <PlanUsagePanel />
      <OrgSubscriptionPanel />
      {/* Last, and muted. A customer reaches this screen to see what they are on and what else
          exists; the address they need if something looks wrong belongs after that answer, not
          competing with it. `billing` because this is the one screen where "who do I ask about a
          charge" is the likelier question. */}
      <SupportContact variant="billing" />
    </div>
  );
}
