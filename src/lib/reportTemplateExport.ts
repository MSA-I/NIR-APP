import { supabase } from './supabase';
import { unwrap } from './useQuery';
import { exportDefinition, type ExportKey, type PlaceholderMapping } from './exportTemplates';
import { fillTemplateWorkbook } from './exportTemplateWorkbook';
import { downloadBytes, safeFileName, XLSX_MIME } from './workbook';
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


/**
 * A workbook template substitutes named placeholders into CELLS, so its money values are numbers
 * an accountant sorts and adds in Excel. That is exactly why a period covering two currencies
 * cannot fill them (OPEN-DECISIONS #277): the only honest single number for "gross total" across
 * ₪12,400 and $3,100 does not exist, and a cell holding 15,500 would be worse than an empty one
 * because it looks computed.
 *
 * So the rule these builders follow is the rule the whole product follows:
 *
 *   ONE CURRENCY  every numeric placeholder is filled exactly as it always was, and `currency`
 *                 names it. This is every period any organisation has today.
 *   TWO OR MORE   the numeric placeholders are null — which every template already renders as an
 *                 em dash, because a figure the reader may not have permission to see has always
 *                 been able to arrive null — and `currency_note` says in words which currencies
 *                 the period held, so the file states the reason rather than looking incomplete.
 *
 * The per-currency workbook itself — a currency column on every money sheet and a sheet per
 * currency in a mixed month — is #287 and belongs to the monthly report, not to this template.
 */
export interface MoneyEntry { currency: string; amount: number }

export function singleCurrencyTotal(entries: readonly MoneyEntry[] | null | undefined) {
  if (!entries || entries.length === 0) return { amount: null as number | null, currency: null as string | null, mixed: false };
  const currencies = [...new Set(entries.map((entry) => entry.currency))].sort();
  if (currencies.length > 1) return { amount: null as number | null, currency: null as string | null, mixed: true };
  return {
    amount: entries.reduce((sum, entry) => sum + entry.amount, 0),
    currency: currencies[0],
    mixed: false,
  };
}

function currencyValues(entries: readonly MoneyEntry[] | null | undefined): ReportTemplateValues {
  const currencies = [...new Set((entries ?? []).map((entry) => entry.currency))].sort();
  return {
    currency: currencies.length === 1 ? currencies[0] : null,
    currency_note: currencies.length > 1
      ? `התקופה כוללת יותר ממטבע אחד (${currencies.join(', ')}), ולכן אין סכום כולל יחיד`
      : null,
  };
}

export function monthlyReportTemplateValues(input: ReportPeriodInput & {
  invoices: {
    amount_before_vat: number;
    vat_amount: number;
    total_amount: number;
    /** The invoice's own currency (0217). Every total below is filled only when they all agree. */
    currency: string;
    supplier: { name: string };
    /**
     * `invoice_balances.credited_amount` for this invoice — the credit the server has already
     * taken off it. `null` when the reader has no balance row for the invoice.
     */
    balance?: { credited_amount: number } | null;
  }[];
}): ReportTemplateValues {
  const net = singleCurrencyTotal(input.invoices.map((row) => ({ currency: row.currency, amount: row.amount_before_vat })));
  const vat = singleCurrencyTotal(input.invoices.map((row) => ({ currency: row.currency, amount: row.vat_amount })));
  const gross = singleCurrencyTotal(input.invoices.map((row) => ({ currency: row.currency, amount: row.total_amount })));
  // Recognised credit is read from the same computed balance the screen shows, never re-derived
  // here from credit lifecycle labels. Since 0173 the canonical credited amount is the sum of the
  // `payment_allocations` that name the credit, and a credit consumed in part stays `received` —
  // so an `offset`/`closed` filter drops money `invoice_balances` has already subtracted and
  // overstates `net_expense` in the file the accountant receives.
  //
  // Both sides of the subtraction must range over the same invoices. If any invoice in the total
  // has no balance row, the credited figure is unanswerable and stays `—` rather than 0.
  //
  // A MONTH WITH NO INVOICES AT ALL IS THE SAME KIND OF ABSENCE (`EXP-03`). `reduce` over an empty
  // array returns 0, and it reached the file as a literal `זיכויים שקוזזו | 0` sitting between
  // four money fields the same empty month had correctly left unstated — one block, two answers to
  // the same question. Nothing was measured, so there is no figure.
  const creditedRows = input.invoices.map((row) => row.balance ?? null);
  const creditsRecognized = input.invoices.length === 0 || creditedRows.includes(null) || gross.mixed
    ? null
    : input.invoices.reduce((sum, row) => sum + (row.balance?.credited_amount ?? 0), 0);

  return {
    ...commonValues(input),
    ...currencyValues(input.invoices.map((row) => ({ currency: row.currency, amount: row.total_amount }))),
    invoice_count: input.invoices.length,
    net_total: net.amount,
    vat_total: vat.amount,
    gross_total: gross.amount,
    credits_recognized: creditsRecognized,
    net_expense: creditsRecognized === null || gross.amount === null ? null : gross.amount - creditsRecognized,
    supplier_count: new Set(input.invoices.map((row) => row.supplier.name).filter(Boolean)).size,
  };
}

