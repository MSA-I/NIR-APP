// Favicon set for the three HTML entry points.
//
// WHY THIS EXISTS. `public/_redirects` ends with `/* /index.html 200`, so before this script
// a browser's default request for `/favicon.ico` was answered with an HTML document. The tab
// icon also disagreed with the marketing site, which serves the standalone symbol as an SVG
// favicon while the app served only a 192px PNG of the rounded app icon.
//
// SOURCE, AND THE ONE DELIBERATE SPLIT (owner decision, 24.08.2026):
//   favicon.svg / favicon.ico / favicon-96.png  <- inplace-symbol.svg, byte-identical to the
//     asset the landing site serves, so the two tabs match exactly.
//   apple-touch-icon.png                        <- inplace-app-icon.svg, the opaque rounded
//     tile. iOS composites a home-screen icon onto black and does not honour transparency, so
//     the transparent dark symbol would render dark-on-dark there. The manifest's PWA icons
//     already use this same app icon, so this is the consistent choice, not a new one.
//
// NOT IMAGEMAGICK. `convert` on this machine's PATH is the Windows FAT->NTFS tool, not
// ImageMagick, and running it would be a disk command rather than a failed render. Rendering
// reuses the proven path from scripts/extract-inplace-brand-assets.mjs: playwright-core
// driving Edge. The ICO container is assembled here in a few lines rather than pulling in a
// dependency for a 22-byte header plus three PNG blobs.
//
// `public/manifest.webmanifest` is deliberately untouched — brand/implementation-surface.md:28
// requires the existing asset paths to survive so favicon, PWA, precache and push keep working.
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const root = process.cwd();
const publicDir = path.join(root, 'public');
const brandDir = path.join(publicDir, 'brand');
const iconsDir = path.join(publicDir, 'icons');
const symbolSvg = path.join(brandDir, 'inplace-symbol.svg');
const appIconSvg = path.join(brandDir, 'inplace-app-icon.svg');

await mkdir(iconsDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
});

// Same shape as extract-inplace-brand-assets.mjs: size the <svg> to the viewport, then
// screenshot with omitBackground when no background colour was asked for.
async function renderSvg(svgPath, pngPath, size, background = null) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.goto(pathToFileURL(svgPath).href);
  await page.locator('svg').evaluate((svg, { px, bg }) => {
    svg.setAttribute('width', String(px));
    svg.setAttribute('height', String(px));
    document.documentElement.style.background = bg ?? 'transparent';
  }, { px: size, bg: background });
  await page.screenshot({ path: pngPath, omitBackground: background === null });
  await page.close();
  return pngPath;
}

/**
 * ICO with PNG payloads (supported since Windows Vista; every current browser reads it).
 * Layout: ICONDIR(6) + ICONDIRENTRY(16) * n + the PNG blobs back to back.
 * A width or height byte of 0 means 256 — irrelevant at these sizes, but the encoding is
 * why the field is one byte and why 256 is the format's ceiling.
 */
function packIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);            // reserved
  header.writeUInt16LE(1, 2);            // 1 = icon
  header.writeUInt16LE(pngs.length, 4);  // image count

  const directory = Buffer.alloc(16 * pngs.length);
  let offset = header.length + directory.length;
  pngs.forEach(({ size, data }, i) => {
    const at = i * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, at);      // width
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);  // height
    directory.writeUInt8(0, at + 2);                       // palette count (0 = truecolour)
    directory.writeUInt8(0, at + 3);                       // reserved
    directory.writeUInt16LE(1, at + 4);                    // colour planes
    directory.writeUInt16LE(32, at + 6);                   // bits per pixel
    directory.writeUInt32LE(data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });

  return Buffer.concat([header, directory, ...pngs.map((p) => p.data)]);
}

const tmp = path.join(root, '.favicon-tmp');
await mkdir(tmp, { recursive: true });

const icoSizes = [16, 32, 48];
const icoParts = [];
for (const size of icoSizes) {
  const png = await renderSvg(symbolSvg, path.join(tmp, `sym-${size}.png`), size);
  icoParts.push({ size, data: await readFile(png) });
}
const ico = packIco(icoParts);
await writeFile(path.join(publicDir, 'favicon.ico'), ico);

await copyFile(symbolSvg, path.join(publicDir, 'favicon.svg'));
await renderSvg(symbolSvg, path.join(iconsDir, 'favicon-96.png'), 96);
await renderSvg(appIconSvg, path.join(publicDir, 'apple-touch-icon.png'), 180);

await browser.close();

const sha = async (p) => createHash('sha256').update(await readFile(p)).digest('hex');
const report = {};
for (const rel of ['favicon.ico', 'favicon.svg', 'apple-touch-icon.png', 'icons/favicon-96.png']) {
  const abs = path.join(publicDir, rel);
  report[rel] = { bytes: (await readFile(abs)).byteLength, sha256: await sha(abs) };
}
report['favicon.svg identical to public/brand/inplace-symbol.svg'] =
  (await sha(path.join(publicDir, 'favicon.svg'))) === (await sha(symbolSvg));
report.icoEntries = icoParts.map((p) => ({ size: p.size, bytes: p.data.length }));
console.log(JSON.stringify(report, null, 2));
