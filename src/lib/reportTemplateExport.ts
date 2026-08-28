import { supabase } from './supabase';
import { unwrap } from './useQuery';
import { exportDefinition, type ExportKey, type PlaceholderMapping } from './exportTemplates';
import { fillTemplateWorkbook } from './exportTemplateWorkbook';
import type { TKey } from './i18n/t';

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
    /**
     * `invoice_balances.credited_amount` for this invoice — the credit the server has already
     * taken off it. `null` when the reader has no balance row for the invoice.
     */
    balance?: { credited_amount: number } | null;
  }[];
}): ReportTemplateValues {
  const netTotal = input.invoices.reduce((sum, row) => sum + row.amount_before_vat, 0);
  const vatTotal = input.invoices.reduce((sum, row) => sum + row.vat_amount, 0);
  const grossTotal = input.invoices.reduce((sum, row) => sum + row.total_amount, 0);
  // Recognised credit is read from the same computed balance the screen shows, never re-derived
  // here from credit lifecycle labels. Since 0173 the canonical credited amount is the sum of the
  // `payment_allocations` that name the credit, and a credit consumed in part stays `received` —
  // so an `offset`/`closed` filter drops money `invoice_balances` has already subtracted and
  // overstates `net_expense` in the file the accountant receives.
  //
  // Both sides of the subtraction must range over the same invoices. If any invoice in the total
  // has no balance row, the credited figure is unanswerable and stays `—` rather than 0.
  const creditedRows = input.invoices.map((row) => row.balance ?? null);
  const creditsRecognized = creditedRows.includes(null)
    ? null
    : creditedRows.reduce((sum, row) => sum + (row?.credited_amount ?? 0), 0);

  return {
    ...commonValues(input),
    invoice_count: input.invoices.length,
    net_total: netTotal,
    vat_total: vatTotal,
    gross_total: grossTotal,
    credits_recognized: creditsRecognized,
    net_expense: creditsRecognized === null ? null : grossTotal - creditsRecognized,
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

export type ReportTemplateErrorCode =
  | 'mapping_invalid'
  | 'unknown_report_type'
  | 'cell_invalid'
  | 'duplicate_cell'
  | 'field_invalid'
  | 'wrong_export_key'
  | 'path_invalid'
  | 'bytes_invalid'
  | 'checksum_invalid'
  | 'download_failed'
  | 'downloaded_size_mismatch'
  | 'downloaded_checksum_mismatch'
  | 'workbook_invalid';

export const REPORT_TEMPLATE_ERROR_KEY: Readonly<Record<ReportTemplateErrorCode, TKey>> = {
  mapping_invalid: 'reportTemplateExport.mappingInvalid',
  unknown_report_type: 'reportTemplateExport.unknownReportType',
  cell_invalid: 'reportTemplateExport.cellInvalid',
  duplicate_cell: 'reportTemplateExport.duplicateCell',
  field_invalid: 'reportTemplateExport.fieldInvalid',
  wrong_export_key: 'reportTemplateExport.wrongExportKey',
  path_invalid: 'reportTemplateExport.pathInvalid',
  bytes_invalid: 'reportTemplateExport.bytesInvalid',
  checksum_invalid: 'reportTemplateExport.checksumInvalid',
  download_failed: 'reportTemplateExport.downloadFailed',
  downloaded_size_mismatch: 'reportTemplateExport.downloadedSizeMismatch',
  downloaded_checksum_mismatch: 'reportTemplateExport.downloadedChecksumMismatch',
  workbook_invalid: 'reportTemplateExport.workbookInvalid',
};

export class ReportTemplateError extends Error {
  readonly code: ReportTemplateErrorCode;

  constructor(code: ReportTemplateErrorCode) {
    super(code);
    this.name = 'ReportTemplateError';
    this.code = code;
  }
}

export function reportTemplateErrorText(
  error: unknown,
  t: (key: TKey) => string,
  fallback: (error: unknown) => string,
): string {
  return error instanceof ReportTemplateError ? t(REPORT_TEMPLATE_ERROR_KEY[error.code]) : fallback(error);
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function approvedMapping(value: unknown, key: ExportKey, values: ReportTemplateValues): PlaceholderMapping[] {
  if (!Array.isArray(value)) {
    throw new ReportTemplateError('mapping_invalid');
  }
  const definition = exportDefinition(key);
  if (!definition) throw new ReportTemplateError('unknown_report_type');
  const allowed = new Set(definition.fields.map((field) => field.key));
  const cells = new Set<string>();

  return value.map((raw) => {
    if (!raw || typeof raw !== 'object') {
      throw new ReportTemplateError('mapping_invalid');
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
      throw new ReportTemplateError('cell_invalid');
    }
    const cellKey = `${mapping.sheet}\u0000${mapping.cell}`;
    if (cells.has(cellKey)) {
      throw new ReportTemplateError('duplicate_cell');
    }
    cells.add(cellKey);
    if (source && (!allowed.has(source) || !Object.prototype.hasOwnProperty.call(values, source))) {
      throw new ReportTemplateError('field_invalid');
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
    throw new ReportTemplateError('wrong_export_key');
  }

  const expectedPath = resolved.version_id
    ? `${input.orgId}/${resolved.version_id}.xlsx`
    : null;
  if (!expectedPath || resolved.workbook_path !== expectedPath) {
    throw new ReportTemplateError('path_invalid');
  }
  if (!Number.isInteger(resolved.workbook_bytes) || Number(resolved.workbook_bytes) <= 0) {
    throw new ReportTemplateError('bytes_invalid');
  }
  if (!/^[0-9a-f]{64}$/.test(resolved.workbook_checksum ?? '')) {
    throw new ReportTemplateError('checksum_invalid');
  }

  const mapping = approvedMapping(resolved.placeholders, input.exportKey, input.values);
  const downloaded = await supabase.storage.from('export-templates').download(expectedPath);
  if (downloaded.error || !downloaded.data) {
    throw new ReportTemplateError('download_failed');
  }
  const bytes = await downloaded.data.arrayBuffer();
  if (bytes.byteLength !== Number(resolved.workbook_bytes)) {
    throw new ReportTemplateError('downloaded_size_mismatch');
  }
  if (await sha256Hex(bytes) !== resolved.workbook_checksum) {
    throw new ReportTemplateError('downloaded_checksum_mismatch');
  }

  try {
    return fillTemplateWorkbook(bytes, input.values, mapping);
  } catch {
    throw new ReportTemplateError('workbook_invalid');
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
