// Visual verification of PR 38 — the price-intake doors (PL-03..PL-08, PL-11, PL-12).
//
// The unit oracles prove the DOM. A picture settles what a DOM assertion cannot: that a preview
// row which has just gained two badges still reads as a row, that a ledger cell which now carries
// three numbers still fits its column, and that a queue split into work and confirmations still
// looks like one screen.
//
// HEADED ON PURPOSE — headless misses injected CSS on this machine
// (memory: headless-screenshot-stale-css). Shape copied from
// `scripts/mobile-columns-visual-check.cjs`, which is what this repo already trusts.
//
// NO DATABASE AND NO SIGN-IN. Every Supabase call is answered by Playwright from a fixture, and
// the client is pointed at a DEAD port on purpose: the shared local stack is at ledger head 0245
// against a 0314 tree and is held by another agent for this wave, so a missed route must fail
// loudly here instead of quietly reaching it.
//
//   node <this file>
const { chromium } = require('playwright-core');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');

// Forward slashes: ROOT is interpolated into the harness's own module specifiers, where a Windows
// backslash would be read as an escape.
const ROOT = join(__dirname, '..').replace(/\\/g, '/');
const HARNESS = join(ROOT, '.tmp', 'pr38-visual');
const OUT = join(ROOT, 'docs', 'qa', '2026-09-04', 'evidence');
const PORT = 5199 + 738; // away from dev (5199), the gate, and the other visual checks

// --------------------------------------------------------------------------- harness sources

const AUTH_STUB = `import { createContext, useContext } from 'react';
// Office, because every screen in this PR is the procurement manager's — and because PL-11's
// second half is precisely what an office user who did NOT upload the document is shown.
const value = {
  profile: { id: 'office-2', role: 'office', org_id: 'org-test', full_name: 'בודק' },
  org: { id: 'org-test', name: 'עסק לדוגמה', settings: {}, base_currency: 'ILS', vat_rate: 18 },
  session: {},
  roleLabels: {},
  organizationAccess: { mode: 'active', canWrite: true },
};
const Ctx = createContext(value);
export function useAuth() { return useContext(Ctx); }
export function AuthProvider({ children }) { return <Ctx.Provider value={value}>{children}</Ctx.Provider>; }
export default { useAuth, AuthProvider };
`;

const SNAPSHOT = `{
  documentId: 'doc-price-list', stage: 'review',
  document: {
    id: 'doc-price-list', org_id: 'org-test', unit_id: null, entity_type: 'inbox', entity_id: null,
    storage_path: 'org-test/price-list.pdf', file_name: 'פעמית מחירון.pdf',
    mime_type: 'application/pdf', document_kind: 'price_list',
    uploaded_by: 'office-1', supplier_id: null, document_date: null,
    deleted_at: null, created_at: '2026-09-02T00:00:00Z',
  },
  job: { id: 'job-1', status: 'review', last_error_code: null, last_error_message: null },
  jobs: [], extraction: null, extractions: [],
  interpretation: {
    id: 'interpretation-1', org_id: 'org-test', document_id: 'doc-price-list', provider: 'openai',
    model: 'fixture', prompt_version: 'v1', schema_version: '1', suggested_supplier_id: null,
    payload: {
      schema_version: '1', document_type: 'price_list', document_type_confidence: 0.99,
      supplier: { suggested_id: null, suggested_name: 'פעמית', confidence: 0.9, evidence_block_ids: [] },
      fields: [],
      line_items: Array.from({ length: 79 }, (_, index) => ({
        source_row: index + 1,
        values: { description: 'מוצר ' + (index + 1), unit_price: 10 + index },
        evidence_block_ids: [],
      })),
      suggested_annotations: [],
    },
  },
  interpretations: [], annotations: [], ruleApplications: [], learningRules: [],
  reviewCorrections: [], typeReviewDecisions: [], filings: [], feedback: [],
  exportTemplates: [], exportTemplateVersions: [], exports: [], packet: null, packetSegments: [],
  actorNames: new Map(),
  priceListDecision: null, priceListLines: [], priceListPredictions: [],
}`;

