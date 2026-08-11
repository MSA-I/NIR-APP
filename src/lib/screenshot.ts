/**
 * The viewport, as a PNG, for a feedback note (package L, owner decision 11.08.2026).
 *
 * DOM capture was chosen over `getDisplayMedia` for one reason and it is worth restating where the
 * code is: this reads THIS PAGE's DOM and paints it. It has no picker, no permission prompt and no
 * way to reach another tab, another window or the desktop. `getDisplayMedia` would have let a person
 * hand a vendor's Discord channel a screenshot of their bank.
 *
 * THE LIBRARY IS `html2canvas-pro`, NOT `html2canvas`, and that is not a preference. html2canvas
 * 1.4.1 is the last release, from 2022, and it throws `Attempting to parse an unsupported color
 * function "oklch"` on this app -- measured, in the browser, on /documents. Every colour token in
 * `src/index.css` is an oklch, because that is what Tailwind v4's `@theme` emits, so the original
 * library cannot render a single screen of this product. The fork is API-compatible and maintained,
 * and it is the same mechanism the owner chose: a DOM renderer that cannot see past this page.
 *
 * Three rules the capture obeys, all enforced here because the server cannot inspect a PNG:
 *
 *   1. **Never the feedback dialog.** The picture is of the screen the person is complaining about.
 *      Capturing the box they are typing into is both useless and a way to photograph their own
 *      half-written words back at them. Anything inside `[role="dialog"]`, plus anything the app
 *      marks `data-no-capture`, is skipped.
 *   2. **Never a password field.** There is no login form behind an authenticated feedback button
 *      today, but "there is no such screen today" is exactly the assumption that expires quietly.
 *
 * There used to be a third rule here — skip anything whose computed style says it is not painted —
 * and it was wrong in a way only the screen could show. The library lays the clone out in its own
 * iframe, so an element's visibility in the LIVE document says nothing about its visibility in the
 * clone: `lg:hidden` phone chrome is invisible here and visible there. Measured on /documents at
 * 2560px, the filter cut the ink from 49,274 sampled pixels spanning the full width down to 428
 * huddled against one edge — a preview that was, literally, the sidebar. Hidden elements are the
 * renderer's business, and it already handles `display:none` and `visibility:hidden` in the layout
 * context where the question can actually be answered.
 *
 * The library is loaded with a dynamic import, so a person who never opens the feedback box never
 * downloads it -- it is ~50KB and this is a surface most users use zero times.
 */

/** What the caller needs in order to preview, describe and upload one capture. */
export interface ScreenshotCapture {
  blob: Blob;
  /** Object URL for the preview. The caller revokes it. */
  previewUrl: string;
  bytes: number;
  /** sha-256, lower hex — the shape 0122's CHECK pins. */
  checksum: string;
  width: number;
  height: number;
}

/** 0122's bucket cap. A viewport PNG is a few hundred KB; this is the ceiling, not the target. */
export const SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024;

const SKIP_SELECTOR = '[data-no-capture],[role="dialog"],.dialog-backdrop-safe,input[type="password"]';

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Capture the visible viewport.
 *
 * Returns `null` rather than throwing on any failure — a tainted canvas from a cross-origin image,
 * a browser without `crypto.subtle`, an out-of-memory on a very long page. The note must survive all
 * of them, so failure here is a missing picture and never a lost sentence.
 */
export async function captureViewport(): Promise<ScreenshotCapture | null> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  try {
    const { default: html2canvas } = await import('html2canvas-pro');
    const canvas = await html2canvas(document.body, {
      // The viewport, not the whole document: the person is reporting what they can see, and a
      // 12,000px-tall table would blow the size cap for no added information.
      //
      // Four options and no more: `x`/`y` say where to crop, `width`/`height` say how much. The
      // clone's own layout size is the library's business, and `windowWidth`/`windowHeight` set
      // alongside a crop is two answers to one question.
      x: window.scrollX,
      y: window.scrollY,
      width: window.innerWidth,
      height: window.innerHeight,
      // 1, not devicePixelRatio: a retina capture is four times the bytes to say the same thing.
      scale: 1,
      useCORS: true,
      backgroundColor: null,
      logging: false,
      ignoreElements: (element) => element.matches(SKIP_SELECTOR),
    });
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((result) => resolve(result), 'image/png');
    });
    if (!blob || blob.size === 0 || blob.size > SCREENSHOT_MAX_BYTES) return null;
    return {
      blob,
      previewUrl: URL.createObjectURL(blob),
      bytes: blob.size,
      checksum: await sha256Hex(blob),
      width: canvas.width,
      height: canvas.height,
    };
  } catch {
    return null;
  }
}
