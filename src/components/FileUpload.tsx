import { useRef, useState } from 'react';
import { Camera, FileText, Loader2, Paperclip, Trash2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthContext';
import { useToast, Skeleton, ConfirmDialog } from './ui';
import { ok, toHebrewError } from '../lib/errors';
import { useQuery, unwrap } from '../lib/useQuery';
import type { DocumentRow } from '../lib/types';
import { fmtDateTime } from '../lib/format';

const MAX_DIM = 1600;      // enough to read an invoice; a raw phone photo is ~4x this
const JPEG_QUALITY = 0.8;

/**
 * Shrinks a phone photo (~3.5MB) to ~350KB before upload. Invoices are read, not zoomed,
 * so 1600px is plenty -- and documents are kept 7 years, so the storage never shrinks back.
 * Non-images (PDFs) and anything that fails to decode pass through untouched.
 */
async function compressImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 500_000) { bitmap.close(); return file; }

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) { bitmap.close(); return file; }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY));
    if (!blob || blob.size >= file.size) return file;   // already smaller than we'd make it
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;   // HEIC on an old browser, corrupt file -- upload the original
  }
}

/**
 * Uploads a file to the private `documents` bucket and registers it on an entity.
 * A null entityId is an inbox capture (migration 0014): the file lands under
 * {org_id}/inbox/ and the row carries entity_type='inbox' with no entity until it is
 * re-filed from /inbox. The stored object never moves on re-filing — the bucket policy
 * reads only the leading org segment.
 */
export async function uploadDocument(orgId: string, entityType: string, entityId: string | null, file: File) {
  const upload = await compressImage(file);
  const safeName = upload.name.replace(/[^\w.\-]+/g, '_');
  // org_id must lead the path -- the bucket's RLS policy reads it to enforce tenant isolation.
  const path = entityId
    ? `${orgId}/${entityType}/${entityId}/${Date.now()}_${safeName}`
    : `${orgId}/inbox/${Date.now()}_${safeName}`;
  const up = await supabase.storage.from('documents').upload(path, upload, { contentType: upload.type });
  if (up.error) throw new Error(up.error.message);
  const { data: user } = await supabase.auth.getUser();
  const ins = await supabase.from('documents').insert({
    org_id: orgId, entity_type: entityType, entity_id: entityId,
    storage_path: path, file_name: file.name, mime_type: upload.type, uploaded_by: user.user?.id,
  });
  if (ins.error) throw new Error(ins.error.message);
}

export function DocumentList({ entityType, entityId, canUpload = true, capture }: {
  entityType: string; entityId: string; canUpload?: boolean; capture?: boolean;
}) {
  const { profile } = useAuth();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<DocumentRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const { data: docs, loading, refetch } = useQuery<DocumentRow[]>(async () =>
    unwrap(await supabase.from('documents').select('*').eq('entity_type', entityType).eq('entity_id', entityId)
      .is('deleted_at', null).order('created_at', { ascending: false })),
    [entityType, entityId]);

  async function onPick(files: FileList | null) {
    if (!files?.length || !profile) return;
    setBusy(true);
    try {
      for (const f of Array.from(files)) await uploadDocument(profile.org_id, entityType, entityId, f);
      toast('הקובץ הועלה בהצלחה');
      await refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'שגיאה בהעלאה', 'error');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function open(doc: DocumentRow) {
    const { data, error } = await supabase.storage.from('documents').createSignedUrl(doc.storage_path, 300);
    if (error || !data) { toast('שגיאה בפתיחת הקובץ', 'error'); return; }
    window.open(data.signedUrl, '_blank');
  }

  // Soft delete (migration 0010). Was a one-click hard delete of both the row and the stored
  // file, with no confirmation and no error check — the only destructive action in the app
  // without a ConfirmDialog, and the deleted file is the scan of the original document.
  //
  // The stored object is deliberately left in place. Clearing the row while destroying the
  // bytes would keep the record and lose the document, which defeats the purpose of a soft
  // delete on a financial record.
  async function remove(doc: DocumentRow) {
    setDeleting(true);
    try {
      ok(await supabase.from('documents')
        .update({ deleted_at: new Date().toISOString(), deleted_by: profile?.id ?? null })
        .eq('id', doc.id));
      toast('המסמך הוסר');
      setPending(null);
      await refetch();
    } catch (e) {
      toast(toHebrewError(e), 'error');
    } finally {
      setDeleting(false);
    }
  }

  const canDelete = profile?.role === 'owner' || profile?.role === 'office';

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-ink-soft flex items-center gap-1.5"><Paperclip size={15} /> מסמכים מצורפים</span>
        {canUpload && (
          <button className="btn-secondary py-1.5!" disabled={busy} onClick={() => inputRef.current?.click()}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : capture ? <Camera size={15} /> : <Paperclip size={15} />}
            {capture ? 'צילום / העלאה' : 'העלאת קובץ'}
          </button>
        )}
        <input ref={inputRef} type="file" hidden multiple accept="image/*,application/pdf"
          {...(capture ? { capture: 'environment' as const } : {})}
          onChange={(e) => void onPick(e.target.files)} />
      </div>
      {loading ? (
        // Not cosmetic: `docs` is null while fetching, and the empty branch below claims
        // "no documents". On an invoice that reads as "no scan attached" when there is one.
        <div className="border border-line-soft rounded-lg divide-y divide-line-soft" role="status" aria-busy="true">
          <span className="sr-only">טוען מסמכים</span>
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-2 px-3 py-2.5">
              <Skeleton className="h-3.5 w-3.5 shrink-0" />
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-3 w-24 ms-auto shrink-0" />
            </div>
          ))}
        </div>
      ) : docs?.length ? (
        <ul className="divide-y divide-line-soft border border-line-soft rounded-lg">
          {docs.map((d) => (
            <li key={d.id} className="flex items-center gap-2 px-3 py-2 text-sm">
              <FileText size={15} className="text-ink-faint shrink-0" />
              <button className="link truncate" onClick={() => void open(d)}>{d.file_name}</button>
              <span className="text-xs text-ink-muted ms-auto shrink-0">{fmtDateTime(d.created_at)}</span>
              {canDelete && (
                <button className="btn-ghost p-1.5! min-w-11 min-h-11 text-ink-faint hover:text-alert-solid" onClick={() => setPending(d)} aria-label="מחיקה">
                  <Trash2 size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-sm text-ink-muted border border-dashed border-line rounded-lg px-3 py-4 text-center">אין מסמכים</div>
      )}

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={() => { if (pending) void remove(pending); }}
        title="הסרת מסמך"
        message={`המסמך "${pending?.file_name ?? ''}" יוסר מהרשימה. הקובץ עצמו נשמר, וההסרה ניתנת לביטול על ידי מנהל המערכת.`}
        confirmLabel="הסרה"
        danger
        busy={deleting}
      />
    </div>
  );
}
