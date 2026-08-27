import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path) => readFileSync(resolve(path), 'utf8').replace(/\r\n/g, '\n');
const migration = read('supabase/migrations/0213_plan_capability_ladder.sql');
const decisions = read('docs/OPEN-DECISIONS.md');
const panel = read('src/components/OrgSubscriptionPanel.tsx');
const pricing = read('src/pages/Pricing.tsx');
const app = read('src/App.tsx');
const oldMigration = read('supabase/migrations/0184_launch_plan_and_price_catalogue.sql');

const failures = [];
const requireText = (source, needle, label) => {
  if (!source.includes(needle)) failures.push(`${label}: missing ${JSON.stringify(needle)}`);
};
const forbidText = (source, needle, label) => {
  if (source.includes(needle)) failures.push(`${label}: forbidden ${JSON.stringify(needle)}`);
};

for (const [needle, label] of [
  ["('free',       1::numeric,  1::numeric,   5::numeric)", 'Free limits'],
  ["('basic',      5::numeric,  1::numeric,  40::numeric)", 'Basic limits'],
  ["('pro',       15::numeric,  1::numeric, 150::numeric)", 'Pro limits'],
  ["('premium',   30::numeric, 10::numeric, 375::numeric)", 'Premium limits'],
  ['private.assistant_intro_windows', 'single introduction clock'],
  ['documents.automatic_monthly', 'automatic-document counter'],
  ['private.enforce_active_profile_plan_limit', 'user write guard'],
  ['private.enforce_branch_plan_limit', 'branch write guard'],
  ['public.check_plan_request()', 'Data API request gate'],
  ["alter role authenticator set pgrst.db_pre_request", 'PostgREST wiring'],
  ['the capability ladder is not monotonic', 'monotonicity assertion'],
  ['public.get_public_plan_features()', 'public feature read model'],
  ['public.my_plan_features()', 'authenticated feature read model'],
]) requireText(migration, needle, label);

requireText(oldMigration, '#196 forbids it', 'positive control for superseded guard');
forbidText(migration, '#196 forbids it', '0213 must not restore superseded guard');

requireText(decisions, '| 277 |', 'display-vs-billing owner decision');
requireText(decisions, 'עברית מציגה ILS ואנגלית מציגה USD', 'language display rule');
requireText(decisions, 'החיוב בפועל נשאר לפי `#208`', 'verified billing rule');

requireText(panel, "rows<PlanFeatureRowData>('my_plan_features')", 'authenticated feature source');
requireText(panel, "rows<PlanCataloguePriceRow>('get_public_plan_catalogue')", 'two display catalogues');
requireText(panel, 'displayCurrencyForLanguage(document.documentElement.lang)', 'language display selection');
forbidText(panel, 'const PLAN_PRICES', 'no TypeScript price table');

requireText(pricing, "supabase.rpc('get_public_plan_features')", 'public feature source');
forbidText(pricing, 'fmtPlanPrice', 'public page stays price-free');

for (const [path, capability] of [
  ['/pay', 'payments.accountant_queue'],
  ['/documents/consolidated-invoices', 'invoices.consolidated'],
  ['/settings/webhooks', 'integrations.api'],
]) {
  if (!app.includes(`path="${path}"`) || !app.includes(`capability="${capability}"`)) {
    failures.push(`route gate missing: ${path} -> ${capability}`);
  }
}
if (!app.includes('path={APP_ROUTE_POLICY.bank.path}') || !app.includes('capability="bank.reconciliation"')) {
  failures.push('route gate missing: /bank -> bank.reconciliation');
}

if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

console.log('subscription plan contract verification passed');
