import { downloadBytes, safeFileName } from './workbook';
import { supabase } from './supabase';

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
 * the print areas the screen has already laid out — the identical reasoning `src/lib/orderImage.ts`
 * used to build the WhatsApp order image, and `-pro` for the identical reason (the original throws
 * on the oklch colours Tailwind v4 emits). jsPDF is then only a container: pages, the blocks that
 * land on them, and the stamp.
 *
 * THE COST IS STATED PLAINLY: text in a PDF produced HERE is not selectable or searchable. It is a
 * picture of a correctly typeset page.
 *
 * THAT COST IS WHY THIS IS NO LONGER THE ONLY PRODUCER. `downloadDocumentPdf` at the foot of this
 * file asks the server first (`supabase/functions/render-document` → `worker/render`), where the
 * same Chromium lays out the same print stylesheet and `page.pdf()` emits real text — and where
 * the stamp goes on somewhere the reader cannot reach it. What remains here is the fallback for an
 * environment with no render service deployed, which is a normal state rather than a failure.
 */

const A4 = { width: 210, height: 297 } as const;
const MARGIN = 10;
/** Breathing room between two blocks that share a page. */
const BLOCK_GAP = 4;

/**
 * Print-only blocks are `display: none` on screen, so html2canvas would capture a page missing its
 * own heading and logo. The class flips `.print-only` on for the duration of the capture; the
 * matching rule lives in `src/index.css` beside the `@media print` block, so the two definitions
 * of "this belongs on paper" sit together.
 */
const CAPTURE_CLASS = 'pdf-capture';

export interface PdfOptions {
  /**
   * The subtree(s) to render — the same `.print-area` elements the print stylesheet targets.
   *
   * An ARRAY because a screen is not always one box: the invoice detail carries six separate
   * print areas (the money tiles, the details card, the lines) and no single wrapper around them.
   * Each element is captured on its own and the blocks are then flowed across pages, so a screen
   * built from several cards prints like a document instead of not printing at all.
   */
  element: HTMLElement | readonly HTMLElement[];
  fileName: string;
  /**
   * Stamp the InPlace mark across every page. Driven by the `exports.unbranded_pdf` entitlement,
   * resolved by `exportWatermark()` against the server. Applied in the BROWSER on this path, which
   * makes it branding rather than enforcement — the enforced copy comes from `downloadDocumentPdf`
   * below. DEBT §69.
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

/**
 * Rasterise the shipped SVG mark once per export so jsPDF has bitmap bytes to place.
 *
 * The LOCKUP, not the bare symbol (owner ruling 28.08.2026): a watermark exists to say whose
 * product produced the document, and the symbol alone says that only to someone who already knows
 * it. The lockup carries the name.
 */
async function watermarkImage(height: number): Promise<HTMLCanvasElement | null> {
  const image = new Image();
  image.src = '/brand/inplace-lockup.svg';
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

function crop(source: HTMLCanvasElement, top: number, height: number): HTMLCanvasElement | null {
  const slice = document.createElement('canvas');
  slice.width = source.width;
  slice.height = height;
  const context = slice.getContext('2d');
  if (context === null) return null;
  context.drawImage(source, 0, top, source.width, height, 0, 0, source.width, height);
  return slice;
}

/**
 * Cut a canvas that is taller than one page into one canvas per printed page.
 *
 * The alternative — placing the whole image once per page at a negative offset — relies on the
 * page boundary clipping it, which jsPDF does not do: every page ends up carrying the entire
 * document and the file grows with the square of its length.
 */
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
    const slice = crop(source, top, height);
    if (slice === null) return slices;
    slices.push(slice);
    top += height;
  }
  return slices;
}

