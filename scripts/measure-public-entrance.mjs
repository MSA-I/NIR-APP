#!/usr/bin/env node
/**
 * THE PUBLIC ENTRANCE, MEASURED IN A BROWSER — `/pricing`, `/login`, `/signup`, `/forgot-password`.
 *
 * Three of the four findings this script answers are invisible to every other gate in the repo,
 * and each of them is invisible for the same reason: they are LAYOUT, and layout only exists once
 * a browser has laid the page out.
 *
 *   `ENTRY-02`  At 390px `/pricing` rendered four plan names and four document counts. All 52
 *               entitlement rows were still in the DOM — a screen reader still got them — and
 *               `display: none` at 767px removed every one of them from the page with no control
 *               to open them again. A spec that reads markup passes against that defect; only a
 *               laid-out box can tell you the rows are gone.
 *   `ENTRY-06`  The free rung's `רק 30 יום ראשונים` badge is `white-space: nowrap` and `flex: none`
 *               inside a 209px card, so it left the card by nineteen pixels. Overflow is a
 *               rectangle, not a class name.
 *   `ENTRY-12`  Six controls on the entrance measured 16-20px tall on a phone against the 44px
 *               floor `plan-card.css` and `Entrance.tsx` both cite. A height is a measurement.
 *
 * IT NEEDS NO DATABASE AND NO SIGN-IN, deliberately — `/pricing` is a public page, and the three
 * catalogue RPCs are answered from a fixture injected into the page's own `fetch`. Nothing here
 * depends on the local Supabase stack being up, on its migration head, or on the demo seed, so
 * this measurement cannot be blocked by somebody else's broken environment. The fixture is
 * deliberately the sweep's own shape: four plans x thirteen rows = the 52 rows the finding
 * counted, five of them intro-only on the free rung so the badge is on screen to be measured.
 *
 * Environment, the sibling measurement's contract verbatim:
 *   PLAYWRIGHT_CORE_PATH   module id or path for playwright-core        (default: playwright-core)
 *   QUALITY_BROWSER_PATH   browser executable                           (default: system Edge)
 *   QUALITY_BASE_URL       the running dev/preview server               (default: :5199)
 *   MEASURE_OUT_DIR        where the JSON report and screenshots go     (optional)
 *   MEASURE_LABEL          a name for this run, e.g. RED / GREEN        (default: run)
 *   MEASURE_HEADLESS=1     opt out of the headed default, for CI
 *
 * Exit code is the verdict: 0 when every claim below holds, 1 when any of them does not.
 */
import { createRequire } from 'node:module';
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

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
/** The floor `src/styles/plan-card.css` and `src/pages/Entrance.tsx` both name, in pixels. */
const TARGET_FLOOR = 44;

/* ── the catalogue fixture ────────────────────────────────────────────────────────────────────
   Synthetic on purpose, and it is not the decision table: this measurement is about GEOMETRY, and
   a fixture that happened to match production would invite somebody to read a layout number as a
   commercial fact. What it does reproduce exactly is the SHAPE the sweep measured — four rungs,
   thirteen rows each, five of them intro-only on the free rung. */
const PLANS = ['free', 'basic', 'pro', 'premium'];
const PLAN_LABEL = { free: 'חינם', basic: 'בסיס', pro: 'פרו', premium: 'פרימיום' };

const CATALOGUE = PLANS.map((plan, index) => ({
  plan_key: plan, label: PLAN_LABEL[plan], tier_order: index + 1, currency: 'ILS',
  catalogue_version: 'qa-fixture', monthly_amount: [0, 69, 249, 449][index], yearly_amount: null,
}));

const quota = (plan, key, planLabel, limit, measured = true) => ({
  plan_key: plan, entitlement_key: key, label: planLabel, unit: key.split('.')[0],
  unlimited: false, numeric_limit: limit, measured,
});

