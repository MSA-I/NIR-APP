import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Loader2, X } from 'lucide-react';
import type { Role } from '../../lib/types';
import { toHebrewError } from '../../lib/errors';
import { fmtDateTime } from '../../lib/format';
import { supabase } from '../../lib/supabase';
import { useToast } from '../ui';
import {
  DOCUMENT_TYPE_LABELS,
  MARK_KIND_LABELS,
  bboxDescription,
  canManageOrganizationRules,
  correctionKey,
  latestCorrections,
  resolvedText,
  type ReviewSnapshot,
  type ReviewTarget,
} from './model';

interface ReviewTargetEditorProps {
  snapshot: ReviewSnapshot;
  role: Role;
  target: ReviewTarget;
  onClose: () => void;
  onRefetch: () => Promise<boolean>;
}

type RuleContext = 'global' | 'document_type' | 'supplier';

export function ReviewTargetEditor({ snapshot, role, target, onClose, onRefetch }: ReviewTargetEditorProps) {
  const toast = useToast();
  const headingId = useId();
  const annotationInputRef = useRef<HTMLInputElement>(null);
  const correctionTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [annotationTag, setAnnotationTag] = useState('');
  const [annotationLabel, setAnnotationLabel] = useState('');
  const [annotationReason, setAnnotationReason] = useState('');
  const [correctedText, setCorrectedText] = useState('');
  const [correctionReason, setCorrectionReason] = useState('');
  const [ruleScope, setRuleScope] = useState<'personal' | 'organization'>('personal');
  const [ruleContext, setRuleContext] = useState<RuleContext>('document_type');
  const [ruleTag, setRuleTag] = useState('');
  const [ruleLabel, setRuleLabel] = useState('');
  const [ruleReason, setRuleReason] = useState('');
  const [exactFingerprint, setExactFingerprint] = useState(true);

  const interpretation = snapshot.interpretation;
  const extraction = snapshot.extraction;
  const canMutate = snapshot.job?.status === 'review' && !!interpretation && !!extraction;
  const isSupplier = role === 'supplier';
  const latest = useMemo(() => latestCorrections(snapshot.reviewCorrections), [snapshot.reviewCorrections]);
  const currentText = target.kind === 'mark'
    ? null
    : resolvedText(
        target.text,
        latest,
        target.kind,
        target.id,
        target.kind === 'table_cell' ? target.rowIndex : null,
        target.kind === 'table_cell' ? target.columnIndex : null,
      );
  const currentCorrection = target.kind === 'mark'
    ? null
    : latest.get(correctionKey(
        target.kind,
        target.id,
        target.kind === 'table_cell' ? target.rowIndex : null,
        target.kind === 'table_cell' ? target.columnIndex : null,
      )) ?? null;

  useEffect(() => {
    setAnnotationTag('');
    setAnnotationLabel('');
    setAnnotationReason('');
    setCorrectedText(currentText?.text ?? '');
    setCorrectionReason('');
    setRuleScope('personal');
    setRuleContext('document_type');
    setRuleTag('');
    setRuleLabel('');
    setRuleReason('');
    setExactFingerprint(true);
    window.requestAnimationFrame(() => {
      (target.kind === 'table_cell' ? correctionTextareaRef.current : annotationInputRef.current)?.focus();
    });
  }, [target.kind, target.id, target.kind === 'table_cell' ? target.rowIndex : null, target.kind === 'table_cell' ? target.columnIndex : null]);

  async function finishMutation(successMessage: string) {
    const refreshed = await onRefetch();
    if (refreshed) toast(successMessage);
    else toast(`${successMessage}, אך רענון המסך נכשל. יש לרענן ידנית לפני פעולה נוספת.`, 'error');
    return refreshed;
  }

  async function addAnnotation(event: FormEvent) {
    event.preventDefault();
    if (!interpretation || !extraction || !canMutate) return;
    if (target.kind === 'table_cell') {
      toast('הערה סמנטית זמינה לקטע טקסט או לסימון; בתא טבלה אפשר לתקן את הטקסט.', 'error');
      return;
    }
    if (!annotationTag.trim() || !annotationLabel.trim() || !annotationReason.trim()) {
      toast('יש למלא מפתח, תווית וסיבה להוספת ההערה.', 'error');
      return;
    }
    setBusy('annotation');
    try {
      const result = await supabase.rpc('add_document_annotation', {
        p_interpretation_id: interpretation.id,
        p_target_kind: target.kind,
        p_target_id: target.id,
        p_tag_key: annotationTag.trim(),
        p_label: annotationLabel.trim(),
        p_reason: annotationReason.trim(),
        p_expected_input_checksum: extraction.input_checksum,
        p_expected_contract_version: extraction.contract_version,
      });
      if (result.error) throw new Error(result.error.message);
      if (await finishMutation('ההערה נשמרה מעל תוצאת הפענוח המקורית')) {
        setAnnotationTag('');
        setAnnotationLabel('');
        setAnnotationReason('');
      }
    } catch (error) {
      toast(toHebrewError(error), 'error');
    } finally {
      setBusy(null);
    }
  }

  async function saveCorrection(event: FormEvent) {
    event.preventDefault();
    if (!interpretation || !extraction || !canMutate || target.kind === 'mark' || !currentText) return;
    if (!correctionReason.trim()) {
      toast('יש להזין סיבה לתיקון.', 'error');
      return;
    }
    if (correctedText === currentText.text) {
      toast('הטקסט המתוקן זהה לטקסט הנוכחי.', 'error');
      return;
    }
    setBusy('correction');
    try {
      const result = await supabase.rpc('add_document_review_correction', {
        p_interpretation_id: interpretation.id,
        p_target_kind: target.kind,
        p_target_id: target.id,
        p_row_index: target.kind === 'table_cell' ? target.rowIndex : null,
        p_column_index: target.kind === 'table_cell' ? target.columnIndex : null,
        p_expected_text: currentText.text,
        p_corrected_text: correctedText,
        p_reason: correctionReason.trim(),
        p_expected_input_checksum: extraction.input_checksum,
        p_expected_contract_version: extraction.contract_version,
        p_expected_revision: currentText.revision,
      });
      if (result.error) throw new Error(result.error.message);
      if (await finishMutation('התיקון נשמר כשכבה חדשה; תוצאת ה־OCR המקורית נשארה ללא שינוי')) {
        setCorrectionReason('');
      }
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      if (/document_review_revision_conflict/i.test(raw)) {
        toast('הטקסט השתנה מאז פתיחת הטופס. הנתונים ירועננו; יש לבדוק ולנסות שוב.', 'error');
        await onRefetch();
      } else {
        toast(toHebrewError(error), 'error');
      }
    } finally {
      setBusy(null);
    }
  }

  async function createRule(event: FormEvent) {
    event.preventDefault();
    if (!interpretation || target.kind !== 'mark' || isSupplier || !canMutate) return;
    if (!ruleTag.trim() || !ruleLabel.trim() || !ruleReason.trim()) {
      toast('יש למלא מפתח, תווית וסיבה ליצירת הכלל.', 'error');
      return;
    }
    if (ruleScope === 'organization' && !canManageOrganizationRules(role)) {
      toast('אין לך הרשאה ליצור כלל ארגוני.', 'error');
      return;
    }
    if (ruleContext === 'supplier' && !snapshot.document?.supplier_id) {
      toast('למסמך אין ספק משויך ומאושר; לא ניתן ליצור כלל לפי ספק על סמך הצעה בלבד.', 'error');
      return;
    }
    setBusy('rule');
    try {
      const result = await supabase.rpc('create_document_learning_rule', {
        p_rule_scope: ruleScope,
        p_document_type: ruleContext === 'global' ? null : interpretation.payload.document_type,
        p_supplier_id: ruleContext === 'supplier' ? snapshot.document?.supplier_id ?? null : null,
        p_mark_kind: target.markKind,
        p_mark_fingerprint: exactFingerprint ? target.fingerprint : null,
        p_tag_key: ruleTag.trim(),
        p_label: ruleLabel.trim(),
        p_reason: ruleReason.trim(),
      });
      if (result.error) throw new Error(result.error.message);
      if (await finishMutation('הכלל נשמר ויוכל לחול במסמכים הבאים')) {
        setRuleTag('');
        setRuleLabel('');
        setRuleReason('');
      }
    } catch (error) {
      toast(toHebrewError(error), 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <aside
      className="card card-pad scroll-mt-4"
      aria-labelledby={headingId}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={headingId} className="section-title">עריכת {target.kind === 'block' ? 'קטע טקסט' : target.kind === 'mark' ? 'סימון' : 'תא טבלה'}</h3>
          <p className="mt-1 break-words text-sm text-ink-soft">{target.label}</p>
          <p className="mt-1 text-xs text-ink-muted">עמוד {target.page} · {bboxDescription(target.bbox)}</p>
        </div>
        <button type="button" className="btn-ghost shrink-0" onClick={onClose} aria-label="סגירת העריכה והחזרת הפוקוס">
          <X size={18} aria-hidden="true" /> סגירה
        </button>
      </div>

      {!canMutate && (
        <div className="note-await mt-4" role="status">אפשר לערוך רק כאשר המסמך במצב „דורש בדיקה”. כעת הנתונים מוצגים לקריאה בלבד.</div>
      )}

      {target.kind !== 'table_cell' && (
        <form className="mt-5 border-t border-line pt-4" onSubmit={addAnnotation}>
          <h4 className="font-semibold text-ink-body">הוספת משמעות</h4>
          <p className="mt-1 text-sm text-ink-muted">ההערה נשמרת כשכבה נפרדת ואינה משנה את החילוץ או את פירוש Claude.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="label">מפתח משמעות</span>
              <input ref={annotationInputRef} className="input" maxLength={100} value={annotationTag} onChange={(event) => setAnnotationTag(event.target.value)} placeholder="למשל urgent" disabled={!canMutate || !!busy} />
            </label>
            <label className="block">
              <span className="label">תווית בעברית</span>
              <input className="input" maxLength={200} value={annotationLabel} onChange={(event) => setAnnotationLabel(event.target.value)} placeholder="למשל דורש טיפול" disabled={!canMutate || !!busy} />
            </label>
          </div>
          <label className="mt-3 block">
            <span className="label">סיבה</span>
            <textarea className="input" rows={2} maxLength={1000} value={annotationReason} onChange={(event) => setAnnotationReason(event.target.value)} disabled={!canMutate || !!busy} />
          </label>
          <button className="btn-primary mt-3" disabled={!canMutate || !!busy}>
            {busy === 'annotation' && <Loader2 className="animate-spin" size={17} aria-hidden="true" />} שמירת הערה
          </button>
        </form>
      )}

      {target.kind !== 'mark' && currentText && (
        <form className="mt-5 border-t border-line pt-4" onSubmit={saveCorrection}>
          <h4 className="font-semibold text-ink-body">תיקון טקסט</h4>
          <dl className="mt-3 grid gap-2 rounded-lg bg-surface-sunken p-3 text-sm">
            <div><dt className="font-medium text-ink-soft">מקור OCR בלתי משתנה</dt><dd className="mt-1 whitespace-pre-wrap break-words text-ink-body">{target.text || 'טקסט ריק'}</dd></div>
            <div><dt className="font-medium text-ink-soft">גרסת עבודה נוכחית</dt><dd className="mt-1 whitespace-pre-wrap break-words text-ink-body">{currentText.text || 'טקסט ריק'} <span className="num text-xs text-ink-muted">(גרסה {currentText.revision})</span></dd></div>
            {currentCorrection && (
              <div>
                <dt className="font-medium text-ink-soft">מקור התיקון האחרון</dt>
                <dd className="mt-1 break-words text-ink-body">
                  {currentCorrection.reason} · {fmtDateTime(currentCorrection.created_at)} · מבצע <span dir="ltr" className="num break-all">{currentCorrection.actor_id}</span>
                </dd>
              </div>
            )}
          </dl>
          <label className="mt-3 block">
            <span className="label">טקסט מתוקן</span>
            <textarea ref={correctionTextareaRef} className="input" rows={4} value={correctedText} onChange={(event) => setCorrectedText(event.target.value)} disabled={!canMutate || !!busy} />
          </label>
          <label className="mt-3 block">
            <span className="label">סיבה</span>
            <textarea className="input" rows={2} maxLength={1000} value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)} disabled={!canMutate || !!busy} />
          </label>
          <button className="btn-primary mt-3" disabled={!canMutate || !!busy || correctedText === currentText.text}>
            {busy === 'correction' && <Loader2 className="animate-spin" size={17} aria-hidden="true" />} שמירת שכבת תיקון
          </button>
        </form>
      )}

      {target.kind === 'mark' && !isSupplier && (
        <form className="mt-5 border-t border-line pt-4" onSubmit={createRule}>
          <h4 className="font-semibold text-ink-body">לימוד כלל למסמכים הבאים</h4>
          <p className="mt-1 text-sm text-ink-muted">הכלל אינו משנה מסמך זה. סימון: {MARK_KIND_LABELS[target.markKind]}; סוג מוצע: {interpretation ? DOCUMENT_TYPE_LABELS[interpretation.payload.document_type] : 'לא זמין'}.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="label">בעלות על הכלל</span>
              <select className="input" value={ruleScope} onChange={(event) => setRuleScope(event.target.value as 'personal' | 'organization')} disabled={!canMutate || !!busy}>
                <option value="personal">אישי — רק עבורי</option>
                {canManageOrganizationRules(role) && <option value="organization">ארגוני — לכל המשתמשים</option>}
              </select>
            </label>
            <label className="block">
              <span className="label">הקשר</span>
              <select className="input" value={ruleContext} onChange={(event) => setRuleContext(event.target.value as RuleContext)} disabled={!canMutate || !!busy}>
                <option value="document_type">סוג המסמך המוצע</option>
                <option value="global">כל סוגי המסמכים</option>
                <option value="supplier" disabled={!snapshot.document?.supplier_id}>ספק משויך וסוג מסמך</option>
              </select>
            </label>
            <label className="block">
              <span className="label">מפתח משמעות</span>
              <input className="input" maxLength={100} value={ruleTag} onChange={(event) => setRuleTag(event.target.value)} disabled={!canMutate || !!busy} />
            </label>
            <label className="block">
              <span className="label">תווית</span>
              <input className="input" maxLength={200} value={ruleLabel} onChange={(event) => setRuleLabel(event.target.value)} disabled={!canMutate || !!busy} />
            </label>
          </div>
          <label className="mt-3 flex min-h-11 items-center gap-3 text-sm text-ink-soft">
            <input type="checkbox" className="h-5 w-5" checked={exactFingerprint} onChange={(event) => setExactFingerprint(event.target.checked)} disabled={!target.fingerprint || !canMutate || !!busy} />
            התאמה לטביעת הסימון המדויקת {target.fingerprint ? '' : '(לסימון אין טביעה זמינה)'}
          </label>
          <label className="mt-3 block">
            <span className="label">סיבה</span>
            <textarea className="input" rows={2} maxLength={1000} value={ruleReason} onChange={(event) => setRuleReason(event.target.value)} disabled={!canMutate || !!busy} />
          </label>
          <button className="btn-primary mt-3" disabled={!canMutate || !!busy}>
            {busy === 'rule' && <Loader2 className="animate-spin" size={17} aria-hidden="true" />} יצירת כלל
          </button>
        </form>
      )}
    </aside>
  );
}
