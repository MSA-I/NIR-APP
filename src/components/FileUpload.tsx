import { useRef, useState } from 'react';
import { Camera, FileText, Loader2, Paperclip, Trash2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthContext';
import { useToast } from './ui';
import { useQuery, unwrap } from '../lib/useQuery';
import type { DocumentRow } from '../lib/types';
import { fmtDateTime } from '../lib/format';

/** Uploads a file to the private `documents` bucket and registers it on an entity. */
export async function uploadDocument(orgId: string, entityType: string, entityId: string, file: File) {
  const safeName = file.name.replace(/[^\w.\-]+/g, '_');
  const path = `${entityType}/${entityId}/${Date.now()}_${safeName}`;
  const up = await supabase.storage.from('documents').upload(path, file, { contentType: file.type });
  if (up.error) throw new Error(up.error.message);
  const { data: user } = await supabase.auth.getUser();
  const ins = await supabase.from('documents').insert({
    org_id: orgId, entity_type: entityType, entity_id: entityId,
    storage_path: path, file_name: file.name, mime_type: file.type, uploaded_by: user.user?.id,
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
