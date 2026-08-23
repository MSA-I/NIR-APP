import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BLUR_VARIANCE_THRESHOLD,
  DARK_LUMA_THRESHOLD,
  MAX_METRIC_SAMPLE_PIXELS,
  findWeakCaptures,
  isMeasurablePhoto,
  measureImageQuality,
  measureImageQualityOutcome,
  measureLumaMetrics,
  metricSampleSize,
  qualityVerdict,
  weakCaptureHint,
  weakCaptureRetryLabel,
  weakCaptureTitle,
} from './imageQuality';

/* ---------- synthetic pixels with known properties ---------- */

/** Crisp black-on-white text-like ruling: high Laplacian variance, high luma. */
function sharpDocument(width = 64, height = 64, ink = 0, paper = 255) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = y % 4 === 0 || x % 7 === 0 ? ink : paper;
      const p = (y * width + x) * 4;
      rgba[p] = value; rgba[p + 1] = value; rgba[p + 2] = value; rgba[p + 3] = 255;
    }
  }
  return { rgba, width, height };
}

/** A flat field: zero Laplacian everywhere, luma exactly `level`. */
function flat(level: number, width = 32, height = 32) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < rgba.length; p += 4) {
    rgba[p] = level; rgba[p + 1] = level; rgba[p + 2] = level; rgba[p + 3] = 255;
  }
  return { rgba, width, height };
}

function scaled(source: ReturnType<typeof sharpDocument>, alpha: number) {
  const rgba = new Uint8ClampedArray(source.rgba.length);
  for (let p = 0; p < rgba.length; p += 4) {
    rgba[p] = Math.round(source.rgba[p] * alpha);
    rgba[p + 1] = Math.round(source.rgba[p + 1] * alpha);
    rgba[p + 2] = Math.round(source.rgba[p + 2] * alpha);
    rgba[p + 3] = 255;
  }
  return { ...source, rgba };
}

describe('measureLumaMetrics', () => {
  it('reports zero variance and the exact luma of a flat field', () => {
    const { rgba, width, height } = flat(120);
    const metrics = measureLumaMetrics(rgba, width, height);
    expect(metrics.laplacianVariance).toBe(0);
    expect(metrics.meanLuma).toBeCloseTo(120, 5);
  });

  it('uses Rec.601 weights, so a pure green field is brighter than a pure blue one', () => {
    const green = new Uint8ClampedArray([0, 255, 0, 255]);
    const blue = new Uint8ClampedArray([0, 0, 255, 255]);
    expect(measureLumaMetrics(green, 1, 1).meanLuma).toBeCloseTo(150, 0);
    expect(measureLumaMetrics(blue, 1, 1).meanLuma).toBeCloseTo(29, 0);
  });

  it('scales the variance by alpha squared when the image is darkened — the reason dark wins', () => {
    const source = sharpDocument();
    const bright = measureLumaMetrics(source.rgba, source.width, source.height);
    const dim = scaled(source, 0.35);
    const dark = measureLumaMetrics(dim.rgba, dim.width, dim.height);
    expect(dark.laplacianVariance / bright.laplacianVariance).toBeCloseTo(0.35 * 0.35, 2);
    expect(dark.meanLuma / bright.meanLuma).toBeCloseTo(0.35, 2);
  });
});

