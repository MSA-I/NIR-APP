import { useEffect, useRef, useState } from 'react';
import { Camera, Eye, FileInput, FileText, Inbox, Loader2, ReceiptText, Search, Trash2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthContext';
import { useQuery, unwrap } from '../lib/useQuery';
import { INBOX_CHANGED_EVENT, useQuickCapture } from '../components/QuickCapture';
import { ConfirmDialog, EmptyState, ErrorNote, Modal, Skeleton, useToast } from '../components/ui';
import { ok, toHebrewError } from '../lib/errors';
import { logAction } from '../lib/audit';
import { fmtDate, fmtDateTime } from '../lib/format';
import type { DocumentRow } from '../lib/types';
import { ActionMenu } from '../components/ActionMenu';

type RefileTarget = 'invoice' | 'goods_receipt';

type InvoicePick = { id: string; invoice_number: string; invoice_date: string; supplier: { name: string } | null };
type ReceiptPick = { id: string; number: number; received_at: string; order: { supplier: { name: string } | null } | null };

/**
 * שיוך modal: pick the invoice / goods receipt an inbox document belongs to. The update
 * only flips entity_type/entity_id — the stored file never moves (migration 0014) — and the
 * re-filing is written to the audit log, because it changes what a financial document
 * testifies about.
 */
function RefileModal({ doc, target, onClose, onDone }: {
  doc: DocumentRow; target: RefileTarget; onClose: () => void; onDone: () => void | Promise<unknown>;
}) {
  const { profile } = useAuth();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [busy, setBusy] = useState(false);

  // Debounce — otherwise every keystroke is a server round-trip.
  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Out-of-order guard (adversarial review round): useQuery carries no request identity, so a
  // slow response for an OLD search term could land after — and overwrite — the results of the
  // current one. Each invocation takes a token; a resolution whose token is no longer current
  // parks on a never-settling promise, so useQuery never sees its stale rows (the newer
  // invocation is the one that resolves and paints). Local by design — useQuery stays untouched.
  const reqSeq = useRef(0);

  const { data: options, loading } = useQuery<{ id: string; title: string; sub: string }[]>(async () => {
    const token = ++reqSeq.current;
    let result: { id: string; title: string; sub: string }[];
    if (target === 'invoice') {
      let query = supabase.from('invoices')
        .select('id, invoice_number, invoice_date, supplier:suppliers(name)')
        .is('deleted_at', null)
        .order('invoice_date', { ascending: false })
        .limit(20);
      if (dq) query = query.ilike('invoice_number', `%${dq}%`);
      const rows = unwrap(await query) as InvoicePick[];
      result = rows.map((r) => ({
        id: r.id,
        title: `חשבונית ${r.invoice_number}${r.supplier ? ` — ${r.supplier.name}` : ''}`,
        sub: fmtDate(r.invoice_date),
      }));
    } else {
      let query = supabase.from('goods_receipts')
        .select('id, number, received_at, order:purchase_orders(supplier:suppliers(name))')
        .order('received_at', { ascending: false })
        .limit(20);
      // goods_receipts.number is an integer, so a numeric query matches it exactly;
      // free text narrows the fetched page by supplier name instead.
      const numeric = /^\d+$/.test(dq);
      if (dq && numeric) query = query.eq('number', Number(dq));
      let rows = unwrap(await query) as ReceiptPick[];
      if (dq && !numeric) rows = rows.filter((r) => r.order?.supplier?.name.includes(dq));
      result = rows.map((r) => ({
        id: r.id,
        title: `קבלה #${r.number}${r.order?.supplier ? ` — ${r.order.supplier.name}` : ''}`,
        sub: fmtDate(r.received_at),
      }));
    }
    if (token !== reqSeq.current) return new Promise<never>(() => {});
    return result;
  }, [target, dq]);

  async function assign(entityId: string) {
    if (!profile) return;
    setBusy(true);
    try {
      ok(await supabase.from('documents')
        .update({ entity_type: target, entity_id: entityId })
        .eq('id', doc.id));
      await logAction({
        orgId: profile.org_id,
        action: 'document_refiled',
        entityType: 'documents',
        entityId: doc.id,
        oldValues: { entity_type: 'inbox' },
        newValues: { entity_type: target, entity_id: entityId },
      });
      toast('המסמך שויך');
      onClose();
      await onDone();
    } catch (e) {
      toast(toHebrewError(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={target === 'invoice' ? 'שיוך לחשבונית' : 'שיוך לקבלת סחורה'}>
      <p className="text-sm text-ink-soft mb-3 truncate">המסמך: {doc.file_name}</p>
      <div className="relative mb-3">
        <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-ink-faint" />
        <input className="input ps-9!" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder={target === 'invoice' ? 'חיפוש לפי מספר חשבונית...' : 'חיפוש לפי מספר קבלה או ספק...'} />
      </div>
      {loading ? (
        <div className="space-y-2" role="status" aria-busy="true">
          <span className="sr-only">טוען</span>
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
        </div>
      ) : options?.length ? (
        <ul className="divide-y divide-line-soft border border-line-soft rounded-lg max-h-72 overflow-y-auto">
          {options.map((o) => (
            <li key={o.id}>
              <button type="button" disabled={busy} onClick={() => void assign(o.id)}
                className="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-sm text-start row-hover cursor-pointer disabled:cursor-default disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2">
                <span className="min-w-0 truncate text-ink-body">{o.title}</span>
                <span className="text-xs text-ink-muted shrink-0">{o.sub}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-sm text-ink-muted border border-dashed border-line rounded-lg px-3 py-4 text-center">
          {dq ? 'לא נמצאו תוצאות' : target === 'invoice' ? 'אין חשבוניות במערכת' : 'אין קבלות סחורה במערכת'}
        </div>
      )}
    </Modal>
  );
}

/**
 * /inbox — the documents inbox (migration 0014). Everything captured via QuickCapture waits
 * here until it is filed onto the invoice / goods receipt it belongs to, so a photographed
 * paper is never lost between "arrived" and "recorded".
 */
export default function DocumentsInbox() {
  const { profile } = useAuth();
  const toast = useToast();
  // Mirrors the RLS reality: documents_soft_delete (owner/office) is the UPDATE policy
  // behind both re-filing and removal — kitchen captures and views only.
  const canFile = profile?.role === 'owner' || profile?.role === 'office';

  const { data, loading, error, refetch } = useQuery<{ docs: DocumentRow[]; thumbs: Record<string, string> }>(async () => {
    const docs = unwrap(await supabase.from('documents').select('*')
      .eq('entity_type', 'inbox').is('deleted_at', null)
      .order('created_at', { ascending: false })) as DocumentRow[];
    const thumbs: Record<string, string> = {};
    if (docs.length) {
      // One batch call for all thumbnails; opening a card signs a fresh URL so expiry can't bite.
      const { data: signed } = await supabase.storage.from('documents')
        .createSignedUrls(docs.map((d) => d.storage_path), 300);
      for (const s of signed ?? []) if (s.path && s.signedUrl && !s.error) thumbs[s.path] = s.signedUrl;
    }
    return { docs, thumbs };
  }, []);

  const { openCapture, element, busy } = useQuickCapture(refetch);

  // A capture from ANOTHER surface (the global FAB floats over this screen's list too) fires
  // INBOX_CHANGED_EVENT; without listening, the list would sit stale until a manual reload.
  // This page's own capture button keeps its direct onUploaded path above — a double refetch
  // for local captures is harmless (useQuery keeps current data while fetching).
  useEffect(() => {
    const onChanged = () => { void refetch(); };
    window.addEventListener(INBOX_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(INBOX_CHANGED_EVENT, onChanged);
  }, [refetch]);

  const [refile, setRefile] = useState<{ doc: DocumentRow; target: RefileTarget } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DocumentRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Same open pattern as FileUpload: a fresh short-lived signed URL per click.
  async function open(doc: DocumentRow) {
    const { data: url, error: err } = await supabase.storage.from('documents').createSignedUrl(doc.storage_path, 300);
    if (err || !url) { toast('שגיאה בפתיחת הקובץ', 'error'); return; }
    window.open(url.signedUrl, '_blank');
  }

  // Soft delete — the exact contract DocumentList established (0010): flag the row, keep the bytes.
  async function remove(doc: DocumentRow) {
    setDeleting(true);
    try {
      ok(await supabase.from('documents')
        .update({ deleted_at: new Date().toISOString(), deleted_by: profile?.id ?? null })
        .eq('id', doc.id));
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
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title flex items-center gap-2"><Inbox size={22} /> מסמכים לא משויכים</h1>
          <p className="text-sm text-ink-muted mt-1">
            מצלמים את המסמך ברגע שהוא מגיע — ומשייכים אותו מכאן לחשבונית או לקבלת הסחורה כשהרשומה קיימת.
          </p>
        </div>
        <button className="btn-primary" disabled={busy} onClick={openCapture}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Camera size={16} />}
          צילום / העלאה
        </button>
      </div>
      {element}

      {error && <ErrorNote message={error} />}

      {loading ? (
        <div className="divide-y divide-line-soft border-y border-line-strong bg-surface" role="status" aria-busy="true">
          <span className="sr-only">טוען מסמכים</span>
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex min-h-20 items-center gap-3 px-3 py-2.5 sm:px-4">
              <Skeleton className="size-14 shrink-0 rounded-none" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
          ))}
        </div>
      ) : data?.docs.length ? (
        <ul className="divide-y divide-line-soft border-y border-line-strong bg-surface">
          {data.docs.map((d) => {
            const thumb = data.thumbs[d.storage_path];
            const isImage = !!thumb && !!d.mime_type?.startsWith('image/');
            return (
              <li key={d.id} className="flex min-h-20 items-center gap-3 px-3 py-2.5 sm:px-4">
                <button type="button" onClick={() => void open(d)} title={d.file_name}
                  aria-label={`פתיחת המסמך ${d.file_name} בלשונית חדשה`}
                  className="grid size-14 shrink-0 place-items-center border border-line bg-surface-sunken focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2">
                  {isImage ? (
                    <img src={thumb} alt={d.file_name} className="size-full object-cover" />
                  ) : (
                    <FileText size={22} className="text-ink-faint" aria-hidden="true" />
                  )}
                </button>
                <div className="min-w-0 flex-1">
                  <button type="button" onClick={() => void open(d)}
                    className="max-w-full truncate text-start text-sm font-medium text-ink-body hover:text-action focus-visible:outline-none focus-visible:underline"
                    title={d.file_name}>{d.file_name}</button>
                  <div className="text-xs text-ink-muted mt-0.5">{fmtDateTime(d.created_at)}</div>
                </div>
                <ActionMenu label={`פעולות עבור ${d.file_name}`} items={[
                  { key: 'view', label: 'צפייה', icon: Eye, onSelect: () => void open(d) },
                  { key: 'invoice', label: 'שיוך לחשבונית', icon: FileInput, hidden: !canFile, onSelect: () => setRefile({ doc: d, target: 'invoice' }) },
                  { key: 'receipt', label: 'שיוך לקבלת סחורה', icon: ReceiptText, hidden: !canFile, onSelect: () => setRefile({ doc: d, target: 'goods_receipt' }) },
                  { key: 'delete', label: 'הסרה', icon: Trash2, tone: 'danger', hidden: !canFile, onSelect: () => setPendingDelete(d) },
                ]} />
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="border-y border-line-strong bg-surface">
          <EmptyState title="אין מסמכים לא משויכים" subtitle="כל מה שצולם כבר שויך. מסמך חדש נקלט בכפתור צילום / העלאה." />
        </div>
      )}

      {refile && (
        <RefileModal doc={refile.doc} target={refile.target} onClose={() => setRefile(null)} onDone={refetch} />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => { if (pendingDelete) void remove(pendingDelete); }}
        title="הסרת מסמך"
        message={`המסמך "${pendingDelete?.file_name ?? ''}" יוסר מהרשימה. הקובץ עצמו נשמר, וההסרה ניתנת לביטול על ידי מנהל המערכת.`}
        confirmLabel="הסרה"
        danger
        busy={deleting}
      />
    </div>
  );
}
