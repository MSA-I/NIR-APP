import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { z } from 'zod';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const STATIC_SOURCE_PATHS = new Set([
  'schema_version',
  'document_type',
  'document_type_confidence',
  'supplier.suggested_id',
  'supplier.suggested_name',
  'supplier.confidence',
  'line_items.source_row',
]);
const DOCUMENT_TYPES = [
  'invoice',
  'delivery_note',
  'credit_note',
  'price_list',
  'quote',
  'payment_confirmation',
  'tax_receipt',
  'other',
] as const;

const sourceKey = (path: string, prefix: string) => {
  if (!path.startsWith(prefix)) return null;
  const key = path.slice(prefix.length);
  return IDENTIFIER.test(key) && !FORBIDDEN_KEYS.has(key) ? key : null;
};

export const isAllowedDocumentExportSourcePath = (path: string) =>
  STATIC_SOURCE_PATHS.has(path)
  || sourceKey(path, 'fields.') !== null
  || sourceKey(path, 'line_items.values.') !== null;

const documentExportColumnSchema = z.object({
  key: z.string().regex(IDENTIFIER).refine((key) => !FORBIDDEN_KEYS.has(key), 'unsafe column key'),
  label: z.string().trim().min(1).max(200),
  source_path: z.string().max(128).refine(isAllowedDocumentExportSourcePath, 'source_path is not allowlisted'),
  type: z.enum(['text', 'number', 'date', 'boolean']),
  required: z.boolean(),
}).strict();

export const documentExportTemplateSchema = z.object({
  schema_version: z.literal('1'),
  name: z.string().trim().min(1).max(120),
  format: z.enum(['xlsx', 'csv', 'json', 'table', 'text']),
  scope: z.object({
    document_type: z.enum(DOCUMENT_TYPES).nullable(),
    supplier_id: z.string().uuid().nullable(),
    user_id: z.string().uuid().nullable(),
  }).strict(),
  columns: z.array(documentExportColumnSchema).min(1).max(100),
}).strict().superRefine((template, context) => {
  const { document_type: documentType, supplier_id: supplierId, user_id: userId } = template.scope;
  if ((supplierId !== null && documentType !== null)
      || (userId !== null && supplierId === null && documentType === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['scope'],
      message: 'scope must match one of the five supported precedence tiers',
    });
  }
  const seen = new Set<string>();
  template.columns.forEach((column, index) => {
    if (seen.has(column.key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['columns', index, 'key'],
        message: 'column keys must be unique',
      });
    }
    seen.add(column.key);
  });
});

export type DocumentExportTemplate = z.infer<typeof documentExportTemplateSchema>;
export type DocumentExportFormat = DocumentExportTemplate['format'];
export type DocumentExportCell = string | number | boolean | null;

export interface DocumentExportInput {
  schema_version: '1';
  document_type: string;
  document_type_confidence: number | null;
  supplier: {
    suggested_id: string | null;
    suggested_name: string | null;
    confidence: number | null;
  };
  fields: Array<{
    key: string;
    value: DocumentExportCell;
  }>;
  line_items: Array<{
    source_row: number | null;
    values: Record<string, string | number | null>;
  }>;
}

export interface DocumentExportTable {
  columns: Array<Pick<DocumentExportTemplate['columns'][number], 'key' | 'label' | 'type'>>;
  rows: Array<Record<string, DocumentExportCell>>;
}

export interface DocumentExportResult {
  format: DocumentExportFormat;
  mimeType: string | null;
  fileExtension: string | null;
  checksum: `sha256:${string}`;
  content: Uint8Array | string | DocumentExportTable;
  columns: DocumentExportTable['columns'];
  rows: DocumentExportTable['rows'];
}

interface ResolvedValue {
  found: boolean;
  value: unknown;
}

const ownValue = (value: object | null | undefined, key: string): ResolvedValue =>
  value && Object.prototype.hasOwnProperty.call(value, key)
    ? { found: true, value: (value as Record<string, unknown>)[key] }
    : { found: false, value: undefined };

function resolveSourcePath(
  input: DocumentExportInput,
  lineItem: DocumentExportInput['line_items'][number] | undefined,
  path: string,
): ResolvedValue {
  switch (path) {
    case 'schema_version': return ownValue(input, 'schema_version');
    case 'document_type': return ownValue(input, 'document_type');
    case 'document_type_confidence': return ownValue(input, 'document_type_confidence');
    case 'supplier.suggested_id': return ownValue(input.supplier, 'suggested_id');
    case 'supplier.suggested_name': return ownValue(input.supplier, 'suggested_name');
    case 'supplier.confidence': return ownValue(input.supplier, 'confidence');
    case 'line_items.source_row': return ownValue(lineItem, 'source_row');
  }

  const fieldKey = sourceKey(path, 'fields.');
  if (fieldKey !== null) {
    const field = input.fields.find(({ key }) => key === fieldKey);
    return field ? ownValue(field, 'value') : { found: false, value: undefined };
  }

  const lineValueKey = sourceKey(path, 'line_items.values.');
  if (lineValueKey !== null) return ownValue(lineItem?.values, lineValueKey);
  return { found: false, value: undefined };
}

