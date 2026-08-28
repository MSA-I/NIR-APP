import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { CheckCircle2, XCircle, GitBranchPlus } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { useQuery } from '../lib/useQuery';
import { supabase } from '../lib/supabase';
import { unwrap } from '../lib/useQuery';
import {
  Breadcrumbs, ConfirmDialog, ErrorNote, Note, RecordHeader, RecordSkeleton, StatusBadge, useToast, ICON,
} from '../components/ui';
import { SUPPLIER_PROPOSAL_STATUS } from '../lib/status';
import { fmtDate, fmtDateTime, fmtMoneyExact, formatQuantity } from '../lib/format';
import { toHebrewError } from '../lib/errors';
import {
  createRevisionFromProposal, decideProposal, fetchProposal, type ProposalWithLines,
} from '../lib/supplierPortal';
import type { SupplierOrderProposalLine } from '../lib/types';

// The internal half of the supplier portal (0167): original order versus supplier proposal,
// line by line, with an explicit accept/reject per row, a separate decision on the proposed
// delivery date, a mandatory reason for any rejection, and — after deciding — one action that
// turns the accepted changes into a NEW order revision. The proposal itself never mutates the
// original order; it is evidence, and this screen is where the decision on it is recorded.

type Verdict = 'accepted' | 'rejected';

function lineChanged(line: SupplierOrderProposalLine): boolean {
  return line.availability === 'unavailable'
    || line.proposed_qty !== null
    || line.proposed_unit_price !== null
    || line.replacement_note !== null;
}

