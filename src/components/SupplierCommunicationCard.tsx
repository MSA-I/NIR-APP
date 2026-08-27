import { useT } from '../lib/i18n/LocaleProvider';
import { useState } from 'react';
import { MessageSquareText, Pencil } from 'lucide-react';
import { ICON, Modal, StatusBadge, useToast } from './ui';
import { useQuery } from '../lib/useQuery';
import { COMMUNICATION_CHANNEL } from '../lib/status';
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
  const { errorText } = useT();
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
    if (busy || !reason.trim()) return;
    setBusy(true);
    try {
      await setSupplierCommunicationPreferences(supplierId, {
        channel,
        locale,
        emailOverride: emailOverride.trim() || null,
        whatsappOverride: whatsappOverride.trim() || null,
        remindersAllowed,
        reason: reason.trim(),
      });
      toast('העדפות התקשורת נשמרו ותועדו ביומן הביקורת');
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
          <MessageSquareText size={ICON.sm} aria-hidden="true" /> תקשורת עם הספק
        </h2>
        <div className="flex items-center gap-2">
          <StatusBadge meta={COMMUNICATION_CHANNEL[effectiveChannel]} />
          {canWrite && (
            <button type="button" className="btn-ghost" onClick={openEditor}>
              <Pencil size={ICON.sm} /> עריכה
            </button>
          )}
        </div>
      </div>
      <dl className="mt-2 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
        <div className="flex gap-1">
          <dt className="text-ink-faint">שפת הודעות:</dt>
          <dd className="text-ink-body">{(prefs?.locale ?? 'he') === 'he' ? 'עברית' : 'אנגלית'}</dd>
        </div>
        {['email', 'both'].includes(effectiveChannel) && (
          <div className="flex gap-1">
            <dt className="text-ink-faint">יעד מייל:</dt>
            <dd className="text-ink-body" dir="ltr">{effectiveEmail ?? '—'}</dd>
          </div>
        )}
        <div className="flex gap-1">
          <dt className="text-ink-faint">תזכורות אוטומטיות:</dt>
          <dd className="text-ink-body">{prefs?.reminders_allowed ? 'מאושרות' : 'כבויות'}</dd>
        </div>
      </dl>
      {effectiveChannel === 'manual' && (
        <p className="mt-2 text-xs text-ink-muted">
          במצב ידני הזמנות נמסרות בשיתוף WhatsApp ידני או בהדפסה בלבד. כדי לאפשר שליחת מייל
          אוטומטית יש לבחור ערוץ מייל.
        </p>
      )}

      <Modal open={editing} onClose={() => setEditing(false)} title="העדפות תקשורת עם הספק" busy={busy}>
        <div className="space-y-3">
          <div>
            <label className="label" htmlFor="comm-channel">ערוץ מסירת הזמנות</label>
            <select id="comm-channel" className="input" value={channel}
              onChange={(e) => setChannel(e.target.value as CommunicationChannel)}>
              <option value="manual">ידני בלבד (ברירת המחדל)</option>
              <option value="email">מייל</option>
              <option value="whatsapp">WhatsApp (יופעל כשהחיבור יוגדר)</option>
              <option value="both">מייל ו-WhatsApp</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="comm-locale">שפת ההודעות לספק</label>
            <select id="comm-locale" className="input" value={locale}
              onChange={(e) => setLocale(e.target.value as CommunicationLocale)}>
              <option value="he">עברית</option>
              <option value="en">אנגלית</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="comm-email">כתובת מייל ייעודית (ברירת מחדל: {supplierEmail ?? 'אין בכרטיס'})</label>
            <input id="comm-email" className="input" dir="ltr" type="email"
              value={emailOverride} onChange={(e) => setEmailOverride(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="comm-whatsapp">מספר WhatsApp ייעודי (ברירת מחדל: {supplierPhone ?? 'אין בכרטיס'})</label>
            <input id="comm-whatsapp" className="input num" dir="ltr" inputMode="tel"
              placeholder="9725XXXXXXXX"
              value={whatsappOverride} onChange={(e) => setWhatsappOverride(e.target.value)} />
          </div>
          <label className="flex min-h-11 items-center gap-2 text-sm text-ink-body">
            <input type="checkbox" className="size-5 shrink-0" checked={remindersAllowed}
              onChange={(e) => setRemindersAllowed(e.target.checked)} />
            הספק מאשר קבלת תזכורות אוטומטיות
          </label>
          <div>
            <label className="label" htmlFor="comm-reason">סיבת השינוי (חובה — תתועד ביומן הביקורת)</label>
            <input id="comm-reason" className="input" value={reason}
              onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setEditing(false)}>ביטול</button>
            <button type="button" className="btn-primary" disabled={busy || !reason.trim()} onClick={() => void save()}>שמירה</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
