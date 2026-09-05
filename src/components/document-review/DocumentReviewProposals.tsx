import type { TKey } from '../../lib/i18n/t';

type TFn = (key: TKey, vars?: Record<string, string | number>) => string;

import { useT } from '../../lib/i18n/LocaleProvider';
import { useEffect, useMemo, useState } from 'react';
import { reasonOr } from '../../lib/reason';
import { useNavigate } from 'react-router';
import { FilePlus2, Info, Loader2, ShieldAlert } from 'lucide-react';
import { fmtDateTime } from '../../lib/format';
import { supabase } from '../../lib/supabase';
import type { InterpretationContract } from '../../lib/useDocumentProcessing';
import { Disclosure, ICON, Note, useToast } from '../ui';
import {
  DOCUMENT_TYPE_KEYS,
  actorName,
  confidenceLabel,
  creditDraftFromInterpretation,
  documentRoutingSummary,
  fieldKeyLabel,
  filingReason,
  latestTypeReviewDecision,
  lineItemArithmetic,
  lineItemKeyLabel,
  paymentConfirmationFacts,
  sameAmount,
  supplierMatchCaution,
  type ReviewSnapshot,
} from './model';
import { DocumentReviewFeedback } from './DocumentReviewFeedback';

interface DocumentReviewProposalsProps {
  snapshot: ReviewSnapshot;
  onRefetch: () => Promise<boolean>;
}

function valueText(value: string | number | boolean | null, t: TFn): string {
  if (value === null) return t('docReview.valueNotRecognised');
  if (typeof value === 'boolean') return value ? t('docReview.valueYes') : t('docReview.valueNo');
  return String(value);
}

