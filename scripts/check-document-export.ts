import assert from 'node:assert/strict';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import {
  documentExportTemplateSchema,
  generateDocumentExport,
  isAllowedDocumentExportSourcePath,
  type DocumentExportFormat,
  type DocumentExportInput,
  type DocumentExportResult,
  type DocumentExportTemplate,
  type DocumentExportTable,
} from '../src/lib/documentExport.ts';

const input: DocumentExportInput = {
  schema_version: '1',
  document_type: 'invoice',
  document_type_confidence: 0.98,
  supplier: {
    suggested_id: '11111111-1111-4111-8111-111111111111',
    suggested_name: 'ספק ירושלים',
    confidence: 0.91,
  },
  fields: [
    { key: 'rtl', value: 'חשבונית בעברית' },
    { key: 'dangerous_equals', value: '=SUM(1,1)' },
    { key: 'dangerous_plus', value: '+cmd' },
    { key: 'dangerous_minus', value: '-cmd' },
    { key: 'dangerous_at', value: '@cmd' },
    { key: 'dangerous_tab', value: '\t=cmd' },
    { key: 'dangerous_cr', value: '\r=cmd' },
    { key: 'total', value: 1234.5 },
    { key: 'invoice_date', value: '2026-07-29' },
    { key: 'approved', value: true },
    { key: 'optional_note', value: null },
  ],
  line_items: [
    { source_row: 7, values: { description: 'שורה ראשונה', amount: 4.5 } },
    { source_row: 8, values: { description: 'שורה שנייה', amount: 9 } },
  ],
};

const columns: DocumentExportTemplate['columns'] = [
  { key: 'schema', label: 'גרסה', source_path: 'schema_version', type: 'text', required: true },
  { key: 'document_type', label: 'סוג מסמך', source_path: 'document_type', type: 'text', required: true },
  { key: 'supplier', label: 'ספק', source_path: 'supplier.suggested_name', type: 'text', required: false },
  { key: 'rtl', label: 'תיאור', source_path: 'fields.rtl', type: 'text', required: true },
  { key: 'dangerous_equals', label: '=מספר מסמך', source_path: 'fields.dangerous_equals', type: 'text', required: true },
  { key: 'dangerous_plus', label: 'פלוס', source_path: 'fields.dangerous_plus', type: 'text', required: true },
  { key: 'dangerous_minus', label: 'מינוס', source_path: 'fields.dangerous_minus', type: 'text', required: true },
  { key: 'dangerous_at', label: 'כרוכית', source_path: 'fields.dangerous_at', type: 'text', required: true },
  { key: 'dangerous_tab', label: 'טאב', source_path: 'fields.dangerous_tab', type: 'text', required: true },
  { key: 'dangerous_cr', label: 'החזרת גררה', source_path: 'fields.dangerous_cr', type: 'text', required: true },
  { key: 'total', label: 'סכום', source_path: 'fields.total', type: 'number', required: true },
  { key: 'invoice_date', label: 'תאריך', source_path: 'fields.invoice_date', type: 'date', required: true },
  { key: 'approved', label: 'מאושר', source_path: 'fields.approved', type: 'boolean', required: true },
  { key: 'optional_note', label: 'הערה', source_path: 'fields.optional_note', type: 'text', required: false },
  { key: 'source_row', label: 'שורת מקור', source_path: 'line_items.source_row', type: 'number', required: true },
  { key: 'line_description', label: 'פריט', source_path: 'line_items.values.description', type: 'text', required: true },
  { key: 'line_amount', label: 'כמות', source_path: 'line_items.values.amount', type: 'number', required: true },
];

const template = (format: DocumentExportFormat): DocumentExportTemplate => ({
  schema_version: '1',
  name: 'ייצוא חשבונית',
  format,
  scope: { document_type: 'invoice', supplier_id: null, user_id: null },
  columns,
});

