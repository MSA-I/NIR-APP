// The one price-list intake entry point shared by Suppliers, Products and PriceLists, so every
// "העלאת מחירון" button behaves identically:
//   - PDF / image / Word  → OCR document path: reserve → storage → register → /documents/:id/review
//   - Excel / CSV (staff) → deterministic sheet import for ONE supplier via import_supplier_prices;
//     unmatched product names become NEW products only after an explicit user opt-in, never silently.
// Prices are still written only by the sanctioned RPCs — this file adds no new writer.

import type { TKey } from '../lib/i18n/t';
import { BASE_LOCALE, INTL_LOCALE, type Locale } from '../lib/i18n/locale';
import { useT } from '../lib/i18n/LocaleProvider';
import { useMemo, useRef, useState } from 'react';
import { reasonOr } from '../lib/reason';
import { useNavigate } from 'react-router';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { Modal, Note, ErrorNote, useToast } from './ui';
import { readSheet, matchColumn, mapRows, cellText, skipRow, nameKey, groupSkipped } from '../lib/importSheet';
import { PRICE_REASON_KEYS, parsePrice } from '../lib/price';
import { fetchAll } from '../lib/supabasePaging';
import { fmtMoneyExact, normalizeUnitInput, todayISO } from '../lib/format';
import { canStartSupplierCommerce, NEW_COMMERCE_SUPPLIER_STATUSES } from '../lib/status';
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
  accepted: { key: 'submission_accepted', tone: 'done' },
  accepted_with_rejections: { key: 'submission_accepted_with_rejections', tone: 'await' },
  rejected: { key: 'submission_rejected', tone: 'alert' },
} as const;

export const submissionMonthLabel = (value: string, locale: Locale = BASE_LOCALE) => new Intl.DateTimeFormat(INTL_LOCALE[locale], {
  month: 'long', year: 'numeric', timeZone: 'UTC',
}).format(new Date(`${value.slice(0, 7)}-01T00:00:00Z`));

// No `.html`/`.htm` here either — OPEN-DECISIONS #346, and the same list as FileUpload.tsx minus
// the one type the owner removed. A supplier whose price list arrives as an exported HTML table
// converts it to PDF or XLSX; the DB refuses `text/html` from 0288 regardless of what is offered.
export const PRICE_DOCUMENT_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,.gif,.avif,.doc,.docx,.rtf,.txt,.odt';
const PRICE_DOCUMENT_MIME: Record<string, string> = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', gif: 'image/gif', avif: 'image/avif', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', rtf: 'application/rtf',
  txt: 'text/plain', odt: 'application/vnd.oasis.opendocument.text',
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

function parseReservation(value: unknown, orgId: string, supplierId: string, t: (key: TKey, vars?: Record<string, string | number>) => string): PriceDocumentReservation {
  if (!value || typeof value !== 'object') throw new PriceDocumentError(t('priceUpload.reservationMalformed'));
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, ['document_id', 'storage_path', 'expires_at'])
      || typeof row.document_id !== 'string' || !UUID_PATTERN.test(row.document_id)
      || typeof row.storage_path !== 'string'
      || typeof row.expires_at !== 'string' || !Number.isFinite(Date.parse(row.expires_at))
      || Date.parse(row.expires_at) <= Date.now()) {
    throw new PriceDocumentError(t('priceUpload.reservationMalformed'));
  }
  const segments = row.storage_path.split('/');
  if (segments.length !== 5 || segments[0] !== orgId || segments[1] !== 'supplier'
      || segments[2] !== supplierId || segments[3] !== row.document_id || !segments[4]) {
    throw new PriceDocumentError(t('priceUpload.reservationPathMismatch'));
  }
  return row as PriceDocumentReservation;
}

function parseRegistration(value: unknown, reservation: Pick<PriceDocumentReservation, 'document_id' | 'storage_path'>, t: (key: TKey, vars?: Record<string, string | number>) => string): PriceDocumentRegistration {
  if (!value || typeof value !== 'object') throw new PriceDocumentError(t('priceUpload.registrationUnconfirmed'));
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, ['document_id', 'job_id', 'storage_path', 'idempotent'])
      || row.document_id !== reservation.document_id
      || typeof row.job_id !== 'string' || !UUID_PATTERN.test(row.job_id)
      || row.storage_path !== reservation.storage_path
      || typeof row.idempotent !== 'boolean') {
    throw new PriceDocumentError(t('priceUpload.registrationUnconfirmed'));
  }
  return row as PriceDocumentRegistration;
}