export default function SupplierProposalReview() {
  const { proposalId } = useParams<{ proposalId: string }>();
  const navigate = useNavigate();
  const { profile, organizationAccess } = useAuth();
  const toast = useToast();
  const canWrite = organizationAccess.canWrite && !!profile && ['owner', 'office'].includes(profile.role);

  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});
  const [acceptDate, setAcceptDate] = useState(true);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [revisionConfirmOpen, setRevisionConfirmOpen] = useState(false);

  const { data, loading, error, refetch } = useQuery(async () => {
    const proposal = await fetchProposal(proposalId!);
    if (!proposal) return null;
    const order = unwrap(await supabase.from('purchase_orders')
      .select('id, number, status, currency, expected_date, supplier:suppliers(name)')
      .eq('id', proposal.purchase_order_id).single()) as {
        id: string; number: number; status: string; currency: string; expected_date: string | null;
        supplier: { name: string } | null;
      };
    return { proposal, order };
  }, [proposalId]);

  const proposal: ProposalWithLines | null = data?.proposal ?? null;
  const changedLines = useMemo(
    () => (proposal ? proposal.lines.filter(lineChanged) : []), [proposal]);
  const untouchedLines = useMemo(
    () => (proposal ? proposal.lines.filter((l) => !lineChanged(l)) : []), [proposal]);

  if (loading) return <RecordSkeleton />;
  if (error) return <ErrorNote message={error} />;
  if (!proposal || !data) return <ErrorNote message="הצעת הספק לא נמצאה" />;

  const { order } = data;
  const pending = proposal.status === 'submitted';
  const anyRejected = proposal.lines.some((l) => verdicts[l.id] === 'rejected')
    || (proposal.proposed_delivery_date !== null && !acceptDate);
  const allDecided = proposal.lines.every((l) => verdicts[l.id]);
  const reasonMissing = anyRejected && reason.trim() === '';

  const setAll = (verdict: Verdict) => {
    const next: Record<string, Verdict> = {};
    for (const line of proposal.lines) next[line.id] = verdict;
    setVerdicts(next);
  };

  async function submitDecision() {
    if (!proposal || !allDecided || reasonMissing || busy) return;
    setBusy(true);
    try {
      await decideProposal(proposal.id, {
        lineDecisions: proposal.lines.map((l) => ({ line_id: l.id, decision: verdicts[l.id] })),
        acceptDeliveryDate: proposal.proposed_delivery_date !== null ? acceptDate : false,
        reason: reason.trim() || null,
      });
      toast('ההחלטה נרשמה ותועדה ביומן הביקורת');
      void refetch();
    } catch (failure) {
      toast(toHebrewError(failure), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function createRevision(revisionReason?: string) {
    if (!proposal || busy) return;
    setBusy(true);
    try {
      const newOrderId = await createRevisionFromProposal(
        proposal.id, revisionReason?.trim() || 'יצירת רוויזיה מהצעת ספק');
      toast('נוצרה רוויזיה חדשה של ההזמנה');
      navigate(`/orders/${newOrderId}`);
    } catch (failure) {
      toast(toHebrewError(failure), 'error');
      setBusy(false);
      setRevisionConfirmOpen(false);
    }
  }

  const decidedSummary = !pending && (
    <Note tone={proposal.status === 'rejected' ? 'idle' : 'done'}>
      <span className="min-w-0 flex-1">
        ההחלטה נרשמה ב-{fmtDateTime(proposal.decided_at)}
        {proposal.decision_reason && <> · סיבה: {proposal.decision_reason}</>}
      </span>
    </Note>
  );

  return (
    <div className="space-y-4">
      <RecordHeader
        breadcrumbs={<Breadcrumbs items={[
          { label: 'הזמנות', to: '/orders' },
          { label: `#${order.number}`, to: `/orders/${order.id}` },
          { label: 'הצעת ספק' },
        ]} />}
        title={<span>הצעת ספק להזמנה <span className="num">#{order.number}</span></span>}
        status={<StatusBadge meta={SUPPLIER_PROPOSAL_STATUS[proposal.status]} />}
        meta={<>
          {order.supplier && <span>{order.supplier.name}</span>}
          <span>התקבלה דרך פורטל הספק {fmtDateTime(proposal.submitted_at)}</span>
          <span className="num font-semibold text-ink-body">
            הפרש מוצע: {fmtMoneyExact(proposal.total_delta, order.currency)}
          </span>
        </>}
        primaryAction={pending && canWrite ? (
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !allDecided || reasonMissing}
            onClick={() => void submitDecision()}
          >
            <CheckCircle2 size={ICON.sm} aria-hidden="true" /> רישום ההחלטה
          </button>
        ) : !pending && canWrite && proposal.status !== 'rejected' && !proposal.revision_order_id
          && !['partial', 'received', 'cancelled'].includes(order.status) ? (
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={() => setRevisionConfirmOpen(true)}
            >
              <GitBranchPlus size={ICON.sm} aria-hidden="true" /> יצירת רוויזיה מהשינויים שאושרו
            </button>
          ) : undefined}
      />

      {decidedSummary}

      {proposal.revision_order_id && (
        <Note tone="info">
          <span className="min-w-0 flex-1">
            נוצרה רוויזיה חדשה מהצעה זו.{' '}
            <button type="button" className="underline" onClick={() => navigate(`/orders/${proposal.revision_order_id}`)}>
              מעבר להזמנה החדשה
            </button>
          </span>
        </Note>
      )}

      {proposal.supplier_note && (
        <div className="card p-4">
          <h2 className="text-sm font-medium text-ink">הערת הספק</h2>
          <p className="mt-1 text-sm text-ink-body"><bdi>{proposal.supplier_note}</bdi></p>
        </div>
      )}

      {proposal.proposed_delivery_date && (
        <div className="card p-4">
          <h2 className="text-sm font-medium text-ink">שינוי מוצע בתאריך האספקה</h2>
          <p className="mt-1 text-sm text-ink-body">
            מקורי: <span className="num">{fmtDate(order.expected_date)}</span>
            {' · '}מוצע: <span className="num font-medium">{fmtDate(proposal.proposed_delivery_date)}</span>
          </p>
          {pending && canWrite ? (
            <label className="mt-2 flex min-h-11 items-center gap-2 text-sm text-ink-body">
              <input
                type="checkbox"
                className="size-5"
                checked={acceptDate}
                onChange={(e) => setAcceptDate(e.target.checked)}
              />
              אישור תאריך האספקה המוצע
            </label>
          ) : proposal.delivery_date_accepted !== null && (
            <p className="mt-1 text-sm text-ink-muted">
              {proposal.delivery_date_accepted ? 'תאריך האספקה המוצע אושר.' : 'תאריך האספקה המוצע נדחה.'}
            </p>
          )}
        </div>
      )}

      {pending && canWrite && changedLines.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary" onClick={() => setAll('accepted')}>
            <CheckCircle2 size={ICON.sm} aria-hidden="true" /> אישור כל השורות
          </button>
          <button type="button" className="btn-secondary" onClick={() => setAll('rejected')}>
            <XCircle size={ICON.sm} aria-hidden="true" /> דחיית כל השורות
          </button>
        </div>
      )}

      <section aria-label="שורות ההצעה" className="space-y-3">
        {changedLines.map((line) => (
          <ProposalLineCard
            currency={order.currency}
            key={line.id}
            line={line}
            pending={pending && canWrite}
            verdict={verdicts[line.id]}
            onVerdict={(v) => setVerdicts((prev) => ({ ...prev, [line.id]: v }))}
          />
        ))}
        {untouchedLines.length > 0 && (
          <details className="card p-4">
            <summary className="cursor-pointer text-sm text-ink-muted">
              <span className="num">{untouchedLines.length}</span> שורות ללא שינוי מהספק
            </summary>
            <ul className="mt-3 space-y-2">
              {untouchedLines.map((line) => (
                <li key={line.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-ink-body"><bdi>{line.product_name}</bdi></span>
                  <span className="num text-ink-muted">
                    {formatQuantity(line.original_qty, line.unit)} × {fmtMoneyExact(line.original_unit_price, order.currency)}
                  </span>
                  {pending && canWrite && (
                    <VerdictPicker
                      value={verdicts[line.id]}
                      onChange={(v) => setVerdicts((prev) => ({ ...prev, [line.id]: v }))}
                    />
                  )}
                  {!pending && <DecisionBadge decision={line.decision} />}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {pending && canWrite && (
        <div className="card space-y-3 p-4">
          <div>
            <label className="label" htmlFor="proposal-decision-reason">
              סיבת ההחלטה {anyRejected ? '(חובה כאשר יש דחייה)' : '(לא חובה)'}
            </label>
            <input
              id="proposal-decision-reason"
              className="input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          {!allDecided && (
            <p className="text-sm text-ink-muted">יש להכריע על כל שורה לפני רישום ההחלטה.</p>
          )}
          {reasonMissing && (
            <p className="text-sm text-alert-fg">דחייה מחייבת סיבה — היא תתועד ביומן הביקורת.</p>
          )}
          <p className="text-xs text-ink-faint">
            ההחלטה תירשם עם זהות המחליט, מועד וסיבה ביומן הביקורת. ההזמנה המקורית אינה משתנה;
            שינויים שאושרו ייכנסו לתוקף רק ביצירת רוויזיה חדשה.
          </p>
        </div>
      )}

      <ConfirmDialog
        open={revisionConfirmOpen}
        onClose={() => setRevisionConfirmOpen(false)}
        onConfirm={(revisionReason) => void createRevision(revisionReason)}
        title="יצירת רוויזיה חדשה"
        message="תיווצר הזמנה חדשה מהשינויים שאושרו, וההזמנה המקורית תבוטל ותישאר כתיעוד. הפעולה תתועד ביומן הביקורת."
        confirmLabel="יצירת רוויזיה"
        requireReason
        busy={busy}
      />
    </div>
  );
}

function VerdictPicker({ value, onChange }: { value: Verdict | undefined; onChange: (v: Verdict) => void }) {
  return (
    <div className="flex gap-1" role="group" aria-label="החלטה לשורה">
      <button
        type="button"
        className={value === 'accepted' ? 'btn-primary px-3' : 'btn-secondary px-3'}
        aria-pressed={value === 'accepted'}
        onClick={() => onChange('accepted')}
      >
        <CheckCircle2 size={ICON.sm} aria-hidden="true" /> אישור
      </button>
      <button
        type="button"
        className={value === 'rejected' ? 'btn-danger px-3' : 'btn-secondary px-3'}
        aria-pressed={value === 'rejected'}
        onClick={() => onChange('rejected')}
      >
        <XCircle size={ICON.sm} aria-hidden="true" /> דחייה
      </button>
    </div>
  );
}

function DecisionBadge({ decision }: { decision: SupplierOrderProposalLine['decision'] }) {
  if (decision === 'accepted') return <span className="badge badge-done">אושרה</span>;
  if (decision === 'rejected') return <span className="badge badge-idle">נדחתה</span>;
  return <span className="badge badge-await">ממתינה</span>;
}

function ProposalLineCard({
  line, currency, pending, verdict, onVerdict,
}: {
  line: SupplierOrderProposalLine;
  /**
   * The ORDER's currency (0217). A proposal is the supplier's answer to one order, so its prices
   * and every delta derived from them are money of that one kind — the supplier is not quoting in
   * a second currency, they are answering the one they were asked in.
   */
  currency: string;
  pending: boolean;
  verdict: Verdict | undefined;
  onVerdict: (v: Verdict) => void;
}) {
  const qtyChanged = line.proposed_qty !== null && line.proposed_qty !== line.original_qty;
  const priceChanged = line.proposed_unit_price !== null && line.proposed_unit_price !== line.original_unit_price;
  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-ink"><bdi>{line.product_name}</bdi></p>
          {line.availability === 'unavailable' && (
            <p className="mt-1 text-sm text-alert-fg">הספק סימן: הפריט אינו זמין</p>
          )}
          {line.replacement_note && (
            <p className="mt-1 text-sm text-ink-muted">
              הצעת תחליף (טקסט בלבד, אינה נוספת לקטלוג): <bdi>{line.replacement_note}</bdi>
            </p>
          )}
        </div>
        {pending
          ? <VerdictPicker value={verdict} onChange={onVerdict} />
          : <DecisionBadge decision={line.decision} />}
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-ink-faint">כמות</dt>
          <dd className="num text-ink-body">
            {formatQuantity(line.original_qty, line.unit)}
            {qtyChanged && <> ← <span className="font-medium">{formatQuantity(line.proposed_qty, line.unit)}</span></>}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-faint">מחיר יחידה</dt>
          <dd className="num text-ink-body">
            {fmtMoneyExact(line.original_unit_price, currency)}
            {priceChanged && <> ← <span className="font-medium">{fmtMoneyExact(line.proposed_unit_price, currency)}</span></>}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-faint">הפרש לשורה</dt>
          <dd className="num text-ink-body">{fmtMoneyExact(line.line_delta, currency)}</dd>
        </div>
      </dl>
    </div>
  );
}
