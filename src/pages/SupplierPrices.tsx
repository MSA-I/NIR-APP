import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Download, FileCheck2, Pencil, Tags, Upload } from 'lucide-react';
import { toHebrewError } from '../lib/errors';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { DataTable, Modal, useToast, ErrorNote, StatusBadge, Note, SkeletonTable, type Column } from '../components/ui';
import { cellText, matchColumn, nameKey, readSheet } from '../lib/importSheet';
import { fmtDate, todayISO } from '../lib/format';
import { PRODUCT_AVAILABILITY } from '../lib/status';
import type {
  Product,
  SupplierPriceRejection,
  SupplierPriceSubmission,
  SupplierProduct,
} from '../lib/types';

type Row = Omit<SupplierProduct, 'product'> & { product: { id: string; name: string; unit: string } };
type CatalogProduct = Pick<Product, 'id' | 'name' | 'unit'>;
type PortalPrice = Omit<SupplierProduct, 'id' | 'org_id' | 'supplier_id' | 'product'> & {
  supplier_product_id: string;
  product_name: string;
  unit: string;
};
interface SupplierPortalContext {
  organization_name: string;
  supplier: { id: string; name: string };
  prices: PortalPrice[];
}

interface SubmissionRow {
  source_row: number;
  product_id: string | null;
  product_name: string;
  price_text: string;
  available: boolean;
}

interface PreparedSubmission {
  file: File;
  rows: SubmissionRow[];
}

class SubmissionError extends Error {}

interface SubmissionReceipt {
  submission_id: string;
  revision: number;
  status: SupplierPriceSubmission['status'];
  accepted_count: number;
  rejected_count: number;
  unchanged_count: number;
  rejections: SupplierPriceRejection[];
  storage_path: string;
  idempotent: boolean;
}

const SUBMISSION_STATUS = {
  accepted: { label: 'נקלט', tone: 'done' },
  accepted_with_rejections: { label: 'נקלט חלקית', tone: 'await' },
  rejected: { label: 'נדחה', tone: 'alert' },
} as const;

const monthLabel = (value: string) => new Intl.DateTimeFormat('he-IL', {
  month: 'long', year: 'numeric', timeZone: 'UTC',
}).format(new Date(`${value.slice(0, 7)}-01T00:00:00Z`));

const PRICE_DOCUMENT_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,.gif,.avif,.doc,.docx,.rtf,.txt,.html,.htm,.odt';
const PRICE_DOCUMENT_MIME: Record<string, string> = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', gif: 'image/gif', avif: 'image/avif', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', rtf: 'application/rtf',
  txt: 'text/plain', html: 'text/html', htm: 'text/html', odt: 'application/vnd.oasis.opendocument.text',
};

class PriceDocumentError extends Error {}

type PriceDocumentReservation = { document_id: string; storage_path: string; expires_at: string };
type PriceDocumentRegistration = { document_id: string; job_id: string; storage_path: string; idempotent: boolean };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

async function registerPriceDocument(reservation: Pick<PriceDocumentReservation, 'document_id' | 'storage_path'>) {
  const registered = await supabase.rpc('register_supplier_price_document', { p_document_id: reservation.document_id });
  if (registered.error) throw registered.error;
  return parseRegistration(registered.data, reservation);
}

