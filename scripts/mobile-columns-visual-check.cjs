// Visual verification of PR 20 — mobile column parity (RTL-A11Y-02..05).
//
// The unit oracles prove the DOM. Only a picture settles the rest: that a card which has just
// gained two more fields still reads as a card at 390px, and that a totals block that went from
// one figure to five does not turn the month into a wall.
//
// HEADED ON PURPOSE — headless misses injected CSS on this machine
// (memory: headless-screenshot-stale-css). Shape copied from `scripts/sparkline-visual-check.cjs`,
// which is what this repo already trusts.
//
// NO DATABASE AND NO SIGN-IN. Every Supabase call is answered by Playwright from a fixture, and
// the client is pointed at a DEAD port on purpose: if a route is ever missed the run fails loudly
// instead of quietly reaching the shared local stack another agent may be resetting.
//
//   node <this file>
const { chromium } = require('playwright-core');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');

// Forward slashes: ROOT is interpolated into the harness's own module specifiers, where a Windows
// backslash would be read as an escape.
const ROOT = join(__dirname, '..').replace(/\\/g, '/');
const HARNESS = join(ROOT, '.tmp', 'pr20-visual');
const OUT = join(ROOT, 'docs', 'qa', '2026-09-04', 'evidence');
const PORT = 5199 + 720; // away from dev (5199), the gate, and the other visual checks

// --------------------------------------------------------------------------- harness sources

const AUTH_STUB = `import { createContext, useContext } from 'react';
// The three screens read exactly this much of AuthContext. A stub, so the harness needs no
// GoTrue session and no sign-in — the fields are the fixture, not a claim about permissions.
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
import PriceLists from '${ROOT}/src/pages/PriceLists';
import { SuppliersList } from '${ROOT}/src/pages/Suppliers';
import Reports from '${ROOT}/src/pages/Reports';

// /payments is NOT here, deliberately and with the reason written down: it is a server-mode
// screen, it paints a skeleton until fetchServerList settles, and a fixture served through this
// harness never settles it — 30s of skeleton and no <h1>. Its evidence is the DataTable-level
// oracle (mobileColumnParity.spec.tsx), which tests the exact predicate its three priority-3
// columns depend on, plus the two screens below that exercise the same mechanism end to end.
const SCREENS = {
  prices: ['/prices', <PriceLists />],
  suppliers: ['/suppliers', <SuppliersList />],
  reports: ['/reports?month=2026-09', <Reports />],
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
<html dir="rtl" lang="he"><head><meta charset="utf-8"><title>pr20 mobile columns</title></head>
<body class="bg-canvas"><div id="root"></div><script type="module" src="./entry.tsx"></script></body></html>
`;

// A DEAD port on purpose — see the header. Nothing listens on 59999.
const ENV = `VITE_SUPABASE_URL=http://127.0.0.1:59999
VITE_SUPABASE_ANON_KEY=harness-anon-key-not-a-secret
`;

const CONFIG = `import base from '${ROOT}/vite.config.ts';

/** Redirects the three screens' AuthContext import to the harness stub. A resolveId hook rather
 *  than an alias entry: the specifier is relative ('../auth/AuthContext') and only the resolver
 *  sees which file it means. */
const stubAuth = {
  name: 'pr20-harness-auth-stub',
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
  // ROOT, not the harness folder. Tailwind v4 auto-detects its sources from the vite root, and
  // with the root set to \`.tmp/pr20-visual\` it scanned only the harness: \`hidden\` and \`lg:hidden\`
  // were never generated, so BOTH bodies painted at 390px and the screenshot showed a desktop
  // table on a phone that the product never renders. The harness page is served as a path under
  // the root instead.
  root: '${ROOT}',
  // The env still comes from the harness folder — the worktree has no .env of its own.
  envDir: '${HARNESS.replace(/\\/g, '/')}',
  // With the root at the repository the dependency scanner otherwise crawls every .html in the
  // tree — the email templates, the prototypes, the owner-decisions tool — and fails on them.
  optimizeDeps: { entries: ['.tmp/pr20-visual/index.html'] },
  plugins: [stubAuth, ...(base.plugins ?? [])],
  build: undefined,
};
`;

// --------------------------------------------------------------------------------- fixtures

