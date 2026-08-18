import { supabase } from './supabase';
import { unwrap } from './useQuery';
import { exportDefinition, type ExportKey, type PlaceholderMapping } from './exportTemplates';
import { fillTemplateWorkbook } from './exportTemplateWorkbook';

export type ReportTemplateValues = Record<string, string | number | null>;

interface ReportPeriodInput {
  orgName: string | null | undefined;
  periodLabel: string;
  periodFrom: string;
  periodTo: string;
  generatedAt: string;
}

function commonValues(input: ReportPeriodInput): ReportTemplateValues {
  return {
    org_name: input.orgName?.trim() || '—',
    period_label: input.periodLabel,
    period_from: input.periodFrom,
    period_to: input.periodTo,
    generated_at: input.generatedAt,
  };
}

export function monthlyReportTemplateValues(input: ReportPeriodInput & {
  invoices: {
    amount_before_vat: number;
    vat_amount: number;
    total_amount: number;
    supplier: { name: string };
  }[];
  credits: { amount: number; status: string }[];
}): ReportTemplateValues {
  const netTotal = input.invoices.reduce((sum, row) => sum + row.amount_before_vat, 0);
  const vatTotal = input.invoices.reduce((sum, row) => sum + row.vat_amount, 0);
  const grossTotal = input.invoices.reduce((sum, row) => sum + row.total_amount, 0);
  const creditsRecognized = input.credits
    .filter((row) => row.status === 'offset' || row.status === 'closed')
    .reduce((sum, row) => sum + row.amount, 0);

  return {
    ...commonValues(input),
    invoice_count: input.invoices.length,
    net_total: netTotal,
    vat_total: vatTotal,
    gross_total: grossTotal,
    credits_recognized: creditsRecognized,
    net_expense: grossTotal - creditsRecognized,
    supplier_count: new Set(input.invoices.map((row) => row.supplier.name).filter(Boolean)).size,
  };
}

export interface PurchaseMetrics {
  committed: number | null;
  gross_expense: number | null;
  credits_recognised: number | null;
  net_expense: number | null;
}

export function expenseSummaryTemplateValues(input: ReportPeriodInput & {
  metrics: PurchaseMetrics;
  bySupplier: { name: string; total: number }[];
}): ReportTemplateValues {
  const topSupplier = [...input.bySupplier].sort((a, b) => b.total - a.total)[0] ?? null;
  return {
    ...commonValues(input),
    committed_total: input.metrics.committed,
    gross_total: input.metrics.gross_expense,
    credits_recognized: input.metrics.credits_recognised,
    net_expense: input.metrics.net_expense,
    top_supplier_name: topSupplier?.name ?? null,
    top_supplier_total: topSupplier?.total ?? null,
  };
}

export function productPurchaseTemplateValues(input: ReportPeriodInput & {
  products: { gross_amount: number | null }[];
  unmappedInvoiceLines: number;
  unmappedInvoiceAmount: number | null;
}): ReportTemplateValues {
  const mappedGross = input.products.reduce((sum, row) => sum + (row.gross_amount ?? 0), 0);
  return {
    ...commonValues(input),
    product_count: input.products.length,
    // Unmapped invoice money remains visible as unmapped, but it is still part of the period's
    // gross expense. Omitting it from the total would make the template look reconciled when it is
    // exactly the work item the report calls out.
    gross_total: mappedGross + (input.unmappedInvoiceAmount ?? 0),
    unmapped_invoice_lines: input.unmappedInvoiceLines,
    unmapped_invoice_amount: input.unmappedInvoiceAmount,
  };
}

interface LiveReportTemplate {
  found: boolean;
  export_key: string;
  version_id?: string;
  workbook_path?: string;
  workbook_name?: string;
  workbook_bytes?: number;
  workbook_checksum?: string;
  placeholders?: unknown;
}

