/**
 * Pre-upload capture quality — "this photo will not read well" said before the bytes leave the
 * phone, not after a paid OCR call comes back empty.
 *
 * The two thresholds below are measured, not chosen. They come from running the live worker's
 * own metric (`worker/ocr/src/scanning.py`, the Laplacian variance of the grayscale image before
 * any denoise/CLAHE work) over the owner's real corpus: 17 genuine documents — 10 phone captures
 * plus 7 from the 20260808 calibration corpus — and 20 deliberately degraded variants.
 *
 *   Laplacian variance   genuine 345 … 8717   ·  9x9 blur 59.9 … 75.6  ·  21x21 blur 6.0 … 6.7
 *   mean luma            genuine 137.4 … 244.8 ·  darkened (alpha 0.35) 58.5 … 65.0
 *
 * The gap between 75.6 and 345 is a factor of four and a half, so 130 sits in open space rather
 * than on the edge of either population. Same for luma: 85 sits between 65.0 and 137.4.
 *
 * There is deliberately **no overexposure gate**. It was measured and rejected: a white receipt
 * photographed on a white desk legitimately clips 85% of its histogram (`17/18/19-credit-note-
 * armonrama-pad*.jpg`), while an artificially brightened photo clips 52–61%. The populations
 * overlap the wrong way round, so no honest threshold exists. Do not invent one.
 *
 * Two rules govern everything here:
 *
 *  1. **The measurement never changes what is uploaded.** It decodes into a canvas and reads
 *     pixels back; the `File` handed to tus stays the same object, byte-identical. Canvas
 *     conversion discards source pixels, orientation and metadata that OCR and the long-term
 *     document evidence both need — see the note at `FileUpload.tsx`'s tus call.
 *  2. **A quality check must never be the reason an upload fails.** Every path that cannot
 *     produce a confident number returns `null`, which reads as "no verdict" and lets the
 *     upload proceed untouched. Non-images (PDF, Office, unknown) return `null` immediately —
 *     they are not photographs.
 */

/** Mirrors MAX_METRIC_SAMPLE_PIXELS in `worker/ocr/src/scanning.py:30`. */
export const MAX_METRIC_SAMPLE_PIXELS = 1_000_000;

/** Below this Laplacian variance the capture is blurred beyond the corpus's worst genuine document. */
export const BLUR_VARIANCE_THRESHOLD = 130;

/** Below this mean luma the capture is darker than the corpus's darkest genuine document. */
export const DARK_LUMA_THRESHOLD = 85;

/** A source larger than this is not measured at all — decoding it is the expensive part. */
const MAX_SOURCE_PIXELS = 64_000_000;

/** One decode may not hold the picker open longer than this. */
const DECODE_BUDGET_MS = 3_000;

/** A whole batch may not hold it open longer than this; later files simply get no verdict. */
const BATCH_BUDGET_MS = 8_000;

export type ImageQualityVerdict = 'ok' | 'blurry' | 'dark';

export interface ImageQualityMeasurement {
  verdict: ImageQualityVerdict;
  /** Variance of the 3x3 Laplacian over the sampled grayscale. Lower = blurrier. */
  laplacianVariance: number;
  /** Mean Rec.601 luma, 0–255. Lower = darker. */
  meanLuma: number;
  /** Pixels actually measured, after the ~1 MP downscale. */
  sampledPixels: number;
}

export interface LumaMetrics {
  laplacianVariance: number;
  meanLuma: number;
}

/** A picked file the measurement is not confident about. `verdict` is never `'ok'`. */
export interface WeakCapture {
  file: File;
  verdict: Exclude<ImageQualityVerdict, 'ok'>;
  measurement: ImageQualityMeasurement;
}

/* ---------- the pure core (shared with the calibration harness and the unit tests) ---------- */

/**
 * Target sample size for a source of `width` x `height`, capped at ~1 MP by area — the same
 * `sqrt(cap / pixels)` scale `_metric_sample` uses, so the numbers stay comparable to the
 * worker's own diagnostics regardless of phone resolution.
 */
