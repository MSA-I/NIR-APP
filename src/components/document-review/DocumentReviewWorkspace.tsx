import { useEffect, useMemo, useState } from 'react';
import { FileCheck2, RefreshCw, ScanText } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { openReservedPopup } from '../../lib/popup';
import { documentProcessingFailureText, documentUiStatus } from '../../lib/documentStatus';
import { ICON, Note, useToast } from '../ui';
import { DocumentStatusBadge } from '../DocumentStatusBadge';
import { DocumentAssessmentPanel } from './DocumentAssessmentPanel';
import { DocumentExportPreview } from './DocumentExportPreview';
import { DocumentPacketReview } from './DocumentPacketReview';
import { DocumentProcessingProgress } from './DocumentProcessingProgress';
import { DocumentReviewProposals } from './DocumentReviewProposals';
import { DocumentSourceViewer } from './DocumentSourceViewer';
import { PriceListReviewConfirmation } from './PriceListReviewConfirmation';
import {
  DOCUMENT_TYPE_LABELS,
  MARK_KIND_LABELS,
  bboxDescription,
  confidencePercent,
  fieldKeyLabel,
  type ReviewSnapshot,
} from './model';

interface DocumentReviewWorkspaceProps {
  snapshot: ReviewSnapshot;
  actorId: string;
  onRefetch: () => Promise<boolean>;
  initialPanel: string | null;
  readOnly?: boolean;
  reprocessing?: boolean;
  onReprocess?: () => void;
}

