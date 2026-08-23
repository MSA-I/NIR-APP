import { useCallback, useEffect, useState } from 'react';
import { CreditCard, Undo2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { toHebrewError } from '../lib/errors';
import { fmtDate, fmtNum, fmtPlanPrice } from '../lib/format';
import { SUBSCRIPTION_STATUS } from '../lib/status';
import { ErrorNote, Modal, Note, StatusBadge, useToast } from './ui';

/**
 * The tenant's own subscription surface: what they are on, what else exists, and the three
 * lifecycle moves they are allowed to make. It is deliberately NOT a sales page.
 *
 * THE RULE THAT SHAPES EVERYTHING HERE: a redirect is not a receipt.
 * OPEN-DECISIONS #217 and #224 both settle it — a paid entitlement opens on a SIGNED SERVER
 * EVENT and on nothing else. A browser returning from a payment page has learned that a browser
 * returned from a payment page; it has not learned that money moved. So the checkout button sends
 * the customer to the provider and then says «ממתין לאישור», and the plan on screen keeps saying
 * whatever `my_subscription()` says until the server itself reports otherwise. There is no code
 * path in this file that upgrades a plan locally.
 *
 * THE OTHER FOUR RULES, each with the decision that forces it:
 *   * Currency is never guessed (#208). ILS or USD follows the billing country VERIFIED at the
 *     merchant of record — not an IP, not a picker. With no verified country there is no verified
 *     currency, so prices render `—` and the panel says why. Never `0`.
 *   * `ביזנס` is `דברו איתנו` and carries no figure (#194). The internal minimums of #201 are
 *     platform business and never reach a tenant screen.
 *   * A paid→paid tier or interval change lands AT THE NEXT RENEWAL with no proration (#216);
 *     cancellation lands at the end of the paid period and can be reversed until then (#219).
 *     Neither ever touches the usage period, which is anchored to signup (#242).
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
  checkout_pending: boolean;
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

const INTERVALS = [['monthly', 'חודשי'], ['yearly', 'שנתי']] as const;
type Interval = (typeof INTERVALS)[number][0];

/** Keep command identity across a lost response or a refresh, exactly as the offboarding calls do. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function stableSessionUuid(key: string): string {
  const existing = window.sessionStorage.getItem(key);
  if (existing && UUID_PATTERN.test(existing)) return existing;
  const created = crypto.randomUUID();
  window.sessionStorage.setItem(key, created);
  return created;
}

export function OrgSubscriptionPanel() {
  const toast = useToast();
  const [subscription, setSubscription] = useState<SubscriptionRow | null>(null);
  const [options, setOptions] = useState<UpgradeOption[]>([]);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [interval, setIntervalChoice] = useState<Interval>('monthly');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  /**
   * "This browser started a checkout." That is the whole meaning, and it is why the flag is local
   * and never promotes anything: it changes the WORDING to «ממתין לאישור» and nothing else. The
   * server's own `checkout_pending` outranks it, and the moment the server reports a paid plan
   * this flag stops mattering.
   */
  const [startedCheckout, setStartedCheckout] = useState(false);

  const load = useCallback(async () => {
    const [sub, upgrade, snapshot] = await Promise.all([
      supabase.rpc('my_subscription'),
      supabase.rpc('my_upgrade_options'),
      supabase.rpc('organization_usage_snapshot'),
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
    if (row) setIntervalChoice(row.billing_interval === 'yearly' ? 'yearly' : 'monthly');
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function run(action: () => Promise<void>, done?: string) {
    setBusy(true);
    try {
      await action();
      await load();
      if (done) toast(done);
    } catch (actionError) {
      toast(toHebrewError(actionError), 'error');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Free → paid. The Edge function hands back a provider-hosted checkout URL; this code opens it
   * and then knows nothing further. It records that a checkout was STARTED — never that one
   * succeeded — and re-reads the server, which is the only thing entitled to say the plan changed.
   */
  const startCheckout = (option: UpgradeOption) => run(async () => {
    const started = await supabase.functions.invoke<{ checkout_url: string; checkout_attempt_id: string }>(
      'billing-checkout', { body: { plan_key: option.plan_key, billing_interval: interval } });
    if (started.error || !started.data?.checkout_url) {
      throw started.error ?? new Error('checkout_unavailable');
    }
    setStartedCheckout(true);
    window.open(started.data.checkout_url, '_blank', 'noopener,noreferrer');
  });

  const scheduleChange = (option: UpgradeOption) => run(async () => {
    const key = `supplyflow:subscription:schedule:${option.plan_key}:${interval}`;
    const changed = await supabase.rpc('schedule_subscription_change', {
      p_plan_key: option.plan_key,
      p_billing_interval: interval,
      p_idempotency_key: stableSessionUuid(key),
    });
    if (changed.error) throw changed.error;
    window.sessionStorage.removeItem(key);
  }, 'השינוי נקבע לחידוש הבא.');

  const cancelAtPeriodEnd = () => run(async () => {
    const key = 'supplyflow:subscription:cancel';
    const cancelled = await supabase.rpc('cancel_subscription_at_period_end', {
      p_idempotency_key: stableSessionUuid(key),
    });
    if (cancelled.error) throw cancelled.error;
    window.sessionStorage.removeItem(key);
    setConfirmingCancel(false);
  }, 'הביטול נרשם ויחול בסוף התקופה ששולמה.');

  const resume = () => run(async () => {
    const key = 'supplyflow:subscription:resume';
    const resumed = await supabase.rpc('resume_subscription', {
      p_idempotency_key: stableSessionUuid(key),
    });
    if (resumed.error) throw resumed.error;
    window.sessionStorage.removeItem(key);
  }, 'המנוי ממשיך כרגיל.');

  const currency = subscription?.billing_country_verified ? subscription.catalogue_currency : null;
  const amountOf = (option: UpgradeOption) =>
    (interval === 'yearly' ? option.yearly_amount : option.monthly_amount);
  const pendingCheckout = !!subscription
    && (subscription.checkout_pending || (startedCheckout && !subscription.is_paid_plan));

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

          {pendingCheckout && (
            <Note tone="await" role="status">
              <span className="min-w-0 flex-1">
                נפתח תשלום אצל ספק הסליקה, והמצב הוא ממתין לאישור. המסלול ישתנה רק כאשר יתקבל
                אירוע תשלום חתום מהשרת; חזרה מדף התשלום אינה אישור, ועד אז המסלול הנוכחי הוא
                שבתוקף.
              </span>
            </Note>
          )}

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
                <button key={value} type="button" aria-pressed={interval === value} disabled={busy}
                  className={`chip-filter ${interval === value ? 'chip-filter-active' : ''}`}
                  onClick={() => setIntervalChoice(value)}>{label}</button>
              ))}
            </div>
          </div>

          {currency ? (
            <p className="text-sm text-ink-muted">
              המחירים בקטלוג שנקבע לכתובת החיוב המאומתת שלך, לפני מס. ספק הסליקה מחשב וגובה את המס
              המקומי.
            </p>
          ) : (
            <Note tone="info">
              <span className="min-w-0 flex-1">
                המטבע והקטלוג נקבעים לפי כתובת חיוב מאומתת אצל ספק הסליקה — לא לפי מיקום משוער ולא
                לפי בחירת מטבע. כל עוד לא אומתה כתובת חיוב אין מטבע מאומת, ולכן המחירים מוצגים כאן
                כ«—» וייקבעו בשלב התשלום.
              </span>
            </Note>
          )}

          <ul className="divide-y divide-line-soft">
            {[...options].sort((a, b) => a.tier_order - b.tier_order).map((option) => {
              const current = option.plan_key === subscription.plan_key;
              const amount = amountOf(option);
              return (
                <li key={option.plan_key}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <span className="min-w-32 text-sm text-ink-body">{option.label}</span>
                  {option.contact_sales ? (
                    // #194 and #201: a conversation, never a figure.
                    <span className="text-sm text-ink">דברו איתנו</span>
                  ) : (
                    <span className={amount == null || !currency ? 'num text-sm text-ink-muted' : 'num text-sm text-ink'}>
                      {currency ? fmtPlanPrice(amount, currency) : '—'}
                    </span>
                  )}
                  {current && <span className="badge-idle">המסלול הנוכחי</span>}
                  {!current && !option.contact_sales && option.paid && (
                    <span className="ms-auto">
                      {subscription.is_paid_plan ? (
                        <button type="button" className="btn-secondary py-1! text-xs" disabled={busy}
                          onClick={() => void scheduleChange(option)}>
                          תזמון מעבר ל{option.label}
                        </button>
                      ) : (
                        <button type="button" className="btn-primary py-1! text-xs" disabled={busy}
                          onClick={() => void startCheckout(option)}>
                          מעבר לתשלום — {option.label}
                        </button>
                      )}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="flex flex-wrap justify-end gap-2">
            {subscription.is_paid_plan && subscription.cancel_at_period_end && (
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => void resume()}>
                <Undo2 size={15} /> חזרה מהביטול
              </button>
            )}
            {subscription.is_paid_plan && !subscription.cancel_at_period_end && (
              <button type="button" className="btn-secondary text-alert-fg" disabled={busy}
                onClick={() => setConfirmingCancel(true)}>
                ביטול המנוי
              </button>
            )}
          </div>
        </>
      )}

      {confirmingCancel && subscription && (
        <CancelDialog
          busy={busy}
          usage={usage}
          periodEnd={subscription.current_period_end}
          onClose={() => setConfirmingCancel(false)}
          onConfirm={() => void cancelAtPeriodEnd()}
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
function CancelDialog({ busy, usage, periodEnd, onClose, onConfirm }: {
  busy: boolean;
  usage: UsageRow[];
  periodEnd: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open onClose={onClose} title="ביטול המנוי" busy={busy}>
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
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>
            השארת המנוי
          </button>
          <button type="button" className="btn-primary" disabled={busy} onClick={onConfirm}>
            ביטול בסוף התקופה
          </button>
        </div>
      </div>
    </Modal>
  );
}
