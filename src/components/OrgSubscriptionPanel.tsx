import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CreditCard, Undo2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { fmtDate, fmtNum, fmtPlanPrice } from '../lib/format';
import { SUBSCRIPTION_STATUS } from '../lib/status';
import { DOMAIN, key } from '../lib/query/keys';
import { useOrgScope } from '../lib/query/orgScope';
import {
  HEADLINE_QUOTA_KEY, PLAN_TRAY, PlanTicket, PlanTicketSkeleton, RECOMMENDED_PLAN,
} from './PlanTicket';
import { usageSnapshotQuery, type UsageRow } from './PlanLimitNote';
import { ErrorNote, ICON, Modal, Note, Skeleton, StatusBadge } from './ui';

/**
 * The tenant's own subscription surface: what they are on, what else exists, and the three
 * lifecycle moves they are allowed to make. It is deliberately NOT a sales page.
 *
 * THE RULE THAT SHAPES EVERYTHING HERE: there is no purchase path, and that is deliberate.
 * OPEN-DECISIONS #217 and #224 say a paid entitlement opens on a SIGNED SERVER EVENT and on
 * nothing else. An earlier draft honoured that by sending the customer to a provider checkout and
 * then refusing to call the return a success. Paddle is ACCOUNT_NOT_PROVEN, no `billing-checkout`
 * function exists, and none is being built this wave — so the honest implementation is stronger
 * and simpler: THIS FILE INVOKES NO EDGE FUNCTION, renders no affordance that would start a
 * payment, and contains no wording that could be read as money having moved. A rule enforced by
 * the absence of a code path cannot be violated by a future edit to that path.
 *
 * THE OTHER FIVE RULES, each with the decision that forces it:
 *   * Currency is never guessed (#208). ILS or USD follows the billing country VERIFIED at the
 *     merchant of record — not an IP, not a picker. With no verified country there is no verified
 *     currency, so no amount is rendered at all and the ladder says where the amount IS given
 *     (`PRICE_AT_UPGRADE`; it was a `—` in each price slot until the owner's ruling of
 *     26.08.2026). Never `0`.
 *   * `ביזנס` is `דברו איתנו` and carries no figure (#194). The internal minimums of #201 are
 *     platform business and never reach a tenant screen.
 *   * A paid→paid tier or interval change lands AT THE NEXT RENEWAL with no proration (#216);
 *     cancellation lands at the end of the paid period and can be reversed until then (#219).
 *     Neither ever touches the usage period, which is anchored to signup (#242). The server
 *     transitions for all three do not exist yet, so the controls render DISABLED with the reason
 *     stated — visible per #204, which forbids hidden cancellation, and never silently no-op.
 *   * A failed renewal is read-only, not deletion and not a silent downgrade (#221), and the only
 *     way out is a successful signed payment event (#222). The notice says both halves, because a
 *     customer who is refused an upload will otherwise assume the worse one.
 *   * **A PLAN CAN BE GIVEN, AND THEN "PAID PLAN" STOPS MEANING "PAID FOR".** This one is new, and
 *     it is the correction that shaped this rewrite. `is_paid_plan` answers a question about the
 *     LADDER — is this rung above free — and until `0210` that happened to coincide with the
 *     question the customer's screen was actually asking. `0210` puts every organisation on
 *     `premium` until the window closes, so from the day it deploys every tenant answers true to
 *     `is_paid_plan` while not one of them has paid anything. Three branches here used to key off
 *     it and all three then lie: a person who never bought anything would be shown a billing
 *     period, told "תקופת חיוב לא התקבלה מספק הסליקה" — which reads as a payment failure — and
 *     offered a cancel button for a subscription that does not exist. They now key off
 *     `has_paid` from `my_plan_grant()` (0212), which is the existence of a real billing period
 *     and nothing softer. `is_paid_plan` keeps its own job: it still decides which rung this is.
 *
 * AND THE WINDOW IS SAID OUT LOUD. #276 makes the end of an introductory window a real reduction
 * in service and requires the screen to say, BEFORE it happens, what closes, when, and on which
 * plan it reopens — "הודעה שמגיעה אחרי הסגירה נקראת כתקלה". `0210` shipped the grant with no date
 * at all and no screen anywhere mentioning it; `0212` gives it an end date and `my_plan_grant()`
 * hands that date to the notice below.
 */
interface SubscriptionRow {
  plan_key: string;
  plan_label: string;
  is_paid_plan: boolean;
  status: string;
  billing_interval: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  scheduled_plan_key: string | null;
  scheduled_plan_label: string | null;
  scheduled_interval: string | null;
  scheduled_effective_at: string | null;
  delinquent: boolean;
  billing_country: string | null;
  billing_country_verified: boolean;
  catalogue_currency: string | null;
  /**
   * Whether the organization can acquire a paid plan at all. Delegated by `my_subscription()` to
   * `my_billing_availability()` so there is one derivation, and `0189` guarantees it is present
   * and non-null. It is ONE BOOLEAN on purpose: a customer may learn whether it can buy, never
   * which merchant of record we chose or that our KYC is unproven.
   *
   * It gates ACQUIRING a plan only. Cancellation and resume are never gated on it — #204 names
   * hidden cancellation alongside fake countdowns, and #219 grants the right unqualified. A
   * provider outage must not trap a paying customer.
   */
  billing_provider_enabled: boolean;
}

