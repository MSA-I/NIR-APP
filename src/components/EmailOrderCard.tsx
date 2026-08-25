import { useState } from 'react';
import { Mail, RotateCcw, Send } from 'lucide-react';
import { ConfirmDialog, Note, StatusBadge, useToast } from './ui';
import { useQuery } from '../lib/useQuery';
import { fmtDateTime } from '../lib/format';
import { toHebrewError } from '../lib/errors';
import { EMAIL_MESSAGE_STATUS } from '../lib/status';
import {
  EMAIL_CHANNEL_STATE,
  EMAIL_RETRYABLE_STATUSES,
  emailDeliveryReason,
  fetchOrderEmailMessage,
  fetchSupplierCommunicationPreferences,
  resetOrderEmailMessage,
  sendOrderEmail,
} from '../lib/orderEmail';
import { useAuth } from '../auth/AuthContext';

/**
 * Provider-backed order delivery over email (0168 + 0190). The button claims the send
 * server-side; the ORDER becomes `sent` only when the provider accepted the message — never
 * because a window opened. What happens afterwards arrives from the signed delivery webhook, and
 * the badge shows the CHANNEL state (#238): "נמסרה לספק המייל" and "נמסרה לנמען" are different
 * claims and stay different, and once a message has bounced this card can never say delivered —
 * the database refuses the regression, so there is nothing here to get wrong.
 *
 * The failure surface is bounded on purpose: one Hebrew sentence derived from the reason code,
 * the provider's own capped wording as secondary evidence, and a resend. No raw provider payload,
 * no provider credential, and no provider identifier ever reaches this screen.
 */
