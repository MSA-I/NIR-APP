import { CheckCircle2, FileStack, Loader2 } from 'lucide-react';
import { Link } from 'react-router';
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { toHebrewError } from '../../lib/errors';
import { reasonOr } from '../../lib/reason';
import type {
  DocumentInterpretationType, DocumentPacket, DocumentPacketSegment, DocumentProcessingSnapshot,
} from '../../lib/useDocumentProcessing';
import { Disclosure, Note } from '../ui';
import { StickyPrimaryAction } from './StickyPrimaryAction';
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

/**
 * Why a part still needs a person, in the packet's own words — or null when the machine was sure.
 *
 * Every clause is read off the stored contract rather than a feeling about the number:
 * `confidence_threshold` is the value this packet carries for exactly this decision (it is per
 * packet, not a constant here), `source_partial` says the extraction did not see the whole file so
 * no split derived from it can be trusted, and `other` is the classifier declining to classify —
 * which is a question, not an answer. A confidence that is absent or non-finite is unknown, and
 * unknown is not "confident": it is the reason to look.
 *
 * Graded against the STORED segment, never the live draft. A reviewer who corrects a type must not
 * have the row he is editing vanish into the folded group under his cursor.
 */
function segmentAttentionReason(
  segment: DocumentPacketSegment | undefined,
  packet: DocumentPacket,
): string | null {
  if (packet.source_partial) return 'החילוץ חלקי';
  if (!segment) return 'החלק לא נקרא';
  if (!segment.document_type || segment.document_type === 'other') return 'הסוג לא זוהה';
  if (segment.confidence == null || !Number.isFinite(segment.confidence)) return 'הזיהוי לא נמדד';
  if (segment.confidence < packet.confidence_threshold) return 'זיהוי נמוך';
  return null;
}

function pageSpan(segment: { start_page: number; end_page: number }): number {
  return Math.max(0, segment.end_page - segment.start_page + 1);
}

/** One editable part. Identical anatomy whether it is open on top or folded below — the only
    difference is the attention badge, so a folded part is never a different kind of thing. */
function SegmentEditor({ draft, stored, pageCount, editable, busy, attention, onChange }: {
  draft: SegmentDraft;
  stored: DocumentPacketSegment | undefined;
  pageCount: number;
  editable: boolean;
  busy: boolean;
  attention: string | null;
  onChange: (patch: Partial<SegmentDraft>) => void;
}) {
  return (
    <article className="rounded-lg border border-line bg-surface-sunken p-3">
      <div className="grid gap-3 sm:grid-cols-[6rem_6rem_minmax(0,1fr)]">
        <label>
          <span className="label">עמוד ראשון</span>
          <input className="input num" type="number" min={1} max={pageCount} value={draft.start_page}
            disabled={!editable || busy} onChange={(event) => onChange({ start_page: Number(event.target.value) })} />
        </label>
        <label>
          <span className="label">עמוד אחרון</span>
          <input className="input num" type="number" min={1} max={pageCount} value={draft.end_page}
            disabled={!editable || busy} onChange={(event) => onChange({ end_page: Number(event.target.value) })} />
        </label>
        <label>
          <span className="label">סוג מסמך</span>
          <select className="input" value={draft.document_type} disabled={!editable || busy}
            onChange={(event) => onChange({ document_type: event.target.value as DocumentInterpretationType })}>
            {DOCUMENT_TYPES.map((type) => <option key={type} value={type}>{DOCUMENT_TYPE_LABELS[type]}</option>)}
          </select>
        </label>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm text-ink-muted">
        <span className="flex flex-wrap items-center gap-2">
          <span>חלק <span className="num">{draft.ordinal}</span> · {confidenceLabel(draft.confidence)}</span>
          {attention && <span className="badge-await">{attention}</span>}
        </span>
        {stored?.child_document_id && (
          <Link className="btn-secondary" to={`/documents/${stored.child_document_id}/review`}>
            פתיחת המסמך שנוצר
          </Link>
        )}
      </div>
    </article>
  );
}

