import { useEffect, useMemo, useState } from 'react';
import { Cpu, FileCheck2, ScanText } from 'lucide-react';
import type { Role } from '../../lib/types';
import { supabase } from '../../lib/supabase';
import { openReservedPopup } from '../../lib/popup';
import { DOCUMENT_PROCESSING_STAGE_META } from '../../lib/useDocumentProcessing';
import { Note, useToast } from '../ui';
import { DocumentExportPreview } from './DocumentExportPreview';
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
  role: Role;
  actorId: string;
  onRefetch: () => Promise<boolean>;
  initialPanel: string | null;
  readOnly?: boolean;
}

export function DocumentReviewWorkspace({ snapshot, role, actorId, onRefetch, initialPanel, readOnly = false }: DocumentReviewWorkspaceProps) {
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
  const stageMeta = DOCUMENT_PROCESSING_STAGE_META[snapshot.stage];

  /**
   * Every confidence number the everyday screens stopped printing, in one place.
   *
   * The percentages were not deleted — deleting them would take the only thread a support session
   * has when an extraction goes wrong. They moved: the review screens now say "זוהה בבירור" and the
   * arithmetic lives here, folded, one click away, alongside the evidence ids that let a number be
   * traced back to the block it came from. Rule applications are excluded for a supplier account
   * for the same reason the rules panel itself is: they are the tenant's learned rules.
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
    if (role !== 'supplier') {
      snapshot.ruleApplications.forEach((application) => rows.push({
        key: `rule-application-${application.id}`,
        label: `כלל שהופעל · גרסה ${application.rule_version}`,
        confidence: application.confidence,
        evidence: [application.target_id],
      }));
    }
    return rows;
  }, [snapshot.interpretation, snapshot.annotations, snapshot.ruleApplications, role]);

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
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="page-title break-words">בדיקת מסמך</h1>
              <span className={`badge-${stageMeta.tone}`}>{stageMeta.label}</span>
            </div>
            <p className="mt-1 break-words text-sm text-ink-muted">{snapshot.document.file_name}</p>
          </div>
        </div>

        <div className="mt-4 rounded-lg bg-surface-sunken p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-ink-soft"><FileCheck2 size={17} aria-hidden="true" /> שכבות בדיקה</div>
          <p className="mt-1 text-sm text-ink-body"><span className="num">{snapshot.reviewCorrections.length}</span> תיקונים · <span className="num">{snapshot.annotations.length}</span> הערות</p>
        </div>

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
              <div>
                <dt className="flex items-center gap-1.5 font-medium text-ink-soft"><ScanText size={14} aria-hidden="true" /> מנוע חילוץ</dt>
                <dd className="mt-0.5 break-words">{snapshot.extraction ? `${snapshot.extraction.engine} · ${snapshot.extraction.model} ${snapshot.extraction.model_version}` : 'טרם זמין'}</dd>
              </div>
              <div>
                <dt className="flex items-center gap-1.5 font-medium text-ink-soft"><Cpu size={14} aria-hidden="true" /> מנוע פירוש</dt>
                <dd className="mt-0.5 break-words">
                  {snapshot.interpretation
                    ? `${snapshot.interpretation.provider} · ${snapshot.interpretation.model} · prompt ${snapshot.interpretation.prompt_version} · schema ${snapshot.interpretation.schema_version}`
                    : 'טרם זמין'}
                </dd>
              </div>
              {snapshot.job && (
                <div>
                  <dt className="font-medium text-ink-soft">מזהה משימה</dt>
                  <dd className="mt-0.5 break-all"><span dir="ltr" className="num">{snapshot.job.id}</span></dd>
                </div>
              )}
              {snapshot.extraction && (
                <>
                  <div>
                    <dt className="font-medium text-ink-soft">טביעת מקור</dt>
                    <dd className="mt-0.5 break-all"><span dir="ltr" className="num">{snapshot.extraction.input_checksum}</span></dd>
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
                className="mt-2 max-w-full overflow-x-auto rounded-lg border border-line"
                role="region"
                tabIndex={0}
                aria-label="רמות זיהוי גולמיות של הפירוש; ניתן לגלול בתוך הטבלה"
              >
                <table className="min-w-full bg-surface">
                  {/* Named for what the table actually holds: a supplier account gets no rule rows,
                      so it must not be promised any. */}
                  <caption className="px-3 pt-2 text-start text-xs font-medium text-ink-soft">
                    {role === 'supplier' ? 'פירוש והערות' : 'פירוש, הערות וכללים'}
                  </caption>
                  <thead>
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
                className="mt-2 max-w-full overflow-x-auto rounded-lg border border-line"
                role="region"
                tabIndex={0}
                aria-label="רמות זיהוי גולמיות של החילוץ; ניתן לגלול בתוך הטבלה"
              >
                <table className="min-w-full bg-surface">
                  <caption className="px-3 pt-2 text-start text-xs font-medium text-ink-soft">קטעים וסימונים בחילוץ</caption>
                  <thead>
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
                        <td className="td"><span dir="ltr" className="num">{row.id}</span></td>
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
        <Note tone="alert" role="alert">
          העיבוד נכשל{snapshot.job?.last_error_message ? `: ${snapshot.job.last_error_message}` : '.'} אפשר לחזור לגלריה ולשלוח את המסמך מחדש לתור.
        </Note>
      )}
      {snapshot.stage !== 'review' && snapshot.stage !== 'failed' && (
        <Note tone="info" role="status">המסמך מוצג לקריאה בלבד כל עוד אינו במצב „דורש בדיקה”. הסטטוס מתרענן אוטומטית.</Note>
      )}
      {snapshot.extraction?.payload.document.partial && (
        <Note tone="await" role="status">החילוץ חלקי. יש להשוות כל ערך למקור לפני מתן משוב.</Note>
      )}

      {!snapshot.job && <Note tone="idle">המסמך טרם נשלח לעיבוד.</Note>}
      {snapshot.job && !snapshot.extraction && snapshot.stage !== 'failed' && <Note tone="info">החילוץ עדיין אינו זמין. המסך יתעדכן כאשר תתקבל תוצאה.</Note>}
      {snapshot.extraction && !snapshot.interpretation && snapshot.stage !== 'failed' && <Note tone="info">החילוץ התקבל והפירוש הסמנטי עדיין בעיבוד.</Note>}

      {extraction && (
        <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1.08fr)_minmax(24rem,0.92fr)]">
          <div className={isPriceList ? 'order-2 min-w-0 xl:order-1' : 'min-w-0'}>
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

          <div className={`min-w-0 space-y-5 ${isPriceList ? 'order-1 xl:order-2' : ''}`}>
            {readOnly ? (
              <Note tone="idle">המסמך ותוצאות העיבוד זמינים לצפייה. פעולות בדיקה ועדכון אינן זמינות במצב קריאה בלבד.</Note>
            ) : isPriceList
              ? <PriceListReviewConfirmation snapshot={snapshot} role={role} actorId={actorId} onRefetch={onRefetch} />
              : snapshot.interpretation && <DocumentReviewProposals snapshot={snapshot} role={role} onRefetch={onRefetch} />}
            {!readOnly && snapshot.interpretation && !isPriceList && role !== 'supplier'
              && <DocumentExportPreview snapshot={snapshot} actorId={actorId} autoFocus={initialPanel === 'export'} />}
          </div>
        </div>
      )}
    </div>
  );
}
