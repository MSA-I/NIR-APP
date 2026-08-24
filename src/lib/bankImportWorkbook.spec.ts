import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BANK_IMPORT_HEADERS,
  BANK_IMPORT_SHEET_NAME,
  BANK_IMPORT_TEMPLATE_VERSION,
  parseCanonicalBankImportWorkbook,
} from './bankImportWorkbook';

function workbookBytes({
  version = BANK_IMPORT_TEMPLATE_VERSION,
  sheetName = BANK_IMPORT_SHEET_NAME,
  headers = BANK_IMPORT_HEADERS,
  rows = [] as unknown[][],
}: {
  version?: string;
  sheetName?: string;
  headers?: readonly string[];
  rows?: unknown[][];
} = {}) {
  const sheet = XLSX.utils.aoa_to_sheet([
    ['INPLACE_BANK_IMPORT', version],
    [...headers],
    ...rows,
  ], { cellDates: true });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  return XLSX.write(workbook, { type: 'array', bookType: 'xlsx', cellDates: true }) as ArrayBuffer;
}

describe('canonical bank XLSX contract', () => {
  it('round-trips real XLSX bytes with exact date/number/text cell types', () => {
    const bytes = readFileSync(resolve('src/test/fixtures/bank-import-v1-fixture.xlsx'));

    const parsed = parseCanonicalBankImportWorkbook(bytes, 'bank-import-v1.xlsx');

    expect(parsed.contract).toEqual({
      template_version: '1',
      sheet: 'Bank Transactions',
      headers: ['transaction_date', 'description', 'direction', 'amount', 'reference'],
    });
    expect(parsed.rows).toEqual([
      {
        tx_date: '2026-08-21', description: 'העברה לספק א', direction: 'debit', is_debit: true, amount: 1250.5,
        reference: 'REF-1', raw: {
          transaction_date: '2026-08-21', description: 'העברה לספק א', direction: 'debit', amount: 1250.5,
          reference: 'REF-1',
        },
      },
      {
        tx_date: '2026-08-22', description: 'העברה מספק ב', direction: 'credit', is_debit: false, amount: 99,
        reference: null, raw: {
          transaction_date: '2026-08-22', description: 'העברה מספק ב', direction: 'credit', amount: 99,
          reference: null,
        },
      },
    ]);
  });

  it('builds the downloadable current template with the exact versioned signature', () => {
    const bytes = readFileSync(resolve('public/templates/inplace-bank-import-v1.xlsx'));
    const workbook = XLSX.read(bytes, { cellDates: true });
    expect(workbook.SheetNames).toEqual([BANK_IMPORT_SHEET_NAME]);
    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[BANK_IMPORT_SHEET_NAME], {
      header: 1,
      raw: true,
    });
    expect(rows[0]).toEqual(['INPLACE_BANK_IMPORT', BANK_IMPORT_TEMPLATE_VERSION]);
    expect(rows[1]).toEqual([...BANK_IMPORT_HEADERS]);
  });

  it.each([
    ['old version', workbookBytes({ version: '0' }), 'bank_import_version_unsupported'],
    ['wrong sheet', workbookBytes({ sheetName: 'Transactions' }), 'bank_import_sheet_invalid'],
    ['wrong header', workbookBytes({ headers: ['date', 'description', 'amount', 'reference'] }), 'bank_import_headers_invalid'],
  ])('rejects %s before returning rows', (_label, bytes, expected) => {
    expect(() => parseCanonicalBankImportWorkbook(bytes, 'bank.xlsx')).toThrow(expected);
  });

  it('rejects CSV and legacy XLS even when their tabular contents look valid', () => {
    const csv = new TextEncoder().encode('transaction_date,description,amount,reference\n2026-08-21,x,10,r');
    expect(() => parseCanonicalBankImportWorkbook(csv, 'bank.csv')).toThrow('bank_import_xlsx_required');
    expect(() => parseCanonicalBankImportWorkbook(csv, 'bank.xls')).toThrow('bank_import_xlsx_required');
  });

  it('rejects formula cells and formula-like text before normalization', () => {
    const bytes = workbookBytes({ rows: [[new Date(Date.UTC(2026, 7, 21)), 'safe', 'debit', 10, 'REF']] });
    const workbook = XLSX.read(bytes, { cellDates: true });
    workbook.Sheets[BANK_IMPORT_SHEET_NAME].B3 = { t: 'n', f: '1+1', v: 2 };
    const formulaBytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    expect(() => parseCanonicalBankImportWorkbook(formulaBytes, 'bank.xlsx')).toThrow('bank_import_formula_forbidden');

    const formulaText = workbookBytes({ rows: [[new Date(Date.UTC(2026, 7, 21)), '=HYPERLINK("https://example.test")', 'debit', 10, 'REF']] });
    expect(() => parseCanonicalBankImportWorkbook(formulaText, 'bank.xlsx')).toThrow('bank_import_formula_forbidden');
  });

  it('rejects string dates, string amounts, empty required values and more than 5,000 rows', () => {
    expect(() => parseCanonicalBankImportWorkbook(workbookBytes({
      rows: [['2026-08-21', 'x', 'debit', 10, 'REF']],
    }), 'bank.xlsx')).toThrow('bank_import_cell_type_invalid');
    expect(() => parseCanonicalBankImportWorkbook(workbookBytes({
      rows: [[new Date(Date.UTC(2026, 7, 21)), 'x', 'debit', '10', 'REF']],
    }), 'bank.xlsx')).toThrow('bank_import_cell_type_invalid');
    expect(() => parseCanonicalBankImportWorkbook(workbookBytes({
      rows: [[new Date(Date.UTC(2026, 7, 21)), '', 'debit', 10, 'REF']],
    }), 'bank.xlsx')).toThrow('bank_import_row_invalid');
    expect(() => parseCanonicalBankImportWorkbook(workbookBytes({
      rows: [[new Date(Date.UTC(2026, 7, 21)), 'x', 'unknown', 10, 'REF']],
    }), 'bank.xlsx')).toThrow('bank_import_row_invalid');
    expect(() => parseCanonicalBankImportWorkbook(workbookBytes({
      rows: Array.from({ length: 5_001 }, (_, index) => [
        new Date(Date.UTC(2026, 7, 21)), `row ${index}`, 'debit', index + 1, null,
      ]),
    }), 'bank.xlsx')).toThrow('bank_import_row_limit');
  });

  it('rejects a declared fifth column before scanning non-contract cells', () => {
    const extraColumn = workbookBytes({
      headers: [...BANK_IMPORT_HEADERS, 'unexpected'],
    });
    expect(() => parseCanonicalBankImportWorkbook(extraColumn, 'bank.xlsx'))
      .toThrow('bank_import_headers_invalid');
  });
});
