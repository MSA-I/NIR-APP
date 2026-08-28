import { useT } from '../../lib/i18n/LocaleProvider';
import type { TKey } from '../../lib/i18n/t';
import {
  CheckCircle2, ChevronDown, ChevronsDownUp, ChevronsUpDown, FileStack, Loader2,
} from 'lucide-react';
import { Link } from 'react-router';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { supabase } from '../../lib/supabase';
import { reasonOr } from '../../lib/reason';
import type {
  DocumentInterpretationType, DocumentPacket, DocumentPacketSegment, DocumentProcessingSnapshot,
} from '../../lib/useDocumentProcessing';
import type { Tone } from '../../lib/status';
import { ICON, Note, SubPanel } from '../ui';
import { PrimaryDecision } from './PrimaryDecision';
import { confidenceLabel, DOCUMENT_TYPE_KEYS } from './model';
import { AUTOMATIC_SPLIT_PAGE_CEILING, PAID_OCR_PAGE_CAP } from './serverLimits';

interface Props {
  snapshot: DocumentProcessingSnapshot;
  readOnly: boolean;
  onRefetch: () => Promise<boolean>;
}

type SegmentDraft = Pick<DocumentPacketSegment, 'ordinal' | 'start_page' | 'end_page' | 'document_type' | 'confidence'>;

const DOCUMENT_TYPES = Object.keys(DOCUMENT_TYPE_KEYS) as DocumentInterpretationType[];

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
 * Why THIS part still needs a person, in the packet's own words — or null when the machine was sure.
 *
 * Every clause is read off the stored contract rather than a feeling about the number:
 * `confidence_threshold` is the value this packet carries for exactly this decision (it is per
 * packet, not a constant here), and `other` is the classifier declining to classify — which is a
 * question, not an answer. A confidence that is absent or non-finite is unknown, and unknown is not
 * "confident": it is the reason to look.
 *
 * **`source_partial` is deliberately NOT here (owner report, 18.08.2026).** It used to be the first
 * test, which made every part of every packet an exception — the flag is true on every document the
 * worker has produced so far, so nothing was ever confident and the fold added the day before never
 * appeared: a 24-part packet at 0.99/0.98/0.98/0.99 rendered 24 open editors. The category error is
 * older than the bad flag, though: a partial extraction is a fact about the WHOLE file, not about
 * part 17. Printing it as a per-part badge says the same sentence N times, defeats every fold, and
 * still does not tell the reader which part is short. It is now one statement at the top of the
 * panel, where a fact about the packet belongs — see `PACKET_PARTIAL_NOTE` below.
 *
 * Graded against the STORED segment, never the live draft. A reviewer who corrects a type must not
 * have the row he is editing vanish into the folded group under his cursor.
 */
function segmentAttentionKey(
  segment: DocumentPacketSegment | undefined,
  packet: DocumentPacket,
): TKey | null {
  if (!segment) return 'packetReview.attentionUnread';
  if (!segment.document_type || segment.document_type === 'other') return 'packetReview.attentionTypeUnknown';
  if (segment.confidence == null || !Number.isFinite(segment.confidence)) return 'packetReview.attentionUnmeasured';
  if (segment.confidence < packet.confidence_threshold) return 'packetReview.attentionLowConfidence';
  return null;
}

function pageSpan(segment: { start_page: number; end_page: number }): number {
  return Math.max(0, segment.end_page - segment.start_page + 1);
}

/**
 * One group of parts — the exceptions, or everything the classifier settled — under this panel's
 * own control.
 *
 * Why not `Disclosure` from `ui.tsx`: that component is an uncontrolled `<details>` on purpose, and
 * this panel needs two things it cannot give. The exception group must start OPEN, which a native
 * `<details>` will not do unless it is told; and both groups must answer to one „fold everything”
 * button, which needs their state to live here. The anatomy below is `Disclosure`'s, line for line
 * — a 44px summary row, a count badge in the `status.ts` tone vocabulary, a chevron that respects
 * `motion-reduce` — so this is the same fold in the same visual language, not a second one.
 *
 * The children are not built while the group is shut. A shut `<details>` still renders everything
 * inside it, so folding alone would buy paint and not work; on a 24-part packet the difference is
 * 24 editors and 192 `<option>`s that are never constructed.
 */