const PRICE_ROWS = [
  {
    id: 'sp-1', org_id: 'org-test', supplier_id: 'sup-1', product_id: 'p1',
    current_price: 3.2, previous_price: 12.5, price_effective_date: '2026-08-01',
    available: true, supplier_sku: null, min_qty: null, package_size: null,
    updated_at: '2026-08-01', currency: 'ILS',
    supplier: { id: 'sup-1', name: 'משק ירוק', status: 'active' },
    product: { id: 'p1', name: 'חסה ערבית', unit: 'kg' },
  },
  {
    id: 'sp-2', org_id: 'org-test', supplier_id: 'sup-2', product_id: 'p2',
    current_price: 4.6, previous_price: 4.1, price_effective_date: '2026-08-14',
    available: true, supplier_sku: null, min_qty: null, package_size: null,
    updated_at: '2026-08-14', currency: 'ILS',
    supplier: { id: 'sup-2', name: 'ירקות השרון', status: 'active' },
    product: { id: 'p2', name: 'עגבניות שרי', unit: 'kg' },
  },
];

const SUPPLIER_ROWS = [
  {
    id: 'sup-1', org_id: 'org-test', name: 'אחים כהן', tax_id: null,
    contact_name: 'סיגל אברהם', phone: '02-5891000', whatsapp: null, email: null,
    address: null, min_order_amount: 1250, payment_terms: null, notes: null,
    status: 'active', delivery_days: [], cutoff_time: null, default_currency: 'ILS',
    country_code: 'IL', deleted_at: null, created_at: '2026-07-01', updated_at: '2026-07-27',
    rating: 4, rating_updated_at: null, rating_note: null,
    supplier_categories: [{ category_id: 'c1', categories: { name: 'ירקות' } }],
  },
  {
    id: 'sup-2', org_id: 'org-test', name: 'חוות השדה', tax_id: null,
    contact_name: 'עופר', phone: '03-6100200', whatsapp: null, email: null,
    address: null, min_order_amount: 350, payment_terms: null, notes: null,
    status: 'active', delivery_days: [], cutoff_time: null, default_currency: 'ILS',
    country_code: 'IL', deleted_at: null, created_at: '2026-07-01', updated_at: '2026-07-27',
    rating: 5, rating_updated_at: null, rating_note: null,
    supplier_categories: [{ category_id: 'c2', categories: { name: 'פירות' } }],
  },
];

const invoice = (id, num, before, vat, total) => ({
  id, org_id: 'org-test', supplier_id: 'sup-1', financial_role: 'payable',
  invoice_number: num, invoice_date: '2026-09-01', received_date: '2026-09-02',
  amount_before_vat: before, vat_amount: vat, total_amount: total, currency: 'ILS',
  review_status: 'approved', payment_status: 'partial', export_status: 'pending',
  notes: null, deleted_at: null,
});

