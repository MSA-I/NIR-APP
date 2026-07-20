import { useRef, useState } from 'react';
import { Camera, FileText, Loader2, Paperclip, Trash2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthContext';
import { useToast } from './ui';
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

/** Uploads a file to the private `documents` bucket and registers it on an entity. */
export async function uploadDocument(orgId: string, entityType: string, entityId: string, file: File) {
  const upload = await compressImage(file);
  const safeName = upload.name.replace(/[^\w.\-]+/g, '_');
  // org_id must lead the path -- the bucket's RLS policy reads it to enforce tenant isolation.
  const path = `${orgId}/${entityType}/${entityId}/${Date.now()}_${safeName}`;
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

  const { data: docs, refetch } = useQuery<DocumentRow[]>(async () =>
    unwrap(await supabase.from('documents').select('*').eq('entity_type', entityType).eq('entity_id', entityId).order('created_at', { ascending: false })),
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

  async function remove(doc: DocumentRow) {
    await supabase.storage.from('documents').remove([doc.storage_path]);
    await supabase.from('documents').delete().eq('id', doc.id);
    await refetch();
  }

  const canDelete = profile?.role === 'owner' || profile?.role === 'office';

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-slate-600 flex items-center gap-1.5"><Paperclip size={15} /> מסמכים מצורפים</span>
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
      {docs?.length ? (
        <ul className="divide-y divide-slate-100 border border-slate-100 rounded-lg">
          {docs.map((d) => (
            <li key={d.id} className="flex items-center gap-2 px-3 py-2 text-sm">
              <FileText size={15} className="text-slate-400 shrink-0" />
              <button className="text-indigo-700 hover:underline truncate" onClick={() => void open(d)}>{d.file_name}</button>
              <span className="text-xs text-slate-400 ms-auto shrink-0">{fmtDateTime(d.created_at)}</span>
              {canDelete && (
                <button className="btn-ghost p-1! text-slate-400 hover:text-rose-600" onClick={() => void remove(d)} aria-label="מחיקה">
                  <Trash2 size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-sm text-slate-400 border border-dashed border-slate-200 rounded-lg px-3 py-4 text-center">אין מסמכים</div>
      )}
    </div>
  );
}
