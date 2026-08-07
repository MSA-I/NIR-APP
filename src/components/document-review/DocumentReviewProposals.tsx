import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Check, FilePlus2, Info, Loader2, RotateCcw, ShieldAlert, X } from 'lucide-react';
import type { Role } from '../../lib/types';
import { toHebrewError } from '../../lib/errors';
import { fmtDateTime } from '../../lib/format';
import { supabase } from '../../lib/supabase';
import type { DocumentAnnotation, DocumentFeedback, DocumentLearningRule, InterpretationContract } from '../../lib/useDocumentProcessing';
import { Note, useToast } from '../ui';
import {
  ANNOTATION_SOURCE_LABELS,
  DOCUMENT_TYPE_LABELS,
  MARK_KIND_LABELS,
  actorName,
  confidenceLabel,
  creditDraftFromInterpretation,
  fieldKeyLabel,
  filingReason,
  latestCorrections,
  latestFeedbackByAnnotation,
  latestTypeReviewDecision,
  lineItemArithmetic,
  lineItemKeyLabel,
  paymentConfirmationFacts,
  sameAmount,
  resolvedText,
  ruleWhy,
  supplierMatchCaution,
  type ReviewSnapshot,
} from './model';

interface DocumentReviewProposalsProps {
  snapshot: ReviewSnapshot;
  role: Role;
  onRefetch: () => Promise<boolean>;
}

function valueText(value: string | number | boolean | null): string {
  if (value === null) return 'לא זוהה';
  if (typeof value === 'boolean') return value ? 'כן' : 'לא';
  return String(value);
}

function annotationTarget(snapshot: ReviewSnapshot, annotation: DocumentAnnotation): string {
  if (annotation.target_kind === 'block') {
    const block = snapshot.extraction?.payload.blocks.find(({ id }) => id === annotation.target_id);
    const text = block
      ? resolvedText(block.text, latestCorrections(snapshot.reviewCorrections), 'block', block.id).text
      : null;
    return block ? `קטע בעמוד ${block.page}: ${text || 'ללא טקסט'}` : `קטע ${annotation.target_id}`;
  }
  const mark = snapshot.extraction?.payload.marks.find(({ id }) => id === annotation.target_id);
  return mark ? `${MARK_KIND_LABELS[mark.kind]} בעמוד ${mark.page}` : `סימון ${annotation.target_id}`;
}

/**
 * Which mark a learning rule fired on, as a locator a person can find on the page.
 *
 * The raw `target_id` used to be printed here ("הופעל על סימון 7f3a…"), which named nothing the
 * reviewer could act on — the same argument the mark overlays already make about uuids. The id is
 * not lost: it is a row in the extraction table of "פרטים טכניים" at the top of the workspace.
 * The fallback says plainly that the mark is not in the extraction on screen rather than inventing
 * a location, because a rule application can outlive the extraction revision it fired against.
 */
function ruleApplicationTarget(snapshot: ReviewSnapshot, targetId: string): string {
  const mark = snapshot.extraction?.payload.marks.find(({ id }) => id === targetId);
  return mark ? `${MARK_KIND_LABELS[mark.kind]} בעמוד ${mark.page}` : 'סימון שאינו מופיע בחילוץ הנוכחי';
}

