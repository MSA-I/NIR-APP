import { assertEquals, assertThrows } from 'jsr:@std/assert@1.0.14';
import * as XLSX from 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';
import { parseProductNameRepairSource, sha256Hex } from './core.ts';

Deno.test('XLSX parser preserves source text and exact row/cell provenance', async () => {
  const sheet = XLSX.utils.aoa_to_sheet([
    ['מק״ט', 'ברקוד', 'שם מוצר'],
    ['SKU-1', '', ')ג״ק 5( ןבל חמק'],
    ['', '729000000001', 'שמן 1 ליטר'],
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'מחירון');
  const bytes = new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }));

  assertEquals(parseProductNameRepairSource(bytes, 'original.xlsx'), [
    { source_row: 2, sku: 'SKU-1', barcode: null, product_name: ')ג״ק 5( ןבל חמק',
      evidence: { sheet: 'מחירון', name_cell: 'C2', sku_cell: 'A2', barcode_cell: 'B2' } },
    { source_row: 3, sku: null, barcode: '729000000001', product_name: 'שמן 1 ליטר',
      evidence: { sheet: 'מחירון', name_cell: 'C3', sku_cell: 'A3', barcode_cell: 'B3' } },
  ]);
});

Deno.test('CSV parser rejects missing authoritative identifier columns', () => {
  const bytes = new TextEncoder().encode('שם מוצר,מחיר\nמוצר,10\n');
  assertThrows(() => parseProductNameRepairSource(bytes, 'original.csv'),
    Error, 'product_name_repair_source_columns_missing');
});

Deno.test('checksum is computed from original bytes', async () => {
  assertEquals(await sha256Hex(new TextEncoder().encode('immutable-original')),
    '84623405f03b6687bf0066b394e76a7e0020a81706a7bbbee24fb964cc67ab5d');
});

Deno.test('handler downloads server-side and never accepts caller rows/checksum', async () => {
  const source = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  for (const required of [
    '.storage.from(BUCKET).download(',
    'sha256Hex(bytes)',
    'parseProductNameRepairSource(bytes, submission.file_name)',
    "admin.rpc('prepare_product_name_repair_dry_run'",
    'p_requester_id: user.data.user.id',
  ]) {
    if (!source.includes(required)) throw new Error(`missing handler anchor: ${required}`);
  }
  if (/body\.(rows|checksum)/.test(source)) throw new Error('caller-authoritative rows/checksum reached handler');
});
