import * as XLSX from 'xlsx';

export const BANK_IMPORT_TEMPLATE_VERSION = '1' as const;
export const BANK_IMPORT_SHEET_NAME = 'Bank Transactions' as const;
export const BANK_IMPORT_HEADERS = [
  'transaction_date',
  'description',
  'direction',
  'amount',
  'reference',
] as const;

export const BANK_IMPORT_CONTRACT = {
  template_version: BANK_IMPORT_TEMPLATE_VERSION,
  sheet: BANK_IMPORT_SHEET_NAME,
  headers: [...BANK_IMPORT_HEADERS],
} as const;

export interface CanonicalBankImportRow {
  tx_date: string;
  description: string;
  direction: 'debit' | 'credit';
  is_debit: boolean;
  amount: number;
  reference: string | null;
  raw: {
    transaction_date: string;
    description: string;
    direction: 'debit' | 'credit';
    amount: number;
    reference: string | null;
  };
}

export interface CanonicalBankImport {
  contract: {
    template_version: typeof BANK_IMPORT_TEMPLATE_VERSION;
    sheet: typeof BANK_IMPORT_SHEET_NAME;
    headers: string[];
  };
  rows: CanonicalBankImportRow[];
}

const fail = (code: string): never => { throw new Error(code); };

function bytesOf(input: ArrayBuffer | Uint8Array) {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function isXlsxZip(bytes: Uint8Array) {
  return bytes.length >= 4
    && bytes[0] === 0x50
    && bytes[1] === 0x4b
    && bytes[2] === 0x03
    && bytes[3] === 0x04;
}

function isoDate(value: Date) {
  if (Number.isNaN(value.getTime())) fail('bank_import_cell_type_invalid');
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formulaLike(value: unknown) {
  return typeof value === 'string' && /^[=+\-@]/.test(value.trimStart());
}

export function buildCanonicalBankImportTemplate() {
  const sheet = XLSX.utils.aoa_to_sheet([
    ['INPLACE_BANK_IMPORT', BANK_IMPORT_TEMPLATE_VERSION],
    [...BANK_IMPORT_HEADERS],
  ], { cellDates: true });
  sheet['!cols'] = [{ wch: 18 }, { wch: 42 }, { wch: 12 }, { wch: 16 }, { wch: 24 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, BANK_IMPORT_SHEET_NAME);
  workbook.Workbook = { Views: [{ RTL: true }] };
  return XLSX.write(workbook, {
    type: 'array',
    bookType: 'xlsx',
    cellDates: true,
  }) as ArrayBuffer;
}

export function parseCanonicalBankImportWorkbook(
  input: ArrayBuffer | Uint8Array,
  filename: string,
): CanonicalBankImport {
  const bytes = bytesOf(input);
  if (!filename.toLowerCase().endsWith('.xlsx') || !isXlsxZip(bytes)) {
    fail('bank_import_xlsx_required');
  }

  const workbook = (() => {
    try {
      return XLSX.read(bytes, { type: 'array', cellDates: true, raw: true });
    } catch {
      return fail('bank_import_workbook_invalid');
    }
  })();
  if (workbook.SheetNames.length !== 1 || workbook.SheetNames[0] !== BANK_IMPORT_SHEET_NAME) {
    fail('bank_import_sheet_invalid');
  }
  const sheet = workbook.Sheets[BANK_IMPORT_SHEET_NAME];
  if (!sheet) fail('bank_import_sheet_invalid');

  const range = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : null;
  if (range) {
    // Bound iteration before walking cells. An XLSX can declare a giant sparse `!ref` while
    // containing only a handful of cells; scanning that declared rectangle before validating its
    // shape turns a rejected workbook into a browser freeze. Two signature rows + 5,000 data rows
    // and exactly the four canonical columns are the whole contract.
    if (range.s.r !== 0 || range.e.r > 5_001) fail('bank_import_row_limit');
    if (range.s.c !== 0 || range.e.c >= BANK_IMPORT_HEADERS.length) fail('bank_import_headers_invalid');
    for (let row = range.s.r; row <= range.e.r; row += 1) {
      for (let column = range.s.c; column <= range.e.c; column += 1) {
        const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
        if (cell?.f || formulaLike(cell?.v)) fail('bank_import_formula_forbidden');
      }
    }
  }

  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    blankrows: false,
    defval: null,
  });
  if (rows[0]?.[0] !== 'INPLACE_BANK_IMPORT'
      || String(rows[0]?.[1] ?? '') !== BANK_IMPORT_TEMPLATE_VERSION) {
    fail('bank_import_version_unsupported');
  }
  const headers = (rows[1] ?? []).slice(0, BANK_IMPORT_HEADERS.length);
  if (rows[1]?.length !== BANK_IMPORT_HEADERS.length
      || headers.some((header, index) => header !== BANK_IMPORT_HEADERS[index])) {
    fail('bank_import_headers_invalid');
  }

  const dataRows = rows.slice(2).filter((row) => row.some((value) => value !== null && value !== ''));
  if (dataRows.length > 5_000) fail('bank_import_row_limit');

  return {
    contract: {
      template_version: BANK_IMPORT_TEMPLATE_VERSION,
      sheet: BANK_IMPORT_SHEET_NAME,
      headers: [...BANK_IMPORT_HEADERS],
    },
    rows: dataRows.map((row) => {
      const [dateCell, descriptionCell, directionCell, amountCell, referenceCell] = row;
      if (!(dateCell instanceof Date)
          || typeof descriptionCell !== 'string'
          || typeof directionCell !== 'string'
          || typeof amountCell !== 'number'
          || (referenceCell !== null && typeof referenceCell !== 'string')) {
        fail('bank_import_cell_type_invalid');
      }
      const dateValue = dateCell as Date;
      const descriptionValue = descriptionCell as string;
      const directionValue = (directionCell as string).trim().toLowerCase();
      const amountValue = amountCell as number;
      const referenceValue = referenceCell as string | null;
      const txDate = isoDate(dateValue);
      const description = descriptionValue.trim();
      const reference = referenceValue?.trim() || null;
      if (!description || !['debit', 'credit'].includes(directionValue)
          || !Number.isFinite(amountValue) || amountValue <= 0) {
        fail('bank_import_row_invalid');
      }
      const amount = Math.round(amountValue * 100) / 100;
      return {
        tx_date: txDate,
        description,
        direction: directionValue as 'debit' | 'credit',
        is_debit: directionValue === 'debit',
        amount,
        reference,
        raw: {
          transaction_date: txDate,
          description,
          direction: directionValue as 'debit' | 'credit',
          amount,
          reference,
        },
      };
    }),
  };
}
