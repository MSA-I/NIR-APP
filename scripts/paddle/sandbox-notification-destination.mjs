/**
 * Registers (or re-finds) the Paddle SANDBOX notification destination that delivers to this
 * deployment's billing-webhook, and prints the endpoint secret ONCE so it can be put into a secret
 * store by hand.
 *
 * WHICH EVENTS, AND WHY NOT ALL OF THEM. The subscription list below is not a preference; it is
 * read out of the database. `private.billing_event_types` is the allowlist 0187 built -- every
 * event this application has actually classified, with the transition it maps to -- and an event
 * outside it dead-letters as `event_type_unrecognized`. Subscribing to Paddle's whole catalogue
 * would therefore manufacture dead letters for events nobody decided to handle, burying the ones
 * that mean something real in a queue somebody has to work.
 *
 * So the rule is: subscribe to exactly what the allowlist names, and let the allowlist be the one
 * place that decides. Adding an event type to Paddle without adding it to 0187's table would
 * produce noise; adding it to the table without re-running this script would produce silence. This
 * script makes the second impossible to do accidentally by re-reading the table every run.
 *
 * SANDBOX ONLY: the API host is a constant and the key must carry the sandbox prefix.
 *
 * Usage:
 *   node scripts/paddle/sandbox-notification-destination.mjs <https-destination-url>
 *   node scripts/paddle/sandbox-notification-destination.mjs --delete <ntfset_id>
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const BASE = 'https://sandbox-api.paddle.com';
const KEY = fs.readFileSync('D:/משה פרוייקטים/פיתוח אתרים/AI/API/Sandbox API Key.txt', 'utf8').trim();
if (!KEY.startsWith('pdl_sdbx_')) throw new Error('refusing to run: not a Paddle SANDBOX key');

const CONTAINER = process.env.PADDLE_PSQL_CONTAINER ?? 'supabase_db_supplyflow-p0';
const HEADERS = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'Paddle-Version': '1' };

async function api(method, path, body) {
  const response = await fetch(BASE + path, {
    method, headers: HEADERS, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 400) }; }
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${JSON.stringify(parsed.error ?? parsed)}`);
  return parsed;
}

if (process.argv[2] === '--delete') {
  const id = process.argv[3];
  if (!/^ntfset_[a-z0-9]+$/.test(id ?? '')) throw new Error('pass a ntfset_… id to delete');
  await api('DELETE', `/notification-settings/${id}`);
  console.log(`deleted ${id}`);
  process.exit(0);
}

const destination = process.argv[2];
if (!destination?.startsWith('https://')) {
  throw new Error('pass the https destination URL of billing-webhook');
}

/** The application's own allowlist, read from the database rather than restated here. */
const rows = execFileSync('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres',
  '-At', '-c', "select event_type from private.billing_event_types where provider = 'paddle' order by event_type"],
  { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
if (rows.length === 0) throw new Error('the billing_event_types allowlist is empty; 0187 has not been applied');

// Paddle rejects an event type it does not publish, so the allowlist is intersected with what the
// account actually offers rather than sent whole. A row we classified that Paddle does not send is
// worth SAYING -- it means 0187 named something that cannot arrive -- so it is reported, not hidden.
const available = new Set((await api('GET', '/event-types')).data.map((row) => row.name));
const subscribed = rows.filter((row) => available.has(row));
const unknown = rows.filter((row) => !available.has(row));

const existing = (await api('GET', '/notification-settings')).data
  .find((row) => row.destination === destination);

let setting;
if (existing) {
  setting = (await api('PATCH', `/notification-settings/${existing.id}`, {
    subscribed_events: subscribed, active: true,
  })).data;
  console.log(`reused  ${setting.id}`);
} else {
  setting = (await api('POST', '/notification-settings', {
    description: 'InPlace billing-webhook (sandbox)',
    destination,
    type: 'url',
    active: true,
    // Paddle's own retry schedule. The handler answers 200 for anything it has DECIDED, including
    // a dead letter, so a retry is reserved for the cases a retry could actually fix.
    api_version: 1,
    subscribed_events: subscribed,
  })).data;
  console.log(`created ${setting.id}`);
}

console.log(`destination      ${setting.destination}`);
console.log(`active           ${setting.active}`);
console.log(`subscribed       ${subscribed.length} event types (from private.billing_event_types)`);
for (const row of subscribed) console.log(`                 ${row}`);
if (unknown.length > 0) {
  console.log(`\nCLASSIFIED BUT NOT PUBLISHED BY PADDLE (${unknown.length}) -- 0187 names an event that cannot arrive:`);
  for (const row of unknown) console.log(`                 ${row}`);
}

// The secret is returned only on creation. It is written to a file OUTSIDE the repository and
// never printed, so it cannot end up in a transcript, a log or a commit.
const secret = setting.endpoint_secret_key;
if (secret) {
  const path = 'D:/משה פרוייקטים/פיתוח אתרים/AI/API/Paddle Sandbox Webhook Secret.txt';
  fs.writeFileSync(path, secret + '\n', 'utf8');
  console.log(`\nendpoint secret written to the out-of-repo credentials folder (not printed).`);
} else {
  console.log('\nno endpoint secret returned (existing destination); reuse the stored one.');
}
