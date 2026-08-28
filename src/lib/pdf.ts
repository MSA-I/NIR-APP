import { safeFileName } from './workbook';

/**
 * The product's PDF generator.
 *
 * ─── WHY THE BROWSER LAYS THE PAGE OUT, AND NOT A PDF LIBRARY ────────────────────────────────
 * Every JavaScript PDF engine available in August 2026 gets Hebrew wrong, and the reason is the
 * same in each: PDFKit, jsPDF and pdfmake write glyphs at coordinates, and none of them implements
 * the Unicode bidirectional algorithm. jsPDF's `setR2L` reverses a run rather than resolving one,
 * so it renders a Hebrew-only sentence acceptably and mangles the moment a number, a currency sign
 * or a Latin SKU appears inside it — which is every row of every table in this product.
 * `@react-pdf/renderer` has carried the same open defect since 2019; the community patches that
 * exist target Arabic shaping. pdfmake's own issue tracker carries "Hebrew renders left to right,
 * words reversed" unresolved.
 *
 * A browser, meanwhile, implements bidi correctly and is already sitting here rendering the same
 * table on screen. So the layout engine is the one we already trust: `html2canvas-pro` rasterises
 * the print area the screen has already laid out — the identical reasoning `src/lib/orderImage.ts`
 * used to build the WhatsApp order image, and `-pro` for the identical reason (the original throws
 * on the oklch colours Tailwind v4 emits). jsPDF is then only a container: pages, an image per
 * page, and the watermark.
 *
 * THE COST IS STATED PLAINLY: text in these PDFs is not selectable or searchable. It is a picture
 * of a correctly typeset page. The accountant's machine-readable artefact is the .xlsx, which is
 * where copying figures belongs; the PDF is the human-readable one. If selectable text is ever
 * required, the only honest route is rendering this same HTML in a headless browser server-side —
 * not a JS PDF engine, which would trade selectable text for wrong text.
 */

const A4 = { width: 210, height: 297 } as const;
const MARGIN = 10;

/**
 * Print-only blocks are `display: none` on screen, so html2canvas would capture a page missing its
 * own heading and logo. The class flips `.print-only` on for the duration of the capture; the
 * matching rule lives in `src/index.css` beside the `@media print` block, so the two definitions
 * of "this belongs on paper" sit together.
 */
const CAPTURE_CLASS = 'pdf-capture';

export interface PdfOptions {
  /** The subtree to render — the same `.print-area` the print stylesheet targets. */
  element: HTMLElement;
  fileName: string;
  /**
   * Stamp the InPlace mark across every page. Driven by the `exports.unbranded_pdf` entitlement:
   * a plan that does not grant it exports branded. Enforced in the browser, which is the honest
   * limit — see `usePdfWatermark`.
   */
  watermark: boolean;
  /** Landscape for the wide accountant grids; portrait for order sheets and invoices. */
  orientation?: 'portrait' | 'landscape';
}

function tokenColor(token: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return value === '' ? undefined : value;
}

