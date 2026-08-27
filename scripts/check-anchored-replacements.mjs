/**
 * check:anchored-replacements — a migration that patches a live function body must not care which
 * operating system applied the migration before it.
 *
 * A function body is stored as the bytes it was created from. Applied from Windows, `prosrc` gets
 * CRLF; applied on a Linux CI runner, it gets LF. A migration that then reads that body with
 * `pg_get_functiondef` and searches it for a multi-line anchor built with `e'\n'` matches in CI
 * and fails in production — which is precisely how the `0171`-`0205` rollout aborted at `0181`,
 * with 58.8% of production bodies carrying CRLF and CI never seeing one.
 *
 * `0209` normalised what already existed and `db-query.ps1` normalises on apply, so no NEW body
 * should carry CR. This guard is the third leg: it fails a migration that would depend on that
 * being true rather than making itself independent of it.
 *
 * THE RULE: if a migration assigns `pg_get_functiondef(...)` into a variable it later searches,
 * that assignment must strip carriage returns — `replace(pg_get_functiondef(…), e'\r', '')`.
 *
 * Reading the definition to re-execute it, or to test for a single-line token, is not the failure
 * mode: a token with no newline in it is CR-insensitive. The check therefore looks for the
 * assignment form, which is what every anchored replacement in this repository uses.
 *
 * Migrations already applied to production are immutable and cannot be fixed, so the ones that
 * predate this rule are pinned below by name. The list may shrink and must never grow.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDir = fileURLToPath(new URL('../supabase/migrations', import.meta.url));

/**
 * Migrations that read a live body without stripping CR and were written before this guard.
 * Every one is already in `main`; committed migrations are immutable. `0209` makes them safe by
 * removing the CR they would have tripped over, and this list exists so a NEW one cannot join
 * them silently.
 */
const PINNED_LEGACY = new Set([
  '0031_role_capability_contract.sql',
  '0061_step_up_paths.sql',
  '0066_integration_adapters.sql',
  '0071_scope_last_grant_guard.sql',
  '0079_document_filing_reason_code.sql',
  '0084_automatic_document_classification.sql',
  '0087_receipt_credit_automation_and_manual_exceptions.sql',
  '0096_document_automation_calibration_shadow_operations.sql',
  '0107_document_order_resolution.sql',
  '0108_document_reconciliation_assessment.sql',
  '0109_document_review_assessment_read.sql',
  '0110_apply_reviewed_document.sql',
  '0115_preferred_supplier_tiebreak.sql',
  '0117_search_follows_removed_destinations.sql',
  '0120_document_order_date_proximity.sql',
  '0121_document_removal_open_to_every_role.sql',
  '0123_export_template_workbooks.sql',
  '0126_propose_export_report_template.sql',
  '0133_remove_retired_persona_surfaces.sql',
  '0145_global_search_purchase_request_drafts.sql',
  '0168_supplier_order_email_delivery.sql',
  '0171_financial_bank_contracts.sql',
  '0172_approved_credit_note_intake.sql',
  '0173_partial_credit_allocations.sql',
  '0175_legal_entity_audit_scope.sql',
  '0177_product_name_source_repair.sql',
  '0180_full_frame_fallback_source.sql',
  '0181_price_list_calibration_activation.sql',
  '0182_qualified_product_creation_guards.sql',
  '0185_signup_anchored_usage_period.sql',
  '0186_referral_grants_and_customer_read_models.sql',
  '0195_suspension_reason_split.sql',
  '0198_owner_webhook_verification.sql',
  '0202_assistant_quota_and_intro_window.sql',
  '0205_google_identity_is_owner_only.sql',
]);

/**
 * Every read of a live body, however it is assigned.
 *
 * Both forms occur in this repository and BOTH broke production:
 *   v_def := replace(pg_get_functiondef(sig), e'
', '');
 *   select pg_get_functiondef(sig) into v_def;        <-- 0181, the one that actually aborted
 *
 * Matching the assignment shape misses the postfix `into`, so the check is proximity instead:
 * a call is normalised when `replace(` opens within the 60 characters before it. That is the
 * only way the strip is ever written here, and it cannot be spelled at a distance.
 */
const CALL = /pg_get_functiondef\s*\(/gi;
const NORMALISED_WINDOW = 60;

/** A definition read only to be re-executed needs no strip: nothing searches it. */
const EXECUTED = /\bexecute\s+(?:replace\s*\(\s*)?$/i;

const offenders = [];
const stale = [];
let scanned = 0;
let readers = 0;

const names = readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort();
for (const name of names) {
  const sql = readFileSync(join(migrationsDir, name), 'utf8');
  scanned += 1;
  if (!/pg_get_functiondef/i.test(sql)) continue;
  readers += 1;

  // The strip routinely sits on the line above the call, so the test is whether the matched
  // span CONTAINS `replace(` — not whether it ends with it.
  const bare = [...sql.matchAll(CALL)].filter((m) => {
    const before = sql.slice(Math.max(0, m.index - NORMALISED_WINDOW), m.index);
    return !/replace\s*\(/i.test(before) && !EXECUTED.test(before);
  });
  if (bare.length === 0) continue;
  if (PINNED_LEGACY.has(name)) continue;
  offenders.push(`${name}: ${bare.length} assignment(s) of pg_get_functiondef without a CR strip`);
}

for (const pinned of PINNED_LEGACY) {
  if (!names.includes(pinned)) stale.push(pinned);
}

// A guard that quietly stopped looking is worse than one that fails.
if (readers === 0) {
  console.error(
    'check:anchored-replacements FAILED — no migration reads pg_get_functiondef at all.\n'
    + '  Either the idiom was renamed or this script is pointed at the wrong directory. Both mean\n'
    + '  it is no longer checking anything.',
  );
  process.exit(1);
}

if (offenders.length || stale.length) {
  console.error(
    'check:anchored-replacements FAILED\n\n'
    + (offenders.length
      ? '  Reads a live function body without normalising line endings:\n'
        + offenders.map((line) => `    ${line}`).join('\n')
        + '\n\n  Use `replace(pg_get_functiondef(<sig>), e\'\\r\', \'\')`. A body applied from Windows\n'
        + '  stores CRLF and one applied on CI stores LF; an anchor built with e\'\\n\' matches only\n'
        + '  one of them, and the gate only ever sees CI. That is how the 0171-0205 rollout aborted\n'
        + '  at 0181 with production 58.8% CRLF.\n\n'
      : '')
    + (stale.length
      ? '  Pinned legacy files that no longer exist (the pin must shrink honestly):\n'
        + stale.map((line) => `    ${line}`).join('\n') + '\n'
      : ''),
  );
  process.exit(1);
}

console.log(
  `check:anchored-replacements passed: ${scanned} migration(s) scanned, ${readers} read a live `
  + `function body, ${PINNED_LEGACY.size} pinned pre-rule file(s), 0 new unnormalised reader(s).`,
);
