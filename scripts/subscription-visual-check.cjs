// Visual verification of the rebuilt plan ladder (26.08.2026). Serves the built dist with
// `vite preview`, intercepts Supabase at the network edge with fixtures, and screenshots the two
// surfaces that draw a plan card — `/settings/subscription` and `/pricing` — at 390 and 1280, in
// the three subscription states the panel can be in.
//
// HEADED ON PURPOSE — headless misses injected CSS on this machine (memory:
// headless-screenshot-stale-css). Copied from `scripts/portal-visual-check.cjs`, which is the
// pattern this repo already trusts for a one-off visual claim.
//
// WHY FIXTURES AND NOT THE DEMO STACK. Two reasons, and the first is decisive: the "paid" state
// cannot exist in the local demo database without WRITING a billing period, and
// `private.record_billing_period` is reached only from a verified provider event or an operator
// command carrying a reason. Manufacturing one to take a screenshot would be manufacturing the
// exact fact this whole screen exists to never invent. The second is that other agents share this
// machine's Supabase stack, and a screenshot run must not touch it.
//
// Not wired into any gate; run manually:
//   node scripts/subscription-visual-check.cjs
const { chromium } = require('playwright-core');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { mkdirSync } = require('node:fs');

const ROOT = join(__dirname, '..');
const OUT = process.env.PLAN_SHOT_DIR || join(ROOT, '.plan-shots');
const PORT = 5199 + 701; // isolated preview port, away from dev, the gate and the portal check
const API = 'http://127.0.0.1:55431'; // matches VITE_SUPABASE_URL in .env.local

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

/** A JWT the client only ever decodes — the signature is never checked in the browser. */
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = () => [
  b64({ alg: 'HS256', typ: 'JWT' }),
  b64({
    sub: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'shots@example.test',
    exp: Math.floor(Date.now() / 1000) + 60 * 60,
  }),
  'signature-not-verified-in-browser',
].join('.');

const USER = {
  id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'shots@example.test',
  app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString(),
};
const SESSION = () => ({
  access_token: token(), token_type: 'bearer', expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'refresh-not-used', user: USER,
});

const PROFILE = {
  id: USER_ID, org_id: ORG_ID, full_name: 'בעלים לבדיקה', role: 'owner',
  phone: null, active: true, supplier_id: null,
};
const ORGANIZATION = {
  id: ORG_ID, name: 'מסעדת הגן הקסום', vat_rate: 18, status: 'active',
  logo_path: null, logo_updated_at: null, settings: { bank_match_days: 5, bank_match_amount_tolerance: 1 },
};

const PLAN_QUOTAS = [
  ['free', 20, 1, 1], ['basic', 40, 5, 1], ['pro', 150, 15, 1], ['premium', 375, 30, 10],
].flatMap(([plan_key, documents, users, branches]) => ([{
  plan_key, entitlement_key: 'documents.monthly', label: 'מסמכים', unit: 'מסמכים',
  unlimited: false, numeric_limit: documents, measured: true,
}, {
    plan_key, entitlement_key: 'users.max', label: 'משתמשים', unit: 'משתמשים',
    unlimited: false, numeric_limit: users, measured: true,
  }, {
    plan_key, entitlement_key: 'branches.max', label: 'סניפים', unit: 'סניפים',
    unlimited: false, numeric_limit: branches, measured: true,
  }]));

const FEATURE_DEFINITIONS = [
  ['documents.automation', 'קריאה אוטומטית של מסמכים', 10, 2, true],
  ['history.full', 'היסטוריה מלאה', 20, 2, true],
  ['exports.custom', 'ייצוא Excel ודוחות לרו״ח', 30, 2, true],
  ['reports.advanced', 'לוח ביצועי ספקים', 40, 2, true],
  ['notifications.email', 'התראות ואוטומציות במייל', 50, 2, true],
  ['bank.reconciliation', 'התאמות בנק', 60, 3, false],
  ['payments.accountant_queue', 'תור תשלומים לרואה החשבון', 70, 3, false],
  ['invoices.consolidated', 'חשבוניות מרכזות', 80, 3, false],
  ['org.multi_unit', 'עד 10 סניפים', 90, 4, false],
  ['integrations.api', 'חיבור למערכות אחרות', 100, 4, false],
  ['support.premium', 'תמיכה מורחבת', 110, 4, false],
];
const PLAN_FEATURES = ['free', 'basic', 'pro', 'premium', 'business'].flatMap((plan_key, tier) =>
  FEATURE_DEFINITIONS.map(([entitlement_key, label, display_order, minimumTier, intro]) => ({
    plan_key, entitlement_key, label, display_order,
    included: plan_key === 'business' || tier + 1 >= minimumTier,
    intro_included: plan_key === 'free' && intro,
  })));

