import { useEffect, useMemo, useRef, useState } from 'react';
import { FileSpreadsheet, Loader2, RefreshCw } from 'lucide-react';
import { generateDocumentExport, type DocumentExportResult } from '../../lib/documentExport';
import { Note } from '../ui';
import { resolveExportTemplateWinner, type ReviewSnapshot } from './model';

interface DocumentExportPreviewProps {
  snapshot: ReviewSnapshot;
  actorId: string;
  autoFocus: boolean;
}

const formatLabel: Record<'xlsx' | 'csv' | 'json' | 'table' | 'text', string> = {
  xlsx: 'Excel (XLSX)',
  csv: 'CSV',
  json: 'JSON',
  table: 'טבלה',
  text: 'טקסט',
};

export function DocumentExportPreview({ snapshot, actorId, autoFocus }: DocumentExportPreviewProps) {
  const sectionRef = useRef<HTMLElement>(null);
  const selected = useMemo(
    () => resolveExportTemplateWinner(snapshot, actorId),
    [actorId, snapshot],
  );
  const [result, setResult] = useState<DocumentExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setResult(null);
    setError(null);
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
    setError(null);
    setResult(null);
    try {
      setResult(await generateDocumentExport(snapshot.interpretation.payload, selected.contract));
    } catch (previewError) {
      console.error('[document-export-preview]', previewError);
      setError('לא ניתן להפיק תצוגה מקדימה מהתבנית והפירוש הנוכחיים. ייתכן שחסר שדה חובה או שסוג הערך אינו תואם לתבנית.');
    } finally {
      setBusy(false);
    }
  }

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
          <h2 id="document-export-title" className="section-title">תצוגה מקדימה לייצוא</h2>
          <p className="mt-1 text-sm text-ink-muted">התצוגה נוצרת בזמן אמת באמצעות generator המאושר. היא אינה שומרת קובץ ואינה משנה נתונים.</p>
        </div>
        <FileSpreadsheet className="text-action" size={24} aria-hidden="true" />
      </div>

      {!selected ? (
        <Note tone="idle" className="mt-4">אין תבנית ייצוא פעילה וזמינה למסמך הזה.</Note>
      ) : (
        <>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <span className="label">התבנית שנבחרה לפי הקדימות המאושרת</span>
              <p className="mt-1 break-words font-medium text-ink-body">{selected.contract.name} · {formatLabel[selected.contract.format]}</p>
            </div>
            <button type="button" className="btn-primary shrink-0" onClick={() => void buildPreview()} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" size={17} aria-hidden="true" /> : <RefreshCw size={17} aria-hidden="true" />} הפקת preview
            </button>
          </div>

          <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-ink-muted">
            <div><dt className="inline font-medium">פורמט: </dt><dd className="inline">{formatLabel[selected.contract.format]}</dd></div>
            <div><dt className="inline font-medium">גרסת תבנית: </dt><dd className="inline num">{selected.version.version}</dd></div>
            <div><dt className="inline font-medium">עמודות: </dt><dd className="inline num">{selected.contract.columns.length}</dd></div>
          </dl>

          {error && <Note tone="alert" role="alert" className="mt-4">{error}</Note>}

          {result && (
            <div className="mt-5 min-w-0" aria-live="polite">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold text-ink-body">תוצאת preview</h3>
                <span className="badge-done">{formatLabel[result.format]} · {result.rows.length} שורות</span>
              </div>
              <p className="mt-2 break-all text-xs text-ink-muted">Checksum: <span dir="ltr" className="num">{result.checksum}</span></p>
              <div className="mt-3 max-w-full overflow-x-auto rounded-lg border border-line" tabIndex={0} aria-label="תצוגת טבלת הייצוא; ניתן לגלול בתוך הטבלה">
                <table className="min-w-full bg-surface">
                  <thead>
                    <tr className="border-b border-line">
                      {result.columns.map((column) => <th key={column.key} className="th">{column.label}</th>)}
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
              {result.rows.length > 100 && <p className="mt-2 text-sm text-ink-muted">מוצגות 100 מתוך {result.rows.length} שורות ב־preview בלבד.</p>}
            </div>
          )}
        </>
      )}
    </section>
  );
}
