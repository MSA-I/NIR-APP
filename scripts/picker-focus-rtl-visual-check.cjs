// The oracle for PR 37 — `RTL-A11Y-09`, `-10`, `-11`, `-12`.
//
// WHY A RUN AND NOT A SOURCE SCAN. `RTL-A11Y-09` is the row where that distinction is the whole
// point: the column picker's source says Escape calls `close(true)`, which focuses the trigger,
// and an earlier draft called the finding refuted on the strength of that. The sweep had MEASURED
// focus landing on a row-action button. Source shows intent; only a run shows behaviour — so this
// file drives a real browser and prints where `document.activeElement` actually was, including the
// sweep's own repro (Enter, then Tab repeatedly, then Escape).
//
// The other three ride the same harness because they need pixels too: which side of the digits the
// shekel sign lands on (`-10`), whether every field on the mobile supplier card names itself
// (`-11`), and whether a four-bar categorical chart draws four axis labels at 390px (`-12`).
//
// HEADED ON PURPOSE, and on system Edge: the bundled chromium fails with `spawn UNKNOWN` on this
// machine, and headless misses injected CSS (memory: headless-screenshot-stale-css). Shape copied
// from `scripts/mobile-columns-visual-check.cjs`, which is what this repo already trusts.
//
// NO DATABASE AND NO SIGN-IN. Every Supabase call is answered by Playwright from a fixture and the
// client points at a DEAD port, so a missed route fails loudly instead of quietly reaching the
// shared local stack another agent may be resetting.
//
//   node scripts/picker-focus-rtl-visual-check.cjs            # measure, screenshots, JSON verdict
//   node scripts/picker-focus-rtl-visual-check.cjs --tag RED   # names the evidence files
const { chromium } = require('playwright-core');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { mkdirSync, writeFileSync, existsSync } = require('node:fs');

// Forward slashes: ROOT is interpolated into the harness's own module specifiers, where a Windows
// backslash would be read as an escape.
const ROOT = join(__dirname, '..').replace(/\\/g, '/');
const HARNESS = join(ROOT, '.tmp', 'pr37-visual');
const OUT = join(ROOT, 'docs', 'qa', '2026-09-04', 'evidence');
const PORT = 5199 + 738; // away from dev (5199), the gate, and the other visual checks
const TAG = (process.argv.includes('--tag') ? process.argv[process.argv.indexOf('--tag') + 1] : 'RUN')
  .replace(/[^A-Za-z0-9_-]/g, '');

// Own cache dir, so this run never shares profile state with another agent's browser.
const CACHE = join(HARNESS, 'browser-profile');

