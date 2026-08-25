import { useCallback, useEffect, useState } from 'react';
import { CreditCard, Undo2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { fmtDate, fmtNum, fmtPlanPrice } from '../lib/format';
import { SUBSCRIPTION_STATUS } from '../lib/status';
import { ErrorNote, Modal, Note, StatusBadge } from './ui';

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
 * THE OTHER FOUR RULES, each with the decision that forces it:
 *   * Currency is never guessed (#208). ILS or USD follows the billing country VERIFIED at the
 *     merchant of record — not an IP, not a picker. With no verified country there is no verified
 *     currency, so prices render `—` and the panel says why. Never `0`.
 *   * `ביזנס` is `דברו איתנו` and carries no figure (#194). The internal minimums of #201 are
 *     platform business and never reach a tenant screen.
 *   * A paid→paid tier or interval change lands AT THE NEXT RENEWAL with no proration (#216);
 *     cancellation lands at the end of the paid period and can be reversed until then (#219).
 *     Neither ever touches the usage period, which is anchored to signup (#242). The server
 *     transitions for all three do not exist yet, so the controls render DISABLED with the reason
 *     stated — visible per #204, which forbids hidden cancellation, and never silently no-op.
 *     `is_paid_plan` is false for every organization today, so none of them is reachable.
 *   * A failed renewal is read-only, not deletion and not a silent downgrade (#221), and the only
 *     way out is a successful signed payment event (#222). The notice says both halves, because a
 *     customer who is refused an upload will otherwise assume the worse one.
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

interface UsageRow {
  metric_key: string;
  label: string;
  used: number | null;
  usage_limit: number | null;
  unlimited: boolean;
  measured: boolean;
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
 * The one quota #266 lets a customer be shown. OCR pages are derived from it (ten per document)
 * and deliberately unpublished; users and suppliers have no counter behind them at all. A card
 * that listed every key would be three dashes and one number.
 */
const CARD_QUOTA_KEY = 'documents.monthly';

/**
 * Which tier mark each rung wears — the same five classes the top-bar badge uses, so the chip a
 * person taps in the header is the chip they then find on their own row here.
 */
const TIER_CLASS: Record<string, string> = {
  free: 'plan-badge-free',
  basic: 'plan-badge-basic',
  pro: 'plan-badge-pro',
  premium: 'plan-badge-premium',
  business: 'plan-badge-premium',
};

const INTERVALS = [['monthly', 'חודשי'], ['yearly', 'שנתי']] as const;
type Interval = (typeof INTERVALS)[number][0];

export function OrgSubscriptionPanel() {
  const [subscription, setSubscription] = useState<SubscriptionRow | null>(null);
  const [options, setOptions] = useState<UpgradeOption[]>([]);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [planQuotas, setPlanQuotas] = useState<PlanQuotaRow[]>([]);
  const [interval, setIntervalChoice] = useState<Interval>('monthly');
  const [error, setError] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  const load = useCallback(async () => {
    const [sub, upgrade, snapshot, quotas] = await Promise.all([
      supabase.rpc('my_subscription'),
      supabase.rpc('my_upgrade_options'),
      supabase.rpc('organization_usage_snapshot'),
      supabase.rpc('get_public_plan_quotas'),
    ]);
    if (sub.error || upgrade.error) {
      setError('לא ניתן לטעון את פרטי המסלול כרגע.');
      return;
    }
    setError(null);
    const row = ((sub.data ?? []) as SubscriptionRow[])[0] ?? null;
    setSubscription(row);
    setOptions((upgrade.data ?? []) as UpgradeOption[]);
    setUsage(snapshot.error ? [] : ((snapshot.data ?? []) as UsageRow[]));
    // A quota read that fails costs the cards one line each; it must not cost the whole panel.
    setPlanQuotas(quotas.error ? [] : ((quotas.data ?? []) as PlanQuotaRow[]));
    if (row) setIntervalChoice(row.billing_interval === 'yearly' ? 'yearly' : 'monthly');
  }, []);

  useEffect(() => { void load(); }, [load]);

  /**
   * `schedule_subscription_change`, `cancel_subscription_at_period_end` and `resume_subscription`
   * DO NOT EXIST. They need stored state on the subscription that the provider webhook must also
   * write, and that agent has stood down — building one half of a two-sided contract alone is the
   * failure mode this program has already paid for once. So there are no handlers here and no
   * call sites: an orphan RPC name in the source is a real defect, not a placeholder.
   */
  const currency = subscription?.billing_country_verified ? subscription.catalogue_currency : null;
  const amountOf = (option: UpgradeOption) =>
    (interval === 'yearly' ? option.yearly_amount : option.monthly_amount);
  /**
   * Three states, never two. "We could not determine" must not be rendered as "no" — the same
   * distinction the codebase already draws with `measured: false` → «—» rather than `0`. `0189`
   * forbids a missing or null key, so this branch is defence in depth rather than an expected path.
   */
  const availability: 'available' | 'unavailable' | 'indeterminate' =
    typeof subscription?.billing_provider_enabled !== 'boolean' ? 'indeterminate'
      : subscription.billing_provider_enabled ? 'available' : 'unavailable';

  return (
    <section className="card card-pad space-y-4" aria-labelledby="org-subscription-heading">
      <h2 id="org-subscription-heading" className="section-title flex items-center gap-2">
        <CreditCard size={17} /> מסלול ומנוי
      </h2>

      {error && <ErrorNote message={error} />}

      {subscription && (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span data-testid="current-plan" className="text-lg font-medium text-ink">
              {subscription.plan_label}
            </span>
            <StatusBadge meta={SUBSCRIPTION_STATUS[subscription.status]} />
            {subscription.is_paid_plan && (
              <span className="text-sm text-ink-muted">
                {subscription.current_period_end
                  ? `התקופה ששולמה מסתיימת ב־${fmtDate(subscription.current_period_end)}`
                  : 'תקופת חיוב לא התקבלה מספק הסליקה'}
              </span>
            )}
          </div>

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
              {!currency && ' המחיר נקבע במטבע של כתובת החיוב המאומתת אצל ספק הסליקה — לא לפי מיקום משוער ולא לפי בחירת מטבע — ולכן הוא מוצג כאן כ«—» עד שלב התשלום.'}
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

          {currency && (
            <p className="text-sm text-ink-muted">
              המחירים בקטלוג שנקבע לכתובת החיוב המאומתת שלך, לפני מס. ספק הסליקה מחשב וגובה את המס
              המקומי.
            </p>
          )}

          {/* The ladder as CARDS (owner report 25.08.2026: "התוכניות השונות עם האופציה לשדרוג,
              כמו בכל אפליקציה נורמלית"). It was a flat list of label-and-price rows, which reads
              as a table of the same thing five times rather than as five products.

              WHAT A CARD IS ALLOWED TO SAY, and why it is this little:
                * The tier mark and its Hebrew name — both from the server's catalogue.
                * ONE quota: documents per usage period. #266 makes it the single published
                  metric; OCR pages are derived from it and unpublished, and users/suppliers have
                  no counter behind them at all (DEBT §56).
                * The price, which today is «—» for everyone. Owner ruling 25.08.2026.
                * `ביזנס`: `דברו איתנו`, never a figure (#194/#201).
              WHAT IT MUST NOT SAY: a per-plan capability list. #274 decided one and it is
              `NOT_IMPLEMENTED` — every capability boolean is still `true` for every plan, and
              `0184` fails any migration that turns one off. A card claiming "ייצוא ✗ בחינם" would
              promise a difference the server does not enforce. */}
          <ul data-testid="plan-cards" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {[...options].sort((a, b) => a.tier_order - b.tier_order).map((option) => {
              const current = option.plan_key === subscription.plan_key;
              const amount = amountOf(option);
              const quota = planQuotas.find(
                (row) => row.plan_key === option.plan_key && row.entitlement_key === CARD_QUOTA_KEY,
              );
              return (
                <li key={option.plan_key} data-plan={option.plan_key}
                  className={`flex flex-col gap-2 rounded-2xl p-4 ${
                    current ? 'bg-surface-selected' : 'bg-surface-sunken'
                  }`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`plan-badge ${TIER_CLASS[option.plan_key] ?? 'plan-badge-free'}`}>
                      {option.label}
                    </span>
                    {current && <span className="badge-idle">המסלול הנוכחי</span>}
                  </div>

                  {option.contact_sales ? (
                    // #194 and #201: a conversation, never a figure.
                    <span className="text-sm font-medium text-ink">דברו איתנו</span>
                  ) : (
                    <span className={amount == null || !currency ? 'num text-lg text-ink-muted' : 'num text-lg text-ink'}>
                      {currency ? fmtPlanPrice(amount, currency) : '—'}
                    </span>
                  )}

                  {/* The number on its own line, the server's own wording under it. The label is
                      not restated or "improved" here: `/pricing` prints the same string from the
                      same function, and a card that reworded it would be the second place a
                      customer could read a different sentence about one entitlement. */}
                  <span className="text-sm text-ink-body">
                    {option.contact_sales
                      ? 'מכסה חוזית, נקבעת מול השירות'
                      : !quota || !quota.measured ? <span className="text-ink-muted">—</span>
                        : quota.unlimited ? `${quota.label} ללא הגבלה`
                          : (
                            <>
                              <span className="num block text-lg font-medium text-ink">{fmtNum(quota.numeric_limit)}</span>
                              {quota.label}
                            </>
                          )}
                  </span>

                  {/* Disabled, with the reason said out loud (owner ruling 25.08.2026). There is
                      no `billing-checkout` function and no signed provider event to open a paid
                      entitlement with (#217), so a live button would either lie or no-op — and
                      #204 forbids hiding the control instead, because a customer must be able to
                      see that the path exists and why it is shut. THIS COMPONENT CALLS NO EDGE
                      FUNCTION AT ALL; that absence is the guarantee, not this `disabled`. */}
                  {!current && (
                    <button type="button" className="btn-secondary mt-auto w-full py-1! text-xs" disabled
                      title="החיוב עדיין לא נפתח">
                      {option.contact_sales ? 'פנייה לשירות' : `שדרוג ל${option.label}`}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="text-sm text-ink-muted">
            כפתורי השדרוג אינם פעילים עדיין: החיוב טרם נפתח. שינוי מסלול נעשה כרגע מול השירות, והוא
            אינו מאפס את תקופת השימוש או את המונים.
          </p>

          <div className="flex flex-wrap justify-end gap-2">
            {subscription.is_paid_plan && subscription.cancel_at_period_end && (
              <button type="button" className="btn-secondary" disabled>
                <Undo2 size={15} /> חזרה מהביטול
              </button>
            )}
            {/* Reachable, not disabled: opening it is how #220's usage-versus-quota disclosure is
                delivered, and #204 forbids putting cancellation out of reach. The stop is at the
                confirm step, where it is stated rather than silently swallowed. */}
            {subscription.is_paid_plan && !subscription.cancel_at_period_end && (
              <button type="button" className="btn-secondary text-alert-fg"
                onClick={() => setConfirmingCancel(true)}>
                ביטול המנוי
              </button>
            )}
          </div>
        </>
      )}

      {confirmingCancel && subscription && (
        <CancelDialog
          usage={usage}
          periodEnd={subscription.current_period_end}
          onClose={() => setConfirmingCancel(false)}
        />
      )}
    </section>
  );
}

/**
 * #220, and the reason this is a dialog and not a one-line confirm: cancelling means landing on the
 * Free quota WITHOUT the counters resetting (#242). An organization already past the Free limit is
 * therefore blocked the moment the period turns over — so the honest thing to show before the
 * decision is the actual usage against the actual quota, including the metrics we cannot measure,
 * which appear as `—` rather than a reassuring zero.
 */
function CancelDialog({ usage, periodEnd, onClose }: {
  usage: UsageRow[];
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