const results = new Map<DocumentExportFormat, DocumentExportResult>();
for (const format of ['xlsx', 'csv', 'json', 'table', 'text'] as const) {
  const first = await generateDocumentExport(input, template(format));
  const second = await generateDocumentExport(input, template(format));
  assert.match(first.checksum, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.checksum, second.checksum, `${format} checksum must be deterministic`);
  assert.deepEqual(first.content, second.content, `${format} content must be deterministic`);
  results.set(format, first);
}

const tableResult = results.get('table')!;
assert.equal(tableResult.fileExtension, null);
assert.equal(tableResult.mimeType, null);
const table = tableResult.content as DocumentExportTable;
assert.equal(table.rows.length, 2);
assert.equal(table.rows[0].rtl, 'חשבונית בעברית');
assert.equal(table.rows[0].total, 1234.5);
assert.equal(table.rows[0].invoice_date, '2026-07-29');
assert.equal(table.rows[0].approved, true);
assert.equal(table.rows[0].optional_note, null);
assert.equal(table.rows[1].line_description, 'שורה שנייה');
assert.equal(table.rows[1].line_amount, 9);
assert.equal(table.rows[0].dangerous_equals, '=SUM(1,1)', 'table must retain source text');

const jsonResult = results.get('json')!;
assert.equal(typeof jsonResult.content, 'string');
const json = JSON.parse(jsonResult.content as string) as DocumentExportTable;
assert.deepEqual(json, table);
assert.equal(json.rows[0].dangerous_plus, '+cmd', 'JSON must retain source text');
assert.ok((jsonResult.content as string).includes('חשבונית בעברית'));

const textResult = results.get('text')!;
assert.equal(typeof textResult.content, 'string');
assert.ok((textResult.content as string).includes('תיאור: חשבונית בעברית'));
assert.ok((textResult.content as string).includes('תאריך: 2026-07-29'));
assert.ok((textResult.content as string).includes('הערה: null'));
assert.ok((textResult.content as string).includes('פלוס: +cmd'), 'text must retain source text');

const csvResult = results.get('csv')!;
assert.equal(csvResult.mimeType, 'text/csv');
assert.ok((csvResult.content as string).startsWith('\uFEFF'));
const csvRoundTrip = Papa.parse<string[]>((csvResult.content as string).replace(/^\uFEFF/, ''), {
  skipEmptyLines: false,
});
assert.deepEqual(csvRoundTrip.errors, []);
assert.equal(csvRoundTrip.data.length, 3);
const csvHeaders = csvRoundTrip.data[0];
const csvFirst = csvRoundTrip.data[1];
const index = (key: string) => columns.findIndex((column) => column.key === key);
const spreadsheetSafe = (value: unknown) =>
  typeof value === 'string' && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
const expectedSpreadsheetRows = [
  table.columns.map(({ label }) => spreadsheetSafe(label)),
  ...table.rows.map((row) => table.columns.map(({ key }) => spreadsheetSafe(row[key]))),
];
assert.deepEqual(csvRoundTrip.data, expectedSpreadsheetRows.map((row) => row.map((value) =>
  value === null ? '' : String(value)
)), 'CSV must round-trip every rendered cell');
assert.equal(csvHeaders[index('dangerous_equals')], "'=מספר מסמך", 'CSV header must be neutralized');
assert.equal(csvFirst[index('dangerous_equals')], "'=SUM(1,1)");
assert.equal(csvFirst[index('dangerous_plus')], "'+cmd");
assert.equal(csvFirst[index('dangerous_minus')], "'-cmd");
assert.equal(csvFirst[index('dangerous_at')], "'@cmd");
assert.equal(csvFirst[index('dangerous_tab')], "'\t=cmd");
assert.equal(csvFirst[index('dangerous_cr')], "'\r=cmd");
assert.equal(csvFirst[index('rtl')], 'חשבונית בעברית');
assert.equal(csvFirst[index('total')], '1234.5');
assert.equal(csvFirst[index('invoice_date')], '2026-07-29');
assert.equal(csvFirst[index('approved')], 'true');
assert.equal(csvFirst[index('optional_note')], '');

