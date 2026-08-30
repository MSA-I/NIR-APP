import { useState } from 'react';
import { Pencil, ShieldPlus, Undo2 } from 'lucide-react';
import { Modal, Note, StatusBadge, ConfirmDialog, ICON } from '../components/ui';
import { ReauthModal } from '../components/ReauthModal';
import { fmtDate, fmtDateTime, fmtNum } from '../lib/format';
import { SUBSCRIPTION_STATUS } from '../lib/status';
import {
  grantEntitlementOverride, revokeEntitlementOverride, setOrgSubscription,
  type BillingEventRow, type OrgEntitlement, type OrgSubscription, type PlatformCapability,
  type SubscriptionPlan,
} from '../lib/platform';
import { reasonOr } from '../lib/reason';

const BILLING_INTERVAL: Record<string, string> = { monthly: 'חודשי', yearly: 'שנתי' };

/**
 * Every unit `private.entitlement_definitions` defines, in Hebrew.
 *
 * It used to be one ternary — `row.unit === 'bytes' ? 'בתים' : ''` — which is not "we only
 * translate bytes", it is "every other unit is silently dropped". `40` appeared where `40 מסמכים`
 * belonged, and an operator reading a column of bare integers has to remember which row counts
 * documents and which counts users. The map covers the six units that exist; the LOOKUP falls back
 * to the raw unit rather than to an empty string, so a unit added by a later migration shows up as
 * itself and is visible enough to be translated, instead of vanishing.
 */
const ENTITLEMENT_UNIT: Record<string, string> = {
  users: 'משתמשים',
  suppliers: 'ספקים',
  documents: 'מסמכים',
  pages: 'עמודים',
  bytes: 'בתים',
  runs: 'ריצות',
};

/**
 * The honest rendering of one resolved entitlement, and the reason this component exists.
 *
 *   * `measured: false` is an em dash plus a sentence. It means the platform cannot state what
 *     the customer is entitled to — NOT that they are entitled to nothing, and certainly not a
 *     zero, which would be a claim the data does not support.
 *   * unlimited is a word, never a very large number, because that is how it is stored.
 */
function entitlementValue(row: OrgEntitlement): { text: string; muted: boolean } {
  if (!row.measured) return { text: '—', muted: true };
  if (row.kind === 'boolean') return { text: row.boolean_value ? 'פעיל' : 'חסום', muted: false };
  if (row.unlimited) return { text: 'ללא הגבלה', muted: false };
  const unit = row.unit ? ENTITLEMENT_UNIT[row.unit] ?? row.unit : '';
  return { text: `${fmtNum(row.numeric_limit ?? 0)} ${unit}`.trim(), muted: false };
}

/**
 * Paddle's event vocabulary (`0187` section 2), in the language the rest of this console speaks.
 *
 * The list printed `subscription.past_due` and `paddle` verbatim into an otherwise Hebrew screen —
 * machine keys an operator has to decode before they can act, on the one panel where the question
 * is usually "did the customer's payment fail, and when". The phrasing is NOMINAL on purpose: this
 * section is headed "אירועים מספק החיוב" and each row is the name of something the PROVIDER
 * reported, not a claim that our own subscription state moved. Whether it moved is the ledger's
 * business and is deliberately not shown here.
 *
 * The fallback is the raw key, for the reason every fallback in this file is: an event type added
 * at the provider must appear as itself rather than as a blank, and `0187` dead-letters an
 * unrecognised type instead of hiding it. The raw key also stays in the row's `title`, because
 * correlating with the provider's own dashboard needs the exact string.
 */
