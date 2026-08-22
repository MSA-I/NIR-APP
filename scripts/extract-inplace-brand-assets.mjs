import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/extract-inplace-brand-assets.mjs <source.svg>');

const root = process.cwd();
const brandDir = path.join(root, 'brand', 'assets');
const publicBrandDir = path.join(root, 'public', 'brand');
const publicIconsDir = path.join(root, 'public', 'icons');
await Promise.all([brandDir, publicBrandDir, publicIconsDir].map((dir) => mkdir(dir, { recursive: true })));

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
});

const page = await browser.newPage({ viewport: { width: 2048, height: 2048 } });
await page.goto(pathToFileURL(path.resolve(source)).href);

const paths = await page.locator('path').evaluateAll((nodes) => nodes.map((node, index) => {
  const box = node.getBBox();
  return {
    index,
    html: node.outerHTML,
    fill: node.getAttribute('fill') ?? '',
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
  };
}));

const regions = {
  lockup: [520, 650, 1450, 850],
  symbol: [1640, 650, 1840, 850],
  appIcon: [190, 840, 380, 1040],
  symbolPrimary: [1060, 1100, 1210, 1240],
  symbolMuted: [1210, 1100, 1370, 1240],
  symbolAccentDot: [1360, 1100, 1530, 1240],
  symbolAccent: [1260, 1670, 1470, 1860],
  darkTile: [1490, 1610, 1800, 1940],
};

const inRegion = (item, [x1, y1, x2, y2]) => {
  const cx = item.x + item.width / 2;
  const cy = item.y + item.height / 2;
  return cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2;
};

const cleanPath = (html) => html
  .replaceAll('fill="rgb(13,34,47)"', 'fill="#0D222F"')
  .replaceAll('fill="rgb(5,57,79)"', 'fill="#05394F"')
  .replaceAll('fill="rgb(62,62,64)"', 'fill="#3E3E40"')
  .replaceAll('fill="rgb(251,251,251)"', 'fill="#FBFBFB"')
  .replaceAll('fill="rgb(237,237,237)"', 'fill="#EDEDED"');

const selected = Object.fromEntries(Object.entries(regions).map(([name, region]) => [
  name,
  paths.filter((item) => inRegion(item, region)),
]));

for (const [name, items] of Object.entries(selected)) {
  if (items.length === 0) throw new Error(`No SVG paths found for ${name}`);
}

function bounds(items, square = false, padding = 0) {
  const minX = Math.min(...items.map((item) => item.x));
  const minY = Math.min(...items.map((item) => item.y));
  const maxX = Math.max(...items.map((item) => item.x + item.width));
  const maxY = Math.max(...items.map((item) => item.y + item.height));
  let width = maxX - minX;
  let height = maxY - minY;
  let x = minX;
  let y = minY;
  if (square) {
    const size = Math.max(width, height);
    x -= (size - width) / 2;
    y -= (size - height) / 2;
    width = size;
    height = size;
  }
  const pad = Math.max(width, height) * padding;
  return { x: x - pad, y: y - pad, width: width + 2 * pad, height: height + 2 * pad };
}

const isBoardWhite = (item) => item.fill === 'rgb(251,251,251)';

function maskedSvg(items, { title, desc, forceColor, square = false, padding = 0.025 }) {
  const box = bounds(items, square, padding);
  const foreground = items.filter((item) => !isBoardWhite(item));
  const holes = items.filter(isBoardWhite);
  const body = foreground.map((item) => {
    const html = cleanPath(item.html);
    return forceColor ? html.replace(/fill="[^"]+"/, `fill="${forceColor}"`) : html;
  }).join('\n    ');
  const mask = holes.map((item) => cleanPath(item.html).replace(/fill="[^"]+"/, 'fill="#000000"')).join('\n        ');
  const defs = holes.length > 0 ? `  <defs>
    <mask id="cutouts" maskUnits="userSpaceOnUse" x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}">
      <rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="#ffffff"/>
      ${mask}
    </mask>
  </defs>
` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.x} ${box.y} ${box.width} ${box.height}" role="img" aria-labelledby="title desc">
  <title id="title">${title}</title>
  <desc id="desc">${desc}</desc>
${defs}  <g${holes.length > 0 ? ' mask="url(#cutouts)"' : ''}>
    ${body}
  </g>
</svg>
`;
}

function directSvg(items, { title, desc, square = false, padding = 0.025 }) {
  const box = bounds(items, square, padding);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.x} ${box.y} ${box.width} ${box.height}" role="img" aria-labelledby="title desc">
  <title id="title">${title}</title>
  <desc id="desc">${desc}</desc>
  ${items.map((item) => cleanPath(item.html)).join('\n  ')}
</svg>
`;
}