const ENTRY = `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import '${ROOT}/src/index.css';
import { LocaleProvider } from '${ROOT}/src/lib/i18n/LocaleProvider';
import { createAppQueryClient } from '${ROOT}/src/lib/query/client';
import { OrgScopeProvider } from '${ROOT}/src/lib/query/orgScope';
import { ToastProvider } from '${ROOT}/src/components/ui';
import PriceLists from '${ROOT}/src/pages/PriceLists';
import Products from '${ROOT}/src/pages/Products';
import SupplierLog from '${ROOT}/src/pages/SupplierLog';
import { DocumentAssessmentPanel } from '${ROOT}/src/components/document-review/DocumentAssessmentPanel';
import { PriceListAutomationReadiness } from '${ROOT}/src/components/document-review/PriceListAutomationReadiness';
import { PriceListReviewConfirmation } from '${ROOT}/src/components/document-review/PriceListReviewConfirmation';

const snapshot = ${SNAPSHOT};

// Each entry is [route, element]. The three document-review screens are mounted as components
// rather than through /documents/:id/review: the route pulls a whole processing pipeline in, and
// what is being read here is one panel of it.
const SCREENS = {
  prices: ['/prices', <PriceLists />],
  products: ['/products', <Products />],
  'supplier-log': ['/supplier-log', <SupplierLog />],
  'no-route': ['/x', <div className="p-6"><DocumentAssessmentPanel documentId="doc-quote" /></div>],
  readiness: ['/x', <div className="card card-pad m-6"><PriceListAutomationReadiness documentId="doc-quote" interpretationId="interpretation-1" ingested={false} /></div>],
  'price-list-review': ['/x', <div className="m-6"><PriceListReviewConfirmation snapshot={snapshot} actorId="office-2" onRefetch={async () => true} /></div>],
};

function Harness() {
  const name = new URLSearchParams(location.search).get('screen') || 'prices';
  const [entry, element] = SCREENS[name];
  const path = entry.split('?')[0];
  return (
    <LocaleProvider initialLocale="he">
      <QueryClientProvider client={createAppQueryClient()}>
        <OrgScopeProvider org="org-test">
          <ToastProvider>
            <MemoryRouter initialEntries={[entry]}>
              <Routes><Route path={path} element={element} /></Routes>
            </MemoryRouter>
          </ToastProvider>
        </OrgScopeProvider>
      </QueryClientProvider>
    </LocaleProvider>
  );
}

// Mount only once the design tokens have actually applied: vite dev injects the stylesheet with a
// <style> tag AFTER the first paint, and a screenshot taken before that is of an unstyled page.
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
<html dir="rtl" lang="he"><head><meta charset="utf-8"><title>pr38 price intake</title></head>
<body class="bg-canvas"><div id="root"></div><script type="module" src="./entry.tsx"></script></body></html>
`;

// A DEAD port on purpose — see the header. Nothing listens on 59999.
const ENV = `VITE_SUPABASE_URL=http://127.0.0.1:59999
VITE_SUPABASE_ANON_KEY=harness-anon-key-not-a-secret
`;

const CONFIG = `import base from '${ROOT}/vite.config.ts';

/** Redirects the screens' AuthContext import to the harness stub. A resolveId hook rather than an
 *  alias entry: the specifier is relative and only the resolver sees which file it means. */
const stubAuth = {
  name: 'pr38-harness-auth-stub',
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
  // root inside .tmp generates only the classes the harness file itself names.
  root: '${ROOT}',
  envDir: '${HARNESS.replace(/\\/g, '/')}',
  optimizeDeps: { entries: ['.tmp/pr38-visual/index.html'] },
  plugins: [stubAuth, ...(base.plugins ?? [])],
  build: undefined,
};
`;