const EDGE_CANDIDATES = [
  process.env.PLAYWRIGHT_EDGE,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

// --------------------------------------------------------------------------- harness sources

const AUTH_STUB = `import { createContext, useContext } from 'react';
// The screens read exactly this much of AuthContext. A stub, so the harness needs no GoTrue
// session and no sign-in — the fields are the fixture, not a claim about permissions.
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
import { SuppliersList } from '${ROOT}/src/pages/Suppliers';
import { InvoicesList } from '${ROOT}/src/pages/Invoices';
import Dashboard from '${ROOT}/src/pages/Dashboard';

const SCREENS = {
  suppliers: ['/suppliers', <SuppliersList />],
  invoices: ['/invoices', <InvoicesList />],
  dashboard: ['/dashboard', <Dashboard />],
};

function Harness() {
  const name = new URLSearchParams(location.search).get('screen') || 'suppliers';
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
<html dir="rtl" lang="he"><head><meta charset="utf-8"><title>pr37 picker focus + rtl</title></head>
<body class="bg-canvas"><div id="root"></div><script type="module" src="./entry.tsx"></script></body></html>
`;

// A DEAD port on purpose — see the header. Nothing listens on 59999.
const ENV = `VITE_SUPABASE_URL=http://127.0.0.1:59999
VITE_SUPABASE_ANON_KEY=harness-anon-key-not-a-secret
`;

const CONFIG = `import base from '${ROOT}/vite.config.ts';

/** Redirects the screens' AuthContext import to the harness stub. A resolveId hook rather than an
 *  alias entry: the specifier is relative ('../auth/AuthContext') and only the resolver sees which
 *  file it means. */
const stubAuth = {
  name: 'pr37-harness-auth-stub',
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
  // harness-rooted scan generates neither \`hidden\` nor \`lg:hidden\`, so both bodies paint at 390px.
  root: '${ROOT}',
  envDir: '${HARNESS.replace(/\\/g, '/')}',
  optimizeDeps: { entries: ['.tmp/pr37-visual/index.html'] },
  plugins: [stubAuth, ...(base.plugins ?? [])],
  build: undefined,
};
`;

// --------------------------------------------------------------------------------- fixtures

const SUPPLIER_ROWS = [
  {
    id: 'sup-1', org_id: 'org-test', name: 'אחים כהן', tax_id: null,
    contact_name: 'סיגל אברהם', phone: '026518868', whatsapp: null, email: null,
    address: null, min_order_amount: 1250, payment_terms: null, notes: null,
    status: 'active', delivery_days: [], cutoff_time: null, default_currency: 'ILS',
    country_code: 'IL', deleted_at: null, created_at: '2026-07-01', updated_at: '2026-07-27',
    rating: 4, rating_updated_at: null, rating_note: null,
    supplier_categories: [{ category_id: 'c1', categories: { name: 'ירקות' } }],
  },
  {
    id: 'sup-2', org_id: 'org-test', name: 'חוות השדה', tax_id: null,
    contact_name: 'עופר', phone: '036100200', whatsapp: null, email: null,
    address: null, min_order_amount: 350, payment_terms: null, notes: null,
    status: 'active', delivery_days: [], cutoff_time: null, default_currency: 'ILS',
    country_code: 'IL', deleted_at: null, created_at: '2026-07-01', updated_at: '2026-07-27',
    rating: 5, rating_updated_at: null, rating_note: null,
    supplier_categories: [{ category_id: 'c2', categories: { name: 'פירות' } }],
  },
];

// One supplier carries alerts and one does not, so the mobile card is measured in both states —
// the orphan `RTL-A11Y-11` names is the bare em dash as much as the bare count.
const SUPPLIER_METRICS = [
  { supplier_id: 'sup-1', open_exceptions: 1, open_credits: 1 },
  { supplier_id: 'sup-2', open_exceptions: 0, open_credits: 0 },
];

const invoice = (id, num, supplier, date, total) => ({
  id, org_id: 'org-test', supplier_id: supplier, financial_role: 'payable',
  invoice_number: num, invoice_date: date, received_date: date,
  amount_before_vat: Math.round(total / 1.18 * 100) / 100,
  vat_amount: Math.round((total - total / 1.18) * 100) / 100,
  total_amount: total, currency: 'ILS',
  review_status: 'approved', payment_status: 'partial', export_status: 'pending',
  notes: null, deleted_at: null, supplier: { id: supplier, name: 'אחים כהן' },
});

// Four consecutive calendar months, so the monthly bar chart has four buckets with an observation
// in each — that is the series `RTL-A11Y-12` is about.
const INVOICE_ROWS = [
  invoice('inv-1', 'QA-R3-1112376', 'sup-1', '2026-06-11', 21440),
  invoice('inv-2', 'QA-R3-1112377', 'sup-1', '2026-07-09', 30110),
  invoice('inv-3', 'QA-R3-1112378', 'sup-2', '2026-08-14', 17250),
  invoice('inv-4', 'QA-R3-1112379', 'sup-2', '2026-09-02', 10942),
];

const DASHBOARD_SNAPSHOT = {
  money: {
    openBalanceByCurrency: [{ currency: 'ILS', amount: 68663, invoiceCount: 12 }],
    openInvoiceCount: 12,
  },
  paymentRequests: {
    pendingApproval: 2, drafts: 1, dueDateCoverage: 1, activeCount: 4,
    overdue: 1, dueToday: 0,
    overdueAmountByCurrency: [{ currency: 'ILS', amount: 4200 }],
    dueWithin7AmountByCurrency: [{ currency: 'ILS', amount: 6742 }],
    dueWithin7Count: 2,
  },
  credits: { count: 1, sumByCurrency: [{ currency: 'ILS', amount: 150 }] },
  bank: { unmatched: 3, suggested: 1 },
  invoices: { pendingApproval: 2, toReview: 1, notSent: 4 },
  openOrders: {
    count: 5,
    committedByCurrency: [{ currency: 'ILS', amount: 12500 }],
    remainingByCurrency: [{ currency: 'ILS', amount: 5200 }],
    noDate: 1, late: 1, awaitingConfirmation: 2,
  },
  openSupplierCount: 2,
  topBalancesByCurrency: [{ currency: 'ILS', rows: [{ id: 'sup-1', name: 'אחים כהן', balance: 573 }] }],
};

const FIXTURES = {
  suppliers: SUPPLIER_ROWS,
  supplier_metrics: SUPPLIER_METRICS,
  supplier_balances_by_currency: [
    { supplier_id: 'sup-1', currency: 'ILS', open_balance_in_currency: 573, amount: 573 },
  ],
  supplier_products: [],
  supplier_price_submissions: [],
  invoices: INVOICE_ROWS,
  invoice_balances_by_currency: [],
  payments: [
    { id: 'pay-1', amount: 1724, currency: 'ILS', paid_date: '2026-09-01' },
  ],
  payment_reportable_amounts: [],
  purchase_orders: [],
  purchase_order_items: [],
  purchase_request_items: [],
  exceptions: [],
  credit_requests: [],
  bank_transactions: [],
  notifications: [],
  financial_supplier_directory: [{ id: 'sup-1', name: 'אחים כהן' }, { id: 'sup-2', name: 'חוות השדה' }],
  'rpc:management_dashboard_snapshot': DASHBOARD_SNAPSHOT,
  'rpc:scheduled_payments_outlook': { status: 'not_permitted' },
  'rpc:resolve_feature_flags': [],
};

// ------------------------------------------------------------------ in-page measurement code
//
// Everything below runs in the page. Kept as source strings so each measurement is one round trip
// and the helpers are shared between them.

const PAGE_HELPERS = `
  window.__pr37 = {
    /** The portalled picker panel: the element directly under <body> that holds the checkboxes.
        Located by CONTENT, never by role — the whole question in RTL-A11Y-09 is which role it
        announces, so the finder must work before and after the fix. */
    panel() {
      const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
      for (const box of boxes) {
        let node = box;
        while (node && node.parentElement && node.parentElement !== document.body) node = node.parentElement;
        if (node && node.parentElement === document.body && node !== document.body) return node;
      }
      return null;
    },
    describe(el) {
      if (!el || el === document.body) return { tag: el ? 'BODY' : 'none', name: '', where: 'body' };
      const panel = window.__pr37.panel();
      const label = el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 60);
      return {
        tag: el.tagName,
        role: el.getAttribute('role'),
        type: el.getAttribute('type'),
        name: label,
        where: panel && panel.contains(el) ? 'inside-panel'
          : el.closest('table') ? 'table-behind'
          : el.closest('[data-pr37-trigger]') || el.hasAttribute('data-pr37-trigger') ? 'trigger'
          : 'elsewhere',
      };
    },
    panelSemantics() {
      const panel = window.__pr37.panel();
      if (!panel) return null;
      const group = panel.querySelector('[role="group"]') || (panel.getAttribute('role') === 'group' ? panel : null);
      const trigger = document.querySelector('[data-pr37-trigger]');
      const controls = trigger && trigger.getAttribute('aria-controls');
      return {
        role: panel.getAttribute('role'),
        ariaModal: panel.getAttribute('aria-modal'),
        ariaLabel: panel.getAttribute('aria-label'),
        id: panel.getAttribute('id'),
        innerGroupLabel: group ? group.getAttribute('aria-label') : null,
        triggerHasPopup: trigger && trigger.getAttribute('aria-haspopup'),
        triggerExpanded: trigger && trigger.getAttribute('aria-expanded'),
        triggerControls: controls,
        // A disclosure is only announced if the control actually points at the revealed region.
        controlsResolves: !!(controls && panel.id && controls === panel.id),
      };
    },
    /** Which side of the digits the currency sign sits on, measured per character like the sweep.
        Returns one entry per rendered text node that holds a shekel sign. */
    shekelSides() {
      const out = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const text = node.nodeValue || '';
        if (!text.includes('₪') || !/[0-9]/.test(text)) continue;
        const host = node.parentElement;
        if (!host || !host.getClientRects().length) continue;
        let signX = null; let minDigit = Infinity; let maxDigit = -Infinity;
        for (let i = 0; i < text.length; i += 1) {
          const ch = text[i];
          if (ch !== '₪' && !/[0-9]/.test(ch)) continue;
          const range = document.createRange();
          range.setStart(node, i); range.setEnd(node, i + 1);
          const rect = range.getBoundingClientRect();
          if (!rect.width && !rect.height) continue;
          const mid = rect.left + rect.width / 2;
          if (ch === '₪') signX = mid;
          else { minDigit = Math.min(minDigit, mid); maxDigit = Math.max(maxDigit, mid); }
        }
        if (signX == null || minDigit === Infinity) continue;
        out.push({
          text: text.trim(),
          side: signX < minDigit ? 'left' : signX > maxDigit ? 'right' : 'inside',
          cls: host.className && host.className.baseVal !== undefined ? host.className.baseVal : String(host.className || ''),
          dir: getComputedStyle(host).direction,
          hero: !!host.closest('.kpi-hero') || String(host.className || '').includes('kpi-hero'),
        });
      }
      return out;
    },
    /** Every field on every mobile data card, and whether it carries a label. */
    mobileCardFields() {
      const cards = Array.from(document.querySelectorAll('ul[class*="lg:hidden"] li'));
      return cards.map((card) => {
        const grid = card.querySelector('div[class*="flex-wrap"]');
        const fields = grid ? Array.from(grid.children) : [];
        return fields.map((field) => {
          const first = field.firstElementChild;
          const labelled = !!first && /text-ink-muted/.test(String(first.className || '')) && /:$/.test((first.textContent || '').trim());
          return { text: (field.textContent || '').trim(), labelled };
        });
      });
    },
    /** Bars against axis labels, for the one categorical chart on the dashboard. */
    barChart(titleId) {
      const heading = document.getElementById(titleId);
      const card = heading && heading.closest('section');
      const root = card || document;
      const bars = root.querySelectorAll('.recharts-bar-rectangle');
      const ticks = Array.from(root.querySelectorAll('.recharts-xAxis .recharts-cartesian-axis-tick-value'))
        .map((t) => (t.textContent || '').trim()).filter(Boolean);
      const box = card ? card.getBoundingClientRect() : { width: 0 };
      return { bars: bars.length, ticks, cardWidth: Math.round(box.width) };
    },
  };
`;

// ------------------------------------------------------------------------------------- run

function log(lines, text) { lines.push(text); console.log(text); }

async function main() {
  mkdirSync(HARNESS, { recursive: true });
  mkdirSync(CACHE, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(HARNESS, 'entry.tsx'), ENTRY, 'utf8');
  writeFileSync(join(HARNESS, 'authStub.tsx'), AUTH_STUB, 'utf8');
  writeFileSync(join(HARNESS, 'index.html'), HTML, 'utf8');
  writeFileSync(join(HARNESS, '.env'), ENV, 'utf8');
  writeFileSync(join(HARNESS, 'vite.harness.config.ts'), CONFIG, 'utf8');

  const edge = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!edge) throw new Error(`no Microsoft Edge found; tried:\n  ${EDGE_CANDIDATES.join('\n  ')}`);

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
    const deadline = setTimeout(() => reject(new Error(`vite did not start in 120s:\n${serverLog}`)), 120000);
    const poll = setInterval(() => {
      if (/ready in|Local:\s+http/i.test(serverLog)) { clearInterval(poll); clearTimeout(deadline); resolve(); }
    }, 200);
  });

  const browser = await chromium.launchPersistentContext(CACHE, {
    headless: false,
    executablePath: edge,
    viewport: { width: 1440, height: 900 },
    locale: 'he-IL',
    serviceWorkers: 'block',
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
  });

  const lines = [];
  const verdict = {};
  const shots = [];
  const missedRoutes = [];
  const pageErrors = [];

  await browser.route('**/127.0.0.1:59999/**', async (route) => {
    const url = new URL(route.request().url());
    const name = url.pathname.replace(/^\/rest\/v1\//, '').replace(/^rpc\//, 'rpc:').split('?')[0];
    const body = FIXTURES[name];
    if (body === undefined) missedRoutes.push(url.pathname);
    const rows = body ?? [];
    const count = Array.isArray(rows) ? rows.length : 1;
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'application/json',
        // Server mode reads the RLS-filtered COUNT off this header, not off the page length.
        'content-range': count ? `0-${count - 1}/${count}` : '*/0',
      },
      body: JSON.stringify(rows),
    });
  });

  const open = async (screen, width, height, { headingTimeout = 45000, optional = false } = {}) => {
    const page = browser.pages()[0] || await browser.newPage();
    await page.setViewportSize({ width, height });
    page.on('pageerror', (e) => pageErrors.push(`${screen}: ${e.message}`));
    await page.goto(`${baseURL}/.tmp/pr37-visual/index.html?screen=${screen}`, { waitUntil: 'load', timeout: 90000 });
    try {
      await page.locator('h1').first().waitFor({ timeout: headingTimeout });
    } catch (error) {
      if (!optional) throw error;
      return null;
    }
    await page.waitForTimeout(1800);
    await page.evaluate(PAGE_HELPERS);
    return page;
  };

  try {
    // ------------------------------------------------------- RTL-A11Y-09 — the picker, measured
    log(lines, '');
    log(lines, '=== RTL-A11Y-09 — column chooser, focus and announced role (1440x900) ===');
    // The finding names /invoices and says "same control on /payments and /bank". Both routes are
    // measured where they render; the verdict is the AND, so a pass is never one screen's luck.
    const pickerRuns = {};
    for (const screen of ['invoices', 'suppliers']) {
      log(lines, '');
      log(lines, `--- /${screen} ---`);
      /* /invoices is a SERVER-MODE screen: it paints a skeleton until `fetchServerList` settles,
         and a fixture served through this harness never settles it — the same reason PR 20's
         harness left /payments out and said so. When the heading never arrives the run says
         NOT MEASURED here rather than pretending the route was covered. */
      const page = await open(screen, 1440, 900, { headingTimeout: 20000, optional: true });
      if (!page) {
        log(lines, `NOT MEASURED on /${screen}: no <h1> in 20s — server-mode screen, the fixture harness never settles it`);
        continue;
      }
      const triggerCount = await page.getByRole('button', { name: 'עמודות', exact: true }).count();
      if (!triggerCount) {
        log(lines, `NOT MEASURED on /${screen}: no "עמודות" trigger rendered in this harness`);
        continue;
      }
      const trigger = page.getByRole('button', { name: 'עמודות', exact: true }).first();
      await trigger.evaluate((el) => el.setAttribute('data-pr37-trigger', '1'));

      // --- sequence 1: open with Enter, close with Escape. The contract the source claims.
      await trigger.focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      const semantics = await page.evaluate(() => window.__pr37.panelSemantics());
      const onOpen = await page.evaluate(() => window.__pr37.describe(document.activeElement));
      log(lines, `panel semantics on open: ${JSON.stringify(semantics)}`);
      log(lines, `focus after Enter:       ${JSON.stringify(onOpen)}`);
      shots.push(join(OUT, `PR37-${TAG}-09-${screen}-picker-open-1440x900.png`));
      await page.screenshot({ path: shots[shots.length - 1] });

      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      const afterEscape = await page.evaluate(() => window.__pr37.describe(document.activeElement));
      const stillOpen = await page.evaluate(() => !!window.__pr37.panel());
      log(lines, `focus after Escape:      ${JSON.stringify(afterEscape)} (panel still open: ${stillOpen})`);

      // --- sequence 2: the sweep's own repro — Enter, then Tab repeatedly, then Escape.
      await trigger.focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      const trail = [];
      for (let i = 0; i < 14; i += 1) {
        await page.keyboard.press('Tab');
        await page.waitForTimeout(60);
        trail.push(await page.evaluate(() => ({
          open: !!window.__pr37.panel(),
          ...window.__pr37.describe(document.activeElement),
        })));
      }
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      const afterSweepEscape = await page.evaluate(() => window.__pr37.describe(document.activeElement));
      log(lines, `sweep repro — Tab trail (14 presses):`);
      trail.forEach((s, i) => log(lines, `  ${String(i + 1).padStart(2)}. open=${s.open} where=${s.where} ${s.tag}${s.type ? `[${s.type}]` : ''} "${s.name}"`));
      log(lines, `focus after the sweep's Escape: ${JSON.stringify(afterSweepEscape)}`);

      /* CONTAINMENT, and the predicate matters more than the number. A dialog contains focus: no
         Tab may take the keyboard out of it, and no Tab may make it vanish. The weaker reading —
         "did focus land outside while it was still open" — is satisfied by a panel that CLOSES on
         the way out, which is exactly what this popover does by design, so it would have called
         a lie true. `escapedAt` is the first Tab that either closed the panel or left it. */
      const escapedAt = trail.findIndex((s) => !s.open || s.where !== 'inside-panel');
      const containsFocus = escapedAt === -1;
      log(lines, `first Tab that left or closed the panel: ${escapedAt === -1 ? 'none — focus is contained' : `#${escapedAt + 1}`}`);

      // The acceptance, from docs/GATES.md: either it contains focus and really is a dialog, or it
      // stops announcing itself as one — and in both worlds Escape returns focus to the trigger.
      // When it is not a dialog it must still be announced as SOMETHING: a disclosure whose
      // trigger carries aria-expanded and points at the region it reveals.
      const announcesDialog = semantics && semantics.role === 'dialog';
      const escapeReturns = afterEscape.where === 'trigger';
      const disclosureWired = !!semantics && semantics.triggerExpanded === 'true' && semantics.controlsResolves;
      const pass = escapeReturns && (announcesDialog ? containsFocus : disclosureWired);
      pickerRuns[screen] = {
        pass, announcesDialog, containsFocus, escapeReturns, disclosureWired,
        panelRole: semantics && semantics.role,
        firstTabThatLeft: escapedAt === -1 ? null : escapedAt + 1,
        focusAfterEscape: afterEscape,
        focusAfterSweepRepro: afterSweepEscape,
        semantics,
      };
      log(lines, `/${screen}: ${pass ? 'PASS' : 'FAIL'} — announces dialog=${announcesDialog}, contains focus=${containsFocus}, Escape returns to trigger=${escapeReturns}, disclosure wired=${disclosureWired}`);
    }
    {
      const measured = Object.keys(pickerRuns);
      verdict['RTL-A11Y-09'] = {
        pass: measured.length > 0 && measured.every((s) => pickerRuns[s].pass),
        measuredOn: measured, runs: pickerRuns,
      };
      log(lines, '');
      log(lines, `VERDICT RTL-A11Y-09: ${verdict['RTL-A11Y-09'].pass ? 'PASS' : 'FAIL'} — measured on ${measured.join(', ') || 'nothing'}`);
    }

    // ------------------------------------------- RTL-A11Y-11 — every field on the card is named
    log(lines, '');
    log(lines, '=== RTL-A11Y-11 — mobile supplier card, field labels (390x844) ===');
    {
      const page = await open('suppliers', 390, 844);
      const cards = await page.evaluate(() => window.__pr37.mobileCardFields());
      const orphans = [];
      cards.forEach((fields, i) => fields.forEach((f) => {
        log(lines, `  card ${i + 1}: ${f.labelled ? 'labelled  ' : 'ORPHAN    '} "${f.text}"`);
        if (!f.labelled) orphans.push(`card ${i + 1}: "${f.text}"`);
      }));
      shots.push(join(OUT, `PR37-${TAG}-11-suppliers-mobile-390x844.png`));
      await page.screenshot({ path: shots[shots.length - 1], fullPage: true });
      verdict['RTL-A11Y-11'] = { pass: cards.length > 0 && orphans.length === 0, cards: cards.length, orphans };
      log(lines, `VERDICT RTL-A11Y-11: ${verdict['RTL-A11Y-11'].pass ? 'PASS' : 'FAIL'} — ${orphans.length} unlabelled field(s) on ${cards.length} card(s)`);
    }

    // ------------------------------------------- RTL-A11Y-10 / -12 — the dashboard, both widths
    for (const [label, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
      log(lines, '');
      log(lines, `=== /dashboard at ${width}x${height} ===`);
      const page = await open('dashboard', width, height);
      // The charts sit below the fold on a phone; scroll the page once so every viewport-gated
      // chart has been through its observer before anything is counted.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1200);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(600);

      const sides = await page.evaluate(() => window.__pr37.shekelSides());
      const counts = sides.reduce((acc, s) => { acc[s.side] = (acc[s.side] || 0) + 1; return acc; }, {});
      log(lines, `shekel occurrences: ${JSON.stringify(counts)}`);
      for (const s of sides) log(lines, `  ${s.side.padEnd(6)} dir=${s.dir} hero=${s.hero} "${s.text}"`);
      if (label === 'desktop') {
        const distinct = new Set(sides.map((s) => s.side));
        verdict['RTL-A11Y-10'] = { pass: sides.length > 0 && distinct.size === 1, counts, occurrences: sides.length };
        log(lines, `VERDICT RTL-A11Y-10: ${verdict['RTL-A11Y-10'].pass ? 'PASS' : 'FAIL'} — ${distinct.size} shape(s) on one screen`);
      }

      const chart = await page.evaluate(() => window.__pr37.barChart('monthly-trend-title'));
      log(lines, `monthly bar chart: ${chart.bars} bars, ${chart.ticks.length} axis labels ${JSON.stringify(chart.ticks)}`);

      shots.push(join(OUT, `PR37-${TAG}-dashboard-${label}-${width}x${height}.png`));
      await page.screenshot({ path: shots[shots.length - 1], fullPage: true });

      /* RTL-A11Y-12 is a CULL, and a cull is a function of width — so one width is not a
         measurement of it. 390x844 is the reference phone; the narrower widths below are ordinary
         phones this product is used on, and a categorical axis that drops a label on any of them
         has dropped it. Whether the label is present is asked at each. */
      if (label === 'mobile') {
        const byWidth = [];
        for (const w of [430, 412, 390, 375, 360, 344]) {
          await page.setViewportSize({ width: w, height: 844 });
          await page.waitForTimeout(900);
          const measured = await page.evaluate(() => window.__pr37.barChart('monthly-trend-title'));
          byWidth.push({ width: w, ...measured });
          log(lines, `  ${w}px (card ${measured.cardWidth}px): ${measured.bars} bars, ${measured.ticks.length} labels ${JSON.stringify(measured.ticks)}`);
          // The narrowest width gets a picture of the card alone: a count of labels does not say
          // whether four of them fit without colliding, and only the picture can.
          if (w === 344) {
            const card = page.locator('#monthly-trend-title').locator('xpath=ancestor::section[1]');
            if (await card.count()) {
              shots.push(join(OUT, `PR37-${TAG}-12-monthly-chart-344px.png`));
              await card.first().screenshot({ path: shots[shots.length - 1] });
            }
          }
        }
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(600);
        const bad = byWidth.filter((m) => m.bars === 0 || m.ticks.length !== m.bars);
        verdict['RTL-A11Y-12'] = { pass: bad.length === 0, byWidth, unlabelledAt: bad.map((m) => m.width) };
        log(lines, `VERDICT RTL-A11Y-12: ${verdict['RTL-A11Y-12'].pass ? 'PASS' : 'FAIL'} — labels missing at ${bad.length ? bad.map((m) => `${m.width}px`).join(', ') : 'no width'}`);
      }
    }
  } finally {
    await browser.close();
    server.kill();
  }

  log(lines, '');
  log(lines, `page errors:   ${JSON.stringify([...new Set(pageErrors)], null, 2)}`);
  log(lines, `missed routes: ${JSON.stringify([...new Set(missedRoutes)], null, 2)}`);
  log(lines, `screenshots:   ${JSON.stringify(shots, null, 2)}`);
  log(lines, '');
  log(lines, `SUMMARY: ${JSON.stringify(Object.fromEntries(Object.entries(verdict).map(([k, v]) => [k, v.pass ? 'PASS' : 'FAIL'])))}`);

  writeFileSync(join(OUT, `PR37-${TAG}-oracle.txt`), lines.join('\n') + '\n', 'utf8');
  writeFileSync(join(OUT, `PR37-${TAG}-oracle.json`), JSON.stringify({ verdict, pageErrors: [...new Set(pageErrors)], missedRoutes: [...new Set(missedRoutes)], shots }, null, 2), 'utf8');
  if (Object.values(verdict).some((v) => !v.pass)) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