export function EmailOrderCard({ orderId, supplierId, orderStatus, canWrite }: {
  orderId: string;
  supplierId: string;
  orderStatus: string;
  canWrite: boolean;
}) {
  const toast = useToast();
  const { profile } = useAuth();
  const [sendOpen, setSendOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const { data, loading, refetch } = useQuery(async () => {
    const [message, prefs] = await Promise.all([
      fetchOrderEmailMessage(orderId),
      fetchSupplierCommunicationPreferences(supplierId),
    ]);
    return { message, prefs };
  }, [orderId, supplierId]);

  if (loading) return null;
  const message = data?.message ?? null;
  const emailEnabled = !!data?.prefs && ['email', 'both'].includes(data.prefs.channel);
  const sendable = ['ready', 'sent'].includes(orderStatus);
  if (!message && (!emailEnabled || !sendable || !canWrite)) return null;

  const failure = message ? emailDeliveryReason(message) : null;
  const retryable = !!message && EMAIL_RETRYABLE_STATUSES.includes(message.status);

  async function send(reason?: string) {
    setBusy(true);
    try {
      const result = await sendOrderEmail(orderId, reason?.trim() || 'שליחת הזמנה לספק במייל');
      if (result.ok) {
        toast(result.deliveryLimited
          ? 'המייל נמסר לספק המייל — אבל הדומיין טרם אומת, ולכן המסירה מוגבלת (DEBT §25)'
          : 'המייל נמסר לספק המייל וההזמנה סומנה כנשלחה');
      } else if (result.state === 'already_sent' || result.state === 'in_flight') {
        toast('שליחה כבר בתהליך או שהושלמה — המסך יתרענן');
      } else {
        toast(result.error ?? 'השליחה נכשלה — הניסיון תועד וניתן לנסות שוב', 'error');
      }
      setSendOpen(false);
      void refetch();
    } catch (failed) {
      toast(toHebrewError(failed), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function reset(reason?: string) {
    if (!message) return;
    setBusy(true);
    try {
      await resetOrderEmailMessage(message.id, reason?.trim() || 'איפוס שליחת מייל');
      toast('ניסיונות השליחה אופסו');
      setResetOpen(false);
      void refetch();
    } catch (failed) {
      toast(toHebrewError(failed), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-4 no-print">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-medium text-ink">
          <Mail size={15} aria-hidden="true" /> מסירת ההזמנה במייל
        </h2>
        {message && <StatusBadge meta={EMAIL_CHANNEL_STATE[message.delivery_state]} />}
      </div>

      {message ? (
        <div className="mt-2 space-y-1 text-sm text-ink-muted">
          <p>
            נמענה: <span dir="ltr">{message.to_email}</span>
            {' · '}ניסיון <span className="num">{message.attempt_count}</span> מתוך <span className="num">5</span>
            {message.last_attempt_at && <> · {fmtDateTime(message.last_attempt_at)}</>}
          </p>
          {message.status === 'accepted' && message.accepted_at && (
            <p>
              נמסרה לספק המייל ב-{fmtDateTime(message.accepted_at)}. אישור מסירה לנמען יתעדכן
              כשיתקבל אירוע מאומת מהספק.
            </p>
          )}
          {message.status === 'delivered' && message.delivered_at && (
            <p>שרת הדואר של הנמען אישר את קבלת ההודעה ב-{fmtDateTime(message.delivered_at)}.</p>
          )}
          {/* #238: the channel failed, the order did not. Say both, and offer the resend. */}
          {message.delivery_state === 'delivery_failed' && failure && (
            <Note tone="alert">
              <span className="min-w-0 flex-1">
                {failure.sentence}
                {message.failed_at && <> ({fmtDateTime(message.failed_at)})</>}
                {' '}ההזמנה עצמה נשארת במצב ״נשלחה״ — היא כבר נמסרה לספק המייל; מה שנכשל הוא
                {' '}המסירה לנמען. שליחה חוזרת תנפיק קישור פורטל חדש ותבטל מיד את הקודם.
                {failure.providerDetail && (
                  <>
                    {' '}
                    <span dir="auto" className="text-ink-faint">
                      דיווח ספק המייל: {failure.providerDetail}
                    </span>
                  </>
                )}
              </span>
            </Note>
          )}
          {message.status === 'unknown' && (
            <Note tone="alert">
              <span className="min-w-0 flex-1">
                השליחה נקטעה במצב לא ידוע — ייתכן שהמייל יצא וייתכן שלא. כדי למנוע כפילות המערכת
                קפאה את השרשור; בעל העסק יכול לאפס אותו לאחר בירור מול הספק.
              </span>
            </Note>
          )}
          {/* The provider's own word for the stored status, kept visible next to the channel
              claim so the two are never confused with each other. */}
          <p className="text-xs text-ink-faint">
            מצב אצל ספק המייל: {EMAIL_MESSAGE_STATUS[message.status]?.label ?? '—'}
          </p>
        </div>
      ) : (
        <p className="mt-2 text-sm text-ink-muted">
          ההזמנה תישלח לכתובת המייל שהוגדרה בהעדפות התקשורת, עם קישור פורטל לאישור או להצעת
          שינויים. ההזמנה תסומן ״נשלחה״ רק כשספק המייל יאשר את קבלת ההודעה.
        </p>
      )}

      {canWrite && (
        <div className="mt-3 flex flex-wrap gap-2">
          {emailEnabled && sendable && (!message || retryable) && (
            <button type="button" className="btn-primary" disabled={busy} onClick={() => setSendOpen(true)}>
              <Send size={15} /> {message ? 'שליחה חוזרת במייל' : 'שליחת ההזמנה במייל'}
            </button>
          )}
          {message && ['failed', 'unknown'].includes(message.status) && profile?.role === 'owner' && (
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => setResetOpen(true)}>
              <RotateCcw size={15} /> איפוס ניסיונות (בעלים)
            </button>
          )}
        </div>
      )}

      <ConfirmDialog open={sendOpen} onClose={() => setSendOpen(false)}
        onConfirm={(reason) => void send(reason)}
        title="שליחת ההזמנה לספק במייל"
        message="המייל יכלול את פרטי ההזמנה וקישור פורטל מאובטח. קישור פורטל קודם, אם קיים, יבוטל מיד. ההזמנה תסומן כנשלחה רק לאחר שספק המייל יאשר את קבלת ההודעה. הפעולה תתועד ביומן הביקורת."
        confirmLabel="שליחה" requireReason busy={busy} />
      <ConfirmDialog open={resetOpen} onClose={() => setResetOpen(false)}
        onConfirm={(reason) => void reset(reason)}
        title="איפוס ניסיונות השליחה"
        message="האיפוס פותח מחדש את השרשור לאחר בירור. ודא מול הספק שהמייל לא התקבל — איפוס של שליחה שכן יצאה עלול להוביל לכפילות. הפעולה תתועד ביומן הביקורת."
        confirmLabel="איפוס" danger requireReason busy={busy} />
    </div>
  );
}
