import { useT } from '../lib/i18n/LocaleProvider';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Link2, Copy, Loader2, RefreshCcw, Send, XCircle, Inbox } from 'lucide-react';
import { ConfirmDialog, ICON, Note, StatusBadge, useToast } from './ui';
import { useQuery } from '../lib/useQuery';
import { fmtDateTime } from '../lib/format';
import { SUPPLIER_LINK_STATE, SUPPLIER_PROPOSAL_STATUS } from '../lib/status';
import {
  buildPortalUrl, fetchOrderLink, fetchOrderProposal, issueOrderLink, linkState, revokeOrderLink,
} from '../lib/supplierPortal';
import { OPEN_ORDER_WHATSAPP_ERROR_KEY, openOrderWhatsApp, type WhatsAppOrder } from '../lib/share';

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
  const { errorText, statusLabel, t } = useT();
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
      const issued = await issueOrderLink(order.id, reason?.trim() || t('portalCard.issueOrderLink'));
      setFreshUrl(buildPortalUrl(issued.token));
      toast(t('portalCard.toast'));
      setIssueOpen(false);
      void refetch();
    } catch (failure) {
      toast(errorText(failure), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(reason?: string) {
    if (!link) return;
    setBusy(true);
    try {
      await revokeOrderLink(link.id, reason?.trim() || t('portalCard.revokeOrderLink'));
      setFreshUrl(null);
      toast(t('portalCard.toast_2'));
      setRevokeOpen(false);
      void refetch();
    } catch (failure) {
      toast(errorText(failure), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function copyFreshUrl() {
    if (!freshUrl) return;
    try {
      await navigator.clipboard.writeText(freshUrl);
      toast(t('portalCard.toast_3'));
    } catch {
      toast(t('portalCard.toast_4'), 'error');
    }
  }

  function openWhatsAppWithLink() {
    if (!freshUrl) return;
    const res = openOrderWhatsApp(order, orgName, freshUrl);
    if (res.errorCode) {
      toast(t(OPEN_ORDER_WHATSAPP_ERROR_KEY[res.errorCode]), 'error');
    }
  }

  if (loading) return null;
  if (!canIssue && !link && !proposal) return null;

  return (
    <div className="card p-4 no-print">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-medium text-ink">
          <Link2 size={ICON.sm} aria-hidden="true" /> {t('portalCard.heading')}
        </h2>
        {state && <StatusBadge meta={SUPPLIER_LINK_STATE[state]} />}
      </div>

      {proposal && (
        <Note tone={proposal.status === 'submitted' ? 'await' : 'info'} className="mt-3">
          <Inbox size={ICON.sm} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            {t('portalCard.supplierReplied', { at: fmtDateTime(proposal.submitted_at) })}{' '}
            {statusLabel(SUPPLIER_PROPOSAL_STATUS[proposal.status])}.{' '}
            <button
              type="button"
              className="underline"
              onClick={() => navigate(`/orders/proposals/${proposal.id}`)}
            >
              {proposal.status === 'submitted' ? t('portalCard.text') : t('portalCard.text_2')}
            </button>
          </span>
        </Note>
      )}

      {freshUrl ? (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-ink-muted">
            {t('portalCard.text_3')}
          </p>
          <div className="flex items-center gap-2">
            <input className="input num" dir="ltr" readOnly value={freshUrl} aria-label={t('portalCard.aria_label')}
              onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className="btn-secondary shrink-0" onClick={() => void copyFreshUrl()}>
              <Copy size={ICON.sm} aria-hidden="true" /> {t('portalCard.copy')}
            </button>
          </div>
          {(order.supplier.whatsapp || order.supplier.phone) && (
            <button type="button" className="btn-secondary" onClick={openWhatsAppWithLink}>
              <Send size={ICON.sm} aria-hidden="true" /> {t('portalCard.openWhatsApp')}
            </button>
          )}
        </div>
      ) : link && state === 'live' ? (
        <p className="mt-2 text-sm text-ink-muted">
          {t('portalCard.issuedValidUntil', { issued: fmtDateTime(link.created_at), expires: fmtDateTime(link.expires_at) })}{' '}
          {link.opened_at
            ? t('portalCard.openedBySupplier', { count: link.open_count })
            : t('portalCard.notOpenedYet')}{' '}
          {t('portalCard.linkNotStored')}
        </p>
      ) : link && state === 'expired' ? (
        <p className="mt-2 text-sm text-ink-muted">{t('portalCard.expiredAt', { at: fmtDateTime(link.expires_at) })}</p>
      ) : !link && canIssue ? (
        <p className="mt-2 text-sm text-ink-muted">
          {t('portalCard.text_8')}
        </p>
      ) : null}

      {canIssue && (
        <div className="mt-3 flex flex-wrap gap-2">
          {(!link || state === 'expired' || (state === 'live' && !freshUrl)) && (
            <button type="button" className={link ? 'btn-secondary' : 'btn-primary'} disabled={busy}
              onClick={() => setIssueOpen(true)}>
                {busy ? <Loader2 size={ICON.sm} aria-hidden="true" className="animate-spin" />
                : link ? <RefreshCcw size={ICON.sm} aria-hidden="true" /> : <Link2 size={ICON.sm} aria-hidden="true" />}
              {link ? t('portalCard.text_9') : t('portalCard.text_10')}
            </button>
          )}
          {link && state === 'live' && (
            <button type="button" className="btn-danger" disabled={busy}
              onClick={() => setRevokeOpen(true)}>
                {busy ? <Loader2 size={ICON.sm} aria-hidden="true" className="animate-spin" /> : <XCircle size={ICON.sm} aria-hidden="true" />}
              {t('portalCard.text_11')}
            </button>
          )}
        </div>
      )}

      <ConfirmDialog open={issueOpen} onClose={() => setIssueOpen(false)}
        onConfirm={(reason) => void issue(reason)}
        title={link ? t('portalCard.text_12') : t('portalCard.text_13')}
        message={link
          ? t('portalCard.text_14')
          : t('portalCard.text_15')}
        confirmLabel={t('portalCard.confirmLabel')} requireReason busy={busy} />
      <ConfirmDialog open={revokeOpen} onClose={() => setRevokeOpen(false)}
        onConfirm={(reason) => void revoke(reason)}
        title={t('portalCard.title')}
        message={t('portalCard.message')}
        confirmLabel={t('portalCard.confirmLabel_2')} danger requireReason busy={busy} />
    </div>
  );
}