function SegmentGroup({ id, testId, title, count, tone, summary, open, onOpenChange, children }: {
  id: string;
  testId: string;
  title: string;
  count: number;
  tone: Tone;
  summary: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <details
      id={id}
      data-testid={testId}
      open={open}
      className="group mt-3 overflow-hidden rounded-lg border border-line"
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
    >
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2.5 text-sm hover:bg-surface-hover active:bg-surface-selected focus-visible:outline-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden sm:px-4">
        <span className="font-medium text-ink-body">{title}</span>
        <span className={`badge-${tone} num`}>{count}</span>
        <span className="ms-auto min-w-0 text-end text-xs text-ink-muted">{summary}</span>
        <ChevronDown size={ICON.sm} aria-hidden="true"
          className="shrink-0 text-ink-ghost transition-transform duration-200 ease-out group-open:rotate-180 motion-reduce:transition-none" />
      </summary>
      <div className="border-t border-line-soft px-3 pb-4 pt-3 sm:px-4">{open && children}</div>
    </details>
  );
}

/** One editable part. Identical anatomy whether it is open on top or folded below — the only
    difference is the attention badge, so a folded part is never a different kind of thing. */
function SegmentEditor({ draft, stored, pageCount, editable, busy, attentionKey, onChange }: {
  draft: SegmentDraft;
  stored: DocumentPacketSegment | undefined;
  pageCount: number;
  editable: boolean;
  busy: boolean;
  attentionKey: TKey | null;
  onChange: (patch: Partial<SegmentDraft>) => void;
}) {
  const { t } = useT();
  return (
    <SubPanel as="article">
      <div className="grid gap-3 sm:grid-cols-[6rem_6rem_minmax(0,1fr)]">
        <label>
          <span className="label">{t('packetReview.text')}</span>
          <input className="input num" type="number" min={1} max={pageCount} value={draft.start_page}
            disabled={!editable || busy} onChange={(event) => onChange({ start_page: Number(event.target.value) })} />
        </label>
        <label>
          <span className="label">{t('packetReview.text_2')}</span>
          <input className="input num" type="number" min={1} max={pageCount} value={draft.end_page}
            disabled={!editable || busy} onChange={(event) => onChange({ end_page: Number(event.target.value) })} />
        </label>
        <label>
          <span className="label">{t('packetReview.text_3')}</span>
          <select className="input" value={draft.document_type} disabled={!editable || busy}
            onChange={(event) => onChange({ document_type: event.target.value as DocumentInterpretationType })}>
            {DOCUMENT_TYPES.map((type) => <option key={type} value={type}>{t(DOCUMENT_TYPE_KEYS[type])}</option>)}
          </select>
        </label>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm text-ink-muted">
        <span className="flex flex-wrap items-center gap-2">
          <span>{t('packetReview.confidenceLabel')} <span className="num">{draft.ordinal}</span> · {confidenceLabel(draft.confidence, t)}</span>
          {attentionKey && <span className="badge-await">{t(attentionKey)}</span>}
        </span>
        {stored?.child_document_id && (
          <Link className="btn-secondary" to={`/documents/${stored.child_document_id}/review`}>
            {t('packetReview.text_4')}
          </Link>
        )}
      </div>
    </SubPanel>
  );
}

