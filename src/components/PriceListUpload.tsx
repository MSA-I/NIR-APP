// The ONE price-list intake entry point, shared by Suppliers, Products, PriceLists and the
// supplier portal. Extracted from the near-verbatim duplicates in PriceLists.tsx and
// SupplierPrices.tsx so every "העלאת מחירון" button behaves identically:
//   - PDF / image / Word  → OCR document path: reserve → storage → register → /documents/:id/review
//   - Excel / CSV (staff) → deterministic sheet import for ONE supplier via import_supplier_prices;
//     unmatched product names become NEW products only after an explicit user opt-in, never silently.
// Prices are still written only by the sanctioned RPCs — this file adds no new writer.

import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toHebrewError } from '../lib/errors';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { Modal, Note, ErrorNote, useToast } from './ui';
import { readSheet, matchColumn, mapRows, cellText, cellNumber, skipRow, nameKey, groupSkipped } from '../lib/importSheet';
import { fetchAll } from '../lib/supabasePaging';
import { todayISO } from '../lib/format';
import type { Supplier } from '../lib/types';
import { TusUploadCancelledError, TusUploadError, tusUploadToDocuments } from '../lib/tusUpload';
import { SupplierSelectField, useQuickSupplier } from './QuickSupplierPicker';
import {
  UploadCenter,
  claimActiveUploadTask,
  enqueueUploadCenterBatch,
  markUploadCenterDocumentRegistered,
} from './UploadCenter';

/** Shared display metadata for supplier_price_submissions rows (the per-supplier history ledger). */
export const SUBMISSION_STATUS = {
  accepted: { label: 'נקלט', tone: 'done' },
  accepted_with_rejections: { label: 'נקלט חלקית', tone: 'await' },
  rejected: { label: 'נדחה', tone: 'alert' },
} as const;

export const submissionMonthLabel = (value: string) => new Intl.DateTimeFormat('he-IL', {
  month: 'long', year: 'numeric', timeZone: 'UTC',
}).format(new Date(`${value.slice(0, 7)}-01T00:00:00Z`));

export const PRICE_DOCUMENT_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,.gif,.avif,.doc,.docx,.rtf,.txt,.html,.htm,.odt';
const PRICE_DOCUMENT_MIME: Record<string, string> = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', gif: 'image/gif', avif: 'image/avif', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', rtf: 'application/rtf',
  txt: 'text/plain', html: 'text/html', htm: 'text/html', odt: 'application/vnd.oasis.opendocument.text',
};

export class PriceDocumentError extends Error {}

export type PriceDocumentReservation = { document_id: string; storage_path: string; expires_at: string };
type PriceDocumentRegistration = { document_id: string; job_id: string; storage_path: string; idempotent: boolean };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isSpreadsheet = (name: string) => /\.(csv|xlsx|xls)$/i.test(name);

function priceDocumentMime(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return PRICE_DOCUMENT_MIME[extension] ?? null;
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).sort().join('|') === [...keys].sort().join('|');
}

function parseReservation(value: unknown, orgId: string, supplierId: string): PriceDocumentReservation {
  if (!value || typeof value !== 'object') throw new PriceDocumentError('השרת החזיר הקצאת העלאה לא תקינה.');
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, ['document_id', 'storage_path', 'expires_at'])
      || typeof row.document_id !== 'string' || !UUID_PATTERN.test(row.document_id)
      || typeof row.storage_path !== 'string'
      || typeof row.expires_at !== 'string' || !Number.isFinite(Date.parse(row.expires_at))
      || Date.parse(row.expires_at) <= Date.now()) {
    throw new PriceDocumentError('השרת החזיר הקצאת העלאה לא תקינה.');
  }
  const segments = row.storage_path.split('/');
  if (segments.length !== 5 || segments[0] !== orgId || segments[1] !== 'supplier'
      || segments[2] !== supplierId || segments[3] !== row.document_id || !segments[4]) {
    throw new PriceDocumentError('נתיב ההעלאה שהוחזר אינו תואם לספק ולמסמך.');
  }
  return row as PriceDocumentReservation;
}

function parseRegistration(value: unknown, reservation: Pick<PriceDocumentReservation, 'document_id' | 'storage_path'>): PriceDocumentRegistration {
  if (!value || typeof value !== 'object') throw new PriceDocumentError('השרת לא אישר את רישום המסמך.');
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, ['document_id', 'job_id', 'storage_path', 'idempotent'])
      || row.document_id !== reservation.document_id
      || typeof row.job_id !== 'string' || !UUID_PATTERN.test(row.job_id)
      || row.storage_path !== reservation.storage_path
      || typeof row.idempotent !== 'boolean') {
    throw new PriceDocumentError('השרת לא אישר את רישום המסמך.');
  }
  return row as PriceDocumentRegistration;
}

