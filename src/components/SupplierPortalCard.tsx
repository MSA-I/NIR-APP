import { useT } from '../lib/i18n/LocaleProvider';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Link2, Copy, Loader2, RefreshCcw, Send, XCircle, Inbox } from 'lucide-react';
import { ConfirmDialog, ICON, Note, StatusBadge, useToast } from './ui';
import { useQuery } from '../lib/useQuery';
import { fmtDateTime } from '../lib/format';
import { toHebrewError } from '../lib/errors';
import { SUPPLIER_LINK_STATE, SUPPLIER_PROPOSAL_STATUS } from '../lib/status';
import {
  buildPortalUrl, fetchOrderLink, fetchOrderProposal, issueOrderLink, linkState, revokeOrderLink,
} from '../lib/supplierPortal';
import { openOrderWhatsApp, type WhatsAppOrder } from '../lib/share';

/**
 * The supplier-portal panel on an order (0167): issue / regenerate / revoke the one live link,
 * and reach the proposal review when the supplier answered.
 *
 * The raw link is only known in the moment it is issued — the server stores a hash. So the copy
 * and WhatsApp buttons appear right after issuing, and after a reload the panel says so instead
 * of pretending it could re-show the URL. Regeneration mints a new link and kills the old one.
 */
export function SupplierPortalCard({ order, orgName, canWrite }: {
  order: WhatsAppOrder & { status: string };
  orgName: string;
  canWrite: boolean;
}) {
  const { statusLabel } = useT();
  const navigate = useNavigate();
  const toast = useToast();
  const [issueOpen, setIssueOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [freshUrl, setFreshUrl] = useState<string | null>(null);

  const { data, loading, refetch } = useQuery(async () => {
    const [link, proposal] = await Promise.all([
      fetchOrderLink(order.id),
      fetchOrderProposal(order.id),
    ]);
    return { link, proposal };
  }, [order.id]);

  const link = data?.link ?? null;
  const proposal = data?.proposal ?? null;
  const state = link ? linkState(link) : null;
  const canIssue = canWrite && ['ready', 'sent'].includes(order.status);

  async function issue(reason?: string) {
    setBusy(true);
    try {
      const issued = await issueOrderLink(order.id, reason?.trim() || 'הנפקת קישור פורטל לספק');
      setFreshUrl(buildPortalUrl(issued.token));
      toast('הקישור הונפק. ניתן להעתיק או לשלוח אותו לספק — הוא לא יוצג שוב לאחר עזיבת המסך.');
      setIssueOpen(false);
      void refetch();
    } catch (failure) {
      toast(toHebrewError(failure), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(reason?: string) {
    if (!link) return;
    setBusy(true);
    try {
      await revokeOrderLink(link.id, reason?.trim() || 'ביטול קישור פורטל');
      setFreshUrl(null);
      toast('הקישור בוטל');
      setRevokeOpen(false);
      void refetch();
    } catch (failure) {
      toast(toHebrewError(failure), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function copyFreshUrl() {
    if (!freshUrl) return;
    try {
      await navigator.clipboard.writeText(freshUrl);
      toast('הקישור הועתק');
    } catch {
      toast('לא ניתן להעתיק אוטומטית — יש לסמן ולהעתיק את הקישור ידנית', 'error');
    }
  }

  function openWhatsAppWithLink() {
    if (!freshUrl) return;
    const res = openOrderWhatsApp(order, orgName, freshUrl);
    if (res.error) toast(res.error, 'error');
  }

  if (loading) return null;
  if (!canIssue && !link && !proposal) return null;

  return (
    <div className="card p-4 no-print">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-medium text-ink">
          <Link2 size={ICON.sm} aria-hidden="true" /> פורטל ספק
        </h2>
        {state && <StatusBadge meta={SUPPLIER_LINK_STATE[state]} />}
      </div>

      {proposal && (
        <Note tone={proposal.status === 'submitted' ? 'await' : 'info'} className="mt-3">
          <Inbox size={ICON.sm} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            הספק שלח תשובה דרך הפורטל ({fmtDateTime(proposal.submitted_at)}) ·{' '}
            {statusLabel(SUPPLIER_PROPOSAL_STATUS[proposal.status])}.{' '}
            <button
              type="button"
              className="underline"
              onClick={() => navigate(`/orders/proposals/${proposal.id}`)}
            >
              {proposal.status === 'submitted' ? 'מעבר לסקירה והחלטה' : 'צפייה בהצעה ובהחלטה'}
            </button>
          </span>
        </Note>
      )}

      {freshUrl ? (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-ink-muted">
            הקישור מוצג פעם אחת בלבד — המערכת שומרת רק טביעת אצבע שלו.
          </p>
          <div className="flex items-center gap-2">
            <input className="input num" dir="ltr" readOnly value={freshUrl} aria-label="קישור פורטל הספק"
              onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className="btn-secondary shrink-0" onClick={() => void copyFreshUrl()}>
              <Copy size={ICON.sm} aria-hidden="true" /> העתקה
            </button>
          </div>
          {(order.supplier.whatsapp || order.supplier.phone) && (
            <button type="button" className="btn-secondary" onClick={openWhatsAppWithLink}>
              <Send size={ICON.sm} aria-hidden="true" /> פתיחת WhatsApp עם ההזמנה והקישור
            </button>
          )}
        </div>
      ) : link && state === 'live' ? (
        <p className="mt-2 text-sm text-ink-muted">
          הונפק {fmtDateTime(link.created_at)} · בתוקף עד {fmtDateTime(link.expires_at)}
          {link.opened_at
            ? <> · נפתח על ידי הספק (<span className="num">{link.open_count}</span> פעמים)</>
            : ' · טרם נפתח'}
          . הקישור עצמו אינו נשמר במערכת — להצגתו מחדש יש להנפיק קישור חדש.
        </p>
      ) : link && state === 'expired' ? (
        <p className="mt-2 text-sm text-ink-muted">הקישור פג תוקף ב-{fmtDateTime(link.expires_at)}.</p>
      ) : !link && canIssue ? (
        <p className="mt-2 text-sm text-ink-muted">
          קישור מאובטח וחד-הזמנתי שבו הספק מאשר את ההזמנה או מציע שינויים — ללא חשבון וללא התחברות.
        </p>
      ) : null}

      {canIssue && (
        <div className="mt-3 flex flex-wrap gap-2">
          {(!link || state === 'expired' || (state === 'live' && !freshUrl)) && (
            <button type="button" className={link ? 'btn-secondary' : 'btn-primary'} disabled={busy}
              onClick={() => setIssueOpen(true)}>
                {busy ? <Loader2 size={ICON.sm} aria-hidden="true" className="animate-spin" />
                : link ? <RefreshCcw size={ICON.sm} aria-hidden="true" /> : <Link2 size={ICON.sm} aria-hidden="true" />}
              {link ? 'הנפקת קישור חדש (מבטלת את הקודם)' : 'הנפקת קישור לספק'}
            </button>
          )}
          {link && state === 'live' && (
            <button type="button" className="btn-danger" disabled={busy}
              onClick={() => setRevokeOpen(true)}>
                {busy ? <Loader2 size={ICON.sm} aria-hidden="true" className="animate-spin" /> : <XCircle size={ICON.sm} aria-hidden="true" />}
              ביטול הקישור
            </button>
          )}
        </div>
      )}

      <ConfirmDialog open={issueOpen} onClose={() => setIssueOpen(false)}
        onConfirm={(reason) => void issue(reason)}
        title={link ? 'הנפקת קישור חדש לספק' : 'הנפקת קישור לספק'}
        message={link
          ? 'יונפק קישור חדש והקישור הקודם יפסיק לפעול מיידית. הפעולה תתועד ביומן הביקורת.'
          : 'יונפק קישור מאובטח להזמנה זו בלבד. הקישור יוצג פעם אחת ויפוג אוטומטית. הפעולה תתועד ביומן הביקורת.'}
        confirmLabel="הנפקה" requireReason busy={busy} />
      <ConfirmDialog open={revokeOpen} onClose={() => setRevokeOpen(false)}
        onConfirm={(reason) => void revoke(reason)}
        title="ביטול קישור הפורטל"
        message="הספק לא יוכל עוד לפתוח את הקישור. הפעולה תתועד ביומן הביקורת."
        confirmLabel="ביטול הקישור" danger requireReason busy={busy} />
    </div>
  );
}
