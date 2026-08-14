import { useEffect, useRef, useState } from 'react';
import { Check, CornerDownLeft, Loader2, Pencil, ScanLine } from 'lucide-react';
import { toHebrewError } from '../../lib/errors';
import { supabase } from '../../lib/supabase';
import {
  acceptDocumentScan,
  recoverDocumentScan,
  scanCornersValid,
  submitDocumentScanCorners,
  type DocumentScanState,
  type ScanCorners,
} from '../../lib/useDocumentScanning';
import { Note, useToast } from '../ui';

const DEFAULT_CORNERS: ScanCorners = [[0.05, 0.05], [0.95, 0.05], [0.95, 0.95], [0.05, 0.95]];
const CORNER_LABELS = ['פינה שמאלית עליונה', 'פינה ימנית עליונה', 'פינה ימנית תחתונה', 'פינה שמאלית תחתונה'];

interface Props {
  state: DocumentScanState;
  originalStoragePath: string;
  fileName: string;
  onChanged: () => Promise<unknown>;
  readOnly: boolean;
}

const SCAN_FAILURE_MESSAGES: Record<string, string> = {
  corrupt_document: 'קובץ התמונה פגום או שאינו נתמך.',
  decompressed_size_limit: 'רזולוציית התמונה גדולה מדי לעיבוד בטוח.',
  file_size_limit: 'קובץ התמונה גדול מדי.',
  processing_resource_failure: 'עיבוד התמונה חרג ממגבלת המשאבים.',
  processing_timeout: 'עיבוד התמונה ארך זמן רב מדי.',
  scan_image_too_small: 'התמונה קטנה מדי לזיהוי מסמך.',
};

function scanFailureMessage(code: string | null): string {
  return code && SCAN_FAILURE_MESSAGES[code]
    ? SCAN_FAILURE_MESSAGES[code]
    : 'לא ניתן ליצור סריקה נקייה. אפשר לנסות להעלות צילום ברור יותר.';
}

function ScanCornerEditor({ sourceUrl, state, fileName, onChanged, readOnly, recovery = false }: {
  sourceUrl: string;
  state: DocumentScanState;
  fileName: string;
  onChanged: () => Promise<unknown>;
  readOnly: boolean;
  recovery?: boolean;
}) {
  const [corners, setCorners] = useState<ScanCorners>(
    state.manual_corners ?? state.detected_corners ?? DEFAULT_CORNERS,
  );
  const [saving, setSaving] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const valid = scanCornersValid(corners);

  function move(index: number, x: number, y: number) {
    setCorners((current) => current.map((point, pointIndex) =>
      pointIndex === index
        ? [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))]
        : point
    ) as ScanCorners);
  }

  async function submit() {
    if (!valid || readOnly) return;
    setSaving(true);
    try {
      if (recovery) await recoverDocumentScan(state.scan_job_id, corners);
      else await submitDocumentScanCorners(state.scan_job_id, corners);
      toast('הפינות נשמרו. נוצרת סריקה חדשה.', 'success');
      await onChanged();
    } catch (error) {
      toast(toHebrewError(error), 'error');
    } finally {
      setSaving(false);
    }
  }

  const polygon = corners.map(([x, y]) => `${x * 100},${y * 100}`).join(' ');
  return (
    <div className="space-y-4">
      <Note tone="await">
        {recovery
          ? 'מקם את ארבע הפינות על הדף המלא. הסריקה הקודמת תישמר כראיה ותיווצר סריקה חדשה.'
          : 'גבולות הדף לא זוהו. מקם את ארבע הפינות על קצות המסמך ואז צור סריקה חדשה.'}
      </Note>
      <div ref={frame} dir="ltr" className="relative mx-auto max-w-4xl overflow-hidden rounded-lg bg-surface-sunken touch-none">
        <img src={sourceUrl} alt={`המסמך המקורי ${fileName} לבחירת גבולות`} className="block h-auto w-full select-none" draggable={false} />
        <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polygon points={polygon} fill="none" stroke="currentColor" strokeWidth="0.65" className="text-action" />
        </svg>
        {corners.map(([x, y], index) => (
          <button
            key={CORNER_LABELS[index]}
            type="button"
            className="absolute grid size-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 border-action bg-surface text-action shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            style={{ insetInlineStart: `${x * 100}%`, insetBlockStart: `${y * 100}%` }}
            aria-label={`${CORNER_LABELS[index]}. חצים מזיזים בחצי אחוז; Shift וחץ בשני אחוזים.`}
            disabled={readOnly}
            onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId) || !frame.current) return;
              const rect = frame.current.getBoundingClientRect();
              move(index, (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
            }}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 0.02 : 0.005;
              const delta: Record<string, [number, number]> = {
                ArrowRight: [step, 0], ArrowLeft: [-step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
              };
              const change = delta[event.key];
              if (!change) return;
              event.preventDefault();
              move(index, x + change[0], y + change[1]);
            }}
          >
            <CornerDownLeft size={19} aria-hidden="true" />
          </button>
        ))}
      </div>
      {!valid && <Note tone="alert" role="alert">ארבע הפינות חייבות ליצור מסגרת של דף בלי קווים מצטלבים.</Note>}
      {readOnly && <Note tone="await">הארגון במצב קריאה בלבד, ולכן אי אפשר לשמור תיקון פינות.</Note>}
      <div className="flex justify-end">
        <button type="button" className="btn-primary" disabled={saving || !valid || readOnly} onClick={() => void submit()}>
          {saving ? <Loader2 className="animate-spin motion-reduce:animate-none" size={17} aria-hidden="true" /> : <ScanLine size={17} aria-hidden="true" />}
          {saving ? 'שומר ומעבד…' : 'יצירת סריקה מהפינות'}
        </button>
      </div>
    </div>
  );
}