const validDate = (value: string) => {
  if (!/^(?!0000-)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

function normalizeValue(value: unknown, column: DocumentExportTemplate['columns'][number]): DocumentExportCell {
  if (value === null) return null;
  switch (column.type) {
    case 'text':
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
      break;
    case 'number':
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      break;
    case 'boolean':
      if (typeof value === 'boolean') return value;
      break;
    case 'date':
      if (typeof value === 'string' && validDate(value)) return value;
      break;
  }
  throw new Error(`document_export_type_mismatch:${column.key}`);
}

function buildTable(input: DocumentExportInput, template: DocumentExportTemplate): DocumentExportTable {
  const columns = template.columns.map(({ key, label, type }) => ({ key, label, type }));
  const lineItems = input.line_items.length ? input.line_items : [undefined];
  const rows = lineItems.map((lineItem) => Object.fromEntries(template.columns.map((column) => {
    const resolved = resolveSourcePath(input, lineItem, column.source_path);
    if ((!resolved.found || resolved.value === null) && column.required) {
      throw new Error(`document_export_required_missing:${column.key}`);
    }
    return [column.key, resolved.found ? normalizeValue(resolved.value, column) : null];
  })) as Record<string, DocumentExportCell>);
  return { columns, rows };
}

/**
 * A cell that opens with `= + - @ TAB CR` is a formula to Excel and to Sheets, whatever the app
 * meant by it. The leading apostrophe is the spreadsheet's own "this is text" marker: it does not
 * survive into the value a person sees, and it is what stops a supplier name like `=HYPERLINK(...)`
 * or `@SUM(...)` from executing when an accountant opens the file.
 *
 * Exported because it was private here while `monthlyReport.ts` and `Expenses.tsx` — the two
 * exports that actually go OUT of the building, to an accountant — wrote supplier names,
 * exception titles, payment references and bank descriptions into cells raw. One neutralizer, one
 * place; the alternative was a second regex that could drift from this one.
 */
export const neutralizeSpreadsheetString = (value: DocumentExportCell): DocumentExportCell =>
  typeof value === 'string' && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;

/** The same rule over a row object, for the `json_to_sheet` callers. Keys are ours; values are not. */
export function neutralizeSpreadsheetRow<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === 'string' ? neutralizeSpreadsheetString(value) : value;
  }
  return out as T;
}

const spreadsheetMatrix = (table: DocumentExportTable): DocumentExportCell[][] => [
  table.columns.map(({ label }) => neutralizeSpreadsheetString(label)),
  ...table.rows.map((row) => table.columns.map(({ key }) => neutralizeSpreadsheetString(row[key]))),
];

const encode = (value: string) => new TextEncoder().encode(value);

async function checksum(bytes: Uint8Array): Promise<`sha256:${string}`> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

const textValue = (value: DocumentExportCell) => value === null ? 'null' : String(value);

export async function generateDocumentExport(
  input: DocumentExportInput,
  untrustedTemplate: unknown,
): Promise<DocumentExportResult> {
  const template = documentExportTemplateSchema.parse(untrustedTemplate);
  const table = buildTable(input, template);
  let content: DocumentExportResult['content'];
  let bytes: Uint8Array;
  let mimeType: string | null;
  let fileExtension: string | null;

  switch (template.format) {
    case 'xlsx': {
      const workbook = XLSX.utils.book_new();
      workbook.Workbook = { Views: [{ RTL: true }] };
      workbook.Props = {
        CreatedDate: new Date('2000-01-01T00:00:00.000Z'),
        ModifiedDate: new Date('2000-01-01T00:00:00.000Z'),
      };
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(spreadsheetMatrix(table)), 'Export');
      content = new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx', compression: true }));
      bytes = content;
      mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      fileExtension = 'xlsx';
      break;
    }
    case 'csv':
      content = `\uFEFF${Papa.unparse(spreadsheetMatrix(table), { newline: '\r\n' })}`;
      bytes = encode(content);
      mimeType = 'text/csv';
      fileExtension = 'csv';
      break;
    case 'json':
      content = JSON.stringify(table, null, 2);
      bytes = encode(content);
      mimeType = 'application/json';
      fileExtension = 'json';
      break;
    case 'table':
      content = table;
      bytes = encode(JSON.stringify(table));
      mimeType = null;
      fileExtension = null;
      break;
    case 'text':
      content = table.rows.map((row) => table.columns
        .map(({ key, label }) => `${label}: ${textValue(row[key])}`)
        .join('\r\n'))
        .join('\r\n\r\n');
      bytes = encode(content);
      mimeType = 'text/plain';
      fileExtension = 'txt';
      break;
  }

  return {
    format: template.format,
    mimeType,
    fileExtension,
    checksum: await checksum(bytes),
    content,
    columns: table.columns,
    rows: table.rows,
  };
}