function TypeReviewControls({ snapshot, canDecide, onRefetch }: {
  snapshot: ReviewSnapshot;
  canDecide: boolean;
  onRefetch: () => Promise<boolean>;
}) {
  const { errorText, t } = useT();
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
      toast(t('docReview.toast'), 'error');
      return;
    }
    setBusy(true);
    try {
      const result = await supabase.rpc('review_document_type', {
        p_interpretation_id: currentInterpretation.id,
        p_decision: 'approved',
        p_expected_suggested_document_type: automaticType,
        p_reason: reasonOr(reason, 'תיקון סוג המסמך'),
        p_expected_input_checksum: currentExtraction.input_checksum,
        p_expected_contract_version: currentExtraction.contract_version,
        p_expected_revision: latest?.revision ?? 0,
        p_approved_document_type: selectedType,
      });
      if (result.error) throw new Error(result.error.message);
      const refreshed = await onRefetch();
      const success = t('docReview.typeCorrectedTo', { type: t(DOCUMENT_TYPE_KEYS[selectedType]) });
      if (refreshed) toast(success);
      else toast(t('docReview.refreshFailedBeforeMore', { message: success }), 'error');
      setReason('');
      setChosenType(null);
      setCorrecting(false);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      if (/document_type_review_(revision_conflict|context_changed)|document_review_status_invalid/i.test(raw)) {
        toast(t('docReview.toast_2'), 'error');
        await onRefetch();
      } else {
        toast(errorText(error), 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-y border-line-soft py-3" aria-labelledby="document-type-review-title">
      <div className="flex min-h-11 flex-wrap items-center gap-3">
        <h3 id="document-type-review-title" className="text-sm font-medium text-ink-soft">{t('docReview.text')}</h3>
        <strong className="text-sm text-ink-body" aria-live="polite">{t(DOCUMENT_TYPE_KEYS[effectiveType])}</strong>
        <span className={manuallyCorrected ? 'badge-info' : 'badge-done'}>{manuallyCorrected ? t('docReview.text_3') : t('docReview.text_4')}</span>
        {canMutate && !correcting && (
          <button type="button" className="link ms-auto min-h-11" onClick={() => setCorrecting(true)}>
            {t('docReview.setCorrecting')}
          </button>
        )}
      </div>

      {latest && (
        <p className="mt-3 break-words text-xs text-ink-muted">
          {latest.reason} · {fmtDateTime(latest.created_at)} · {t('docReview.actorBy', { name: actorName(snapshot, latest.actor_id) })}
        </p>
      )}

      {canMutate && correcting ? (
        <form className="mt-4 border-t border-line pt-4" onSubmit={(event) => event.preventDefault()}>
          <label className="block">
            <span className="label">{t('docReview.text_6')}</span>
            <select
              className="input"
              value={selectedType}
              disabled={busy}
              onChange={(event) => setChosenType(event.target.value as InterpretationContract['document_type'])}
            >
              {(Object.keys(DOCUMENT_TYPE_KEYS) as InterpretationContract['document_type'][]).map((type) => (
                <option key={type} value={type}>
                  {t(DOCUMENT_TYPE_KEYS[type])}{type === effectiveType ? t('docReview.text_7') : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="mt-3 block">
            <span className="label">{t('docReview.text_8')}</span>
            <textarea className="input" rows={2} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} disabled={busy} />
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn-primary" disabled={busy || selectedType === effectiveType} onClick={() => void saveCorrection()}>
              {busy && <Loader2 className="animate-spin" size={ICON.md} aria-hidden="true" />} {t('docReview.saveCorrection')}
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => { setCorrecting(false); setChosenType(null); setReason(''); }}>
              {t('docReview.text_9')}
            </button>
          </div>
        </form>
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
  { labelKey: TKey }
>> = {
  invoice: {
    labelKey: 'docReview.draftInvoiceLabel',
  },
  delivery_note: {
    // Deliberately does not promise the order is chosen for you. When the automatic path resolved
    // it, the document is already filed to its draft receipt and this panel is not what the
    // reviewer sees; when it did not, the honest sentence is the manual one.
    labelKey: 'docReview.draftReceiptLabel',
  },
  credit_note: {
    labelKey: 'docReview.draftCreditLabel',
  },
};

/**
 * A payment confirmation is reconciled here, not executed.
 *
 * Executing is `execute_payment_request`, which only the accountant may call. That split is the
 * separation of duties this system is built on: whoever files the paperwork is not whoever moves
 * the money. So this panel answers the question a reviewer can actually act on -- does this
 * confirmation correspond to a payment we really made? -- and says plainly where execution lives.
 */
function PaymentConfirmationMatch({ interpretation }: {
  interpretation: NonNullable<ReviewSnapshot['interpretation']>;
}) {
  const { t } = useT();
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
      <h4 className="text-sm font-medium text-ink-soft">{t('docReview.text_10')}</h4>
      <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-3">
        <div><dt className="text-xs text-ink-muted">{t('docReview.text_11')}</dt><dd className="num">{facts.amount === null ? '—' : facts.amount}</dd></div>
        <div><dt className="text-xs text-ink-muted">{t('docReview.text_12')}</dt><dd className="num">{facts.paidDate || '—'}</dd></div>
        <div><dt className="text-xs text-ink-muted">{t('docReview.text_13')}</dt><dd className="break-all num" dir="ltr">{facts.reference || '—'}</dd></div>
      </dl>

      {state.status === 'loading' && <p className="mt-3 text-sm text-ink-muted">{t('docReview.text_14')}</p>}
      {state.status === 'error' && (
        <Note tone="alert" className="mt-3" role="alert">
          {t('docReview.text_15')}
        </Note>
      )}
      {state.status === 'ready' && (
        <div className="mt-3 space-y-2 text-sm">
          {matchedPayments.length > 0 && (
            <Note tone="done">
              <span className="min-w-0 flex-1">
                {t('docReview.matchedPaymentFound', { payments: matchedPayments.map((payment) => t('docReview.paymentRef', { number: payment.number, date: payment.paid_date })).join(', ') })}{' '}
                {t('docReview.text_16')}
              </span>
            </Note>
          )}
          {matchedPayments.length === 0 && matchedRequests.length > 0 && (
            <Note tone="await">
              <span className="min-w-0 flex-1">
                {t('docReview.matchedRequestFound', { requests: matchedRequests.map((request) => `#${request.number}`).join(', ') })}{' '}
                {t('docReview.text_17')}
              </span>
            </Note>
          )}
          {matchedPayments.length === 0 && matchedRequests.length === 0 && (
            <Note tone="alert" role="alert">
              {facts.amount === null
                ? t('docReview.text_18')
                : t('docReview.text_19')}
            </Note>
          )}
          {/* Said explicitly rather than left to be discovered: the reviewer is not being denied a
              button by oversight, and hunting for one they will never have is wasted time. */}
          <p className="text-xs text-ink-muted">
            {t('docReview.text_20')}
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
  const { errorText, t } = useT();
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
    const draft = creditDraftFromInterpretation(interpretation.payload, t);
    const supplierId = interpretation.suggested_supplier_id;
    if (!draft.creditedInvoiceNumber || !supplierId) {
      toast(t('docReview.toast_3'), 'error');
      navigate('/invoices');
      return;
    }
    setBusy(true);
    const found = await supabase.from('invoices').select('id')
      .eq('supplier_id', supplierId).eq('invoice_number', draft.creditedInvoiceNumber)
      .eq('financial_role', 'payable').is('deleted_at', null).limit(2);
    setBusy(false);
    if (found.error) { toast(errorText(found.error.message), 'error'); return; }
    const rows = (found.data ?? []) as { id: string }[];
    if (rows.length !== 1) {
      toast(rows.length === 0
        ? t('docReview.creditInvoiceNotFound', { number: draft.creditedInvoiceNumber })
        : t('docReview.creditInvoiceAmbiguous', { number: draft.creditedInvoiceNumber }), 'error');
      navigate('/invoices');
      return;
    }
    navigate(`/invoices/${rows[0].id}?credit=${documentId}`);
  }

  return (
    <div className="mt-2">
      {/* Secondary, not primary. This card renders on the same screen as `DocumentAssessmentPanel`,
          whose "אישור המסמך" already creates the supplier invoice or the draft receipt — with the
          reason, the ledger row and the audit entry. Two petrol buttons offering two routes to the
          same outcome asked the reviewer to pick a mechanism; the shortcut stays, its weight does
          not. */}
      <button
        type="button"
        className="link min-h-11"
        disabled={busy}
        onClick={() => {
          if (documentType === 'invoice') navigate(`/invoices/new?document=${documentId}`);
          else if (documentType === 'delivery_note') navigate(`/receiving?document=${documentId}`);
          else void openCreditDraft();
        }}
      >
        {busy ? <Loader2 className="animate-spin" size={ICON.md} aria-hidden="true" /> : <FilePlus2 size={ICON.md} aria-hidden="true" />} {t(action.labelKey)}
      </button>
    </div>
  );
}

export function DocumentReviewProposals({ snapshot, onRefetch }: DocumentReviewProposalsProps) {
  const { t } = useT();
  const navigate = useNavigate();
  const interpretation = snapshot.interpretation;
  /**
   * The proposed-lines table builds its rows only once someone opens it.
   *
   * A real price list runs to 338 lines, and each row is a `<dl>` of every key the interpreter
   * returned — roughly 1,700 elements for content nobody asked to see. A shut `<details>` still
   * renders all of it and re-diffs it on every refetch and every feedback submit, so the fold has
   * to gate construction, not only visibility. Same idiom as the workspace's "פרטים טכניים".
   */
  const [linesOpen, setLinesOpen] = useState(false);
  // Counted whether or not the table is open, because this one stays on screen: broken arithmetic
  // is a money claim, and a reviewer must not have to unfold anything to learn it exists.
  const inconsistentRows = useMemo(
    () => (interpretation?.payload.line_items ?? [])
      .filter((item) => lineItemArithmetic(item.values)?.consistent === false).length,
    [interpretation],
  );

  if (!interpretation) return null;

  const supplierCaution = supplierMatchCaution(interpretation.payload.supplier.confidence, t);
  const machineReason = filingReason(snapshot, t);
  const routing = documentRoutingSummary(snapshot, t);

  return (
    <section className="space-y-4" data-testid="document-review-proposals" aria-labelledby="document-proposals-title">
      <div className="card card-pad" data-testid="document-routing-result">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="section-title">{t('docReview.text_30')}</h2>
            <p className="mt-1 text-sm font-medium text-ink-body">{routing.headline}</p>
          </div>
          <span className={routing.completed ? 'badge-done' : 'badge-await'}>{routing.completed ? t('docReview.text_31') : t('docReview.text_32')}</span>
        </div>
        <dl className="mt-3 grid gap-2 rounded-lg bg-surface-sunken p-3 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-ink-muted">{t('docReview.text_33')}</dt><dd className="mt-1 font-medium text-ink-body">{t(DOCUMENT_TYPE_KEYS[interpretation.payload.document_type])}</dd></div>
          <div><dt className="text-xs text-ink-muted">{t('docReview.text_34')}</dt><dd className="mt-1 font-medium text-ink-body">{routing.destination}</dd></div>
        </dl>
        <p className="mt-3 text-sm text-ink-soft">{routing.lineSummary}</p>
        {machineReason && (
          <Note tone="info" className="mt-3" role="status" data-testid="filing-reason">
            <Info className="mt-0.5 shrink-0" size={ICON.md} aria-hidden="true" />
            <span><strong>{t('docReview.text_35')}</strong> {machineReason}</span>
          </Note>
        )}
        {routing.path && routing.actionLabel && (
          <button type="button" className="btn-secondary mt-3" onClick={() => navigate(routing.path!)}>{routing.actionLabel}</button>
        )}
      </div>

      <div className="card card-pad">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="document-proposals-title" className="section-title">{t('docReview.text_36')}</h2>
            <p className="mt-1 text-sm text-ink-muted">{t('docReview.text_37')}</p>
          </div>
          <span className="badge-info">{t('docReview.text_38')}</span>
        </div>
        {/* Provider, model, prompt and schema versions used to sit here as a second card of equal
            weight. They are provenance, not a decision the reviewer makes; they now live in the
            "פרטים טכניים" disclosure at the top of the workspace. */}
        <dl className="mt-4 rounded-lg bg-surface-sunken p-3">
          <dt className="text-sm font-medium text-ink-soft">{t('docReview.text_39')}</dt>
          <dd className="mt-1 break-words text-ink-body">{interpretation.payload.supplier.suggested_name || t('docReview.text_40')}</dd>
          <dd className="mt-1 text-xs text-ink-muted">{confidenceLabel(interpretation.payload.supplier.confidence, t)}</dd>
        </dl>
        {/* The supplier is the one value on this card whose grade is not the whole message: it is
            carried into the invoice draft as the payee, so anything short of "clearly" states the
            check out loud instead of leaving the reviewer to infer it from a word. */}
        {supplierCaution && (
          <Note tone="await" className="mt-3" role="status">
            <ShieldAlert className="mt-0.5 shrink-0" size={ICON.md} aria-hidden="true" />
            <span>{supplierCaution}</span>
          </Note>
        )}
      </div>

      <TypeReviewControls snapshot={snapshot} canDecide onRefetch={onRefetch} />

      {/* Stays on the surface, above the fold that swallows the table it refers to. Broken
          arithmetic is a money claim, and CLAUDE.md's staged-disclosure rule folds detail, never a
          finding. The sentence names the count and what to do, so it stands on its own. */}
      {inconsistentRows > 0 && (
        <Note tone="alert" role="alert">
          <ShieldAlert className="mt-0.5 shrink-0" size={ICON.md} aria-hidden="true" />
          <span>
            {t('docReview.inconsistentBefore')}<span className="num">{inconsistentRows}</span>{t('docReview.inconsistentAfter')}
            {t('docReview.text_41')}
          </span>
        </Note>
      )}

      {/* Everything the machine produced and is sure about, folded into one card of counted rows.
          It is evidence to check a decision against, not the decision — so it opens on demand. */}
      <div className="card min-w-0 overflow-hidden" data-testid="document-evidence">
        <h3 className="section-title px-4 pt-4 sm:px-5">{t('docReview.text_42')}</h3>

        {interpretation.payload.fields.length > 0 ? (
          <Disclosure className="mt-2 border-t border-line-soft" title={t('docReview.title')} count={interpretation.payload.fields.length}>
            <div className="divide-y divide-line">
              {interpretation.payload.fields.map((field) => (
                <div key={field.key} className="grid gap-1 py-3 first:pt-0 sm:grid-cols-[minmax(8rem,0.4fr)_minmax(0,1fr)] sm:gap-4">
                  <div className="font-medium text-ink-soft">{fieldKeyLabel(field.key, t)}</div>
                  <div className="min-w-0">
                    <div className="break-words text-ink-body">{valueText(field.value, t)}</div>
                    {/* Evidence block ids ("block-heading") named nothing a reviewer could act on.
                        The evidence itself is not lost: the source viewer beside this list is where
                        a value is checked against the document. */}
                    <div className="mt-1 text-xs text-ink-muted">{confidenceLabel(field.confidence, t)}</div>
                  </div>
                </div>
              ))}
            </div>
          </Disclosure>
        ) : (
          <p className="mt-2 border-t border-line-soft px-3 py-3 text-sm text-ink-muted sm:px-4">{t('docReview.text_43')}</p>
        )}

        {interpretation.payload.line_items.length > 0 ? (
          <Disclosure className="border-t border-line-soft" title={t('docReview.title_2')}
            count={interpretation.payload.line_items.length} onToggle={setLinesOpen}>
            {linesOpen && (
              <div className="table-scroll overflow-x-auto rounded-lg border border-line" role="region" tabIndex={0} aria-label={t('docReview.aria_label')}>
                <table className="min-w-full bg-surface">
                  <thead className="table-head">
                    <tr className="border-b border-line">
                      <th scope="col" className="th">{t('docReview.text_44')}</th>
                      <th scope="col" className="th">{t('docReview.text_45')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {interpretation.payload.line_items.map((item, index) => {
                      const arithmetic = lineItemArithmetic(item.values);
                      return (
                        <tr key={`${item.source_row ?? 'none'}-${index}`} className="border-b border-line last:border-b-0">
                          <td className="td num">{item.source_row ?? '—'}</td>
                          <td className="td">
                            <dl className="space-y-1">{Object.entries(item.values).map(([key, value]) => <div key={key}><dt className="inline font-medium">{lineItemKeyLabel(key, t)}: </dt><dd className="inline">{valueText(value, t)}</dd></div>)}</dl>
                            {arithmetic && !arithmetic.consistent && (
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                <span className="badge-alert">{t('docReview.text_46')}</span>
                                <span className="text-xs text-ink-muted">
                                  <span className="num">{arithmetic.quantity}</span> × <span className="num">{arithmetic.unitPrice}</span> = <span className="num">{arithmetic.expected}</span>{t('docReview.text_47')} <span className="num">{arithmetic.lineTotal}</span>
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
            )}
          </Disclosure>
        ) : (
          <p className="border-t border-line-soft px-3 py-3 text-sm text-ink-muted sm:px-4">{t('docReview.text_48')}</p>
        )}

        {snapshot.job?.status === 'review' && (
          <div className="border-t border-line-soft px-3 py-3 sm:px-4">
            <DocumentReviewFeedback
              documentId={snapshot.documentId}
              interpretationId={interpretation.id}
              existing={snapshot.documentReviewFeedback?.[0] ?? null}
              onRefetch={onRefetch}
            />
          </div>
        )}
      </div>
    </section>
  );
}
