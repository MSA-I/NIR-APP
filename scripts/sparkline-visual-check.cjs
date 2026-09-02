// Visual verification of the price sparkline's non-colour direction carrier (DEBT §53).
//
// The claim under test is not "an icon renders" -- colorLanguage.spec.ts already pins that from
// the source. It is the part only a picture settles: that a 13px glyph beside a 96x28 step line
// reads as a direction at real size, that it does not crowd the line, and -- the reason the debt
// existed -- that up and down stay distinguishable once hue is removed entirely.
//
// HEADED ON PURPOSE -- headless misses injected CSS on this machine (memory:
// headless-screenshot-stale-css). Shape and launch flags copied from
// `scripts/toast-undo-visual-check.cjs`, which is what this repo already trusts.
//
// NO DATABASE, NO SIGN-IN. `PriceSparkline` takes `number[]` and nothing else, so this mounts the
// real component in the real stylesheet behind the real LocaleProvider and touches no fixture and
// no shared local Supabase. That is the whole reason this check is cheap enough to keep.
//
// Not wired into any gate; run manually:
//   node scripts/sparkline-visual-check.cjs
const { chromium } = require('playwright-core');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { mkdirSync, writeFileSync, rmSync } = require('node:fs');

const ROOT = join(__dirname, '..');
const HARNESS = join(ROOT, '.tmp', 'sparkline-harness');
const OUT = join(ROOT, '.sparkline-shots');
const PORT = 5199 + 707; // away from dev, the gate, the portal, the plan and the toast checks

const ENTRY = [
  "import { StrictMode } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import '../../src/index.css';",
  "import { LocaleProvider } from '../../src/lib/i18n/LocaleProvider';",
  "import { PriceSparkline } from '../../src/components/supplier-metrics';",
  '',
  '// Three series, one per branch of the direction. Values are arbitrary; only the sign matters.',
  'const CASES = [',
  "  ['up', [10, 11, 12, 14]],",
  "  ['down', [14, 13, 12, 10]],",
  "  ['flat', [12, 12, 12, 12]],",
  '];',
  '',
  'function Harness() {',
  '  return (',
  '    <LocaleProvider initialLocale="he">',
  '      <div dir="rtl" className="bg-canvas p-6" style={{ display: "grid", gap: "12px", width: "max-content" }}>',
  '        {CASES.map(([name, points]) => (',
  '          <div key={name} data-case={name} style={{ display: "flex", alignItems: "center", gap: "10px" }}>',
  '            <span className="text-xs text-ink-muted" style={{ width: "3rem" }}>{name}</span>',
  '            <PriceSparkline points={points} />',
  '          </div>',
  '        ))}',
  '      </div>',
  '    </LocaleProvider>',
  '  );',
  '}',
  '',
  '// Mount only once the design tokens have actually applied. `chartTheme()` reads them through',
  '// getComputedStyle and memoises the first answer, and vite dev injects the stylesheet with a',
  '// <style> tag AFTER the first paint -- so mounting immediately caches an empty theme and the',
  "// step line comes out stroke:none. A production build links the stylesheet, which blocks the",
  '// first paint, so this race belongs to the dev server and not to the product.',
  'function mountWhenTokensResolve() {',
  '  const style = getComputedStyle(document.documentElement);',
  '  // ALL THREE, not just one: chartTheme() memoises the whole object on its first call, so a',
  '  // partially-applied stylesheet locks in empty strokes for whichever tokens had not landed yet.',
  '  const ready = ["--color-trend-up-fg", "--color-trend-down-fg", "--color-chart-3"]',
  '    .every((name) => style.getPropertyValue(name).trim() !== "");',
  '  if (!ready) { requestAnimationFrame(mountWhenTokensResolve); return; }',
  "  createRoot(document.getElementById('root')).render(<StrictMode><Harness /></StrictMode>);",
  '}',
  'mountWhenTokensResolve();',
  '',
].join('\n');

const HTML = [
  '<!doctype html>',
  '<html dir="rtl" lang="he"><head><meta charset="utf-8"><title>sparkline</title></head>',
  '<body><div id="root"></div><script type="module" src="./entry.tsx"></script></body></html>',
  '',
].join('\n');

/**
 * The glyph must not be a hue. Two forms reach here: Chrome reports `oklch(...)` verbatim for a
 * token declared in oklch -- which every colour in `index.css` is -- and `rgb(...)` for anything
 * that went through a fallback. In oklch the second component IS the chroma, so neutrality is
 * read directly; in rgb it is the spread between the channels.
 */
function neutralityFinding(probe) {
  for (const p of probe) {
    const colour = p.glyphColor || '';
    const oklch = /oklch\(\s*[\d.]+%?\s+([\d.]+)/.exec(colour);
    if (oklch) {
      if (Number(oklch[1]) > 0.04) {
        return `${p.name}: glyph colour ${colour} carries chroma ${oklch[1]}, which is a hue`;
      }
      continue;
    }
    const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(colour);
    if (!rgb) return `${p.name}: unreadable glyph colour ${colour}`;
    const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 24) {
      return `${p.name}: glyph colour ${colour} is a hue, not neutral ink`;
    }
  }
  return null;
}