const files = new Map([
  ['inplace-lockup.svg', maskedSvg(selected.lockup, {
    title: 'InPlace logo',
    desc: 'Final InPlace symbol and custom vector wordmark.',
    padding: 0.02,
  })],
  ['inplace-lockup-paper.svg', maskedSvg(selected.lockup, {
    title: 'InPlace inverse logo',
    desc: 'Final InPlace symbol and custom vector wordmark in paper white for dark surfaces.',
    forceColor: '#FBFBFB',
    padding: 0.02,
  })],
  ['inplace-symbol.svg', maskedSvg(selected.symbol, {
    title: 'InPlace symbol',
    desc: 'Final dark InPlace standalone symbol.',
    square: true,
  })],
  ['inplace-symbol-paper.svg', maskedSvg(selected.symbol, {
    title: 'InPlace inverse symbol',
    desc: 'Final InPlace standalone symbol in paper white for dark surfaces.',
    forceColor: '#FBFBFB',
    square: true,
  })],
  ['inplace-symbol-muted.svg', maskedSvg(selected.symbolMuted, {
    title: 'InPlace muted symbol',
    desc: 'Final InPlace standalone symbol in graphite gray.',
    square: true,
  })],
  ['inplace-symbol-accent.svg', maskedSvg(selected.symbolAccent, {
    title: 'InPlace accent symbol',
    desc: 'Final InPlace standalone symbol in deep blue.',
    square: true,
  })],
  ['inplace-symbol-accent-dot.svg', maskedSvg(selected.symbolAccentDot, {
    title: 'InPlace accent dot symbol',
    desc: 'Final InPlace deep-blue symbol with its subtle dot variation.',
    square: true,
  })],
  ['inplace-app-icon.svg', directSvg(selected.appIcon, {
    title: 'InPlace app icon',
    desc: 'Final rounded InPlace app icon in dark blue and paper white.',
    square: true,
    padding: 0,
  })],
  ['inplace-monochrome-dark.svg', directSvg(selected.darkTile, {
    title: 'InPlace monochrome dark tile',
    desc: 'Final InPlace paper-white symbol on a dark square.',
    square: true,
    padding: 0,
  })],
]);

for (const [name, content] of files) {
  await writeFile(path.join(brandDir, name), content, 'utf8');
}

for (const name of [
  'inplace-lockup.svg', 'inplace-lockup-paper.svg', 'inplace-symbol.svg',
  'inplace-symbol-paper.svg', 'inplace-app-icon.svg',
]) {
  await writeFile(path.join(publicBrandDir, name), files.get(name), 'utf8');
}

const symbolItems = selected.symbol.filter((item) => !isBoardWhite(item));
const symbolHoles = selected.symbol.filter(isBoardWhite);
const symbolBox = bounds(selected.symbol, true, 0);
const scale = 460 / Math.max(symbolBox.width, symbolBox.height);
const tx = 500 - (symbolBox.x + symbolBox.width / 2) * scale;
const ty = 500 - (symbolBox.y + symbolBox.height / 2) * scale;
const maskableDefs = symbolHoles.length > 0 ? `  <defs>
    <mask id="symbol-cutouts" maskUnits="userSpaceOnUse" x="0" y="0" width="1000" height="1000">
      <rect width="1000" height="1000" fill="#ffffff"/>
      <g transform="translate(${tx} ${ty}) scale(${scale})">
        ${symbolHoles.map((item) => cleanPath(item.html).replace(/fill="[^"]+"/, 'fill="#000000"')).join('\n        ')}
      </g>
    </mask>
  </defs>
` : '';
const maskableSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" role="img" aria-labelledby="title desc">
  <title id="title">InPlace maskable app icon</title>
  <desc id="desc">Final InPlace symbol centered in the maskable safe zone.</desc>
  <rect width="1000" height="1000" fill="#0D222F"/>
${maskableDefs}
  <g transform="translate(${tx} ${ty}) scale(${scale})"${symbolHoles.length > 0 ? ' mask="url(#symbol-cutouts)"' : ''}>
    ${symbolItems.map((item) => cleanPath(item.html).replace(/fill="[^"]+"/, 'fill="#FBFBFB"')).join('\n    ')}
  </g>
</svg>
`;
await writeFile(path.join(brandDir, 'inplace-app-icon-maskable.svg'), maskableSvg, 'utf8');
await writeFile(path.join(publicBrandDir, 'inplace-app-icon-maskable.svg'), maskableSvg, 'utf8');

async function renderSvg(svgPath, pngPath, size, background = null) {
  const renderPage = await browser.newPage({ viewport: { width: size, height: size } });
  await renderPage.goto(pathToFileURL(svgPath).href);
  await renderPage.locator('svg').evaluate((svg, { px, background }) => {
    svg.setAttribute('width', String(px));
    svg.setAttribute('height', String(px));
    document.documentElement.style.background = background ?? 'transparent';
  }, { px: size, background });
  await renderPage.screenshot({ path: pngPath, omitBackground: background === null });
  await renderPage.close();
}

await renderSvg(path.join(publicBrandDir, 'inplace-app-icon.svg'), path.join(publicIconsDir, 'icon-192.png'), 192);
await renderSvg(path.join(publicBrandDir, 'inplace-app-icon.svg'), path.join(publicIconsDir, 'icon-512.png'), 512);
await renderSvg(path.join(publicBrandDir, 'inplace-app-icon-maskable.svg'), path.join(publicIconsDir, 'icon-512-maskable.png'), 512);
await renderSvg(path.join(brandDir, 'inplace-lockup.svg'), path.join(brandDir, 'inplace-lockup-preview.png'), 1200, '#FBFBFB');

await copyFile(source, path.join(brandDir, 'inplace-brand-board-3x3.svg'));
await renderSvg(path.join(brandDir, 'inplace-brand-board-3x3.svg'), path.join(brandDir, 'inplace-brand-board-3x3-render.png'), 2048);
await copyFile(path.join(brandDir, 'inplace-brand-board-3x3-render.png'), path.join(brandDir, 'inplace-logo-signoff.png'));

await browser.close();

const sourceBytes = (await readFile(source)).byteLength;
console.log(JSON.stringify({
  sourceBytes,
  selectedPaths: Object.fromEntries(Object.entries(selected).map(([name, items]) => [name, items.length])),
  generated: [...files.keys(), 'inplace-app-icon-maskable.svg'],
}, null, 2));