describe('metricSampleSize', () => {
  it('leaves a small source alone', () => {
    expect(metricSampleSize(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('caps a phone capture at about one megapixel while keeping its aspect ratio', () => {
    const sample = metricSampleSize(4032, 3024);
    expect(sample.width * sample.height).toBeLessThanOrEqual(MAX_METRIC_SAMPLE_PIXELS * 1.001);
    expect(sample.width * sample.height).toBeGreaterThan(MAX_METRIC_SAMPLE_PIXELS * 0.99);
    expect(sample.width / sample.height).toBeCloseTo(4032 / 3024, 2);
  });
});

describe('qualityVerdict', () => {
  it('passes a sharp, well-lit capture', () => {
    expect(qualityVerdict({ laplacianVariance: 465, meanLuma: 129 })).toBe('ok');
  });

  it('flags a capture below the measured blur threshold', () => {
    expect(qualityVerdict({ laplacianVariance: BLUR_VARIANCE_THRESHOLD - 1, meanLuma: 170 })).toBe('blurry');
  });

  it('flags a capture below the measured darkness threshold', () => {
    expect(qualityVerdict({ laplacianVariance: 800, meanLuma: DARK_LUMA_THRESHOLD - 1 })).toBe('dark');
  });

  it('says dark, not blurry, when both trip — low light depresses the sharpness number', () => {
    // 09-delivery-note-invoiceonline.jpg darkened by 0.35: 464.8 -> 58.1, luma 129.0 -> 45.1.
    // Ranking by relative margin picked "blurry" and sent the user to steady the phone.
    expect(qualityVerdict({ laplacianVariance: 58.1, meanLuma: 45.1 })).toBe('dark');
  });

  it('holds exactly at the thresholds', () => {
    expect(qualityVerdict({ laplacianVariance: BLUR_VARIANCE_THRESHOLD, meanLuma: DARK_LUMA_THRESHOLD })).toBe('ok');
  });
});

/* ---------- the browser entry point ---------- */

const imageFile = (name = 'capture.jpg', type = 'image/jpeg') =>
  new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], name, { type });

function stubDecode(source: { rgba: Uint8ClampedArray; width: number; height: number }) {
  const drawn: { width: number; height: number }[] = [];
  const close = vi.fn();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: source.width, height: source.height, close })));
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(readonly width: number, readonly height: number) {}
    getContext() {
      return {
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low',
        drawImage: (_bitmap: unknown, _x: number, _y: number, width: number, height: number) => {
          drawn.push({ width, height });
        },
        getImageData: () => ({ data: source.rgba }),
      };
    }
  });
  return { drawn, close };
}

afterEach(() => vi.unstubAllGlobals());

describe('isMeasurablePhoto', () => {
  it.each([
    ['image/jpeg', 'invoice.jpg', true],
    ['image/png', 'invoice.png', true],
    ['image/heic', 'IMG_0042.heic', true],
    ['application/pdf', 'invoice.pdf', false],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'prices.xlsx', false],
    ['image/svg+xml', 'logo.svg', false],
    ['', 'invoice.pdf', false],
    ['', 'photo.JPEG', true],
    ['', 'mystery', false],
  ])('%s / %s -> %s', (type, name, expected) => {
    expect(isMeasurablePhoto(new File([''], name, { type }))).toBe(expected);
  });
});

