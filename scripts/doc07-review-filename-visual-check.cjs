// Rendered measurement of the file name on /documents/:documentId/review — DOC-07.
//
// WHY A SECOND SCRIPT BESIDE `filename-bidi-visual-check.cjs`. That one measures /documents, the
// folder. This one measures the REVIEW screen, and it exists because that screen was the hole in
// DOC-07's "25 sites" claim: `DocumentSourceViewer.tsx:65` drew `{fileName}` with no isolation of
// any kind, and the source scan could not see it — its detector required a DOT before the name,
// so a destructured prop was invisible. Nothing measured this screen, so nothing contradicted the
// row.
//
// WHAT MAKES THE SCREENSHOT WORTH READING. The same file name is drawn TWICE here: once in the
// record header, which has always carried `<bdi dir="ltr">`, and once in the source viewer, which
// did not. One name, one screen, two renderings — the defect and its own control, side by side.
//
// WHAT IS MEASURED. Per-character `Range` rectangles sorted by screen x — the reader's order, not
// the DOM string's. Reading `textContent` would report the logical name and call a scrambled
// screen correct. Claims per drawn copy, the same two `filename-bidi-visual-check.cjs` makes:
//   1. the visual string ENDS with the extension, dot included;
//   2. every technical run of two or more ASCII characters in the stem survives contiguous and in
//      its own order. `00002007_93` is the shape of the defect.
//
// NO DATABASE AND NO SIGN-IN. Every Supabase call is answered from a fixture and the client points
// at a dead port, so this never touches the shared local stack.
//
//   DOC07_SHOT=BEFORE node scripts/doc07-review-filename-visual-check.cjs   (unfixed tree)
//   DOC07_SHOT=AFTER  node scripts/doc07-review-filename-visual-check.cjs   (fixed tree)
const { chromium } = require('playwright-core');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');

// Forward slashes: ROOT is interpolated into the harness's own module specifiers, where a Windows
// backslash would be read as an escape.
const ROOT = join(__dirname, '..').replace(/\\/g, '/');
const HARNESS = join(ROOT, '.tmp', 'doc07-review-filename');
const OUT = join(ROOT, 'docs', 'qa', '2026-09-04', 'evidence');
const PORT = 5199 + 741; // away from dev (5199) and from the other visual checks

/**
 * The name under test: digits first, then Hebrew. Digits are not strong, so the run takes its
 * direction from `חלק` and an un-isolated copy renders `jpeg.3 קלח — 00002007_93`.
 * `.jpeg` rather than the `.pdf` of RTL-A11Y-08's original, so the viewer paints an image instead
 * of pulling pdf.js into the harness; the bidi shape — Latin/technical stem, Hebrew word, Latin
 * extension — is identical.
 */
const NAME = '93_00002007 — חלק 3.jpeg';

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
import DocumentReview from '${ROOT}/src/pages/DocumentReview';

