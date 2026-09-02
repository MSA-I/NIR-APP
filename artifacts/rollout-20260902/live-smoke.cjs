// Live read-only smoke for the 0243-0283 rollout, section 10 of the plan.
//
// Signs in as the three authorised demo identities, visits the screens the rollout could have
// broken, proves the retired identities are still refused, and makes ONE assistant call. It
// submits no business form; every non-GET the app makes is recorded and printed so a stray write
// cannot hide.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const BASE = process.env.SMOKE_BASE_URL || 'https://app.inplace.digital';
const OUT = process.env.SMOKE_OUT;
const CHROME = process.env.CHROME_PATH;
const CREDS = process.env.SMOKE_CREDENTIALS;

const creds = new Map(
  fs.readFileSync(CREDS, 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^\s*([^#\s:]+@[a-z.]+)\s*:\s*(.+?)\s*$/i))
    .filter(Boolean)
    .map((m) => [m[1].toLowerCase(), m[2]]),
);
const pw = (email) => {
  const p = creds.get(email);
  if (!p) throw new Error(`no credential for ${email}`);
  return p;
};

const findings = [];
const say = (s) => { console.log(s); findings.push(s); };

function watch(page, label) {
  const errors = [];
  const writes = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`));
  page.on('request', (r) => {
    const m = r.method();
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return;
    const u = r.url();
    // Auth token exchange and the assistant call are expected and named as such.
    if (/\/auth\/v1\/(token|logout)/.test(u)) return;
    writes.push(`${m} ${u.replace(/^https?:\/\/[^/]+/, '')}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !/\/auth\/v1\/token/.test(r.url())) {
      errors.push(`http ${r.status()} ${r.url().replace(/^https?:\/\/[^/]+/, '').slice(0, 120)}`);
    }
  });
  return { label, errors, writes };
}

async function signIn(page, email) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#email', { timeout: 30000 });
  await page.fill('#email', email);
  await page.fill('#password', pw(email));
  await page.click('button[type="submit"]');
}

async function visit(page, route) {
  await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
  return (await page.textContent('body')) || '';
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: false });

  // ---- 1. the three product identities sign in and read ------------------------------------
  const routesByRole = {
    'owner@gamos.demo': ['/dashboard', '/bank', '/pay', '/documents/consolidated-invoices',
      '/settings/subscription', '/alerts', '/suppliers', '/invoices'],
    'office@gamos.demo': ['/dashboard', '/orders', '/suppliers'],
    'accountant@gamos.demo': ['/dashboard', '/invoices', '/payments'],
  };

  for (const [email, routes] of Object.entries(routesByRole)) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const w = watch(page, email);
    await signIn(page, email);
    await page.waitForURL((u) => !/\/login$/.test(u.pathname), { timeout: 45000 })
      .catch(() => { throw new Error(`${email}: never left /login`); });
    say(`SIGNED IN  ${email}`);

    for (const route of routes) {
      const body = await visit(page, route);
      const blocked = /אין לך הרשאה|לא נמצא|שגיאה בטעינה|Something went wrong/.test(body);
      say(`  ${route.padEnd(36)} ${body.trim().length} chars${blocked ? '  <-- BLOCKED/ERROR' : ''}`);
      if (route === '/dashboard') {
        await page.screenshot({ path: path.join(OUT, `dashboard-${email.split('@')[0]}.png`), fullPage: false });
      }
      if (route === '/settings/subscription') {
        const keys = ['מסמכים בחודש', 'משתמשים פעילים', 'סניפים'].filter((k) => body.includes(k));
        say(`     subscription quota labels present: ${keys.length}/3 [${keys.join(', ')}]`);
        await page.screenshot({ path: path.join(OUT, 'subscription.png'), fullPage: false });
      }
    }

    // ---- the one assistant call, owner only ------------------------------------------------
    if (email === 'owner@gamos.demo') {
      const res = await page.evaluate(async (base) => {
        const k = Object.keys(localStorage).find((x) => /^sb-.*-auth-token$/.test(x));
        if (!k) return { ok: false, why: 'no session in localStorage' };
        const token = JSON.parse(localStorage.getItem(k)).access_token;
        const r = await fetch(`${base}/functions/v1/assistant`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: token },
          body: JSON.stringify({ question: 'מה מצב ההזמנות הפתוחות?', conversation_id: null, route: '/dashboard', locale: null }),
        });
        const text = await r.text();
        return { ok: r.ok, status: r.status, sample: text.slice(0, 400) };
      }, 'https://rkftlbctohswhbbiaqin.supabase.co');
      say(`  ASSISTANT  status ${res.status} ok=${res.ok}`);
      say(`     ${JSON.stringify(res.sample || res.why).slice(0, 400)}`);
    }

    say(`  console/page/http errors: ${w.errors.length}`);
    for (const e of w.errors.slice(0, 8)) say(`     ${e}`);
    say(`  non-GET requests: ${w.writes.length}`);
    for (const x of [...new Set(w.writes)].slice(0, 12)) say(`     ${x}`);
    await ctx.close();
  }

  // ---- 2. the retired identities are still refused -----------------------------------------
  for (const email of ['nir@gamos.demo', 'payer@gamos.demo', 'meshek@supplier.demo']) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#email', { timeout: 30000 });
    await page.fill('#email', email);
    await page.fill('#password', creds.get(email) || 'not-a-password-anybody-set');
    await page.click('button[type="submit"]');
    await page.waitForTimeout(6000);
    const stillOnLogin = /\/login/.test(new URL(page.url()).pathname);
    say(`RETIRED   ${email.padEnd(24)} ${stillOnLogin ? 'REFUSED (still on /login)' : 'LET IN  <-- PROBLEM'}`);
    await ctx.close();
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT, 'live-smoke.txt'), findings.join('\n'), 'utf8');
})().catch((e) => { console.error('SMOKE FAILED:', e.message); process.exit(1); });
