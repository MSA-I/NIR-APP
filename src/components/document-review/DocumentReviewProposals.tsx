import { useMemo, useState, type FormEvent } from 'react';
import { Check, Loader2, RotateCcw, ShieldAlert, X } from 'lucide-react';
import type { Role } from '../../lib/types';
import { toHebrewError } from '../../lib/errors';
import { fmtDateTime } from '../../lib/format';
import { supabase } from '../../lib/supabase';
import type { DocumentAnnotation, DocumentFeedback, DocumentLearningRule } from '../../lib/useDocumentProcessing';
import { Note, useToast } from '../ui';
import {
  ANNOTATION_SOURCE_LABELS,
  DOCUMENT_TYPE_LABELS,
  MARK_KIND_LABELS,
  confidenceLabel,
  latestCorrections,
  latestFeedbackByAnnotation,
  latestTypeReviewDecision,
  resolvedText,
  ruleWhy,
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

function TypeReviewControls({ snapshot, canDecide, onRefetch }: {
  snapshot: ReviewSnapshot;
  canDecide: boolean;
  onRefetch: () => Promise<boolean>;
}) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'approved' | 'rejected' | null>(null);
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
  const suggestedLabel = DOCUMENT_TYPE_LABELS[currentInterpretation.payload.document_type];
  const decisionLabel = latest?.decision === 'approved'
    ? `אושר: ${DOCUMENT_TYPE_LABELS[latest.approved_document_type ?? latest.suggested_document_type]}`
    : latest?.decision === 'rejected'
      ? 'ההצעה נדחתה; אין סוג מאושר'
      : 'טרם התקבלה הכרעה';
  const decisionBadgeLabel = latest?.decision === 'approved'
    ? 'מאושר'
    : latest?.decision === 'rejected'
      ? 'נדחה'
      : 'ממתין להכרעה';

  async function decide(decision: 'approved' | 'rejected') {
    if (!reason.trim()) {
      toast('יש להזין סיבה להכרעת סוג המסמך.', 'error');
      return;
    }
    setBusy(decision);
    try {
      const result = await supabase.rpc('review_document_type', {
        p_interpretation_id: currentInterpretation.id,
        p_decision: decision,
        p_expected_suggested_document_type: currentInterpretation.payload.document_type,
        p_reason: reason.trim(),
        p_expected_input_checksum: currentExtraction.input_checksum,
        p_expected_contract_version: currentExtraction.contract_version,
        p_expected_revision: latest?.revision ?? 0,
      });
      if (result.error) throw new Error(result.error.message);
      const refreshed = await onRefetch();
      const success = decision === 'approved' ? 'סוג המסמך אושר ונשמר בנפרד מהצעת Claude' : 'הצעת סוג המסמך נדחתה';
      if (refreshed) toast(success);
      else toast(`${success}, אך רענון המסך נכשל. יש לרענן ידנית לפני פעולה נוספת.`, 'error');
      setReason('');
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      if (/document_type_review_(revision_conflict|context_changed)|document_review_status_invalid/i.test(raw)) {
        toast('הקשר הבדיקה השתנה מאז פתיחת הטופס. הנתונים ירועננו; יש לבדוק ולנסות שוב.', 'error');
        await onRefetch();
      } else {
        toast(toHebrewError(error), 'error');
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card card-pad" aria-labelledby="document-type-review-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="document-type-review-title" className="section-title">הכרעת סוג המסמך</h3>
          <p className="mt-1 text-sm text-ink-muted">הכרעה נשמרת בלדג׳ר נפרד; הצעת Claude אינה משתנה.</p>
        </div>
        <span className={latest?.decision === 'approved' ? 'badge-done' : latest?.decision === 'rejected' ? 'badge-alert' : 'badge-await'}>
          {decisionBadgeLabel}
        </span>
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg bg-surface-sunken p-3">
          <dt className="text-sm font-medium text-ink-soft">הצעת Claude</dt>
          <dd className="mt-1 text-ink-body">{suggestedLabel}</dd>
          <dd className="mt-1 text-xs text-ink-muted">{confidenceLabel(currentInterpretation.payload.document_type_confidence)}</dd>
        </div>
        <div className="rounded-lg bg-surface-sunken p-3" aria-live="polite">
          <dt className="text-sm font-medium text-ink-soft">הכרעה אחרונה</dt>
          <dd className="mt-1 text-ink-body">{decisionLabel}</dd>
          <dd className="mt-1 text-xs text-ink-muted">גרסה <span className="num">{latest?.revision ?? 0}</span></dd>
        </div>
      </dl>

      {latest && (
        <p className="mt-3 break-words text-xs text-ink-muted">
          {latest.reason} · {fmtDateTime(latest.created_at)} · מבצע <span dir="ltr" className="num break-all">{latest.actor_id}</span>
        </p>
      )}

      {canMutate ? (
        <form className="mt-4 border-t border-line pt-4" onSubmit={(event) => event.preventDefault()}>
          <label className="block">
            <span className="label">סיבת ההכרעה</span>
            <textarea className="input" rows={2} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} disabled={!!busy} />
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn-primary" disabled={!!busy || latest?.decision === 'approved'} onClick={() => void decide('approved')}>
              {busy === 'approved' ? <Loader2 className="animate-spin" size={17} aria-hidden="true" /> : <Check size={17} aria-hidden="true" />} אישור הסוג המוצע
            </button>
            <button type="button" className="btn-danger" disabled={!!busy || latest?.decision === 'rejected'} onClick={() => void decide('rejected')}>
              {busy === 'rejected' ? <Loader2 className="animate-spin" size={17} aria-hidden="true" /> : <X size={17} aria-hidden="true" />} דחיית ההצעה
            </button>
          </div>
        </form>
      ) : (
        <Note tone="idle" className="mt-4">
          {canDecide
            ? 'אפשר להכריע את סוג המסמך רק כאשר המשימה במצב „דורש בדיקה”.'
            : 'הכרעת סוג המסמך מוצגת לקריאה בלבד בחשבון ספק.'}
        </Note>
      )}
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

  if (!interpretation) return null;

  return (
    <section className="space-y-4" data-testid="document-review-proposals" aria-labelledby="document-proposals-title">
      <div className="card card-pad">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="document-proposals-title" className="section-title">פירוש מוצע</h2>
            <p className="mt-1 text-sm text-ink-muted">הערכים הבאים הופקו אוטומטית ואינם עובדות מאושרות.</p>
          </div>
          <span className="badge-await">הצעת Claude</span>
        </div>
        <Note tone="await" className="mt-4">
          <ShieldAlert className="mt-0.5 shrink-0" size={18} aria-hidden="true" />
          <span>סוג המסמך המוצע הוא <strong>{DOCUMENT_TYPE_LABELS[interpretation.payload.document_type]}</strong> ({confidenceLabel(interpretation.payload.document_type_confidence)}). זו הצעה בלתי משתנה; הכרעה אנושית, אם קיימת, נשמרת בנפרד.</span>
        </Note>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg bg-surface-sunken p-3">
            <dt className="text-sm font-medium text-ink-soft">ספק מוצע</dt>
            <dd className="mt-1 break-words text-ink-body">{interpretation.payload.supplier.suggested_name || 'לא זוהה'}</dd>
            <dd className="mt-1 text-xs text-ink-muted">{confidenceLabel(interpretation.payload.supplier.confidence)}</dd>
          </div>
          <div className="rounded-lg bg-surface-sunken p-3">
            <dt className="text-sm font-medium text-ink-soft">מקור הפירוש</dt>
            <dd className="mt-1 text-ink-body">{interpretation.provider} · {interpretation.model}</dd>
            <dd className="mt-1 text-xs text-ink-muted">Prompt {interpretation.prompt_version} · schema {interpretation.schema_version}</dd>
          </div>
        </dl>
      </div>

      <TypeReviewControls snapshot={snapshot} canDecide={!isSupplier} onRefetch={onRefetch} />

      <div className="card card-pad">
        <h3 className="section-title">שדות מוצעים</h3>
        <div className="mt-3 divide-y divide-line">
          {interpretation.payload.fields.length === 0 && <p className="py-3 text-sm text-ink-muted">לא הוצעו שדות.</p>}
          {interpretation.payload.fields.map((field) => (
            <div key={field.key} className="grid gap-1 py-3 sm:grid-cols-[minmax(8rem,0.4fr)_minmax(0,1fr)] sm:gap-4">
              <div className="font-medium text-ink-soft">{field.key}</div>
              <div className="min-w-0">
                <div className="break-words text-ink-body">{valueText(field.value)}</div>
                <div className="mt-1 text-xs text-ink-muted">{confidenceLabel(field.confidence)} · ראיות: {field.evidence_block_ids.length ? field.evidence_block_ids.join(', ') : 'לא צורפו'}</div>
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
          <div className="mt-3 max-w-full overflow-x-auto rounded-lg border border-line" tabIndex={0} aria-label="טבלת שורות מוצעות; ניתן לגלול בתוך הטבלה">
            <table className="min-w-full bg-surface">
              <thead>
                <tr className="border-b border-line">
                  <th className="th">שורת מקור</th>
                  <th className="th">ערכים מוצעים</th>
                  <th className="th">ראיות</th>
                </tr>
              </thead>
              <tbody>
                {interpretation.payload.line_items.map((item, index) => (
                  <tr key={`${item.source_row ?? 'none'}-${index}`} className="border-b border-line last:border-b-0">
                    <td className="td num">{item.source_row ?? '—'}</td>
                    <td className="td"><dl className="space-y-1">{Object.entries(item.values).map(([key, value]) => <div key={key}><dt className="inline font-medium">{key}: </dt><dd className="inline">{valueText(value)}</dd></div>)}</dl></td>
                    <td className="td break-words">{item.evidence_block_ids.length ? item.evidence_block_ids.join(', ') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card card-pad">
        <h3 className="section-title">Annotations והחלטות</h3>
        <p className="mt-1 text-sm text-ink-muted">המקור מצוין בכל רשומה; רק משוב מפורש משנה את מצב ההצעה.</p>
        <div className="mt-4 space-y-3">
          {snapshot.annotations.length === 0 && <p className="text-sm text-ink-muted">לא נשמרו annotations למסמך.</p>}
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
                    <p className="mt-1 break-all text-xs text-ink-muted">מבצע <span dir="ltr" className="num">{feedback.actor_id}</span></p>
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

      {!isSupplier && (
        <div className="card card-pad">
          <h3 className="section-title">כללים שהופעלו</h3>
          <p className="mt-1 text-sm text-ink-muted">כל יישום מקושר לגרסה המדויקת של הכלל ולסימון שעליו פעל.</p>
          <div className="mt-4 space-y-3">
            {snapshot.ruleApplications.length === 0 && <p className="text-sm text-ink-muted">לא הופעל כלל נלמד במסמך הזה.</p>}
            {snapshot.ruleApplications.map((application) => {
              const rule = ruleById.get(application.rule_id);
              return (
                <article key={application.id} className="rounded-lg border border-line bg-surface p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h4 className="break-words font-semibold text-ink-body">{rule ? `${rule.label} (${rule.tag_key})` : `כלל ${application.rule_id}`}</h4>
                      <p className="mt-1 text-sm text-ink-soft">הופעל על סימון {application.target_id}; {confidenceLabel(application.confidence)}</p>
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