export async function registerPriceDocument(reservation: Pick<PriceDocumentReservation, 'document_id' | 'storage_path'>) {
  const registered = await supabase.rpc('register_supplier_price_document', { p_document_id: reservation.document_id });
  if (registered.error) throw registered.error;
  return parseRegistration(registered.data, reservation);
}

export async function uploadPriceDocument(orgId: string, supplierId: string, file: File) {
  // Claimed in the synchronous prologue, before any await — null outside the Center's queue.
  const center = claimActiveUploadTask();
  if (!file.size) throw new PriceDocumentError('הקובץ ריק.');
  if (file.size > 10 * 1024 * 1024) throw new PriceDocumentError('הקובץ גדול מ־10MB.');
  const mimeType = priceDocumentMime(file);
  if (!mimeType) throw new PriceDocumentError('סוג הקובץ אינו נתמך לעיבוד מסמכים.');

  const reserved = await supabase.rpc('reserve_supplier_price_document_upload', {
    p_supplier_id: supplierId,
    p_file_name: file.name,
    p_mime_type: mimeType,
  });
  if (reserved.error) throw reserved.error;
  const reservation = parseReservation(reserved.data, orgId, supplierId);

  // Resumable upload against the reserved path (wave 6b). The reservation's expires_at
  // drives the proactive renewal on chunk completion, and a 403 mid-PATCH gets exactly
  // one renew-then-resume before the failure surfaces (PLAN-07 §1.5).
  const handle = tusUploadToDocuments(file, {
    objectName: reservation.storage_path,
    contentType: mimeType,
    onProgress: (percent) => center?.onProgress(percent),
    renewal: { documentId: reservation.document_id, expiresAt: reservation.expires_at },
  });
  center?.registerAbort(handle.abort);
  try {
    await handle.done;
  } catch (uploadError) {
    center?.registerAbort(null);
    if (uploadError instanceof TusUploadCancelledError) throw uploadError;
    throw uploadError instanceof TusUploadError ? new PriceDocumentError(uploadError.message) : uploadError;
  }
  center?.registerAbort(null);
  center?.markStored(reservation.document_id);

  try {
    const registration = await registerPriceDocument(reservation);
    center?.markRegistered(registration.document_id);
    return { documentId: registration.document_id, pending: null };
  } catch (registrationError) {
    return {
      documentId: reservation.document_id,
      pending: reservation,
      registrationError: registrationError instanceof PriceDocumentError
        ? registrationError.message : toHebrewError(registrationError),
    };
  }
}

/* ================= unified upload modal ================= */

interface SheetPreviewRow {
  name: string;
  price: number;
  unit: string;
  productId: string | null;
  /** null productId + ambiguous=true: catalog holds two products with this normalized name. */
  ambiguous: boolean;
}

interface SheetPreview {
  rows: SheetPreviewRow[];
  skipped: { row: number; reason: string }[];
}

/**
 * One modal for every price-list upload button. `supplier` locks the target supplier
 * (per-supplier buttons); without it the user picks one. Spreadsheets are a staff
 * (owner/office) route; the supplier role submits sheets through "הגשת מחירון חודשי".
 */
