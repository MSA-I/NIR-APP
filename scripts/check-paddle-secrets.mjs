/**
 * A Paddle SERVER key must never be reachable from the browser.
 *
 * Paddle hands out two credentials that look similar enough to confuse in a hurry, and exactly one
 * of them is safe in a bundle:
 *
 *   pdl_sdbx_apikey_… / pdl_apikey_…  -- SERVER. Reads customers, changes subscriptions, issues
 *                                        refunds. Belongs only to an Edge Function secret.
 *   test_… / live_…                   -- CLIENT. Opens a checkout for a transaction the server
 *                                        already created, and can do nothing else. Safe.
 *
 * The failure this guard exists for is not someone pasting a key into a component. It is the quiet
 * one: `VITE_PADDLE_API_KEY` in an env file. Vite substitutes every `VITE_`-prefixed variable into
 * the bundle at build time, so that single line publishes a key that can refund money, and nothing
 * about the build would look different. This is the same class of mistake the repository already
 * guards for the Supabase service key, and it is worth its own script because the Paddle key shape
 * is different and would not be caught by that one.
 *
 * WHAT IS SCANNED: everything under src/, the built bundle when one exists, and every env example.
 * Real .env files are scanned too when present -- a developer's own machine is where the mistake
 * gets made -- but they are never printed, and neither is any matched value.
 *
 * Run: node scripts/check-paddle-secrets.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

/** A Paddle server API key, sandbox or live. The prefix is Paddle's and is not guessed. */
const SERVER_KEY = /pdl_(sdbx_)?apikey_[A-Za-z0-9]/;
/**
 * A VITE_-prefixed name that would carry a Paddle secret into the bundle.
 *
 * TWO PATTERNS, BECAUSE MENTIONING ONE IS NOT DOING ONE. The first draft matched the bare name
 * anywhere and immediately failed on `.env.example` — on the comment WARNING people not to create
 * the variable. An assertion its own explanation can break is measuring the wrong thing, and the
 * fix is to match what actually causes the harm:
 *
 *   * in an env file, only an ASSIGNMENT (`VITE_PADDLE_API_KEY=…`) publishes anything
 *   * in browser source, a READ (`import.meta.env.VITE_PADDLE_API_KEY`) is equally damning,
 *     because Vite substitutes it whether or not an env file in this repo sets it
 */
const VITE_SECRET_ASSIGNED = /^[\t ]*(export[\t ]+)?VITE_[A-Z0-9_]*PADDLE[A-Z0-9_]*(API_KEY|SECRET|WEBHOOK)[\t ]*=/m;
const VITE_SECRET_READ = /import\.meta\.env\.VITE_[A-Z0-9_]*PADDLE[A-Z0-9_]*(API_KEY|SECRET|WEBHOOK)/;
/** The notification-destination endpoint secret. Server-only, same reasoning. */
const ENDPOINT_SECRET = /pdl_ntfset_[A-Za-z0-9]/;

const failures = [];

function walk(directory, onFile) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, onFile);
    else onFile(full);
  }
}

function scan(file, label) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  const relative = path.relative(ROOT, file).replace(/\\/g, '/');

  // The guard's own source names these patterns to explain them, and so does the module that
  // documents which credential is which. Matching our own explanation is the trap this repository
  // has hit before; the fix is to exempt the files whose JOB is to describe the rule.
  const describesTheRule = relative === 'scripts/check-paddle-secrets.mjs'
    || relative === 'src/lib/paddle.ts';

  for (const [pattern, what] of [
    [SERVER_KEY, 'a Paddle SERVER API key'],
    [ENDPOINT_SECRET, 'a Paddle webhook endpoint secret'],
  ]) {
    if (!describesTheRule && pattern.test(text)) {
      failures.push(`${relative}: ${what} appears in ${label}`);
    }
  }
  if (VITE_SECRET_ASSIGNED.test(text)) {
    failures.push(`${relative}: ASSIGNS a VITE_-prefixed Paddle secret, which Vite would inline into the bundle`);
  }
  if (VITE_SECRET_READ.test(text)) {
    failures.push(`${relative}: READS a VITE_-prefixed Paddle secret from import.meta.env`);
  }
}

for (const directory of ['src', 'dist']) {
  const full = path.join(ROOT, directory);
  if (fs.existsSync(full)) walk(full, (file) => scan(file, directory === 'dist' ? 'the built bundle' : 'browser source'));
}
for (const entry of fs.readdirSync(ROOT)) {
  if (/^\.env($|\.)/.test(entry)) scan(path.join(ROOT, entry), 'an environment file');
}

if (failures.length > 0) {
  console.error('Paddle credential guard FAILED:');
  for (const failure of failures) console.error(`  ${failure}`);
  console.error('\nThe server key belongs in an Edge Function secret (PADDLE_API_KEY), never in a');
  console.error('VITE_ variable and never under src/. The browser gets VITE_PADDLE_CLIENT_TOKEN only.');
  process.exit(1);
}
console.log('Paddle credential guard: no server key or endpoint secret is reachable from the browser.');
