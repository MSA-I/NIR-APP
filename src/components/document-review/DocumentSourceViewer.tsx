import { ExternalLink, FileText, MousePointer2 } from 'lucide-react';
import type { ExtractionContract } from '../../lib/types';
import { Note } from '../ui';
import {
  MARK_KIND_LABELS,
  bboxDescription,
  confidenceLabel,
  type ReviewTarget,
} from './model';

interface DocumentSourceViewerProps {
  fileName: string;
  mimeType: string | null;
  sourceUrl: string | null;
  sourceError: string | null;
  extraction: ExtractionContract;
  page: number;
  selectedTarget: ReviewTarget | null;
  onPageChange: (page: number) => void;
  onSelectTarget: (target: ReviewTarget, returnFocus: HTMLButtonElement) => void;
  resolveBlockText: (block: ExtractionContract['blocks'][number]) => {
    text: string;
    corrected: boolean;
  };
  resolveCellText: (
    tableId: string,
    rowIndex: number,
    columnIndex: number,
    original: string,
  ) => { text: string; corrected: boolean };
}

const targetKey = (target: ReviewTarget | null) => target
  ? `${target.kind}:${target.id}:${target.kind === 'table_cell' ? `${target.rowIndex}:${target.columnIndex}` : ''}`
  : '';

function OverlayButton({
  target,
  selected,
  onSelect,
}: {
  target: Exclude<ReviewTarget, { kind: 'table_cell' }>;
  selected: boolean;
  onSelect: (target: ReviewTarget, returnFocus: HTMLButtonElement) => void;
}) {
  const [xMin, yMin, xMax, yMax] = target.bbox;
  // No touch minimum on this box: it is sized in % from the bbox, so a min-h-11/min-w-11 would
  // inflate small marks past their own region and let neighbours overlap and steal each other's
  // clicks. These overlays are tabIndex={-1} pointer shortcuts — the 44px keyboard path is the
  // labelled button list below, which is the accessible route by design.
  return (
    <button
      type="button"
      tabIndex={-1}
      className={`absolute border-2 ${selected ? 'border-action bg-action-wash/60' : 'border-info-line bg-info-wash/20'} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus`}
      style={{
        insetInlineStart: `${xMin * 100}%`,
        insetBlockStart: `${yMin * 100}%`,
        inlineSize: `${Math.max(0.01, xMax - xMin) * 100}%`,
        blockSize: `${Math.max(0.01, yMax - yMin) * 100}%`,
      }}
      aria-label={`בחירת ${target.label}. ${bboxDescription(target.bbox)}`}
      aria-pressed={selected}
      onClick={(event) => onSelect(target, event.currentTarget)}
    >
      <span className="sr-only">{target.label}</span>
    </button>
  );
}

