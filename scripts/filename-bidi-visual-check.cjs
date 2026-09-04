// Rendered measurement of the file-name bidi contract — DOC-07, RTL-A11Y-08.
//
// WHY THIS FILE EXISTS AT ALL. `src/lib/fileNameIsolation.spec.ts` was green on the deploy where
// this defect was measured, and it was not lying: it is a SOURCE SCAN, and a source scan proves
// that every site carries an isolation form. It cannot see what the form does to pixels. `<bdi>`
// and `dir="auto"` resolve the name's own direction from its FIRST STRONG character; digits are
// not strong, so `93_00002007 — חלק 3.pdf` resolves RTL and the Latin runs inside it are
// reordered anyway. The scan stays — it is doing a real job — and this is the half it could
// never do.
//
// WHAT IS MEASURED. Per-character `Range` rectangles on the real screen, sorted by screen x. That
// is the reader's order, not the DOM string's order — reading `textContent` here would report the
// logical name and call a scrambled screen correct.
//
// TWO CLAIMS PER NAME, both taken from the two findings' own oracles:
//   1. "extension last"  — the visual string ENDS with the file's extension, dot included.
//   2. "the name shown is the name of the file" — every technical run in the name (digits,
//      Latin, `_`, `-`) survives as a contiguous substring in its own order. `00002007_93` is the
//      shape of the defect.
//
// THE TWO CONTROLS ARE THE POINT. `ADTV Ltd receipt 7352.pdf` and `invoice-2026-08 סופי.pdf` are
// expected to pass BEFORE the fix as well — a Latin-only name and a name whose first strong
// character is already Latin. A run in which everything fails is a broken harness, not a finding.
//
// NO DATABASE AND NO SIGN-IN. Every Supabase call is answered from a fixture and the client points
// at a dead port, so this never touches the shared local stack (which sits at migration head 0245
// while this tree carries 0314). Shape copied from `scripts/mobile-columns-visual-check.cjs`.
//
//   node scripts/filename-bidi-visual-check.cjs
const { chromium } = require('playwright-core');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');

// Forward slashes: ROOT is interpolated into the harness's own module specifiers, where a Windows
// backslash would be read as an escape.
const ROOT = join(__dirname, '..').replace(/\\/g, '/');
const HARNESS = join(ROOT, '.tmp', 'pr34-filename-bidi');
const OUT = join(ROOT, 'docs', 'qa', '2026-09-04', 'evidence');
const PORT = 5199 + 734; // away from dev (5199) and from the other visual checks

// --------------------------------------------------------------------------- the names measured

/** `expectPassUnfixed` marks the controls: names that render correctly even with the defect in
 *  place, because their first strong character is already Latin (or there is no Hebrew at all). */
const NAMES = [
  { name: '93_00002007 — חלק 3.pdf', expectPassUnfixed: false }, // RTL-A11Y-08's own example
  { name: 'א.ע עלים ירוקים — חשבונית 2026-08.jpeg', expectPassUnfixed: false }, // DOC-07's own example
  { name: 'חשבונית ספק לבדיקה.pdf', expectPassUnfixed: false },
  { name: 'invoice-2026-08 סופי.pdf', expectPassUnfixed: true }, // control — the spec's worked example
  { name: 'ADTV Ltd receipt 7352.pdf', expectPassUnfixed: true }, // control — Latin only
];

// --------------------------------------------------------------------------- harness sources

const AUTH_STUB = `import { createContext, useContext } from 'react';
const value = {
  profile: { id: 'user-1', role: 'owner', org_id: 'org-test', full_name: 'בודק' },
  org: { id: 'org-test', name: 'עסק לדוגמה', settings: {}, base_currency: 'ILS' },
  session: {},
  roleLabels: {},
  organizationAccess: { mode: 'active', canWrite: true },
};
const Ctx = createContext(value);
export function useAuth() { return useContext(Ctx); }
export function AuthProvider({ children }) { return <Ctx.Provider value={value}>{children}</Ctx.Provider>; }
export default { useAuth, AuthProvider };
`;

