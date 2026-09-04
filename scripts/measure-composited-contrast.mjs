#!/usr/bin/env node
/**
 * The RENDERED-PIXEL oracle: contrast measured on the pixels a screen actually paints.
 *
 * `check:contrast` proves the manifest is honest and `check-contrast-rendered.mjs` proves the
 * PALETTE is — it resolves token pairs in a real browser. Neither can see this class of defect,
 * and one of them says so in its own header: "it measures the PALETTE, not each screen's choice
 * of pair". A token pair can be sound while the colour that lands under the text is not, because
 * something translucent is painted in between. That is exactly the defect ruling #354 settles:
 * `.app-glow` mixes `--color-action` at 17%, the dark theme redefines that token as a paper tone,
 * and the orb therefore LIGHTENS the dark canvas under the page description on every screen.
 *
 * HOW THE BACKGROUND IS OBTAINED, AND WHY NOT THE OBVIOUS WAY. The first attempt read the modal
 * colour of the text's own box. It aborted on its own integrity check at the first route, and it
 * was right to: the ground under that text is a radial gradient, so 474x20 pixels held 849
 * distinct colours and no colour covered more than 2.3% of the box. There is no single background
 * pixel to find. So the text is made TRANSPARENT and the box photographed again — every pixel in
 * the second photograph is the ground, exactly as composited, and the verdict is taken on the
 * WORST of them rather than on an average that would hide the dark end of a gradient.
 *
 * INTEGRITY, BECAUSE A MEASUREMENT THAT CANNOT BE WRONG CANNOT BE RIGHT EITHER. The two
 * photographs must DIFFER inside the box — if hiding the text changed no pixels, the capture is
 * not showing what the page is showing, which is the stale-screenshot trap this machine has hit
 * before. Any box that fails that aborts the run instead of reporting a comfortable number. The
 * run is HEADED for the same reason: headless capture here has served stale pixels while
 * `getComputedStyle` reported the new values.
 *
 * Environment, the sibling gate's contract plus three:
 *   PLAYWRIGHT_CORE_PATH   module id or path for playwright-core        (default: playwright-core)
 *   QUALITY_BROWSER_PATH   browser executable                           (default: system Edge)
 *   QUALITY_BASE_URL       the running dev/preview server               (default: :5199)
 *   MEASURE_OUT_DIR        where the JSON report and screenshots go     (optional)
 *   MEASURE_LABEL          a name for this run, e.g. RED / GREEN        (default: run)
 *   MEASURE_HEADLESS=1     opt out of the headed default, for CI
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const envOr = (name, fallback) => {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
};

const corePath = envOr('PLAYWRIGHT_CORE_PATH', 'playwright-core');
const browserPath = envOr(
  'QUALITY_BROWSER_PATH',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
);
const baseUrl = envOr('QUALITY_BASE_URL', 'http://localhost:5199').replace(/\/$/, '');
const outDir = envOr('MEASURE_OUT_DIR', null);
const label = envOr('MEASURE_LABEL', 'run');
const headless = envOr('MEASURE_HEADLESS', '') === '1';

const { chromium } = createRequire(import.meta.url)(corePath);

/**
 * The fourteen routes the sweep measured, in the finding's own order, so a re-run answers the
 * question the finding asked rather than a friendlier one.
 */
const ROUTES = [
  '/settings', '/alerts', '/reports', '/orders', '/suppliers', '/prices', '/inventory',
  '/invoices', '/payments', '/bank', '/analytics', '/exceptions', '/dashboard', '/documents',
];
const DASH_ROUTES = new Set(['/suppliers', '/prices']);
const TEXT_THRESHOLD = 4.5;

/** Collects the measurable text on the screen and parks the handles for the second photograph. */
const collectTargets = (wantDashes) => {
  const nodes = [];
  const heading = document.querySelector('h1.page-title');
  if (heading && heading.parentElement) {
    const description = [...heading.parentElement.children].find(
      (el) => el !== heading && el.classList.contains('text-ink-muted'),
    );
    if (description) nodes.push({ kind: 'page-description', el: description });
  }
  if (wantDashes) {
    for (const span of document.querySelectorAll('span')) {
      if (span.children.length === 0 && span.textContent.trim() === '\u2014') {
        nodes.push({ kind: 'no-data-dash', el: span });
      }
    }
  }
  window.__pr21 = nodes.map((n) => n.el);
  const probe = document.createElement('canvas');
  probe.width = 1;
  probe.height = 1;
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  const rgba = (css) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  return nodes.map(({ kind, el }) => {
    const box = el.getBoundingClientRect();
    let opacity = 1;
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      opacity *= Number(getComputedStyle(n).opacity);
    }
    return {
      kind,
      classes: el.getAttribute('class') ?? '',
      text: el.textContent.trim().slice(0, 48),
      colour: rgba(getComputedStyle(el).color),
      opacityChain: Number(opacity.toFixed(3)),
      box: {
        x: Math.round(box.left), y: Math.round(box.top),
        w: Math.round(box.width), h: Math.round(box.height),
      },
    };
  });
};