/** Six quota keys: one is the headline figure, so five of them become rows on every card. */
const QUOTAS = [
  ...PLANS.map((plan, i) => quota(plan, 'documents.monthly', 'מסמכים', [25, 50, 300, 500][i])),
  ...PLANS.map((plan, i) => quota(plan, 'ocr_pages.monthly', 'עמודי סריקה', [250, 500, 3000, 5000][i])),
  ...PLANS.map((plan, i) => quota(plan, 'users.max', 'משתמשים פעילים', [1, 5, 15, 30][i])),
  ...PLANS.map((plan, i) => quota(plan, 'branches.max', 'סניפים', [1, 1, 1, 10][i])),
  ...PLANS.map((plan) => quota(plan, 'assistant_runs.monthly', 'ריצות עוזר', null, false)),
  ...PLANS.map((plan) => quota(plan, 'suppliers.max', 'ספקים', null, false)),
];

/**
 * Eight capabilities, and the five the free rung holds for thirty days are the five the finding
 * photographed wearing the badge. `documents.automation` carries the longest label on the card,
 * which is the row that wrapped one word per line.
 */
const CAPABILITIES = [
  { key: 'documents.automation', label: 'קריאה אוטומטית של מסמכים', from: 1, intro: true },
  { key: 'exports.accountant', label: 'ייצוא Excel ודוחות לרו״ח', from: 1, intro: true },
  { key: 'suppliers.scoreboard', label: 'לוח ביצועי ספקים', from: 1, intro: true },
  { key: 'bank.reconciliation', label: 'התאמות בנק', from: 2, intro: true },
  { key: 'payments.accountant_queue', label: 'תור תשלומים לרואה החשבון', from: 2, intro: true },
  { key: 'invoices.consolidated', label: 'חשבוניות מרכזות', from: 2, intro: false },
  { key: 'integrations.api', label: 'חיבור למערכות אחרות', from: 3, intro: false },
  { key: 'support.premium', label: 'תמיכה מורחבת', from: 3, intro: false },
];

const FEATURES = PLANS.flatMap((plan, tier) => CAPABILITIES.map((row, order) => ({
  plan_key: plan, entitlement_key: row.key, label: row.label,
  display_order: (order + 1) * 10,
  included: tier >= row.from,
  intro_included: tier === 0 && row.intro,
})));

/** 4 rungs x (5 quota rows + 8 capability rows). The number the finding counted on the desktop. */
const EXPECTED_ROWS = PLANS.length * ((new Set(QUOTAS.map((q) => q.entitlement_key)).size - 1) + CAPABILITIES.length);

const FIXTURE = {
  get_public_plan_catalogue: CATALOGUE,
  get_public_plan_quotas: QUOTAS,
  get_public_plan_features: FEATURES,
};

/* ── what is measured ─────────────────────────────────────────────────────────────────────── */

/** Runs in the page. Every `[data-row-state]` and whether the browser gave it a box. */
const readPricingRows = () => {
  const rows = [...document.querySelectorAll('[data-row-state]')];
  const laidOut = rows.filter((el) => {
    const box = el.getBoundingClientRect();
    return box.height > 0 && box.width > 0;
  });
  return {
    inDom: rows.length,
    laidOut: laidOut.length,
    /** A control that would open them again, if the card drew one. */
    expanders: document.querySelectorAll('.plan-card__more').length,
    bodyTextLength: (document.body.innerText || '').length,
  };
};

/** Runs in the page. Every intro badge, against the card it belongs to. */
const readBadges = () => {
  const out = [];
  for (const tag of document.querySelectorAll('.plan-row__tag')) {
    const card = tag.closest('.plan-card');
    const row = tag.closest('.plan-row');
    if (!card || !row) continue;
    const t = tag.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    out.push({
      plan: card.getAttribute('data-plan'),
      text: (tag.textContent || '').trim(),
      tagWidth: Math.round(t.width),
      cardWidth: Math.round(c.width),
      rowHeight: Math.round(row.getBoundingClientRect().height),
      /** Positive on either edge is the badge crossing its own card's border. */
      overflowStart: Math.round(c.left - t.left),
      overflowEnd: Math.round(t.right - c.right),
      label: (row.querySelector('.plan-row__label')?.textContent || '').trim(),
    });
  }
  const cards = [...document.querySelectorAll('.plan-card')].map((card) => ({
    plan: card.getAttribute('data-plan'),
    height: Math.round(card.getBoundingClientRect().height),
    tallestRow: Math.max(0, ...[...card.querySelectorAll('.plan-row')]
      .map((row) => Math.round(row.getBoundingClientRect().height))),
  }));
  return { badges: out, cards };
};

