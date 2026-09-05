// Visual verification of PR 19 — DOC-05, DOC-13 and MON-07.
//
// The unit oracles prove the DOM. A picture settles what the sweep actually reported, because
// all three findings are things a person READ off a screen: a date box showing today, a label
// claiming a rate beside a number no rate produced, and a packet page naming a state with no
// instruction under it.
//
// HEADED ON PURPOSE — headless misses injected CSS on this machine
// (memory: headless-screenshot-stale-css). Shape copied from
// `scripts/mobile-columns-visual-check.cjs`, which is what this repo already trusts.
//
// NO DATABASE AND NO SIGN-IN. Every Supabase call is answered by Playwright from a fixture, and
// the client is pointed at a DEAD port on purpose: the shared local stack is held by another
// agent, and a missed route must fail loudly rather than quietly reach it.
//
//   node <this file>
const { chromium } = require('playwright-core');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');

// Forward slashes: ROOT is interpolated into the harness's own module specifiers, where a Windows
// backslash would be read as an escape.
const ROOT = join(__dirname, '..').replace(/\\/g, '/');
const HARNESS = join(ROOT, '.tmp', 'pr19-visual');
const OUT = join(ROOT, 'docs', 'qa', '2026-09-04', 'evidence');
const PORT = 5199 + 190; // away from dev (5199), the gate, and the other visual checks

const DOCUMENT_ID = '69517a3e-36db-41ee-9948-aeb72239fa73';

// --------------------------------------------------------------------------- harness sources

// 17.50 is the rate this tenant is really configured with — the OWN-12 measurement. A stub
// carrying the product's default would hide the disagreement all three screenshots are about.
const AUTH_STUB = `import { createContext, useContext } from 'react';
const value = {
  profile: { id: 'user-1', role: 'owner', org_id: 'org-test', full_name: 'בודק' },
  org: {
    id: 'org-test', name: 'עסק לדוגמה', settings: {},
    base_currency: 'ILS', country_code: 'IL', vat_rate: 17.5,
  },
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
import InvoiceNew from '${ROOT}/src/pages/InvoiceNew';
import ConsolidatedInvoices from '${ROOT}/src/pages/ConsolidatedInvoices';

const SCREENS = {
  draft: ['/invoices/new?document=${DOCUMENT_ID}', <InvoiceNew />],
  blank: ['/invoices/new', <InvoiceNew />],
  consolidated: ['/documents/consolidated-invoices?case=case-1', <ConsolidatedInvoices />],
};

function Harness() {
  const name = new URLSearchParams(location.search).get('screen') || 'draft';
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
<html dir="rtl" lang="he"><head><meta charset="utf-8"><title>pr19 vat, date and scan gate</title></head>
<body class="bg-canvas"><div id="root"></div><script type="module" src="./entry.tsx"></script></body></html>
`;

// A DEAD port on purpose — see the header. Nothing listens on 59999.
const ENV = `VITE_SUPABASE_URL=http://127.0.0.1:59999
VITE_SUPABASE_ANON_KEY=harness-anon-key-not-a-secret
`;

const CONFIG = `import base from '${ROOT}/vite.config.ts';

const stubAuth = {
  name: 'pr19-harness-auth-stub',
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
  // narrower root generates only the classes the harness itself spells out.
  root: '${ROOT}',
  envDir: '${HARNESS.replace(/\\/g, '/')}',
  optimizeDeps: { entries: ['.tmp/pr19-visual/index.html'] },
  plugins: [stubAuth, ...(base.plugins ?? [])],
  build: undefined,
};
`;

// --------------------------------------------------------------------------------- fixtures

// The supplier's own page, as the reader returned it: day-first, two-digit year, and a VAT
// amount that is 18.00% of the taxable base the document prints — not 17.5% of anything.
const INTERPRETATION = {
  payload: {
    schema_version: '1',
    document_type: 'invoice',
    document_type_confidence: 0.99,
    supplier: { suggested_id: 'sup-il', suggested_name: 'ספק מקומי', confidence: 0.99, evidence_block_ids: [] },
    fields: [
      { key: 'invoice_number', value: 'SI266001312', confidence: 0.99, evidence_block_ids: [] },
      { key: 'invoice_date', value: '31/07/26', confidence: 0.99, evidence_block_ids: [] },
      { key: 'subtotal', value: 20720.8, confidence: 0.98, evidence_block_ids: [] },
      { key: 'vat_amount', value: 133.2, confidence: 0.98, evidence_block_ids: [] },
      { key: 'total', value: 20854, confidence: 0.98, evidence_block_ids: [] },
      { key: 'currency', value: 'ILS', confidence: 0.99, evidence_block_ids: [] },
    ],
    line_items: [],
    suggested_annotations: [],
  },
  suggested_supplier_id: 'sup-il',
};

