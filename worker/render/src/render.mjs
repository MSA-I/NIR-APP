import { chromium } from 'playwright-core';
import { PDFDocument, degrees } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { MAX_PDF_BYTES, MAX_RENDER_MS, PAGE_FORMAT } from './contract.mjs';

/**
 * Render one application screen to a PDF, server-side.
 *
 * ─── WHY A BROWSER, AND WHY THIS SOLVES BOTH OPEN DEBTS AT ONCE ──────────────────────────────
 * The client-side generator (`src/lib/pdf.ts`) rasterises the screen because no JavaScript PDF
 * engine implements the Unicode bidirectional algorithm — measured, and the reason is written up
 * there. That left two things open: the text was a picture (DEBT §68) and the watermark was
 * applied by the client, so it was branding rather than enforcement (DEBT §72).
 *
 * A browser here answers both. Chromium lays the Hebrew out — the same engine, the same print
 * stylesheet, the same result — and `page.pdf()` emits REAL TEXT, so the accountant can select and
 * search it. And because the document is produced on a machine the reader cannot reach, the stamp
 * goes on where it cannot be removed: the customer never holds an unstamped copy.
 *
 * MEASURED before this service was written: `page.pdf()` on `/reports` produced a two-page file
 * whose extracted text contained `דוח חודשי יוני 2026` and `12,523.00`.
 *
 * ─── THE PRINT STYLESHEET IS THE TEMPLATE ────────────────────────────────────────────────────
 * There is no second layout to maintain and no `/print` route to keep in step. `@media print` in
 * `src/index.css` already decides what belongs on paper: `.no-print` is dropped, `.print-only`
 * appears, the report gets its landscape `@page`, and table headers repeat across pages.
 * `page.pdf()` applies exactly that. A document that looks wrong here looks wrong on a printer,
 * which is the correct coupling.
 *
 * ─── THE SESSION, AND THE TRUST BOUNDARY IT DRAWS ────────────────────────────────────────────
 * The page reads the tenant's own data under RLS, so it needs the caller's session. The Edge
 * hands it over in the request body — never in the URL, which would put a live token in this
 * service's logs and in the browser's history — and it is written into `localStorage` by an init
 * script BEFORE the first navigation, so the application boots already signed in and no login
 * screen is ever rendered.
 *
 * That makes this service first-party infrastructure inside the same trust boundary as the Edge
 * function: for the seconds a render takes, it can read whatever the caller can read. It is
 * stated here rather than discovered later. The mitigations are the shared secret on the way in,
 * the path allowlist, and a browser context that is destroyed after every request.
 */

const CHROME_PATH = process.env.RENDER_CHROMIUM_PATH || undefined;
const VIEWPORT = { width: 1440, height: 1200 };
/** After the network goes quiet, the report still settles — measured on the live dashboard. */
const SETTLE_MS = Number(process.env.RENDER_SETTLE_MS ?? 2500);

let browserPromise = null;

/** One browser for the life of the process; a context per request. Launch is the expensive part. */
async function browser() {
  if (browserPromise === null) {
    browserPromise = chromium.launch({
      // Headless in the container. The switch exists for local verification against a Vite DEV
      // server, which injects its stylesheets through JavaScript — a case where headless Chrome has
      // been measured on this project to render a page with no styles at all. A production build
      // serves a real stylesheet and does not have that failure mode.
      headless: process.env.RENDER_HEADLESS !== 'false',
      executablePath: CHROME_PATH,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (browserPromise === null) return;
  const instance = await browserPromise;
  browserPromise = null;
  await instance.close();
}

/**
 * Stamp the mark across every page of a finished PDF.
 *
 * Drawn HERE and not by the page, so it is not something a stylesheet or a client can suppress —
 * that is the whole difference between this and the browser-side generator. The lockup is
 * embedded as PNG because pdf-lib draws raster or vector paths, not SVG documents; at 8% opacity
 * across a page it never competes with a figure the reader has to trust.
 */
async function stamp(pdfBytes, markPath) {
  const document = await PDFDocument.load(pdfBytes);
  const mark = await document.embedPng(await readFile(markPath));
  for (const page of document.getPages()) {
    const { width, height } = page.getSize();
    const drawWidth = width * 0.55;
    const drawHeight = (mark.height / mark.width) * drawWidth;
    page.drawImage(mark, {
      x: (width - drawWidth) / 2,
      y: (height - drawHeight) / 2,
      width: drawWidth,
      height: drawHeight,
      opacity: 0.08,
      rotate: degrees(0),
    });
  }
  return Buffer.from(await document.save());
}

export async function renderDocument({ appUrl, path, orientation, watermark, session, markPath }) {
  const instance = await browser();
  const context = await instance.newContext({
    viewport: VIEWPORT,
    locale: 'he-IL',
    timeZoneId: 'Asia/Jerusalem',
  });
  try {
    // Before the first navigation, so the application boots signed in rather than redirecting to
    // the login screen and rendering it into the file.
    await context.addInitScript(
      ([key, value]) => {
        try { window.localStorage.setItem(key, value); } catch { /* private mode: the page will 401 */ }
      },
      [session.storageKey, session.value],
    );

    const page = await context.newPage();
    page.setDefaultTimeout(MAX_RENDER_MS);
    await page.goto(new URL(path, appUrl).href, {
      waitUntil: 'networkidle',
      timeout: MAX_RENDER_MS,
    });
    // The screen has to have rendered its document, not merely stopped fetching.
    //
    // `attached`, not the default `visible`: `.print-only` is `display: none` ON SCREEN by
    // definition — it is the heading that exists only on paper — and the invoice screen happens to
    // put one first. Waiting for visibility timed out on a page that was already complete.
    await page.waitForSelector('.print-area, .print-only', {
      state: 'attached',
      timeout: MAX_RENDER_MS,
    });
    await page.waitForTimeout(SETTLE_MS);

    let pdf = await page.pdf({
      format: PAGE_FORMAT,
      landscape: orientation === 'landscape',
      printBackground: true,
      // No margin here on purpose: `@page` in src/index.css owns it, and setting both would
      // silently add them together.
      preferCSSPageSize: true,
    });
    if (watermark) pdf = await stamp(pdf, markPath);
    if (pdf.byteLength > MAX_PDF_BYTES) {
      throw new Error('render_pdf_too_large');
    }
    return pdf;
  } finally {
    await context.close();
  }
}
