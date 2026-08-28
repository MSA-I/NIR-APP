/**
 * The three reports a tenant may hand us a workbook for, and the fields each one can fill.
 *
 * This is the right-hand side of the mapping screen. A placeholder found in the accountant's
 * workbook — `{{net_total}}`, or `{{סהכ_חודשי}}` if that is what they wrote — is matched against one
 * of these by a person, and the pairing is stored in `workbook_placeholders` (0123) and frozen by
 * the approval.
 *
 * WHY THE CATALOGUE LIVES HERE AND NOT IN THE DATABASE. These are the values the report code
 * actually produces: `monthlyReport.ts` computes the accountant's figures, `Expenses.tsx` the
 * owner's, and `get_product_purchase_summary` the product one. A second copy in a migration would
 * be a list that drifts from the code that fills it — and the drift would be invisible, because a
 * key nobody produces simply renders as an unfilled placeholder rather than as an error.
 *
 * A key added to a report belongs here in the same commit. `exportTemplates.spec.ts` pins the shape;
 * what it cannot pin is that the report still produces the value, which is why the export leaves an
 * unmapped or unproduced placeholder VISIBLE in the output instead of blanking it
 * (`fillTemplateWorkbook`).
 */

import type { TKey } from './i18n/t';

export type ExportKey =
  | 'accountant_monthly_report'
  | 'owner_expense_summary'
  | 'product_purchase_summary';

export interface ExportField {
  key: string;
  labelKey: TKey;
  /** What the accountant will see in the cell, so the mapping screen can show an example. It is
   *  a key too: a sample date reads differently in each language, and a sample business name in a
   *  script the reader cannot read illustrates nothing. */
  sampleKey: TKey;
}

export interface ExportDefinition {
  key: ExportKey;
  /**
   * The CANONICAL Hebrew name, and the one place on this surface that stays Hebrew: it is the
   * default `p_name` of the stored template and it composes the `p_reason` written to
   * `audit_logs`. What a person READS is `titleKey`.
   */
  title: string;
  titleKey: TKey;
  /** One sentence: which file this template replaces, in the words of the person choosing. */
  descriptionKey: TKey;
  fields: ExportField[];
}

/** Fields every report carries, because every report is about a period and a business. */
const COMMON_FIELDS: ExportField[] = [
  { key: 'org_name', labelKey: 'exportTemplates.fieldOrgName', sampleKey: 'exportTemplates.sampleOrgName' },
  { key: 'period_label', labelKey: 'exportTemplates.fieldPeriodLabel', sampleKey: 'exportTemplates.samplePeriodLabel' },
  { key: 'period_from', labelKey: 'exportTemplates.fieldPeriodFrom', sampleKey: 'exportTemplates.samplePeriodFrom' },
  { key: 'period_to', labelKey: 'exportTemplates.fieldPeriodTo', sampleKey: 'exportTemplates.samplePeriodTo' },
  { key: 'generated_at', labelKey: 'exportTemplates.fieldGeneratedAt', sampleKey: 'exportTemplates.sampleGeneratedAt' },
];