// --------------------------------------------------------------------------------- fixtures

const CANONICAL_SOAP = 'סבון ידיים נוזלי — 4 ליטר';

const SHEET = [
  'מוצר,מחיר',
  `${CANONICAL_SOAP},18.90`,
  'בצל יבש,1.2345',
  'ריבה,7.00',
  'עגבניות שרי,4.60',
  'קמח לבן,"12,50"',
].join('\n');

const CATALOGUE = [
  { id: 'prod-soap', org_id: 'org-test', name: 'סבון ידיים נוזלי 4 ליטר', display_name: CANONICAL_SOAP, unit: 'יח׳', active: true, category_id: null, sku: null, barcode: null, notes: null, min_stock: null },
  { id: 'prod-onion', org_id: 'org-test', name: 'בצל יבש', display_name: null, unit: 'ק״ג', active: true, category_id: null, sku: null, barcode: null, notes: null, min_stock: null },
  { id: 'prod-jam-raw', org_id: 'org-test', name: 'ריבה', display_name: null, unit: 'יח׳', active: true, category_id: null, sku: null, barcode: null, notes: null, min_stock: null },
  { id: 'prod-jam-canonical', org_id: 'org-test', name: 'ריבת חלב', display_name: 'ריבה', unit: 'יח׳', active: true, category_id: null, sku: null, barcode: null, notes: null, min_stock: null },
  // The /products queue: one proposal that changes the name, one stored in visual order, three
  // whose proposal is the name already there.
  { id: 'prod-oil', org_id: 'org-test', name: 'שמן קנולה 100 מ״ל חברת דגן', display_name: null, unit: 'יח׳', active: true, category_id: null, sku: null, barcode: null, notes: null, min_stock: null },
  { id: 'prod-flour', org_id: 'org-test', name: ')ק"ג 5( קמח לבן', display_name: null, unit: 'ק״ג', active: true, category_id: null, sku: null, barcode: null, notes: null, min_stock: null },
  { id: 'prod-salt', org_id: 'org-test', name: 'מלח גס', display_name: null, unit: 'ק״ג', active: true, category_id: null, sku: null, barcode: null, notes: null, min_stock: null },
  { id: 'prod-sugar', org_id: 'org-test', name: 'סוכר לבן', display_name: null, unit: 'ק״ג', active: true, category_id: null, sku: null, barcode: null, notes: null, min_stock: null },
  { id: 'prod-rice', org_id: 'org-test', name: 'אורז בסמטי', display_name: null, unit: 'ק״ג', active: true, category_id: null, sku: null, barcode: null, notes: null, min_stock: null },
];

const IMPORT_REASON = 'בדיקת QA — סריקת רגרסיה 04.09.2026';
const NAME_REASON = 'אישור השם הקנוני שהוצע למוצר';

const at = (index) => new Date(Date.UTC(2026, 8, 4, 12, 0, 0) - index * 60000).toISOString();
const logRow = (index, over) => ({
  id: `log-${index}`, org_id: 'org-test', user_id: 'user-1',
  action: 'update', entity_type: 'suppliers', entity_id: 'sup-1',
  old_values: null, new_values: null, reason: null,
  created_at: at(index), correlation_id: `corr-${index}`,
  scope_domain: null, scope_class: null, legal_entity_id: null, causation_id: null,
  ...over,
});

