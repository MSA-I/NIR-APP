import { useT } from '../lib/i18n/LocaleProvider';
import type { TKey } from '../lib/i18n/t';
import { useId, useState } from 'react';
import { MessageCircle, Link2, Power, ShieldOff } from 'lucide-react';
import { ErrorNote, ICON, Modal, Note, StatusBadge, useToast } from './ui';
import { ReauthModal } from './ReauthModal';
import { useQuery } from '../lib/useQuery';
import type { StatusMeta } from '../lib/status';
import {
  configureWhatsAppConnection,
  fetchWhatsAppConnection,
  revokeWhatsAppConnection,
  setWhatsAppConnectionEnabled,
  summarizeConnection,
  WHATSAPP_CONNECTION_STATUS_LABEL,
  type WhatsAppConnectionStatus,
  type WhatsAppProvider,
} from '../lib/whatsappConnection';

/**
 * The organization's own WhatsApp sender (#239, #240, #241).
 *
 * WHAT THIS SCREEN IS FOR. A manager who opens it should be able to answer, in seconds: does an
 * order I press "send" on actually leave through my own number, or does it still need a person
 * with a phone? That is one fact -- `providerDeliveryAvailable` -- and everything else on the
 * card exists to explain it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never shows a credential, never shows a Vault reference,
 * and never shows an unmasked sender: the server returns a masked form and nothing else exists
 * to render. The role check below is convenience -- `configure_whatsapp_provider_connection`,
 * `set_whatsapp_provider_connection_enabled` and `revoke_whatsapp_provider_connection` each
 * enforce owner, a fresh password and a reason themselves, so a hand-crafted call gains nothing.
 *
 * THE MANUAL CHANNEL IS A SEPARATE, LABELLED THING. Opening wa.me is a person promising a
 * message left. It stays available at all times and is never counted, displayed or inferred as
 * provider delivery -- an unconfigured or disabled channel says exactly that instead of quietly
 * looking fine.
 */

const STATUS_TONE: Record<WhatsAppConnectionStatus, StatusMeta['tone']> = {
  pending: 'await',
  active: 'done',
  disabled: 'idle',
  error: 'alert',
};

/** The one refusal on this card that is about a FIELD rather than about the server, so it is the
    one the reason inputs below mark themselves invalid for. It is stored as a KEY: the card
    compares against it, and a comparison between two resolved sentences would stop being true
    the moment the reader changed language. */
const REASON_REQUIRED: TKey = 'whatsappCard.reasonRequired';

type PendingAction =
  | { kind: 'configure' }
  | { kind: 'enable'; enabled: boolean }
  | { kind: 'revoke' };