export function DocumentReviewWorkspace({ snapshot, actorId, onRefetch, initialPanel, readOnly = false, reprocessing = false, onReprocess }: DocumentReviewWorkspaceProps) {
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [openingSource, setOpeningSource] = useState(false);
  const [page, setPage] = useState(1);
  const toast = useToast();
  /**
   * The technical disclosure builds its rows only once someone opens it.
   *
   * `extractionEvidence` is one row per block and mark across the WHOLE document, not the current
   * page, and nothing in the pipeline caps block count — `worker/ocr/src/limits.py` bounds pages
   * and payload bytes, never blocks — while `price_list` is a first-class document_kind here, i.e.
   * exactly the many-line document. Rendered unconditionally, React would build and then re-diff
   * those rows on every workspace re-render (selecting a target, changing page, refetching) for
   * content nobody has asked to see. Tens of rows on an invoice is free; thousands on a long price
   * list, re-diffed per interaction, is not. `<details>` stays the collapsed-by-default control —
   * this only decides when its contents come into existence.
   */
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const isPriceList = snapshot.interpretation?.payload.document_type === 'price_list';
  const extraction = snapshot.extraction?.payload ?? null;
  const uiStatus = documentUiStatus({ status: snapshot.stage, job: snapshot.job, document: snapshot.document });

  /**
   * Every confidence number the everyday screens stopped printing, in one place.
   *
   * The percentages were not deleted — deleting them would take the only thread a support session
   * has when an extraction goes wrong. They moved: the review screens now say "זוהה בבירור" and the
   * arithmetic lives here, folded, one click away, alongside the evidence ids that let a number be
   * traced back to the block it came from.
   */
  const interpretationEvidence = useMemo(() => {
    const payload = snapshot.interpretation?.payload;
    const rows: { key: string; label: string; confidence: number | null; evidence: string[] }[] = [];
    if (payload) {
      rows.push({
        key: 'document-type',
        label: `סוג המסמך · ${DOCUMENT_TYPE_LABELS[payload.document_type]}`,
        confidence: payload.document_type_confidence,
        evidence: [],
      });
      rows.push({
        key: 'supplier',
        label: `ספק מוצע · ${payload.supplier.suggested_name || 'לא זוהה'}`,
        confidence: payload.supplier.confidence,
        evidence: payload.supplier.evidence_block_ids,
      });
      payload.fields.forEach((field, index) => rows.push({
        key: `field-${index}`,
        label: `שדה · ${fieldKeyLabel(field.key)}`,
        confidence: field.confidence,
        evidence: field.evidence_block_ids,
      }));
      // The contract carries no per-line confidence, so these rows show — rather than a number
      // borrowed from somewhere else. They are here for their evidence ids.
      payload.line_items.forEach((item, index) => rows.push({
        key: `line-${index}`,
        label: `שורה מוצעת ${index + 1}${item.source_row === null ? '' : ` · שורת מקור ${item.source_row}`}`,
        confidence: null,
        evidence: item.evidence_block_ids,
      }));
    }
    snapshot.annotations.forEach((annotation) => rows.push({
      key: `annotation-${annotation.id}`,
      label: `הערה · ${annotation.label}`,
      confidence: annotation.confidence,
      evidence: annotation.evidence_mark_ids,
    }));
    snapshot.ruleApplications.forEach((application) => rows.push({
      key: `rule-application-${application.id}`,
      label: `כלל שהופעל · גרסה ${application.rule_version}`,
      confidence: application.confidence,
      evidence: [application.target_id],
    }));
    return rows;
  }, [snapshot.interpretation, snapshot.annotations, snapshot.ruleApplications]);

  const extractionEvidence = useMemo(() => {
    const payload = snapshot.extraction?.payload;
    if (!payload) return [];
    return [
      ...payload.blocks.map((block) => ({
        key: `block-${block.id}`,
        kind: 'קטע טקסט',
        page: block.page,
        confidence: block.confidence,
        bbox: block.bbox,
        id: block.id,
      })),
      ...payload.marks.map((mark) => ({
        key: `mark-${mark.id}`,
        kind: MARK_KIND_LABELS[mark.kind],
        page: mark.page,
        confidence: mark.confidence,
        bbox: mark.bbox,
        id: mark.id,
      })),
    ];
  }, [snapshot.extraction]);

  useEffect(() => {
    let cancelled = false;
    setSourceUrl(null);
    setSourceError(null);
    if (!snapshot.document?.storage_path) return;
    void supabase.storage.from('documents').createSignedUrl(snapshot.document.storage_path, 600).then(({ data, error }) => {
      if (cancelled) return;
      if (error || !data?.signedUrl) {
        console.error('[document-review-source]', error?.message ?? 'signed URL missing');
        setSourceError('לא ניתן לטעון תצוגה מאובטחת של המקור. אפשר לנסות לרענן את המסך.');
        return;
      }
      setSourceUrl(data.signedUrl);
    });
    return () => { cancelled = true; };
  }, [snapshot.document?.storage_path]);

  async function openSource() {
    const storagePath = snapshot.document?.storage_path;
    if (!storagePath) return;
    setOpeningSource(true);
    const result = await openReservedPopup(async () => {
      const { data, error } = await supabase.storage
        .from('documents')
        .createSignedUrl(storagePath, 300);
      if (error || !data?.signedUrl) throw error ?? new Error('signed URL missing');
      return data.signedUrl;
    });
    setOpeningSource(false);
    if (result === 'blocked') toast('הדפדפן חסם את פתיחת המסמך. יש לאפשר חלונות קופצים ולנסות שוב.', 'error');
    if (result === 'error') toast('לא ניתן ליצור קישור מאובטח חדש למסמך. יש לנסות שוב.', 'error');
  }

  useEffect(() => {
    if (!extraction) return;
    setPage((current) => Math.min(Math.max(current, 1), Math.max(1, extraction.document.page_count)));
  }, [extraction]);

  if (!snapshot.document) {
    return <Note tone="alert" role="alert">המסמך אינו זמין או שאין לך הרשאה לצפות בו.</Note>;
  }

  return (
    <div className="min-w-0 space-y-5" data-testid="document-review-page">
      <section className="card card-pad">
        {/* One h1 per page, and it belongs to the page. `DocumentReview` renders "בדיקת מסמך" and
            the file name above this card, and renders them even while a scan is still waiting and
            this workspace does not mount at all — so the copy here was the second h1 and the
            second file name on the same screen. This card owns one thing: where the document is. */}
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="section-title">מצב המסמך</h2>
          {/* The strip below is the single place this screen says how far the document got. While
              a job is in flight the badge said it again, and `DocumentStatusBadge` carries the page
              counter for the surfaces that have no strip (the folder, the upload centre) — so
              "עמוד 7 מתוך 27" was rendered twice, from two code paths, a few pixels apart. The
              badge stays for every state the strip cannot express: not sent yet, stuck, failed,
              filed, archived. It steps aside only while the strip is telling the story. */}
          {!uiStatus.loading && <DocumentStatusBadge status={uiStatus} data-stage={snapshot.stage} />}
        </div>

        {/* Above the review layers on purpose: while a document is still being read there is
            nothing to review, and "where is it now" is the only question the screen can answer. */}
        <div className="mt-4">
          <DocumentProcessingProgress snapshot={snapshot} />
        </div>

        {/* "0 תיקונים · 0 הערות" is the ordinary case, and it took a box on the first screen of
            every review to say that nothing happened. The tile now appears once there is a layer
            to report; its absence carries the same information without spending the space. */}
        {(snapshot.reviewCorrections.length > 0 || snapshot.annotations.length > 0) && (
          <div className="mt-4 rounded-lg bg-surface-sunken p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-ink-soft"><FileCheck2 size={ICON.md} aria-hidden="true" /> שכבות בדיקה</div>
            <p className="mt-1 text-sm text-ink-body"><span className="num">{snapshot.reviewCorrections.length}</span> תיקונים · <span className="num">{snapshot.annotations.length}</span> הערות</p>
          </div>
        )}

        {/* Which engine read the document, the job id, the source fingerprint and the contract
            version are support/audit evidence, not decision material: knowing the model name does
            not help a bookkeeper decide whether the price is right. Staged disclosure (DESIGN.md):
            kept verbatim and reachable, folded so a non-technical reviewer is not met by them. */}
        {/* Gated on any of the three, not on the job alone: the confidence numbers now live in
            here, and an extraction whose job row is not readable must not take its evidence with
            it. Each row inside still states its own availability. */}
        {(snapshot.job || snapshot.extraction || snapshot.interpretation) && (
          <details
            className="mt-4 border-t border-line pt-3"
            onToggle={(event) => setTechnicalOpen(event.currentTarget.open)}
          >
            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-ink-soft">פרטים טכניים</summary>
            <dl className="mt-2 grid gap-2 text-xs text-ink-muted">
              {/* THE VENDOR AND THE MODEL ARE GONE (owner report 25.08.2026: "כשכתוב לי פרטים
                  טכניים אני לא אמור לראות שם מודל ו-ai ודברים כאלה"). DESIGN.md already banned a
                  model name on the assistant surface; the ruling extends the same rule here, and
                  the reason is the same on both: a customer of a procurement system is buying the
                  reading, not the machine that did it, and printing "openai · gpt-…" beside their
                  supplier invoice makes the vendor the subject of the screen.

                  WHAT SURVIVES, AND WHY IT IS NOT THE SAME THING. Support has to be able to find
                  one exact run when a reading is wrong, and the four rows that do that — job id,
                  source digest, contract version, and the prompt/schema pair — are OURS. They
                  identify our own revision of our own pipeline (`DEBT §19` is the open claim that
                  rests on the prompt version), and none of them names a company or a product. The
                  two engine rows collapse into one "גרסת עיבוד" line for the same reason: with
                  the brand names removed, what was left of each was a version. Nothing is deleted
                  from the database — `engine`, `model` and `provider` are still written and still
                  queryable by an operator; they simply stop being printed at a tenant. */}
              <div>
                <dt className="flex items-center gap-1.5 font-medium text-ink-soft"><ScanText size={ICON.xs} aria-hidden="true" /> גרסת עיבוד</dt>
                <dd className="mt-0.5 break-words">
                  {snapshot.extraction
                    ? <>קריאה <span dir="ltr" className="num">{snapshot.extraction.model_version}</span></>
                    : 'קריאה — טרם זמין'}
                  {snapshot.interpretation
                    ? <> · פירוש <span dir="ltr" className="num">{snapshot.interpretation.prompt_version}</span> / <span dir="ltr" className="num">{snapshot.interpretation.schema_version}</span></>
                    : ' · פירוש — טרם זמין'}
                </dd>
              </div>
              {snapshot.job && (
                <div>
                  <dt className="font-medium text-ink-soft">מזהה משימה</dt>
                  <dd className="mt-0.5 break-all"><span dir="ltr" className="tech-id">{snapshot.job.id}</span></dd>
                </div>
              )}
              {snapshot.extraction && (
                <>
                  <div>
                    <dt className="font-medium text-ink-soft">טביעת מקור</dt>
                    <dd className="mt-0.5 break-all"><span dir="ltr" className="tech-id">{snapshot.extraction.input_checksum}</span></dd>
                  </div>
                  <div>
                    <dt className="font-medium text-ink-soft">גרסת חוזה</dt>
                    <dd className="mt-0.5 break-all"><span dir="ltr" className="num">{snapshot.extraction.contract_version}</span></dd>
                  </div>
                </>
              )}
            </dl>

            {/* The percentages the review screens stopped printing. Said plainly, because a number
                shown without this sentence reads as a probability that the value is correct, and
                it is not one: it is the engine's self-report about its own reading. The sentence
                does not appear when there is nothing under it to describe. */}
            {technicalOpen && (interpretationEvidence.length > 0 || extractionEvidence.length > 0) && (
              <p className="mt-3 text-xs text-ink-muted">
                האחוזים הם דיווח עצמי של המנוע על איכות הקריאה, ואינם הסתברות שהערך נכון. המסכים
                עצמם מציגים דרגה מילולית; כאן מוצג המספר עצמו, מעוגל לשתי ספרות אחרי הנקודה, לצד
                מזהי הראיה.
              </p>
            )}

            {technicalOpen && interpretationEvidence.length > 0 && (
              <div
                className="mt-2 table-scroll overflow-x-auto rounded-lg border border-line"
                role="region"
                tabIndex={0}
                aria-label="רמות זיהוי גולמיות של הפירוש; ניתן לגלול בתוך הטבלה"
              >
                <table className="min-w-full bg-surface">
                  <caption className="px-3 pt-2 text-start text-xs font-medium text-ink-soft">פירוש, הערות וכללים</caption>
                  <thead className="table-head">
                    <tr className="border-b border-line">
                      <th className="th" scope="col">פריט</th>
                      <th className="th" scope="col">רמת זיהוי</th>
                      <th className="th" scope="col">מזהי ראיה</th>
                    </tr>
                  </thead>
                  <tbody>
                    {interpretationEvidence.map((row) => (
                      <tr key={row.key} className="border-b border-line last:border-b-0">
                        <td className="td">{row.label}</td>
                        <td className="td num">{confidencePercent(row.confidence)}</td>
                        <td className="td"><span dir="ltr" className="num">{row.evidence.length ? row.evidence.join(', ') : '—'}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {technicalOpen && extractionEvidence.length > 0 && (
              <div
                className="mt-2 table-scroll overflow-x-auto rounded-lg border border-line"
                role="region"
                tabIndex={0}
                aria-label="רמות זיהוי גולמיות של החילוץ; ניתן לגלול בתוך הטבלה"
              >
                <table className="min-w-full bg-surface">
                  <caption className="px-3 pt-2 text-start text-xs font-medium text-ink-soft">קטעים וסימונים בחילוץ</caption>
                  <thead className="table-head">
                    <tr className="border-b border-line">
                      <th className="th" scope="col">פריט</th>
                      <th className="th" scope="col">עמוד</th>
                      <th className="th" scope="col">רמת זיהוי</th>
                      <th className="th" scope="col">מיקום</th>
                      <th className="th" scope="col">מזהה</th>
                    </tr>
                  </thead>
                  <tbody>
                    {extractionEvidence.map((row) => (
                      <tr key={row.key} className="border-b border-line last:border-b-0">
                        <td className="td">{row.kind}</td>
                        <td className="td num">{row.page}</td>
                        <td className="td num">{confidencePercent(row.confidence)}</td>
                        <td className="td">{bboxDescription(row.bbox)}</td>
                        <td className="td"><span dir="ltr" className="tech-id">{row.id}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </details>
        )}
      </section>

      {snapshot.stage === 'failed' && (
        <Note tone="alert" role="alert" className="flex-wrap">
          <span className="min-w-0 flex-1">
            <strong>העיבוד נכשל.</strong>{' '}
            {documentProcessingFailureText(snapshot.job?.last_error_code, snapshot.job?.last_error_message)}
          </span>
          {!readOnly && onReprocess && (
            <button type="button" className="btn-secondary" disabled={reprocessing} onClick={onReprocess}>
              <RefreshCw className={reprocessing ? 'animate-spin ' : ''} size={ICON.md} aria-hidden="true" />
              {reprocessing ? 'שולח מחדש…' : 'עיבוד מחדש'}
            </button>
          )}
        </Note>
      )}
      {/* The old wording narrated the heuristic ("לפי הגיל ומספר הניסיונות שנשמרו בשרת").
          documentUiStatus already carries the reason; the alert only has to name the next move. */}
      {uiStatus.state === 'stuck' && (
        <Note tone="alert" role="alert">העיבוד נעצר. אפשר לטפל בו במרכז תפעול המסמכים.</Note>
      )}
      {snapshot.extraction?.payload.document.partial && (
        <Note tone="await" role="status">החילוץ חלקי. יש להשוות כל ערך למקור לפני מתן משוב.</Note>
      )}

      {/* Four notes stood here and none of them survived, because each one was the strip's sentence
          said a second time — and each one outlived the state it described:
          · "המסמך בעיבוד ומוצג כרגע לקריאה בלבד" — while a document is being read there is nothing
            on screen to edit, so the read-only half claimed a restriction that does not exist.
          · "המסמך טרם נשלח לעיבוד" — `DocumentReview` already says this above, with the button
            that does something about it.
          · "החילוץ עדיין אינו זמין. המסך יתעדכן כאשר תתקבל תוצאה." — not gated on stuck, so a job
            that had stopped moving showed the alert AND a promise that it would update by itself.
          · "החילוץ התקבל והפירוש הסמנטי עדיין בעיבוד." — not gated on review/completed, so a
            document whose interpretation never arrived kept claiming work was under way.
          The strip above answers all four from the job the server actually reports, and it is the
          only surface on this screen that may claim work is in progress. */}

      {/* Below `xl` the decision column comes first, for every document kind — not only for a price
          list, which is how this started.
          On a phone the two columns are one column, and the source viewer is a full-width page
          image with no height cap: an invoice review opened onto ~750px of scan before the first
          word about what the machine concluded. The findings, the supplier, the order and "מה יקרה
          באישור" are what a reviewer reads first; the document is what they consult when one of
          those makes them doubt, and it is still on the same screen, one scroll down.
          DOM order is unchanged — only the visual order moves — so `order` is applied to the grid
          children and the reading order a screen reader follows stays source-then-decision. */}
      {extraction && (
        <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1.08fr)_minmax(24rem,0.92fr)]">
          <div className="order-2 min-w-0 xl:order-1">
            <DocumentSourceViewer
              fileName={snapshot.document.file_name}
              mimeType={snapshot.document.mime_type}
              sourceUrl={sourceUrl}
              sourceError={sourceError}
              openingSource={openingSource}
              pageCount={extraction.document.page_count}
              page={page}
              onPageChange={setPage}
              onOpenSource={() => void openSource()}
            />
          </div>

          <div className="order-1 min-w-0 space-y-5 xl:order-2">
            {snapshot.packet ? (
              <DocumentPacketReview snapshot={snapshot} readOnly={readOnly} onRefetch={onRefetch} />
            ) : readOnly ? (
              <Note tone="idle">המסמך ותוצאות העיבוד זמינים לצפייה. פעולות בדיקה ועדכון אינן זמינות במצב קריאה בלבד.</Note>
            ) : isPriceList
              ? <PriceListReviewConfirmation snapshot={snapshot} actorId={actorId} onRefetch={onRefetch} />
              : snapshot.interpretation && (
                <>
                  <DocumentAssessmentPanel
                    documentId={snapshot.document.id}
                    onApplied={() => { void onRefetch(); }}
                  />
                  <DocumentReviewProposals snapshot={snapshot} onRefetch={onRefetch} />
                </>
              )}
            {!readOnly && snapshot.interpretation && !isPriceList
              && <DocumentExportPreview snapshot={snapshot} actorId={actorId} autoFocus={initialPanel === 'export'} />}
          </div>
        </div>
      )}
    </div>
  );
}