const ENTRY = `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import '${ROOT}/src/index.css';
import { LocaleProvider } from '${ROOT}/src/lib/i18n/LocaleProvider';
import { createAppQueryClient } from '${ROOT}/src/lib/query/client';
import { OrgScopeProvider } from '${ROOT}/src/lib/query/orgScope';
import { ToastProvider } from '${ROOT}/src/components/ui';
import DocumentsGallery from '${ROOT}/src/pages/DocumentsInbox';

function Harness() {
  return (
    <LocaleProvider initialLocale="he">
      <QueryClientProvider client={createAppQueryClient()}>
        <OrgScopeProvider org="org-test">
          <ToastProvider>
            <MemoryRouter initialEntries={['/documents']}>
              <Routes><Route path="/documents" element={<DocumentsGallery />} /></Routes>
            </MemoryRouter>
          </ToastProvider>
        </OrgScopeProvider>
      </QueryClientProvider>
    </LocaleProvider>
  );
}

// vite dev injects the stylesheet AFTER first paint; a screenshot taken before that is of an
// unstyled page, and an unstyled page measures a different line box.
function mountWhenTokensResolve() {
  const style = getComputedStyle(document.documentElement);
  const ready = ['--color-canvas', '--color-ink-body', '--color-surface-sunken']
    .every((name) => style.getPropertyValue(name).trim() !== '');
  if (!ready) { requestAnimationFrame(mountWhenTokensResolve); return; }
  createRoot(document.getElementById('root')).render(<StrictMode><Harness /></StrictMode>);
}
mountWhenTokensResolve();
`;

const HTML = `<!doctype html>
<html dir="rtl" lang="he"><head><meta charset="utf-8"><title>pr34 file-name bidi</title></head>
<body class="bg-canvas"><div id="root"></div><script type="module" src="./entry.tsx"></script></body></html>
`;

// A DEAD port on purpose — nothing listens on 59999, so a route this harness forgot fails loudly
// instead of quietly reaching the shared local stack.
const ENV = `VITE_SUPABASE_URL=http://127.0.0.1:59999
VITE_SUPABASE_ANON_KEY=harness-anon-key-not-a-secret
`;

const CONFIG = `import base from '${ROOT}/vite.config.ts';

const stubAuth = {
  name: 'pr34-harness-auth-stub',
  enforce: 'pre',
  resolveId(source) {
    if (/(^|[\\\\/])auth[\\\\/]AuthContext(\\.tsx?)?$/.test(source)) {
      return '${HARNESS.replace(/\\/g, '/')}/authStub.tsx';
    }
    return null;
  },
};

export default {
  ...base,
  // ROOT, not the harness folder: Tailwind v4 auto-detects its sources from the vite root, and a
  // root inside .tmp generates neither \`hidden\` nor \`lg:hidden\`, so both bodies paint at 390px.
  root: '${ROOT}',
  envDir: '${HARNESS.replace(/\\/g, '/')}',
  // Its OWN cache. The shared \`node_modules/.vite\` is a collision between two agents running two
  // harnesses at once, and the symptom is a stale optimised dependency, not an error.
  cacheDir: '${HARNESS.replace(/\\/g, '/')}/.vite',
  optimizeDeps: { entries: ['.tmp/pr34-filename-bidi/index.html'] },
  plugins: [stubAuth, ...(base.plugins ?? [])],
  build: undefined,
};
`;

// --------------------------------------------------------------------------------- fixtures

const document_ = (id, fileName, created) => ({
  id, org_id: 'org-test', entity_type: 'inbox', entity_id: null,
  storage_path: `org-test/inbox/${id}_x.pdf`, file_name: fileName,
  mime_type: fileName.endsWith('.jpeg') ? 'image/jpeg' : 'application/pdf',
  document_kind: 'supplier_invoice', supplier_id: 'sup-1', document_date: '2026-08-01',
  uploaded_by: 'user-1', created_at: created, deleted_at: null, deleted_by: null,
  supplier: { id: 'sup-1', name: 'א.ע עלים ירוקים' },
});

const FIXTURES = {
  suppliers: [{ id: 'sup-1', name: 'א.ע עלים ירוקים' }],
  documents: NAMES.map((entry, index) =>
    document_(`doc-${index + 1}`, entry.name, `2026-08-${String(20 - index).padStart(2, '0')}T09:00:00Z`)),
  document_auto_actions: [],
  document_processing_jobs: [],
  profiles: [],
  document_export_templates: [],
};

// ------------------------------------------------------------------------------------- run