/** Runs in the page. One named control's rendered height. */
const readControl = (selector) => {
  const el = document.querySelector(selector);
  if (!el) return null;
  const box = el.getBoundingClientRect();
  return { text: (el.textContent || '').trim(), height: Math.round(box.height), width: Math.round(box.width) };
};

/**
 * The six controls the finding measured, addressed structurally rather than by their Hebrew, and
 * then checked against their expected wording — a selector that drifts onto a different control
 * must fail loudly rather than measure the wrong box.
 */
const ENTRANCE_TARGETS = [
  { route: '/login', selector: 'a[href="/forgot-password"]', expect: 'שכחתי סיסמה' },
  { route: '/login', selector: 'main form ~ p button', expect: 'להרשמה' },
  { route: '/login', selector: 'main > div a[href="/terms"]', expect: 'תנאי שימוש' },
  { route: '/login', selector: 'main > div a[href="/privacy"]', expect: 'מדיניות פרטיות' },
  { route: '/signup', selector: 'main form ~ p button', expect: 'התחברות' },
  { route: '/forgot-password', selector: 'a[href="/login"]', expect: 'חזרה למסך הכניסה' },
];

const shoot = async (page, name) => {
  if (!outDir) return null;
  const file = join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
};

const settle = async (page, url) => {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(350);
};

