import * as PapaModule from 'https://esm.sh/papaparse@5.4.1?target=denonext';
import * as XLSX from 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';

const Papa = (PapaModule as unknown as { default: typeof PapaModule }).default ?? PapaModule;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 5_000;

export interface RepairSourceRow {
  source_row: number;
  sku: string | null;
  barcode: string | null;
  product_name: string;
  evidence: { sheet: string; name_cell: string; sku_cell: string; barcode_cell: string };
}

const normalizeHeader = (value: unknown) => String(value ?? '').trim().toLowerCase()
  .replace(/["'״׳.:_\-\s]+/g, '');
const text = (value: unknown, max = 200) => String(value ?? '').trim().slice(0, max);

function findHeader(headers: unknown[], aliases: string[]) {
  const normalized = headers.map(normalizeHeader);
  return aliases.map(normalizeHeader).map((alias) => normalized.indexOf(alias)).find((index) => index >= 0) ?? -1;
}

function rowsFromArrays(rows: unknown[][], sheet: string): RepairSourceRow[] {
  if (rows.length < 2) throw new Error('product_name_repair_source_empty');
  const headers = rows[0];
  const nameIndex = findHeader(headers, ['שם מוצר', 'מוצר', 'product_name', 'product', 'name']);
  const skuIndex = findHeader(headers, ['מק״ט', 'מק"ט', 'מקט', 'sku', 'supplier_sku']);
  const barcodeIndex = findHeader(headers, ['ברקוד', 'barcode']);
  if (nameIndex < 0 || (skuIndex < 0 && barcodeIndex < 0)) {
    throw new Error('product_name_repair_source_columns_missing');
  }
  if (rows.length - 1 > MAX_ROWS) throw new Error('product_name_repair_source_row_limit');

  const cell = (column: number, row: number) => column < 0 ? '' : XLSX.utils.encode_cell({ c: column, r: row });
  return rows.slice(1).flatMap((row, offset) => {
    const productName = text(row[nameIndex]);
    const sku = skuIndex < 0 ? null : text(row[skuIndex]) || null;
    const barcode = barcodeIndex < 0 ? null : text(row[barcodeIndex]) || null;
    if (!productName && !sku && !barcode) return [];
    const sourceRow = offset + 2;
    return [{
      source_row: sourceRow,
      sku,
      barcode,
      product_name: productName,
      evidence: {
        sheet,
        name_cell: cell(nameIndex, sourceRow - 1),
        sku_cell: cell(skuIndex, sourceRow - 1),
        barcode_cell: cell(barcodeIndex, sourceRow - 1),
      },
    }];
  });
}

export function parseProductNameRepairSource(bytes: Uint8Array, filename: string): RepairSourceRow[] {
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('product_name_repair_source_size_invalid');
  const extension = filename.match(/\.(csv|xlsx|xls)$/i)?.[1].toLowerCase();
  if (!extension) throw new Error('product_name_repair_source_type_invalid');
  if (extension === 'csv') {
    let decoded: string;
    try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); }
    catch { throw new Error('product_name_repair_source_encoding_invalid'); }
    const parsed = Papa.parse<unknown[]>(decoded, { header: false, skipEmptyLines: true });
    if (parsed.errors.length) throw new Error('product_name_repair_source_parse_invalid');
    return rowsFromArrays(parsed.data, 'CSV');
  }

  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const ole = [0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]
    .every((value, index) => bytes[index] === value);
  if ((extension === 'xlsx' && !isZip) || (extension === 'xls' && !ole)) {
    throw new Error('product_name_repair_source_parse_invalid');
  }
  try {
    const workbook = XLSX.read(bytes, { type: 'array', raw: true, sheetRows: MAX_ROWS + 2 });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error('product_name_repair_source_parse_invalid');
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1, defval: '', raw: true, blankrows: false,
    }) as unknown[][];
    return rowsFromArrays(rows, sheetName);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('product_name_repair_')) throw error;
    throw new Error('product_name_repair_source_parse_invalid');
  }
}

export async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