function Harness() {
  return (
    <LocaleProvider initialLocale="he">
      <QueryClientProvider client={createAppQueryClient()}>
        <OrgScopeProvider org="org-test">
          <ToastProvider>
            <MemoryRouter initialEntries={['/documents/doc-1/review']}>
              <Routes>
                <Route path="/documents/:documentId/review" element={<main className="mx-auto w-full max-w-7xl p-6"><DocumentReview /></main>} />
              </Routes>
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
<html dir="rtl" lang="he"><head><meta charset="utf-8"><title>doc07 review file name</title></head>
<body class="bg-canvas"><div id="root"></div><script type="module" src="./entry.tsx"></script></body></html>
`;

// A DEAD port on purpose — nothing listens on 59999, so a route this harness forgot fails loudly
// instead of quietly reaching the shared local stack.
const ENV = `VITE_SUPABASE_URL=http://127.0.0.1:59999
VITE_SUPABASE_ANON_KEY=harness-anon-key-not-a-secret
`;

const CONFIG = `import base from '${ROOT}/vite.config.ts';

const stubAuth = {
  name: 'doc07-harness-auth-stub',
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
  // ROOT, not the harness folder: Tailwind v4 auto-detects its sources from the vite root.
  root: '${ROOT}',
  envDir: '${HARNESS.replace(/\\/g, '/')}',
  // Its OWN cache. The shared \`node_modules/.vite\` is a collision between two agents running two
  // harnesses at once, and the symptom is a stale optimised dependency, not an error.
  cacheDir: '${HARNESS.replace(/\\/g, '/')}/.vite',
  optimizeDeps: { entries: ['.tmp/doc07-review-filename/index.html'] },
  plugins: [stubAuth, ...(base.plugins ?? [])],
  build: undefined,
};
`;

// --------------------------------------------------------------------------------- fixtures

const NOW = '2026-08-20T09:00:00Z';

const JOB = {
  id: 'job-1', org_id: 'org-test', document_id: 'doc-1', status: 'review',
  attempt_count: 1, created_at: NOW, updated_at: NOW, lease_until: null,
  last_error_code: null, last_error_message: null, progress_done: null, progress_total: null,
};

const DOCUMENT = {
  id: 'doc-1', org_id: 'org-test', entity_type: 'inbox', entity_id: null,
  storage_path: 'org-test/inbox/doc-1.jpeg', file_name: NAME, mime_type: 'image/jpeg',
  document_kind: 'supplier_invoice', supplier_id: 'sup-1', document_date: '2026-08-01',
  uploaded_by: 'user-1', created_at: NOW, deleted_at: null, deleted_by: null,
};

const EXTRACTION = {
  id: 'extraction-1', org_id: 'org-test', job_id: 'job-1', document_id: 'doc-1',
  engine: 'openai', model: 'gpt-4o-mini', model_version: '2026-05',
  input_checksum: 'etag:1111111111111111', contract_version: '1', created_at: NOW,
  payload: {
    schema_version: '1',
    document: { page_count: 1, detected_languages: ['heb'], plain_text: '', partial: false },
    blocks: [{ id: 'block-1', page: 1, type: 'text', bbox: [0, 0.26, 1, 0.3], text: 'ספק בע״מ', confidence: 0.91 }],
    tables: [],
    marks: [],
  },
};

const INTERPRETATION = {
  id: 'interpretation-1', org_id: 'org-test', job_id: 'job-1', document_id: 'doc-1',
  provider: 'openai', model: 'gpt-4o-mini', prompt_version: '3', schema_version: '1',
  suggested_supplier_id: null, created_at: NOW,
  payload: {
    schema_version: '1',
    document_type: 'invoice',
    document_type_confidence: 0.95,
    supplier: { suggested_id: null, suggested_name: 'ספק בע״מ', confidence: 0.95, evidence_block_ids: ['block-1'] },
    fields: [{ key: 'invoice_number', value: 'INV-1042', confidence: 0.95, evidence_block_ids: ['block-1'] }],
    line_items: [],
    suggested_annotations: [],
  },
};

const FIXTURES = {
  'rpc:get_document_processing_statuses': [JOB],
  documents: [DOCUMENT],
  document_extractions: [EXTRACTION],
  document_interpretations: [INTERPRETATION],
  suppliers: [{ id: 'sup-1', name: 'ספק בע״מ' }],
};

/** A 2x2 grey PNG. The viewer only has to paint something; the file name is what is measured. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP8//8/AzJgYkAFAB8FAwFwPiJhAAAAAElFTkSuQmCC',
  'base64',
);

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

  const findings = [];
  const measured = [];
  const missedRoutes = [];
  let shot = '';
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 }, locale: 'he-IL', serviceWorkers: 'block',
      reducedMotion: 'reduce', deviceScaleFactor: 2,
    });
    await context.route('**/127.0.0.1:59999/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/storage/v1/object/sign')) {
        // Two shapes on one path: the POST that ASKS for a signed url, and the GET that follows it.
        if (route.request().method() === 'POST') {
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ signedURL: '/object/sign/documents/doc-1.jpeg?token=harness' }),
          });
          return;
        }
        await route.fulfill({ status: 200, headers: { 'content-type': 'image/png' }, body: PNG });
        return;
      }
      const name = url.pathname.replace(/^\/rest\/v1\//, '').replace(/^rpc\//, 'rpc:').split('?')[0];
      const body = FIXTURES[name];
      if (body === undefined) missedRoutes.push(url.pathname);
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
    page.on('pageerror', (e) => findings.push(`page error ${e.message}`));

    await page.goto(`${baseURL}/.tmp/doc07-review-filename/index.html`, { waitUntil: 'load', timeout: 60000 });
    await page.locator('[data-testid="document-source-viewer"]').waitFor({ timeout: 30000 });
    await page.waitForTimeout(1500);

    const styled = await page.evaluate(() => ({
      token: getComputedStyle(document.documentElement).getPropertyValue('--color-canvas').trim(),
      size: document.querySelector('h1') ? getComputedStyle(document.querySelector('h1')).fontSize : '0px',
      dir: getComputedStyle(document.documentElement).direction,
    }));
    if (!styled.token || parseFloat(styled.size) <= 16) {
      findings.push(`page is unstyled (--color-canvas="${styled.token}", h1 ${styled.size})`);
    }
    if (styled.dir !== 'rtl') findings.push(`page is not RTL (direction=${styled.dir})`);

    const rows = await page.evaluate((name) => {
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
        // Zero-width glyphs are dropped: a space collapsed at a line break, and the isolate control
        // characters themselves, draw nothing and have no place on the reader's line.
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
      // The DEEPEST element whose whole text is the name — the element that actually draws it.
      const drawing = [...document.querySelectorAll('*')].filter((el) =>
        el.textContent.trim() === name.trim()
        && ![...el.children].some((child) => child.textContent.trim() === name.trim())
        && el.getClientRects().length > 0);
      return drawing.map((el) => {
        const lines = visualOrder(el);
        return {
          where: el.closest('[data-testid="document-source-viewer"]') ? 'source viewer'
            : el.closest('header, [class*="record"]') ? 'record header' : 'elsewhere on the screen',
          tag: el.tagName,
          dirAttr: el.getAttribute('dir'),
          direction: getComputedStyle(el).direction,
          unicodeBidi: getComputedStyle(el).unicodeBidi,
          lines,
          visual: lines.join(''),
        };
      });
    }, NAME);

    if (!rows.length) findings.push(`"${NAME}" is not drawn anywhere on the review screen — nothing to measure`);

    const extension = NAME.slice(NAME.lastIndexOf('.'));
    const stem = NAME.slice(0, NAME.lastIndexOf('.'));
    for (const row of rows) {
      const bag = (s) => [...s.replace(/\s+/g, '')].sort().join('');
      if (bag(row.visual) !== bag(NAME)) {
        findings.push(`"${NAME}" measured ${bag(row.visual).length} drawn characters of ${bag(NAME).length} on <${row.tag}> — clipped, not measurable`);
        continue;
      }
      const problems = [];
      if (!row.visual.endsWith(extension)) {
        problems.push(`the extension "${extension}" is not last — the rendered name ends "${row.visual.slice(-8)}"`);
      }
      for (const run of stem.match(/[\x21-\x7E]{2,}/g) ?? []) {
        if (!row.visual.includes(run)) problems.push(`the run "${run}" is broken or reordered`);
      }
      measured.push({
        where: row.where, tag: row.tag, dirAttr: row.dirAttr,
        direction: row.direction, unicodeBidi: row.unicodeBidi,
        visual: row.lines.join(' ⏎ '), ok: problems.length === 0, problems,
      });
      if (problems.length) {
        findings.push(`${row.where}: <${row.tag} dir=${row.dirAttr ?? 'null'}> renders "${row.lines.join(' ⏎ ')}"\n      ${problems.join('\n      ')}`);
      }
    }

    const suffix = process.env.DOC07_SHOT ? `-${process.env.DOC07_SHOT}` : '';
    shot = join(OUT, `DOC07-review-desktop-1440x900${suffix}.png`);
    await page.screenshot({ path: shot });
    await context.close();
  } finally {
    await browser.close();
    server.kill();
  }

  console.log('\n--- measured (visual order, left to right) ---');
  for (const row of measured) {
    console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.where}  <${row.tag} dir=${row.dirAttr ?? 'null'}> direction=${row.direction} unicode-bidi=${row.unicodeBidi}`);
    console.log(`      logical: ${NAME}`);
    console.log(`      visual : ${row.visual}`);
    for (const problem of row.problems) console.log(`      ! ${problem}`);
  }

  // THE CONTROL. The record header has carried `<bdi dir="ltr">` since before this finding, so it
  // must read correctly in BOTH runs. A run where every copy fails is a broken harness, not a
  // finding — and one where the header alone fails means the harness, not the screen, is at fault.
  const header = measured.filter((row) => row.where === 'record header');
  if (!header.length) findings.push('the record header copy of the name was not measured — the control is missing and this run proves nothing');
  else if (header.some((row) => !row.ok)) findings.push('the CONTROL failed: the record header, isolated since before this finding, does not read correctly — broken harness');

  console.log(`\nscreenshot: ${shot}`);
  if (missedRoutes.length) console.log(`\nroutes answered empty: ${[...new Set(missedRoutes)].join(', ')}`);
  if (findings.length) {
    console.error(`\nFINDINGS (${findings.length}):\n  ` + findings.join('\n  '));
    process.exitCode = 1;
  } else {
    console.log(`\nreview-screen file-name check completed with no findings — ${measured.length} rendered copies measured`);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