export function WhatsAppConnectionCard({ role }: { role: string | null | undefined }) {
  const { t, errorText } = useT();
  const toast = useToast();
  const isOwner = role === 'owner';
  const { data: connection, loading, refetch } = useQuery(() => fetchWhatsAppConnection(), []);
  const summary = summarizeConnection(connection ?? null);

  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  // Either a dictionary key this card raised, or a sentence `errorText` already resolved from
  // whatever the server threw. `message` is what reaches the screen; `errorKey` is what the card
  // can still reason about.
  const [error, setError] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<TKey | null>(null);
  const [stepUpFor, setStepUpFor] = useState<PendingAction | null>(null);
  const cardErrorId = useId();
  const modalErrorId = useId();
  const reasonInvalid = errorKey === REASON_REQUIRED || undefined;

  const [provider, setProvider] = useState<WhatsAppProvider>('twilio');
  const [providerAccountId, setProviderAccountId] = useState('');
  const [providerSenderId, setProviderSenderId] = useState('');
  const [displayNumber, setDisplayNumber] = useState('');
  const [credential, setCredential] = useState('');
  const [orderTemplateName, setOrderTemplateName] = useState('');
  const [reminderTemplateName, setReminderTemplateName] = useState('');
  const [languageCode, setLanguageCode] = useState('he');
  const [reason, setReason] = useState('');

  function openWizard() {
    setProvider('twilio');
    setProviderAccountId('');
    setProviderSenderId('');
    setDisplayNumber('');
    setCredential('');
    setOrderTemplateName('');
    setReminderTemplateName('');
    setLanguageCode('he');
    setReason('');
    setError(null);
    setErrorKey(null);
    setEditing(true);
  }

  function requestStepUp(action: PendingAction) {
    setError(null);
    setErrorKey(null);
    if (!reason.trim()) {
      setError(t(REASON_REQUIRED));
      setErrorKey(REASON_REQUIRED);
      return;
    }
    setStepUpFor(action);
  }

  async function runPending(action: PendingAction) {
    setStepUpFor(null);
    setBusy(true);
    setError(null);
    setErrorKey(null);
    try {
      if (action.kind === 'configure') {
        await configureWhatsAppConnection({
          provider,
          providerAccountId: providerAccountId.trim(),
          providerSenderId: providerSenderId.trim(),
          displayNumber: displayNumber.trim(),
          credential,
          orderTemplateName: orderTemplateName.trim(),
          reminderTemplateName: reminderTemplateName.trim(),
          languageCode,
          reason: reason.trim(),
        });
        toast(t('whatsappCard.toast'));
        setEditing(false);
      } else if (action.kind === 'enable') {
        await setWhatsAppConnectionEnabled(action.enabled, reason.trim());
        toast(action.enabled ? t('whatsappCard.toast_2') : t('whatsappCard.toast_3'));
      } else {
        await revokeWhatsAppConnection(reason.trim());
        toast(t('whatsappCard.toast_4'));
      }
      setCredential('');
      setReason('');
      void refetch();
    } catch (failure) {
      setError(errorText(failure));
      setErrorKey(null);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return null;

  // Not a StatusMeta: WHATSAPP_CONNECTION_STATUS_LABEL is this card's own vocabulary and has not
  // been extracted yet, so it is still literal text. StatusBadge takes both shapes on purpose.
  const statusMeta: { label: string; tone: StatusMeta['tone'] } | undefined = connection?.status
    ? { label: WHATSAPP_CONNECTION_STATUS_LABEL[connection.status], tone: STATUS_TONE[connection.status] }
    : undefined;

  return (
    <section className="card p-4" aria-labelledby="whatsapp-connection-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="whatsapp-connection-heading"
          className="flex items-center gap-1.5 text-sm font-medium text-ink">
          <MessageCircle size={ICON.sm} aria-hidden="true" /> {t('whatsappCard.heading')}
        </h2>
        <div className="flex items-center gap-2">
          {statusMeta ? <StatusBadge meta={statusMeta} /> : <span className="text-sm text-ink-muted">{t('whatsappCard.text')}</span>}
          {isOwner && (
            <button type="button" className="btn-secondary" onClick={openWizard}>
              <Link2 size={ICON.sm} aria-hidden="true" /> {summary.configured ? t('whatsappCard.text_2') : t('whatsappCard.text_3')}
            </button>
          )}
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
        <div className="flex gap-1">
          <dt className="text-ink-faint">{t('whatsappCard.text_4')}</dt>
          <dd className="text-ink-body">{summary.providerLabel}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-ink-faint">{t('whatsappCard.text_5')}</dt>
          <dd className="num text-ink-body" dir="ltr">{summary.maskedSender}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-ink-faint">{t('whatsappCard.text_6')}</dt>
          <dd className="text-ink-body">{summary.credentialLabel}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-ink-faint">{t('whatsappCard.text_7')}</dt>
          <dd className="text-ink-body">{summary.languageLabel}</dd>
        </div>
      </dl>

      {summary.providerDeliveryAvailable ? (
        <Note tone="done" className="mt-3">
          <span className="min-w-0 flex-1">
            {t('whatsappCard.text_8')}
          </span>
        </Note>
      ) : (
        <Note tone="await" className="mt-3">
          <span className="min-w-0 flex-1">
            {t('whatsappCard.noAutomaticDelivery')}
          </span>
        </Note>
      )}

      <p className="mt-2 text-xs text-ink-muted">
        {t('whatsappCard.text_11')}
      </p>

      {error && !editing && <div className="mt-3" id={cardErrorId}><ErrorNote message={error} /></div>}

      {isOwner && summary.configured && (
        <div className="mt-3 space-y-2">
          <div>
            <label className="label" htmlFor="whatsapp-connection-reason">
              {t('whatsappCard.text_12')}
            </label>
            <input id="whatsapp-connection-reason" className="input" value={reason}
              aria-invalid={reasonInvalid}
              aria-describedby={reasonInvalid ? cardErrorId : undefined}
              onChange={(event) => setReason(event.target.value)} />
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="btn-secondary" disabled={busy}
              onClick={() => requestStepUp({ kind: 'enable', enabled: connection?.status !== 'active' })}>
              <Power size={ICON.sm} aria-hidden="true" /> {connection?.status === 'active' ? t('whatsappCard.text_13') : t('whatsappCard.text_14')}
            </button>
            <button type="button" className="btn-danger" disabled={busy}
              onClick={() => requestStepUp({ kind: 'revoke' })}>
              <ShieldOff size={ICON.sm} aria-hidden="true" /> {t('whatsappCard.revokeConnection')}
            </button>
          </div>
        </div>
      )}

      <Modal open={editing} onClose={() => setEditing(false)} title={t('whatsappCard.title')}
        busy={busy}
        description={t('whatsappCard.description')}>
        <div className="space-y-3">
          <div>
            <label className="label" htmlFor="whatsapp-provider">{t('whatsappCard.text_15')}</label>
            <select id="whatsapp-provider" className="input" value={provider}
              onChange={(event) => setProvider(event.target.value as WhatsAppProvider)}>
              <option value="twilio">Twilio</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="whatsapp-account">{t('whatsappCard.text_16')}</label>
            <input id="whatsapp-account" className="input" dir="ltr" value={providerAccountId}
              onChange={(event) => setProviderAccountId(event.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="whatsapp-sender">{t('whatsappCard.text_17')}</label>
            <input id="whatsapp-sender" className="input" dir="ltr" placeholder="whatsapp:+9725XXXXXXXX"
              value={providerSenderId} onChange={(event) => setProviderSenderId(event.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="whatsapp-display">{t('whatsappCard.text_18')}</label>
            <input id="whatsapp-display" className="input num" dir="ltr" inputMode="tel"
              value={displayNumber} onChange={(event) => setDisplayNumber(event.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="whatsapp-credential">{t('whatsappCard.text_19')}</label>
            <input id="whatsapp-credential" className="input" dir="ltr" type="password"
              autoComplete="off" value={credential}
              onChange={(event) => setCredential(event.target.value)} />
            <p className="mt-1 text-xs text-ink-muted">
              {t('whatsappCard.text_20')}
            </p>
          </div>
          <div>
            <label className="label" htmlFor="whatsapp-order-template">{t('whatsappCard.text_21')}</label>
            <input id="whatsapp-order-template" className="input" dir="ltr" value={orderTemplateName}
              onChange={(event) => setOrderTemplateName(event.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="whatsapp-reminder-template">{t('whatsappCard.text_22')}</label>
            <input id="whatsapp-reminder-template" className="input" dir="ltr"
              value={reminderTemplateName}
              onChange={(event) => setReminderTemplateName(event.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="whatsapp-language">{t('whatsappCard.text_23')}</label>
            <select id="whatsapp-language" className="input" value={languageCode}
              onChange={(event) => setLanguageCode(event.target.value)}>
              <option value="he">{t('whatsappCard.text_24')}</option>
              <option value="en">{t('whatsappCard.text_25')}</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="whatsapp-configure-reason">
              {t('whatsappCard.text_26')}
            </label>
            <input id="whatsapp-configure-reason" className="input" value={reason}
              aria-invalid={reasonInvalid}
              aria-describedby={reasonInvalid ? modalErrorId : undefined}
              onChange={(event) => setReason(event.target.value)} />
          </div>
          {error && <div id={modalErrorId}><ErrorNote message={error} /></div>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" disabled={busy}
              onClick={() => setEditing(false)}>{t('whatsappCard.setEditing')}</button>
            <button type="button" className="btn-primary" disabled={busy}
              onClick={() => requestStepUp({ kind: 'configure' })}>{t('whatsappCard.requestStepUp')}</button>
          </div>
        </div>
      </Modal>

      <ReauthModal
        open={stepUpFor !== null}
        title={t('whatsappCard.title_2')}
        onCancel={() => setStepUpFor(null)}
        onConfirm={() => { if (stepUpFor) void runPending(stepUpFor); }}
      />
    </section>
  );
}
