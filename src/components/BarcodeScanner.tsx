import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ScanLine } from 'lucide-react';
import { useFeatureFlags } from '../lib/flags';
import { matchDeliveryLineProduct, type DeliveryNoteLine } from './document-review/model';
import { ICON, Modal, Note } from './ui';

/**
 * Barcode-assisted goods receiving (הכרעה #102, OPEN-DECISIONS #102).
 *
 * **A scanned code is a key, never a guess.** It identifies which line of the order the person is
 * standing in front of; it never fills in a quantity, because a quantity is a claim about what came
 * off the truck and only a person can make it.
 *
 * The match runs through the catalogue chain the delivery-note reviewer already uses
 * (`matchDeliveryLineProduct`, `model.ts:343-370`) with a synthetic line carrying only the barcode,
 * so the two paths share one rule — including the one that matters most here: **two products
 * answering the same code is not a match.** Nothing is pre-selected in that case; the code is named
 * and the candidates are listed.
 *
 * The flag `receiving.barcode` gates the whole thing and is fail-closed (`flags.ts:33-34`): unknown,
 * still loading or failed to load all read as off, and off means nothing renders at all.
 *
 * `@zxing/*` is ~17MB unpacked, so it is behind a dynamic `import()` (plus its own `manualChunks`
 * rule in `vite.config.ts`) and is fetched only when someone actually opens the scanner.
 */

export interface BarcodeCatalogueEntry {
  productId: string;
  orderItemId: string;
  supplierSku: string | null;
  sku: string | null;
  barcode: string | null;
  name: string;
}

export type BarcodeScanResult =
  | { kind: 'match'; productId: string; orderItemId: string; name: string; code: string }
  | { kind: 'ambiguous'; code: string; candidates: { productId: string; name: string }[] }
  | { kind: 'none'; code: string };

const normalize = (value: string | null) => value?.trim().toLowerCase().replace(/\s+/g, ' ') || null;

/**
 * Resolves a scanned code against the lines of THIS order.
 *
 * `ambiguous` is reported separately from `none` for one reason: they are different facts. "I do not
 * know this code" and "this code names two different products" call for different actions from the
 * person holding the box, and collapsing them into one message would hide the second.
 */
export function matchScannedBarcode(
  code: string,
  entries: readonly BarcodeCatalogueEntry[],
): BarcodeScanResult {
  const value = code.trim();
  if (!value) return { kind: 'none', code: value };
  const line: DeliveryNoteLine = {
    sourceRow: null, sku: null, barcode: value, description: null, quantity: null,
  };
  const productId = matchDeliveryLineProduct(line, entries.map((entry) => ({
    productId: entry.productId,
    supplierSku: entry.supplierSku,
    sku: entry.sku,
    barcode: entry.barcode,
    name: entry.name,
  })));
  if (productId) {
    const hit = entries.find((entry) => entry.productId === productId);
    if (hit) {
      return { kind: 'match', productId, orderItemId: hit.orderItemId, name: hit.name, code: value };
    }
  }
  const candidates = entries.filter((entry) => normalize(entry.barcode) === normalize(value));
  if (candidates.length > 1) {
    return {
      kind: 'ambiguous',
      code: value,
      candidates: candidates.map((entry) => ({ productId: entry.productId, name: entry.name })),
    };
  }
  return { kind: 'none', code: value };
}

type CameraState =
  | { kind: 'starting' }
  | { kind: 'scanning' }
  | { kind: 'unavailable'; message: string };

const CAMERA_DENIED =
  'הדפדפן לא נתן הרשאה למצלמה, ולכן הסריקה כבויה. אפשר לאשר גישה למצלמה בהגדרות האתר, או להקליד את הקוד למטה.';
const CAMERA_MISSING =
  'לא נמצאה מצלמה זמינה במכשיר הזה. אפשר להקליד את הקוד למטה.';
const CAMERA_INSECURE =
  'הדפדפן מאפשר מצלמה רק בחיבור מאובטח (HTTPS). אפשר להקליד את הקוד למטה.';
const READER_FAILED =
  'לא ניתן לטעון את מנוע הסריקה. אפשר להקליד את הקוד למטה.';

