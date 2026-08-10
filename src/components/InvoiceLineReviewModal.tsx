import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { toHebrewError } from '../lib/errors';
import { fmtMoneyExact } from '../lib/format';
import { Modal, Note, useToast } from './ui';

export type InvoiceReviewCandidate = {
  invoice_line_id: string;
  purchase_order_item_id: string;
  purchase_order_id: string;
  product_id: string;
  ordered_quantity: number;
  received_quantity: number;
  unit: string;
  unit_price: number;
};

export type InvoiceReviewLine = {
  id: string;
  line_number: number;
  description: string;
  supplier_sku?: string | null;
  barcode?: string | null;
  product_id?: string | null;
  quantity: number;
  unit: string;
  unit_price: number;
  discount_amount?: number;
  vat_rate?: number;
  line_total: number;
  matches?: {
    purchase_order_item_id: string;
    allocated_invoice_quantity: number;
    source: string;
  }[];
};

export type InvoiceLineReviewAssessment = {
  evidence_batch_id?: string | null;
  lines: InvoiceReviewLine[];
  candidate_context?: InvoiceReviewCandidate[];
};

type DraftLine = {
  clientId: string;
  productId: string | null;
  description: string;
  supplierSku: string;
  barcode: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  discountAmount: string;
  vatRate: string;
  lineTotal: string;
};

function toDraft(line?: InvoiceReviewLine): DraftLine {
  return {
    clientId: line?.id ?? crypto.randomUUID(),
    productId: line?.product_id ?? null,
    description: line?.description ?? '',
    supplierSku: line?.supplier_sku ?? '',
    barcode: line?.barcode ?? '',
    quantity: line == null ? '' : String(line.quantity),
    unit: line?.unit ?? '',
    unitPrice: line == null ? '' : String(line.unit_price),
    discountAmount: String(line?.discount_amount ?? 0),
    vatRate: line == null ? '' : String(line.vat_rate ?? ''),
    lineTotal: line == null ? '' : String(line.line_total),
  };
}

