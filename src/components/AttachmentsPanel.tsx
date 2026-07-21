import { FileText } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useToast, Skeleton } from './ui';
import { DocumentList } from './FileUpload';
import { fmtDate } from '../lib/format';
import type { DocumentRow } from '../lib/types';

/** The exact shape InvoiceDetail already loads via invoice_receipt_links → goods_receipts. */
export interface LinkedReceipt {
  id: string;
  number: number | string;
  received_at: string | null;
}

/**
 * Invoice attachments hub — the scanned invoice (upload/camera/soft-delete via DocumentList)
 * plus a read-only gallery of delivery notes photographed on the linked goods receipts,
 * so opening an invoice shows every document in one place.
 */
export function InvoiceAttachments({ invoiceId, receipts }: { invoiceId: string; receipts: LinkedReceipt[] }) {
  const toast = useToast();
  // Stable dep: the parent rebuilds the array every render; the id list is what actually matters.
  const receiptsKey = receipts.map((r) => r.id).join(',');

  const { data, loading } = useQuery<{ docs: DocumentRow[]; thumbs: Record<string, string> }>(async () => {
    if (!receiptsKey) return { docs: [], thumbs: {} }; // no linked receipts — no query at all
    const docs = unwrap(await supabase.from('documents').select('*')
      .eq('entity_type', 'goods_receipt').in('entity_id', receiptsKey.split(','))
      .is('deleted_at', null).order('created_at', { ascending: false })) as DocumentRow[];
    const thumbs: Record<string, string> = {};
    if (docs.length) {
      // One batch call for all thumbnails; opening a tile signs a fresh URL so expiry can't bite.
      const { data: signed } = await supabase.storage.from('documents')
        .createSignedUrls(docs.map((d) => d.storage_path), 300);
      for (const s of signed ?? []) if (s.path && s.signedUrl && !s.error) thumbs[s.path] = s.signedUrl;
    }
    return { docs, thumbs };
  }, [receiptsKey]);

  // Same open pattern as FileUpload: a fresh short-lived signed URL per click.
  async function open(doc: DocumentRow) {
    const { data: url, error } = await supabase.storage.from('documents').createSignedUrl(doc.storage_path, 300);
    if (error || !url) { toast('שגיאה בפתיחת הקובץ', 'error'); return; }
    window.open(url.signedUrl, '_blank');
  }

  const groups = receipts
    .map((r) => ({ receipt: r, docs: (data?.docs ?? []).filter((d) => d.entity_id === r.id) }))
    .filter((g) => g.docs.length > 0);

  return (
    <div>
      <div className="section-title mb-3">מסמכים מצורפים</div>

      <section aria-label="חשבונית סרוקה">
        <div className="text-xs font-semibold text-ink-muted mb-1.5">חשבונית סרוקה</div>
        <DocumentList entityType="invoice" entityId={invoiceId} capture />
      </section>

      {receipts.length > 0 && (
        <section aria-label="תעודות משלוח מהקבלות" className="mt-4">
          <div className="text-xs font-semibold text-ink-muted mb-1.5">תעודות משלוח מהקבלות</div>
          {loading ? (
            <div className="flex flex-wrap gap-2" role="status" aria-busy="true">
              <span className="sr-only">טוען תעודות משלוח</span>
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-16 rounded-lg shrink-0" />)}
            </div>
          ) : groups.length ? (
            <div className="space-y-3">
              {groups.map(({ receipt, docs }) => (
                <div key={receipt.id}>
                  <div className="text-xs text-ink-muted mb-1.5">קבלה #{receipt.number} · {fmtDate(receipt.received_at)}</div>
                  <ul className="flex flex-wrap gap-2">
                    {docs.map((d) => {
                      const thumb = data?.thumbs[d.storage_path];
                      const isImage = !!thumb && !!d.mime_type?.startsWith('image/');
                      return (
                        <li key={d.id}>
                          <button type="button" title={d.file_name}
                            aria-label={`פתיחת תעודת המשלוח ${d.file_name} בלשונית חדשה`}
                            onClick={() => void open(d)}
                            className="block cursor-pointer rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface">
                            {isImage ? (
                              <img src={thumb} alt={d.file_name} className="h-16 w-16 object-cover rounded-lg border border-line" />
                            ) : (
                              <span className="flex h-16 w-16 flex-col items-center justify-center gap-1 rounded-lg border border-line bg-surface-sunken px-1">
                                <FileText size={18} className="text-ink-faint shrink-0" aria-hidden="true" />
                                <span className="w-full truncate text-center text-xs text-ink-muted">{d.file_name}</span>
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-ink-muted border border-dashed border-line rounded-lg px-3 py-4 text-center">
              אין תעודות משלוח מצולמות בקבלות המקושרות
            </div>
          )}
        </section>
      )}
    </div>
  );
}