async function main() {
  if (outDir) mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless, executablePath: browserPath });
  const context = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 1 });

  /* The catalogue, answered inside the page. `page.route` would have to satisfy a CORS preflight
     for a cross-origin POST; patching `fetch` needs no preflight and no server at all. */
  await context.addInitScript((fixture) => {
    const native = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const hit = Object.keys(fixture).find((fn) => url.includes(`/rpc/${fn}`));
      if (!hit) return native(input, init);
      return Promise.resolve(new Response(JSON.stringify(fixture[hit]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    };
  }, FIXTURE);

  const page = await context.newPage();
  const report = { label, baseUrl, expectedRows: EXPECTED_ROWS, findings: {}, screenshots: {} };
  const failures = [];

  /* ── ENTRY-02 + ENTRY-06 on /pricing ───────────────────────────────────────────────────── */
  await page.setViewportSize(DESKTOP);
  await settle(page, `${baseUrl}/pricing`);
  await page.waitForSelector('[data-testid="plan-cards"]', { timeout: 15_000 });
  const desktopRows = await page.evaluate(readPricingRows);
  const desktopBadges = await page.evaluate(readBadges);
  report.screenshots['pricing-1440x900'] = await shoot(page, `PR36-pricing-1440x900-${label}`);

  await page.setViewportSize(PHONE);
  await settle(page, `${baseUrl}/pricing`);
  await page.waitForSelector('[data-testid="plan-cards"]', { timeout: 15_000 });
  const phoneRows = await page.evaluate(readPricingRows);
  report.screenshots['pricing-390x844'] = await shoot(page, `PR36-pricing-390x844-${label}`);

  report.findings['ENTRY-02'] = { desktop: desktopRows, phone: phoneRows };
  report.findings['ENTRY-06'] = desktopBadges;

  /* The desktop reference first: a phone claim measured against a broken desktop proves nothing. */
  if (desktopRows.laidOut !== EXPECTED_ROWS) {
    failures.push(`ENTRY-02 reference: 1440x900 laid out ${desktopRows.laidOut} entitlement rows, `
      + `expected ${EXPECTED_ROWS} (in DOM: ${desktopRows.inDom}). The fixture or the page changed.`);
  }
  if (phoneRows.laidOut !== desktopRows.laidOut) {
    failures.push(`ENTRY-02: 390x844 lays out ${phoneRows.laidOut} of the ${desktopRows.inDom} `
      + `entitlement rows in the DOM, against ${desktopRows.laidOut} on the desktop, and offers `
      + `${phoneRows.expanders} control(s) to open them. A visitor on a phone cannot tell the `
      + 'plans apart.');
  }

  const escaping = desktopBadges.badges.filter((b) => b.overflowStart > 0 || b.overflowEnd > 0);
  if (escaping.length) {
    failures.push(`ENTRY-06: ${escaping.length} intro badge(s) cross their own card's border — `
      + escaping.map((b) => `${b.plan} "${b.text}" by ${Math.max(b.overflowStart, b.overflowEnd)}px `
        + `(card ${b.cardWidth}px, badge ${b.tagWidth}px, row ${b.rowHeight}px)`).join('; '));
  }
  if (!desktopBadges.badges.length) {
    failures.push('ENTRY-06: no intro badge was rendered at all, so nothing was measured. The '
      + 'fixture must put the free rung on screen wearing one.');
  }

  /* ── ENTRY-12 on the three entrance routes ─────────────────────────────────────────────── */
  const controls = [];
  for (const target of ENTRANCE_TARGETS) {
    await page.setViewportSize(PHONE);
    await settle(page, `${baseUrl}${target.route}`);
    const measured = await page.evaluate(readControl, target.selector);
    controls.push({ ...target, measured });
    if (!measured) {
      failures.push(`ENTRY-12: ${target.route} — nothing matched \`${target.selector}\`, so the `
        + `control «${target.expect}» was not measured.`);
      continue;
    }
    if (!measured.text.includes(target.expect)) {
      failures.push(`ENTRY-12: ${target.route} \`${target.selector}\` matched «${measured.text}», `
        + `not «${target.expect}» — the selector drifted onto a different control.`);
      continue;
    }
    if (measured.height < TARGET_FLOOR) {
      failures.push(`ENTRY-12: ${target.route} «${measured.text}» is ${measured.height}px tall at `
        + `390x844, under the product's own ${TARGET_FLOOR}px floor.`);
    }
  }
  report.findings['ENTRY-12'] = controls;

  for (const route of ['/login', '/signup', '/forgot-password']) {
    await page.setViewportSize(PHONE);
    await settle(page, `${baseUrl}${route}`);
    report.screenshots[`${route.slice(1)}-390x844`] = await shoot(page, `PR36-${route.slice(1)}-390x844-${label}`);
    await page.setViewportSize(DESKTOP);
    await settle(page, `${baseUrl}${route}`);
    report.screenshots[`${route.slice(1)}-1440x900`] = await shoot(page, `PR36-${route.slice(1)}-1440x900-${label}`);
  }

  await browser.close();

  report.failures = failures;
  report.verdict = failures.length ? 'FAIL' : 'PASS';
  const text = JSON.stringify(report, null, 2);
  if (outDir) writeFileSync(join(outDir, `PR36-measurement-${label}.json`), `${text}\n`, 'utf8');

  console.log(`— /pricing 1440x900: ${desktopRows.laidOut}/${desktopRows.inDom} entitlement rows laid out`);
  console.log(`— /pricing 390x844 : ${phoneRows.laidOut}/${phoneRows.inDom} entitlement rows laid out, `
    + `${phoneRows.expanders} expander(s), body text ${phoneRows.bodyTextLength} chars`);
  for (const b of desktopBadges.badges) {
    console.log(`— badge ${b.plan} «${b.text}» card ${b.cardWidth}px, badge ${b.tagWidth}px, `
      + `row ${b.rowHeight}px, overflow start ${b.overflowStart}px / end ${b.overflowEnd}px, `
      + `label «${b.label}»`);
  }
  for (const c of desktopBadges.cards) console.log(`— card ${c.plan}: ${c.height}px, tallest row ${c.tallestRow}px`);
  for (const c of controls) {
    console.log(`— ${c.route} «${c.expect}»: ${c.measured ? `${c.measured.height}px` : 'NOT FOUND'}`);
  }
  console.log(`\n${report.verdict} — ${failures.length} failure(s)`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