const WORKSPACE = {
  case: {
    id: 'case-1', supplier_id: 'sup-1', supplier_name: 'אריזות הדרום',
    target_month: '2026-08-01', legal_entity_id: 'le-1', legal_entity_name: 'ישות משפטית',
    status: 'awaiting_anchor', anchor_invoice_id: null, current_revision: 1, warning_count: 0,
    created_at: '2026-09-03T00:43:00Z', updated_at: '2026-09-03T00:43:00Z',
  },
  anchor: null,
  intake: null,
  pages: [{
    page_number: 1, document_id: 'doc-1', file_name: 'consolidated-page-1.png',
    is_primary: true, job_id: 'job-1', job_status: 'awaiting_scan',
    interpretation_id: null, document_type: null,
  }],
  sources: [],
  reconciliation: { anchor_vs_interim: [], anchor_vs_receipts: [], interim_vs_receipts: [] },
  current_revision: null,
  warnings: [],
};

const FIXTURES = {
  suppliers: [
    { id: 'sup-il', name: 'ספק מקומי', default_currency: 'ILS', country_code: 'IL', deleted_at: null },
    { id: 'sup-1', name: 'אריזות הדרום', default_currency: 'ILS', country_code: 'IL', deleted_at: null },
  ],
  currencies: [{ code: 'ILS', minor_units: 2 }, { code: 'USD', minor_units: 2 }],
  invoices: [],
  credit_requests: [],
  // Read with `.maybeSingle()`, so these two are OBJECTS and not arrays.
  document_interpretations: INTERPRETATION,
  documents: { file_name: 'u3-invoice.jpeg' },
  'rpc:list_consolidated_invoice_cases': [],
  'rpc:list_consolidated_invoice_legal_entities': [{ id: 'le-1', name: 'ישות משפטית' }],
  'rpc:get_consolidated_invoice_workspace': WORKSPACE,
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

  // The bundled chromium on this machine fails with `spawn UNKNOWN`; the installed Edge/Chrome
  // does not. Headed, because headless misses injected CSS here.
  const browser = await chromium.launch({
    headless: false,
    ...(process.env.PLAYWRIGHT_CHROMIUM
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM }
      : { channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' }),
  });

  const shots = [];
  const findings = [];
  const missedRoutes = [];
  const readBack = {};
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 }, locale: 'he-IL', serviceWorkers: 'block',
      reducedMotion: 'reduce', deviceScaleFactor: 2,
    });
    await context.route('**/127.0.0.1:59999/**', async (route) => {
      const url = new URL(route.request().url());
      const name = url.pathname.replace(/^\/rest\/v1\//, '').replace(/^rpc\//, 'rpc:').split('?')[0];
      const body = FIXTURES[name];
      if (body === undefined) missedRoutes.push(url.pathname);
      const rows = body ?? [];
      const length = Array.isArray(rows) ? rows.length : 1;
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-range': length ? `0-${length - 1}/${length}` : '*/0',
        },
        body: JSON.stringify(rows),
      });
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => findings.push(`page error ${e.message}`));

    for (const screenName of ['draft', 'blank', 'consolidated']) {
      // `load`, not `networkidle`: vite dev holds an HMR websocket open.
      await page.goto(`${baseURL}/.tmp/pr19-visual/index.html?screen=${screenName}`,
        { waitUntil: 'load', timeout: 60000 });
      await page.locator('h1').first().waitFor({ timeout: 30000 });
      // The prefill and the workspace arrive from the fixture a tick later.
      await page.waitForTimeout(1500);

      // An unstyled screenshot is worse than none: it looks like a finding.
      const styled = await page.evaluate(() => ({
        token: getComputedStyle(document.documentElement).getPropertyValue('--color-canvas').trim(),
        size: document.querySelector('h1') ? getComputedStyle(document.querySelector('h1')).fontSize : '0px',
      }));
      if (!styled.token || parseFloat(styled.size) <= 16) {
        findings.push(`${screenName}: page is unstyled (--color-canvas="${styled.token}", h1 ${styled.size})`);
      }

      readBack[screenName] = await page.evaluate(() => {
        const label = (id) => document.querySelector(`label[for="${id}"]`)?.textContent?.trim() ?? null;
        const value = (id) => document.getElementById(id)?.value ?? null;
        const row = document.querySelector('ul li p')?.parentElement?.textContent?.trim() ?? null;
        return {
          vatLabel: label('invoice-new-vat'),
          invoiceDate: value('invoice-new-date'),
          invoiceNumber: value('invoice-new-number'),
          vatValue: value('invoice-new-vat'),
          packetRow: row,
        };
      });

      const shot = join(OUT, `PR19-${screenName}-1440x900.png`);
      await page.screenshot({ path: shot, fullPage: true });
      shots.push(shot);
    }
  } finally {
    await browser.close();
    server.kill();
  }

  console.log('\n--- what the screens actually said ---');
  console.log(JSON.stringify(readBack, null, 2));
  if (missedRoutes.length) console.log(`\nroutes with no fixture: ${[...new Set(missedRoutes)].join(', ')}`);
  console.log(`\nshots:\n  ${shots.join('\n  ')}`);
  if (findings.length) {
    console.error(`\nFINDINGS:\n  ${findings.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log('\nno rendering findings.');
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