function cameraFailureMessage(error: unknown): string {
  const name = (error as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return CAMERA_DENIED;
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return CAMERA_MISSING;
  return CAMERA_DENIED;
}

function describeResult(result: BarcodeScanResult): { tone: 'done' | 'await' | 'alert'; text: string } {
  switch (result.kind) {
    case 'match':
      return { tone: 'done', text: `הקוד ${result.code} זוהה: ${result.name}. הכמות נשארת להזנה שלך.` };
    case 'ambiguous':
      return {
        tone: 'alert',
        text: `הקוד ${result.code} מופיע ביותר ממוצר אחד בהזמנה הזו (${result.candidates
          .map((candidate) => candidate.name).join(', ')}), ולכן לא ניתן לקבוע איזה מהם הגיע. יש לבחור את השורה ידנית.`,
      };
    case 'none':
      return {
        tone: 'await',
        text: `הקוד ${result.code} אינו מופיע בפריטי ההזמנה הזו. אפשר לבחור את השורה ידנית — לא נבחר דבר עבורך.`,
      };
  }
}

/* ============================ the scanner ============================ */

function ScannerDialog({ entries, onClose, onPick }: {
  entries: readonly BarcodeCatalogueEntry[];
  onClose: () => void;
  onPick: (result: BarcodeScanResult) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const manualId = useId();
  const [camera, setCamera] = useState<CameraState>({ kind: 'starting' });
  const [manual, setManual] = useState('');
  const [result, setResult] = useState<BarcodeScanResult | null>(null);

  const handleCode = useCallback((code: string) => {
    const resolved = matchScannedBarcode(code, entries);
    setResult(resolved);
    onPick(resolved);
  }, [entries, onPick]);

  useEffect(() => {
    let cancelled = false;
    let stopScanner: (() => void) | null = null;
    let stream: MediaStream | null = null;

    (async () => {
      // The permission decision is asked for directly rather than left to the library, so the two
      // failures a person can act on -- "you said no" and "there is no camera" -- arrive as Hebrew
      // sentences instead of a library exception.
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        setCamera({ kind: 'unavailable', message: window.isSecureContext === false ? CAMERA_INSECURE : CAMERA_MISSING });
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      } catch (error) {
        if (!cancelled) setCamera({ kind: 'unavailable', message: cameraFailureMessage(error) });
        return;
      }
      if (cancelled) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      try {
        const { BrowserMultiFormatReader } = await import('@zxing/browser');
        if (cancelled || !videoRef.current) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        const reader = new BrowserMultiFormatReader();
        const controls = await reader.decodeFromStream(stream, videoRef.current, (decoded) => {
          if (!decoded) return;
          handleCode(decoded.getText());
        });
        stopScanner = () => controls.stop();
        if (!cancelled) setCamera({ kind: 'scanning' });
      } catch (error) {
        console.error('[supplyflow] barcode reader failed to start', error);
        for (const track of stream.getTracks()) track.stop();
        if (!cancelled) setCamera({ kind: 'unavailable', message: READER_FAILED });
      }
    })();

    return () => {
      cancelled = true;
      stopScanner?.();
      if (stream) for (const track of stream.getTracks()) track.stop();
    };
  }, [handleCode]);

  const message = result ? describeResult(result) : null;

  return (
    <Modal open onClose={onClose} title="סריקת ברקוד" description="סריקה מזהה את השורה בהזמנה. הכמות תמיד נשארת להזנה ידנית.">
      <div className="space-y-3">
        {camera.kind === 'unavailable'
          ? <Note tone="await" role="status">{camera.message}</Note>
          : (
            <>
              <div className="overflow-hidden rounded-2xl bg-surface-sunken">
                {/* muted + playsInline: iOS refuses to play an inline camera preview without both. */}
                <video ref={videoRef} className="block w-full" muted playsInline aria-label="תצוגת מצלמה לסריקת ברקוד" />
              </div>
              <p className="text-xs text-ink-muted" role="status">
                {camera.kind === 'starting' ? 'מפעיל את המצלמה…' : 'כוון את המצלמה אל הברקוד על האריזה.'}
              </p>
            </>
          )}

        {message && <Note tone={message.tone} role="status">{message.text}</Note>}

        <form className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => { event.preventDefault(); if (manual.trim()) handleCode(manual); }}>
          <div className="min-w-40 flex-1">
            <label className="label" htmlFor={manualId}>הזנת קוד ידנית</label>
            <input id={manualId} className="input num min-h-11" inputMode="numeric" autoComplete="off"
              value={manual} onChange={(event) => setManual(event.target.value)} />
          </div>
          <button type="submit" className="btn-secondary min-h-11" disabled={!manual.trim()}>בדיקת הקוד</button>
        </form>

        <div className="flex justify-end">
          {/* Named apart from the Modal's own close control: two buttons answering to "סגירה" in one
              dialog give a screen-reader user two identical choices with different behaviour. */}
          <button type="button" className="btn-secondary min-h-11" onClick={onClose}>סיום סריקה</button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The flag boundary.
 *
 * With the flag off — including "not loaded yet" and "the resolver failed", both of which read as
 * off — this returns `null`: no button, no dialog, no `@zxing` chunk requested.
 */
export default function BarcodeScanControl({ entries, onPick }: {
  entries: readonly BarcodeCatalogueEntry[];
  onPick: (result: BarcodeScanResult) => void;
}) {
  const { isEnabled } = useFeatureFlags();
  const [open, setOpen] = useState(false);
  if (!isEnabled('receiving.barcode')) return null;
  return (
    <>
      <button type="button" className="btn-secondary min-h-11" onClick={() => setOpen(true)}>
        <ScanLine size={ICON.sm} /> סריקת ברקוד
      </button>
      {open && <ScannerDialog entries={entries} onClose={() => setOpen(false)} onPick={onPick} />}
    </>
  );
}