/** Runs INSIDE the page: decodes both photographs and measures every box against the ground. */
const measureInPage = async ([withText, withoutText, targets, viewport]) => {
  const decode = async (b64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${b64}`;
    await image.decode();
    const surface = document.createElement('canvas');
    surface.width = image.naturalWidth;
    surface.height = image.naturalHeight;
    const ctx = surface.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    return { ctx, width: surface.width, height: surface.height };
  };
  const shown = await decode(withText);
  const ground = await decode(withoutText);
  if (shown.width !== viewport.width || shown.height !== viewport.height) {
    return { error: `the capture is ${shown.width}x${shown.height}, not the ${viewport.width}x${viewport.height} viewport` };
  }

  const channel = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (r, g, b) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const contrast = (a, b) => {
    const [hi, lo] = [a, b].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const hex = (r, g, b) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

  const rows = [];
  const broken = [];
  for (const target of targets) {
    const { x, y, w, h } = target.box;
    if (w < 4 || h < 6 || x < 0 || y < 0 || x + w > shown.width || y + h > shown.height) {
      rows.push({ ...target, skipped: 'not fully inside the viewport' });
      continue;
    }
    // The band the glyphs live in — the top and bottom slivers of a line box are leading, and a
    // neighbouring border would be the only thing that could reach them.
    const top = y + Math.max(1, Math.round(h * 0.15));
    const bottom = y + h - Math.max(1, Math.round(h * 0.15));
    const bandHeight = Math.max(1, bottom - top);
    const a = shown.ctx.getImageData(x, top, w, bandHeight).data;
    const b = ground.ctx.getImageData(x, top, w, bandHeight).data;

    let changed = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) changed += 1;
    }
    const coverage = changed / (w * bandHeight);
    if (coverage < 0.005) {
      broken.push(
        `${target.kind} at ${x},${y} ${w}x${h}: hiding the text changed ${(coverage * 100).toFixed(2)}% `
        + 'of the box. The capture is not showing what the page is showing.',
      );
      continue;
    }

    const fg = luminance(target.colour[0], target.colour[1], target.colour[2]);
    let worst = { ratio: Infinity, rgb: null };
    let best = { ratio: -Infinity, rgb: null };
    const ratios = [];
    for (let i = 0; i < b.length; i += 4) {
      const ratio = contrast(fg, luminance(b[i], b[i + 1], b[i + 2]));
      ratios.push(ratio);
      if (ratio < worst.ratio) worst = { ratio, rgb: [b[i], b[i + 1], b[i + 2]] };
      if (ratio > best.ratio) best = { ratio, rgb: [b[i], b[i + 1], b[i + 2]] };
    }
    ratios.sort((p, q) => p - q);
    rows.push({
      ...target,
      glyphCoverage: Number(coverage.toFixed(4)),
      background: hex(...worst.rgb),
      backgroundLightest: hex(...best.rgb),
      ratio: Number(worst.ratio.toFixed(3)),
      ratioMedian: Number(ratios[Math.floor(ratios.length / 2)].toFixed(3)),
      ratioBest: Number(best.ratio.toFixed(3)),
    });
  }
  return { rows, broken };
};

const failures = [];
const report = { label, baseUrl, when: new Date().toISOString(), routes: [], unrenderable: [] };

const browser = await chromium.launch({ headless, executablePath: browserPath });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    // `--glow-x/y` has a 0.12s transition that is `none` under reduce, so the orb lands where it
    // is put with no easing to wait out. Nothing else in the measurement moves.
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();

  // ---- sign in through the local demo disclosure — no password is read, typed or printed -------
  await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('details summary').first().click();
  await page.locator('details button').first().click();
  await page.waitForURL(/\/(dashboard|orders|pay|documents)/, { timeout: 45000 });

  for (const theme of ['light', 'dark']) {
    await page.evaluate((wanted) => window.localStorage.setItem('inplace.theme', wanted), theme);
    await page.reload({ waitUntil: 'domcontentloaded' });
    const applied = await page.evaluate(() => document.documentElement.dataset.theme ?? 'light');
    if (applied !== theme) {
      throw new Error(`the ${theme} theme did not apply — the document reports "${applied}"`);
    }

    for (const route of ROUTES) {
      await page.goto(`${baseUrl}${route}`, { waitUntil: 'domcontentloaded' });
      /**
       * A route that will not RENDER is reported, never silently skipped and never measured.
       * The local Supabase stack is shared between agents and can sit many migrations behind the
       * tree; a screen whose query names a column the database has not got shows an error card
       * with no heading at all. That is a fact about the stack, not a contrast result, and the
       * run says so out loud instead of quietly measuring thirteen routes and claiming fourteen.
       */
      const rendered = await page.waitForSelector('h1.page-title', { timeout: 20000 })
        .then(() => true).catch(() => false);
      if (!rendered) {
        const reason = await page.evaluate(() => document.body.innerText.trim().split('\n').at(-1) ?? '');
        report.unrenderable.push({ theme, route, reason: reason.slice(0, 120) });
        continue;
      }
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(900);

      // Park the orb's centre on the description: the worst position a reader can put it in, and
      // one every reader can, because it follows the pointer.
      const anchor = await page.evaluate(() => {
        const heading = document.querySelector('h1.page-title');
        const description = heading && heading.parentElement
          ? [...heading.parentElement.children].find(
            (el) => el !== heading && el.classList.contains('text-ink-muted'),
          )
          : null;
        const box = (description ?? heading)?.getBoundingClientRect();
        return box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null;
      });
      if (anchor) {
        await page.evaluate(({ x, y }) => {
          const style = document.documentElement.style;
          style.setProperty('--glow-x', `${((x / window.innerWidth) * 100).toFixed(1)}%`);
          style.setProperty('--glow-y', `${((y / window.innerHeight) * 100).toFixed(1)}%`);
        }, anchor);
        await page.waitForTimeout(300);
      }

      const targets = await page.evaluate(collectTargets, DASH_ROUTES.has(route));
      const shown = await page.screenshot({ scale: 'css' });
      await page.evaluate(() => {
        for (const el of window.__pr21) el.style.setProperty('color', 'transparent', 'important');
      });
      await page.waitForTimeout(120);
      const ground = await page.screenshot({ scale: 'css' });
      await page.evaluate(() => {
        for (const el of window.__pr21) el.style.removeProperty('color');
      });

      const measured = await page.evaluate(measureInPage, [
        shown.toString('base64'), ground.toString('base64'), targets, { width: 1440, height: 900 },
      ]);
      if (measured.error) throw new Error(`[${theme}] ${route} — ${measured.error}`);
      if (measured.broken.length) {
        throw new Error(`[${theme}] ${route} — the measurement is not trustworthy:\n  ${measured.broken.join('\n  ')}`);
      }

      for (const row of measured.rows) {
        if (row.skipped) continue;
        if (row.colour[3] !== 1 || row.opacityChain !== 1) {
          throw new Error(
            `[${theme}] ${route} — ${row.kind} is not opaque (alpha ${row.colour[3]}, opacity chain `
            + `${row.opacityChain}); this measurement does not model it.`,
          );
        }
        if (row.ratio < TEXT_THRESHOLD) {
          failures.push(
            `[${theme}] ${route} ${row.kind} "${row.text}" = ${row.ratio}:1 (median ${row.ratioMedian}) `
            + `on the composited ground ${row.background} — needs ${TEXT_THRESHOLD}:1 — ${row.classes}`,
          );
        }
      }

      const description = measured.rows.find((r) => r.kind === 'page-description' && !r.skipped);
      const dashes = measured.rows.filter((r) => r.kind === 'no-data-dash' && !r.skipped);
      report.routes.push({
        theme,
        route,
        descriptionBackground: description ? description.background : null,
        descriptionRatio: description ? description.ratio : null,
        dashCount: dashes.length,
        dashWorst: dashes.length ? Math.min(...dashes.map((d) => d.ratio)) : null,
        groundSha256: createHash('sha256').update(ground).digest('hex'),
        rows: measured.rows,
      });
      if (outDir && (route === '/prices' || route === '/dashboard')) {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, `PR21-${label}-${theme}${route.replace(/\//g, '_')}-1440x900.png`), shown);
      }
    }
  }
} finally {
  await browser.close();
}