const xlsxResult = results.get('xlsx')!;
assert.ok(xlsxResult.content instanceof Uint8Array);
const workbook = XLSX.read(xlsxResult.content as Uint8Array, { type: 'array' });
assert.equal(workbook.Workbook?.Views?.[0]?.RTL, true, 'XLSX workbook must open RTL');
assert.deepEqual(workbook.SheetNames, ['Export']);
for (const [address, cell] of Object.entries(workbook.Sheets.Export)) {
  if (!address.startsWith('!')) assert.equal((cell as XLSX.CellObject).f, undefined, `${address} must not contain a formula`);
}
const xlsxRoundTrip = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets.Export, {
  header: 1,
  raw: true,
  defval: null,
});
assert.equal(xlsxRoundTrip.length, 3);
const xlsxHeaders = xlsxRoundTrip[0];
const xlsxFirst = xlsxRoundTrip[1];
assert.deepEqual(xlsxRoundTrip, expectedSpreadsheetRows, 'XLSX must round-trip every rendered cell');
assert.equal(xlsxHeaders[index('dangerous_equals')], "'=מספר מסמך", 'XLSX header must be neutralized');
assert.equal(xlsxFirst[index('dangerous_equals')], "'=SUM(1,1)");
assert.equal(xlsxFirst[index('dangerous_plus')], "'+cmd");
assert.equal(xlsxFirst[index('dangerous_minus')], "'-cmd");
assert.equal(xlsxFirst[index('dangerous_at')], "'@cmd");
assert.equal(xlsxFirst[index('dangerous_tab')], "'\t=cmd");
assert.equal(xlsxFirst[index('dangerous_cr')], "'\r=cmd");
assert.equal(xlsxFirst[index('rtl')], 'חשבונית בעברית');
assert.equal(xlsxFirst[index('total')], 1234.5);
assert.equal(xlsxFirst[index('invoice_date')], '2026-07-29');
assert.equal(xlsxFirst[index('approved')], true);
assert.equal(xlsxFirst[index('optional_note')], null);

const missingRequired = {
  ...input,
  fields: input.fields.filter(({ key }) => key !== 'total'),
};
await assert.rejects(
  generateDocumentExport(missingRequired, template('json')),
  /document_export_required_missing:total/,
);
await assert.rejects(generateDocumentExport({
  ...input,
  fields: input.fields.map((field) => field.key === 'invoice_date'
    ? { ...field, value: '0000-01-01' }
    : field),
}, template('json')), /document_export_type_mismatch:invoice_date/);

assert.equal(isAllowedDocumentExportSourcePath('fields.total'), true);
assert.equal(isAllowedDocumentExportSourcePath('line_items.values.amount'), true);
assert.equal(isAllowedDocumentExportSourcePath('fields.total + 1'), false);
assert.equal(isAllowedDocumentExportSourcePath('line_items.values.constructor'), false);
assert.throws(() => documentExportTemplateSchema.parse({
  ...template('json'),
  columns: [{ ...columns[0], source_path: 'fields.total + 1' }],
}));
assert.throws(() => documentExportTemplateSchema.parse({
  ...template('json'),
  executable: 'not allowed',
}));
assert.throws(() => documentExportTemplateSchema.parse({
  ...template('json'),
  scope: { document_type: null, supplier_id: null, user_id: '22222222-2222-4222-8222-222222222222' },
}), /scope must match/);
assert.throws(() => documentExportTemplateSchema.parse({
  ...template('json'),
  scope: {
    document_type: 'invoice',
    supplier_id: '22222222-2222-4222-8222-222222222222',
    user_id: null,
  },
}), /scope must match/);

const documentOnly = await generateDocumentExport(input, {
  ...template('table'),
  columns: [columns[0]],
});
assert.equal(documentOnly.rows.length, input.line_items.length, 'line items must define export row count');

console.log('Document export checks passed');