const option = (plan_key, label, tier_order, over = {}) => ({
  plan_key, label, tier_order, paid: plan_key !== 'free', contact_sales: false,
  currency: null, catalogue_version: null, monthly_amount: null, yearly_amount: null, ...over,
});
const OPTIONS = [
  option('free', 'חינם', 1), option('basic', 'בסיס', 2), option('pro', 'פרו', 3),
  option('premium', 'פרימיום', 4), option('business', 'ביזנס', 5, { contact_sales: true }),
];
/** The catalogue the public page reads. Four rungs — #194 keeps `ביזנס` off it. */
const CATALOGUE = ['ILS', 'USD'].flatMap((currency) => OPTIONS.slice(0, 4).map((o) => ({
  plan_key: o.plan_key, label: o.label, tier_order: o.tier_order, currency,
  catalogue_version: currency === 'ILS' ? 'il-2026-08' : 'global-2026-08',
  monthly_amount: (currency === 'ILS'
    ? { free: 0, basic: 69, pro: 249, premium: 449 }
    : { free: 0, basic: 20, pro: 79, premium: 149 })[o.plan_key] ?? null,
  yearly_amount: (currency === 'ILS'
    ? { free: 0, basic: 690, pro: 2490, premium: 4490 }
    : { free: 0, basic: 200, pro: 790, premium: 1490 })[o.plan_key] ?? null,
})));

const subscription = (over = {}) => ({
  plan_key: 'free', plan_label: 'חינם', is_paid_plan: false, status: 'active',
  billing_interval: 'monthly', current_period_end: null, cancel_at_period_end: false,
  scheduled_plan_key: null, scheduled_plan_label: null, scheduled_interval: null,
  scheduled_effective_at: null, delinquent: false, billing_country: null,
  billing_country_verified: false, catalogue_currency: null, billing_provider_enabled: false,
  ...over,
});
const grant = (over = {}) => ({
  granted: false, ends_at: null, reverts_to_plan_key: 'free', reverts_to_label: 'חינם',
  has_paid: false, ...over,
});

/** The three states the panel can be in, and the only three worth a picture. */
const STATES = {
  free: {
    subscription: subscription(),
    grant: grant(),
    options: OPTIONS,
  },
  granted: {
    subscription: subscription({ plan_key: 'premium', plan_label: 'פרימיום', is_paid_plan: true }),
    grant: grant({ granted: true, ends_at: '2027-01-01T00:00:00.000Z' }),
    options: OPTIONS,
  },
  // The fourth metal. `basic` is the only rung whose chip (silver) no other state puts on screen,
  // and DESIGN.md:503 is a claim about all of them: the mark in the header is the mark on the card.
  basic: {
    subscription: subscription({ plan_key: 'basic', plan_label: 'בסיס', is_paid_plan: true }),
    grant: grant({ has_paid: true }),
    options: OPTIONS,
  },
  // A real billing period, a verified billing country, and therefore real amounts. This is the
  // only state in which the price slot holds a figure instead of «—».
  paid: {
    subscription: subscription({
      plan_key: 'pro', plan_label: 'פרו', is_paid_plan: true,
      current_period_end: '2026-09-15T00:00:00.000Z',
      billing_country: 'IL', billing_country_verified: true, catalogue_currency: 'ILS',
    }),
    grant: grant({ has_paid: true }),
    options: OPTIONS.map((o) => (o.contact_sales ? o : {
      ...o,
      currency: 'ILS',
      catalogue_version: 'il-2026-08',
      monthly_amount: { free: 0, basic: 69, pro: 249, premium: 449 }[o.plan_key] ?? null,
      yearly_amount: { free: null, basic: 690, pro: 2490, premium: 4490 }[o.plan_key] ?? null,
    })),
  },
};

const USAGE = [
  { metric_key: 'documents.monthly', label: 'מסמכים', used: 96, usage_limit: 150, unlimited: false, measured: true, remaining: 54, percent_used: 64, period_end: '2026-09-04T00:00:00.000Z' },
  { metric_key: 'users.max', label: 'משתמשים', used: null, usage_limit: null, unlimited: false, measured: false, remaining: null, percent_used: null, period_end: null },
];