const FIXTURES = {
  supplier_products: PRICE_ROWS,
  supplier_price_submissions: [],
  suppliers: SUPPLIER_ROWS,
  supplier_balances_by_currency: [],
  supplier_metrics: [],
  invoices: [invoice('inv-1', '3377', 300.0, 54.0, 354.0), invoice('inv-2', '7702', 187.66, 31.34, 219.0)],
  payments: [],
  credit_requests: [],
  exceptions: [],
  bank_transactions: [],
  financial_supplier_directory: [{ id: 'sup-1', name: 'חוות השדה' }, { id: 'sup-2', name: 'אחים כהן' }],
  invoice_balances_by_currency: [
    { invoice_id: 'inv-1', currency: 'ILS', paid_amount: 354.0, credited_amount: 0, balance_in_currency: 0 },
    { invoice_id: 'inv-2', currency: 'ILS', paid_amount: 208.0, credited_amount: 0, balance_in_currency: 11.0 },
  ],
  payment_reportable_amounts: [],
  monthly_report_snapshots: [],
  monthly_report_snapshot_deliveries: [],
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
    // The root is POSITIONAL in vite 6. `--config` is not optional: without the repo's config the
    // Tailwind v4 and React plugins are both absent and neither the CSS nor the JSX builds.
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

  // The bundled chromium on this machine fails with `spawn UNKNOWN`; the installed Chrome does
  // not. Headed, because headless misses injected CSS here (memory: headless-screenshot-stale-css)
  // — and the token probe below fails the run rather than trusting that.
  const browser = await chromium.launch({
    headless: false,
    ...(process.env.PLAYWRIGHT_CHROMIUM
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM }
      : { channel: 'chrome' }),
  });

  const shots = [];
  const findings = [];
  const missedRoutes = [];
  try {
    for (const [label, width, height] of [['mobile', 390, 844], ['desktop', 1440, 900]]) {
      const context = await browser.newContext({
        viewport: { width, height }, locale: 'he-IL', serviceWorkers: 'block',
        reducedMotion: 'reduce', deviceScaleFactor: 2,
      });
      // Every Supabase call answered from a fixture. Anything not named is an empty 200 AND is
      // recorded, so a screen quietly depending on a table this harness never fed is visible.
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
            // Server mode reads the RLS-filtered COUNT off this header, not off the page length,
            // so a `*` total leaves /payments reporting no rows at all.
            'content-range': rows.length ? `0-${rows.length - 1}/${rows.length}` : '*/0',
          },
          body: JSON.stringify(rows),
        });
      });
      const page = await context.newPage();
      page.on('pageerror', (e) => findings.push(`${label}: page error ${e.message}`));

      for (const screenName of ['prices', 'suppliers', 'reports']) {
        // `load`, not `networkidle`: vite dev holds an HMR websocket open.
        await page.goto(`${baseURL}/.tmp/pr20-visual/index.html?screen=${screenName}`,
          { waitUntil: 'load', timeout: 60000 });
        await page.locator('h1').first().waitFor({ timeout: 30000 });
        // The row bodies arrive from the fixture a tick later.
        await page.waitForTimeout(1200);

        // An unstyled screenshot is worse than none: it looks like a finding. Prove the token
        // layer AND the responsive layer actually landed before believing any picture from this
        // page — a harness that failed to generate `hidden`/`lg:hidden` painted both bodies at
        // 390px and made a phone look like it renders the desktop table.
        const styled = await page.evaluate(() => {
          const cards = document.querySelector('ul[class*="lg:hidden"]');
          const wrap = document.querySelector('div[class*="lg:block"]');
          return {
            token: getComputedStyle(document.documentElement).getPropertyValue('--color-canvas').trim(),
            size: document.querySelector('h1') ? getComputedStyle(document.querySelector('h1')).fontSize : '0px',
            cards: cards ? getComputedStyle(cards).display : null,
            table: wrap ? getComputedStyle(wrap).display : null,
          };
        });
        if (!styled.token || parseFloat(styled.size) <= 16) {
          findings.push(`${label}/${screenName}: page is unstyled (--color-canvas="${styled.token}", h1 ${styled.size})`);
        }
        // /reports has no DataTable, so it has neither element — only assert where they exist.
        if (styled.cards && styled.table) {
          const expected = label === 'mobile' ? { cards: 'block', table: 'none' } : { cards: 'none', table: 'block' };
          if (styled.cards !== expected.cards || styled.table !== expected.table) {
            findings.push(`${label}/${screenName}: the cards/table swap did not happen — cards ${styled.cards}, table ${styled.table}`);
          }
        }

        const before = join(OUT, `PR20-${screenName}-${label}-${width}x${height}.png`);
        await page.screenshot({ path: before, fullPage: label === 'mobile' });
        shots.push(before);

        // The claim RTL-A11Y-02..04 make is that the viewer can turn a column ON. Only the phone
        // has the sheet, and /reports has no picker at all (it has no DataTable) — so this half
        // runs for the two screens that do.
        if (label === 'mobile' && screenName !== 'reports') {
          const trigger = page.getByRole('button', { name: /סינון ותצוגה/ });
          if (!(await trigger.count())) { findings.push(`${screenName}: no סינון ותצוגה trigger at 390px`); continue; }
          await trigger.first().click();
          const wanted = {
            prices: ['יחידה', 'מחיר קודם'],
            suppliers: ['איש קשר', 'מינ׳ הזמנה', 'דירוג', 'קטגוריות'],
          }[screenName];
          for (const name of wanted) {
            const box = page.getByRole('checkbox', { name, exact: true });
            if (!(await box.count())) { findings.push(`${screenName}: no checkbox named ${name}`); continue; }
            if (await box.first().isChecked()) findings.push(`${screenName}: ${name} already reads as on`);
            await box.first().check();
          }
          await page.keyboard.press('Escape');
          await page.waitForTimeout(600);
          const after = join(OUT, `PR20-${screenName}-mobile-390x844-columns-on.png`);
          await page.screenshot({ path: after, fullPage: true });
          shots.push(after);
        }
      }
      await context.close();
    }
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
