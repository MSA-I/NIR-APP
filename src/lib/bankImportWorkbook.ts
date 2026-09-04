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

/**
 * THE TEMPLATE IS HANDED TO A PERSON (`EXP-09`, 04.09.2026).
 *
 * What the Hebrew button `הורדת התבנית העדכנית` produced was two rows — a signature and five
 * English keys — with no Hebrew, no example, and nothing saying that `direction` means the literal
 * strings below. A bookkeeper cannot fill that in; they can only guess at it.
 *
 * The machine contract does not move. The data sheet keeps its name, its signature row and its
 * five headers in that order, so every template a tenant already holds still imports. What is
 * added is the second sheet a person reads and one worked example row in the place the data goes.
 *
 * AND THE EXAMPLE ROW IS REFUSED, BY NAME. An example in a financial import is a specimen
 * transaction one forgotten keystroke away from the tenant's bank ledger. `parseCanonical…` below
 * rejects the file while this exact row is still in it and says so, which is what makes shipping a
 * worked example safe at all: the row teaches the format in the cell types the parser demands, and
 * cannot be imported as money.
 */
export const BANK_IMPORT_GUIDE_SHEET_NAME = 'הנחיות למילוי' as const;

export const BANK_IMPORT_EXAMPLE_ROW = {
  transaction_date: '2026-01-15',
  description: 'שורת דוגמה — יש להחליף בנתוני התדפיס שלכם',
  direction: 'debit',
  amount: 1250.5,
  reference: 'REF-0001',
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

/**
 * The Hebrew half of the template: one row per machine key, saying what to put in it, what values
 * are accepted, and what a filled cell looks like. `scripts/generate-bank-import-assets.mjs`
 * writes the same rows into the shipped asset, and `bankImportWorkbook.spec.ts` reads that file
 * back and pins it against what is declared HERE — so the two cannot drift apart in silence.
 */
export const bankImportGuideRows = (): unknown[][] => [
  ['ייבוא תדפיס בנק — הנחיות למילוי'],
  [`יש למלא את גיליון „${BANK_IMPORT_SHEET_NAME}". אין לשנות בו את שתי השורות הראשונות.`],
  ['שורה 3 בגיליון הנתונים היא שורת דוגמה. יש להחליף אותה בנתונים שלכם או למחוק אותה — קובץ שנשלח והדוגמה עדיין בתוכו נדחה.'],
  [],
  ['עמודה בקובץ', 'מה למלא', 'ערכים מותרים ופורמט', 'דוגמה'],
  ['transaction_date', 'תאריך התנועה', 'תא בפורמט תאריך — לא טקסט', '15.01.2026'],
  ['description', 'תיאור התנועה כפי שמופיע בתדפיס', 'טקסט חופשי, שדה חובה', BANK_IMPORT_EXAMPLE_ROW.description],
  ['direction', 'כיוון התנועה', 'debit לחיוב, credit לזיכוי — באנגלית ובאותיות קטנות', BANK_IMPORT_EXAMPLE_ROW.direction],
  ['amount', 'סכום התנועה', 'מספר חיובי, עד שתי ספרות אחרי הנקודה', '1250.50'],
  ['reference', 'אסמכתה', 'טקסט, אפשר להשאיר ריק', BANK_IMPORT_EXAMPLE_ROW.reference],
  [],
  // Not a preference and not an omission: `bank_imports.currency` is one column for the whole
  // statement (0217) and every line mirrors it, so a file holding two currencies is unrepresentable
  // rather than merely discouraged. A bookkeeper should learn that here and not after importing.
  ['אין עמודת מטבע: כל תדפיס נקלט כמטבע אחד, ILS. אין לערבב מטבעות בקובץ אחד.'],
];

export function buildCanonicalBankImportTemplate() {
  const [year, month, day] = BANK_IMPORT_EXAMPLE_ROW.transaction_date.split('-').map(Number);
  const sheet = XLSX.utils.aoa_to_sheet([
    ['INPLACE_BANK_IMPORT', BANK_IMPORT_TEMPLATE_VERSION],
    [...BANK_IMPORT_HEADERS],
    [
      new Date(Date.UTC(year, month - 1, day)),
      BANK_IMPORT_EXAMPLE_ROW.description,
      BANK_IMPORT_EXAMPLE_ROW.direction,
      BANK_IMPORT_EXAMPLE_ROW.amount,
      BANK_IMPORT_EXAMPLE_ROW.reference,
    ],
  ], { cellDates: true });
  sheet['!cols'] = [{ wch: 18 }, { wch: 42 }, { wch: 12 }, { wch: 16 }, { wch: 24 }];
  const guide = XLSX.utils.aoa_to_sheet(bankImportGuideRows());
  guide['!cols'] = [{ wch: 22 }, { wch: 38 }, { wch: 46 }, { wch: 34 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, BANK_IMPORT_SHEET_NAME);
  XLSX.utils.book_append_sheet(workbook, guide, BANK_IMPORT_GUIDE_SHEET_NAME);
  workbook.Workbook = { Views: [{ RTL: true }, { RTL: true }] };
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
  // The workbook must CONTAIN the canonical sheet; it no longer has to be the only one. The
  // template ships a Hebrew guide sheet beside it (`EXP-09`) and a bookkeeper sends the file back
  // as it came, guide included. Nothing outside the canonical sheet is read — not for rows, not
  // for the formula scan below — so a second sheet widens what is accepted, never what is trusted.
  if (!workbook.SheetNames.includes(BANK_IMPORT_SHEET_NAME)) {
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

  const parsedRows: CanonicalBankImportRow[] = dataRows.map((row) => {
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
  });

  // THE EXAMPLE ROW IS NOT DATA (`EXP-09`). It ships inside the template so a bookkeeper can see
  // what a filled row looks like, in the cell types this parser demands. Left in place it would
  // file a specimen transfer against the tenant's bank account, so the whole file is refused with
  // a code that names the row rather than the file — one cell typed over and it imports.
  if (parsedRows.some((row) =>
    row.tx_date === BANK_IMPORT_EXAMPLE_ROW.transaction_date
    && row.description === BANK_IMPORT_EXAMPLE_ROW.description
    && row.direction === BANK_IMPORT_EXAMPLE_ROW.direction
    && row.amount === BANK_IMPORT_EXAMPLE_ROW.amount
    && row.reference === BANK_IMPORT_EXAMPLE_ROW.reference)) {
    fail('bank_import_example_row_present');
  }

  return {
    contract: {
      template_version: BANK_IMPORT_TEMPLATE_VERSION,
      sheet: BANK_IMPORT_SHEET_NAME,
      headers: [...BANK_IMPORT_HEADERS],
    },
    rows: parsedRows,
  };
}