export function DocumentSourceViewer({
  fileName,
  mimeType,
  sourceUrl,
  sourceError,
  extraction,
  page,
  selectedTarget,
  onPageChange,
  onSelectTarget,
  resolveBlockText,
  resolveCellText,
}: DocumentSourceViewerProps) {
  const blocks = extraction.blocks.filter((block) => block.page === page);
  const marks = extraction.marks.filter((mark) => mark.page === page);
  const tables = extraction.tables.filter((table) => table.page === page);
  const selected = targetKey(selectedTarget);
  const isImage = mimeType?.startsWith('image/') ?? false;
  const isPdf = mimeType === 'application/pdf';

  return (
    <section className="min-w-0 space-y-4" data-testid="document-source-viewer" aria-labelledby="document-source-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id="document-source-title" className="section-title">המסמך המקורי</h2>
          <p className="mt-1 break-words text-sm text-ink-muted">{fileName}</p>
        </div>
        {sourceUrl && (
          <a className="btn-secondary" href={sourceUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={17} aria-hidden="true" /> פתיחת המקור
          </a>
        )}
      </div>

      {sourceError && <Note tone="alert" role="alert">{sourceError}</Note>}

      <div className="card overflow-hidden">
        {sourceUrl && isImage ? (
          <div className="relative mx-auto w-full max-w-4xl bg-surface-sunken">
            <img className="block h-auto w-full" src={sourceUrl} alt={`המסמך המקורי ${fileName}`} />
            <div className="absolute inset-0" role="group" aria-label="קיצורי בחירה באמצעות מצביע">
              {blocks.map((block) => {
                const value = resolveBlockText(block);
                const target: ReviewTarget = {
                  kind: 'block', id: block.id, page: block.page, text: block.text,
                  bbox: block.bbox, label: `קטע טקסט: ${value.text}`,
                };
                return <OverlayButton key={`block-${block.id}`} target={target} selected={selected === targetKey(target)} onSelect={onSelectTarget} />;
              })}
              {marks.map((mark) => {
                const target: ReviewTarget = {
                  kind: 'mark', id: mark.id, page: mark.page, bbox: mark.bbox,
                  markKind: mark.kind, fingerprint: mark.fingerprint,
                  // Kind alone: every consumer of `label` pairs it with bboxDescription, which is what
                  // actually disambiguates two marks of the same kind. The uuid never read as anything.
                  label: MARK_KIND_LABELS[mark.kind],
                };
                return <OverlayButton key={`mark-${mark.id}`} target={target} selected={selected === targetKey(target)} onSelect={onSelectTarget} />;
              })}
            </div>
          </div>
        ) : sourceUrl && isPdf ? (
          <iframe className="h-[32rem] w-full" src={sourceUrl} title={`המסמך המקורי ${fileName}`} />
        ) : (
          <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center text-ink-muted">
            <FileText size={36} aria-hidden="true" />
            <p>{sourceUrl ? 'לקובץ זה אין תצוגה מקדימה בדפדפן. אפשר לפתוח את המקור בקישור שמעל.' : 'טוען קישור מאובטח למקור…'}</p>
          </div>
        )}
      </div>

      <div className="card card-pad" data-testid="document-annotations-keyboard">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="section-title">בחירה נגישה לפי עמוד</h3>
            <p className="mt-1 text-sm text-ink-muted">כל פעולה זמינה באמצעות Tab ואז Enter או רווח; תיבת העריכה נסגרת ב־Escape ומחזירה את הפוקוס.</p>
          </div>
          <label className="grid min-h-11 min-w-0 max-w-full gap-2 text-sm font-medium text-ink-soft sm:flex sm:items-center">
            <span>עמוד</span>
            <select className="input min-w-0 w-full sm:w-auto sm:min-w-24" value={page} onChange={(event) => onPageChange(Number(event.target.value))}>
              {Array.from({ length: extraction.document.page_count }, (_, index) => index + 1).map((number) => (
                <option key={number} value={number}>{number}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-2">
          <div className="min-w-0">
            <h4 className="font-semibold text-ink-body">קטעי טקסט</h4>
            <div className="mt-2 space-y-2">
              {blocks.length === 0 && <p className="text-sm text-ink-muted">לא זוהו קטעי טקסט בעמוד הזה.</p>}
              {blocks.map((block) => {
                const value = resolveBlockText(block);
                const target: ReviewTarget = {
                  kind: 'block', id: block.id, page: block.page, text: block.text,
                  bbox: block.bbox, label: `קטע טקסט: ${value.text}`,
                };
                return (
                  <button
                    key={block.id}
                    type="button"
                    className={`min-h-11 w-full rounded-lg border p-3 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${selected === targetKey(target) ? 'border-action bg-action-wash' : 'border-line bg-surface hover:bg-surface-sunken'}`}
                    aria-pressed={selected === targetKey(target)}
                    onClick={(event) => onSelectTarget(target, event.currentTarget)}
                  >
                    <span className="block break-words font-medium text-ink-body">{value.text || 'קטע ללא טקסט'}</span>
                    <span className="mt-1 block text-xs text-ink-muted">{confidenceLabel(block.confidence)} · {bboxDescription(block.bbox)}</span>
                    {value.corrected && <span className="badge-info mt-2">מוצג תיקון מעל המקור</span>}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="min-w-0">
            <h4 className="font-semibold text-ink-body">סימונים</h4>
            <div className="mt-2 space-y-2">
              {marks.length === 0 && <p className="text-sm text-ink-muted">לא זוהו סימונים בעמוד הזה.</p>}
              {marks.map((mark) => {
                const target: ReviewTarget = {
                  kind: 'mark', id: mark.id, page: mark.page, bbox: mark.bbox,
                  markKind: mark.kind, fingerprint: mark.fingerprint,
                  // Kind alone: every consumer of `label` pairs it with bboxDescription, which is what
                  // actually disambiguates two marks of the same kind. The uuid never read as anything.
                  label: MARK_KIND_LABELS[mark.kind],
                };
                return (
                  <button
                    key={mark.id}
                    type="button"
                    className={`min-h-11 w-full rounded-lg border p-3 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${selected === targetKey(target) ? 'border-action bg-action-wash' : 'border-line bg-surface hover:bg-surface-sunken'}`}
                    aria-pressed={selected === targetKey(target)}
                    onClick={(event) => onSelectTarget(target, event.currentTarget)}
                  >
                    <span className="block font-medium text-ink-body"><MousePointer2 className="me-1 inline" size={16} aria-hidden="true" />{MARK_KIND_LABELS[mark.kind]}</span>
                    <span className="mt-1 block text-xs text-ink-muted">{confidenceLabel(mark.confidence)} · {bboxDescription(mark.bbox)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Numbered by position, not by `table.id`: the id is an extraction-internal string
            ("ocr-p1-t1") that named nothing to the person checking the document. */}
        {tables.map((table, tableIndex) => (
          <section key={table.id} className="mt-5 min-w-0" aria-labelledby={`table-${table.id}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 id={`table-${table.id}`} className="font-semibold text-ink-body">טבלה <span className="num">{tableIndex + 1}</span></h4>
              <span className="text-xs text-ink-muted">{bboxDescription(table.bbox)}</span>
            </div>
            <div className="mt-2 max-w-full overflow-x-auto rounded-lg border border-line" role="region" tabIndex={0} aria-label={`טבלה חזותית ${tableIndex + 1}; ניתן לגלול בתוך הטבלה`}>
              <table className="min-w-full border-collapse bg-surface">
                <tbody>
                  {table.rows.map((row, rowIndex) => (
                    <tr key={`${table.id}-${rowIndex}`} className="border-b border-line last:border-b-0">
                      {row.map((cell, columnIndex) => {
                        const value = resolveCellText(table.id, rowIndex, columnIndex, cell.text);
                        const target: ReviewTarget = {
                          kind: 'table_cell', id: table.id, page: table.page,
                          rowIndex, columnIndex, text: cell.text, bbox: cell.bbox,
                          label: `תא בשורה ${rowIndex + 1}, עמודה ${columnIndex + 1}: ${value.text}`,
                        };
                        return (
                          <td key={`${table.id}-${rowIndex}-${columnIndex}`} className="border-e border-line p-1 last:border-e-0">
                            <button
                              type="button"
                              className={`min-h-11 min-w-24 w-full rounded-md px-3 py-2 text-start text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${selected === targetKey(target) ? 'bg-action-wash text-ink' : 'hover:bg-surface-sunken'}`}
                              aria-label={`${target.label}. ${bboxDescription(cell.bbox)}`}
                              aria-pressed={selected === targetKey(target)}
                              onClick={(event) => onSelectTarget(target, event.currentTarget)}
                            >
                              <span className="break-words">{value.text || 'תא ריק'}</span>
                              {value.corrected && <span className="badge-info ms-2">תוקן</span>}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}