const AUDIT_ROWS = [
  logRow(0, {
    id: 'cmd-import', action: 'supplier_prices_imported', entity_type: 'supplier_products',
    entity_id: null, reason: IMPORT_REASON, correlation_id: 'corr-import',
    new_values: { row_count: 6, created: 0, updated: 6, unchanged: 0, effective_date: '2026-09-04' },
  }),
  ...[1, 2, 3, 4, 5, 6].map((n) => logRow(n, {
    id: `trg-import-${n}`, action: 'update', entity_type: 'supplier_products',
    entity_id: `sp-${n}`, correlation_id: 'corr-import',
    old_values: { current_price: 10 + n }, new_values: { current_price: 12 + n },
  })),
  logRow(7, {
    id: 'cmd-name', action: 'product_display_name_set', entity_type: 'products',
    entity_id: 'prod-salt', reason: NAME_REASON, correlation_id: 'corr-name',
    old_values: { display_name: null, name: 'מלח גס' },
    new_values: { display_name: 'מלח גס דק', name: 'מלח גס' },
  }),
  logRow(8, {
    id: 'trg-rating', entity_id: 'sup-1', correlation_id: 'corr-rating',
    old_values: { rating: 3 }, new_values: { rating: 4 },
  }),
];

const LEDGER_PRICE_ROWS = [1, 2, 3, 4, 5, 6].map((n) => ({
  id: `sp-${n}`, supplier_id: 'sup-1',
  supplier: { id: 'sup-1', name: 'ספק אלפא', default_currency: 'ILS' },
  product: { id: `p-${n}`, name: `מוצר ${n}` },
}));

/** The read the quote panel makes — a supplier price list classified „הצעת מחיר". */
const QUOTE_REVIEW = {
  document_id: 'doc-quote',
  file_name: 'אחים כהן מחירון.pdf',
  document_kind: 'other',
  document_type: 'quote',
  document_date: '2026-09-01',
  file_stored: true,
  data_approved: false,
  interpretation_id: 'interpretation-1',
  supplier_resolution: {
    resolved: true, matched_by: 'by_vat_id', reason: null, candidates: [], supplier_id: 'sup-1',
  },
  order_resolution: null,
  assessment: null,
  state: 'ready_for_approval',
};

const FIXTURES = {
  supplier_products: [],
  supplier_price_submissions: [],
  suppliers: [{ id: 'sup-1', org_id: 'org-test', name: 'ספק אלפא', status: 'active', default_currency: 'ILS', deleted_at: null }],
  currencies: [{ code: 'ILS' }],
  products: CATALOGUE,
  categories: [],
  profiles: [{ id: 'user-1', full_name: 'בעל העסק' }],
  audit_log_read_model: AUDIT_ROWS,
  'rpc:get_product_name_repair_queue': { has_dry_run: false, dry_run_count: 0, latest_dry_run_at: null, candidates: [] },
  'rpc:get_document_review_assessment': QUOTE_REVIEW,
  'rpc:get_price_list_calibration_preparation_queue': [],
  // PL-04's whole subject: the server names the refusal and the client used to answer „contact
  // support". 400/22023 is what migration 0182 raises.
  'rpc:get_qualified_product_creation_dry_run': {
    status: 400,
    body: { code: '22023', message: 'qualified_product_dry_run_context_invalid', details: null, hint: null },
  },
};