describe('measureImageQuality', () => {
  it('returns no verdict for a PDF without ever decoding it', async () => {
    const decode = vi.fn();
    vi.stubGlobal('createImageBitmap', decode);
    await expect(measureImageQuality(new File(['%PDF'], 'invoice.pdf', { type: 'application/pdf' })))
      .resolves.toBeNull();
    expect(decode).not.toHaveBeenCalled();
  });

  it.each([
    ['spreadsheet', 'prices.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['word document', 'terms.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['unknown type', 'notes', ''],
  ])('returns no verdict for a %s', async (_label, name, type) => {
    await expect(measureImageQuality(new File(['x'], name, { type }))).resolves.toBeNull();
  });

  it('measures a sharp, well-lit photo as ok and reports the sampled size', async () => {
    const source = sharpDocument();
    stubDecode(source);
    const measurement = await measureImageQuality(imageFile());
    expect(measurement?.verdict).toBe('ok');
    expect(measurement?.laplacianVariance).toBeGreaterThan(BLUR_VARIANCE_THRESHOLD);
    expect(measurement?.meanLuma).toBeGreaterThan(DARK_LUMA_THRESHOLD);
    expect(measurement?.sampledPixels).toBe(source.width * source.height);
  });

  it('measures a flat, featureless photo as blurry', async () => {
    stubDecode(flat(200));
    await expect(measureImageQuality(imageFile())).resolves.toMatchObject({ verdict: 'blurry' });
  });

  it('measures an underexposed photo as dark', async () => {
    stubDecode(scaled(sharpDocument(), 0.2));
    await expect(measureImageQuality(imageFile())).resolves.toMatchObject({ verdict: 'dark' });
  });

  it('downscales an oversized capture to the ~1 MP metric sample', async () => {
    // The stub hands back a small buffer regardless; what is pinned here is the requested draw size.
    const { drawn } = stubDecode({ ...sharpDocument(), width: 4032, height: 3024 });
    await measureImageQuality(imageFile());
    expect(drawn).toHaveLength(1);
    expect(drawn[0].width * drawn[0].height).toBeLessThanOrEqual(MAX_METRIC_SAMPLE_PIXELS * 1.001);
  });

  it('returns no verdict when the decoder throws — an unreadable file still uploads', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('unsupported HEIC'); }));
    await expect(measureImageQuality(imageFile('IMG_0042.heic', 'image/heic'))).resolves.toBeNull();
  });

  it('routes unsupported HEIC to bounded server preprocessing without replacing its bytes', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('unsupported HEIC'); }));
    const file = imageFile('IMG_0042.heic', 'image/heic');
    const before = new Uint8Array(await file.arrayBuffer());

    await expect(measureImageQualityOutcome(file)).resolves.toEqual({
      kind: 'server_required',
      file,
      reason: 'client_decode_unsupported',
    });
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(before);
  });

  it('keeps an ordinary JPEG decoder failure unavailable rather than claiming HEIC routing', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('decode failed'); }));
    await expect(measureImageQualityOutcome(imageFile())).resolves.toMatchObject({
      kind: 'unavailable',
    });
  });

  it('returns no verdict when the canvas throws mid-measurement', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 32, height: 32, close: vi.fn() })));
    vi.stubGlobal('OffscreenCanvas', class {
      getContext() { throw new Error('context lost'); }
    });
    await expect(measureImageQuality(imageFile())).resolves.toBeNull();
  });

  it('returns no verdict when the environment cannot decode images at all', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    await expect(measureImageQuality(imageFile())).resolves.toBeNull();
  });

  it('refuses to decode an absurdly large source rather than stalling the picker', async () => {
    const { drawn } = stubDecode({ ...flat(200), width: 30_000, height: 30_000 });
    await expect(measureImageQuality(imageFile())).resolves.toBeNull();
    expect(drawn).toHaveLength(0);
  });

  it('closes the decoded bitmap even when the measurement succeeds', async () => {
    const { close } = stubDecode(sharpDocument());
    await measureImageQuality(imageFile());
    expect(close).toHaveBeenCalledTimes(1);
  });

  /**
   * The load-bearing invariant. `FileUpload.tsx` uploads the exact File object because canvas
   * conversion discards source pixels, orientation and metadata that OCR and the long-term
   * document evidence both need. Measuring on a canvas is fine; handing tus a different object,
   * or a File whose bytes moved, is not.
   */
  it('leaves the File object and its bytes untouched', async () => {
    stubDecode(sharpDocument());
    const bytes = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    const file = new File([bytes], 'invoice.jpg', { type: 'image/jpeg', lastModified: 1_700_000_000_000 });
    const before = new Uint8Array(await file.arrayBuffer());

    const measurement = await measureImageQuality(file);

    expect(measurement).not.toBeNull();
    const after = new Uint8Array(await file.arrayBuffer());
    expect(after).toEqual(before);
    expect(after).toEqual(bytes);
    expect(file.size).toBe(bytes.byteLength);
    expect(file.name).toBe('invoice.jpg');
    expect(file.type).toBe('image/jpeg');
    expect(file.lastModified).toBe(1_700_000_000_000);
  });
});