const BILLING_EVENT_TYPE: Record<string, string> = {
  'subscription.created': 'יצירת מנוי',
  'subscription.imported': 'ייבוא מנוי',
  'subscription.trialing': 'מנוי בתקופת ניסיון',
  'subscription.activated': 'הפעלת מנוי בתשלום',
  'subscription.updated': 'עדכון פרטי מנוי',
  'subscription.canceled': 'ביטול מנוי',
  'subscription.past_due': 'כשל בחיוב חידוש',
  'subscription.resumed': 'חזרה מביטול מנוי',
  'subscription.paused': 'הקפאת מנוי',
  'transaction.completed': 'השלמת תשלום',
  'transaction.paid': 'תשלום שנגבה',
  'transaction.payment_failed': 'כשל בתשלום',
  'transaction.billed': 'הנפקת חיוב',
  'transaction.created': 'יצירת עסקה',
  'transaction.ready': 'עסקה מוכנה לחיוב',
  'transaction.updated': 'עדכון עסקה',
  'transaction.canceled': 'ביטול עסקה',
  'transaction.past_due': 'עסקה בפיגור',
  'transaction.revised': 'תיקון עסקה',
  'adjustment.created': 'רישום התאמה',
  'adjustment.updated': 'עדכון התאמה',
};

/**
 * The three providers `0187` seeds. A brand name is not translated — `Paddle` is what the operator
 * will look for in the provider's own console — it is merely capitalised as the name it is, rather
 * than left as the lowercase database key.
 */
const BILLING_PROVIDER: Record<string, string> = {
  paddle: 'Paddle',
  stripe: 'Stripe',
  morning: 'Morning',
  manual: 'ידני',
};