export function DocumentScanPreview({ state, originalStoragePath, fileName, onChanged, readOnly }: Props) {
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  const [scanUrl, setScanUrl] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [editingCorners, setEditingCorners] = useState(state.status === 'failed');
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    setOriginalUrl(null);
    setScanUrl(null);
    setUrlError(null);
    void Promise.all([
      supabase.storage.from('documents').createSignedUrl(originalStoragePath, 600),
      state.output_storage_path
        ? supabase.storage.from('document-scans').createSignedUrl(state.output_storage_path, 600)
        : Promise.resolve({ data: null, error: null }),
    ]).then(([original, scan]) => {
      if (cancelled) return;
      if (original.error || !original.data?.signedUrl || (state.output_storage_path && (scan.error || !scan.data?.signedUrl))) {
        setUrlError('לא ניתן לטעון את תצוגת הסריקה המאובטחת. אפשר לרענן ולנסות שוב.');
        return;
      }
      setOriginalUrl(original.data.signedUrl);
      setScanUrl(scan.data?.signedUrl ?? null);
    });
    return () => { cancelled = true; };
  }, [originalStoragePath, state.output_storage_path]);

  async function accept() {
    if (!state.output_id || readOnly) return;
    setAccepting(true);
    try {
      await acceptDocumentScan(state.output_id);
      toast('הסריקה אושרה והמסמך נשלח לחילוץ.', 'success');
      await onChanged();
    } catch (error) {
      toast(toHebrewError(error), 'error');
    } finally {
      setAccepting(false);
    }
  }

  return (
    <section className="card card-pad space-y-4" data-testid="document-scan-preview" aria-labelledby="document-scan-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ScanLine size={19} className="text-action" aria-hidden="true" />
            <h2 id="document-scan-title" className="section-title">הכנת סריקה לקריאה</h2>
          </div>
          <p className="mt-1 break-words text-sm text-ink-muted">{fileName}</p>
        </div>
        <span className={state.status === 'accepted' ? 'badge-done' : state.status === 'failed' ? 'badge-alert' : 'badge-await'}>
          {state.status === 'queued' ? 'ממתין לסריקה'
            : state.status === 'processing' ? 'משפר תמונה'
              : state.status === 'needs_corners' ? 'נדרשות פינות'
                : state.status === 'ready' ? 'ממתין לאישור'
                  : state.status === 'accepted' ? 'הסריקה אושרה' : 'הסריקה נכשלה'}
        </span>
      </div>

      {urlError && <Note tone="alert" role="alert">{urlError}</Note>}
      {(state.status === 'queued' || state.status === 'processing') && (
        <Note tone="info" role="status" className="flex items-center gap-2">
          <Loader2 className="animate-spin motion-reduce:animate-none" size={17} aria-hidden="true" />
          מזהה גבולות, מיישר פרספקטיבה ומסיר צללים ורעש. החילוץ יתחיל רק לאחר אישור התצוגה.
        </Note>
      )}
      {state.status === 'failed' && (
        <Note tone="alert" role="alert">הסריקה נכשלה. {scanFailureMessage(state.last_error_code)}</Note>
      )}
      {(state.status === 'needs_corners' || state.status === 'failed' || (state.status === 'ready' && editingCorners)) && originalUrl && (
        <ScanCornerEditor
          sourceUrl={originalUrl}
          state={state}
          fileName={fileName}
          onChanged={onChanged}
          readOnly={readOnly}
          recovery={state.status === 'ready' || state.status === 'failed'}
        />
      )}
      {(state.status === 'ready' || state.status === 'accepted') && !editingCorners && originalUrl && scanUrl && (
        <div className="space-y-4">
          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            <figure className="min-w-0 overflow-hidden rounded-lg border border-line bg-surface-sunken">
              <figcaption className="border-b border-line bg-surface px-3 py-2 text-sm font-medium text-ink-soft">המקור</figcaption>
              <img src={originalUrl} alt={`המסמך המקורי ${fileName}`} className="block max-h-[58vh] w-full object-contain lg:max-h-[72vh]" />
            </figure>
            <figure className="min-w-0 overflow-hidden rounded-lg border border-line bg-surface-sunken">
              <figcaption className="border-b border-line bg-surface px-3 py-2 text-sm font-medium text-ink-soft">
                הסריקה המשופרת · {state.output_mode === 'black_and_white' ? 'שחור־לבן' : 'גווני אפור'}
              </figcaption>
              <img src={scanUrl} alt={`סריקה משופרת של ${fileName}`} className="block max-h-[58vh] w-full object-contain lg:max-h-[72vh]" />
            </figure>
          </div>
          {state.status === 'ready' ? (
            <div className="space-y-3 border-t border-line pt-4">
              <Note tone="info">בשלב הזה הוכנה תמונת סריקה בלבד. עדיין לא חולצו מהמסמך ספק, מספר, תאריך, סכומים או שורות.</Note>
              <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-ink-muted">
                {readOnly
                  ? 'הארגון במצב קריאה בלבד. אפשר לצפות בסריקה, אך אי אפשר לאשר אותה לחילוץ.'
                  : 'בדוק שהדף שלם וקריא. האישור קובע שה־OCR יקרא נגזרת זו, לא את המקור.'}
              </p>
              <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-secondary" disabled={accepting || readOnly} onClick={() => setEditingCorners(true)}>
                <Pencil size={17} aria-hidden="true" /> תיקון גבולות
              </button>
              <button type="button" className="btn-primary" disabled={accepting || readOnly} onClick={() => void accept()}>
                {accepting ? <Loader2 className="animate-spin motion-reduce:animate-none" size={17} aria-hidden="true" /> : <Check size={17} aria-hidden="true" />}
                {accepting ? 'מאשר…' : 'אישור והמשך לחילוץ'}
              </button>
              </div>
              </div>
            </div>
          ) : (
            <Note tone="done" role="status">הסריקה אושרה. החילוץ קורא כעת את הגרסה המשופרת.</Note>
          )}
        </div>
      )}
    </section>
  );
}