if (outDir) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `PR21-${label}-measurements.json`), `${JSON.stringify(report, null, 2)}\n`);
}

console.log(`measure-composited-contrast [${label}] — worst composited ground under each text, 1440x900\n`);
for (const entry of report.routes) {
  console.log(
    `${entry.theme.padEnd(5)} ${entry.route.padEnd(12)} description ${String(entry.descriptionRatio).padStart(6)}:1 `
    + `on ${entry.descriptionBackground}`
    + (entry.dashCount ? `   |  ${entry.dashCount} "—" marker(s), worst ${entry.dashWorst}:1` : ''),
  );
}

/**
 * The light theme must not move by a pixel where the orb is the only thing that changed. The
 * text-free photograph is the direct reading of that claim: it is the page's own ground with
 * every measured glyph removed, so it is unaffected by a text COLOUR change and moves only if
 * the background does.
 */
console.log('\nlight-theme ground, per route — the hash of the text-free capture:');
for (const entry of report.routes.filter((r) => r.theme === 'light')) {
  console.log(`  ${entry.route.padEnd(12)} ${entry.descriptionBackground}  ground ${entry.groundSha256}`);
}

if (report.unrenderable.length > 0) {
  console.log('\nNOT MEASURED — the route did not render against this stack:');
  for (const entry of report.unrenderable) {
    console.log(`  [${entry.theme}] ${entry.route} — ${entry.reason}`);
  }
}

if (failures.length > 0) {
  console.error(`\nmeasure-composited-contrast [${label}] FAILED — ${failures.length} measurement(s) below ${TEXT_THRESHOLD}:1:`);
  for (const line of failures) console.error(`  ${line}`);
  process.exit(1);
}

console.log(
  `\nmeasure-composited-contrast [${label}] passed: ${report.routes.length} route/theme pass(es), `
  + 'every measured box at or above 4.5:1 on the worst pixel actually painted under it.',
);