export default function CustomerSubscription({
  orgId, subscription, entitlements, plans, billingEvents, may, busy, run,
}: {
  orgId: string;
  subscription: OrgSubscription | null;
  entitlements: OrgEntitlement[];
  plans: SubscriptionPlan[];
  billingEvents: BillingEventRow[];
  may: (capability: PlatformCapability) => boolean;
  busy: boolean;
  run: (action: () => Promise<unknown>, done: string) => void;
}) {
  const [editingPlan, setEditingPlan] = useState(false);
  const [planReauth, setPlanReauth] = useState<{
    planKey: string; status: string; interval: string; reason: string;
  } | null>(null);
  const [granting, setGranting] = useState<OrgEntitlement | null>(null);
  const [grantReauth, setGrantReauth] = useState<Parameters<typeof grantEntitlementOverride>[0] | null>(null);
  const [revoking, setRevoking] = useState<OrgEntitlement | null>(null);
  const [revokeReauth, setRevokeReauth] = useState<{ id: string; reason: string } | null>(null);

  const unmeasured = entitlements.filter((row) => !row.measured).length;

  return (
    <section className="card card-pad space-y-3" aria-labelledby="subscription-heading">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="subscription-heading" className="section-title">מנוי והרשאות</h2>
        {may('subscription.edit') && (
          <button type="button" className="btn-ghost ms-auto py-1! text-xs"
            onClick={() => setEditingPlan(true)}>
            <Pencil size={ICON.xs} /> שינוי מנוי
          </button>
        )}
      </div>

      {subscription ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="text-lg font-medium text-ink">{subscription.plan_label}</span>
          <StatusBadge meta={SUBSCRIPTION_STATUS[subscription.status]} />
          {/* The fallback is not defensive noise: without it an interval outside monthly|yearly —
              which the column's CHECK allows a future migration to add — renders the dangling
              fragment "חיוב " with nothing after it, and a reader cannot tell a missing translation
              from a missing value. `CustomerUsage` already had this right with `?? period_source`. */}
          <span className="text-sm text-ink-muted">
            חיוב {BILLING_INTERVAL[subscription.billing_interval] ?? subscription.billing_interval}
          </span>
          {/* When the provider has not told us a period, saying so beats implying a month that
              nobody agreed. What this date is NOT is explained in the line below. */}
          <span className="text-sm text-ink-muted">
            {subscription.current_period_end
              ? `תקופת החיוב עד ${fmtDate(subscription.current_period_end)}`
              : 'תקופת חיוב לא התקבלה מספק החיוב'}
          </span>
          {!subscription.plan_active && (
            <span className="badge-idle">מסלול שאינו מוצע ללקוחות חדשים</span>
          )}
        </div>
      ) : (
        <p className="text-sm text-ink-muted">לא נמצא מנוי לארגון הזה.</p>
      )}

      {subscription && (
        <>
          {/* OPEN-DECISIONS #242 separated the two periods, and this screen used to conflate them:
              the renewal date above looks like the date the quota comes back, and it is not. The
              usage period is anchored immutably to the organization's signup timestamp, and no
              billing event — payment, renewal, tier or interval change, cancellation, refund,
              delinquency recovery or the Legacy cutover — moves it or resets a counter. An
              operator answering "when does this customer get capacity back" from the renewal date
              would answer wrong. */}
          <p className="text-sm text-ink-muted">
            תקופת החיוב אינה תקופת השימוש: המכסות נספרות בתקופה מעוגנת לתאריך ההרשמה של הארגון,
            ותשלום, חידוש, שינוי מסלול, ביטול או החזר אינם מאפסים אותה.
          </p>

          {/* #221/#222: a failed renewal is a read-only state, not a downgrade and not deletion,
              and it ends only on a signed payment event. Naming that here keeps an operator from
              "helping" by hand-setting the plan back to active. */}
          {subscription.status === 'past_due' && (
            <Note tone="alert">
              <span className="min-w-0 flex-1">
                חיוב החידוש נכשל, והארגון בקריאה בלבד עד להסדרת התשלום: אין מעבר אוטומטי למסלול
                חינם, אין מחיקה ואין סיום שירות. היציאה היא אך ורק באמצעות אירוע תשלום מוצלח וחתום
                מספק הסליקה.
              </span>
            </Note>
          )}
        </>
      )}

      {unmeasured > 0 && (
        <p className="text-sm text-ink-muted">
          {fmtNum(unmeasured)} הרשאות ללא מגבלה מוגדרת — הן מוצגות כ־«—» ולא כאפס, והמערכת תסרב
          לפעולה שתלויה בהן עד שתוגדר מגבלה.
        </p>
      )}

      <ul className="divide-y divide-line-soft">
        {entitlements.map((row) => {
          const value = entitlementValue(row);
          return (
            <li key={row.entitlement_key} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <span className="min-w-40 text-sm text-ink-body">{row.label}</span>
              <span className={value.muted ? 'text-sm text-ink-muted num' : 'text-sm text-ink num'}>
                {value.text}
              </span>
              {row.source === 'override' && (
                <span className="badge-info">
                  חריג{row.override_expires_at ? ` עד ${fmtDate(row.override_expires_at)}` : ''}
                </span>
              )}
              {may('entitlement.override') && (
                <span className="ms-auto flex gap-1">
                  {row.override_id ? (
                    <button type="button" className="btn-ghost py-1! text-xs"
                      onClick={() => setRevoking(row)}>
                      <Undo2 size={ICON.xs} /> ביטול החריג
                    </button>
                  ) : (
                    <button type="button" className="btn-ghost py-1! text-xs"
                      onClick={() => setGranting(row)}>
                      <ShieldPlus size={ICON.xs} /> חריג
                    </button>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {/* Evidence that the provider spoke, never what it said: the payload is a payment
          processor's dump of a customer's details and has no business in a console. */}
      {billingEvents.length > 0 && (
        <div className="space-y-1 border-t border-line-soft pt-3">
          <h3 className="text-sm font-medium text-ink-body">אירועים מספק החיוב</h3>
          <ul className="space-y-1">
            {billingEvents.map((event) => (
              <li key={event.id} className="flex flex-wrap items-center gap-2 text-sm"
                title={`${event.event_type} · ${event.provider}`}>
                <span className="text-ink-body">
                  {BILLING_EVENT_TYPE[event.event_type] ?? event.event_type}
                </span>
                <span className="text-xs text-ink-muted">
                  {BILLING_PROVIDER[event.provider] ?? event.provider}
                </span>
                <span className="ms-auto text-xs text-ink-muted">{fmtDateTime(event.received_at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {editingPlan && subscription && (
        <PlanModal
          busy={busy}
          plans={plans}
          subscription={subscription}
          onClose={() => setEditingPlan(false)}
          // The password step-up below is untouched — only the typing gate is gone, so an empty
          // box carries the honest audit sentence into the reauth payload.
          onSubmit={(form) => {
            setEditingPlan(false);
            setPlanReauth({ ...form, reason: reasonOr(form.reason, 'שינוי מנוי הלקוח') });
          }}
        />
      )}
      <ReauthModal
        open={!!planReauth}
        title="אימות זהות לשינוי מנוי"
        onConfirm={() => {
          if (planReauth) {
            run(() => setOrgSubscription({ orgId, ...planReauth }), 'המנוי עודכן');
            setPlanReauth(null);
          }
        }}
        onCancel={() => setPlanReauth(null)}
      />

      {granting && (
        <OverrideModal
          busy={busy}
          entitlement={granting}
          onClose={() => setGranting(null)}
          onSubmit={(form) => {
            setGranting(null);
            setGrantReauth({
              orgId, entitlementKey: granting.entitlement_key, ...form,
              reason: reasonOr(form.reason, `מתן חריג להרשאה ״${granting.label}״`),
            });
          }}
        />
      )}
      <ReauthModal
        open={!!grantReauth}
        title="אימות זהות למתן חריג"
        onConfirm={() => {
          if (grantReauth) {
            run(() => grantEntitlementOverride(grantReauth), 'החריג נרשם');
            setGrantReauth(null);
          }
        }}
        onCancel={() => setGrantReauth(null)}
      />

      <ConfirmDialog
        open={!!revoking}
        busy={busy}
        requireReason
        title="ביטול חריג"
        message="ההרשאה תחזור לערך של המסלול. החריג עצמו נשמר ביומן עם הסיבה שניתנה לו ועם סיבת הביטול."
        confirmLabel="ביטול החריג"
        onClose={() => setRevoking(null)}
        onConfirm={(reason) => {
          if (revoking?.override_id) {
            setRevokeReauth({ id: revoking.override_id, reason: reason ?? '' });
            setRevoking(null);
          }
        }}
      />
      <ReauthModal
        open={!!revokeReauth}
        title="אימות זהות לביטול חריג"
        onConfirm={() => {
          if (revokeReauth) {
            run(() => revokeEntitlementOverride(revokeReauth.id, revokeReauth.reason), 'החריג בוטל');
            setRevokeReauth(null);
          }
        }}
        onCancel={() => setRevokeReauth(null)}
      />
    </section>
  );
}

function PlanModal({ busy, plans, subscription, onClose, onSubmit }: {
  busy: boolean;
  plans: SubscriptionPlan[];
  subscription: OrgSubscription;
  onClose: () => void;
  onSubmit: (form: { planKey: string; status: string; interval: string; reason: string }) => void;
}) {
  const [form, setForm] = useState({
    planKey: subscription.plan_key,
    status: subscription.status as string,
    interval: subscription.billing_interval as string,
    reason: '',
  });
  // An inactive plan holds who is already on it and takes nobody new; the server refuses the move
  // too, and offering it here would be an affordance that exists only to fail.
  const choices = plans.filter((plan) => plan.active || plan.plan_key === subscription.plan_key);

  return (
    <Modal open onClose={onClose} title="שינוי מנוי" busy={busy}>
      <div className="space-y-3">
        <div>
          <label className="label" htmlFor="plan-key">מסלול</label>
          <select id="plan-key" className="input" value={form.planKey}
            onChange={(event) => setForm({ ...form, planKey: event.target.value })}>
            {choices.map((plan) => (
              <option key={plan.plan_key} value={plan.plan_key}>
                {plan.label}{plan.active ? '' : ' (אינו מוצע ללקוחות חדשים)'}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="plan-status">מצב המנוי</label>
            <select id="plan-status" className="input" value={form.status}
              onChange={(event) => setForm({ ...form, status: event.target.value })}>
              <option value="active">פעיל</option>
              <option value="past_due">בפיגור תשלום</option>
              <option value="paused">מוקפא</option>
              <option value="canceled">בוטל</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="plan-interval">מחזור חיוב</label>
            <select id="plan-interval" className="input" value={form.interval}
              onChange={(event) => setForm({ ...form, interval: event.target.value })}>
              <option value="monthly">חודשי</option>
              <option value="yearly">שנתי</option>
            </select>
          </div>
        </div>
        <div>
          <label className="label" htmlFor="plan-reason">סיבת השינוי (רשות)</label>
          <textarea id="plan-reason" className="input" rows={2} maxLength={1000} value={form.reason}
            onChange={(event) => setForm({ ...form, reason: event.target.value })} />
        </div>
        <p className="text-xs text-ink-muted">
          השינוי נרשם ביומן הפלטפורמה עם הסיבה ועם המפעיל, ודורש אימות זהות.
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
          <button type="button" className="btn-primary" disabled={busy}
            onClick={() => onSubmit(form)}>המשך לאימות</button>
        </div>
      </div>
    </Modal>
  );
}

function OverrideModal({ busy, entitlement, onClose, onSubmit }: {
  busy: boolean;
  entitlement: OrgEntitlement;
  onClose: () => void;
  onSubmit: (form: {
    unlimited: boolean; numericLimit: number | null; booleanValue: boolean | null;
    expiresAt: string | null; reason: string;
  }) => void;
}) {
  const [mode, setMode] = useState(entitlement.kind === 'boolean' ? 'on' : 'limit');
  const [limit, setLimit] = useState('');
  const [expires, setExpires] = useState('');
  const [reason, setReason] = useState('');

  const numericReady = mode !== 'limit' || (limit.trim() !== '' && Number(limit) >= 0);
  // Only the numeric limit still gates the button: a missing limit has no override to grant, while
  // a missing reason has one — it just carries the fallback audit sentence (`lib/reason.ts`).
  const ready = numericReady;

  return (
    <Modal open onClose={onClose} title={`חריג — ${entitlement.label}`} busy={busy}>
      <div className="space-y-3">
        {entitlement.kind === 'numeric' ? (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <button type="button" aria-pressed={mode === 'limit'}
                className={mode === 'limit' ? 'chip-filter-active' : 'chip-filter'}
                onClick={() => setMode('limit')}>מגבלה מספרית</button>
              <button type="button" aria-pressed={mode === 'unlimited'}
                className={mode === 'unlimited' ? 'chip-filter-active' : 'chip-filter'}
                onClick={() => setMode('unlimited')}>ללא הגבלה</button>
            </div>
            {mode === 'limit' && (
              <div>
                <label className="label" htmlFor="override-limit">המגבלה</label>
                <input id="override-limit" type="number" min="0" className="input num" value={limit}
                  onChange={(event) => setLimit(event.target.value)} />
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button type="button" aria-pressed={mode === 'on'}
              className={mode === 'on' ? 'chip-filter-active' : 'chip-filter'}
              onClick={() => setMode('on')}>פתיחת היכולת</button>
            <button type="button" aria-pressed={mode === 'off'}
              className={mode === 'off' ? 'chip-filter-active' : 'chip-filter'}
              onClick={() => setMode('off')}>חסימת היכולת</button>
          </div>
        )}
        <div>
          <label className="label" htmlFor="override-expires">בתוקף עד (ריק = ללא מועד סיום)</label>
          <input id="override-expires" type="date" className="input" value={expires}
            onChange={(event) => setExpires(event.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="override-reason">סיבת החריג (רשות)</label>
          <textarea id="override-reason" className="input" rows={2} maxLength={1000} value={reason}
            onChange={(event) => setReason(event.target.value)} />
        </div>
        <p className="text-xs text-ink-muted">
          חריג פעיל אחד לכל הרשאה. החלפה נעשית בביטול ואז מתן חריג חדש, כדי שהיומן לא יצטרך לנחש
          איזה משניהם היה בתוקף.
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
          <button type="button" className="btn-primary" disabled={busy || !ready}
            onClick={() => onSubmit({
              unlimited: mode === 'unlimited',
              numericLimit: mode === 'limit' ? Number(limit) : null,
              booleanValue: entitlement.kind === 'boolean' ? mode === 'on' : null,
              expiresAt: expires || null,
              reason,
            })}>המשך לאימות</button>
        </div>
      </div>
    </Modal>
  );
}