/**
 * `my_plan_grant()` (0212). Every key is always present and never null-by-absence, the same
 * contract `0189` wrote for `my_billing_availability()`: a missing key that a caller coalesces to
 * `false` would render an outage as a fact about the customer.
 */
interface PlanGrant {
  /** The current rung was GIVEN by the pre-launch window rather than bought. */
  granted: boolean;
  /** When the grant stops applying. Null whenever `granted` is false. */
  ends_at: string | null;
  /** The rung the organization returns to. Nothing is deleted at that boundary. */
  reverts_to_plan_key: string;
  reverts_to_label: string | null;
  /**
   * Whether a billing period was ever opened for this organization — the only honest reading of
   * "this customer has actually paid". `private.record_billing_period` is its sole writer, and it
   * is reached from a verified provider event or an operator command carrying a reason.
   */
  has_paid: boolean;
}

interface UpgradeOption {
  plan_key: string;
  label: string;
  tier_order: number;
  paid: boolean;
  contact_sales: boolean;
  currency: string | null;
  catalogue_version: string | null;
  monthly_amount: number | null;
  yearly_amount: number | null;
}

/**
 * What each rung includes, for the comparison the cards make. It comes from the SAME server
 * function the public ladder reads, which is the point: a second source would let the signed-in
 * comparison and the public one disagree, and the server already blanks anything nothing counts
 * (#199, DEBT §56) so a forgetful caller cannot publish a promise by accident.
 */
interface PlanQuotaRow {
  plan_key: string;
  entitlement_key: string;
  label: string;
  unit: string;
  unlimited: boolean;
  numeric_limit: number | null;
  measured: boolean;
}

/**
 * WHAT THE PRICE SLOT SAYS WHEN THERE IS NO PRICE TO PUT IN IT (owner ruling 26.08.2026).
 *
 * Every organization is in this state today, because `private.record_billing_country` (`0186:671`)
 * has no production caller, so no billing country is verified and #208 cannot decide which of the
 * two catalogues applies. The slot used to hold «—», and five of those stacked down the price
 * column read as a broken screen rather than as a figure being withheld.
 *
 * THE THREE THINGS THIS SENTENCE MAY NOT DO, and how it avoids each:
 *   * name or imply a number — it names none, and gives no range, no "from", no "starting at";
 *   * read as an error or a loading state — it describes a step in the purchase, not a failure,
 *     and nothing about it suggests a retry or a wait;
 *   * promise a price the product has not decided to show — it promises only that the amount is
 *     given at the moment of moving to a paid plan, which is #267's own sentence: «נמסר בתוך
 *     החשבון, בשלב המעבר למסלול בתשלום».
 *
 * #208's currency rule — ILS or USD by the billing country VERIFIED at the merchant of record,
 * never an IP and never a picker — is deliberately NOT repeated here. The availability notice
 * above the ladder states it once, in full; printing it again on every row is the cramped
 * duplicated prose this whole package went out to remove.
 */
const PRICE_AT_UPGRADE = 'המחיר נמסר במעבר למסלול בתשלום';

/**
 * THE LADDER'S ACTIONS NOW BELONG TO THE TICKET, and the two classes that used to live here are
 * gone with the card that wore them.
 *
 * `PLAN_ACTION_QUIET` (`btn-standby w-full`) and `PLAN_ACTION_UPGRADE` (`btn-rainbow`) were the
 * answer to an owner report of 26.08.2026 — the buttons read as broken — and the fix was to lift
 * `@utility btn`'s `disabled:opacity-50`, which was halving four disabled controls into grey. That
 * finding is still true and `.btn-standby` still carries it in `index.css` for every other surface.
 *
 * What changed on 27.08.2026 is the SURFACE UNDER the button. Both of those classes were measured
 * against `--color-surface`, a near-white card; three of the ticket's four faces are near black and
 * the fourth is cream, so neither figure transfers. `btn-rainbow` in particular was a named,
 * bounded exception granted for a promoted button sitting on paper — carrying it onto onyx would be
 * widening an exception by accident, which is how a named exception stops being bounded.
 *
 * The ticket's own pill is `.plan-card__cta` in `src/styles/plan-card.css`, next to the faces it is
 * measured against, and it is shared with the marketing site for the same reason the card is.
 */

const INTERVALS = [['monthly', 'חודשי'], ['yearly', 'שנתי']] as const;
type Interval = (typeof INTERVALS)[number][0];