/** The ledger read resolves its price lines from `supplier_products`; every other screen wants []. */
const SUPPLIER_PRODUCTS_BY_SCREEN = { 'supplier-log': LEDGER_PRICE_ROWS };

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

  // The bundled chromium on this machine fails with `spawn UNKNOWN`; the installed browser does
  // not. Headed, because headless misses injected CSS here.
  const browser = await chromium.launch({
    headless: false,
    ...(process.env.PLAYWRIGHT_CHROMIUM
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM }
      : { channel: 'msedge' }),
  });

  const shots = [];
  const findings = [];
  const missedRoutes = [];
  let screen = 'prices';
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 }, locale: 'he-IL', serviceWorkers: 'block',
      reducedMotion: 'reduce', deviceScaleFactor: 2,
    });
    await context.route('**/127.0.0.1:59999/**', async (route) => {
      const url = new URL(route.request().url());
      const name = url.pathname.replace(/^\/rest\/v1\//, '').replace(/^rpc\//, 'rpc:').split('?')[0];
      let body = name === 'supplier_products'
        ? (SUPPLIER_PRODUCTS_BY_SCREEN[screen] ?? [])
        : FIXTURES[name];
      if (body === undefined) { missedRoutes.push(`${screen}: ${url.pathname}`); body = []; }
      if (body && !Array.isArray(body) && typeof body === 'object' && 'status' in body) {
        await route.fulfill({
          status: body.status, headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body.body),
        });
        return;
      }
      const rows = Array.isArray(body) ? body : null;
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-range': rows && rows.length ? `0-${rows.length - 1}/${rows.length}` : '*/0',
        },
        body: JSON.stringify(body),
      });
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => findings.push(`${screen}: page error ${e.message}`));

    const open = async (name) => {
      screen = name;
      await page.goto(`${baseURL}/.tmp/pr38-visual/index.html?screen=${name}`,
        { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(1500);
      const token = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--color-canvas').trim());
      if (!token) findings.push(`${name}: page is unstyled (--color-canvas empty)`);
    };
    const shoot = async (label) => {
      const path = join(OUT, `PR38-${label}-1440x900.png`);
      await page.screenshot({ path, fullPage: true });
      shots.push(path);
    };

    // ---- PL-05 / PL-07 / PL-12 — the sheet preview
    await open('prices');
    await page.locator('[data-tour-anchor="prices-upload"]').click();
    await page.locator('#price-upload-supplier').selectOption('sup-1');
    await page.locator('input[type="file"]').setInputFiles({
      name: 'prices.csv', mimeType: 'text/csv', buffer: Buffer.from(SHEET, 'utf8'),
    });
    await page.getByRole('button', { name: 'המשך לתצוגה מקדימה' }).click();
    await page.locator('[data-testid="sheet-match-rule"]').waitFor({ timeout: 30000 });
    await page.waitForTimeout(500);
    await shoot('PL-05-PL-07-PL-12-sheet-preview');

    // ---- PL-03 / PL-06 — the ledger
    await open('supplier-log');
    await page.locator('table tbody tr').first().waitFor({ timeout: 30000 });
    await shoot('PL-03-PL-06-supplier-log');

    // ---- PL-08 / PL-06 — the naming queue
    await open('products');
    await page.locator('[data-testid="name-review-toggle"]').click();
    await page.locator('[data-testid="name-review-confirm-only"]').waitFor({ timeout: 30000 });
    await page.waitForTimeout(400);
    await shoot('PL-08-name-queue');

    // ---- PL-04 — the readiness refusal
    await open('readiness');
    await page.locator('[role="alert"]').first().waitFor({ timeout: 30000 });
    await shoot('PL-04-readiness-refusal');

    // ---- PL-11a — the quote with one action
    await open('no-route');
    await page.locator('[data-testid="no-approval-route-next-step"]').waitFor({ timeout: 30000 });
    await shoot('PL-11-quote-next-step');

    // ---- PL-11b — the price list that is not processing
    await open('price-list-review');
    await page.locator('[data-testid="price-list-review-confirmation"]').waitFor({ timeout: 30000 });
    await page.waitForTimeout(400);
    await shoot('PL-11-price-list-awaiting-approval');

    // What the pictures have to SAY, read off the page rather than off the file name.
    const read = await page.evaluate(() => document.body.innerText);
    if (!/ממתין לאישור/.test(read) || /בעיבוד/.test(read)) {
      findings.push(`price-list-review: badge still reads בעיבוד — ${read.slice(0, 200)}`);
    }
    await context.close();
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(JSON.stringify({ shots, findings, missedRoutes: [...new Set(missedRoutes)] }, null, 2));
  if (findings.length) {
    console.error('\nFINDINGS:\n  ' + findings.join('\n  '));
    process.exitCode = 1;
  } else {
    console.log('\nvisual check completed with no findings');
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