export const EXPORT_DEFINITIONS: ExportDefinition[] = [
  {
    key: 'accountant_monthly_report',
    title: 'דוח חודשי לרואה חשבון',
    titleKey: 'exportTemplates.accountantMonthlyTitle',
    descriptionKey: 'exportTemplates.accountantMonthlyDescription',
    fields: [
      ...COMMON_FIELDS,
      { key: 'invoice_count', labelKey: 'exportTemplates.fieldInvoiceCount', sampleKey: 'exportTemplates.sampleInvoiceCount' },
      { key: 'net_total', labelKey: 'exportTemplates.fieldNetTotal', sampleKey: 'exportTemplates.sampleNetTotal' },
      { key: 'vat_total', labelKey: 'exportTemplates.fieldVatTotal', sampleKey: 'exportTemplates.sampleVatTotal' },
      { key: 'gross_total', labelKey: 'exportTemplates.fieldGrossTotal', sampleKey: 'exportTemplates.sampleGrossTotal' },
      { key: 'credits_recognized', labelKey: 'exportTemplates.fieldCreditsRecognized', sampleKey: 'exportTemplates.sampleCreditsRecognized' },
      { key: 'net_expense', labelKey: 'exportTemplates.fieldNetExpense', sampleKey: 'exportTemplates.sampleNetExpense' },
      { key: 'supplier_count', labelKey: 'exportTemplates.fieldSupplierCount', sampleKey: 'exportTemplates.sampleSupplierCount' },
    ],
  },
  {
    key: 'owner_expense_summary',
    title: 'ריכוז הוצאות לבעלים',
    titleKey: 'exportTemplates.ownerExpenseTitle',
    descriptionKey: 'exportTemplates.ownerExpenseDescription',
    fields: [
      ...COMMON_FIELDS,
      { key: 'committed_total', labelKey: 'exportTemplates.fieldCommittedTotal', sampleKey: 'exportTemplates.sampleCommittedTotal' },
      { key: 'gross_total', labelKey: 'exportTemplates.fieldGrossExpense', sampleKey: 'exportTemplates.sampleGrossTotal' },
      { key: 'credits_recognized', labelKey: 'exportTemplates.fieldCreditsRecognized', sampleKey: 'exportTemplates.sampleCreditsRecognized' },
      { key: 'net_expense', labelKey: 'exportTemplates.fieldNetExpense', sampleKey: 'exportTemplates.sampleNetExpense' },
      { key: 'top_supplier_name', labelKey: 'exportTemplates.fieldTopSupplierName', sampleKey: 'exportTemplates.sampleTopSupplierName' },
      { key: 'top_supplier_total', labelKey: 'exportTemplates.fieldTopSupplierTotal', sampleKey: 'exportTemplates.sampleTopSupplierTotal' },
    ],
  },
  {
    key: 'product_purchase_summary',
    title: 'סיכום רכישות מוצרים',
    titleKey: 'exportTemplates.productPurchaseTitle',
    descriptionKey: 'exportTemplates.productPurchaseDescription',
    fields: [
      ...COMMON_FIELDS,
      { key: 'product_count', labelKey: 'exportTemplates.fieldProductCount', sampleKey: 'exportTemplates.sampleProductCount' },
      { key: 'gross_total', labelKey: 'exportTemplates.fieldTotalExpense', sampleKey: 'exportTemplates.sampleGrossTotal' },
      { key: 'unmapped_invoice_lines', labelKey: 'exportTemplates.fieldUnmappedLines', sampleKey: 'exportTemplates.sampleUnmappedLines' },
      { key: 'unmapped_invoice_amount', labelKey: 'exportTemplates.fieldUnmappedAmount', sampleKey: 'exportTemplates.sampleUnmappedAmount' },
    ],
  },
];

export function exportDefinition(key: string): ExportDefinition | undefined {
  return EXPORT_DEFINITIONS.find((definition) => definition.key === key);
}

/**
 * The mapping a person approves: one row per placeholder found in the workbook.
 *
 * `source` is null until they choose, and an unchosen placeholder is a legitimate state to save —
 * the workbook may contain `{{שלום}}` in a header that was never meant to be filled. What it must
 * not do is silently become a blank cell, which is why the fill leaves it as written.
 */
export interface PlaceholderMapping {
  key: string;
  sheet: string;
  cell: string;
  source: string | null;
}

/**
 * Match each placeholder to a field automatically, where the match is beyond doubt.
 *
 * Exact key equality only. A workbook that writes `{{net_total}}` means the field called
 * `net_total`, and nothing else in the catalogue is called that. Anything fuzzier — case folding,
 * stripping underscores, similarity — would silently put the VAT total in the net cell on a file an
 * accountant files with the tax authority, and the person approving would have no reason to look
 * twice at a row that says "matched".
 */
export function suggestMapping(
  placeholders: { key: string; sheet: string; cell: string }[],
  definition: ExportDefinition,
): PlaceholderMapping[] {
  const known = new Set(definition.fields.map((field) => field.key));
  return placeholders.map((placeholder) => ({
    ...placeholder,
    source: known.has(placeholder.key) ? placeholder.key : null,
  }));
}

/** How many placeholders still need a person. Drives the sentence above the approve button. */
export function unmappedCount(mapping: PlaceholderMapping[]): number {
  return mapping.filter((row) => !row.source).length;
}