export async function downloadElementPdf(options: PdfOptions): Promise<void> {
  const { watermark, orientation = 'portrait' } = options;
  const elements = (Array.isArray(options.element) ? options.element : [options.element])
    .filter((element): element is HTMLElement => element instanceof HTMLElement);
  if (elements.length === 0) return;

  const [{ default: html2canvas }, { jsPDF, GState }] = await Promise.all([
    import('html2canvas-pro'),
    import('jspdf'),
  ]);

  const root = document.documentElement;
  root.classList.add(CAPTURE_CLASS);
  let blocks: HTMLCanvasElement[];
  try {
    // The organisation's logo lives in Supabase Storage, a DIFFERENT ORIGIN from the app, and it
    // sits in a block that is `display: none` until the line above. Both facts have to be handled
    // or the logo is quietly missing from the file: `useCORS` lets the canvas read the image at
    // all, and waiting for every image to decode stops the capture racing a fetch that only
    // started when the block became visible. Measured — the first generated report had no logo.
    await Promise.all(elements.flatMap((element) =>
      [...element.querySelectorAll('img')].map((image) => image.decode().catch(() => {}))));
    blocks = [];
    for (const element of elements) {
      blocks.push(await html2canvas(element, {
        // 2× so a 9pt table stays legible when the page is zoomed; beyond that the file grows
        // faster than the reading improves.
        scale: 2,
        backgroundColor: tokenColor('--color-surface') ?? null,
        useCORS: true,
        imageTimeout: 15_000,
        logging: false,
      }));
    }
  } finally {
    root.classList.remove(CAPTURE_CLASS);
  }

  const page = orientation === 'landscape'
    ? { width: A4.height, height: A4.width }
    : { width: A4.width, height: A4.height };
  const contentWidth = page.width - MARGIN * 2;
  const contentHeight = page.height - MARGIN * 2;

  const pdf = new jsPDF({ orientation, unit: 'mm', format: 'a4', compress: true });
  let cursor = MARGIN;
  let started = false;

  const draw = (canvas: HTMLCanvasElement) => {
    const height = (canvas.height / canvas.width) * contentWidth;
    pdf.addImage(
      canvas.toDataURL('image/png'), 'PNG',
      MARGIN, cursor, contentWidth, height, undefined, 'FAST',
    );
    cursor += height + BLOCK_GAP;
    started = true;
  };
  const newPage = () => { pdf.addPage(); cursor = MARGIN; started = false; };

  for (const block of blocks) {
    const height = (block.height / block.width) * contentWidth;
    if (height <= contentHeight) {
      // A hair of tolerance: `contentHeight` and the summed block heights are floating point, and
      // a block that fits exactly must not be pushed onto a page of its own by a rounding crumb.
      if (started && cursor + height > page.height - MARGIN + 0.01) newPage();
      draw(block);
      continue;
    }
    // Taller than a page on its own: it starts on a fresh page and is sliced across as many as it
    // needs. `sliceHeight` is how many source pixels fit one page at the scale the width imposes.
    if (started) newPage();
    const sliceHeight = Math.max(1, Math.floor((contentHeight / contentWidth) * block.width));
    for (const slice of pageSlices(block, sliceHeight)) {
      if (started) newPage();
      draw(slice);
    }
  }

  /**
   * The stamp and the page numbers go on AFTER the content, in one pass over the finished pages.
   * Drawing them while placing blocks would mean guessing the page count before it exists, and a
   * document that says "1 / 1" on its first of three pages is worse than no numbering at all.
   */
  const total = pdf.getNumberOfPages();
  const mark = watermark ? await watermarkImage(256) : null;
  for (let index = 1; index <= total; index += 1) {
    pdf.setPage(index);
    if (total > 1) {
      // Digits and a slash only: jsPDF's built-in fonts carry no Hebrew glyphs, and a page number
      // does not need words.
      pdf.setFontSize(8);
      pdf.setTextColor(120);
      pdf.text(`${index} / ${total}`, page.width / 2, page.height - 4, { align: 'center' });
    }
    if (mark === null) continue;
    // In front of everything, so a filled table cell cannot hide it, and at 8% so it never
    // competes with a figure the reader has to trust.
    const markWidth = contentWidth * 0.55;
    const markHeight = (mark.height / mark.width) * markWidth;
    pdf.saveGraphicsState();
    pdf.setGState(new GState({ opacity: 0.08 }));
    pdf.addImage(
      mark.toDataURL('image/png'), 'PNG',
      (page.width - markWidth) / 2, (page.height - markHeight) / 2, markWidth, markHeight,
    );
    pdf.restoreGraphicsState();
  }

  const name = safeFileName(options.fileName, 'inplace-document.pdf');
  pdf.save(name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`);
}

export type PdfSource = 'server' | 'browser';

export interface DocumentPdfOptions extends PdfOptions {
  /**
   * The application path the SERVER should render — the same screen the reader is looking at.
   * There is no second template: `@media print` in `src/index.css` decides what belongs on paper,
   * and Chromium applies it. The path must be one the render contract allows.
   */
  path: string;
}

/**
 * Download a document, preferring the file the customer could not have made themselves.
 *
 * TWO PRODUCERS, ONE OF WHICH IS BETTER IN EVERY WAY THAT MATTERS. The server renderer
 * (`supabase/functions/render-document` → `worker/render`) emits REAL TEXT rather than a picture,
 * and stamps where a reader cannot reach — so it answers DEBT §68 and §69 at once. The browser
 * generator below it produces a correct document too, but its text is an image and its watermark
 * is branding.
 *
 * SO THE FALLBACK IS NARROW ON PURPOSE: only `renderer_not_configured` falls through. That state
 * is normal — `worker/render` is deployed by hand onto the VPS, exactly like the OCR worker, and
 * an environment without it must still be able to export. Any OTHER failure is reported: a
 * configured renderer that breaks is a real fault, and quietly downgrading it would hide the one
 * thing this package exists to guarantee.
 */
export async function downloadDocumentPdf(options: DocumentPdfOptions): Promise<PdfSource> {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;

  if (url && anonKey && accessToken) {
    const response = await fetch(`${url}/functions/v1/render-document`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'apikey': anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        path: options.path,
        orientation: options.orientation ?? 'portrait',
        fileName: options.fileName,
        // `watermark` is deliberately NOT sent. The server resolves the entitlement itself; a
        // client that could ask for an unstamped document is the tampering this package prevents.
      }),
    });

    if (response.ok) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      downloadBytes(bytes, safeFileName(options.fileName, 'inplace-document.pdf'), 'application/pdf');
      return 'server';
    }
    if (response.status !== 503) {
      throw new Error(`render_document_failed:${response.status}`);
    }
  }

  await downloadElementPdf(options);
  return 'browser';
}
