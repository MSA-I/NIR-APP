import { Eye, FileText, Loader2, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { fmtDate, fmtDateTime } from '../lib/format';
import { ok, toHebrewError } from '../lib/errors';
import { supabase } from '../lib/supabase';
import type { DocumentRow } from '../lib/types';
import { useQuery, unwrap } from '../lib/useQuery';
import { ActionMenu } from './ActionMenu';
import { ConfirmDialog, ErrorNote, Skeleton, useToast } from './ui';
import { uploadDocument } from './FileUpload';

export interface LinkedReceipt {
  id: string;
  number: number | string;
  received_at: string | null;
}

interface AttachmentItem {
  doc: DocumentRow;
  source: string;
  sourceDate: string | null;
  direct: boolean;
}

/** One invoice document register: direct invoice files and linked delivery notes share the
 *  same rows, vocabulary and actions instead of living in nested cards and galleries. */
export function InvoiceAttachments({ invoiceId, receipts }: { invoiceId: string; receipts: LinkedReceipt[] }) {
  const { profile } = useAuth();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<DocumentRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const receiptsKey = receipts.map((receipt) => receipt.id).join(',');
  const receiptById = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  const canDelete = profile?.role === 'owner' || profile?.role === 'office';

  const { data, loading, error, refetch } = useQuery<{ items: AttachmentItem[]; thumbs: Record<string, string> }>(async () => {
    const invoicePromise = supabase.from('documents').select('*')
      .eq('entity_type', 'invoice').eq('entity_id', invoiceId).is('deleted_at', null);
    const receiptPromise = receiptsKey
      ? supabase.from('documents').select('*').eq('entity_type', 'goods_receipt')
        .in('entity_id', receiptsKey.split(',')).is('deleted_at', null)
      : Promise.resolve({ data: [], error: null });
    const [invoiceResult, receiptResult] = await Promise.all([invoicePromise, receiptPromise]);
    const invoiceDocs = unwrap(invoiceResult) as DocumentRow[];
    const receiptDocs = unwrap(receiptResult) as DocumentRow[];
    const items: AttachmentItem[] = [
      ...invoiceDocs.map((doc) => ({ doc, source: 'חשבונית', sourceDate: null, direct: true })),
      ...receiptDocs.map((doc) => {
        const receipt = receiptById.get(doc.entity_id ?? '');
        return {
          doc,
          source: receipt ? `קבלת סחורה #${receipt.number}` : 'קבלת סחורה',
          sourceDate: receipt?.received_at ?? null,
          direct: false,
        };
      }),
    ].sort((a, b) => b.doc.created_at.localeCompare(a.doc.created_at));
    const thumbs: Record<string, string> = {};
    if (items.length) {
      const { data: signed } = await supabase.storage.from('documents')
        .createSignedUrls(items.map((item) => item.doc.storage_path), 300);
      for (const row of signed ?? []) if (row.path && row.signedUrl && !row.error) thumbs[row.path] = row.signedUrl;
    }
    return { items, thumbs };
  }, [invoiceId, receiptsKey]);

  async function onPick(files: FileList | null) {
    if (!files?.length || !profile) return;
    setBusy(true);
    try {
      const invoice = unwrap(await supabase.from('invoices').select('supplier_id, invoice_date')
        .eq('id', invoiceId).single()) as { supplier_id: string; invoice_date: string };
      for (const file of Array.from(files)) await uploadDocument(profile.org_id, 'invoice', invoiceId, file, {
        documentKind: 'invoice', supplierId: invoice.supplier_id, documentDate: invoice.invoice_date,
      });
      toast(files.length === 1 ? 'המסמך הועלה' : `${files.length} מסמכים הועלו`);
      await refetch();
    } catch (e) {
      toast(toHebrewError(e), 'error');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function open(doc: DocumentRow) {
    const { data: url, error } = await supabase.storage.from('documents').createSignedUrl(doc.storage_path, 300);
    if (error || !url) { toast('שגיאה בפתיחת הקובץ', 'error'); return; }
    window.open(url.signedUrl, '_blank', 'noopener,noreferrer');
  }

  async function remove(doc: DocumentRow) {
    setDeleting(true);
    try {
      ok(await supabase.from('documents').update({
        deleted_at: new Date().toISOString(), deleted_by: profile?.id ?? null,
      }).eq('id', doc.id));
      toast('המסמך הוסר');
      setPendingDelete(null);
      await refetch();
    } catch (e) {
      toast(toHebrewError(e), 'error');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section aria-labelledby="invoice-attachments-title">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="invoice-attachments-title" className="section-title">מסמכים מצורפים</h2>
          <p className="text-xs text-ink-muted">חשבונית ותעודות משלוח מקבלות מקושרות</p>
        </div>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
          הוספת קבצים
        </button>
        <input ref={inputRef} type="file" hidden multiple accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/gif,image/avif,application/pdf"
          onChange={(event) => void onPick(event.target.files)} />
      </div>

      {error ? (
        <ErrorNote message={error} />
      ) : loading ? (
        <div className="divide-y divide-line-soft border-y border-line-strong" role="status" aria-busy="true">
          <span className="sr-only">טוען מסמכים</span>
          {[0, 1].map((index) => (
            <div key={index} className="flex min-h-16 items-center gap-3 py-2">
              <Skeleton className="size-11 rounded-none" />
              <div className="flex-1 space-y-2"><Skeleton className="h-3 w-40" /><Skeleton className="h-3 w-24" /></div>
            </div>
          ))}
        </div>
      ) : data?.items.length ? (
        <ul className="divide-y divide-line-soft border-y border-line-strong">
          {data.items.map(({ doc, source, sourceDate, direct }) => {
            const thumb = data.thumbs[doc.storage_path];
            const image = !!thumb && !!doc.mime_type?.startsWith('image/');
            return (
              <li key={doc.id} className="flex min-h-16 items-center gap-3 py-2">
                <button type="button" onClick={() => void open(doc)} aria-label={`פתיחת ${doc.file_name}`}
                  className="grid size-11 shrink-0 place-items-center border border-line bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                  {image ? <img src={thumb} alt="" className="size-full object-cover" /> : <FileText size={18} className="text-ink-faint" aria-hidden="true" />}
                </button>
                <div className="min-w-0 flex-1">
                  <button type="button" onClick={() => void open(doc)} className="block max-w-full truncate text-start text-sm font-medium text-ink-body hover:text-action">
                    {doc.file_name}
                  </button>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-ink-muted">
                    <span className="font-medium text-ink-soft">{source}</span>
                    <span>{sourceDate ? fmtDate(sourceDate) : fmtDateTime(doc.created_at)}</span>
                  </div>
                </div>
                <ActionMenu label={`פעולות עבור ${doc.file_name}`} items={[
                  { key: 'view', label: 'צפייה', icon: Eye, onSelect: () => void open(doc) },
                  { key: 'delete', label: 'הסרה', icon: Trash2, tone: 'danger', hidden: !direct || !canDelete, onSelect: () => setPendingDelete(doc) },
                ]} />
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="border-y border-dashed border-line px-3 py-5 text-center text-sm text-ink-muted">אין מסמכים מצורפים</div>
      )}

      <ConfirmDialog open={pendingDelete !== null} onClose={() => setPendingDelete(null)}
        onConfirm={() => { if (pendingDelete) void remove(pendingDelete); }}
        title="הסרת מסמך" message={`המסמך "${pendingDelete?.file_name ?? ''}" יוסר מהרשימה. הקובץ נשמר לביקורת.`}
        confirmLabel="הסרה" danger busy={deleting} />
    </section>
  );
}