export function DocumentPacketReview({ snapshot, readOnly, onRefetch }: Props) {
  const packet = snapshot.packet;
  const [drafts, setDrafts] = useState(() => draftsFromSnapshot(snapshot));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The folded parts are not rendered until asked for.
   *
   * A 42-page packet is ~294 form containers and 336 `<option>`s, and a shut `<details>` still
   * renders every one of them into the DOM — collapsing alone would buy paint, not work. The
   * manifest is unaffected: it is built from `drafts`, which holds every part whether or not its
   * editor is on screen, so an unopened part is still submitted exactly as the machine read it.
   */
  const [classifiedOpen, setClassifiedOpen] = useState(false);

  useEffect(() => {
    setDrafts(draftsFromSnapshot(snapshot));
    setReason('');
    setError(null);
  }, [packet?.manifest_hash, packet?.status, snapshot.packetSegments]);

  // One attention verdict per part, index-aligned with `drafts`. Derived from the stored segments,
  // so the split describes what the machine produced and does not move while someone edits.
  const attentionReasons = useMemo(
    () => (packet ? snapshot.packetSegments.map((segment) => segmentAttentionReason(segment, packet)) : []),
    [snapshot.packetSegments, packet],
  );

  const needsAttention = useMemo(
    () => snapshot.packetSegments.flatMap((_, index) => attentionReasons[index] ? [index] : []),
    [snapshot.packetSegments, attentionReasons],
  );
  const classified = useMemo(
    () => snapshot.packetSegments.flatMap((_, index) => attentionReasons[index] ? [] : [index]),
    [snapshot.packetSegments, attentionReasons],
  );

  if (!packet) return null;
  const currentPacket = packet;
  const editable = currentPacket.status === 'needs_review' && !readOnly;
  const canMaterialize = currentPacket.status === 'approved' && !readOnly;
  const classifiedPages = classified.reduce((sum, index) => sum + pageSpan(snapshot.packetSegments[index]), 0);
  const attentionPages = needsAttention.reduce((sum, index) => sum + pageSpan(snapshot.packetSegments[index]), 0);
  // Said on the summary line rather than only behind it: documents the machine actually created
  // are a change to the business, and a change is never something a person has to unfold to learn.
  const classifiedCreated = classified.filter((index) => snapshot.packetSegments[index]?.child_document_id).length;

  function update(index: number, patch: Partial<SegmentDraft>) {
    setDrafts((current) => current.map((draft, draftIndex) => draftIndex === index ? { ...draft, ...patch } : draft));
  }

  function renderSegment(index: number) {
    const draft = drafts[index];
    if (!draft) return null;
    return (
      <SegmentEditor
        key={snapshot.packetSegments[index]?.id ?? draft.ordinal}
        draft={draft}
        stored={snapshot.packetSegments[index]}
        pageCount={currentPacket.page_count}
        editable={editable}
        busy={busy}
        attention={attentionReasons[index]}
        onChange={(patch) => update(index, patch)}
      />
    );
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

      {/* The count line, before anything to scroll: how big the file is, how much of it the machine
          settled, and how much is left for a person. Every figure is measured — none is a label. */}
      <p className="mt-3 text-sm text-ink-body" data-testid="packet-counts">
        <span className="num">{currentPacket.page_count}</span> עמודים
        {' · '}<span className="num">{classifiedPages}</span> מסווגים
        {attentionPages > 0 && <>{' · '}<span className="num">{attentionPages}</span> דורשים בדיקה</>}
      </p>

      {(packet.source_partial || packet.page_count > 20) && (
        <Note tone="await" className="mt-4">החילוץ חלקי או ארוך מ־20 עמודי OCR, ולכן הפיצול דורש אישור אדם.</Note>
      )}

      {needsAttention.length > 0 && (
        <div className="mt-4 space-y-3" data-testid="packet-attention">
          {needsAttention.map(renderSegment)}
        </div>
      )}

      {classified.length > 0 && (
        <div className="mt-4 overflow-hidden rounded-lg border border-line">
          <Disclosure
            title="עמודים מסווגים"
            count={classifiedPages}
            summary={<>
              <span className="num">{classified.length}</span> חלקים
              {classifiedCreated > 0 && <>{' · '}<span className="num">{classifiedCreated}</span> נוצרו</>}
            </>}
            onToggle={setClassifiedOpen}
          >
            {classifiedOpen && <div className="space-y-3">{classified.map(renderSegment)}</div>}
          </Disclosure>
        </div>
      )}

      {editable && (
        <div className="mt-4 border-t border-line pt-4">
          <label>
            <span className="label">הערה ליומן הביקורת — רשות</span>
            <textarea className="input" rows={2} maxLength={1000} value={reason} disabled={busy}
              onChange={(event) => setReason(event.target.value)} />
          </label>
          {/* The parts are a form the reviewer scrolls through; the one button that ends the job
              rides along on a phone. `editable` and `canMaterialize` are mutually exclusive packet
              statuses, so only one of the two ever reaches the bar. */}
          <StickyPrimaryAction className="mt-3 flex justify-end" label="אישור פיצול החבילה">
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void approve()}>
              {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" size={17} aria-hidden="true" /> : <CheckCircle2 size={17} aria-hidden="true" />}
              {busy ? 'יוצר מסמכים נפרדים…' : 'אישור הפיצול ויצירת המסמכים'}
            </button>
          </StickyPrimaryAction>
        </div>
      )}

      {canMaterialize && (
        <StickyPrimaryAction className="mt-4 flex justify-end" label="יצירת המסמכים הנפרדים">
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void retryMaterialization()}>
            {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" size={17} aria-hidden="true" /> : <FileStack size={17} aria-hidden="true" />}
            {busy ? 'יוצר מסמכים נפרדים…' : 'יצירת המסמכים הנפרדים'}
          </button>
        </StickyPrimaryAction>
      )}
      {error && <Note tone="alert" role="alert" className="mt-3">{error}</Note>}
    </section>
  );
}