function TypeReviewControls({ snapshot, canDecide, onRefetch }: {
  snapshot: ReviewSnapshot;
  canDecide: boolean;
  onRefetch: () => Promise<boolean>;
}) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [chosenType, setChosenType] = useState<InterpretationContract['document_type'] | null>(null);
  const interpretation = snapshot.interpretation;
  const extraction = snapshot.extraction;
  const latest = useMemo(
    () => latestTypeReviewDecision(snapshot.typeReviewDecisions),
    [snapshot.typeReviewDecisions],
  );
  const canMutate = canDecide && snapshot.job?.status === 'review' && !!interpretation && !!extraction;

  if (!interpretation || !extraction) return null;

  const currentInterpretation = interpretation;
  const currentExtraction = extraction;
  const automaticType = currentInterpretation.payload.document_type;
  const effectiveType = latest?.decision === 'approved' && latest.approved_document_type
    ? latest.approved_document_type
    : automaticType;
  const selectedType = chosenType ?? effectiveType;
  const manuallyCorrected = effectiveType !== automaticType;

  async function saveCorrection() {
    if (selectedType === effectiveType) {
      toast('יש לבחור סוג מסמך שונה.', 'error');
      return;
    }
    if (!reason.trim()) {
      toast('יש להזין סיבה לתיקון סוג המסמך.', 'error');
      return;
    }
    setBusy(true);
    try {
      const result = await supabase.rpc('review_document_type', {
        p_interpretation_id: currentInterpretation.id,
        p_decision: 'approved',
        p_expected_suggested_document_type: automaticType,
        p_reason: reason.trim(),
        p_expected_input_checksum: currentExtraction.input_checksum,
        p_expected_contract_version: currentExtraction.contract_version,
        p_expected_revision: latest?.revision ?? 0,
        p_approved_document_type: selectedType,
      });
      if (result.error) throw new Error(result.error.message);
      const refreshed = await onRefetch();
      const success = `סוג המסמך תוקן ל${DOCUMENT_TYPE_LABELS[selectedType]}`;
      if (refreshed) toast(success);
      else toast(`${success}, אך רענון המסך נכשל. יש לרענן ידנית לפני פעולה נוספת.`, 'error');
      setReason('');
      setChosenType(null);
      setCorrecting(false);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      if (/document_type_review_(revision_conflict|context_changed)|document_review_status_invalid/i.test(raw)) {
        toast('הקשר הבדיקה השתנה מאז פתיחת הטופס. הנתונים ירועננו; יש לבדוק ולנסות שוב.', 'error');
        await onRefetch();
      } else {
        toast(toHebrewError(error), 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card card-pad" aria-labelledby="document-type-review-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="document-type-review-title" className="section-title">סוג המסמך</h3>
          <p className="mt-1 text-sm text-ink-muted">המערכת מסווגת את המסמך אוטומטית. אין צורך באישור ידני.</p>
        </div>
        <span className={manuallyCorrected ? 'badge-info' : 'badge-done'}>{manuallyCorrected ? 'תוקן ידנית' : 'סווג אוטומטית'}</span>
      </div>

      <dl className="mt-4 rounded-lg bg-surface-sunken p-3" aria-live="polite">
        <dt className="text-sm font-medium text-ink-soft">הסיווג הפעיל</dt>
        <dd className="mt-1 text-ink-body">{DOCUMENT_TYPE_LABELS[effectiveType]}</dd>
        <dd className="mt-1 text-xs text-ink-muted">זיהוי אוטומטי: {confidenceLabel(currentInterpretation.payload.document_type_confidence)}</dd>
      </dl>

      {latest && (
        <p className="mt-3 break-words text-xs text-ink-muted">
          {latest.reason} · {fmtDateTime(latest.created_at)} · מבצע {actorName(snapshot, latest.actor_id)}
        </p>
      )}

      {canMutate && correcting ? (
        <form className="mt-4 border-t border-line pt-4" onSubmit={(event) => event.preventDefault()}>
          <label className="block">
            <span className="label">סוג המסמך הנכון</span>
            <select
              className="input"
              value={selectedType}
              disabled={busy}
              onChange={(event) => setChosenType(event.target.value as InterpretationContract['document_type'])}
            >
              {(Object.keys(DOCUMENT_TYPE_LABELS) as InterpretationContract['document_type'][]).map((type) => (
                <option key={type} value={type}>
                  {DOCUMENT_TYPE_LABELS[type]}{type === effectiveType ? ' — הסיווג הנוכחי' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="mt-3 block">
            <span className="label">סיבת התיקון</span>
            <textarea className="input" rows={2} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} disabled={busy} />
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn-primary" disabled={busy || selectedType === effectiveType} onClick={() => void saveCorrection()}>
              {busy && <Loader2 className="animate-spin" size={17} aria-hidden="true" />} שמירת התיקון
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => { setCorrecting(false); setChosenType(null); setReason(''); }}>
              ביטול
            </button>
          </div>
        </form>
      ) : canMutate ? (
        <div className="mt-3 flex justify-end">
          <button type="button" className="btn-secondary" onClick={() => setCorrecting(true)}>הסיווג שגוי? תיקון סוג</button>
        </div>
      ) : null}

      {canDecide && (
        <DocumentDraftAction
          documentType={effectiveType}
          documentId={currentInterpretation.document_id}
          interpretation={currentInterpretation}
        />
      )}
    </div>
  );
}

const DRAFT_ACTIONS: Partial<Record<
  InterpretationContract['document_type'],
  { blurb: string; label: string }
>> = {
  invoice: {
    blurb: 'המסמך מסווג כחשבונית. אפשר לפתוח ממנו טיוטת חשבונית עם הערכים שזוהו, לבדוק ולאשר.',
    label: 'יצירת טיוטת חשבונית מהמסמך',
  },
  delivery_note: {
    blurb: 'המסמך מסווג כתעודת משלוח. אפשר לקלוט ממנו סחורה — הכמויות ימולאו מהתעודה, ואת ההזמנה בוחרים ידנית.',
    label: 'קליטת סחורה מתעודת המשלוח',
  },
  credit_note: {
    blurb: 'המסמך מסווג כחשבונית זיכוי. אפשר לפתוח ממנו דרישת זיכוי על החשבונית המקורית, עם הסכום שזוהה.',
    label: 'פתיחת דרישת זיכוי מהמסמך',
  },
};

/**
 * A payment confirmation is reconciled here, not executed.
 *
 * Executing is `execute_payment_request`, which only a payer may call, and a payer cannot read a
 * document interpretation at all (0046:557 grants that to owner/office/kitchen). That split is the
 * separation of duties this system is built on: whoever files the paperwork is not whoever moves
 * the money. So this panel answers the question a reviewer can actually act on -- does this
 * confirmation correspond to a payment we really made? -- and says plainly where execution lives.
 */
function PaymentConfirmationMatch({ interpretation }: {
  interpretation: NonNullable<ReviewSnapshot['interpretation']>;
}) {
  const facts = useMemo(
    () => paymentConfirmationFacts(interpretation.payload),
    [interpretation.payload],
  );
  const supplierId = interpretation.suggested_supplier_id;
  const [state, setState] = useState<
    { status: 'loading' }
    | { status: 'error' }
    | { status: 'ready'; payments: { id: string; number: number; paid_date: string; reference: string | null; amount: number }[];
        requests: { id: string; number: number; amount: number; status: string }[] }
  >({ status: 'loading' });

  useEffect(() => {
    if (!supplierId) { setState({ status: 'ready', payments: [], requests: [] }); return; }
    let cancelled = false;
    void (async () => {
      const [payments, requests] = await Promise.all([
        supabase.from('payments').select('id, number, paid_date, reference, amount')
          .eq('supplier_id', supplierId).order('paid_date', { ascending: false }).limit(50),
        supabase.from('payment_requests').select('id, number, amount, status')
          .eq('supplier_id', supplierId).in('status', ['approved', 'sent_for_execution']).limit(50),
      ]);
      if (cancelled) return;
      if (payments.error || requests.error) { setState({ status: 'error' }); return; }
      setState({
        status: 'ready',
        payments: (payments.data ?? []) as never,
        requests: (requests.data ?? []) as never,
      });
    })();
    return () => { cancelled = true; };
  }, [supplierId]);

  const matchedPayments = state.status === 'ready'
    ? state.payments.filter((payment) =>
      sameAmount(facts.amount, payment.amount)
      || (!!facts.reference && payment.reference?.trim() === facts.reference))
    : [];
  const matchedRequests = state.status === 'ready'
    ? state.requests.filter((request) => sameAmount(facts.amount, request.amount))
    : [];

  return (
    <div className="mt-4 border-t border-line pt-4" data-testid="payment-confirmation-match">
      <h4 className="text-sm font-medium text-ink-soft">התאמה לתשלומים במערכת</h4>
      <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-3">
        <div><dt className="text-xs text-ink-muted">סכום במסמך</dt><dd className="num">{facts.amount === null ? '—' : facts.amount}</dd></div>
        <div><dt className="text-xs text-ink-muted">תאריך</dt><dd className="num">{facts.paidDate || '—'}</dd></div>
        <div><dt className="text-xs text-ink-muted">אסמכתא</dt><dd className="break-all num" dir="ltr">{facts.reference || '—'}</dd></div>
      </dl>

      {state.status === 'loading' && <p className="mt-3 text-sm text-ink-muted">בודק מול התשלומים והדרישות של הספק…</p>}
      {state.status === 'error' && (
        <Note tone="alert" className="mt-3" role="alert">
          בדיקת ההתאמה נכשלה. אין להסיק מכך שהתשלום קיים או שאינו קיים.
        </Note>
      )}
      {state.status === 'ready' && (
        <div className="mt-3 space-y-2 text-sm">
          {matchedPayments.length > 0 && (
            <Note tone="done">
              נמצא תשלום רשום תואם: {matchedPayments.map((payment) => `#${payment.number} מ־${payment.paid_date}`).join(', ')}.
              המסמך הוא אסמכתא לתשלום שכבר קיים במערכת.
            </Note>
          )}
          {matchedPayments.length === 0 && matchedRequests.length > 0 && (
            <Note tone="await">
              אין תשלום רשום בסכום הזה, אך יש דרישת תשלום מאושרת תואמת: {matchedRequests.map((request) => `#${request.number}`).join(', ')}.
              ייתכן שההעברה בוצעה ועדיין לא נרשמה.
            </Note>
          )}
          {matchedPayments.length === 0 && matchedRequests.length === 0 && (
            <Note tone="alert" role="alert">
              {facts.amount === null
                ? 'לא זוהה סכום במסמך, ולכן לא ניתן להשוות אותו לתשלומים במערכת.'
                : 'לא נמצא תשלום או דרישת תשלום בסכום הזה לספק. כדאי לברר לפני שמסתמכים על המסמך.'}
            </Note>
          )}
          {/* Said explicitly rather than left to be discovered: the reviewer is not being denied a
              button by oversight, and hunting for one they will never have is wasted time. */}
          <p className="text-xs text-ink-muted">
            רישום ההעברה עצמה נעשה במסך התשלומים בידי בעל תפקיד תשלומים, ולא מכאן.
          </p>
        </div>
      )}
    </div>
  );
}

function DocumentDraftAction({ documentType, documentId, interpretation }: {
  documentType: InterpretationContract['document_type'] | null;
  documentId: string;
  interpretation: NonNullable<ReviewSnapshot['interpretation']>;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const action = documentType ? DRAFT_ACTIONS[documentType] : undefined;
  if (documentType === 'payment_confirmation') return <PaymentConfirmationMatch interpretation={interpretation} />;
  if (!documentType || !action) return null;

  // A credit note names the invoice it credits, but only the database can say whether we hold that
  // invoice. Resolving it here means the reviewer either lands on the right invoice or is told
  // plainly that it was not found -- never silently on the wrong one.
  async function openCreditDraft() {
    const draft = creditDraftFromInterpretation(interpretation.payload);
    const supplierId = interpretation.suggested_supplier_id;
    if (!draft.creditedInvoiceNumber || !supplierId) {
      toast('לא זוהתה במסמך החשבונית שאותה מזכים. בחר אותה מהרשימה ופתח ממנה דרישת זיכוי.', 'error');
      navigate('/invoices');
      return;
    }
    setBusy(true);
    const found = await supabase.from('invoices').select('id')
      .eq('supplier_id', supplierId).eq('invoice_number', draft.creditedInvoiceNumber)
      .is('deleted_at', null).limit(2);
    setBusy(false);
    if (found.error) { toast(toHebrewError(found.error.message), 'error'); return; }
    const rows = (found.data ?? []) as { id: string }[];
    if (rows.length !== 1) {
      toast(rows.length === 0
        ? `לא נמצאה חשבונית ${draft.creditedInvoiceNumber} לספק הזה. בחר אותה מהרשימה.`
        : `נמצאה יותר מחשבונית אחת במספר ${draft.creditedInvoiceNumber}. בחר את הנכונה מהרשימה.`, 'error');
      navigate('/invoices');
      return;
    }
    navigate(`/invoices/${rows[0].id}?credit=${documentId}`);
  }

  return (
    <div className="mt-4 border-t border-line pt-4">
      <p className="text-sm text-ink-soft">{action.blurb}</p>
      <button
        type="button"
        className="btn-primary mt-3"
        disabled={busy}
        onClick={() => {
          if (documentType === 'invoice') navigate(`/invoices/new?document=${documentId}`);
          else if (documentType === 'delivery_note') navigate(`/receiving?document=${documentId}`);
          else void openCreditDraft();
        }}
      >
        {busy ? <Loader2 className="animate-spin" size={17} aria-hidden="true" /> : <FilePlus2 size={17} aria-hidden="true" />} {action.label}
      </button>
    </div>
  );
}

const FEEDBACK_LABELS: Record<DocumentFeedback['feedback_type'], string> = {
  accepted: 'ההצעה אושרה',
  rejected: 'ההצעה נדחתה',
  corrected: 'ההצעה תוקנה',
};

function FeedbackControls({ annotation, onRefetch }: {
  annotation: DocumentAnnotation;
  onRefetch: () => Promise<boolean>;
}) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [tagKey, setTagKey] = useState(annotation.tag_key);
  const [label, setLabel] = useState(annotation.label);
  const [busy, setBusy] = useState<string | null>(null);

  async function submit(feedbackType: 'accepted' | 'rejected' | 'corrected') {
    if (!reason.trim()) {
      toast('יש להזין סיבה למשוב.', 'error');
      return;
    }
    if (feedbackType === 'corrected' && (!tagKey.trim() || !label.trim())) {
      toast('לתיקון הצעה נדרשים מפתח ותווית.', 'error');
      return;
    }
    setBusy(feedbackType);
    try {
      const result = await supabase.rpc('add_document_feedback', {
        p_annotation_id: annotation.id,
        p_feedback_type: feedbackType,
        p_after: feedbackType === 'corrected' ? { tag_key: tagKey.trim(), label: label.trim() } : {},
        p_reason: reason.trim(),
      });
      if (result.error) throw new Error(result.error.message);
      const refreshed = await onRefetch();
      const success = feedbackType === 'accepted' ? 'ההצעה אושרה' : feedbackType === 'rejected' ? 'ההצעה נדחתה' : 'ההצעה תוקנה כשכבת annotation חדשה';
      if (refreshed) toast(success);
      else toast(`${success}, אך רענון המסך נכשל. יש לרענן ידנית.`, 'error');
      setReason('');
    } catch (error) {
      toast(toHebrewError(error), 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="label">מפתח משמעות</span>
          <input className="input" value={tagKey} maxLength={100} onChange={(event) => setTagKey(event.target.value)} disabled={!!busy} />
        </label>
        <label className="block">
          <span className="label">תווית</span>
          <input className="input" value={label} maxLength={200} onChange={(event) => setLabel(event.target.value)} disabled={!!busy} />
        </label>
      </div>
      <label className="mt-3 block">
        <span className="label">סיבת המשוב</span>
        <textarea className="input" rows={2} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} disabled={!!busy} />
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="btn-primary" disabled={!!busy} onClick={() => void submit('accepted')}>
          {busy === 'accepted' ? <Loader2 className="animate-spin" size={17} aria-hidden="true" /> : <Check size={17} aria-hidden="true" />} אישור הצעה
        </button>
        <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => void submit('corrected')}>
          {busy === 'corrected' ? <Loader2 className="animate-spin" size={17} aria-hidden="true" /> : <RotateCcw size={17} aria-hidden="true" />} תיקון הצעה
        </button>
        <button type="button" className="btn-danger" disabled={!!busy} onClick={() => void submit('rejected')}>
          {busy === 'rejected' ? <Loader2 className="animate-spin" size={17} aria-hidden="true" /> : <X size={17} aria-hidden="true" />} דחייה
        </button>
      </div>
    </div>
  );
}

function RuleControls({ rule, role, onRefetch }: {
  rule: DocumentLearningRule;
  role: Role;
  onRefetch: () => Promise<boolean>;
}) {
  const toast = useToast();
  const [tagKey, setTagKey] = useState(rule.tag_key);
  const [label, setLabel] = useState(rule.label);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const canManage = rule.user_id !== null || role === 'owner' || role === 'office';

  async function finish(message: string) {
    const refreshed = await onRefetch();
    if (refreshed) toast(message);
    else toast(`${message}, אך רענון המסך נכשל. יש לרענן ידנית.`, 'error');
  }

  async function disableRule() {
    if (!reason.trim()) {
      toast('יש להזין סיבה להשבתת הכלל.', 'error');
      return;
    }
    setBusy('disable');
    try {
      const result = await supabase.rpc('disable_document_learning_rule', {
        p_rule_id: rule.id,
        p_reason: reason.trim(),
      });
      if (result.error) throw new Error(result.error.message);
      await finish('הכלל הושבת');
      setReason('');
    } catch (error) {
      toast(toHebrewError(error), 'error');
    } finally {
      setBusy(null);
    }
  }

  async function correctRule(event: FormEvent) {
    event.preventDefault();
    if (!tagKey.trim() || !label.trim() || !reason.trim()) {
      toast('יש למלא מפתח, תווית וסיבה לעדכון הכלל.', 'error');
      return;
    }
    setBusy('correct');
    try {
      const result = await supabase.rpc('create_document_learning_rule', {
        p_rule_scope: rule.user_id ? 'personal' : 'organization',
        p_document_type: rule.document_type,
        p_supplier_id: rule.supplier_id,
        p_mark_kind: rule.mark_kind,
        p_mark_fingerprint: rule.mark_fingerprint,
        p_tag_key: tagKey.trim(),
        p_label: label.trim(),
        p_reason: reason.trim(),
      });
      if (result.error) throw new Error(result.error.message);
      await finish('נוצרה גרסה מתוקנת של הכלל');
      setReason('');
    } catch (error) {
      toast(toHebrewError(error), 'error');
    } finally {
      setBusy(null);
    }
  }

  if (!rule.active || !canManage) return null;
  return (
    <form className="mt-3 border-t border-line pt-3" onSubmit={correctRule}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="label">מפתח מתוקן</span>
          <input className="input" maxLength={100} value={tagKey} onChange={(event) => setTagKey(event.target.value)} disabled={!!busy} />
        </label>
        <label className="block">
          <span className="label">תווית מתוקנת</span>
          <input className="input" maxLength={200} value={label} onChange={(event) => setLabel(event.target.value)} disabled={!!busy} />
        </label>
      </div>
      <label className="mt-3 block">
        <span className="label">סיבה</span>
        <textarea className="input" rows={2} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} disabled={!!busy} />
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="btn-secondary" disabled={!!busy}>
          {busy === 'correct' && <Loader2 className="animate-spin" size={17} aria-hidden="true" />} יצירת גרסה מתוקנת
        </button>
        <button type="button" className="btn-danger" disabled={!!busy} onClick={() => void disableRule()}>
          {busy === 'disable' && <Loader2 className="animate-spin" size={17} aria-hidden="true" />} השבתת כלל
        </button>
      </div>
    </form>
  );
}

export function DocumentReviewProposals({ snapshot, role, onRefetch }: DocumentReviewProposalsProps) {
  const interpretation = snapshot.interpretation;
  const isSupplier = role === 'supplier';
  const ruleById = useMemo(() => new Map(snapshot.learningRules.map((rule) => [rule.id, rule])), [snapshot.learningRules]);
  const feedbackByAnnotation = useMemo(
    () => latestFeedbackByAnnotation(snapshot.feedback),
    [snapshot.feedback],
  );
  // Surfaced above the table too: a reviewer scanning 37 rows should not have to find the bad one.
  const inconsistentRows = useMemo(
    () => (interpretation?.payload.line_items ?? [])
      .filter((item) => lineItemArithmetic(item.values)?.consistent === false).length,
    [interpretation],
  );

  if (!interpretation) return null;

  const supplierCaution = supplierMatchCaution(interpretation.payload.supplier.confidence);
  const machineReason = filingReason(snapshot);

  return (
    <section className="space-y-4" data-testid="document-review-proposals" aria-labelledby="document-proposals-title">
      <div className="card card-pad">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="document-proposals-title" className="section-title">פירוש המסמך</h2>
            <p className="mt-1 text-sm text-ink-muted">השדות הופקו אוטומטית ומוצגים להשוואה מול המקור.</p>
          </div>
          <span className="badge-info">פירוש אוטומטי</span>
        </div>
        {/* Why the machine did not act, when it looked at this document and chose not to.
            Before 0079 the screen said "ממתין להכרעה" and stopped, and the reason existed only in
            a plpgsql local and an Edge Function log line — the owner had to ask, and the answer
            took a query against production. A document that is waiting is not the same as a
            document nobody looked at, and the difference is the whole point of section 12. */}
        {machineReason && (
          <Note tone="info" className="mt-3" role="status" data-testid="filing-reason">
            <Info className="mt-0.5 shrink-0" size={18} aria-hidden="true" />
            <span><strong>המערכת לא יצרה רשומה אוטומטית.</strong> {machineReason}</span>
          </Note>
        )}
        {/* Provider, model, prompt and schema versions used to sit here as a second card of equal
            weight. They are provenance, not a decision the reviewer makes; they now live in the
            "פרטים טכניים" disclosure at the top of the workspace. */}
        <dl className="mt-4 rounded-lg bg-surface-sunken p-3">
          <dt className="text-sm font-medium text-ink-soft">ספק מוצע</dt>
          <dd className="mt-1 break-words text-ink-body">{interpretation.payload.supplier.suggested_name || 'לא זוהה'}</dd>
          <dd className="mt-1 text-xs text-ink-muted">{confidenceLabel(interpretation.payload.supplier.confidence)}</dd>
        </dl>
        {/* The supplier is the one value on this card whose grade is not the whole message: it is
            carried into the invoice draft as the payee, so anything short of "clearly" states the
            check out loud instead of leaving the reviewer to infer it from a word. */}
        {supplierCaution && (
          <Note tone="await" className="mt-3" role="status">
            <ShieldAlert className="mt-0.5 shrink-0" size={18} aria-hidden="true" />
            <span>{supplierCaution}</span>
          </Note>
        )}
      </div>

      <TypeReviewControls snapshot={snapshot} canDecide={!isSupplier} onRefetch={onRefetch} />

      <div className="card card-pad">
        <h3 className="section-title">שדות מוצעים</h3>
        <div className="mt-3 divide-y divide-line">
          {interpretation.payload.fields.length === 0 && <p className="py-3 text-sm text-ink-muted">לא הוצעו שדות.</p>}
          {interpretation.payload.fields.map((field) => (
            <div key={field.key} className="grid gap-1 py-3 sm:grid-cols-[minmax(8rem,0.4fr)_minmax(0,1fr)] sm:gap-4">
              <div className="font-medium text-ink-soft">{fieldKeyLabel(field.key)}</div>
              <div className="min-w-0">
                <div className="break-words text-ink-body">{valueText(field.value)}</div>
                {/* Evidence block ids ("block-heading") named nothing a reviewer could act on.
                    The evidence itself is not lost: the source viewer beside this list is where a
                    value is checked against the document. */}
                <div className="mt-1 text-xs text-ink-muted">{confidenceLabel(field.confidence)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card card-pad min-w-0">
        <h3 className="section-title">שורות מוצעות</h3>
        {interpretation.payload.line_items.length === 0 ? (
          <p className="mt-3 text-sm text-ink-muted">לא זוהו שורות פריט.</p>
        ) : (
          <>
            {inconsistentRows > 0 && (
              <Note tone="alert" role="alert" className="mt-3 flex items-start gap-2">
                <ShieldAlert className="mt-0.5 shrink-0" size={18} aria-hidden="true" />
                <span>
                  ב־<span className="num">{inconsistentRows}</span> שורות הכפל אינו מסתדר: כמות × מחיר ליחידה
                  אינו שווה לסכום השורה. בדוק אותן מול המסמך לפני אישור.
                </span>
              </Note>
            )}
            <div className="mt-3 max-w-full overflow-x-auto rounded-lg border border-line" role="region" tabIndex={0} aria-label="טבלת שורות מוצעות; ניתן לגלול בתוך הטבלה">
              <table className="min-w-full bg-surface">
                <thead>
                  <tr className="border-b border-line">
                    <th className="th">שורת מקור</th>
                    <th className="th">ערכים מוצעים</th>
                  </tr>
                </thead>
                <tbody>
                  {interpretation.payload.line_items.map((item, index) => {
                    const arithmetic = lineItemArithmetic(item.values);
                    return (
                      <tr key={`${item.source_row ?? 'none'}-${index}`} className="border-b border-line last:border-b-0">
                        <td className="td num">{item.source_row ?? '—'}</td>
                        <td className="td">
                          <dl className="space-y-1">{Object.entries(item.values).map(([key, value]) => <div key={key}><dt className="inline font-medium">{lineItemKeyLabel(key)}: </dt><dd className="inline">{valueText(value)}</dd></div>)}</dl>
                          {arithmetic && !arithmetic.consistent && (
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <span className="badge-alert">הכפל אינו מסתדר</span>
                              <span className="text-xs text-ink-muted">
                                <span className="num">{arithmetic.quantity}</span> × <span className="num">{arithmetic.unitPrice}</span> = <span className="num">{arithmetic.expected}</span>, ובשורה <span className="num">{arithmetic.lineTotal}</span>
                              </span>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {snapshot.annotations.length > 0 && (
        <div className="card card-pad">
          <h3 className="section-title">הערות והחלטות</h3>
          <p className="mt-1 text-sm text-ink-muted">המקור מצוין בכל רשומה; רק משוב מפורש משנה את מצב ההצעה.</p>
          <div className="mt-4 space-y-3">
          {snapshot.annotations.map((annotation) => {
            const feedback = feedbackByAnnotation.get(annotation.id);
            return (
              <article key={annotation.id} className="rounded-lg border border-line bg-surface p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h4 className="break-words font-semibold text-ink-body">{annotation.label}</h4>
                    <p className="mt-1 break-words text-sm text-ink-soft">{annotation.tag_key} · {annotationTarget(snapshot, annotation)}</p>
                    <p className="mt-1 text-xs text-ink-muted">
                      {confidenceLabel(annotation.confidence)} · {ANNOTATION_SOURCE_LABELS[annotation.source]} · {fmtDateTime(annotation.created_at)}
                      {annotation.rule_version ? ` · כלל v${annotation.rule_version}` : ''}
                    </p>
                  </div>
                  <span className={annotation.active ? 'badge-info' : 'badge-idle'}>{annotation.active ? 'פעיל' : 'לא פעיל'}</span>
                </div>
                {feedback && (
                  <div className="mt-3 rounded-lg bg-surface-sunken p-3 text-sm text-ink-soft">
                    <p><strong>{FEEDBACK_LABELS[feedback.feedback_type]}</strong> · {fmtDateTime(feedback.created_at)}</p>
                    <p className="mt-1 break-words">{feedback.reason}</p>
                    <p className="mt-1 break-words text-xs text-ink-muted">מבצע {actorName(snapshot, feedback.actor_id)}</p>
                  </div>
                )}
                {!isSupplier && !feedback && annotation.active && annotation.source !== 'user' && snapshot.job?.status === 'review' && (
                  <FeedbackControls annotation={annotation} onRefetch={onRefetch} />
                )}
              </article>
            );
          })}
          </div>
        </div>
      )}

      {!isSupplier && snapshot.ruleApplications.length > 0 && (
        <div className="card card-pad">
          <h3 className="section-title">כללים שהופעלו</h3>
          <p className="mt-1 text-sm text-ink-muted">כל יישום מקושר לגרסה המדויקת של הכלל ולסימון שעליו פעל.</p>
          <div className="mt-4 space-y-3">
            {snapshot.ruleApplications.map((application) => {
              const rule = ruleById.get(application.rule_id);
              return (
                <article key={application.id} className="rounded-lg border border-line bg-surface p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h4 className="break-words font-semibold text-ink-body">{rule ? `${rule.label} (${rule.tag_key})` : `כלל ${application.rule_id}`}</h4>
                      <p className="mt-1 text-sm text-ink-soft">הופעל על {ruleApplicationTarget(snapshot, application.target_id)}; {confidenceLabel(application.confidence)}</p>
                      <p className="mt-1 text-sm text-ink-muted"><strong>למה הופעל:</strong> {ruleWhy(rule)}</p>
                    </div>
                    <span className="badge-done">כלל v{application.rule_version}</span>
                  </div>
                  {rule && snapshot.job?.status === 'review' && <RuleControls rule={rule} role={role} onRefetch={onRefetch} />}
                </article>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