/** Rasterise the shipped SVG mark once per export so jsPDF has bitmap bytes to place. */
async function watermarkImage(height: number): Promise<HTMLCanvasElement | null> {
  const image = new Image();
  image.src = '/brand/inplace-symbol.svg';
  try {
    await image.decode();
  } catch {
    // A missing or unreadable mark must not cost the user their document. The page still prints;
    // it simply prints unstamped, and that failure is visible rather than silent in the console.
    console.error('[pdf] watermark mark could not be decoded');
    return null;
  }
  const canvas = document.createElement('canvas');
  const ratio = image.naturalWidth / image.naturalHeight || 1;
  canvas.height = height;
  canvas.width = Math.round(height * ratio);
  const context = canvas.getContext('2d');
  if (context === null) return null;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Cut the tall page canvas into one canvas per printed page.
 *
 * The alternative — placing the whole image once per page at a negative offset — relies on the
 * page boundary clipping it, which jsPDF does not do: every page ends up carrying the entire
 * document and the file grows with the square of its length.
 */
/**
 * Move a page break UP to the nearest blank scanline, so a table row is not cut in half.
 *
 * Measured on the first generated accountant report: the break landed inside an invoice row, and
 * half a row of figures at the foot of a page is the kind of defect that makes a document look
 * untrustworthy even when every number in it is right.
 *
 * The heuristic is deliberately small — it looks for a row of pixels that is uniform in colour,
 * which is what the gap between two table rows is — and it gives up after `MAX_BACKTRACK` of the
 * page, because a dense table legitimately has no blank line and a full page beats a short one.
 */
const MAX_BACKTRACK = 0.18;
const SAMPLE_STEP = 8;

function isBlankRow(pixels: Uint8ClampedArray, width: number, row: number): boolean {
  const base = row * width * 4;
  const [r, g, b] = [pixels[base], pixels[base + 1], pixels[base + 2]];
  for (let x = SAMPLE_STEP; x < width; x += SAMPLE_STEP) {
    const at = base + x * 4;
    if (pixels[at] !== r || pixels[at + 1] !== g || pixels[at + 2] !== b) return false;
  }
  return true;
}

function pageSlices(source: HTMLCanvasElement, sliceHeight: number): HTMLCanvasElement[] {
  const reader = source.getContext('2d', { willReadFrequently: true });
  const pixels = reader?.getImageData(0, 0, source.width, source.height).data ?? null;
  const backtrack = Math.floor(sliceHeight * MAX_BACKTRACK);

  const slices: HTMLCanvasElement[] = [];
  let top = 0;
  while (top < source.height) {
    let height = Math.min(sliceHeight, source.height - top);
    if (pixels && top + height < source.height) {
      for (let candidate = height; candidate > height - backtrack; candidate -= 1) {
        if (isBlankRow(pixels, source.width, top + candidate)) { height = candidate; break; }
      }
    }
    const slice = document.createElement('canvas');
    slice.width = source.width;
    slice.height = height;
    const context = slice.getContext('2d');
    if (context === null) return slices;
    context.drawImage(source, 0, top, source.width, height, 0, 0, source.width, height);
    slices.push(slice);
    top += height;
  }
  return slices;
}

export async function downloadElementPdf(options: PdfOptions): Promise<void> {
  const { element, watermark, orientation = 'portrait' } = options;
  const [{ default: html2canvas }, { jsPDF, GState }] = await Promise.all([
    import('html2canvas-pro'),
    import('jspdf'),
  ]);

  const root = document.documentElement;
  root.classList.add(CAPTURE_CLASS);
  let source: HTMLCanvasElement;
  try {
    // The organisation's logo lives in Supabase Storage, a DIFFERENT ORIGIN from the app, and it
    // sits in a block that is `display: none` until the line above. Both facts have to be handled
    // or the logo is quietly missing from the file: `useCORS` lets the canvas read the image at
    // all, and waiting for every image to decode stops the capture racing a fetch that only
    // started when the block became visible. Measured — the first generated report had no logo.
    await Promise.all([...element.querySelectorAll('img')].map((image) => image.decode().catch(() => {})));
    source = await html2canvas(element, {
      // 2× so a 9pt table stays legible when the page is zoomed; beyond that the file grows
      // faster than the reading improves.
      scale: 2,
      backgroundColor: tokenColor('--color-surface') ?? null,
      useCORS: true,
      imageTimeout: 15_000,
      logging: false,
    });
  } finally {
    root.classList.remove(CAPTURE_CLASS);
  }

  const page = orientation === 'landscape'
    ? { width: A4.height, height: A4.width }
    : { width: A4.width, height: A4.height };
  const contentWidth = page.width - MARGIN * 2;
  const contentHeight = page.height - MARGIN * 2;
  // How many source pixels fit in one printed page, at the scale the width imposes.
  const sliceHeight = Math.max(1, Math.floor((contentHeight / contentWidth) * source.width));

  const pdf = new jsPDF({ orientation, unit: 'mm', format: 'a4', compress: true });
  const mark = watermark ? await watermarkImage(512) : null;

  const slices = pageSlices(source, sliceHeight);
  slices.forEach((slice, index) => {
    if (index > 0) pdf.addPage();
    pdf.addImage(
      slice.toDataURL('image/png'),
      'PNG',
      MARGIN,
      MARGIN,
      contentWidth,
      (slice.height / slice.width) * contentWidth,
      undefined,
      'FAST',
    );
    // Page numbers, when there is more than one page. Digits and a slash only: jsPDF's built-in
    // fonts carry no Hebrew glyphs, and a page number does not need words.
    if (slices.length > 1) {
      pdf.setFontSize(8);
      pdf.setTextColor(120);
      pdf.text(`${index + 1} / ${slices.length}`, page.width / 2, page.height - 4, { align: 'center' });
    }
    if (mark === null) return;
    // Behind nothing and in front of everything: the stamp goes on last so it is not hidden by a
    // filled table cell, and at 8% so it never competes with a figure the reader has to trust.
    const markWidth = contentWidth * 0.45;
    const markHeight = (mark.height / mark.width) * markWidth;
    pdf.saveGraphicsState();
    pdf.setGState(new GState({ opacity: 0.08 }));
    pdf.addImage(
      mark.toDataURL('image/png'),
      'PNG',
      (page.width - markWidth) / 2,
      (page.height - markHeight) / 2,
      markWidth,
      markHeight,
    );
    pdf.restoreGraphicsState();
  });

  const name = safeFileName(options.fileName, 'inplace-document.pdf');
  pdf.save(name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`);
}