export async function registerPriceDocument(reservation: Pick<PriceDocumentReservation, 'document_id' | 'storage_path'>, t: (key: TKey, vars?: Record<string, string | number>) => string) {
  const registered = await supabase.rpc('register_supplier_price_document', { p_document_id: reservation.document_id });
  if (registered.error) throw registered.error;
  return parseRegistration(registered.data, reservation, t);
}

export async function uploadPriceDocument(orgId: string, supplierId: string, file: File, t: (key: TKey, vars?: Record<string, string | number>) => string, errorText: (error: unknown) => string) {
  // Claimed in the synchronous prologue, before any await — null outside the Center's queue.
  const center = claimActiveUploadTask();
  if (!file.size) throw new PriceDocumentError(t('priceUpload.fileEmpty'));
  if (file.size > 10 * 1024 * 1024) throw new PriceDocumentError(t('priceUpload.fileTooLarge'));
  const mimeType = priceDocumentMime(file);
  if (!mimeType) throw new PriceDocumentError(t('priceUpload.fileTypeUnsupported'));

  const reserved = await supabase.rpc('reserve_supplier_price_document_upload', {
    p_supplier_id: supplierId,
    p_file_name: file.name,
    p_mime_type: mimeType,
  });
  if (reserved.error) throw reserved.error;
  const reservation = parseReservation(reserved.data, orgId, supplierId, t);

  // Resumable upload against the reserved path (wave 6b). The reservation's expires_at
  // drives the proactive renewal on chunk completion, and a 403 mid-PATCH gets exactly
  // one renew-then-resume before the failure surfaces (migration 0065).
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
    const registration = await registerPriceDocument(reservation, t);
    center?.markRegistered(registration.document_id);
    return { documentId: registration.document_id, pending: null };
  } catch (registrationError) {
    return {
      documentId: reservation.document_id,
      pending: reservation,
      registrationError: registrationError instanceof PriceDocumentError
        ? registrationError.message : errorText(registrationError),
    };
  }
}

/* ================= unified upload modal ================= */

