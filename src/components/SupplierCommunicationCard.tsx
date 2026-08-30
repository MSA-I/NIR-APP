import { useT } from '../lib/i18n/LocaleProvider';
import { useState } from 'react';
import { MessageSquareText, Pencil } from 'lucide-react';
import { ICON, Modal, StatusBadge, useToast } from './ui';
import { useQuery } from '../lib/useQuery';
import { COMMUNICATION_CHANNEL } from '../lib/status';
import { OPTIONAL_REASON_LABEL_KEY, reasonOr } from '../lib/reason';
import {
  fetchSupplierCommunicationPreferences,
  setSupplierCommunicationPreferences,
  type CommunicationChannel,
  type CommunicationLocale,
} from '../lib/orderEmail';

/**
 * The supplier's communication preferences (0168): which channel carries orders, in which
 * language, to which destination. Fail-closed by design — an unconfigured supplier is 'ידני
 * בלבד' and no provider send can happen; the server refuses a provider channel whose
 * destination is missing, so the form surfaces that refusal instead of saving a broken state.
 */
export function SupplierCommunicationCard({ supplierId, supplierEmail, supplierPhone, canWrite }: {
  supplierId: string;
  supplierEmail: string | null;
  supplierPhone: string | null;
  canWrite: boolean;
}) {
  const { errorText, t } = useT();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const { data: prefs, loading, refetch } = useQuery(
    () => fetchSupplierCommunicationPreferences(supplierId), [supplierId]);

  const [channel, setChannel] = useState<CommunicationChannel>('manual');
  const [locale, setLocale] = useState<CommunicationLocale>('he');
  const [emailOverride, setEmailOverride] = useState('');
  const [whatsappOverride, setWhatsappOverride] = useState('');
  const [remindersAllowed, setRemindersAllowed] = useState(false);
  const [reason, setReason] = useState('');

  function openEditor() {
    setChannel(prefs?.channel ?? 'manual');
    setLocale(prefs?.locale ?? 'he');
    setEmailOverride(prefs?.email_override ?? '');
    setWhatsappOverride(prefs?.whatsapp_override ?? '');
    setRemindersAllowed(prefs?.reminders_allowed ?? false);
    setReason('');
    setEditing(true);
  }

  async function save() {
    // `busy` is re-entrancy, not validation. The reason no longer gates the save (owner,
    // 11.08.2026) — `reasonOr` names the action for the ledger when the box was left empty.
    if (busy) return;
    setBusy(true);
    try {
      await setSupplierCommunicationPreferences(supplierId, {
        channel,
        locale,
        emailOverride: emailOverride.trim() || null,
        whatsappOverride: whatsappOverride.trim() || null,
        remindersAllowed,
        reason: reasonOr(reason, 'עדכון העדפות תקשורת מול הספק'),
      });
      toast(t('supplierComms.toast'));
      setEditing(false);
      void refetch();
    } catch (failure) {
      toast(errorText(failure), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return null;

  const effectiveEmail = prefs?.email_override ?? supplierEmail;
  const effectiveChannel = prefs?.channel ?? 'manual';

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-medium text-ink">
          <MessageSquareText size={ICON.sm} aria-hidden="true" /> {t('supplierComms.heading')}
        </h2>
        <div className="flex items-center gap-2">
          <StatusBadge meta={COMMUNICATION_CHANNEL[effectiveChannel]} />
          {canWrite && (
            <button type="button" className="btn-ghost" onClick={openEditor}>
              <Pencil size={ICON.sm} /> {t('supplierComms.edit')}
            </button>
          )}
        </div>
      </div>
      <dl className="mt-2 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
        <div className="flex gap-1">
          <dt className="text-ink-faint">{t('supplierComms.text')}</dt>
          <dd className="text-ink-body">{(prefs?.locale ?? 'he') === 'he' ? t('supplierComms.text_2') : t('supplierComms.text_3')}</dd>
        </div>
        {['email', 'both'].includes(effectiveChannel) && (
          <div className="flex gap-1">
            <dt className="text-ink-faint">{t('supplierComms.text_4')}</dt>
            <dd className="text-ink-body" dir="ltr">{effectiveEmail ?? '—'}</dd>
          </div>
        )}
        <div className="flex gap-1">
          <dt className="text-ink-faint">{t('supplierComms.text_5')}</dt>
          <dd className="text-ink-body">{prefs?.reminders_allowed ? t('supplierComms.text_6') : t('supplierComms.text_7')}</dd>
        </div>
      </dl>
      {effectiveChannel === 'manual' && (
        <p className="mt-2 text-xs text-ink-muted">
          {t('supplierComms.manualChannelNote')}
        </p>
      )}

      <Modal open={editing} onClose={() => setEditing(false)} title={t('supplierComms.title')} busy={busy}>
        <div className="space-y-3">
          <div>
            <label className="label" htmlFor="comm-channel">{t('supplierComms.text_10')}</label>
            <select id="comm-channel" className="input" value={channel}
              onChange={(e) => setChannel(e.target.value as CommunicationChannel)}>
              <option value="manual">{t('supplierComms.text_11')}</option>
              <option value="email">{t('supplierComms.text_12')}</option>
              <option value="whatsapp">{t('supplierComms.text_13')}</option>
              <option value="both">{t('supplierComms.text_14')}</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="comm-locale">{t('supplierComms.text_15')}</label>
            <select id="comm-locale" className="input" value={locale}
              onChange={(e) => setLocale(e.target.value as CommunicationLocale)}>
              <option value="he">{t('supplierComms.text_16')}</option>
              <option value="en">{t('supplierComms.text_17')}</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="comm-email">{t('supplierComms.dedicatedEmailLabel', { fallback: supplierEmail ?? t('supplierComms.text_18') })}</label>
            <input id="comm-email" className="input" dir="ltr" type="email"
              value={emailOverride} onChange={(e) => setEmailOverride(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="comm-whatsapp">{t('supplierComms.dedicatedWhatsAppLabel', { fallback: supplierPhone ?? t('supplierComms.text_19') })}</label>
            <input id="comm-whatsapp" className="input num" dir="ltr" inputMode="tel"
              placeholder="9725XXXXXXXX"
              value={whatsappOverride} onChange={(e) => setWhatsappOverride(e.target.value)} />
          </div>
          <label className="flex min-h-11 items-center gap-2 text-sm text-ink-body">
            <input type="checkbox" className="size-5 shrink-0" checked={remindersAllowed}
              onChange={(e) => setRemindersAllowed(e.target.checked)} />
            {t('supplierComms.text_20')}
          </label>
          <div>
            <label className="label" htmlFor="comm-reason">{t(OPTIONAL_REASON_LABEL_KEY)}</label>
            <input id="comm-reason" className="input" value={reason}
              onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setEditing(false)}>{t('supplierComms.cancel')}</button>
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void save()}>{t('supplierComms.save')}</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