export interface PurchaseMetrics {
  committed_by_currency: MoneyEntry[] | null;
  gross_expense_by_currency: MoneyEntry[] | null;
  credits_recognised_by_currency: MoneyEntry[] | null;
  net_expense_by_currency: MoneyEntry[] | null;
}

export function expenseSummaryTemplateValues(input: ReportPeriodInput & {
  metrics: PurchaseMetrics;
  /** Per supplier, in ONE currency — the caller picks which and passes only that slice. */
  bySupplier: { name: string; total: number; currency: string }[];
}): ReportTemplateValues {
  const topSupplier = [...input.bySupplier].sort((a, b) => b.total - a.total)[0] ?? null;
  const gross = singleCurrencyTotal(input.metrics.gross_expense_by_currency);
  return {
    ...commonValues(input),
    ...currencyValues(input.metrics.gross_expense_by_currency),
    committed_total: singleCurrencyTotal(input.metrics.committed_by_currency).amount,
    gross_total: gross.amount,
    credits_recognized: singleCurrencyTotal(input.metrics.credits_recognised_by_currency).amount,
    net_expense: singleCurrencyTotal(input.metrics.net_expense_by_currency).amount,
    top_supplier_name: topSupplier?.name ?? null,
    top_supplier_total: topSupplier?.total ?? null,
  };
}

export function productPurchaseTemplateValues(input: ReportPeriodInput & {
  products: { gross_amount_by_currency: MoneyEntry[] | null }[];
  unmappedInvoiceLines: number;
  unmappedInvoiceAmount: MoneyEntry[];
}): ReportTemplateValues {
  // Unmapped invoice money remains visible as unmapped, but it is still part of the period's
  // gross expense. Omitting it from the total would make the template look reconciled when it is
  // exactly the work item the report calls out. Both halves go into ONE list, so a period whose
  // products and unmapped lines are in different currencies is mixed and fills nothing.
  const everyEntry = [
    ...input.products.flatMap((row) => row.gross_amount_by_currency ?? []),
    ...input.unmappedInvoiceAmount,
  ];
  const unmapped = singleCurrencyTotal(input.unmappedInvoiceAmount);
  return {
    ...commonValues(input),
    ...currencyValues(everyEntry),
    product_count: input.products.length,
    gross_total: singleCurrencyTotal(everyEntry).amount,
    unmapped_invoice_lines: input.unmappedInvoiceLines,
    unmapped_invoice_amount: unmapped.amount,
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
    return await fillTemplateWorkbook(bytes, input.values, mapping);
  } catch {
    throw new ReportTemplateError('workbook_invalid');
  }
}

export function downloadRenderedWorkbook(bytes: Uint8Array, fileName: string): void {
  // The mechanics moved to workbook.ts and were wrong here in two ways that only show outside
  // Chrome: the anchor was never appended to the document (a detached anchor's click is a no-op in
  // Firefox), and the object URL was revoked in the same turn as the click, which can cancel a
  // download that has not started reading the blob yet.
  const safeName = safeFileName(fileName, 'inplace-export.xlsx');
  downloadBytes(bytes, safeName.toLowerCase().endsWith('.xlsx') ? safeName : `${safeName}.xlsx`, XLSX_MIME);
}
