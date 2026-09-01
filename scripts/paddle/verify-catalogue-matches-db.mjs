/**
 * Proves that what Paddle Sandbox charges is what `plan_prices` says (#195), by reading BOTH sides
 * rather than trusting the transcription in either.
 *
 * Left side:  Paddle's own answer for every active price, fetched live from sandbox-api.paddle.com.
 * Right side: this repository's decided figures, read out of the database that 0184 seeded.
 *
 * A price that exists at Paddle and not in the catalogue, an amount that differs, an interval that
 * differs, a plan that Paddle sells and the map does not know, or a mapped price Paddle has never
 * heard of -- each is a separate failure with its own line. Exit code 1 if any of them fired.
 *
 * SANDBOX ONLY. The base URL is a constant and the key must carry the sandbox prefix.
 *
 * Usage:  node scripts/paddle/verify-catalogue-matches-db.mjs
 *         (reads the local stack by default; pass --psql-container to name another)
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const BASE = 'https://sandbox-api.paddle.com';
const KEY = fs.readFileSync('D:/משה פרוייקטים/פיתוח אתרים/AI/API/Sandbox API Key.txt', 'utf8').trim();
if (!KEY.startsWith('pdl_sdbx_')) throw new Error('refusing to run: not a Paddle SANDBOX key');

const CONTAINER = process.argv.includes('--psql-container')
  ? process.argv[process.argv.indexOf('--psql-container') + 1]
  : 'supabase_db_supplyflow-p0';

/** The decided figures and the mapping, straight out of the database. */
const QUERY = `
  select map.provider_price_id, map.plan_key, map.billing_interval,
         row_price.amount as row_amount, il_price.amount as il_amount
  from private.billing_provider_price_map map
  join plan_prices row_price
    on row_price.catalogue_version = 'launch-row'
   and row_price.plan_key = map.plan_key
   and row_price.billing_interval = map.billing_interval
  join plan_prices il_price
    on il_price.catalogue_version = 'launch-il'
   and il_price.plan_key = map.plan_key
   and il_price.billing_interval = map.billing_interval
  where map.provider = 'paddle' and map.environment = 'sandbox'
  order by map.plan_key, map.billing_interval;
`;

const raw = execFileSync('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres',
  '-At', '-F', '\t', '-c', QUERY], { encoding: 'utf8' });

const expected = new Map();
for (const line of raw.trim().split(/\r?\n/).filter(Boolean)) {
  const [priceId, planKey, interval, rowAmount, ilAmount] = line.split('\t');
  expected.set(priceId, { planKey, interval, usd: Number(rowAmount), ils: Number(ilAmount) });
}

const response = await fetch(`${BASE}/prices?per_page=100&status=active`, {
  headers: { Authorization: `Bearer ${KEY}`, 'Paddle-Version': '1' },
});
const live = (await response.json()).data;

const PADDLE_INTERVAL = { month: 'monthly', year: 'yearly' };
const failures = [];
const seen = new Set();

for (const price of live) {
  const row = expected.get(price.id);
  if (!row) {
    failures.push(`Paddle sells ${price.id} (${price.description}) and the price map does not know it`);
    continue;
  }
  seen.add(price.id);

  const paddleInterval = PADDLE_INTERVAL[price.billing_cycle?.interval];
  if (paddleInterval !== row.interval) {
    failures.push(`${price.id}: Paddle bills ${price.billing_cycle?.interval}, the map records ${row.interval}`);
  }
  if (price.billing_cycle?.frequency !== 1) {
    failures.push(`${price.id}: frequency ${price.billing_cycle?.frequency}; the plan model sells one cycle at a time`);
  }
  // #195/#208: pre-tax. The merchant of record adds the local tax on top.
  if (price.tax_mode !== 'external') {
    failures.push(`${price.id}: tax_mode ${price.tax_mode}; #195 figures are pre-tax`);
  }

  const usdMinor = Number(price.unit_price?.amount);
  if (price.unit_price?.currency_code !== 'USD' || usdMinor !== Math.round(row.usd * 100)) {
    failures.push(`${price.id}: Paddle base ${usdMinor} ${price.unit_price?.currency_code}, `
      + `launch-row says ${Math.round(row.usd * 100)} USD`);
  }

  const ilOverride = (price.unit_price_overrides ?? []).find((o) => o.country_codes.includes('IL'));
  if (!ilOverride) {
    failures.push(`${price.id}: no Israel override; #208 bills Israel in ILS at its own figure`);
  } else {
    const ilsMinor = Number(ilOverride.unit_price.amount);
    if (ilOverride.unit_price.currency_code !== 'ILS' || ilsMinor !== Math.round(row.ils * 100)) {
      failures.push(`${price.id}: Paddle IL ${ilsMinor} ${ilOverride.unit_price.currency_code}, `
        + `launch-il says ${Math.round(row.ils * 100)} ILS`);
    }
  }
}

for (const [priceId, row] of expected) {
  if (!seen.has(priceId)) {
    failures.push(`the map points ${row.planKey}/${row.interval} at ${priceId}, which Paddle does not sell`);
  }
}

console.log(`compared ${live.length} live Paddle prices against ${expected.size} mapped rows`);
for (const [priceId, row] of expected) {
  if (seen.has(priceId)) {
    console.log(`  OK  ${row.planKey.padEnd(8)} ${row.interval.padEnd(8)} ${priceId}  ${row.usd} USD / ${row.ils} ILS`);
  }
}
if (failures.length > 0) {
  console.error(`\n${failures.length} mismatch(es):`);
  for (const failure of failures) console.error(`  FAIL  ${failure}`);
  process.exit(1);
}
console.log('\nPaddle Sandbox matches the decided catalogue exactly.');