async function main() {
  mkdirSync(HARNESS, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(HARNESS, 'entry.tsx'), ENTRY, 'utf8');
  writeFileSync(join(HARNESS, 'authStub.tsx'), AUTH_STUB, 'utf8');
  writeFileSync(join(HARNESS, 'index.html'), HTML, 'utf8');
  writeFileSync(join(HARNESS, '.env'), ENV, 'utf8');
  writeFileSync(join(HARNESS, 'vite.harness.config.ts'), CONFIG, 'utf8');

  const viteBin = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const server = spawn(
    process.execPath,
    [viteBin, ROOT, '--config', join(HARNESS, 'vite.harness.config.ts'),
      '--port', String(PORT), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let serverLog = '';
  const echo = (d) => { const text = d.toString(); serverLog += text; process.stdout.write(`[vite] ${text}`); };
  server.stdout.on('data', echo);
  server.stderr.on('data', echo);

  const baseURL = `http://localhost:${PORT}`;
  console.log(`waiting for vite on ${PORT}...`);
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`vite did not start in 90s:\n${serverLog}`)), 90000);
    const poll = setInterval(() => {
      if (/ready in|Local:\s+http/i.test(serverLog)) { clearInterval(poll); clearTimeout(deadline); resolve(); }
    }, 200);
  });

  // The bundled chromium fails with `spawn UNKNOWN` on this machine; system Edge does not. Headed,
  // because headless misses injected CSS here (memory: headless-screenshot-stale-css).
  const browser = await chromium.launch({
    headless: false,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM
      ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  });

  const shots = [];
  const findings = [];
  const measured = [];
  const missedRoutes = [];
  try {
    for (const [label, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
      const context = await browser.newContext({
        viewport: { width, height }, locale: 'he-IL', serviceWorkers: 'block',
        reducedMotion: 'reduce', deviceScaleFactor: 2,
      });
      await context.route('**/127.0.0.1:59999/**', async (route) => {
        const url = new URL(route.request().url());
        const name = url.pathname.replace(/^\/rest\/v1\//, '').replace(/^rpc\//, 'rpc:').split('?')[0];
        const body = FIXTURES[name];
        if (body === undefined) missedRoutes.push(`${label}: ${url.pathname}`);
        const rows = body ?? [];
        await route.fulfill({
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-range': rows.length ? `0-${rows.length - 1}/${rows.length}` : '*/0',
          },
          body: JSON.stringify(rows),
        });
      });
      const page = await context.newPage();
      page.on('pageerror', (e) => findings.push(`${label}: page error ${e.message}`));

      await page.goto(`${baseURL}/.tmp/pr34-filename-bidi/index.html`, { waitUntil: 'load', timeout: 60000 });
      await page.locator('h1').first().waitFor({ timeout: 30000 });
      await page.waitForTimeout(1500);

      const styled = await page.evaluate(() => ({
        token: getComputedStyle(document.documentElement).getPropertyValue('--color-canvas').trim(),
        size: document.querySelector('h1') ? getComputedStyle(document.querySelector('h1')).fontSize : '0px',
        dir: getComputedStyle(document.documentElement).direction,
      }));
      if (!styled.token || parseFloat(styled.size) <= 16) {
        findings.push(`${label}: page is unstyled (--color-canvas="${styled.token}", h1 ${styled.size})`);
      }
      if (styled.dir !== 'rtl') findings.push(`${label}: page is not RTL (direction=${styled.dir})`);

      const rows = await page.evaluate((names) => {
        /**
         * The reader's order: one Range per character, grouped into LINES by the top of its
         * rectangle and then sorted by x within the line. Sorting by x alone interleaves the
         * two lines of a wrapped mobile card and reports a scramble that nobody sees.
         */
        const visualOrder = (el) => {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          const glyphs = [];
          let node;
          while ((node = walker.nextNode())) {
            for (let i = 0; i < node.data.length; i += 1) {
              const range = document.createRange();
              range.setStart(node, i); range.setEnd(node, i + 1);
              const rect = range.getBoundingClientRect();
              glyphs.push({ ch: node.data[i], x: rect.left, top: Math.round(rect.top), w: rect.width });
            }
          }
          // Zero-width glyphs are dropped: a space collapsed at a line break, and the isolate
          // control characters themselves, draw nothing and have no place on the reader's line.
          const drawn = glyphs.filter((g) => g.w > 0 && !/[\u2066-\u2069]/.test(g.ch));
          const lines = new Map();
          for (const glyph of drawn) {
            if (!lines.has(glyph.top)) lines.set(glyph.top, []);
            lines.get(glyph.top).push(glyph);
          }
          return [...lines.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, line]) => line.sort((a, b) => a.x - b.x).map((g) => g.ch).join(''));
        };
        const out = [];
        for (const name of names) {
          // The DEEPEST element whose whole text is the name — the element that actually draws it.
          const drawing = [...document.querySelectorAll('*')].filter((el) =>
            el.textContent.trim() === name.trim()
            && ![...el.children].some((child) => child.textContent.trim() === name.trim())
            && el.getClientRects().length > 0);
          for (const el of drawing) {
            const lines = visualOrder(el);
            out.push({
              name,
              tag: el.tagName,
              dirAttr: el.getAttribute('dir'),
              direction: getComputedStyle(el).direction,
              unicodeBidi: getComputedStyle(el).unicodeBidi,
              lines,
              visual: lines.join(''),
            });
          }
        }
        return out;
      }, NAMES.map((entry) => entry.name));

      for (const entry of NAMES) {
        const drawn = rows.filter((row) => row.name === entry.name);
        if (!drawn.length) {
          findings.push(`${label}: "${entry.name}" is not drawn anywhere on /documents — nothing to measure`);
          continue;
        }
        for (const row of drawn) {
          // A truncated cell would measure a shortened string; that is not a bidi finding and must
          // not be reported as one. Spaces are excluded from the comparison because a space at a
          // line break collapses to zero width and is genuinely not drawn.
          const bag = (s) => [...s.replace(/\s+/g, '')].sort().join('');
          if (bag(row.visual) !== bag(entry.name)) {
            findings.push(`${label}: "${entry.name}" measured ${bag(row.visual).length} drawn characters of ${bag(entry.name).length} on <${row.tag}> — clipped, not measurable`);
            continue;
          }
          const extension = entry.name.slice(entry.name.lastIndexOf('.'));
          const stem = entry.name.slice(0, entry.name.lastIndexOf('.'));
          const problems = [];
          if (!row.visual.endsWith(extension)) {
            problems.push(`the extension "${extension}" is not last — the rendered name ends "${row.visual.slice(-8)}"`);
          }
          // Every technical run of two characters or more IN THE STEM, in its own order.
          //
          // THE STEM, AND NOT THE WHOLE NAME — measured, and the reason is worth writing down.
          // In `93_00002007 — חלק 3.pdf` the characters `3.pdf` look like one technical run, and
          // they are not: the `3` belongs to the Hebrew phrase «חלק 3» and renders inside it,
          // correctly, to the left of the word. In `א.ע … חשבונית 2026-08.jpeg` the `2026-08`
          // likewise belongs to «חשבונית 2026-08» and reads correctly within that phrase. The
          // bidi algorithm cannot know which trailing digits are part of the Hebrew sentence and
          // which are part of the file's technical stem, and neither can anything else: the only
          // mechanism that would drag them out is an LRM before each run, which was measured on
          // this machine and DESTROYS Hebrew word order — `חשבונית ספק לבדיקה.pdf` came back as
          // `תינובשח קפס הקידבל.pdf`, three words laid out left to right. So the claim made here
          // is the one the two findings actually make and the one a fix can honour: the extension
          // is last, and no technical run in the stem is reordered. `00002007_93` — the shape of
          // the defect — fails it.
          for (const run of stem.match(/[\x21-\x7E]{2,}/g) ?? []) {
            if (!row.visual.includes(run)) problems.push(`the run "${run}" is broken or reordered`);
          }
          const shown = row.lines.join(' ⏎ '); // ⏎ marks a line break inside the drawn name
          measured.push({
            viewport: label, name: entry.name, tag: row.tag, dirAttr: row.dirAttr,
            direction: row.direction, unicodeBidi: row.unicodeBidi,
            visual: shown, ok: problems.length === 0, problems,
          });
          if (problems.length) {
            findings.push(`${label}: <${row.tag} dir=${row.dirAttr ?? 'null'}> "${entry.name}"\n      renders as "${shown}"\n      ${problems.join('\n      ')}`);
          }
        }
      }

      // `PR34_SHOT=BEFORE npm …` on the unfixed tree, `AFTER` once the fix is in — the pair is
      // the evidence, and one file overwritten by the second run would leave only half of it.
      const suffix = process.env.PR34_SHOT ? `-${process.env.PR34_SHOT}` : '';
      const shot = join(OUT, `PR34-documents-${label}-${width}x${height}${suffix}.png`);
      await page.screenshot({ path: shot, fullPage: label === 'mobile' });
      shots.push(shot);
      await context.close();
    }
  } finally {
    await browser.close();
    server.kill();
  }

  console.log('\n--- measured (visual order, left to right) ---');
  for (const row of measured) {
    console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.viewport}  <${row.tag} dir=${row.dirAttr ?? 'null'}> direction=${row.direction} unicode-bidi=${row.unicodeBidi}`);
    console.log(`      logical: ${row.name}`);
    console.log(`      visual : ${row.visual}`);
    for (const problem of row.problems) console.log(`      ! ${problem}`);
  }

  const controls = measured.filter((row) => NAMES.find((n) => n.name === row.name)?.expectPassUnfixed);
  const brokenControls = controls.filter((row) => !row.ok);
  if (brokenControls.length) {
    findings.push(`the CONTROLS failed (${brokenControls.map((r) => r.name).join(', ')}) — a run where every name fails is a broken harness, not a finding`);
  }
  if (!controls.length) findings.push('no control name was measured at all — the harness proved nothing');

  console.log(`\nscreenshots:\n  ${shots.join('\n  ')}`);
  if (missedRoutes.length) console.log(`\nroutes answered empty: ${[...new Set(missedRoutes)].join(', ')}`);
  if (findings.length) {
    console.error(`\nFINDINGS (${findings.length}):\n  ` + findings.join('\n  '));
    process.exitCode = 1;
  } else {
    console.log(`\nfile-name bidi check completed with no findings — ${measured.length} rendered names measured`);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
