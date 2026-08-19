import { useState } from 'react';
import { Pencil, ShieldPlus, Undo2 } from 'lucide-react';
import { Modal, StatusBadge, ConfirmDialog } from '../components/ui';
import { ReauthModal } from '../components/ReauthModal';
import { fmtDate, fmtDateTime, fmtNum } from '../lib/format';
import { SUBSCRIPTION_STATUS } from '../lib/status';
import {
  grantEntitlementOverride, revokeEntitlementOverride, setOrgSubscription,
  type BillingEventRow, type OrgEntitlement, type OrgSubscription, type PlatformCapability,
  type SubscriptionPlan,
} from '../lib/platform';

const BILLING_INTERVAL: Record<string, string> = { monthly: 'חודשי', yearly: 'שנתי' };

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
  const unit = row.unit === 'bytes' ? 'בתים' : '';
  return { text: `${fmtNum(row.numeric_limit ?? 0)} ${unit}`.trim(), muted: false };
}

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
            <Pencil size={13} /> שינוי מנוי
          </button>
        )}
      </div>

      {subscription ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="text-lg font-medium text-ink">{subscription.plan_label}</span>
          <StatusBadge meta={SUBSCRIPTION_STATUS[subscription.status]} />
          <span className="text-sm text-ink-muted">חיוב {BILLING_INTERVAL[subscription.billing_interval]}</span>
          {/* The billing period is what a per-period limit resets against. When the provider has
              not told us one, saying so beats implying a month that nobody agreed. */}
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
                      <Undo2 size={13} /> ביטול החריג
                    </button>
                  ) : (
                    <button type="button" className="btn-ghost py-1! text-xs"
                      onClick={() => setGranting(row)}>
                      <ShieldPlus size={13} /> חריג
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
              <li key={event.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-ink-body">{event.event_type}</span>
                <span className="text-xs text-ink-muted">{event.provider}</span>
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
          onSubmit={(form) => { setEditingPlan(false); setPlanReauth(form); }}
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
            setGrantReauth({ orgId, entitlementKey: granting.entitlement_key, ...form });
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
          <label className="label" htmlFor="plan-reason">סיבת השינוי</label>
          <textarea id="plan-reason" className="input" rows={2} maxLength={1000} value={form.reason}
            onChange={(event) => setForm({ ...form, reason: event.target.value })} />
        </div>
        <p className="text-xs text-ink-muted">
          השינוי נרשם ביומן הפלטפורמה עם הסיבה ועם המפעיל, ודורש אימות זהות.
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
          <button type="button" className="btn-primary" disabled={busy || !form.reason.trim()}
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
  const ready = !!reason.trim() && numericReady;

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
          <label className="label" htmlFor="override-reason">סיבת החריג</label>
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