function rpcBody(name, state) {
  switch (name) {
    case 'my_subscription': return [state.subscription];
    case 'my_upgrade_options': return state.options;
    case 'my_plan_grant': return state.grant;
    case 'get_public_plan_quotas': return PLAN_QUOTAS;
    case 'get_public_plan_catalogue': return CATALOGUE;
    case 'get_public_plan_features': return PLAN_FEATURES.filter((row) => row.plan_key !== 'business');
    case 'my_plan_features': return PLAN_FEATURES;
    case 'organization_usage_snapshot': return USAGE;
    case 'organization_access_state': return [{ access_mode: 'active' }];
    case 'resolve_feature_flags': return [];
    default: return [];
  }
}

/**
 * One route handler for the whole Supabase surface. Auth answers a session so AuthProvider
 * bootstraps; `/rest/v1/rpc/<name>` answers from the fixture for the state under test; every other
 * table read answers an empty collection, which is what the shell's own queries expect.
 */
async function installFixtures(context, state) {
  await context.route(`${API}/**`, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(body),
    });

    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': '*',
        },
      });
    }
    if (path.startsWith('/auth/v1/token')) return json(SESSION());
    if (path.startsWith('/auth/v1/user')) return json(USER);
    if (path.startsWith('/auth/v1/logout')) return json({});
    if (path.startsWith('/rest/v1/rpc/')) {
      return json(rpcBody(path.slice('/rest/v1/rpc/'.length), state));
    }
    if (path.startsWith('/rest/v1/profiles')) return json([PROFILE]);
    if (path.startsWith('/rest/v1/organizations')) return json([ORGANIZATION]);
    if (path.startsWith('/rest/v1/platform_admins')) return json([]);
    if (path.startsWith('/rest/v1/')) return json([]);
    return json({});
  });
}

async function signIn(page, baseURL) {
  await page.goto(`${baseURL}/login`);
  await page.locator('#email').fill('shots@example.test');
  await page.locator('#password').fill('not-a-real-password');
  await page.getByRole('button', { name: /התחברות|כניסה/ }).first().click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20000 });
}

const VIEWPORTS = [['390', 390, 844], ['1280', 1280, 900]];

/**
 * "The body must never scroll horizontally" is a rule the repo already holds, and a bare
 * scrollWidth delta reports THAT it broke without saying WHERE. This names the offenders, so a
 * failure is an address rather than the start of a hunt.
 */
