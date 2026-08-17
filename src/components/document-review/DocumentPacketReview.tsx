import { CheckCircle2, FileStack, Loader2 } from 'lucide-react';
import { Link } from 'react-router';
import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { toHebrewError } from '../../lib/errors';
import { reasonOr } from '../../lib/reason';
import type { DocumentInterpretationType, DocumentPacketSegment, DocumentProcessingSnapshot } from '../../lib/useDocumentProcessing';
import { Note } from '../ui';
import { confidenceLabel, DOCUMENT_TYPE_LABELS } from './model';

interface Props {
  snapshot: DocumentProcessingSnapshot;
  readOnly: boolean;
  onRefetch: () => Promise<boolean>;
}

type SegmentDraft = Pick<DocumentPacketSegment, 'ordinal' | 'start_page' | 'end_page' | 'document_type' | 'confidence'>;

const DOCUMENT_TYPES = Object.keys(DOCUMENT_TYPE_LABELS) as DocumentInterpretationType[];

function draftsFromSnapshot(snapshot: DocumentProcessingSnapshot): SegmentDraft[] {
  return snapshot.packetSegments.map(({ ordinal, start_page, end_page, document_type, confidence }) => ({
    ordinal, start_page, end_page, document_type, confidence,
  }));
}

function manifestValid(segments: SegmentDraft[], pageCount: number): boolean {
  let expectedPage = 1;
  return segments.every((segment, index) => {
    const valid = segment.ordinal === index + 1 && segment.start_page === expectedPage
      && segment.end_page >= segment.start_page && segment.end_page <= pageCount;
    expectedPage = segment.end_page + 1;
    return valid;
  }) && expectedPage === pageCount + 1;
}

export function DocumentPacketReview({ snapshot, readOnly, onRefetch }: Props) {
  const packet = snapshot.packet;
  const [drafts, setDrafts] = useState(() => draftsFromSnapshot(snapshot));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDrafts(draftsFromSnapshot(snapshot));
    setReason('');
    setError(null);
  }, [packet?.manifest_hash, packet?.status, snapshot.packetSegments]);

  if (!packet) return null;
  const currentPacket = packet;
  const editable = currentPacket.status === 'needs_review' && !readOnly;
  const canMaterialize = currentPacket.status === 'approved' && !readOnly;

  function update(index: number, patch: Partial<SegmentDraft>) {
    setDrafts((current) => current.map((draft, draftIndex) => draftIndex === index ? { ...draft, ...patch } : draft));
  }

  async function materialize(packetId: string) {
    const response = await supabase.functions.invoke('interpret-document', { body: { packetId } });
    if (response.error) throw response.error;
  }

  async function approve() {
    if (!manifestValid(drafts, currentPacket.page_count)) {
      setError('טווחי העמודים חייבים לכסות את כל הקובץ ברצף, ללא חפיפה או דילוג.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const approved = await supabase.rpc('approve_document_packet', {
        p_packet_id: currentPacket.id,
        p_expected_manifest_hash: currentPacket.manifest_hash,
        p_segments: drafts,
        p_reason: reasonOr(reason, 'אישור פיצול חבילת מסמכים'),
      });
      if (approved.error) throw approved.error;
      await materialize(currentPacket.id);
      await onRefetch();
    } catch (approveError) {
      setError(toHebrewError(approveError));
    } finally {
      setBusy(false);
    }
  }

  async function retryMaterialization() {
    setBusy(true);
    setError(null);
    try {
      await materialize(currentPacket.id);
      await onRefetch();
    } catch (materializeError) {
      setError(toHebrewError(materializeError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card card-pad" aria-labelledby="document-packet-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="document-packet-title" className="section-title">חבילת מסמכים בקובץ אחד</h2>
          <p className="mt-1 text-sm text-ink-muted">הקובץ המקורי נשמר כמקור בלבד. כל חלק יעבור עיבוד ואישור בנפרד.</p>
        </div>
        <span className={packet.status === 'materialized' ? 'badge-done' : packet.status === 'failed' ? 'badge-alert' : 'badge-await'}>
          {packet.status === 'materialized' ? 'הפיצול הושלם' : packet.status === 'approved' ? 'הפיצול אושר' : packet.status === 'failed' ? 'הפיצול נכשל' : 'נדרשת בדיקה'}
        </span>
      </div>

      {(packet.source_partial || packet.page_count > 20) && (
        <Note tone="await" className="mt-4">החילוץ חלקי או ארוך מ־20 עמודי OCR, ולכן הפיצול דורש אישור אדם.</Note>
      )}

      <div className="mt-4 space-y-3">
        {drafts.map((segment, index) => {
          const stored = snapshot.packetSegments[index];
          return (
            <article key={stored?.id ?? segment.ordinal} className="rounded-lg border border-line bg-surface-sunken p-3">
              <div className="grid gap-3 sm:grid-cols-[6rem_6rem_minmax(0,1fr)]">
                <label>
                  <span className="label">עמוד ראשון</span>
                  <input className="input num" type="number" min={1} max={packet.page_count} value={segment.start_page}
                    disabled={!editable || busy} onChange={(event) => update(index, { start_page: Number(event.target.value) })} />
                </label>
                <label>
                  <span className="label">עמוד אחרון</span>
                  <input className="input num" type="number" min={1} max={packet.page_count} value={segment.end_page}
                    disabled={!editable || busy} onChange={(event) => update(index, { end_page: Number(event.target.value) })} />
                </label>
                <label>
                  <span className="label">סוג מסמך</span>
                  <select className="input" value={segment.document_type} disabled={!editable || busy}
                    onChange={(event) => update(index, { document_type: event.target.value as DocumentInterpretationType })}>
                    {DOCUMENT_TYPES.map((type) => <option key={type} value={type}>{DOCUMENT_TYPE_LABELS[type]}</option>)}
                  </select>
                </label>
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm text-ink-muted">
                <span>חלק <span className="num">{segment.ordinal}</span> · {confidenceLabel(segment.confidence)}</span>
                {stored?.child_document_id && (
                  <Link className="btn-secondary" to={`/documents/${stored.child_document_id}/review`}>
                    פתיחת המסמך שנוצר
                  </Link>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {editable && (
        <div className="mt-4 border-t border-line pt-4">
          <label>
            <span className="label">הערה ליומן הביקורת — רשות</span>
            <textarea className="input" rows={2} maxLength={1000} value={reason} disabled={busy}
              onChange={(event) => setReason(event.target.value)} />
          </label>
          <div className="mt-3 flex justify-end">
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void approve()}>
              {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" size={17} aria-hidden="true" /> : <CheckCircle2 size={17} aria-hidden="true" />}
              {busy ? 'יוצר מסמכים נפרדים…' : 'אישור הפיצול ויצירת המסמכים'}
            </button>
          </div>
        </div>
      )}

      {canMaterialize && (
        <div className="mt-4 flex justify-end">
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void retryMaterialization()}>
            {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" size={17} aria-hidden="true" /> : <FileStack size={17} aria-hidden="true" />}
            {busy ? 'יוצר מסמכים נפרדים…' : 'יצירת המסמכים הנפרדים'}
          </button>
        </div>
      )}
      {error && <Note tone="alert" role="alert" className="mt-3">{error}</Note>}
    </section>
  );
}