export function metricSampleSize(width: number, height: number): { width: number; height: number } {
  const pixels = width * height;
  if (pixels <= MAX_METRIC_SAMPLE_PIXELS) return { width, height };
  const scale = Math.sqrt(MAX_METRIC_SAMPLE_PIXELS / pixels);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Rec.601 luma, the same weighting OpenCV's `COLOR_BGR2GRAY` applies. */
function toLuma(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array {
  const luma = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < luma.length; i += 1, p += 4) {
    luma[i] = (rgba[p] * 4899 + rgba[p + 1] * 9617 + rgba[p + 2] * 1868 + 8192) >> 14;
  }
  return luma;
}

/** BORDER_REFLECT_101 — OpenCV's default. Index -1 mirrors to 1, index n to n-2. */
function reflect101(index: number, size: number): number {
  if (size === 1) return 0;
  if (index < 0) return -index;
  if (index >= size) return 2 * size - index - 2;
  return index;
}

/**
 * Variance of the 3x3 Laplacian [[0,1,0],[1,-4,1],[0,1,0]] plus the mean luma, both over the
 * grayscale of the supplied RGBA buffer. This is the whole measurement: everything else in this
 * module exists to feed it pixels or to turn its two numbers into a sentence.
 */
export function measureLumaMetrics(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): LumaMetrics {
  const luma = toLuma(rgba, width, height);
  let lumaSum = 0;
  let laplacianSum = 0;
  let laplacianSquareSum = 0;
  for (let y = 0; y < height; y += 1) {
    const up = reflect101(y - 1, height) * width;
    const down = reflect101(y + 1, height) * width;
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const centre = luma[row + x];
      lumaSum += centre;
      const value = luma[up + x]
        + luma[down + x]
        + luma[row + reflect101(x - 1, width)]
        + luma[row + reflect101(x + 1, width)]
        - 4 * centre;
      laplacianSum += value;
      laplacianSquareSum += value * value;
    }
  }
  const count = width * height;
  const mean = laplacianSum / count;
  return {
    laplacianVariance: Math.max(0, laplacianSquareSum / count - mean * mean),
    meanLuma: lumaSum / count,
  };
}

/**
 * One verdict, never two — telling someone standing at a truck two things at once is telling
 * them nothing.
 *
 * **When both trip, darkness wins, and not as a preference.** Scaling an image's brightness by
 * α scales its Laplacian by α and therefore its variance by α². Measured on the corpus, the
 * darkened variants land at 0.1226–0.1250 of their original variance against a predicted
 * 0.35² = 0.1225: the blur number is not an independent observation on an underexposed frame,
 * it is the darkness restated. Ranking the two by relative margin sent six of seventeen darkened
 * corpus variants — every one of the low-light document scans — to the message "steady the
 * phone" when the fix was to turn on a light. Darkness is the upstream cause; it gets the
 * sentence. A well-lit frame (luma ≥ 85) still reports blur normally, so nothing is masked.
 */
export function qualityVerdict(metrics: LumaMetrics): ImageQualityVerdict {
  if (metrics.meanLuma < DARK_LUMA_THRESHOLD) return 'dark';
  if (metrics.laplacianVariance < BLUR_VARIANCE_THRESHOLD) return 'blurry';
  return 'ok';
}

/* ---------- the browser path ---------- */

const NON_PHOTO_IMAGE_TYPES = new Set(['image/svg+xml']);
const RASTER_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'heic', 'heif',
]);

/** PDFs, spreadsheets and unknown files are not photographs and must pass through untouched. */
export function isMeasurablePhoto(file: File): boolean {
  const mime = file.type.trim().toLowerCase();
  if (mime) return mime.startsWith('image/') && !NON_PHOTO_IMAGE_TYPES.has(mime);
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return RASTER_EXTENSIONS.has(extension);
}

function createSampleCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement | null {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function drawSample(bitmap: ImageBitmap, width: number, height: number): Uint8ClampedArray | null {
  const canvas = createSampleCanvas(width, height);
  if (!canvas) return null;
  const context = canvas.getContext('2d', { willReadFrequently: true }) as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!context) return null;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, width, height);
  return context.getImageData(0, 0, width, height).data;
}

/**
 * Races a decode against the budget. A decode that wins after the race is still closed, so a slow
 * phone leaks neither the bitmap nor the wait.
 */