async function main() {
  mkdirSync(HARNESS, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(HARNESS, 'entry.tsx'), ENTRY, 'utf8');
  writeFileSync(join(HARNESS, 'index.html'), HTML, 'utf8');

  const viteBin = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const server = spawn(
    process.execPath,
    // `--config` is not optional: without the repo's vite config the Tailwind v4 plugin and the
    // React plugin are both absent, so `src/index.css` and the JSX in the harness fail to build.
    // The root is POSITIONAL in vite 6 -- `--root` is rejected as an unknown option. `--config`
    // is not optional either: without the repo's config the Tailwind v4 and React plugins are
    // both absent, so `src/index.css` and the JSX in the harness fail to build.
    [viteBin, HARNESS, '--config', join(ROOT, 'vite.config.ts'),
      '--port', String(PORT), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let serverLog = '';
  const echo = (d) => { const text = d.toString(); serverLog += text; process.stdout.write(`[vite] ${text}`); };
  server.stdout.on('data', echo);
  server.stderr.on('data', echo);
  server.on('exit', (code) => { if (code) process.stdout.write(`[vite] exited ${code}
`); });

  const baseURL = `http://localhost:${PORT}`;
  // Vite prints "ready in" on stdout before it accepts a connection; without waiting for it the
  // first navigation races the server and comes back ERR_CONNECTION_REFUSED.
  console.log(`waiting for vite on ${PORT}...`);
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`vite did not start in 60s:
${serverLog}`)), 60000);
    const poll = setInterval(() => {
      if (/ready in|Local:\s+http/i.test(serverLog)) { clearInterval(poll); clearTimeout(deadline); resolve(); }
    }, 200);
  });

  const browser = await chromium.launch({
    headless: false,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  });

  const findings = [];
  const shots = [];
  let probe = [];
  try {
    const context = await browser.newContext({
      viewport: { width: 420, height: 260 },
      locale: 'he-IL',
      serviceWorkers: 'block',
      // recharts skips its entry animation only when motion is reduced; without this the first
      // frame can be an empty chart (memory: chart-screenshots-need-reduced-motion).
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    // `load`, not `networkidle`: vite dev holds an HMR websocket open, so the network is never
    // idle and the navigation would hang forever. The locator below is the real readiness signal.
    await page.goto(baseURL, { waitUntil: 'load', timeout: 60000 });
    await page.locator('[data-case="up"] svg').first().waitFor({ timeout: 30000 });

    probe = await page.evaluate(() => {
      const read = (name) => {
        const row = document.querySelector(`[data-case="${name}"]`);
        const image = row && row.querySelector('span[role="img"]');
        if (!image) return { name, error: 'sparkline not rendered' };
        const svgs = [...image.querySelectorAll('svg')];
        const glyph = svgs[svgs.length - 1];
        const chart = image.querySelector('.recharts-wrapper, svg.recharts-surface');
        if (!glyph || !chart || svgs.length < 2) return { name, error: 'glyph or chart missing' };
        const style = getComputedStyle(glyph);
        const box = glyph.getBoundingClientRect();
        return {
          name,
          glyphColor: style.color,
          glyphSize: Math.round(box.width),
          // The path data IS the shape: up, down and flat must not share one.
          shape: [...glyph.querySelectorAll('path, line')]
            .map((node) => node.getAttribute('d') || node.outerHTML).join('|'),
          label: image.getAttribute('aria-label'),
          // The line has to actually be drawn, or this check would go on passing while the
          // sparkline itself disappeared and only the new glyph remained.
          lineStroke: (() => {
            const line = chart.querySelector('path.recharts-curve, .recharts-line-curve');
            return line ? getComputedStyle(line).stroke : null;
          })(),
          lineLength: (() => {
            const line = chart.querySelector('path.recharts-curve, .recharts-line-curve');
            return line ? (line.getAttribute('d') || '').length : 0;
          })(),
          chartWidth: Math.round(chart.getBoundingClientRect().width),
        };
      };
      return ['up', 'down', 'flat'].map(read);
    });

    const neutral = neutralityFinding(probe);
    if (neutral) findings.push(neutral);
    const shapes = new Set(probe.map((p) => p.shape));
    if (shapes.size !== 3) findings.push(`the three directions do not carry three distinct shapes: ${shapes.size}`);
    for (const p of probe) {
      if (p.error) findings.push(`${p.name}: ${p.error}`);
      if (p.glyphSize && (p.glyphSize < 10 || p.glyphSize > 16)) {
        findings.push(`${p.name}: glyph rendered at ${p.glyphSize}px, outside the 10-16 band`);
      }
      if (!p.error && p.lineLength < 10) {
        findings.push(`${p.name}: the step line drew no path -- the glyph is not standing beside anything`);
      }
      if (!p.error && (!p.lineStroke || p.lineStroke === 'none')) {
        findings.push(`${p.name}: the step line has no stroke (${p.lineStroke})`);
      }
      if (!p.error && p.chartWidth !== 96) {
        findings.push(`${p.name}: chart is ${p.chartWidth}px wide, not the fixed 96`);
      }
    }

    // The greyscale pass is the debt's own test: strip hue and the direction must survive.
    for (const [label, filter] of [['colour', 'none'], ['greyscale', 'grayscale(1)']]) {
      await page.evaluate((f) => { document.documentElement.style.filter = f; }, filter);
      const file = join(OUT, `sparkline-${label}.png`);
      await page.screenshot({ path: file });
      shots.push(file);
    }
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(JSON.stringify({ probe, shots, findings }, null, 2));
  if (findings.length) {
    console.error('\nFINDINGS:\n  ' + findings.join('\n  '));
    console.error('\nvite log:\n' + serverLog.slice(-2000));
    process.exitCode = 1;
  } else {
    console.log('\nsparkline visual check passed: three distinct shapes, neutral ink, both shots written.');
  }
  rmSync(HARNESS, { recursive: true, force: true });
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
