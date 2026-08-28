import { useT } from '../lib/i18n/LocaleProvider';
import { useState } from 'react';
import { Loader2, Mail, RotateCcw, Send } from 'lucide-react';
import { ConfirmDialog, ICON, Note, StatusBadge, useToast } from './ui';
import { useQuery } from '../lib/useQuery';
import { fmtDateTime } from '../lib/format';
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
  const { errorText, statusLabel, t } = useT();
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
      const result = await sendOrderEmail(orderId, reason?.trim() || t('emailOrderCard.sendOrderEmail'));
      if (result.ok) {
        toast(result.deliveryLimited
          ? t('emailOrderCard.text')
          : t('emailOrderCard.text_2'));
      } else if (result.state === 'already_sent' || result.state === 'in_flight') {
        toast(t('emailOrderCard.toast'));
      } else {
        toast(result.error ? errorText(result.error) : t('emailOrderCard.toast_2'), 'error');
      }
      setSendOpen(false);
      void refetch();
    } catch (failed) {
      toast(errorText(failed), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function reset(reason?: string) {
    if (!message) return;
    setBusy(true);
    try {
      await resetOrderEmailMessage(message.id, reason?.trim() || t('emailOrderCard.resetOrderEmailMessage'));
      toast(t('emailOrderCard.toast_3'));
      setResetOpen(false);
      void refetch();
    } catch (failed) {
      toast(errorText(failed), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-4 no-print">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-medium text-ink">
          <Mail size={ICON.sm} aria-hidden="true" /> {t('emailOrderCard.heading')}
        </h2>
        {message && <StatusBadge meta={EMAIL_CHANNEL_STATE[message.delivery_state]} />}
      </div>

      {message ? (
        <div className="mt-2 space-y-1 text-sm text-ink-muted">
          <p>
            {t('emailOrderCard.recipientLabel')} <span dir="ltr">{message.to_email}</span>
            {' · '}{t('emailOrderCard.attemptWord')} <span className="num">{message.attempt_count}</span> {t('emailOrderCard.text_3')} <span className="num">5</span>
            {message.last_attempt_at && <> · {fmtDateTime(message.last_attempt_at)}</>}
          </p>
          {message.status === 'accepted' && message.accepted_at && (
            <p>
              {t('emailOrderCard.acceptedByProvider', { at: fmtDateTime(message.accepted_at) })}{' '}
              {t('emailOrderCard.text_4')}
            </p>
          )}
          {message.status === 'delivered' && message.delivered_at && (
            <p>{t('emailOrderCard.deliveredAt', { at: fmtDateTime(message.delivered_at) })}</p>
          )}
          {/* #238: the channel failed, the order did not. Say both, and offer the resend. */}
          {message.delivery_state === 'delivery_failed' && failure && (
            <Note tone="alert">
              <span className="min-w-0 flex-1">
                {t(failure.key)}
                {message.failed_at && <> ({fmtDateTime(message.failed_at)})</>}
                {' '}{t('emailOrderCard.orderStillSent')}
                {failure.providerDetail && failure.providerDetail !== t(failure.key) && (
                  <>
                    {' '}
                    <span dir="auto" className="text-ink-faint">
                      {t('emailOrderCard.text_5')} {failure.providerDetail}
                    </span>
                  </>
                )}
              </span>
            </Note>
          )}
          {message.status === 'unknown' && (
            <Note tone="alert">
              <span className="min-w-0 flex-1">
                {t('emailOrderCard.unknownState')}
              </span>
            </Note>
          )}
          {/* The provider's own word for the stored status, kept visible next to the channel
              claim so the two are never confused with each other. */}
          <p className="text-xs text-ink-faint">
            {t('emailOrderCard.providerStatusLabel')} {statusLabel(EMAIL_MESSAGE_STATUS[message.status]) ?? '—'}
          </p>
        </div>
      ) : (
        <p className="mt-2 text-sm text-ink-muted">
          {t('emailOrderCard.notSentYet')}
        </p>
      )}

      {canWrite && (
        <div className="mt-3 flex flex-wrap gap-2">
          {emailEnabled && sendable && (!message || retryable) && (
            <button type="button" className="btn-primary" disabled={busy} onClick={() => setSendOpen(true)}>
              {busy ? <Loader2 size={ICON.sm} aria-hidden="true" className="animate-spin" /> : <Send size={ICON.sm} aria-hidden="true" />}
              {message ? t('emailOrderCard.text_10') : t('emailOrderCard.text_11')}
            </button>
          )}
          {message && ['failed', 'unknown'].includes(message.status) && profile?.role === 'owner' && (
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => setResetOpen(true)}>
              {busy ? <Loader2 size={ICON.sm} aria-hidden="true" className="animate-spin" /> : <RotateCcw size={ICON.sm} aria-hidden="true" />}
              {t('emailOrderCard.text_12')}
            </button>
          )}
        </div>
      )}

      <ConfirmDialog open={sendOpen} onClose={() => setSendOpen(false)}
        onConfirm={(reason) => void send(reason)}
        title={t('emailOrderCard.title')}
        message={t('emailOrderCard.message')}
        confirmLabel={t('emailOrderCard.confirmLabel')} requireReason busy={busy} />
      <ConfirmDialog open={resetOpen} onClose={() => setResetOpen(false)}
        onConfirm={(reason) => void reset(reason)}
        title={t('emailOrderCard.title_2')}
        message={t('emailOrderCard.message_2')}
        confirmLabel={t('emailOrderCard.confirmLabel_2')} danger requireReason busy={busy} />
    </div>
  );
}
