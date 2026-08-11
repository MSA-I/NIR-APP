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

export type ExportKey =
  | 'accountant_monthly_report'
  | 'owner_expense_summary'
  | 'product_purchase_summary';

export interface ExportField {
  key: string;
  label: string;
  /** What the accountant will see in the cell, so the mapping screen can show an example. */
  sample: string;
}

export interface ExportDefinition {
  key: ExportKey;
  title: string;
  /** One sentence: which file this template replaces, in the words of the person choosing. */
  description: string;
  fields: ExportField[];
}

/** Fields every report carries, because every report is about a period and a business. */
const COMMON_FIELDS: ExportField[] = [
  { key: 'org_name', label: 'שם העסק', sample: 'מסעדת לדוגמה בע״מ' },
  { key: 'period_label', label: 'תקופת הדוח', sample: 'מרץ 2026' },
  { key: 'period_from', label: 'מתאריך', sample: '01.03.2026' },
  { key: 'period_to', label: 'עד תאריך', sample: '31.03.2026' },
  { key: 'generated_at', label: 'תאריך הפקה', sample: '01.04.2026' },
];

export const EXPORT_DEFINITIONS: ExportDefinition[] = [
  {
    key: 'accountant_monthly_report',
    title: 'דוח חודשי לרואה חשבון',
    description: 'הקובץ שנשלח לרו״ח בסוף כל חודש.',
    fields: [
      ...COMMON_FIELDS,
      { key: 'invoice_count', label: 'מספר חשבוניות', sample: '42' },
      { key: 'net_total', label: 'סה״כ לפני מע״מ', sample: '128,400.00' },
      { key: 'vat_total', label: 'סה״כ מע״מ', sample: '23,112.00' },
      { key: 'gross_total', label: 'סה״כ כולל מע״מ', sample: '151,512.00' },
      { key: 'credits_recognized', label: 'זיכויים שקוזזו', sample: '1,240.00' },
      { key: 'net_expense', label: 'הוצאה נטו', sample: '150,272.00' },
      { key: 'supplier_count', label: 'מספר ספקים', sample: '15' },
    ],
  },
  {
    key: 'owner_expense_summary',
    title: 'ריכוז הוצאות לבעלים',
    description: 'ריכוז ההוצאות לפי קטגוריה וספק.',
    fields: [
      ...COMMON_FIELDS,
      { key: 'committed_total', label: 'רכש שהוזמן', sample: '160,000.00' },
      { key: 'gross_total', label: 'הוצאה בפועל ברוטו', sample: '151,512.00' },
      { key: 'credits_recognized', label: 'זיכויים שקוזזו', sample: '1,240.00' },
      { key: 'net_expense', label: 'הוצאה נטו', sample: '150,272.00' },
      { key: 'top_supplier_name', label: 'הספק הגדול ביותר', sample: 'משק ירוק' },
      { key: 'top_supplier_total', label: 'סכום הספק הגדול ביותר', sample: '31,900.00' },
    ],
  },
  {
    key: 'product_purchase_summary',
    title: 'סיכום רכישות מוצרים',
    description: 'כמה נרכש מכל מוצר, ובכמה.',
    fields: [
      ...COMMON_FIELDS,
      { key: 'product_count', label: 'מספר מוצרים', sample: '88' },
      { key: 'gross_total', label: 'סה״כ הוצאה', sample: '151,512.00' },
      { key: 'unmapped_invoice_lines', label: 'שורות שלא שויכו למוצר', sample: '3' },
      { key: 'unmapped_invoice_amount', label: 'סכום שלא שויך', sample: '820.00' },
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