describe('findWeakCaptures', () => {
  it('reports only the weak files, and hands back the same File objects', async () => {
    const good = imageFile('good.jpg');
    const bad = imageFile('bad.jpg');
    const pdf = new File(['%PDF'], 'invoice.pdf', { type: 'application/pdf' });
    const sharp = sharpDocument();
    const featureless = flat(200);
    vi.stubGlobal('createImageBitmap', vi.fn(async (file: File) => ({
      width: file.name === 'good.jpg' ? sharp.width : featureless.width,
      height: file.name === 'good.jpg' ? sharp.height : featureless.height,
      close: vi.fn(),
      __source: file.name,
    })));
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(readonly width: number, readonly height: number) {}
      getContext() {
        return {
          imageSmoothingEnabled: false,
          imageSmoothingQuality: 'low',
          drawImage: (bitmap: { __source: string }) => { this.source = bitmap.__source; },
          getImageData: () => ({ data: this.source === 'good.jpg' ? sharp.rgba : featureless.rgba }),
        };
      }
      source = '';
    });

    const weak = await findWeakCaptures([good, bad, pdf]);

    expect(weak).toHaveLength(1);
    expect(weak[0].file).toBe(bad);
    expect(weak[0].verdict).toBe('blurry');
  });

  it('reports nothing for an empty pick', async () => {
    await expect(findWeakCaptures([])).resolves.toEqual([]);
  });
});

describe('Hebrew copy', () => {
  const weak = (verdict: 'blurry' | 'dark', name = 'a.jpg') => ({
    file: new File([''], name, { type: 'image/jpeg' }),
    verdict,
    measurement: { verdict, laplacianVariance: 1, meanLuma: 1, sampledPixels: 1 },
  } as const);

  it('names the single failure without numbers or algorithm words', () => {
    expect(weakCaptureTitle([weak('blurry')])).toBe('התמונה יצאה מטושטשת');
    expect(weakCaptureTitle([weak('dark')])).toBe('התמונה חשוכה מדי');
    expect(weakCaptureHint([weak('blurry')], 'camera')).toBe('כדאי לייצב את הטלפון ולצלם שוב.');
    expect(weakCaptureHint([weak('dark')], 'camera')).toBe('כדאי להוסיף אור ולצלם שוב.');
  });

  it('speaks about choosing, not shooting, when the file came from the picker', () => {
    expect(weakCaptureHint([weak('blurry')], 'picker')).toBe('כדאי לבחור קובץ ברור יותר.');
    expect(weakCaptureHint([weak('dark')], 'picker')).toBe('כדאי לבחור קובץ בהיר יותר.');
  });

  it('stays in the plural for a batch and does not name a cause it cannot name', () => {
    expect(weakCaptureTitle([weak('blurry', 'a.jpg'), weak('dark', 'b.jpg')])).toBe('חלק מהתמונות לא יצאו טוב');
    expect(weakCaptureHint([weak('blurry', 'a.jpg'), weak('blurry', 'b.jpg')], 'camera'))
      .toBe('כדאי לייצב את הטלפון ולצלם אותן שוב.');
    expect(weakCaptureHint([weak('blurry', 'a.jpg'), weak('dark', 'b.jpg')], 'camera')).toBe('כדאי לצלם אותן שוב.');
  });

  it('offers the action that matches where the file came from', () => {
    expect(weakCaptureRetryLabel('camera')).toBe('צילום מחדש');
    expect(weakCaptureRetryLabel('picker')).toBe('בחירת קובץ אחר');
  });

  it('never mentions the measurement itself', () => {
    const forbidden = /laplacian|variance|luma|\d/i;
    const samples = [
      weakCaptureTitle([weak('blurry')]),
      weakCaptureTitle([weak('dark')]),
      weakCaptureTitle([weak('blurry', 'a'), weak('dark', 'b')]),
      weakCaptureHint([weak('blurry')], 'camera'),
      weakCaptureHint([weak('dark')], 'camera'),
      weakCaptureHint([weak('blurry')], 'picker'),
      weakCaptureRetryLabel('camera'),
      weakCaptureRetryLabel('picker'),
    ];
    for (const sample of samples) expect(sample).not.toMatch(forbidden);
  });
});
