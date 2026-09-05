import { useMemo } from 'react';
import { useT } from './i18n/LocaleProvider';

/**
 * The commercial catalogue's names, in the reader's language.
 *
 * WHY THIS FILE EXISTS. Plan names and entitlement labels are written in the DATABASE, in Hebrew:
 * `subscription_plans.label` (0184), `private.entitlement_definitions.label` (0154/0164/0246/0247)
 * and `private.plan_feature_presentation.public_label` (0246). The server hands them to the client
 * already spelled, so an English screen read `The פרימיום plan was given to this organisation…`,
 * `Move to חינם`, and a plan badge in the phone header saying `פרימיום`. `OPEN-DECISIONS #303`
 * held this open with three ways out; the owner chose on 31.08.2026 — **an English interface names
 * the plans in English.**
 *
 * WHY NOT A `label_en` COLUMN. Every one of these rows already has a stable machine key —
 * `plan_key`, `entitlement_key` — and the product already resolves a machine key to a dictionary
 * key in exactly this shape for statuses, roles, credit reasons and exception types
 * (`src/lib/status.ts`). A second label column would add a language to the SCHEMA, would need a
 * migration for every new rung, and would leave the two languages free to drift apart row by row.
 * The dictionary is where every other translated string in this product lives.
 *
 * THE FALLBACK IS THE SERVER'S OWN LABEL, AND IT IS NOT DECORATION. `#303` counted it as the cost
 * of this route: "a new plan needs code, not just a row". That cost is paid here rather than
 * denied — a key with no dictionary entry renders **the label the server sent**, so a plan or an
 * entitlement seeded by a future migration appears on screen, in Hebrew, instead of vanishing or
 * rendering its own key at a customer. It degrades to today's behaviour rather than to a blank.
 *
 * THE HEBREW SIDE MUST STAY IDENTICAL TO THE DATABASE, and `npm run check:plan-labels` is what
 * makes that true rather than hoped: it parses the seeding migrations and fails if any Hebrew
 * entry here has drifted from the row it mirrors. Without it this file would be a second, silent
 * copy of the catalogue's wording — which is the failure mode `PlanBadge` already documents for
 * `TIER_CLASS` ("this table used to exist twice, and the two copies had already drifted").
 */

/**
 * `subscription_plans.label` — the six rungs of the ladder (0154 seeded four, 0184 renamed them
 * and added `basic`/`premium`).
 */
const PLAN_LABEL: Record<string, string> = {
  legacy: 'plan_legacy',
  free: 'plan_free',
  basic: 'plan_basic',
  pro: 'plan_pro',
  premium: 'plan_premium',
  business: 'plan_business',
};

/**
 * `private.entitlement_definitions.label` — what a quota or capability is CALLED, as the
 * subscription screen lists it beside its number.
 */
const ENTITLEMENT_LABEL: Record<string, string> = {
  'users.max': 'entitlement_users_max',
  'suppliers.max': 'entitlement_suppliers_max',
  'documents.monthly': 'entitlement_documents_monthly',
  'ocr_pages.monthly': 'entitlement_ocr_pages_monthly',
  'storage.bytes': 'entitlement_storage_bytes',
  'reports.advanced': 'entitlement_reports_advanced',
  'bank.reconciliation': 'entitlement_bank_reconciliation',
  'documents.automation': 'entitlement_documents_automation',
  'exports.custom': 'entitlement_exports_custom',
  'org.multi_unit': 'entitlement_org_multi_unit',
  'support.premium': 'entitlement_support_premium',
  'assistant_runs.monthly': 'entitlement_assistant_runs_monthly',
  'branches.max': 'entitlement_branches_max',
  'documents.automatic_monthly': 'entitlement_documents_automatic_monthly',
  'history.full': 'entitlement_history_full',
  'notifications.email': 'entitlement_notifications_email',
  'payments.accountant_queue': 'entitlement_payments_accountant_queue',
  'invoices.consolidated': 'entitlement_invoices_consolidated',
  'integrations.api': 'entitlement_integrations_api',
  'exports.unbranded_pdf': 'entitlement_exports_unbranded_pdf',
};