function withDecodeBudget(pending: Promise<ImageBitmap>, budgetMs: number): Promise<ImageBitmap | null> {
  let settled = false;
  return new Promise<ImageBitmap | null>((resolve) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, budgetMs);
    pending.then(
      (bitmap) => {
        clearTimeout(timer);
        if (settled) { bitmap.close?.(); return; }
        settled = true;
        resolve(bitmap);
      },
      () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve(null);
      },
    );
  });
}

/**
 * Measures one picked file. Returns `null` — "no verdict, upload as usual" — for anything that is
 * not a raster photograph, for a source too large to be worth decoding, when the decode overruns
 * its budget or is unsupported (HEIC on a desktop browser), and for any thrown error at all.
 *
 * The `file` argument is only ever read. Nothing here produces a replacement blob.
 */
export async function measureImageQuality(file: File): Promise<ImageQualityMeasurement | null> {
  if (!isMeasurablePhoto(file)) return null;
  if (typeof createImageBitmap !== 'function') return null;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await withDecodeBudget(createImageBitmap(file), DECODE_BUDGET_MS);
    if (!bitmap) return null;
    const { width, height } = bitmap;
    if (!width || !height || width * height > MAX_SOURCE_PIXELS) return null;
    const sample = metricSampleSize(width, height);
    const rgba = drawSample(bitmap, sample.width, sample.height);
    if (!rgba) return null;
    const metrics = measureLumaMetrics(rgba, sample.width, sample.height);
    if (!Number.isFinite(metrics.laplacianVariance) || !Number.isFinite(metrics.meanLuma)) return null;
    return {
      ...metrics,
      verdict: qualityVerdict(metrics),
      sampledPixels: sample.width * sample.height,
    };
  } catch {
    return null;
  } finally {
    bitmap?.close?.();
  }
}

/**
 * Measures a whole picked batch and reports only the weak ones. Sequential on purpose: one bitmap
 * in memory at a time on a phone. Once the batch budget is spent the remaining files are left
 * unmeasured rather than the picker left hanging — they upload with no verdict, which is the
 * correct failure direction.
 */
export async function findWeakCaptures(files: readonly File[]): Promise<WeakCapture[]> {
  const weak: WeakCapture[] = [];
  const deadline = Date.now() + BATCH_BUDGET_MS;
  for (const file of files) {
    if (Date.now() >= deadline) break;
    const measurement = await measureImageQuality(file);
    if (measurement && measurement.verdict !== 'ok') {
      weak.push({ file, verdict: measurement.verdict, measurement });
    }
  }
  return weak;
}

/* ---------- Hebrew copy ---------- */

/** Camera captures are re-taken; files chosen from storage are re-chosen. */
export type CaptureSource = 'camera' | 'picker';

export const WEAK_CAPTURE_LABEL: Record<Exclude<ImageQualityVerdict, 'ok'>, string> = {
  blurry: 'מטושטשת',
  dark: 'חשוכה',
};

export function weakCaptureTitle(weak: readonly WeakCapture[]): string {
  if (weak.length !== 1) return 'חלק מהתמונות לא יצאו טוב';
  return weak[0].verdict === 'blurry' ? 'התמונה יצאה מטושטשת' : 'התמונה חשוכה מדי';
}

export function weakCaptureHint(weak: readonly WeakCapture[], source: CaptureSource): string {
  const verdicts = new Set(weak.map((item) => item.verdict));
  const only = verdicts.size === 1 ? weak[0]?.verdict : null;
  if (source === 'picker') {
    if (only === 'blurry') return 'כדאי לבחור קובץ ברור יותר.';
    if (only === 'dark') return 'כדאי לבחור קובץ בהיר יותר.';
    return 'כדאי לבחור קבצים אחרים.';
  }
  const again = weak.length === 1 ? 'שוב' : 'אותן שוב';
  if (only === 'blurry') return `כדאי לייצב את הטלפון ולצלם ${again}.`;
  if (only === 'dark') return `כדאי להוסיף אור ולצלם ${again}.`;
  return `כדאי לצלם ${again}.`;
}

export function weakCaptureRetryLabel(source: CaptureSource): string {
  return source === 'camera' ? 'צילום מחדש' : 'בחירת קובץ אחר';
}

export const WEAK_CAPTURE_PROCEED_LABEL = 'העלאה בכל זאת';