async function overflowReport(page) {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    const delta = document.documentElement.scrollWidth - limit;
    if (delta <= 0) return null;
    const guilty = [...document.querySelectorAll('body *')]
      .map((el) => ({ el, rect: el.getBoundingClientRect() }))
      .filter(({ el, rect }) => (rect.right > limit + 1 || rect.left < -1)
        || el.scrollWidth > el.clientWidth + 1)
      .slice(0, 40)
      .map(({ el, rect }) => `${el.tagName.toLowerCase()}.${(el.className || '').toString().slice(0, 70)}`
        + ` [${Math.round(rect.left)}..${Math.round(rect.right)}] sw=${el.scrollWidth}/cw=${el.clientWidth}`);
    return `horizontal overflow ${delta}px (client ${limit}) — ${guilty.join(' | ') || 'no element exceeds the viewport'}`;
  });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const viteBin = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const preview = spawn(process.execPath, [viteBin, 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT, shell: false, stdio: 'pipe',
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('preview did not start')), 30000);
    let stderr = '';
    preview.stderr.on('data', (d) => { stderr += String(d); });
    preview.stdout.on('data', (d) => { if (String(d).includes('Local')) { clearTimeout(timer); resolve(); } });
    preview.on('exit', () => {
      clearTimeout(timer);
      reject(new Error(`preview exited${stderr ? `: ${stderr.trim()}` : ''}`));
    });
  });
  const baseURL = `http://localhost:${PORT}`;

  const browser = await chromium.launch({
    headless: false,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  });
  const shots = [];
  try {
    for (const [stateName, state] of Object.entries(STATES)) {
      for (const [label, width, height] of VIEWPORTS) {
        const context = await browser.newContext({
          viewport: { width, height }, locale: 'he-IL', serviceWorkers: 'block',
        });
        await installFixtures(context, state);
        const page = await context.newPage();
        await signIn(page, baseURL);
        await page.goto(`${baseURL}/settings/subscription`);
        await page.getByTestId('plan-cards').waitFor({ timeout: 20000 });
        // The tier chip in the header is part of the claim: the mark you click is the mark you
        // find on the plans screen (DESIGN.md:503). It is the phone header, so 390 only.
        // It is mounted on every route but only PAINTED in the phone header, so `count()` is not
        // the question — visibility is. At 1280 it is present and hidden, and asking a hidden
        // element for a screenshot is a two-minute timeout, not a failure worth reporting.
        const badge = page.getByTestId('plan-badge').first();
        if (await badge.isVisible()) {
          const file = join(OUT, `badge-${stateName}-${label}.png`);
          await badge.screenshot({ path: file });
          shots.push(file);
        }
        const overflow = await overflowReport(page);
        if (overflow) throw new Error(`subscription-${stateName}-${label}: ${overflow}`);
        const file = join(OUT, `subscription-${stateName}-${label}.png`);
        await page.screenshot({ path: file, fullPage: true });
        shots.push(file);

        // The two rows that carry a state, on their own, so the fill / outline / chip / button
        // treatment can be judged at the size a person actually reads them.
        if (label === '1280') {
          for (const planKey of ['premium', state.subscription.plan_key]) {
            // Scoped to the grid: `PlanBadge` also carries `data-plan`, and an unscoped locator
            // photographs the header chip instead of the card.
            const card = page.locator(`[data-testid="plan-cards"] [data-plan="${planKey}"]`).first();
            if (!(await card.count())) continue;
            const cardFile = join(OUT, `row-${planKey}-${stateName}.png`);
            await card.screenshot({ path: cardFile });
            shots.push(cardFile);
          }
        }
        await context.close();
      }
    }

    // The public ladder. It reads no subscription, so one state is the whole page.
    for (const [label, width, height] of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width, height }, locale: 'he-IL', serviceWorkers: 'block',
      });
      await installFixtures(context, STATES.free);
      const page = await context.newPage();
      await page.goto(`${baseURL}/pricing`);
      await page.getByTestId('plan-cards').waitFor({ timeout: 20000 });
      const overflow = await overflowReport(page);
      if (overflow) throw new Error(`pricing-${label}: ${overflow}`);
      const file = join(OUT, `pricing-${label}.png`);
      await page.screenshot({ path: file, fullPage: true });
      shots.push(file);
      await context.close();
    }

    // REDUCED MOTION, and the one thing it must prove: the premium sheen STOPS. `index.css` hides
    // `.plan-badge-premium::after` outright under the query — a sheen frozen mid-pass reads as a
    // rendering fault — while `.btn-rainbow` only freezes, because that band IS the button border.
    {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 }, locale: 'he-IL', serviceWorkers: 'block',
        reducedMotion: 'reduce',
      });
      await installFixtures(context, STATES.paid);
      const page = await context.newPage();
      await signIn(page, baseURL);
      await page.goto(`${baseURL}/settings/subscription`);
      await page.getByTestId('plan-cards').waitFor({ timeout: 20000 });
      const motion = await page.evaluate(() => {
        const chip = document.querySelector('.plan-badge-premium');
        const rainbow = document.querySelector('.btn-rainbow');
        const read = (el, pseudo) => (el
          ? (({ animationName, display }) => ({ animationName, display }))(getComputedStyle(el, pseudo))
          : null);
        return {
          prefersReduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
          sheen: read(chip, '::after'),
          rainbow: read(rainbow, null),
        };
      });
      const file = join(OUT, 'subscription-paid-1280-reduced-motion.png');
      await page.screenshot({ path: file, fullPage: true });
      shots.push(file);
      console.log('reduced-motion probe:', JSON.stringify(motion));
      if (!motion.prefersReduced) throw new Error('reduced-motion context did not take effect');
      if (motion.sheen && motion.sheen.display !== 'none') {
        throw new Error(`premium sheen still painted under reduced motion: ${JSON.stringify(motion.sheen)}`);
      }
      await context.close();
    }

    console.log(`plan visual check: OK, ${shots.length} shots in ${OUT}`);
  } finally {
    await browser.close();
    preview.kill('SIGTERM');
    setTimeout(() => { try { process.kill(preview.pid); } catch { /* gone */ } }, 1500);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