/**
 * `private.plan_feature_presentation.public_label` — the SAME entitlement key said differently,
 * because a plan card sells a capability and a quota row names a limit. `documents.automation` is
 * «אוטומציית מסמכים» in the definition and «קריאה אוטומטית של מסמכים» on the card;
 * `org.multi_unit` is «ריבוי יחידות» and «עד 10 סניפים». Two maps, because the database keeps two
 * columns on purpose — collapsing them here would publish the wrong one of the pair.
 */
const PLAN_FEATURE_LABEL: Record<string, string> = {
  'documents.automation': 'planFeature_documents_automation',
  'history.full': 'planFeature_history_full',
  'exports.custom': 'planFeature_exports_custom',
  'reports.advanced': 'planFeature_reports_advanced',
  'notifications.email': 'planFeature_notifications_email',
  'bank.reconciliation': 'planFeature_bank_reconciliation',
  'payments.accountant_queue': 'planFeature_payments_accountant_queue',
  'invoices.consolidated': 'planFeature_invoices_consolidated',
  'org.multi_unit': 'planFeature_org_multi_unit',
  'integrations.api': 'planFeature_integrations_api',
  'support.premium': 'planFeature_support_premium',
};

/**
 * One lookup for all three, because they differ only in which map they read.
 *
 * `statusLabel` returns `''` for a key the dictionary does not hold, so one `||` covers both ways
 * this can miss: a machine key with no entry in the map above, and a mapped key whose dictionary
 * entry was never written. Both fall through to `serverLabel` — the row's own wording — and never
 * to a blank or to a raw key.
 */
function catalogueLabel(
  statusLabel: (key: string, vars?: Record<string, string | number>) => string,
  map: Record<string, string>,
  machineKey: string | null | undefined,
  serverLabel: string | null | undefined,
  /**
   * The number this label will be printed BESIDE, when there is one. It reaches `t()` as `count`,
   * which is the only thing that can select a `_one` sibling — Hebrew has one/two/many/other and
   * a quota of one read «1 משתמשים פעילים» on the public pricing page (`ENTRY-08`).
   *
   * The server label is still the fallback, and it is still plural: it is one column, written for
   * the general case, and a language rule is not something a `label` column can carry.
   */
  count?: number,
): string {
  const dictionaryKey = machineKey ? map[machineKey] : undefined;
  const vars = typeof count === 'number' ? { count } : undefined;
  return (dictionaryKey ? statusLabel(dictionaryKey, vars) : '') || serverLabel || '';
}

/**
 * The three resolvers a screen needs, bound to the reader's language.
 *
 * Each takes the row's MACHINE KEY and the row's OWN label, in that order, so a call site reads
 * `planName(option.plan_key, option.label)` and the fallback is visible at the point of use rather
 * than hidden behind a lookup that can silently return nothing.
 */
export function usePlanCatalogue() {
  const { statusLabel } = useT();
  return useMemo(() => ({
    /** A rung of the ladder: «Premium» / «פרימיום». */
    planName: (planKey: string | null | undefined, serverLabel: string | null | undefined) =>
      catalogueLabel(statusLabel, PLAN_LABEL, planKey, serverLabel),
    /**
     * What a quota is called where its number is printed: «Documents per month».
     *
     * `count` is the figure it will stand next to, and it is optional because a quota row that
     * prints no number — an unmeasured one, an unlimited one — has nothing to agree with.
     */
    quotaName: (
      entitlementKey: string | null | undefined,
      serverLabel: string | null | undefined,
      count?: number,
    ) => catalogueLabel(statusLabel, ENTITLEMENT_LABEL, entitlementKey, serverLabel, count),
    /** The same entitlement as a plan card sells it: «Documents read automatically». */
    featureName: (entitlementKey: string | null | undefined, serverLabel: string | null | undefined) =>
      catalogueLabel(statusLabel, PLAN_FEATURE_LABEL, entitlementKey, serverLabel),
  }), [statusLabel]);
}