const rows = async <T,>(name: string): Promise<T[]> => {
  const { data, error } = await supabase.rpc(name);
  if (error) throw new Error(error.message);
  return (data ?? []) as T[];
};

export function OrgSubscriptionPanel() {
  const org = useOrgScope();
  /**
   * THE GATE THAT A BROWSER-GATE RUN ALREADY PAID FOR ONCE. `my_subscription` is one of the two
   * bootstrap resolvers `anon` holds no EXECUTE on (`0186:820`), so calling it before AuthProvider
   * has an organisation leaves an ANONYMOUS request that can only come back 502. `PlanBadge` was
   * fixed and pinned; this panel called the identical RPC with no gate at all and was saved only by
   * sitting behind an owner-only route — which is a coincidence of routing, not a rule. Same gate,
   * same place, stated here so the next mount of this component inherits it.
   */
  const enabled = org !== null;
  const [intervalChoice, setIntervalChoice] = useState<Interval | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  const subscriptionQuery = useQuery({
    queryKey: key(org, DOMAIN.subscription, 'mine'),
    queryFn: () => rows<SubscriptionRow>('my_subscription'),
    enabled,
  });
  const optionsQuery = useQuery({
    queryKey: key(org, DOMAIN.subscription, 'upgrade-options'),
    queryFn: () => rows<UpgradeOption>('my_upgrade_options'),
    enabled,
  });
  const grantQuery = useQuery({
    queryKey: key(org, DOMAIN.subscription, 'grant'),
    queryFn: async (): Promise<PlanGrant | null> => {
      const { data, error } = await supabase.rpc('my_plan_grant');
      if (error) throw new Error(error.message);
      return (data ?? null) as PlanGrant | null;
    },
    enabled,
  });
  const quotasQuery = useQuery({
    queryKey: key(org, DOMAIN.subscription, 'plan-quotas'),
    queryFn: () => rows<PlanQuotaRow>('get_public_plan_quotas'),
    enabled,
  });
  /**
   * LAZY, and the dialog is the only reader. This snapshot answers "how much of the current period
   * is gone", which is #220's disclosure before a cancellation — a question most people on this
   * screen never ask. It used to be fetched on mount for everybody. The key is shared with
   * `PlanLimitNote`, which is mounted directly above this panel on the same screen, so when the
   * note has already asked, opening the dialog costs nothing at all.
   */
  const usageQuery = useQuery({ ...usageSnapshotQuery(org), enabled: enabled && confirmingCancel });

  const subscription = subscriptionQuery.data?.[0] ?? null;
  const options = optionsQuery.data ?? [];
  // A quota read that fails costs the cards one line each; it must not cost the whole panel.
  const planQuotas = quotasQuery.data ?? [];
  const grant = grantQuery.data ?? null;
  const loading = enabled && (subscriptionQuery.isLoading || optionsQuery.isLoading);
  const failed = !!(subscriptionQuery.error || optionsQuery.error);

  /**
   * `schedule_subscription_change`, `cancel_subscription_at_period_end` and `resume_subscription`
   * DO NOT EXIST. They need stored state on the subscription that the provider webhook must also
   * write, and that agent has stood down — building one half of a two-sided contract alone is the
   * failure mode this program has already paid for once. So there are no handlers here and no
   * call sites: an orphan RPC name in the source is a real defect, not a placeholder.
   */
  const currency = subscription?.billing_country_verified ? subscription.catalogue_currency : null;
  // The server's interval until the reader says otherwise. Derived rather than copied into state by
  // an effect: a second source of the same fact is a second thing that can be stale.
  const interval: Interval =
    intervalChoice ?? (subscription?.billing_interval === 'yearly' ? 'yearly' : 'monthly');
  const amountOf = (option: UpgradeOption) =>
    (interval === 'yearly' ? option.yearly_amount : option.monthly_amount);
  /** The rung this organization stands on, for "is that card up or down from here". */
  const currentTier = options.find((option) => option.plan_key === subscription?.plan_key)?.tier_order ?? null;
  /**
   * HAS THIS ORGANIZATION ACTUALLY PAID. Not "is it on a paid rung" — see the fifth rule above.
   * Defaults to false while the grant read is in flight or has failed, which is the direction that
   * cannot invent a customer: the worst case is that a genuinely paying customer briefly does not
   * see their period line, rather than a person who never paid being shown a billing failure.
   */
  const hasPaid = grant?.has_paid === true;
  /**
   * Three states, never two. "We could not determine" must not be rendered as "no" — the same
   * distinction the codebase already draws with `measured: false` → «—» rather than `0`. `0189`
   * forbids a missing or null key, so this branch is defence in depth rather than an expected path.
   */
  const availability: 'available' | 'unavailable' | 'indeterminate' =
    typeof subscription?.billing_provider_enabled !== 'boolean' ? 'indeterminate'
      : subscription.billing_provider_enabled ? 'available' : 'unavailable';

  return (
    /**
     * TWO REGIONS, NOT ONE CARD WITH EVERYTHING IN IT — and this is the structural half of the
     * owner's complaint about the plan cards.
     *
     * The whole panel used to be a single `.card`, so the ladder was five sunken boxes drawn
     * INSIDE a surface: a card within a card, which `ui.tsx` names as the thing that reads as two
     * objects, and the inner boxes could not carry elevation of their own because they were
     * already sitting on one. The plans have their own question — "what else is there" — so they
     * get their own region, and their cards are real cards on the canvas with the app's own
     * radius and shadow.
     *
     * The state of THIS organization's subscription — what it is on, what closes and when, what
     * it may cancel — stays in the card above them, because that is one subject and it is prose.
     */
    <div className="space-y-5">
      <section className="card card-pad space-y-4" aria-labelledby="org-subscription-heading">
        <h2 id="org-subscription-heading" className="section-title flex items-center gap-2">
          <CreditCard size={ICON.md} /> מסלול ומנוי
        </h2>

        {failed && <ErrorNote message="לא ניתן לטעון את פרטי המסלול כרגע." />}

        {/* THE LAYOUT, HELD, WHILE IT LOADS. The body used to be gated on `subscription &&` alone,
            so for the length of the fetch this card was a heading and nothing else — and then five
            plan cards arrived at once and shoved the page down. It also meant a zero-row answer
            with no error rendered that same blank for ever, with nothing telling the reader
            whether the screen was broken or merely empty. Both are answered below. The plan grid's
            own placeholder is a sibling of this card, mirroring where the real one lands. */}
        {loading && <StatusSkeleton />}

        {!loading && !failed && !subscription && (
          <Note tone="alert">
            <span className="min-w-0 flex-1" data-testid="subscription-missing">
              לא נמצאו פרטי מסלול לארגון הזה. אין כאן טענה על חיוב ולא נגרע דבר — זו הגדרה במערכת,
              ויש לפנות לתמיכה כדי להשלים אותה.
            </span>
          </Note>
        )}

        {subscription && (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span data-testid="current-plan" className="text-lg font-medium text-ink">
                {subscription.plan_label}
              </span>
              <StatusBadge meta={SUBSCRIPTION_STATUS[subscription.status]} />
              {/* `hasPaid`, not `is_paid_plan`. Without it, `0210`'s grant shows every organization
                  either a paid period they never bought or a sentence about the payment provider
                  failing to send one. */}
              {subscription.is_paid_plan && hasPaid && (
                <span className="text-sm text-ink-muted">
                  {subscription.current_period_end
                    ? `התקופה ששולמה מסתיימת ב־${fmtDate(subscription.current_period_end)}`
                    : 'תקופת חיוב לא התקבלה מספק הסליקה'}
                </span>
              )}
            </div>

            {/* THE WINDOW, SAID BEFORE IT CLOSES (#276, and `0212` for the date).
                Four facts and no fifth: what the organization holds, that it was given rather than
                bought, until when, and what it becomes afterwards. No countdown — #204 forbids one
                — and no capability list, because #274's feature ladder is `NOT_IMPLEMENTED` and the
                only difference the server enforces between these rungs today is the published quota
                (#266). Promising that exports or bank reconciliation "close" would be selling a
                difference nothing enforces. */}
            {grant?.granted && (
              <Note tone="info">
                <span className="min-w-0 flex-1" data-testid="plan-grant-window">
                  מסלול {subscription.plan_label} ניתן לארגון ללא תשלום לתקופת ההרצה שלפני ההשקה,
                  והוא בתוקף עד {fmtDate(grant.ends_at)}. לא בוצע חיוב, לא נדרש אמצעי תשלום ולא
                  נפתחה תקופת חיוב.
                  {grant.reverts_to_label
                    ? ` במועד הזה הארגון עובר למסלול ${grant.reverts_to_label}, ומכסות אותו מסלול הן שיחולו מאותו רגע.`
                    : ' במועד הזה הארגון עובר למסלול הבסיסי, ומכסותיו הן שיחולו מאותו רגע.'}
                  {' '}שום נתון אינו נמחק וכל מה שנקלט נשאר במקומו; תקופת השימוש והמונים אינם מתאפסים.
                </span>
              </Note>
            )}

            {subscription.delinquent && (
              <Note tone="alert" role="alert">
                <span className="min-w-0 flex-1">
                  חיוב החידוש לא נגבה, והארגון נמצא במצב קריאה בלבד: אפשר לצפות, לייצא ולהוריד, אך
                  עיבוד, העלאה וכתיבה חדשה חסומים. היציאה ממצב זה היא אך ורק באמצעות אירוע תשלום
                  מוצלח וחתום מספק הסליקה — אין מעבר אוטומטי למסלול חינם, אין יציאה אוטומטית בחלוף
                  הזמן, ושום נתון קיים אינו נמחק.
                </span>
              </Note>
            )}

            {/* Wording provisional under #203. One boolean in, three sentences out — and the third
                is the one that matters: an unknown availability is said aloud, never rendered as a
                refusal. Nothing here names the provider or hints why it is not ready.

                THE PRICE SENTENCE LIVES HERE NOW, not in a second box (owner report 25.08.2026:
                the settings screen read as cramped duplicated prose). On a Free organization with
                no verified billing country BOTH notices used to render, one under the other, and
                they were two halves of the same fact: nothing can be bought yet, and that is why
                the amounts are dashes. Said once. */}
            <Note tone={availability === 'unavailable' ? 'info' : 'idle'}>
              <span className="min-w-0 flex-1" data-testid="billing-availability">
                {availability === 'unavailable'
                  && 'רכישת מסלול בתשלום אינה זמינה עדיין. אפשר להמשיך לעבוד במסלול הנוכחי; כשהרכישה תיפתח היא תופיע כאן.'}
                {availability === 'available'
                  && 'רכישת מסלול בתשלום עדיין אינה מתבצעת מהמסך הזה. הפרטים והמכסות למטה מעודכנים.'}
                {availability === 'indeterminate'
                  && 'לא ניתן לקבוע כרגע אם רכישת מסלול זמינה. זה אינו אומר שהיא חסומה — רענון או ניסיון מאוחר יותר יראה את המצב העדכני.'}
                {!currency && ' המחיר נקבע במטבע של כתובת החיוב המאומתת אצל ספק הסליקה — לא לפי מיקום משוער ולא לפי בחירת מטבע — ולכן הוא נמסר במעבר למסלול בתשלום ולא מוצג כאן מראש.'}
              </span>
            </Note>

            {subscription.scheduled_plan_key && (
              <Note tone="info">
                <span className="min-w-0 flex-1">
                  המעבר ל{subscription.scheduled_plan_label} ייכנס לתוקף בחידוש הבא
                  {subscription.scheduled_effective_at ? `, ב־${fmtDate(subscription.scheduled_effective_at)}` : ''},
                  ללא חישוב יחסי ובלי חיוב באמצע התקופה. עד אז המסלול הנוכחי ותנאיו נשארים בתוקף,
                  ותקופת השימוש והמונים אינם מושפעים.
                </span>
              </Note>
            )}

            {subscription.cancel_at_period_end && (
              <Note tone="await">
                <span className="min-w-0 flex-1">
                  המנוי מסומן לביטול. גישה מלאה עד {fmtDate(subscription.current_period_end)}, ואז
                  הארגון עובר למסלול חינם — בלי החזר, בלי מחיקה ובלי סיום שירות. אפשר לחזור מהביטול
                  עד המועד הזה.
                </span>
              </Note>
            )}

            {/* THE INTERVAL PICKER APPEARS ONLY WHEN THERE ARE TWO AMOUNTS TO PICK BETWEEN.
                `Pricing.tsx` removed its own toggle outright and stated the rule: with no price on
                screen it is "a control that changes nothing on the page". The authenticated twin
                kept it, and it is in exactly the same condition — `currency` is null for every
                organization because `private.record_billing_country` (`0186:671`) has no production
                caller, so both columns render «—» and pressing either chip changes not one
                character. It is not deleted, because unlike the public page this surface WILL show
                real amounts the day a billing country is verified, and then the choice is
                meaningful. It is bound to the only condition under which it does anything.

                The reference put this control in the middle of the ladder, as a pill-shaped
                segmented toggle over the grid. It stays HERE, in the state card, because on this
                surface it is a property of the organization's billing — and because the reference's
                switch is a `@radix-ui/react-switch`, which this repo does not have and is not
                adding for a control that is already spelled `chip-filter`. */}
            {currency && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-ink-body" id="subscription-interval-label">מחזור חיוב</span>
                <div className="flex gap-2" role="group" aria-labelledby="subscription-interval-label">
                  {INTERVALS.map(([value, label]) => (
                    <button key={value} type="button" aria-pressed={interval === value}
                      className={`chip-filter ${interval === value ? 'chip-filter-active' : ''}`}
                      onClick={() => setIntervalChoice(value)}>{label}</button>
                  ))}
                </div>
              </div>
            )}

            {currency && (
              <p className="text-sm text-ink-muted">
                המחירים בקטלוג שנקבע לכתובת החיוב המאומתת שלך, לפני מס. ספק הסליקה מחשב וגובה את המס
                המקומי.
              </p>
            )}

            {/* THE LIFECYCLE CONTROLS BELONG TO A SUBSCRIPTION, AND A GRANT IS NOT ONE.
                #204 forbids putting cancellation out of reach, and that rule is about a customer
                who HAS something to cancel. Offering "ביטול המנוי" to an organization that never
                bought anything is not honouring #204 — it is inventing a subscription, and the
                dialog then has to admit at its own confirm step that there is nothing to cancel.
                `hasPaid` is the condition; `is_paid_plan` alone would show this row to every tenant
                from the day `0210` deploys.

                They moved INTO this card with the ladder moving out of it. They act on the
                subscription this card describes, and they were sitting under five plan cards that
                have nothing to do with cancelling one. */}
            {subscription.is_paid_plan && hasPaid && (
              <div className="flex flex-wrap justify-end gap-2">
                {subscription.cancel_at_period_end && (
                  <button type="button" className="btn-secondary" disabled>
                    <Undo2 size={ICON.sm} /> חזרה מהביטול
                  </button>
                )}
                {/* Reachable, not disabled: opening it is how #220's usage-versus-quota disclosure
                    is delivered. The stop is at the confirm step, where it is stated rather than
                    silently swallowed. */}
                {!subscription.cancel_at_period_end && (
                  <button type="button" className="btn-secondary text-alert-fg"
                    onClick={() => setConfirmingCancel(true)}>
                    ביטול המנוי
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </section>

      {/* The ladder's own shape while it loads, not a spinner in the middle of it — and now the
          SAME shape `/pricing` loads into, from `PlanCard.tsx`, so the placeholder cannot drift
          from the row it stands for. Five rungs and an action on each: that is what this surface
          resolves into. */}
      {loading && <PlanTicketSkeleton heading testId="subscription-skeleton" />}

      {/* THE LADDER, AS ITS OWN REGION OF REAL CARDS (owner report 25.08.2026: "התוכניות השונות עם
          האופציה לשדרוג, כמו בכל אפליקציה נורמלית"; owner verdict 26.08.2026 on what shipped:
          "נראים כאילו ילד בן 3 בנה אותם").

          WHAT A CARD IS ALLOWED TO SAY, and why it is this little:
            * The tier mark and its Hebrew name — both from the server's catalogue.
            * Where the rung stands relative to this organization's own — read from `tier_order`,
              which is already fetched and already sorting this list. It lives in Origin UI's
              per-item badge slot, beside the mark, because it is a fact about the READER and not
              about the product.
            * Whether the rung costs money, from `option.paid`. That is the only product
              description on the card: we have no marketing line per plan, and writing one would be
              inventing a business answer (`OPEN-DECISIONS.md:3`).
            * ONE quota: documents per usage period. #266 makes it the single published metric;
              OCR pages are derived from it and unpublished, and users/suppliers have no counter
              behind them at all (DEBT §56). It is why the "feature list" the reference fills with
              five ticks is one row here — five would take four inventions to write.
            * The price, which today is «—» for everyone. Owner ruling 25.08.2026.
            * `ביזנס`: `דברו איתנו`, never a figure (#194/#201).
          WHAT IT MUST NOT SAY: a per-plan capability list. #274 decided one and it is
          `NOT_IMPLEMENTED` — every capability boolean is still `true` for every plan, and `0184`
          fails any migration that turns one off. A card claiming "ייצוא ✗ בחינם" would promise a
          difference the server does not enforce. */}
      {subscription && (
        <section aria-labelledby="plan-ladder-heading" className="space-y-4">
          <h2 id="plan-ladder-heading" className="section-title">כל המסלולים</h2>

          <ul data-testid="plan-cards" className={PLAN_TRAY}>
            {[...options].sort((a, b) => a.tier_order - b.tier_order).map((option) => {
              const current = option.plan_key === subscription.plan_key;
              const amount = amountOf(option);
              const quota = planQuotas.find(
                (row) => row.plan_key === option.plan_key && row.entitlement_key === HEADLINE_QUOTA_KEY,
              );
              /**
               * UP OR DOWN, READ FROM `tier_order` — which was already fetched, already on the
               * card, and already used to sort this list. The label used to be "שדרוג ל…"
               * unconditionally, which was harmless only while every organization sat on the bottom
               * rung. `0210` puts them all near the top, so the free card would have read
               * "שדרוג לחינם" — an offer to upgrade to less. Neither word is a judgement (#202
               * forbids those): one says the rung is above this one, the other says it is not.
               */
              const isUpgrade = currentTier !== null && option.tier_order > currentTier;
              /** An amount only exists once a billing country has been verified (#208). */
              const hasAmount = !option.contact_sales && currency !== null && amount !== null;

              return (
                <PlanTicket
                  key={option.plan_key}
                  planKey={option.plan_key}
                  label={option.label}
                  /* Origin UI's per-item badge slot is gone with the old card, and what it carried
                     moves into the ticket's own description line: which rung this is RELATIVE TO
                     YOURS, then whether it costs money. Both used to be `badge-idle` / `badge-info`
                     chips; `idle` and `info` are two of the five STATUS tones and they belong to
                     data, not to a commercial rung — as plain text they cannot borrow a meaning the
                     product reserves for facts about documents and money.
                     `option.paid` is the server's own boolean, and it is the only answer to "so
                     what is this rung" on a screen where no amount shown is a guess. */
                  who={[
                    ...(currentTier === null ? []
                      : [current ? 'המסלול הנוכחי' : isUpgrade ? 'מדרגה מעל' : 'מדרגה מתחת']),
                    option.paid ? 'מסלול בתשלום' : 'לא נדרש אמצעי תשלום',
                  ].join(' · ')}
                  /* The rung this organization stands on, as an outline on the ticket. A REPORT and
                     not a selection — nothing on this screen can be chosen (#217/#224). */
                  current={current}
                  /* The badge, from the shared presentation file and from nowhere else, so the two
                     surfaces cannot point a reader at two different plans. #202 still binds the
                     part that matters: the emphasis is STATIC and identical for every reader, never
                     keyed to the tenant's own data. */
                  badgeLabel={option.plan_key === RECOMMENDED_PLAN ? 'מומלץ' : undefined}
                  priceLabel="מחיר"
                  /* THE PRICE SLOT, AND THE SENTENCE THAT REPLACED FIVE DASHES (owner ruling
                     26.08.2026: «משפט קצר במקום מקף»). Stacked in a list, five «—» in the column
                     the eye reads as the price read as a broken screen rather than as a withheld
                     figure — the dash rule was written for ONE metric inside a row of real ones,
                     not for a whole column of them.

                     `PRICE_AT_UPGRADE` says the actual reason and nothing else. It names no
                     number and implies none; it is not an error and not a loading state; and it
                     promises no price that the product has not decided to show. It is #267
                     almost verbatim — «נמסר בתוך החשבון, בשלב המעבר למסלול בתשלום» — and #208's
                     currency rule is NOT repeated here, because the availability notice above the
                     ladder already carries it in full and saying it five more times is the
                     cramped duplicated prose the owner asked to remove in the first place.

                     THE MONEY LAYER IS UNTOUCHED. `fmtPlanPrice` still answers «—» for a null
                     amount; what changed is that this call site no longer ASKS it that question.
                     It is called only when there is both a verified currency (#208) and an
                     amount, so a missing price is still missing — it is only said differently. */
                  /* THE FREE RUNG IS NOT A WITHHELD PRICE, and giving it the sentence was a small
                     lie the list layout made visible: four identical "המחיר נמסר במעבר למסלול
                     בתשלום" down the column, one of them on the rung that has no price to give at
                     all. `option.paid` is the server's own boolean and it separates the two cases
                     — nothing to disclose, versus something to disclose later. It also drops the
                     big «0 ₪» the catalogue produces for that rung once a currency IS verified:
                     zero is a true amount here, but a price slot reading `0` on a plan whose whole
                     description is "free" is a figure doing a word's job. */
                  // #194 and #201: a conversation, never a figure — and never at price size.
                  figure={option.contact_sales ? 'דברו איתנו'
                    : !option.paid ? 'ללא עלות'
                      : hasAmount ? fmtPlanPrice(amount, currency) : PRICE_AT_UPGRADE}
                  figureIsWords={!(option.paid && hasAmount)}
                  /* The period sits under the figure, and only when there IS a price to bill in
                     one. A period beside the sentence would dress an absence as a monthly one, and
                     "ללא עלות לחודש" would bill nothing on a cycle. */
                  term={option.paid && hasAmount
                    ? (interval === 'yearly' ? 'לשנה' : 'לחודש') : undefined}
                  /* The ticket's own pill (`.plan-card__cta`, in the shared stylesheet), because
                     three of the four faces are near black and the product's `.btn-primary` is
                     measured against a near-white card surface. `btn-rainbow` went with the old
                     card: it was a named exception granted for a button sitting on paper, and this
                     one sits on onyx, violet or gloss.

                     Disabled, with the reason said out loud (owner ruling 25.08.2026). There is no
                     `billing-checkout` function and no signed provider event to open a paid
                     entitlement with (#217), so a live button would either lie or no-op — and #204
                     forbids hiding the control instead, because a customer must be able to see that
                     the path exists and why it is shut. THIS COMPONENT CALLS NO EDGE FUNCTION AT
                     ALL; that absence is the guarantee, not this `disabled`.

                     The current rung has no action and gets a SPACER of the button's own height, so
                     the tray keeps an even rhythm rather than one ticket sitting 44px shorter. */
                  action={current
                    ? <div className="min-h-11" aria-hidden />
                    : (
                      <button type="button" disabled title="החיוב עדיין לא נפתח"
                        className="plan-card__cta">
                        {option.contact_sales
                          ? 'פנייה לשירות'
                          : isUpgrade ? `שדרוג ל${option.label}` : `מעבר ל${option.label}`}
                      </button>
                    )}
                  /* THE HEADLINE QUOTA IN THE TICKET'S OWN QUOTA SLOT — the one number #266 lets a
                     card publish, with the server's own label above it rather than a restatement:
                     `/pricing` prints the same string from the same function, and a card that
                     reworded it would be the second place a customer could read a different
                     sentence about one entitlement.

                     Still a dash when nothing measures it, and deliberately: the owner's ruling
                     replaced the five PRICE dashes, which were a column of them in the slot the eye
                     reads as the amount. An unmeasured quota (DEBT §56) must not be dressed as `0`,
                     and it must not be dressed as a promise either. */
                  quotaLabel={option.contact_sales
                    ? 'מכסה' : (quota?.label ?? 'מסמכים')}
                  quota={option.contact_sales ? 'חוזית'
                    : !quota || !quota.measured ? '—'
                      : quota.unlimited ? 'ללא הגבלה'
                        : fmtNum(quota.numeric_limit)}
                />
              );
            })}
          </ul>

          <p className="text-sm text-ink-muted">
            כפתורי השדרוג אינם פעילים עדיין: החיוב טרם נפתח. שינוי מסלול נעשה כרגע מול השירות, והוא
            אינו מאפס את תקופת השימוש או את המונים.
          </p>
        </section>
      )}

      {confirmingCancel && subscription && (
        <CancelDialog
          usage={usageQuery.data ?? []}
          loading={usageQuery.isLoading}
          periodEnd={subscription.current_period_end}
          onClose={() => setConfirmingCancel(false)}
        />
      )}
    </div>
  );
}

/**
 * The state card's own shape while it loads. `aria-hidden`, and deliberately not a second
 * `role="status"`: the ladder placeholder below carries the one "טוען" a screen reader should
 * hear, matching `SkeletonRegion` in `ui.tsx`.
 */
function StatusSkeleton() {
  return (
    <div aria-hidden className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-5 w-20 rounded-full" />
      </div>
      <Skeleton className="h-16 w-full rounded-xl" />
    </div>
  );
}

/**
 * #220, and the reason this is a dialog and not a one-line confirm: cancelling means landing on the
 * Free quota WITHOUT the counters resetting (#242). An organization already past the Free limit is
 * therefore blocked the moment the period turns over — so the honest thing to show before the
 * decision is the actual usage against the actual quota, including the metrics we cannot measure,
 * which appear as `—` rather than a reassuring zero.
 */
function CancelDialog({ usage, loading, periodEnd, onClose }: {
  usage: UsageRow[];
  loading: boolean;
  periodEnd: string | null;
  onClose: () => void;
}) {
  return (
    <Modal open onClose={onClose} title="ביטול המנוי">
      <div className="space-y-3">
        <p className="text-sm text-ink-body">
          הביטול ייכנס לתוקף בסוף התקופה ששולמה{periodEnd ? `, ב־${fmtDate(periodEnd)}` : ''}. עד אז
          הגישה נשארת מלאה ואפשר לחזור מהביטול. אין החזר, אין מחיקת נתונים ואין סיום שירות.
        </p>
        <p className="text-sm text-ink-body">
          בגבול התקופה הארגון עובר למסלול חינם. תקופת השימוש והמונים אינם מתאפסים: מה שנצבר בתקופה
          הנוכחית ימשיך להיספר מול מכסת חינם, ולכן ייתכן שפעולות חדשות ייחסמו עד תחילת התקופה הבאה.
        </p>
        <div className="rounded-lg bg-surface-sunken px-4 py-3">
          <h3 className="text-sm font-medium text-ink-body">השימוש שלך בתקופה הנוכחית</h3>
          {/* The snapshot is fetched when this dialog opens, not on mount. Holding the row shape
              while it arrives keeps the dialog from growing under the reader's cursor. */}
          {loading ? (
            <div role="status" aria-busy="true" className="mt-2 space-y-2">
              <span className="sr-only">טוען</span>
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-4 w-40" />
            </div>
          ) : (
            <ul className="mt-2 space-y-1">
              {usage.map((row) => (
                <li key={row.metric_key} data-testid={`cancel-usage-${row.metric_key}`}
                  className="flex flex-wrap items-center gap-x-2 text-sm">
                  <span className="min-w-32 text-ink-body">{row.label}</span>
                  {!row.measured || row.usage_limit === null ? (
                    <span className="text-ink-muted">—</span>
                  ) : (
                    <>
                      <span className="num text-ink">{fmtNum(row.used)}</span>
                      <span className="text-ink-muted">מתוך</span>
                      <span className="num text-ink">{fmtNum(row.usage_limit)}</span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        {/* The honest stop. A refused cancellation must never look like a completed one, and a
            transient toast is close enough to silence for an action the customer believes they
            just performed — so the reason is stated here, in the dialog, and it stays. Wording
            provisional under #203. */}
        <Note tone="await">
          <span className="min-w-0 flex-1">
            ביטול מהמסך הזה אינו זמין עדיין. שום דבר לא השתנה במנוי שלך כתוצאה מפתיחת החלון הזה.
          </span>
        </Note>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            סגירה
          </button>
          <button type="button" className="btn-primary" disabled>
            ביטול בסוף התקופה
          </button>
        </div>
      </div>
    </Modal>
  );
}
