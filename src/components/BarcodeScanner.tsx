import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ScanLine } from 'lucide-react';
import { useFeatureFlags } from '../lib/flags';
import { matchDeliveryLineProduct, type DeliveryNoteLine } from './document-review/model';
import { ICON, Modal, Note } from './ui';
import { useT } from '../lib/i18n/LocaleProvider';
import type { TKey } from '../lib/i18n/t';

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
  | { kind: 'unavailable'; code: CameraFailureCode };

type CameraFailureCode = 'denied' | 'missing' | 'insecure' | 'reader_failed';
const CAMERA_FAILURE_KEY: Readonly<Record<CameraFailureCode, TKey>> = {
  denied: 'barcodeScanner.cameraDenied',
  missing: 'barcodeScanner.cameraMissing',
  insecure: 'barcodeScanner.cameraInsecure',
  reader_failed: 'barcodeScanner.readerFailed',
};

function cameraFailureCode(error: unknown): CameraFailureCode {
  const name = (error as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'missing';
  return 'denied';
}

function describeResult(result: BarcodeScanResult): {
  tone: 'done' | 'await' | 'alert';
  key: TKey;
  vars: Record<string, string | number>;
} {
  switch (result.kind) {
    case 'match':
      return {
        tone: 'done',
        key: 'barcodeScanner.resultMatch',
        vars: { code: result.code, name: result.name },
      };
    case 'ambiguous':
      return {
        tone: 'alert',
        key: 'barcodeScanner.resultAmbiguous',
        vars: {
          code: result.code,
          candidates: result.candidates.map((candidate) => candidate.name).join(', '),
        },
      };
    case 'none':
      return {
        tone: 'await',
        key: 'barcodeScanner.resultNone',
        vars: { code: result.code },
      };
  }
}

/* ============================ the scanner ============================ */

function ScannerDialog({ entries, onClose, onPick }: {
  entries: readonly BarcodeCatalogueEntry[];
  onClose: () => void;
  onPick: (result: BarcodeScanResult) => void;
}) {
  const { t } = useT();
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
      // failures a person can act on -- "you said no" and "there is no camera" -- arrive as
      // product codes resolved in the reader language instead of a library exception.
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        setCamera({ kind: 'unavailable', code: window.isSecureContext === false ? 'insecure' : 'missing' });
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      } catch (error) {
        if (!cancelled) setCamera({ kind: 'unavailable', code: cameraFailureCode(error) });
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
        if (!cancelled) setCamera({ kind: 'unavailable', code: 'reader_failed' });
      }
    })();

    return () => {
      cancelled = true;
      stopScanner?.();
      if (stream) for (const track of stream.getTracks()) track.stop();
    };
  }, [handleCode]);

  const resultDescription = result ? describeResult(result) : null;

  return (
    <Modal open onClose={onClose} title={t('barcodeScanner.title')} description={t('barcodeScanner.description')}>
      <div className="space-y-3">
        {camera.kind === 'unavailable'
          ? <Note tone="await" role="status">{t(CAMERA_FAILURE_KEY[camera.code])}</Note>
          : (
            <>
              <div className="overflow-hidden rounded-2xl bg-surface-sunken">
                {/* muted + playsInline: iOS refuses to play an inline camera preview without both. */}
                <video ref={videoRef} className="block w-full" muted playsInline aria-label={t('barcodeScanner.aria_label')} />
              </div>
              <p className="text-xs text-ink-muted" role="status">
                {camera.kind === 'starting' ? t('barcodeScanner.text') : t('barcodeScanner.text_2')}
              </p>
            </>
          )}

        {resultDescription && <Note tone={resultDescription.tone} role="status">
          {t(resultDescription.key, resultDescription.vars)}
        </Note>}

        <form className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => { event.preventDefault(); if (manual.trim()) handleCode(manual); }}>
          <div className="min-w-40 flex-1">
            <label className="label" htmlFor={manualId}>{t('barcodeScanner.text_3')}</label>
            <input id={manualId} className="input num min-h-11" inputMode="numeric" autoComplete="off"
              value={manual} onChange={(event) => setManual(event.target.value)} />
          </div>
          <button type="submit" className="btn-secondary min-h-11" disabled={!manual.trim()}>{t('barcodeScanner.trim')}</button>
        </form>

        <div className="flex justify-end">
          {/* Named apart from the Modal's own close control: two buttons answering to "סגירה" in one
              dialog give a screen-reader user two identical choices with different behaviour. */}
          <button type="button" className="btn-secondary min-h-11" onClick={onClose}>{t('barcodeScanner.text_4')}</button>
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
  const { t } = useT();
  const { isEnabled } = useFeatureFlags();
  const [open, setOpen] = useState(false);
  if (!isEnabled('receiving.barcode')) return null;
  return (
    <>
      <button type="button" className="btn-secondary min-h-11" onClick={() => setOpen(true)}>
        <ScanLine size={ICON.sm} /> {t('barcodeScanner.openScanner')}
      </button>
      {open && <ScannerDialog entries={entries} onClose={() => setOpen(false)} onPick={onPick} />}
    </>
  );
}