async function uploadPriceDocument(orgId: string, supplierId: string, file: File) {
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

  const uploaded = await supabase.storage.from('documents').upload(reservation.storage_path, file, { contentType: mimeType, upsert: false });
  if (uploaded.error) throw uploaded.error;

  try {
    const registration = await registerPriceDocument(reservation);
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

/** Supplier agent portal — RLS is the boundary; this page never receives another supplier id. */
export default function SupplierPrices() {
  const { profile } = useAuth();
  const toast = useToast();
  const [editFor, setEditFor] = useState<Row | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [documentOpen, setDocumentOpen] = useState(false);

  const { data, loading, error, refetch } = useQuery(async () => {
    const supplierId = profile!.supplier_id!;
    const [portalResult, submissionsResult] = await Promise.all([
      supabase.rpc('supplier_portal_context'),
      supabase.from('supplier_price_submissions').select('*')
        .eq('supplier_id', supplierId)
        .order('target_month', { ascending: false })
        .order('revision', { ascending: false })
        .limit(24),
    ]);
    const portal = unwrap(portalResult) as SupplierPortalContext;
    const rows = portal.prices.map<Row>((price) => ({
      ...price,
      id: price.supplier_product_id,
      org_id: profile!.org_id,
      supplier_id: portal.supplier.id,
      product: { id: price.product_id, name: price.product_name, unit: price.unit },
    }));
    return {
      organizationName: portal.organization_name,
      supplier: portal.supplier,
      rows,
      products: rows.map<CatalogProduct>(({ product }) => product),
      submissions: unwrap(submissionsResult) as SupplierPriceSubmission[],
    };
  });

  const columns: Column<Row>[] = [
    { key: 'product', header: 'מוצר', sortValue: (r) => r.product.name, render: (r) => <span className="font-medium text-ink">{r.product.name}</span> },
    { key: 'unit', header: 'יח׳', priority: 3, render: (r) => r.product.unit },
    { key: 'price', header: 'מחיר נוכחי', className: 'num', sortValue: (r) => r.current_price, render: (r) => <span className="font-semibold">₪{r.current_price.toFixed(2)}</span> },
    { key: 'prev', header: 'מחיר קודם', className: 'num', priority: 3, render: (r) => (r.previous_price != null ? `₪${r.previous_price.toFixed(2)}` : '—') },
    { key: 'date', header: 'בתוקף מ־', priority: 3, sortValue: (r) => r.price_effective_date, render: (r) => fmtDate(r.price_effective_date) },
    { key: 'avail', header: 'זמינות', render: (r) => <StatusBadge meta={PRODUCT_AVAILABILITY[r.available ? 'available' : 'unavailable']} /> },
  ];

  if (loading) return <SkeletonTable cols={5} />;
  if (error || !data) return <ErrorNote message={error ?? 'שגיאה'} />;

  function downloadTemplate() {
    const csvCell = (value: string) => {
      const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const rows = [
      'product_id,product_name,price',
      ...data!.products.map((product) => `${product.id},${csvCell(product.name)},`),
    ];
    const url = URL.createObjectURL(new Blob([`\uFEFF${rows.join('\r\n')}`], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'supplier-price-template.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="page-title flex items-center gap-2"><Tags size={22} /> המחירון שלי</h1>
          <div className="text-sm text-ink-muted mt-1">{`${data.supplier.name} — עדכון מחירים וזמינות עבור ${data.organizationName}`}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary" onClick={downloadTemplate}><Download size={15} /> הורדת תבנית</button>
          <button className="btn-secondary" onClick={() => setDocumentOpen(true)}><Upload size={15} /> PDF, תמונה או Word</button>
          <button className="btn-primary" onClick={() => setImportOpen(true)}><Upload size={15} /> הגשת מחירון חודשי</button>
        </div>
      </div>

      <Note tone="info">
        התבנית כוללת מזהה מוצר ושם קנוני. כל הגשה נשמרת לפי חודש וגרסה; שורה לא מוכרת תידחה בלי ליצור מוצר חדש ובלי לעצור שורות תקינות.
      </Note>

      <DataTable rows={data.rows} columns={columns} searchable
        searchFn={(r, q) => r.product.name.toLowerCase().includes(q)}
        searchLabel="חיפוש במחירון שלי"
        rowLabel={(r) => `מוצר ${r.product.name}`}
        rowActions={(r) => [
          { key: 'edit', label: 'עדכון מחיר וזמינות', icon: Pencil, onSelect: () => setEditFor(r) },
        ]}
        emptyTitle="אין מוצרים במחירון" emptySubtitle="הגש קובץ מחירון כדי להתחיל" />

      <SubmissionHistory submissions={data.submissions} />

      {editFor && (
        <EditModal row={editFor} onClose={() => setEditFor(null)}
          onSaved={() => { setEditFor(null); toast('עודכן בהצלחה'); void refetch(); }} />
      )}
      {importOpen && (
        <ImportModal
          orgId={profile!.org_id}
          supplierId={profile!.supplier_id!}
          products={data.products}
          onClose={() => setImportOpen(false)}
          onDone={() => { setImportOpen(false); void refetch(); }}
        />
      )}
      {documentOpen && (
        <PriceDocumentModal
          orgId={profile!.org_id}
          supplierId={profile!.supplier_id!}
          onClose={() => setDocumentOpen(false)}
        />
      )}
    </div>
  );
}

function PriceDocumentModal({ orgId, supplierId, onClose }: {
  orgId: string;
  supplierId: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [pendingReservation, setPendingReservation] = useState<Pick<PriceDocumentReservation, 'document_id' | 'storage_path'> | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!file) { toast('יש לבחור קובץ', 'error'); return; }
    setBusy(true);
    try {
      const result = await uploadPriceDocument(orgId, supplierId, file);
      if (result.pending) {
        setPendingReservation(result.pending);
        toast(`המקור הועלה, אך רישום המסמך לא הושלם: ${result.registrationError}`, 'error');
        return;
      }
      navigate(`/documents/${result.documentId}/review`);
    } catch (uploadError) {
      toast(uploadError instanceof PriceDocumentError ? uploadError.message : toHebrewError(uploadError), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function retryRegistration() {
    if (!pendingReservation) return;
    setBusy(true);
    try {
      const registered = await registerPriceDocument(pendingReservation);
      navigate(`/documents/${registered.document_id}/review`);
    } catch (registrationError) {
      toast(registrationError instanceof PriceDocumentError ? registrationError.message : toHebrewError(registrationError), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="העלאת מחירון כמסמך" busy={busy} statusMessage={busy ? 'שומר ומכניס את המסמך לעיבוד' : undefined}>
      {pendingReservation ? (
        <div className="space-y-4">
          <Note tone="alert">המקור הועלה, אך רישום המסמך עדיין לא הושלם. אין להעלות אותו שוב; נסה להשלים את הרישום.</Note>
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" disabled={busy} onClick={onClose}>סגירה</button>
            <button className="btn-primary" disabled={busy} onClick={() => void retryRegistration()}>ניסיון רישום נוסף</button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <Note tone="info">המקור נשמר כמסמך הספק שלך ומועבר למסך בדיקה. מחיר ייכתב רק לאחר אישור; שורה לא מזוהה ניתנת לשיוך למוצר קיים בלבד.</Note>
          <label className="block">
            <span className="label">קובץ מקור *</span>
            <input type="file" className="input" accept={PRICE_DOCUMENT_ACCEPT} disabled={busy}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
            <span className="mt-1 block text-xs text-ink-muted">PDF, תמונה, Word או מסמך טקסט נתמך, עד 10MB.</span>
          </label>
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
            <button className="btn-primary" disabled={busy} onClick={() => void submit()}>העלאה והמשך לבדיקה</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function SubmissionHistory({ submissions }: { submissions: SupplierPriceSubmission[] }) {
  return (
    <section className="card p-4" aria-labelledby="supplier-submissions-heading">
      <div className="flex items-center gap-2 mb-3">
        <FileCheck2 size={18} className="text-action" aria-hidden="true" />
        <h2 id="supplier-submissions-heading" className="section-title">היסטוריית הגשות</h2>
      </div>
      {submissions.length ? (
        <div className="divide-y divide-line-soft">
          {submissions.map((submission) => (
            <div key={submission.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-medium text-ink">{monthLabel(submission.target_month)} · גרסה <span className="num">{submission.revision}</span></div>
                <StatusBadge meta={SUBMISSION_STATUS[submission.status]} />
              </div>
              <div className="mt-1 min-w-0 text-xs text-ink-muted sm:text-sm">
                <div className="truncate" title={submission.file_name ?? undefined}>{submission.file_name ?? 'הגשה מדור קודם'}</div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                  <span>נקלטו <span className="num">{submission.accepted_count}</span></span>
                  <span>ללא שינוי <span className="num">{submission.unchanged_count}</span></span>
                  <span>נדחו <span className="num">{submission.rejected_count}</span></span>
                </div>
              </div>
              {submission.rejections.length > 0 && (
                <RejectionDetails rejections={submission.rejections} />
              )}
            </div>
          ))}
        </div>
      ) : <p className="text-sm text-ink-muted">עדיין לא הוגש מחירון חודשי.</p>}
    </section>
  );
}

function RejectionDetails({ rejections }: { rejections: SupplierPriceRejection[] }) {
  const shown = rejections.slice(0, 20);
  return (
    <details className="mt-2 text-sm">
      <summary className="link cursor-pointer">פירוט שורות שנדחו</summary>
      <ul className="mt-2 space-y-1 text-ink-soft">
        {shown.map((rejection, index) => (
          <li key={`${rejection.row}-${rejection.reason}-${index}`}>
            שורה <span className="num">{rejection.row}</span>{rejection.product ? ` · ${rejection.product}` : ''}: {rejection.message}
          </li>
        ))}
      </ul>
      {rejections.length > shown.length && <p className="mt-2 text-ink-muted">ועוד <span className="num">{rejections.length - shown.length}</span> שורות.</p>}
    </details>
  );
}

function EditModal({ row, onClose, onSaved }: { row: Row; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [price, setPrice] = useState(row.current_price.toString());
  const [available, setAvailable] = useState(row.available);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    const nextPrice = Number(price);
    if (!nextPrice || nextPrice <= 0) { toast('מחיר לא תקין', 'error'); return; }
    if (!reason.trim()) { toast('נדרשת סיבה לעדכון המחיר', 'error'); return; }
    setBusy(true);
    const update = await supabase.rpc('set_supplier_product_price', {
      p_supplier_product_id: row.id,
      p_price: nextPrice,
      p_effective_date: todayISO(),
      p_available: available,
      p_reason: reason.trim(),
    });
    if (update.error) { setBusy(false); toast(toHebrewError(update.error.message), 'error'); return; }
    setBusy(false);
    onSaved();
  }

  return (
    <Modal open onClose={onClose} title={`עדכון — ${row.product.name}`} busy={busy} statusMessage={busy ? 'שומר את המחיר והזמינות' : undefined}>
      <div className="space-y-4">
        <div><label className="label" htmlFor="supplier-price">מחיר (₪)</label><input id="supplier-price" type="number" step="0.01" className="input num" value={price} onChange={(event) => setPrice(event.target.value)} /></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="rounded" checked={available} onChange={(event) => setAvailable(event.target.checked)} /> המוצר זמין</label>
        <div><label className="label" htmlFor="supplier-price-reason">סיבת העדכון *</label><input id="supplier-price-reason" className="input" value={reason} onChange={(event) => setReason(event.target.value)} /></div>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <button className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
        <button className="btn-primary" disabled={busy} onClick={() => void save()}>שמירה</button>
      </div>
    </Modal>
  );
}

function ImportModal({ orgId, supplierId, products, onClose, onDone }: {
  orgId: string;
  supplierId: string;
  products: CatalogProduct[];
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [prepared, setPrepared] = useState<PreparedSubmission | null>(null);
  const [receipt, setReceipt] = useState<SubmissionReceipt | null>(null);
  const [targetMonth, setTargetMonth] = useState(todayISO().slice(0, 7));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');

  async function onFile(file: File) {
    setBusy(true);
    setPhase('קורא ובודק את הקובץ');
    setReceipt(null);
    try {
      const sheet = await readSheet(file);
      const columns = {
        productId: matchColumn(sheet.headers, ['מזהה מוצר', 'מזהה_מוצר', 'product_id', 'product id'], false),
        product: matchColumn(sheet.headers, ['מוצר', 'שם מוצר', 'product', 'product_name'], false),
        price: matchColumn(sheet.headers, ['מחיר', 'price'], false),
        available: matchColumn(sheet.headers, ['זמין', 'זמינות', 'available'], false),
      };
      if ((!columns.productId && !columns.product) || !columns.price) {
        throw new Error('נדרשות עמודת product_id או מוצר, וכן עמודת מחיר. מומלץ להוריד את התבנית המעודכנת.');
      }

      const byId = new Map(products.map((product) => [product.id, product]));
      const byName = new Map<string, CatalogProduct | null>();
      for (const product of products) {
        const key = nameKey(product.name);
        byName.set(key, byName.has(key) ? null : product);
      }
      const rows = sheet.rows.map((row, index): SubmissionRow => {
        const suppliedId = cellText(row, columns.productId);
        const suppliedName = cellText(row, columns.product);
        const product = suppliedId ? byId.get(suppliedId) : (byName.get(nameKey(suppliedName)) ?? undefined);
        const availability = nameKey(cellText(row, columns.available));
        return {
          source_row: index + 2,
          product_id: product?.id ?? null,
          product_name: product?.name ?? (suppliedName || suppliedId),
          price_text: cellText(row, columns.price, 64),
          available: !['0', 'false', 'לא', 'לא זמין', 'unavailable'].includes(availability),
        };
      });
      setPrepared({ file, rows });
    } catch (error) {
      setPrepared(null);
      toast(error instanceof Error ? error.message : 'לא ניתן לקרוא את הקובץ', 'error');
    } finally {
      setBusy(false);
      setPhase('');
    }
  }

  async function runImport() {
    if (!prepared) return;
    if (!targetMonth) { toast('יש לבחור חודש יעד', 'error'); return; }
    if (!reason.trim()) { toast('נדרשת סיבה להגשת המחירון', 'error'); return; }

    setBusy(true);
    const submissionId = crypto.randomUUID();
    const storageName = safeStorageName(prepared.file.name);
    const storagePath = `${orgId}/price-submissions/${supplierId}/${submissionId}/${storageName}`;
    let uploaded = false;
    try {
      setPhase('מעלה את הקובץ באופן פרטי');
      const upload = await supabase.storage.from('price-submissions').upload(storagePath, prepared.file, {
        contentType: sheetMimeType(prepared.file.name),
        upsert: false,
      });
      if (upload.error) throw upload.error;
      uploaded = true;

      setPhase('קולט את המחירים ושומר קבלה');
      const response = await supabase.functions.invoke<SubmissionReceipt>('submit-price-list', {
        body: {
          submissionId,
          supplierId,
          targetMonth: `${targetMonth}-01`,
          fileName: prepared.file.name,
          storagePath,
          reason: reason.trim(),
        },
      });
      let result: SubmissionReceipt;
      if (response.error) {
        // A lost outer HTTP response is not proof of rollback. The Edge Function performs its
        // own checksum reconciliation; this final lookup covers a response lost after it replied.
        const recovered = await supabase.from('supplier_price_submissions').select('*')
          .eq('id', submissionId)
          .maybeSingle();
        if (!recovered.error && recovered.data) {
          result = receiptFromSubmission(recovered.data as SupplierPriceSubmission);
        } else {
          throw new SubmissionError(await edgeErrorMessage(response.error));
        }
      } else if (response.data) {
        result = response.data as SubmissionReceipt;
      } else {
        throw new SubmissionError('השרת לא החזיר קבלת הגשה. נסה שוב עם אותו קובץ כדי לבדוק אם כבר נקלט.');
      }

      if (result.idempotent && result.storage_path !== storagePath) {
        const cleanup = await supabase.storage.from('price-submissions').remove([storagePath]);
        if (cleanup.error) {
          toast('ההגשה כבר נקלטה, אך ניקוי קובץ הניסיון החוזר נכשל. הקובץ אינו רשום ואינו חשוף.', 'error');
        }
      }
      setReceipt(result);
    } catch (error) {
      let cleanupFailed = false;
      if (uploaded) {
        const cleanup = await supabase.storage.from('price-submissions').remove([storagePath]);
        cleanupFailed = Boolean(cleanup.error);
      }
      toast(error instanceof SubmissionError ? error.message : toHebrewError(error), 'error');
      if (cleanupFailed) {
        toast('לא ניתן לאשר אם ההגשה נקלטה או לנקות את הקובץ. נסה שוב עם אותו קובץ כדי לקבל את הקבלה בלי ליצור כפילות.', 'error');
      }
    } finally {
      setBusy(false);
      setPhase('');
    }
  }

  const knownRows = prepared?.rows.filter((row) => row.product_id).length ?? 0;

  return (
    <Modal open onClose={onClose} title="הגשת מחירון חודשי" wide busy={busy} statusMessage={busy ? phase : undefined}>
      {receipt ? (
        <div className="space-y-4">
          <Note tone={receipt.status === 'accepted' ? 'done' : receipt.status === 'rejected' ? 'alert' : 'await'} role="status">
            <div className="font-semibold"><StatusBadge meta={SUBMISSION_STATUS[receipt.status]} /> · {monthLabel(targetMonth)} · גרסה <span className="num">{receipt.revision}</span></div>
            <div className="mt-2">נקלטו <span className="num">{receipt.accepted_count}</span> · ללא שינוי <span className="num">{receipt.unchanged_count}</span> · נדחו <span className="num">{receipt.rejected_count}</span></div>
            {receipt.idempotent && <div className="mt-2">זהו ניסיון חוזר; הוחזרה הקבלה המקורית ולא נוצרה גרסה נוספת.</div>}
          </Note>
          {receipt.rejections.length > 0 && <RejectionDetails rejections={receipt.rejections} />}
          <div className="flex justify-end"><button className="btn-primary" onClick={onDone}>סיום</button></div>
        </div>
      ) : prepared ? (
        <div className="space-y-4">
          <Note tone={knownRows === prepared.rows.length ? 'info' : 'await'}>
            זוהו <span className="num">{prepared.rows.length}</span> שורות; <span className="num">{knownRows}</span> הותאמו לקטלוג. שורות אחרות יוצגו בדוח הדחיות ולא יעצרו את הקליטה.
          </Note>
          <div className="max-h-64 overflow-y-auto border border-line-soft rounded-lg">
            <table className="w-full">
              <thead className="bg-surface-sunken sticky top-0"><tr><th scope="col" className="th">שורה</th><th scope="col" className="th">מוצר</th><th scope="col" className="th">התאמה</th><th scope="col" className="th">מחיר</th></tr></thead>
              <tbody className="divide-y divide-line-soft">
                {prepared.rows.slice(0, 100).map((row) => (
                  <tr key={row.source_row}>
                    <td className="td num">{row.source_row}</td>
                    <td className="td">{row.product_name || '—'}</td>
                    <td className="td"><span className={row.product_id ? 'badge-done' : 'badge-alert'}>{row.product_id ? 'מוצר קנוני' : 'לא מוכר'}</span></td>
                    <td className="td num">{row.price_text || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><label className="label" htmlFor="supplier-price-month">חודש יעד *</label><input id="supplier-price-month" type="month" className="input" value={targetMonth} onChange={(event) => setTargetMonth(event.target.value)} /></div>
            <div><label className="label" htmlFor="supplier-import-reason">סיבת ההגשה *</label><input id="supplier-import-reason" className="input" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="מחירון חודשי / תיקון" /></div>
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" disabled={busy} onClick={() => setPrepared(null)}>בחירת קובץ אחר</button>
            <button className="btn-primary" disabled={busy} onClick={() => void runImport()}>{busy ? 'קולט...' : 'אישור והגשה'}</button>
          </div>
        </div>
      ) : (
        <div className="text-center py-8">
          <p className="text-sm text-ink-soft mb-4">בחר Excel או CSV UTF-8 עם product_id (או שם מוצר קנוני) ועמודת מחיר.</p>
          <button className="btn-primary" disabled={busy} onClick={() => fileRef.current?.click()}><Upload size={16} /> בחירת קובץ</button>
          <input ref={fileRef} type="file" hidden accept=".xlsx,.xls,.csv"
            onClick={(event) => { event.currentTarget.value = ''; }}
            onChange={(event) => event.target.files?.[0] && void onFile(event.target.files[0])} />
        </div>
      )}
    </Modal>
  );
}

async function edgeErrorMessage(error: unknown) {
  const context = (error as { context?: Response } | null)?.context;
  if (context && typeof context.json === 'function') {
    try {
      const body = await context.json() as { error?: { message?: string; detail?: string } };
      if (body.error?.message) {
        return body.error.detail ? `${body.error.message} (${body.error.detail})` : body.error.message;
      }
    } catch { /* use the transport mapping below */ }
    if (context.status === 401) return 'פג תוקף החיבור. יש להתחבר מחדש לפני הגשת המחירון.';
    if (context.status === 403) return 'אין לך הרשאה להגיש מחירון עבור הספק שנבחר.';
    if (context.status === 409) return 'מצב ההגשה השתנה. רענן את המסך ונסה שוב.';
    if (context.status === 413) return 'הקובץ גדול מ־10MB. יש לפצל אותו ולנסות שוב.';
    if (context.status === 404 || context.status >= 500) {
      return 'שירות קליטת המחירונים אינו זמין כרגע. נסה שוב בעוד מספר דקות.';
    }
  }
  return toHebrewError(error);
}

function receiptFromSubmission(submission: SupplierPriceSubmission): SubmissionReceipt {
  if (!submission.storage_path) throw new SubmissionError('הקבלה שנשמרה חסרה נתיב קובץ. אין להעלות מחדש לפני בדיקה.');
  return {
    submission_id: submission.id,
    revision: submission.revision,
    status: submission.status,
    accepted_count: submission.accepted_count,
    rejected_count: submission.rejected_count,
    unchanged_count: submission.unchanged_count,
    rejections: submission.rejections,
    storage_path: submission.storage_path,
    idempotent: true,
  };
}

function safeStorageName(fileName: string) {
  const extension = fileName.match(/\.(csv|xlsx|xls)$/i)?.[0].toLowerCase() ?? '.xlsx';
  const stem = fileName.slice(0, -extension.length).normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 100);
  return `${stem || 'price-list'}${extension}`;
}

function sheetMimeType(fileName: string) {
  if (/\.csv$/i.test(fileName)) return 'text/csv';
  if (/\.xls$/i.test(fileName)) return 'application/vnd.ms-excel';
  return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
}
