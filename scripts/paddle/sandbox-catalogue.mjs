/**
 * Creates (or re-finds) the InPlace catalogue in the PADDLE SANDBOX.
 *
 * SANDBOX ONLY, structurally: BASE is a constant pointing at sandbox-api.paddle.com and the key is
 * read from the owner's out-of-repo credential file. There is no argument, environment variable or
 * flag that can aim this script at Paddle Live.
 *
 * THE NUMBERS ARE NOT INVENTED HERE. They are the rows `0184_launch_plan_and_price_catalogue.sql`
 * seeded into `plan_prices` from owner decision #195, transcribed once, below, and checked against
 * the database by `scripts/paddle/verify-catalogue-matches-db.mjs`. `free` has no product (there is
 * nothing to buy) and `business` has none either — #201 makes its answer a conversation, and a
 * price row would be the figure that decision refuses to publish.
 *
 * ONE PRICE PER PLAN AND INTERVAL, carrying BOTH currencies. Paddle's `unit_price_overrides` is
 * exactly the shape #208 describes: a fixed, separately decided amount per billing country rather
 * than an FX conversion of a base figure. 69 ILS is not 20 USD converted, and this is how the two
 * stay independent while one price id keeps the mapping single-valued.
 *
 * IDEMPOTENT. Products and prices are matched on `custom_data.inplace_plan_key` (+ interval), so a
 * second run creates nothing. custom_data is used for THAT and nothing else: entitlement is decided
 * server-side from `private.billing_provider_price_map`, never from a Paddle name or custom field.
 */
import fs from 'node:fs';

const BASE = 'https://sandbox-api.paddle.com';
const KEY_FILE = 'D:/משה פרוייקטים/פיתוח אתרים/AI/API/Sandbox API Key.txt';
const KEY = fs.readFileSync(KEY_FILE, 'utf8').trim();
if (!KEY.startsWith('pdl_sdbx_')) {
  throw new Error('refusing to run: the key is not a Paddle SANDBOX key');
}

/** #195, pre-tax. USD is the base amount; ILS is the Israel override. Minor units, as Paddle wants. */
const PLANS = [
  { key: 'basic',   name: 'InPlace Basic',   monthly: { usd: 20,  ils: 69   }, yearly: { usd: 200,  ils: 690  } },
  { key: 'pro',     name: 'InPlace Pro',     monthly: { usd: 79,  ils: 249  }, yearly: { usd: 790,  ils: 2490 } },
  { key: 'premium', name: 'InPlace Premium', monthly: { usd: 149, ils: 449  }, yearly: { usd: 1490, ils: 4490 } },
];
const INTERVALS = [
  { key: 'monthly', paddle: 'month' },
  { key: 'yearly',  paddle: 'year'  },
];
const minor = (whole) => String(Math.round(whole * 100));

async function api(method, path, body) {
  const response = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      'Paddle-Version': '1',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 500) }; }
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status} ${JSON.stringify(parsed.error ?? parsed)}`);
  }
  return parsed;
}

const listAll = async (resource) => {
  const rows = [];
  let after = null;
  do {
    const query = `?per_page=100&status=active${after ? `&after=${after}` : ''}`;
    const page = await api('GET', `/${resource}${query}`);
    rows.push(...page.data);
    after = page.meta?.pagination?.has_more ? page.data.at(-1).id : null;
  } while (after);
  return rows;
};

const products = await listAll('products');
const prices = await listAll('prices');
const mapping = [];

for (const plan of PLANS) {
  let product = products.find((row) => row.custom_data?.inplace_plan_key === plan.key);
  if (product) {
    console.log(`product  reuse   ${plan.key.padEnd(8)} ${product.id}`);
  } else {
    product = (await api('POST', '/products', {
      name: plan.name,
      // A procurement-to-payment application. `saas` is what the merchant of record charges tax on.
      tax_category: 'saas',
      custom_data: { inplace_plan_key: plan.key },
    })).data;
    console.log(`product  CREATED ${plan.key.padEnd(8)} ${product.id}`);
  }

  for (const interval of INTERVALS) {
    const amounts = plan[interval.key];
    let price = prices.find((row) => row.product_id === product.id
      && row.custom_data?.inplace_plan_key === plan.key
      && row.custom_data?.inplace_billing_interval === interval.key);
    if (price) {
      console.log(`price    reuse   ${plan.key}/${interval.key.padEnd(8)} ${price.id}`);
    } else {
      price = (await api('POST', '/prices', {
        product_id: product.id,
        description: `${plan.name} — ${interval.key}`,
        // Pre-tax (#195/#208): the merchant of record adds and remits the local tax on top.
        tax_mode: 'external',
        billing_cycle: { interval: interval.paddle, frequency: 1 },
        unit_price: { amount: minor(amounts.usd), currency_code: 'USD' },
        // #208: Israel bills in ILS at its OWN decided figure, not a conversion of the USD one.
        unit_price_overrides: [
          { country_codes: ['IL'], unit_price: { amount: minor(amounts.ils), currency_code: 'ILS' } },
        ],
        custom_data: { inplace_plan_key: plan.key, inplace_billing_interval: interval.key },
      })).data;
      console.log(`price    CREATED ${plan.key}/${interval.key.padEnd(8)} ${price.id}`);
    }
    mapping.push({
      plan_key: plan.key,
      billing_interval: interval.key,
      product_id: product.id,
      price_id: price.id,
      usd: amounts.usd,
      ils: amounts.ils,
    });
  }
}

console.log('\n--- deterministic mapping (plan_key | interval | product | price | USD | ILS) ---');
for (const row of mapping) {
  console.log([row.plan_key, row.billing_interval, row.product_id, row.price_id, row.usd, row.ils].join(' | '));
}
fs.writeFileSync('scripts/paddle/sandbox-catalogue.json', JSON.stringify(mapping, null, 2) + '\n');
console.log('\nwrote scripts/paddle/sandbox-catalogue.json');