interface SheetPreviewRow {
  name: string;
  price: number;
  /* The currency this row will be WRITTEN in. The preview used to render every figure with the
     supplier's currency while the writer named no currency at all and the row landed as ILS --
     a dollar list previewed in dollars and stored in shekels. */
  currency: string;
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
 * One modal for every price-list upload button. `supplier` locks the target business supplier
 * (per-supplier buttons); without it the owner/office user picks one.
 */
export function PriceListUploadModal({ supplier, onClose, onImported }: {
  supplier?: Pick<Supplier, 'id' | 'name'> | null;
  onClose: () => void;
  onImported?: () => void;
}) {
  const { errorText, t } = useT();
  const navigate = useNavigate();
  const toast = useToast();
  const { profile, organizationAccess } = useAuth();
  const canUpload = (organizationAccess?.canWrite ?? true)
    && (profile?.role === 'owner' || profile?.role === 'office');
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
    if (supplier) {
      const row = unwrap(await supabase.from('suppliers').select('id, name, status, default_currency')
        .eq('id', supplier.id).is('deleted_at', null).single()) as Pick<Supplier, 'id' | 'name' | 'status' | 'default_currency'>;
      if (!canStartSupplierCommerce(row.status)) {
        throw new PriceDocumentError(t('priceUpload.PriceDocumentError'));
      }
      return [row];
    }
    return unwrap(await supabase.from('suppliers').select('id, name, default_currency').is('deleted_at', null)
      .in('status', NEW_COMMERCE_SUPPLIER_STATUSES).order('name')) as Pick<Supplier, 'id' | 'name' | 'default_currency'>[];
  });

  // The dialog that already creates new *products* on the fly stopped dead at a supplier it did
  // not have. `picker.suppliers` is the fetched list plus anything created here, so the name below
  // resolves the moment the row exists rather than after the next refetch.
  const picker = useQuickSupplier(suppliers, setSupplierId);

  /* `Intl` calls any three-letter code a currency, `KGM` included. The database asks
     `public.currencies`; so does this, once, and hands the set to the shared parser. */
  const { data: currencyCodes } = useQuery(async () => new Set(
    (unwrap(await supabase.from('currencies').select('code').eq('active', true)) as { code: string }[])
      .map((row) => row.code),
  ));

  const accept = `${PRICE_DOCUMENT_ACCEPT},.xlsx,.xls,.csv`;
  const newRows = useMemo(() => (preview?.rows ?? []).filter((r) => !r.productId && !r.ambiguous), [preview]);
  const matchedRows = useMemo(() => (preview?.rows ?? []).filter((r) => r.productId), [preview]);
  const ambiguousRows = useMemo(() => (preview?.rows ?? []).filter((r) => r.ambiguous), [preview]);

  async function parseSheet(sheetFile: File) {
    const sheet = await readSheet(sheetFile, t);
    const cols = {
      product: matchColumn(sheet.headers, ['מוצר', 'שם מוצר', 'product', 'product_name'], false),
      price: matchColumn(sheet.headers, ['מחיר', 'price'], false),
      unit: matchColumn(sheet.headers, ['יחידה', 'יחידת מידה', 'unit'], false),
    };
    if (!cols.product || !cols.price) {
      throw new PriceDocumentError(t('priceUpload.columnsRequired'));
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
    // (first occurrence wins, like the OCR path), the 1,000,000 price cap, and inactive catalog
    // matches. THE CAP CARRIES NO CURRENCY: `0023:2330` is a bare `> 1000000`, a ceiling on the
    // size of the number rather than on an amount of money. The message used to call it
    // ₪1,000,000, which described a shekel limit the server never had — and read as a much
    // tighter rule than it is to anyone importing a price list in another currency.
    // THE PREVIEW AND THE WRITER NOW READ A PRICE THE SAME WAY, because they call one parser.
    // They did not before, and the disagreement was silent in BOTH directions: `cellNumber`
    // deleted every character that was not a digit, a dot or a minus, so `$12.50` previewed as a
    // shekel 12.50 that the writer then refused, while `1.2345` previewed at four decimals and
    // was stored rounded to two. The cap keeps its own explanation above.
    const currency = (picker.suppliers.find((row) => row.id === supplierId)?.default_currency
      ?? '').toUpperCase();
    const seenKeys = new Set<string>();
    const { valid, skipped } = mapRows(sheet.rows, (row) => {
      const name = cellText(row, cols.product);
      const parsed = parsePrice(cellText(row, cols.price, 64), currency, currencyCodes ?? null);
      if (!name) return skipRow(t('priceUpload.skipRow_missing_name'));
      if (!parsed.ok || parsed.value === null) {
        return skipRow(t(PRICE_REASON_KEYS[parsed.reason ?? 'price_unreadable'] as TKey, {
          currency: parsed.currency ?? '', printed: parsed.printedCurrency ?? '',
        }));
      }
      const price = parsed.value;
      const key = nameKey(name);
      if (seenKeys.has(key)) return skipRow(t('priceUpload.has'));
      seenKeys.add(key);
      const match = byName.get(key);
      if (match && !match.active) return skipRow(t('priceUpload.skipRow_3'));
      return {
        name,
        price,
        currency,
        unit: normalizeUnitInput(cellText(row, cols.unit) || 'יחידה'),
        productId: match?.id ?? null,
        ambiguous: match === null,
      } satisfies SheetPreviewRow;
    }, t('importSheet.invalidRow'));
    if (!valid.length) throw new PriceDocumentError(t('priceUpload.PriceDocumentError_5'));
    setPreview({ rows: valid, skipped });
  }

  async function submit() {
    if (!canUpload) { toast(t('priceUpload.toast'), 'error'); return; }
    if (!supplierId) { toast(t('priceUpload.toast_2'), 'error'); return; }
    if (!file) { toast(t('priceUpload.toast_3'), 'error'); return; }
    setBusy(true);
    try {
      if (isSpreadsheet(file.name)) {
        await parseSheet(file);
      } else {
        // Runs through the Upload Center's queue so the file gets a per-file progress row;
        // the runner's resolved value (pending registration included) stays authoritative.
        // Boxed because the assignment happens inside the runner closure.
        const outcome: { value: Awaited<ReturnType<typeof uploadPriceDocument>> | null } = { value: null };
        const batch = await enqueueUploadCenterBatch(
          [file],
          async () => {
            outcome.value = await uploadPriceDocument(orgId, supplierId, file, t, errorText);
            return outcome.value;
          },
          {
            t,
            errorText,
            source: t('priceUpload.text'),
            supplierName: supplierName ?? null,
            classifyFailure: (_item, error) => ({
              message: error instanceof PriceDocumentError ? error.message : errorText(error),
              retryable: false,
            }),
          },
        );
        const result = outcome.value;
        if (batch.failed.length || !result) {
          throw batch.failed[0]?.error ?? new PriceDocumentError(t('priceUpload.PriceDocumentError_6'));
        }
        if (result.pending) {
          setPendingReservation(result.pending);
          toast(t('priceUpload.registrationIncomplete', { message: result.registrationError }), 'error');
          return;
        }
        navigate(`/documents/${result.documentId}/review`);
      }
    } catch (error) {
      if (error instanceof TusUploadCancelledError) return;
      toast(error instanceof PriceDocumentError ? error.message : errorText(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    if (!preview) return;
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
          .insert(newRows.map((r) => ({ org_id: orgId, name: r.name, unit: normalizeUnitInput(r.unit), active: true })))
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
        .map((r) => ({
          supplier_id: supplierId, product_id: r.productId!, price: r.price,
          available: true, currency: r.currency,
        }));
      if (!rows.length) throw new PriceDocumentError(t('priceUpload.PriceDocumentError_7'));
      const imported = unwrap(await supabase.rpc('import_supplier_prices', {
        p_rows: rows,
        p_effective_date: todayISO(),
        p_reason: reasonOr(reason, 'עדכון המחירון'),
      })) as { updated: number; created: number; unchanged: number };
      const skippedNew = workingRows.filter((r) => !r.productId && !r.ambiguous).length;
      setReport([
        t('priceUpload.importSummary', { updated: imported.updated, created: imported.created, unchanged: imported.unchanged }),
        createdProducts ? t('priceUpload.productsCreated', { count: createdProducts }) : '',
        skippedNew ? t('priceUpload.unknownSkipped', { count: skippedNew }) : '',
        ambiguousRows.length ? t('priceUpload.ambiguousSkipped', { count: ambiguousRows.length }) : '',
      ].filter(Boolean).join(' '));
      onImported?.();
    } catch (error) {
      toast(error instanceof PriceDocumentError ? error.message : errorText(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function retryRegistration() {
    if (!pendingReservation) return;
    setBusy(true);
    try {
      const registered = await registerPriceDocument(pendingReservation, t);
      // Lift the matching Upload Center row out of the pending-registration money state.
      markUploadCenterDocumentRegistered(registered.document_id);
      navigate(`/documents/${registered.document_id}/review`);
    } catch (registrationError) {
      toast(registrationError instanceof PriceDocumentError ? registrationError.message : errorText(registrationError), 'error');
    } finally {
      setBusy(false);
    }
  }

  const selectedSupplier = picker.suppliers.find((s) => s.id === supplierId);
  const supplierName = selectedSupplier?.name ?? supplier?.name;
  /* A price list is the SUPPLIER's own quote, so the preview is in the currency that supplier
     trades in (0217) — not the organisation's. A supplier who quotes dollars would otherwise
     preview as shekels, which is the silent unit swap this campaign exists to end. */
  const supplierCurrency = selectedSupplier?.default_currency;

  return (
    <Modal open onClose={onClose} title={supplier ? t('priceUpload.uploadTitleFor', { supplier: supplier.name }) : t('priceUpload.uploadTitle')}
      wide={!!preview} busy={busy}
      statusMessage={busy ? (preview ? t('priceUpload.text_2') : t('priceUpload.text_3')) : undefined}>
      <UploadCenter />
      {report ? (
        <div className="space-y-4">
          <Note tone="done" role="status">{report}</Note>
          <div className="flex justify-end"><button className="btn-primary" onClick={onClose}>{t('priceUpload.text_4')}</button></div>
        </div>
      ) : pendingReservation ? (
        <div className="space-y-4">
          <Note tone="alert">{t('priceUpload.text_5')}</Note>
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" disabled={busy} onClick={onClose}>{t('priceUpload.text_6')}</button>
            <button className="btn-primary" disabled={busy} onClick={() => void retryRegistration()}>{t('priceUpload.retryRegistration')}</button>
          </div>
        </div>
      ) : preview ? (
        <div className="space-y-4">
          <Note tone={newRows.length || ambiguousRows.length ? 'await' : 'info'}>
            <span className="min-w-0 flex-1">
              {t('priceUpload.detectedBefore')}<span className="num">{preview.rows.length}</span>{t('priceUpload.rowsForSupplier')} {supplierName}: <span className="num">{matchedRows.length}</span>{t('priceUpload.existingProducts')}
              {' '}<span className="num">{newRows.length}</span>{t('priceUpload.newProductsWord')}{ambiguousRows.length ? <>, <span className="num">{ambiguousRows.length}</span>{t('priceUpload.duplicateNamesWord')}</> : null}.
              {preview.skipped.length ? <> {t('priceUpload.rowsSkipped', { count: preview.skipped.length })}</> : null}
            </span>
          </Note>
          {preview.skipped.length > 0 && (
            <details className="text-sm">
              <summary className="link flex min-h-11 cursor-pointer items-center">{t('priceUpload.text_8')}</summary>
              <ul className="mt-2 space-y-1 text-ink-soft">
                {groupSkipped(preview.skipped).map(({ reason: skipReason, rows: skipRows }) => (
                  <li key={skipReason}>
                    {skipReason}{t('priceUpload.rowsWord')}<span className="num">{skipRows.slice(0, 12).join(', ')}</span>
                    {skipRows.length > 12 ? t('priceUpload.andMore', { more: skipRows.length - 12 }) : ''}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="table-scroll max-h-64 overflow-auto rounded-lg border border-line-soft"
            role="region" tabIndex={0} aria-label={t('priceUpload.aria_label')}>
            <table className="w-full">
              <thead className="table-head sticky top-0"><tr><th scope="col" className="th">{t('priceUpload.colProduct')}</th><th scope="col" className="th">{t('priceUpload.colPrice')}</th><th scope="col" className="th">{t('priceUpload.text_11')}</th></tr></thead>
              <tbody className="divide-y divide-line-soft">
                {preview.rows.slice(0, 100).map((r, i) => (
                  <tr key={i}>
                    <td className="td">{r.name}</td>
                    <td className="td num">{fmtMoneyExact(r.price, r.currency || supplierCurrency)}</td>
                    <td className="td">{r.productId ? <span className="badge-done">{t('priceUpload.text_12')}</span>
                      : r.ambiguous ? <span className="badge-alert">{t('priceUpload.text_13')}</span>
                        : <span className="badge-await">{t('priceUpload.text_14')}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {newRows.length > 0 && (
            <label className="flex min-h-11 items-center gap-2 text-sm text-ink-mid">
              <input type="checkbox" className="rounded shrink-0" checked={createNew} onChange={(e) => setCreateNew(e.target.checked)} />
              {t('priceUpload.createWord')} {newRows.length === 1 ? t('priceUpload.text_15') : <>‏<span className="num">{newRows.length}</span> {t('priceUpload.text_16')}</>}{t('priceUpload.inCatalogueAndUpdate')}
            </label>
          )}
          <div><label className="label" htmlFor="price-upload-reason">{t('priceUpload.setReason')}</label><input id="price-upload-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('priceUpload.placeholder')} /></div>
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" disabled={busy} onClick={() => { setPreview(null); setCreateNew(false); }}>{t('priceUpload.setPreview')}</button>
            <button className="btn-primary" disabled={busy} onClick={() => void runImport()}>{busy ? t('priceUpload.runImport') : t('priceUpload.runImport_2')}</button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <Note tone="info">
            {t('priceUpload.text_17')}
          </Note>
          {suppliersError ? <ErrorNote message={suppliersError} /> : supplier ? null : (
            <SupplierSelectField picker={picker} id="price-upload-supplier" label={t('priceUpload.label')}
              placeholder={suppliersLoading ? t('priceUpload.text_18') : t('priceUpload.text_19')}
              value={supplierId} disabled={suppliersLoading || busy} />
          )}
          <label className="block">
            <span className="label">{t('priceUpload.text_20')}</span>
            <input ref={fileRef} type="file" className="input" accept={accept} disabled={busy}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <span className="mt-1 block text-xs text-ink-muted">
              {t('priceUpload.text_21')}
            </span>
          </label>
          {suppliersLoading && !supplier && <span className="block text-xs text-ink-muted" role="status">{t('priceUpload.text_22')}</span>}
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" disabled={busy} onClick={onClose}>{t('priceUpload.text_23')}</button>
            <button className="btn-primary" disabled={busy || !!suppliersError || suppliersLoading}
              title={suppliersLoading ? t('priceUpload.text_24') : suppliersError ? t('priceUpload.text_25') : undefined}
              onClick={() => void submit()}>
              {file && isSpreadsheet(file.name) ? t('priceUpload.isSpreadsheet') : t('priceUpload.isSpreadsheet_2')}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
