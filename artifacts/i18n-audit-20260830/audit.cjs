/**
 * English-locale screen audit.
 *
 * Signs in to the local demo stack with the locale pinned to `en`, walks every owner-reachable
 * route, screenshots it, and records every Hebrew string still visible on the page.
 *
 * Each finding is classified against the product source, because Hebrew on an English screen has
 * two very different causes:
 *   HARDCODED — the string exists as a literal in src/ (outside the dictionaries and specs). This
 *               is a translation hole: the same words appear no matter what the reader chose.
 *   DATA      — the string is not in the source. It came out of the database: a supplier name, a
 *               product name, a typed note. Translating it is a different question entirely.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'artifacts', 'i18n-audit-20260830');
const SHOTS = path.join(OUT, 'shots');
const BASE = 'http://127.0.0.1:5290';
const CHROME = 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe';
const HEBREW = /[\u0590-\u05FF]/;

// ---------------------------------------------------------------- source index
/** Every Hebrew string literal that ships in product source, mapped to the files it lives in. */
function sourceHebrewIndex() {
  const index = new Map();
  const skip = (rel) =>
    rel.includes('/i18n/dictionaries/') || rel === 'src/portal/i18n.ts' || /\.spec\.tsx?$/.test(rel);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(entry)) continue;
      const rel = path.relative(ROOT, full).split(path.sep).join('/');
      if (skip(rel)) continue;
      const src = fs.readFileSync(full, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      // string literals AND raw JSX text, both of which reach the screen
      for (const m of src.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`|>([^<>{}]+)</g)) {
        const value = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').trim();
        if (!value || !HEBREW.test(value)) continue;
        for (const piece of value.split(/\$\{[^}]*\}|\{[^}]*\}/)) {
          const clean = piece.trim();
          if (clean.length < 2 || !HEBREW.test(clean)) continue;
          if (!index.has(clean)) index.set(clean, new Set());
          index.get(clean).add(rel);
        }
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  return index;
}

const SOURCE = sourceHebrewIndex();
const SOURCE_KEYS = [...SOURCE.keys()].sort((a, b) => b.length - a.length);

/** Does this on-screen string come from a literal in the source, and if so from where. */
function classify(text) {
  const clean = text.trim();
  if (SOURCE.has(clean)) return { kind: 'HARDCODED', files: [...SOURCE.get(clean)], matched: clean };
  for (const key of SOURCE_KEYS) {
    if (key.length >= 4 && clean.includes(key)) {
      return { kind: 'HARDCODED', files: [...SOURCE.get(key)], matched: key };
    }
  }
  return { kind: 'DATA', files: [], matched: null };
}

// ---------------------------------------------------------------- page probe
const PROBE = () => {
  const HEB = /[\u0590-\u05FF]/;
  const found = [];
  const seen = new Set();
  const label = (el) => {
    const parts = [];
    let node = el;
    for (let i = 0; node && i < 3; i += 1) {
      let piece = node.tagName ? node.tagName.toLowerCase() : '';
      if (node.id) piece += '#' + node.id;
      else if (node.className && typeof node.className === 'string') {
        const first = node.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (first) piece += '.' + first;
      }
      parts.unshift(piece);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const push = (text, el, source) => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean || !HEB.test(clean)) return;
    const key = source + '|' + clean;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ text: clean, where: label(el), source, visible: visible(el) });
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const el = n.parentElement;
    if (!el || el.closest('script,style')) continue;
    push(n.nodeValue || '', el, 'text');
  }
  for (const el of document.querySelectorAll('[aria-label],[placeholder],[title],[alt]')) {
    for (const attr of ['aria-label', 'placeholder', 'title', 'alt']) {
      const v = el.getAttribute(attr);
      if (v) push(v, el, attr);
    }
  }
  return {
    findings: found,
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
    bodyLength: document.body.innerText.length,
  };
};

// ---------------------------------------------------------------- routes
const IDS = {
  supplier: 'aa000000-0000-4000-8000-000000000001',
  invoice: 'f4000000-0000-4000-8000-000000000008',
  order: 'f0000000-0000-4000-8000-000000000001',
  doc: 'f1111111-1111-4111-8111-111111111112',
};

const PUBLIC_ROUTES = [
  ['login', '/login'],
  ['signup', '/signup'],
  ['pricing', '/pricing'],
  ['forgot-password', '/forgot-password'],
  ['reset-password', '/reset-password'],
  ['accept-invite', '/accept-invite'],
  ['operator-invite', '/operator-invite'],
  ['terms', '/terms'],
  ['privacy', '/privacy'],
];

const OWNER_ROUTES = [
  ['dashboard', '/dashboard'],
  ['suppliers', '/suppliers'],
  ['supplier-detail', '/suppliers/' + IDS.supplier],
  ['finance-supplier', '/finance/suppliers/' + IDS.supplier],
  ['products', '/products'],
  ['inventory', '/inventory'],
  ['prices', '/prices'],
  ['orders', '/orders'],
  ['order-new', '/orders/new'],
  ['order-detail', '/orders/' + IDS.order],
  ['receiving', '/receiving'],
  ['receive-order', '/receiving/' + IDS.order],
  ['invoices', '/invoices'],
  ['invoice-new', '/invoices/new'],
  ['invoice-detail', '/invoices/' + IDS.invoice],
  ['documents', '/documents'],
  ['documents-archive', '/documents/archive'],
  ['documents-operations', '/documents/operations'],
  ['documents-consolidated', '/documents/consolidated-invoices'],
  ['document-review', '/documents/' + IDS.doc + '/review'],
  ['credits', '/credits'],
  ['payment-requests', '/payment-requests'],
  ['payments', '/payments'],
  ['bank', '/bank'],
  ['exceptions', '/exceptions'],
  ['alerts', '/alerts'],
  ['expenses', '/expenses'],
  ['reports', '/reports'],
  ['reports-products', '/reports/products'],
  ['analytics', '/analytics'],
  ['supplier-log', '/supplier-log'],
  ['settings', '/settings'],
  ['settings-webhooks', '/settings/webhooks'],
  ['settings-subscription', '/settings/subscription'],
  ['onboarding', '/onboarding'],
];

async function settle(page) {
  // A dev server that has just re-optimized answers the first module request with 504 and the
  // root stays empty. One reload is the documented recovery; without it every screen in the run
  // would be a blank page that looks like a finding.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    for (let i = 0; i < 40; i += 1) {
      const len = await page.evaluate(() => document.body.innerText.length).catch(() => 0);
      const busy = await page.locator('.animate-spin').count().catch(() => 0);
      if (len > 120 && busy === 0) { await page.waitForTimeout(900); return; }
      await page.waitForTimeout(400);
    }
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  await page.waitForTimeout(900);
}

async function capture(page, name, route, report) {
  await page.goto(BASE + route, { waitUntil: 'domcontentloaded' });
  await settle(page);
  const shot = path.join(SHOTS, name + '.png');
  await page.screenshot({ path: shot, fullPage: true });
  const probe = await page.evaluate(PROBE);
  const findings = probe.findings.map((f) => Object.assign({}, f, classify(f.text)));
  const hard = findings.filter((f) => f.kind === 'HARDCODED');
  const data = findings.filter((f) => f.kind === 'DATA');
  report.push({
    name, route, url: page.url(), lang: probe.lang, dir: probe.dir,
    bodyLength: probe.bodyLength, shot: path.relative(ROOT, shot).split(path.sep).join('/'),
    hardcoded: hard, dataStrings: data,
  });
  console.log(
    String(hard.length).padStart(3) + ' hardcoded / ' + String(data.length).padStart(3) + ' data  ' +
    '[lang=' + probe.lang + ' dir=' + probe.dir + ']  ' + name + '  ' + page.url().replace(BASE, ''),
  );
}

(async () => {
  console.log('source Hebrew literals indexed: ' + SOURCE.size);
  const browser = await chromium.launch({ headless: false, executablePath: CHROME });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: 'en-US',
    reducedMotion: 'reduce',
  });
  await context.addInitScript(() => {
    try { window.localStorage.setItem('inplace.locale', 'en'); } catch { /* private window */ }
  });
  const page = await context.newPage();
  const report = [];

  for (const [name, route] of PUBLIC_ROUTES) await capture(page, 'public-' + name, route, report);

  // sign in as the demo owner through the dev-only panel, so no password is read or printed
  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
  await settle(page);
  await page.locator('summary').first().click();
  await page.getByRole('button', { name: /owner|manager|בעלים|מנהל/i }).first().click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 45000 });
  await settle(page);
  console.log('signed in -> ' + page.url());

  for (const [name, route] of OWNER_ROUTES) await capture(page, 'owner-' + name, route, report);

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  await browser.close();
  console.log('report written');
})().catch((e) => { console.error(e); process.exit(1); });