export class ReportTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportTemplateError';
  }
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function approvedMapping(value: unknown, key: ExportKey, values: ReportTemplateValues): PlaceholderMapping[] {
  if (!Array.isArray(value)) {
    throw new ReportTemplateError('מיפוי תבנית הייצוא פגום. יש להעלות ולאשר את התבנית מחדש.');
  }
  const definition = exportDefinition(key);
  if (!definition) throw new ReportTemplateError('סוג דוח התבנית אינו מוכר.');
  const allowed = new Set(definition.fields.map((field) => field.key));
  const cells = new Set<string>();

  return value.map((raw) => {
    if (!raw || typeof raw !== 'object') {
      throw new ReportTemplateError('מיפוי תבנית הייצוא פגום. יש להעלות ולאשר את התבנית מחדש.');
    }
    const row = raw as Record<string, unknown>;
    const source = row.source == null ? null : String(row.source);
    const mapping: PlaceholderMapping = {
      key: String(row.key ?? ''),
      sheet: String(row.sheet ?? ''),
      cell: String(row.cell ?? ''),
      source,
    };
    if (!mapping.key || !mapping.sheet || !/^[A-Z]+[1-9][0-9]*$/.test(mapping.cell)) {
      throw new ReportTemplateError('מיקום תא בתבנית אינו תקין. יש להעלות ולאשר את התבנית מחדש.');
    }
    const cellKey = `${mapping.sheet}\u0000${mapping.cell}`;
    if (cells.has(cellKey)) {
      throw new ReportTemplateError('אותו תא מופיע פעמיים במיפוי התבנית. יש לאשר מיפוי אחד בלבד.');
    }
    cells.add(cellKey);
    if (source && (!allowed.has(source) || !Object.prototype.hasOwnProperty.call(values, source))) {
      throw new ReportTemplateError('התבנית מפנה לשדה שאינו שייך לדוח הזה. יש לאשר את המיפוי מחדש.');
    }
    return mapping;
  });
}

/**
 * Resolve, download, verify and fill the live template. `null` has exactly one meaning: no live
 * template, so the caller should produce its standard export. Every corrupt configured template
 * throws visibly; silently falling back there would send the wrong layout while Settings says the
 * accountant's template is active.
 */
export async function renderConfiguredReportTemplate(input: {
  exportKey: ExportKey;
  orgId: string;
  values: ReportTemplateValues;
}): Promise<Uint8Array | null> {
  const resolved = unwrap(await supabase.rpc('resolve_export_report_template', {
    p_export_key: input.exportKey,
  })) as LiveReportTemplate;

  if (!resolved.found) return null;
  if (resolved.export_key !== input.exportKey) {
    throw new ReportTemplateError('השרת החזיר תבנית לסוג דוח אחר. הייצוא נעצר.');
  }

  const expectedPath = resolved.version_id
    ? `${input.orgId}/${resolved.version_id}.xlsx`
    : null;
  if (!expectedPath || resolved.workbook_path !== expectedPath) {
    throw new ReportTemplateError('נתיב התבנית אינו שייך לארגון או לגרסה שאושרה. הייצוא נעצר.');
  }
  if (!Number.isInteger(resolved.workbook_bytes) || Number(resolved.workbook_bytes) <= 0) {
    throw new ReportTemplateError('גודל התבנית המאושר חסר או אינו תקין.');
  }
  if (!/^[0-9a-f]{64}$/.test(resolved.workbook_checksum ?? '')) {
    throw new ReportTemplateError('חתימת התבנית המאושרת חסרה או אינה תקינה.');
  }

  const mapping = approvedMapping(resolved.placeholders, input.exportKey, input.values);
  const downloaded = await supabase.storage.from('export-templates').download(expectedPath);
  if (downloaded.error || !downloaded.data) {
    throw new ReportTemplateError('לא ניתן להוריד את תבנית הייצוא הפרטית. נסו שוב או העלו תבנית חדשה.');
  }
  const bytes = await downloaded.data.arrayBuffer();
  if (bytes.byteLength !== Number(resolved.workbook_bytes)) {
    throw new ReportTemplateError('גודל קובץ התבנית שונה מהגרסה שאושרה. הייצוא נעצר.');
  }
  if (await sha256Hex(bytes) !== resolved.workbook_checksum) {
    throw new ReportTemplateError('חתימת קובץ התבנית אינה תואמת לגרסה שאושרה. הייצוא נעצר.');
  }

  try {
    return fillTemplateWorkbook(bytes, input.values, mapping);
  } catch {
    throw new ReportTemplateError('קובץ התבנית או מיפוי התאים פגומים. יש להעלות ולאשר את התבנית מחדש.');
  }
}

export function downloadRenderedWorkbook(bytes: Uint8Array, fileName: string): void {
  const safeName = fileName.replace(/[\\/:*?"<>|]/g, '').trim() || 'inplace-export.xlsx';
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }));
  const link = document.createElement('a');
  link.href = url;
  link.download = safeName.toLowerCase().endsWith('.xlsx') ? safeName : `${safeName}.xlsx`;
  link.click();
  URL.revokeObjectURL(url);
}
