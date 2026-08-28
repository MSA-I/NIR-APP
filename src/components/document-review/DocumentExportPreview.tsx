import { useEffect, useMemo, useRef, useState } from 'react';
import { FileSpreadsheet, Loader2, RefreshCw } from 'lucide-react';
import { generateDocumentExport, type DocumentExportResult } from '../../lib/documentExport';
import { ICON, Note } from '../ui';
import { resolveExportTemplateWinner, type ReviewSnapshot } from './model';
import { useT } from '../../lib/i18n/LocaleProvider';
import type { TKey } from '../../lib/i18n/t';

interface DocumentExportPreviewProps {
  snapshot: ReviewSnapshot;
  actorId: string;
  autoFocus: boolean;
}

const formatLabelKey: Record<'xlsx' | 'csv' | 'json' | 'table' | 'text', TKey> = {
  xlsx: 'documentExportPreview.formatXlsx',
  csv: 'documentExportPreview.formatCsv',
  json: 'documentExportPreview.formatJson',
  table: 'documentExportPreview.formatTable',
  text: 'documentExportPreview.formatText',
};

export function DocumentExportPreview({ snapshot, actorId, autoFocus }: DocumentExportPreviewProps) {
  const { t } = useT();
  const sectionRef = useRef<HTMLElement>(null);
  const selected = useMemo(
    () => resolveExportTemplateWinner(snapshot, actorId),
    [actorId, snapshot],
  );
  const [result, setResult] = useState<DocumentExportResult | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setResult(null);
    setPreviewFailed(false);
  }, [selected?.version.id]);

  useEffect(() => {
    if (!autoFocus) return;
    window.requestAnimationFrame(() => {
      sectionRef.current?.scrollIntoView({ block: 'start' });
      sectionRef.current?.focus({ preventScroll: true });
    });
  }, [autoFocus]);

  async function buildPreview() {
    if (!snapshot.interpretation || !selected) return;
    setBusy(true);
    setPreviewFailed(false);
    setResult(null);
    try {
      setResult(await generateDocumentExport(snapshot.interpretation.payload, selected.contract));
    } catch (previewError) {
      console.error('[document-export-preview]', previewError);
      setPreviewFailed(true);
    } finally {
      setBusy(false);
    }
  }

  if (!selected) return null;

  return (
    <section
      ref={sectionRef}
      className="card card-pad min-w-0 scroll-mt-4"
      data-testid="document-export-preview"
      aria-labelledby="document-export-title"
      tabIndex={-1}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="document-export-title" className="section-title">{t('documentExportPreview.text')}</h2>
          <p className="mt-1 text-sm text-ink-muted">{t('documentExportPreview.text_2')}</p>
        </div>
        <FileSpreadsheet className="text-action" size={ICON.xl} aria-hidden="true" />
      </div>

      <>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <span className="label">{t('documentExportPreview.text_3')}</span>
              <p className="mt-1 break-words font-medium text-ink-body">{selected.contract.name} · {t(formatLabelKey[selected.contract.format])}</p>
            </div>
            {/* Secondary: this card sits below the approval on the same screen, and a preview that
                "אינה שומרת קובץ ואינה משנה נתונים" — its own words — must not carry the same
                weight as the button that records the document. */}
            <button type="button" className="btn-secondary shrink-0" onClick={() => void buildPreview()} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" size={ICON.md} aria-hidden="true" /> : <RefreshCw size={ICON.md} aria-hidden="true" />} {t('documentExportPreview.buildPreview')}
            </button>
          </div>

          <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-ink-muted">
            <div><dt className="inline font-medium">{t('documentExportPreview.text_4')} </dt><dd className="inline">{t(formatLabelKey[selected.contract.format])}</dd></div>
            <div><dt className="inline font-medium">{t('documentExportPreview.text_5')} </dt><dd className="inline num">{selected.version.version}</dd></div>
            <div><dt className="inline font-medium">{t('documentExportPreview.text_6')} </dt><dd className="inline num">{selected.contract.columns.length}</dd></div>
          </dl>

          {previewFailed && <Note tone="alert" role="alert" className="mt-4">{t('documentExportPreview.setError')}</Note>}

          {result && (
            <div className="mt-5 min-w-0" aria-live="polite">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold text-ink-body">{t('documentExportPreview.text_7')}</h3>
                <span className="badge-done">{t(formatLabelKey[result.format])} · {t(
                  result.rows.length === 1 ? 'documentExportPreview.rowOne' : 'documentExportPreview.rowMany',
                  { count: result.rows.length },
                )}</span>
              </div>
              <p className="mt-2 break-all text-xs text-ink-muted">{t('documentExportPreview.text_9')} <span dir="ltr" className="tech-id">{result.checksum}</span></p>
              {/* role="region" is what makes aria-label announceable: a bare div has no role, so the
                  name was silently dropped by screen readers and the scroll container arrived unnamed. */}
              <div className="mt-3 table-scroll overflow-x-auto rounded-lg border border-line" role="region" tabIndex={0} aria-label={t('documentExportPreview.aria_label')}>
                <table className="min-w-full bg-surface">
                  <thead className="table-head">
                    <tr className="border-b border-line">
                      {result.columns.map((column) => <th key={column.key} scope="col" className="th">{column.label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.slice(0, 100).map((row, rowIndex) => (
                      <tr key={rowIndex} className="border-b border-line last:border-b-0">
                        {result.columns.map((column) => (
                          <td key={column.key} className={`td ${column.type === 'number' ? 'num' : ''}`}>{row[column.key] == null ? '—' : String(row[column.key])}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {result.rows.length > 100 && <p className="mt-2 text-sm text-ink-muted">{t(
                'documentExportPreview.displayedRows',
                { shown: 100, total: result.rows.length },
              )}</p>}
            </div>
          )}
      </>
    </section>
  );
}