export function DocumentPacketReview({ snapshot, readOnly, onRefetch }: Props) {
  const { errorText, t } = useT();
  const packet = snapshot.packet;
  const [drafts, setDrafts] = useState(() => draftsFromSnapshot(snapshot));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * What is open, and who decided.
   *
   * The default is the exception-inbox law: what needs a person is open, what the machine settled
   * is a counted summary line. On top of the default the reviewer gets one explicit control over
   * the whole list — the automatic behaviour is the point, but somebody looking at 24 parts must be
   * able to fold them without hunting for a toggle on every row, and must be able to unfold them
   * all when he wants to read the machine's whole answer.
   *
   * Neither state is reset by a refetch: a poll that returns the same packet must not reopen a list
   * the reviewer just folded.
   *
   * The manifest is unaffected by any of it. It is built from `drafts`, which holds every part
   * whether or not its editor is on screen, so a part nobody unfolded is still submitted exactly as
   * the machine read it, under the same `manifest_hash`.
   */
  const [attentionOpen, setAttentionOpen] = useState(true);
  const [classifiedOpen, setClassifiedOpen] = useState(false);
  const groupId = useId();
  const attentionGroupId = `${groupId}-attention`;
  const classifiedGroupId = `${groupId}-classified`;

  useEffect(() => {
    setDrafts(draftsFromSnapshot(snapshot));
    setReason('');
    setError(null);
  }, [packet?.manifest_hash, packet?.status, snapshot.packetSegments]);

  // One attention verdict per part, index-aligned with `drafts`. Derived from the stored segments,
  // so the split describes what the machine produced and does not move while someone edits.
  const attentionKeys = useMemo(
    () => (packet ? snapshot.packetSegments.map((segment) => segmentAttentionKey(segment, packet)) : []),
    [snapshot.packetSegments, packet],
  );

  const needsAttention = useMemo(
    () => snapshot.packetSegments.flatMap((_, index) => attentionKeys[index] ? [index] : []),
    [snapshot.packetSegments, attentionKeys],
  );
  const classified = useMemo(
    () => snapshot.packetSegments.flatMap((_, index) => attentionKeys[index] ? [] : [index]),
    [snapshot.packetSegments, attentionKeys],
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
  // "Anything open" rather than "everything open": from the default — exceptions open, settled
  // parts folded — one press folds the list, and the next press opens all of it.
  const anyGroupOpen = (needsAttention.length > 0 && attentionOpen) || (classified.length > 0 && classifiedOpen);
  const groupIds = [
    needsAttention.length > 0 ? attentionGroupId : null,
    classified.length > 0 ? classifiedGroupId : null,
  ].filter((id): id is string => id !== null).join(' ');

  function toggleAllGroups() {
    const next = !anyGroupOpen;
    setAttentionOpen(next);
    setClassifiedOpen(next);
  }

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
        attentionKey={attentionKeys[index]}
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
      setError(t('packetReview.setError'));
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
      setError(errorText(approveError));
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
      setError(errorText(materializeError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card card-pad" aria-labelledby="document-packet-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="document-packet-title" className="section-title">{t('packetReview.text_5')}</h2>
          <p className="mt-1 text-sm text-ink-muted">{t('packetReview.text_6')}</p>
        </div>
        <span className={packet.status === 'materialized' ? 'badge-done' : packet.status === 'failed' ? 'badge-alert' : 'badge-await'}>
          {packet.status === 'materialized' ? t('packetReview.text_7') : packet.status === 'approved' ? t('packetReview.text_8') : packet.status === 'failed' ? t('packetReview.text_9') : t('packetReview.text_10')}
        </span>
      </div>

      {/* The count line, before anything to scroll: how big the file is, how much of it the machine
          settled, and how much is left for a person. Every figure is measured — none is a label. */}
      <p className="mt-3 text-sm text-ink-body" data-testid="packet-counts">
        <span className="num">{currentPacket.page_count}</span> {t('packetReview.pagesWord')}
        {' · '}<span className="num">{classifiedPages}</span> {t('packetReview.classifiedWord')}
        {attentionPages > 0 && <>{' · '}<span className="num">{attentionPages}</span> {t('packetReview.text_11')}</>}
      </p>

      {/* Two facts about the FILE, said once each, at the top — and deliberately NOT in one
          sentence. They used to share a line („החילוץ חלקי או ארוך מ־20 עמודי OCR”), which the
          owner read as a claim about reading quality on a document that had been read perfectly.
          They are different situations with different limits behind them (`serverLimits.ts`), and
          since 0144 they are not even the same number. `source_partial` was also graded per part,
          which said the same sentence on every row and left nothing to fold. */}
      {currentPacket.source_partial && (
        <Note tone="await" className="mt-4">
          <span className="min-w-0 flex-1">
            {t('packetReview.sourcePartialNote', { cap: PAID_OCR_PAGE_CAP })}
          </span>
        </Note>
      )}

      {currentPacket.page_count > AUTOMATIC_SPLIT_PAGE_CEILING && (
        <Note tone="idle" className="mt-4">
          <span className="min-w-0 flex-1">
            {t('packetReview.aboveSplitCeilingNote', { ceiling: AUTOMATIC_SPLIT_PAGE_CEILING })}
          </span>
        </Note>
      )}

      {/* The decision, at the head of the parts rather than after them (see `PrimaryDecision`).
          `editable` and `canMaterialize` are mutually exclusive packet statuses, so only one of the
          two is ever on screen. */}
      {editable && (
        <div className="mt-4 border-t border-line pt-4" data-testid="packet-decision">
          <label>
            <span className="label">{t('packetReview.text_17')}</span>
            <textarea className="input" rows={2} maxLength={1000} value={reason} disabled={busy}
              onChange={(event) => setReason(event.target.value)} />
          </label>
          <PrimaryDecision className="mt-3" label={t('packetReview.label')}>
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void approve()}>
              {busy ? <Loader2 className="animate-spin" size={ICON.md} aria-hidden="true" /> : <CheckCircle2 size={ICON.md} aria-hidden="true" />}
              {busy ? t('packetReview.text_18') : t('packetReview.text_19')}
            </button>
          </PrimaryDecision>
        </div>
      )}

      {canMaterialize && (
        <div className="mt-4 border-t border-line pt-4" data-testid="packet-decision">
          <PrimaryDecision label={t('packetReview.label_2')}>
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void retryMaterialization()}>
              {busy ? <Loader2 className="animate-spin" size={ICON.md} aria-hidden="true" /> : <FileStack size={ICON.md} aria-hidden="true" />}
              {busy ? t('packetReview.text_20') : t('packetReview.text_21')}
            </button>
          </PrimaryDecision>
        </div>
      )}
      {/* Beside the button that produced it: the manifest error is the answer to the press. */}
      {error && <Note tone="alert" role="alert" className="mt-3">{error}</Note>}

      {snapshot.packetSegments.length > 0 && (
        <div className="mt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="section-title">{t('packetReview.text_22')}</h3>
            {/* The reviewer's own control over the whole list, next to its heading rather than on
                any row. It changes what is on screen and nothing about what is submitted. */}
            <button type="button" className="btn-ghost" onClick={toggleAllGroups}
              aria-expanded={anyGroupOpen} aria-controls={groupIds} data-testid="packet-fold-all">
              {anyGroupOpen
                ? <ChevronsDownUp size={ICON.md} aria-hidden="true" />
                : <ChevronsUpDown size={ICON.md} aria-hidden="true" />}
              {anyGroupOpen ? t('packetReview.text_23') : t('packetReview.text_24')}
            </button>
          </div>

          {needsAttention.length > 0 && (
            <SegmentGroup
              id={attentionGroupId}
              testId="packet-attention"
              // Both groups count PAGES on the badge and PARTS on the summary, in that order — the
              // same two units, in the same places, as the count line at the top of the panel.
              title={t('packetReview.title')}
              count={attentionPages}
              tone="await"
              summary={<><span className="num">{needsAttention.length}</span> {t('packetReview.partsWord')}</>}
              open={attentionOpen}
              onOpenChange={setAttentionOpen}
            >
              <div className="space-y-3">{needsAttention.map(renderSegment)}</div>
            </SegmentGroup>
          )}

          {classified.length > 0 && (
            <SegmentGroup
              id={classifiedGroupId}
              testId="packet-classified"
              title={t('packetReview.title_2')}
              count={classifiedPages}
              tone="idle"
              summary={<>
                <span className="num">{classified.length}</span> {t('packetReview.partsWord')}
                {classifiedCreated > 0 && <>{' · '}<span className="num">{classifiedCreated}</span> {t('packetReview.text_26')}</>}
              </>}
              open={classifiedOpen}
              onOpenChange={setClassifiedOpen}
            >
              <div className="space-y-3">{classified.map(renderSegment)}</div>
            </SegmentGroup>
          )}
        </div>
      )}
    </section>
  );
}