export function PriceListUploadModal({ supplier, onClose, onImported }: {
  supplier?: Pick<Supplier, 'id' | 'name'> | null;
  onClose: () => void;
  onImported?: () => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const { profile } = useAuth();
  const isStaff = profile?.role === 'owner' || profile?.role === 'office';
  const orgId = profile?.org_id ?? '';

  const [supplierId, setSupplierId] = useState(supplier?.id ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<SheetPreview | null>(null);
  const [createNew, setCreateNew] = useState(false);
  const [reason, setReason] = useState('');
  const [report, setReport] = useState<string | null>(null);
  const [pendingReservation, setPendingReservation] = useState<Pick<PriceDocumentReservation, 'document_id' | 'storage_path'> | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: suppliers, loading: suppliersLoading, error: suppliersError } = useQuery(async () => {
    if (supplier) return [supplier];
    return unwrap(await supabase.from('suppliers').select('id, name').is('deleted_at', null).order('name')) as Pick<Supplier, 'id' | 'name'>[];
  });

  // The dialog that already creates new *products* on the fly stopped dead at a supplier it did
  // not have. `picker.suppliers` is the fetched list plus anything created here, so the name below
  // resolves the moment the row exists rather than after the next refetch.
  const picker = useQuickSupplier(suppliers, setSupplierId);

  const accept = isStaff ? `${PRICE_DOCUMENT_ACCEPT},.xlsx,.xls,.csv` : PRICE_DOCUMENT_ACCEPT;
  const newRows = useMemo(() => (preview?.rows ?? []).filter((r) => !r.productId && !r.ambiguous), [preview]);
  const matchedRows = useMemo(() => (preview?.rows ?? []).filter((r) => r.productId), [preview]);
  const ambiguousRows = useMemo(() => (preview?.rows ?? []).filter((r) => r.ambiguous), [preview]);

  async function parseSheet(sheetFile: File) {
    const sheet = await readSheet(sheetFile);
    const cols = {
      product: matchColumn(sheet.headers, ['מוצר', 'שם מוצר', 'product', 'product_name'], false),
      price: matchColumn(sheet.headers, ['מחיר', 'price'], false),
      unit: matchColumn(sheet.headers, ['יחידה', 'יחידת מידה', 'unit'], false),
    };
    if (!cols.product || !cols.price) {
      throw new PriceDocumentError('נדרשות עמודות "מוצר" ו"מחיר" (העמודה "יחידה" רשות). המחירים ייקלטו עבור הספק שנבחר.');
    }
    const products = await fetchAll<{ id: string; name: string; active: boolean }>((from, to) =>
      supabase.from('products').select('id, name, active').order('id').range(from, to));
    const byName = new Map<string, { id: string; active: boolean } | null>();
    for (const product of products) {
      const key = nameKey(product.name);
      byName.set(key, byName.has(key) ? null : product);
    }
    // Every rejection rule of import_supplier_prices is mirrored here per-row, so one bad line is
    // skipped with its reason instead of poisoning the whole batch server-side: in-file duplicates
    // (first occurrence wins, like the OCR path), the ₪1M price cap, and inactive catalog matches.
    const seenKeys = new Set<string>();
    const { valid, skipped } = mapRows(sheet.rows, (row) => {
      const name = cellText(row, cols.product);
      const price = cellNumber(row, cols.price);
      if (!name || price == null || price <= 0) return skipRow('חסר שם מוצר או מחיר תקין');
      if (price > 1_000_000) return skipRow('מחיר מעל הטווח המותר (עד ₪1,000,000)');
      const key = nameKey(name);
      if (seenKeys.has(key)) return skipRow('מוצר חוזר בקובץ — נקלטת ההופעה הראשונה בלבד');
      seenKeys.add(key);
      const match = byName.get(key);
      if (match && !match.active) return skipRow('המוצר קיים בקטלוג אך אינו פעיל');
      return {
        name,
        price,
        unit: cellText(row, cols.unit) || 'יח׳',
        productId: match?.id ?? null,
        ambiguous: match === null,
      } satisfies SheetPreviewRow;
    });
    if (!valid.length) throw new PriceDocumentError('לא נמצאו שורות תקינות בקובץ.');
    setPreview({ rows: valid, skipped });
  }

  async function submit() {
    if (!supplierId) { toast('יש לבחור ספק למחירון', 'error'); return; }
    if (!file) { toast('יש לבחור קובץ', 'error'); return; }
    setBusy(true);
    try {
      if (isSpreadsheet(file.name)) {
        if (!isStaff) throw new PriceDocumentError('קובצי Excel מוגשים דרך "הגשת מחירון חודשי".');
        await parseSheet(file);
      } else {
        // Runs through the Upload Center's queue so the file gets a per-file progress row;
        // the runner's resolved value (pending registration included) stays authoritative.
        // Boxed because the assignment happens inside the runner closure.
        const outcome: { value: Awaited<ReturnType<typeof uploadPriceDocument>> | null } = { value: null };
        const batch = await enqueueUploadCenterBatch(
          [file],
          async () => {
            outcome.value = await uploadPriceDocument(orgId, supplierId, file);
            return outcome.value;
          },
          {
            source: 'מחירון ספק',
            supplierName: supplierName ?? null,
            classifyFailure: (_item, error) => ({
              message: error instanceof PriceDocumentError ? error.message : toHebrewError(error),
              retryable: false,
            }),
          },
        );
        const result = outcome.value;
        if (batch.failed.length || !result) {
          throw batch.failed[0]?.error ?? new PriceDocumentError('ההעלאה לא הושלמה.');
        }
        if (result.pending) {
          setPendingReservation(result.pending);
          toast(`המקור הועלה, אך רישום המסמך לא הושלם: ${result.registrationError}`, 'error');
          return;
        }
        navigate(`/documents/${result.documentId}/review`);
      }
    } catch (error) {
      if (error instanceof TusUploadCancelledError) return;
      toast(error instanceof PriceDocumentError ? error.message : toHebrewError(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    if (!preview) return;
    if (!reason.trim()) { toast('נדרשת סיבה לעדכון המחירון', 'error'); return; }
    setBusy(true);
    try {
      let workingRows = preview.rows;
      let createdProducts = 0;
      if (createNew && newRows.length) {
        // Explicit user opt-in above — new catalog products are never a side effect. The insert
        // and the price import are two requests; to keep a retry idempotent, the created products
        // are folded back into the preview as "existing" BEFORE the RPC runs, so a failed import
        // never re-inserts them on the next attempt.
        const inserted = await supabase.from('products')
          .insert(newRows.map((r) => ({ org_id: orgId, name: r.name, unit: r.unit, active: true })))
          .select('id, name');
        if (inserted.error) throw inserted.error;
        const idByName = new Map((inserted.data as { id: string; name: string }[]).map((p) => [nameKey(p.name), p.id]));
        workingRows = preview.rows.map((r) => {
          if (r.productId || r.ambiguous) return r;
          const id = idByName.get(nameKey(r.name));
          if (!id) return r;
          createdProducts++;
          return { ...r, productId: id };
        });
        setPreview({ ...preview, rows: workingRows });
        setCreateNew(false);
      }
      const rows = workingRows.filter((r) => r.productId)
        .map((r) => ({ supplier_id: supplierId, product_id: r.productId!, price: r.price, available: true }));
      if (!rows.length) throw new PriceDocumentError('אין שורות לקליטה. סמן יצירת מוצרים חדשים או תקן את הקובץ.');
      const imported = unwrap(await supabase.rpc('import_supplier_prices', {
        p_rows: rows,
        p_effective_date: todayISO(),
        p_reason: reason.trim(),
      })) as { updated: number; created: number; unchanged: number };
      const skippedNew = workingRows.filter((r) => !r.productId && !r.ambiguous).length;
      setReport([
        `עודכנו ${imported.updated} מחירים, נוצרו ${imported.created} רשומות מחירון, ${imported.unchanged} ללא שינוי.`,
        createdProducts ? `נוצרו ${createdProducts} מוצרים חדשים בקטלוג.` : '',
        skippedNew ? `${skippedNew} מוצרים לא מוכרים דולגו (לא אושרה יצירה).` : '',
        ambiguousRows.length ? `${ambiguousRows.length} שורות דולגו — שם המוצר מופיע פעמיים בקטלוג.` : '',
      ].filter(Boolean).join(' '));
      onImported?.();
    } catch (error) {
      toast(error instanceof PriceDocumentError ? error.message : toHebrewError(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function retryRegistration() {
    if (!pendingReservation) return;
    setBusy(true);
    try {
      const registered = await registerPriceDocument(pendingReservation);
      // Lift the matching Upload Center row out of the pending-registration money state.
      markUploadCenterDocumentRegistered(registered.document_id);
      navigate(`/documents/${registered.document_id}/review`);
    } catch (registrationError) {
      toast(registrationError instanceof PriceDocumentError ? registrationError.message : toHebrewError(registrationError), 'error');
    } finally {
      setBusy(false);
    }
  }

  const supplierName = picker.suppliers.find((s) => s.id === supplierId)?.name ?? supplier?.name;

  return (
    <Modal open onClose={onClose} title={supplier ? `העלאת מחירון — ${supplier.name}` : 'העלאת מחירון'}
      wide={!!preview} busy={busy}
      statusMessage={busy ? (preview ? 'קולט את המחירון' : 'מעבד את הקובץ') : undefined}>
      <UploadCenter />
      {report ? (
        <div className="space-y-4">
          <Note tone="done" role="status">{report}</Note>
          <div className="flex justify-end"><button className="btn-primary" onClick={onClose}>סיום</button></div>
        </div>
      ) : pendingReservation ? (
        <div className="space-y-4">
          <Note tone="alert">המקור הועלה, אך רישום המסמך עדיין לא הושלם. אין להעלות אותו שוב; נסה להשלים את הרישום.</Note>
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" disabled={busy} onClick={onClose}>סגירה</button>
            <button className="btn-primary" disabled={busy} onClick={() => void retryRegistration()}>ניסיון רישום נוסף</button>
          </div>
        </div>
      ) : preview ? (
        <div className="space-y-4">
          <Note tone={newRows.length || ambiguousRows.length ? 'await' : 'info'}>
            זוהו <span className="num">{preview.rows.length}</span> שורות עבור {supplierName}: <span className="num">{matchedRows.length}</span> הותאמו למוצרים קיימים,
            {' '}<span className="num">{newRows.length}</span> מוצרים חדשים{ambiguousRows.length ? <>, <span className="num">{ambiguousRows.length}</span> שמות לא חד־משמעיים (ידולגו)</> : null}.
            {preview.skipped.length ? <> {preview.skipped.length} שורות דולגו.</> : null}
          </Note>
          {preview.skipped.length > 0 && (
            <details className="text-sm">
              <summary className="link cursor-pointer">פירוט השורות שדולגו</summary>
              <ul className="mt-2 space-y-1 text-ink-soft">
                {groupSkipped(preview.skipped).map(({ reason: skipReason, rows: skipRows }) => (
                  <li key={skipReason}>
                    {skipReason} — שורות <span className="num">{skipRows.slice(0, 12).join(', ')}</span>
                    {skipRows.length > 12 ? ` ועוד ${skipRows.length - 12}` : ''}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="max-h-64 overflow-y-auto border border-line-soft rounded-lg">
            <table className="w-full">
              <thead className="bg-surface-sunken sticky top-0"><tr><th scope="col" className="th">מוצר</th><th scope="col" className="th">מחיר</th><th scope="col" className="th">התאמה</th></tr></thead>
              <tbody className="divide-y divide-line-soft">
                {preview.rows.slice(0, 100).map((r, i) => (
                  <tr key={i}>
                    <td className="td">{r.name}</td>
                    <td className="td num">₪{r.price.toFixed(2)}</td>
                    <td className="td">{r.productId ? <span className="badge-done">מוצר קיים</span>
                      : r.ambiguous ? <span className="badge-alert">שם כפול בקטלוג</span>
                        : <span className="badge-await">מוצר חדש</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {newRows.length > 0 && (
            <label className="flex items-center gap-2 text-sm text-ink-mid">
              <input type="checkbox" className="rounded" checked={createNew} onChange={(e) => setCreateNew(e.target.checked)} />
              צור {newRows.length === 1 ? 'מוצר חדש אחד' : <>‏<span className="num">{newRows.length}</span> מוצרים חדשים</>} בקטלוג ועדכן את מחירם
            </label>
          )}
          <div><label className="label" htmlFor="price-upload-reason">סיבת העדכון *</label><input id="price-upload-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="מחירון חודשי מהספק" /></div>
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" disabled={busy} onClick={() => { setPreview(null); setCreateNew(false); }}>חזרה</button>
            <button className="btn-primary" disabled={busy} onClick={() => void runImport()}>{busy ? 'קולט…' : 'אישור ועדכון מחירים'}</button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <Note tone="info">
            {isStaff
              ? 'קובץ Excel/CSV נקלט מיד לאחר תצוגה מקדימה; PDF, תמונה או Word עוברים זיהוי אוטומטי ומסך בדיקה. כשמדיניות הקליטה מופעלת, שורה לא מותאמת עם שם ומק״ט או ברקוד יכולה ליצור מוצר חדש; אחרת היא ממתינה לאישור.'
              : 'המקור נשמר כמסמך הספק שלך ומועבר למסך בדיקה. כשמדיניות הקליטה מופעלת, שורה לא מותאמת עם שם ומק״ט או ברקוד יכולה ליצור מוצר חדש; אחרת צוות הלקוח מכריע בה.'}
          </Note>
          {supplier ? null : suppliersError ? <ErrorNote message={suppliersError} /> : (
            <SupplierSelectField picker={picker} id="price-upload-supplier" label="ספק *"
              placeholder={suppliersLoading ? 'טוען ספקים…' : 'בחירת ספק'}
              value={supplierId} disabled={suppliersLoading || busy} />
          )}
          <label className="block">
            <span className="label">קובץ מחירון *</span>
            <input ref={fileRef} type="file" className="input" accept={accept} disabled={busy}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <span className="mt-1 block text-xs text-ink-muted">
              {isStaff ? 'Excel, CSV, PDF, תמונה או Word, עד 10MB.' : 'PDF, תמונה, Word או מסמך טקסט נתמך, עד 10MB.'}
            </span>
          </label>
          {suppliersLoading && !supplier && <span className="block text-xs text-ink-muted" role="status">רשימת הספקים נטענת — ההעלאה תתאפשר מיד בסיום.</span>}
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
            <button className="btn-primary" disabled={busy || !!suppliersError || suppliersLoading}
              title={suppliersLoading ? 'רשימת הספקים נטענת…' : suppliersError ? 'שגיאה בטעינת הספקים' : undefined}
              onClick={() => void submit()}>
              {file && isSpreadsheet(file.name) ? 'המשך לתצוגה מקדימה' : 'העלאה והמשך לבדיקה'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
