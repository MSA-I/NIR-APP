import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BANK_IMPORT_EXAMPLE_ROW,
  BANK_IMPORT_GUIDE_SHEET_NAME,
  BANK_IMPORT_HEADERS,
  BANK_IMPORT_SHEET_NAME,
  BANK_IMPORT_TEMPLATE_VERSION,
  buildCanonicalBankImportTemplate,
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
    // The DATA sheet is still first and still named exactly this — the machine contract, unmoved.
    // What it is no longer is the only sheet: `EXP-09` added the Hebrew guide a person reads, and
    // its content is pinned by the block at the bottom of this file.
    expect(workbook.SheetNames[0]).toBe(BANK_IMPORT_SHEET_NAME);
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

/**
 * `EXP-09` — the template is handed to a PERSON, and it was written for a parser.
 *
 * What the sweep downloaded from the Hebrew button `הורדת התבנית העדכנית` was 16 KB containing two
 * rows: `INPLACE_BANK_IMPORT | 1` and five English keys. No Hebrew anywhere, no example, and
 * nothing saying that `direction` means the literal strings `debit` and `credit` — which the
 * parser refuses anything else for.
 *
 * The machine contract does not move: the data sheet keeps its name, its signature row and its
 * five English headers, so every template a tenant has already downloaded still imports. What is
 * added is what a person needs — a Hebrew guide sheet and one worked example row — and the one
 * safety rule that makes an example row safe in a FINANCIAL import: the parser refuses the file
 * while the example is still in it, by name, rather than filing a specimen transaction against
 * the tenant's bank account.
 */
describe('EXP-09 — a template a Hebrew bookkeeper can fill in', () => {
  const shipped = () => XLSX.read(
    readFileSync(resolve('public/templates/inplace-bank-import-v1.xlsx')),
    { cellDates: true },
  );

  const cells = (workbook: XLSX.WorkBook, sheet: string) =>
    XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheet]!, { header: 1 })
      .flat().map((value) => String(value ?? ''));

  /**
   * The shipped asset is written by `scripts/generate-bank-import-assets.mjs`, which is plain Node
   * and therefore re-declares the sheet names, the guide rows and the example row that
   * `bankImportWorkbook.ts` owns. A second copy that nothing compares is how a guard comes to
   * approve the thing it was written to prevent — so the two are compared here, cell for cell.
   */
  it('is the file the module itself would build, cell for cell', () => {
    const built = XLSX.read(buildCanonicalBankImportTemplate(), { cellDates: true });
    const asset = shipped();
    expect(asset.SheetNames).toEqual(built.SheetNames);
    for (const name of built.SheetNames) {
      expect(cells(asset, name)).toEqual(cells(built, name));
    }
  });

  it('labels every column in Hebrew and states the values direction accepts', () => {
    const workbook = shipped();
    const guide = workbook.SheetNames.find((name) => name !== BANK_IMPORT_SHEET_NAME);
    expect(guide).toBe(BANK_IMPORT_GUIDE_SHEET_NAME);

    const text = cells(workbook, guide!).join('\n');
    // One Hebrew label per machine key — the five columns a person has to fill in.
    for (const label of ['תאריך התנועה', 'תיאור', 'כיוון התנועה', 'סכום', 'אסמכתה']) {
      expect(text).toContain(label);
    }
    for (const key of BANK_IMPORT_HEADERS) expect(text).toContain(key);
    // The two literals the parser refuses anything else for, said out loud in the file itself.
    expect(text).toContain('debit');
    expect(text).toContain('credit');
    // No currency column, and the reason is the statement's own single currency — stated rather
    // than left for a bookkeeper to discover after importing a statement in another one.
    expect(text).toContain('ILS');
  });

  it('carries exactly one worked example row, in the shape a real row takes', () => {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(
      shipped().Sheets[BANK_IMPORT_SHEET_NAME]!,
      { header: 1, raw: true, blankrows: false },
    );
    expect(rows[0]).toEqual(['INPLACE_BANK_IMPORT', BANK_IMPORT_TEMPLATE_VERSION]);
    expect(rows[1]).toEqual([...BANK_IMPORT_HEADERS]);
    expect(rows).toHaveLength(3);

    const [date, description, direction, amount, reference] = rows[2]!;
    expect(date).toBeInstanceOf(Date);
    expect(typeof description).toBe('string');
    expect(String(description)).toContain('דוגמה');
    expect(['debit', 'credit']).toContain(direction);
    expect(typeof amount).toBe('number');
    expect(typeof reference).toBe('string');
    // And it is the row the parser knows by heart — the pairing that lets it be refused by name.
    expect({ description, direction, amount, reference }).toEqual({
      description: BANK_IMPORT_EXAMPLE_ROW.description,
      direction: BANK_IMPORT_EXAMPLE_ROW.direction,
      amount: BANK_IMPORT_EXAMPLE_ROW.amount,
      reference: BANK_IMPORT_EXAMPLE_ROW.reference,
    });
  });

  it('refuses the file by name while the example row is still in it', () => {
    const bytes = readFileSync(resolve('public/templates/inplace-bank-import-v1.xlsx'));
    // A specimen transaction must never reach a tenant's bank ledger because somebody forgot to
    // delete a row. The refusal is what makes a worked example safe to ship.
    expect(() => parseCanonicalBankImportWorkbook(bytes, 'bank-import.xlsx'))
      .toThrow('bank_import_example_row_present');
  });

  it('imports the filled template with the guide sheet still in the workbook', () => {
    const workbook = shipped();
    // The bookkeeper's own act: type over the example row and send the file back as it came —
    // guide sheet included, because nobody deletes a tab before uploading.
    workbook.Sheets[BANK_IMPORT_SHEET_NAME] = XLSX.utils.aoa_to_sheet([
      ['INPLACE_BANK_IMPORT', BANK_IMPORT_TEMPLATE_VERSION],
      [...BANK_IMPORT_HEADERS],
      [new Date(Date.UTC(2026, 7, 21)), 'העברה לספק א', 'debit', 1250.5, 'REF-1'],
    ], { cellDates: true });
    expect(workbook.SheetNames.length).toBeGreaterThan(1);
    const filled = XLSX.write(workbook, { type: 'array', bookType: 'xlsx', cellDates: true }) as ArrayBuffer;

    const parsed = parseCanonicalBankImportWorkbook(filled, 'bank-import.xlsx');
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      tx_date: '2026-08-21', description: 'העברה לספק א', direction: 'debit', amount: 1250.5,
    });
  });
});