function finiteNumber(value: string) {
  if (!value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function InvoiceLineReviewModal({
  invoiceId,
  actorId,
  assessment,
  orderNumbers,
  onClose,
  onSaved,
}: {
  invoiceId: string;
  actorId: string;
  assessment: InvoiceLineReviewAssessment;
  orderNumbers: Record<string, number>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [lines, setLines] = useState<DraftLine[]>(
    assessment.lines.length ? assessment.lines.map(toDraft) : [toDraft()],
  );
  const [evidenceReason, setEvidenceReason] = useState('');
  const [matchReason, setMatchReason] = useState('');
  const [evidenceKey, setEvidenceKey] = useState(() => crypto.randomUUID());
  const [matchKey, setMatchKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState<'evidence' | 'matches' | null>(null);

  const candidatesByLine = useMemo(() => {
    const grouped = new Map<string, InvoiceReviewCandidate[]>();
    for (const candidate of assessment.candidate_context ?? []) {
      const rows = grouped.get(candidate.invoice_line_id) ?? [];
      rows.push(candidate);
      grouped.set(candidate.invoice_line_id, rows);
    }
    return grouped;
  }, [assessment.candidate_context]);
  const ambiguousLines = assessment.lines.filter(
    (line) => (candidatesByLine.get(line.id)?.length ?? 0) > 1,
  );
  const [allocations, setAllocations] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const line of assessment.lines) {
      for (const match of line.matches ?? []) {
        initial[`${line.id}:${match.purchase_order_item_id}`] = String(
          match.allocated_invoice_quantity,
        );
      }
    }
    return initial;
  });

  function updateLine(index: number, field: keyof DraftLine, value: string) {
    setLines((current) => current.map((line, lineIndex) => (
      lineIndex === index ? { ...line, [field]: value } : line
    )));
    // A changed payload is a different command. Keeping the previous key only for an unchanged
    // retry protects against a lost response without turning edits into an idempotency conflict.
    setEvidenceKey(crypto.randomUUID());
  }

  async function saveEvidence() {
    const parsed = lines.map((line, index) => ({
      line_number: index + 1,
      description: line.description.trim(),
      supplier_sku: line.supplierSku.trim() || null,
      barcode: line.barcode.trim() || null,
      // Existing product identity may be preserved, but the form never lets a reviewer invent a
      // product id from the description. New identity comes from supplier SKU/barcode evidence.
      product_id: line.productId,
      quantity: finiteNumber(line.quantity),
      unit: line.unit.trim(),
      unit_price: finiteNumber(line.unitPrice),
      discount_amount: finiteNumber(line.discountAmount),
      vat_rate: finiteNumber(line.vatRate),
      line_total: finiteNumber(line.lineTotal),
      evidence_block_ids: [],
      raw_evidence: { source: 'human_invoice_line_review' },
    }));
    const invalid = parsed.some((line) => (
      !line.description || !line.unit || line.quantity == null || line.quantity <= 0
      || line.unit_price == null || line.unit_price < 0
      || line.discount_amount == null || line.discount_amount < 0
      || line.vat_rate == null || line.vat_rate < 0 || line.vat_rate > 100
      || line.line_total == null || line.line_total < 0
    ));
    if (invalid || !evidenceReason.trim()) {
      toast('יש להשלים את כל נתוני השורות ואת סיבת העדכון', 'error');
      return;
    }

    setBusy('evidence');
    const result = await supabase.rpc('record_invoice_line_evidence', {
      p_evidence_batch_id: crypto.randomUUID(),
      p_invoice_id: invoiceId,
      p_idempotency_key: evidenceKey,
      p_source_type: 'manual_entry',
      p_document_id: null,
      p_interpretation_id: null,
      p_actor_id: actorId,
      p_lines: parsed,
      p_reason: evidenceReason.trim(),
    });
    setBusy(null);
    if (result.error) {
      toast(toHebrewError(result.error.message), 'error');
      return;
    }
    toast('שורות החשבונית נשמרו כגרסת ראיה חדשה');
    onSaved();
  }

  async function saveMatches() {
    if (!assessment.evidence_batch_id || !matchReason.trim()) {
      toast('יש להזין סיבה להקצאה הידנית', 'error');
      return;
    }
    const matches: {
      invoice_line_id: string;
      purchase_order_item_id: string;
      allocated_quantity: number;
    }[] = [];
    for (const line of ambiguousLines) {
      const candidates = candidatesByLine.get(line.id) ?? [];
      let allocated = 0;
      for (const candidate of candidates) {
        const quantity = finiteNumber(
          allocations[`${line.id}:${candidate.purchase_order_item_id}`] ?? '',
        );
        if (quantity != null && quantity > 0) {
          allocated += quantity;
          matches.push({
            invoice_line_id: line.id,
            purchase_order_item_id: candidate.purchase_order_item_id,
            allocated_quantity: quantity,
          });
        }
      }
      if (Math.abs(allocated - line.quantity) > 0.000001) {
        toast(`יש להקצות במלואה את הכמות בשורה ${line.line_number}`, 'error');
        return;
      }
    }
    if (!matches.length) {
      toast('לא הוזנה הקצאה לשמירה', 'error');
      return;
    }

    setBusy('matches');
    const result = await supabase.rpc('record_invoice_line_matches', {
      p_match_set_id: crypto.randomUUID(),
      p_invoice_id: invoiceId,
      p_evidence_batch_id: assessment.evidence_batch_id,
      p_idempotency_key: matchKey,
      p_matches: matches,
      p_reason: matchReason.trim(),
    });
    setBusy(null);
    if (result.error) {
      toast(toHebrewError(result.error.message), 'error');
      return;
    }
    toast('הקצאת השורות להזמנות נשמרה ונבדקה מחדש');
    onSaved();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="בדיקת שורות החשבונית"
      busy={busy !== null}
      statusMessage={busy === 'evidence' ? 'שומר גרסת ראיה חדשה' : busy === 'matches' ? 'שומר הקצאות להזמנות' : undefined}
    >
      <div className="space-y-6">
        <section aria-labelledby="invoice-line-evidence-title">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 id="invoice-line-evidence-title" className="font-medium text-ink">שורות כפי שמופיעות בחשבונית</h3>
              <p className="mt-0.5 text-xs text-ink-muted">שם אינו מזהה מוצר. יש להזין מק״ט ספק או ברקוד כאשר הם מופיעים במסמך.</p>
            </div>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy !== null}
              onClick={() => {
                setLines((current) => [...current, toDraft()]);
                setEvidenceKey(crypto.randomUUID());
              }}
            >
              <Plus size={15} /> הוספת שורה
            </button>
          </div>

          <div className="mt-3 space-y-3">
            {lines.map((line, index) => (
              <fieldset key={line.clientId} className="rounded-lg border border-line-soft p-3">
                <legend className="px-1 text-xs font-medium text-ink-muted">שורה <span className="num">{index + 1}</span></legend>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <label className="sm:col-span-2 lg:col-span-4"><span className="label">תיאור</span><input className="input" value={line.description} onChange={(event) => updateLine(index, 'description', event.target.value)} /></label>
                  <label><span className="label">מק״ט ספק</span><input className="input num" dir="ltr" value={line.supplierSku} onChange={(event) => updateLine(index, 'supplierSku', event.target.value)} /></label>
                  <label><span className="label">ברקוד</span><input className="input num" inputMode="numeric" dir="ltr" value={line.barcode} onChange={(event) => updateLine(index, 'barcode', event.target.value)} /></label>
                  <label><span className="label">כמות</span><input className="input num" type="number" min="0" step="any" value={line.quantity} onChange={(event) => updateLine(index, 'quantity', event.target.value)} /></label>
                  <label><span className="label">יחידה</span><input className="input" value={line.unit} onChange={(event) => updateLine(index, 'unit', event.target.value)} /></label>
                  <label><span className="label">מחיר יחידה</span><input className="input num" type="number" min="0" step="0.01" value={line.unitPrice} onChange={(event) => updateLine(index, 'unitPrice', event.target.value)} /></label>
                  <label><span className="label">הנחה</span><input className="input num" type="number" min="0" step="0.01" value={line.discountAmount} onChange={(event) => updateLine(index, 'discountAmount', event.target.value)} /></label>
                  <label><span className="label">מע״מ (%)</span><input className="input num" type="number" min="0" max="100" step="0.01" value={line.vatRate} onChange={(event) => updateLine(index, 'vatRate', event.target.value)} /></label>
                  <label><span className="label">סך שורה לפני מע״מ</span><input className="input num" type="number" min="0" step="0.01" value={line.lineTotal} onChange={(event) => updateLine(index, 'lineTotal', event.target.value)} /></label>
                </div>
                {lines.length > 1 && (
                  <button
                    type="button"
                    className="mt-3 inline-flex min-h-11 items-center gap-1 text-sm text-alert-solid"
                    disabled={busy !== null}
                    onClick={() => {
                      setLines((current) => current.filter((_, lineIndex) => lineIndex !== index));
                      setEvidenceKey(crypto.randomUUID());
                    }}
                  >
                    <Trash2 size={15} /> הסרת השורה מהגרסה החדשה
                  </button>
                )}
              </fieldset>
            ))}
          </div>
          <label className="mt-3 block"><span className="label">סיבת תיקון השורות</span><textarea className="input" rows={2} value={evidenceReason} onChange={(event) => { setEvidenceReason(event.target.value); setEvidenceKey(crypto.randomUUID()); }} /></label>
          <div className="mt-3 flex justify-end">
            <button type="button" className="btn-primary" disabled={busy !== null} onClick={() => void saveEvidence()}>שמירת שורות ובדיקה מחדש</button>
          </div>
        </section>

        <section className="border-t border-line-soft pt-5" aria-labelledby="invoice-line-match-title">
          <h3 id="invoice-line-match-title" className="font-medium text-ink">הקצאה להזמנות כאשר קיימת עמימות</h3>
          {ambiguousLines.length === 0 ? (
            <Note tone="info">אין כרגע שורה עם יותר מהתאמת הזמנה אפשרית אחת. אם מוצר לא זוהה, יש לתקן תחילה את המק״ט או הברקוד בשורות.</Note>
          ) : (
            <div className="mt-3 space-y-4">
              {ambiguousLines.map((line) => (
                <fieldset key={line.id} className="rounded-lg border border-line-soft p-3">
                  <legend className="px-1 text-sm font-medium">שורה <span className="num">{line.line_number}</span> · {line.description}</legend>
                  <p className="mb-2 text-xs text-ink-muted">יש להקצות יחד את מלוא הכמות: <span className="num">{line.quantity} {line.unit}</span></p>
                  <div className="space-y-2">
                    {(candidatesByLine.get(line.id) ?? []).map((candidate) => {
                      const key = `${line.id}:${candidate.purchase_order_item_id}`;
                      return (
                        <label key={candidate.purchase_order_item_id} className="grid min-h-11 items-center gap-2 rounded-lg bg-surface-sunken px-3 py-2 sm:grid-cols-[1fr_8rem]">
                          <span className="text-sm">
                            הזמנה <span className="num">#{orderNumbers[candidate.purchase_order_id] ?? '—'}</span>
                            <span className="block text-xs text-ink-muted num">הוזמן {candidate.ordered_quantity} · התקבל {candidate.received_quantity} · {fmtMoneyExact(candidate.unit_price)} ל־{candidate.unit}</span>
                          </span>
                          <span><input aria-label={`כמות להקצאה להזמנה ${orderNumbers[candidate.purchase_order_id] ?? ''}`} className="input num" type="number" min="0" step="any" value={allocations[key] ?? ''} onChange={(event) => { setAllocations((current) => ({ ...current, [key]: event.target.value })); setMatchKey(crypto.randomUUID()); }} /></span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              ))}
              <label className="block"><span className="label">סיבת ההקצאה הידנית</span><textarea className="input" rows={2} value={matchReason} onChange={(event) => { setMatchReason(event.target.value); setMatchKey(crypto.randomUUID()); }} /></label>
              <div className="flex justify-end">
                <button type="button" className="btn-primary" disabled={busy !== null} onClick={() => void saveMatches()}>שמירת הקצאות ובדיקה מחדש</button>
              </div>
            </div>
          )}
        </section>

        <div className="flex justify-end border-t border-line-soft pt-4">
          <button type="button" className="btn-secondary" disabled={busy !== null} onClick={onClose}>סגירה</button>
        </div>
      </div>
    </Modal>
  );
}
