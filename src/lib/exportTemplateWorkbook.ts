import * as XLSX from 'xlsx';
import { neutralizeSpreadsheetString } from './documentExport';
import type { PlaceholderMapping } from './exportTemplates';

/**
 * Reading the accountant's own workbook, so their layout becomes the export (package K, 0123).
 *
 * The reason this exists at all: the standard export produces a correct table, and an accountant
 * receiving it still has to reshape it every month into the workbook their own practice uses. This
 * lets them hand us that workbook once. Their sheet names, their column order, their headings and
 * their formatting are the deliverable; our job is to put the right numbers in the right cells.
 *
 * WHAT IS REFUSED, and why refusing loudly beats accepting quietly:
 *
 *   * **Macro-enabled workbooks** (`.xlsm`, `.xlsb`). This file is handed back to an accountant
 *     every month under this system's name. A macro travelling inside it is a supply chain, not a
 *     template. Refused here AND in 0123, because "the form checks the extension" stops being true
 *     the first time somebody calls the RPC directly.
 *   * **External links and remote references.** A formula pointing at another workbook produces a
 *     file that is correct on the machine that made it and broken or, worse, silently stale
 *     everywhere else.
 *   * **A workbook with no readable sheet.** Nothing to map is not a template.
 *
 * WHAT SURVIVES, honestly stated. SheetJS reads and rewrites the whole file, so anything in a cell
 * we do not touch — merged ranges, column widths, sheet order, formulas between the sheet's own
 * cells — comes back out. Cell STYLING is the community build's known limit: it is read with
 * `cellStyles` and mostly preserved on round-trip, but it is the part to check against a real
 * workbook before promising it to a customer. `docs/DEBT-REGISTER.md` carries that.
 *
 * PLACEHOLDERS are `{{key}}` in any cell. The key is matched against the export's own field list on
 * the mapping screen; nothing here decides what a key means, because a template that guessed would
 * put last month's total in this month's cell and look right doing it.
 */

export interface WorkbookSheet {
  name: string;
  /** The first row, as text. What a person recognises the sheet by. */
  headers: string[];
  rows: number;
  columns: number;
}

export interface WorkbookPlaceholder {
  key: string;
  sheet: string;
  /** A1 notation, so the mapping screen can say exactly which cell. */
  cell: string;
}

export interface ParsedWorkbook {
  sheets: WorkbookSheet[];
  placeholders: WorkbookPlaceholder[];
  namedRanges: string[];
}

export type WorkbookRejection =
  | 'macro_enabled'
  | 'external_links'
  | 'unreadable'
  | 'no_sheets'
  | 'too_large';

/** Hebrew, and each one says what to do next rather than only what went wrong. */
export const WORKBOOK_REJECTION_MESSAGE: Record<WorkbookRejection, string> = {
  macro_enabled:
    'הקובץ מכיל מאקרו (‎.xlsm או ‎.xlsb). שמרו אותו מחדש כ-‎.xlsx רגיל והעלו שוב — התבנית נשלחת '
    + 'לרואה החשבון בשם המערכת, ולכן אינה יכולה לשאת קוד.',
  external_links:
    'הקובץ מפנה לחוברות חיצוניות. הפניה כזו עובדת רק במחשב שבו נוצרה, ובכל מקום אחר תיתן מספר ישן '
    + 'בלי להתריע. החליפו את ההפניות בערכים או ב-‎{{שדה}} והעלו שוב.',
  unreadable: 'לא ניתן לקרוא את הקובץ. ודאו שזו חוברת Excel תקינה ולא קובץ מוגן בסיסמה.',
  no_sheets: 'אין בחוברת אף גיליון קריא, ולכן אין מה למפות.',
  too_large: 'הקובץ גדול מ-20MB. תבנית היא שלד מעוצב, לא הדוח עצמו.',
};

export const WORKBOOK_MAX_BYTES = 20 * 1024 * 1024;

/** The two the bucket and 0123 accept. Anything else is refused before an upload is attempted. */
export const WORKBOOK_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
] as const;

const PLACEHOLDER = /\{\{\s*([\w.\-֐-׿]+)\s*\}\}/g;

/**
 * Is this actually a spreadsheet container?
 *
 * SheetJS is permissive by design and will happily parse a text file into a one-cell sheet, so
 * "it did not throw" is not evidence that somebody uploaded a workbook — measured: a plain
 * `not a workbook` string comes back as a valid book. An xlsx is a ZIP and an xls is an OLE2
 * compound file, and those two signatures are the cheap honest test.
 */
function looksLikeWorkbook(bytes: ArrayBuffer): boolean {
  const head = new Uint8Array(bytes.slice(0, 8));
  const startsWith = (...signature: number[]) =>
    signature.every((byte, index) => head[index] === byte);
  return startsWith(0x50, 0x4b, 0x03, 0x04)                          // PK.. — xlsx (zip)
    || startsWith(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);   // OLE2 — xls
}

/** `.xlsm`/`.xlsb` by name, before a single byte is parsed. */
export function isMacroEnabledName(fileName: string): boolean {
  return /\.(xlsm|xlsb|xltm)$/i.test(fileName.trim());
}

export class WorkbookRejected extends Error {
  constructor(public readonly reason: WorkbookRejection) {
    super(WORKBOOK_REJECTION_MESSAGE[reason]);
    this.name = 'WorkbookRejected';
  }
}

/**
 * Parse an uploaded workbook into the shape a person approves and 0123 stores.
 *
 * `bookVBA: false` is not decoration: it stops the VBA blob being carried into memory at all, so a
 * macro-enabled file that slipped past the extension check has nothing to carry forward.
 */
export function parseTemplateWorkbook(fileName: string, bytes: ArrayBuffer): ParsedWorkbook {
  if (isMacroEnabledName(fileName)) throw new WorkbookRejected('macro_enabled');
  if (bytes.byteLength > WORKBOOK_MAX_BYTES) throw new WorkbookRejected('too_large');
  if (!looksLikeWorkbook(bytes)) throw new WorkbookRejected('unreadable');

  let book: XLSX.WorkBook;
  try {
    book = XLSX.read(bytes, { type: 'array', cellStyles: true, bookVBA: false, cellFormula: true });
  } catch {
    throw new WorkbookRejected('unreadable');
  }
  // The VBA project survives the extension check when a file is renamed. This is the byte-level
  // answer to the same question.
  if (book.vbaraw) throw new WorkbookRejected('macro_enabled');
  if (!book.SheetNames?.length) throw new WorkbookRejected('no_sheets');

  const sheets: WorkbookSheet[] = [];
  const placeholders: WorkbookPlaceholder[] = [];

  for (const name of book.SheetNames) {
    const sheet = book.Sheets[name];
    if (!sheet || !sheet['!ref']) continue;
    const range = XLSX.utils.decode_range(sheet['!ref']);

    for (let row = range.s.r; row <= range.e.r; row += 1) {
      for (let column = range.s.c; column <= range.e.c; column += 1) {
        const address = XLSX.utils.encode_cell({ r: row, c: column });
        const cell = sheet[address] as XLSX.CellObject | undefined;
        if (!cell) continue;
        // A formula naming another workbook: `[Book1.xlsx]Sheet1!A1` or a full path in brackets.
        if (typeof cell.f === 'string' && /\[[^\]]+\]/.test(cell.f)) {
          throw new WorkbookRejected('external_links');
        }
        const text = typeof cell.v === 'string' ? cell.v : null;
        if (!text) continue;
        for (const match of text.matchAll(PLACEHOLDER)) {
          placeholders.push({ key: match[1], sheet: name, cell: address });
        }
      }
    }

    const header = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, blankrows: false })[0];
    sheets.push({
      name,
      headers: (header ?? []).map((value) => String(value ?? '').trim()).filter(Boolean),
      rows: range.e.r - range.s.r + 1,
      columns: range.e.c - range.s.c + 1,
    });
  }

  if (!sheets.length) throw new WorkbookRejected('no_sheets');

  return {
    sheets,
    placeholders,
    namedRanges: (book.Workbook?.Names ?? []).map((entry) => entry.Name).filter(Boolean),
  };
}

/**
 * Write the export's values into the template's placeholder cells and hand back the workbook.
 *
 * The original bytes go in and come out, so everything the template does that we did not touch —
 * merged cells, widths, sheet order, its own formulas — is still there. Only the placeholder cells
 * change, and every string written into one goes through the same neutraliser the standard exports
 * use: a supplier name of `=HYPERLINK(...)` is a formula to Excel no matter which of our files it
 * arrives in.
 */
export function fillTemplateWorkbook(
  bytes: ArrayBuffer,
  values: Record<string, string | number | null>,
  mapping?: PlaceholderMapping[],
): Uint8Array {
  const book = XLSX.read(bytes, { type: 'array', cellStyles: true, bookVBA: false });

  const writeFilledCell = (sheet: XLSX.WorkSheet, address: string, cell: XLSX.CellObject, filled: string) => {
    if (filled === cell.v) return;
    // A cell that is now purely one number stays a number, so the accountant's own formatting
    // and any SUM over it keep working.
    const asNumber = Number(filled);
    if (filled.trim() !== '' && Number.isFinite(asNumber) && !/^0\d/.test(filled.trim())) {
      sheet[address] = { t: 'n', v: asNumber, z: cell.z, s: cell.s } as XLSX.CellObject;
    } else {
      sheet[address] = {
        t: 's',
        v: neutralizeSpreadsheetString(filled) as string,
        z: cell.z,
        s: cell.s,
      } as XLSX.CellObject;
    }
  };

  if (mapping) {
    // The approved mapping names the exact sheet and cell. A key-only scan would ignore `source`
    // and would fill two identical-looking placeholders with the same value even when a person
    // explicitly mapped them differently. Sheet+cell is the frozen agreement in 0123/0126.
    for (const row of mapping) {
      if (!row.source) continue;
      const sheet = book.Sheets[row.sheet];
      const cell = sheet?.[row.cell] as XLSX.CellObject | undefined;
      if (!sheet || !cell || typeof cell.v !== 'string') {
        throw new Error(`export_template_cell_missing:${row.sheet}:${row.cell}`);
      }
      const escapedKey = row.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const exactPlaceholder = new RegExp(`\\{\\{\\s*${escapedKey}\\s*\\}\\}`, 'g');
      if (!exactPlaceholder.test(cell.v)) {
        throw new Error(`export_template_placeholder_mismatch:${row.sheet}:${row.cell}`);
      }
      exactPlaceholder.lastIndex = 0;
      const value = values[row.source];
      // Source keys are validated before download. A null is still a deliberate "no measured
      // value" and therefore leaves the placeholder visible instead of inventing zero.
      if (value === undefined || value === null) continue;
      writeFilledCell(sheet, row.cell, cell, cell.v.replace(exactPlaceholder, String(value)));
    }

    return XLSX.write(book, { type: 'array', bookType: 'xlsx', cellStyles: true }) as Uint8Array;
  }

  for (const name of book.SheetNames) {
    const sheet = book.Sheets[name];
    if (!sheet?.['!ref']) continue;
    const range = XLSX.utils.decode_range(sheet['!ref']);
    for (let row = range.s.r; row <= range.e.r; row += 1) {
      for (let column = range.s.c; column <= range.e.c; column += 1) {
        const address = XLSX.utils.encode_cell({ r: row, c: column });
        const cell = sheet[address] as XLSX.CellObject | undefined;
        if (!cell || typeof cell.v !== 'string') continue;
        const filled = cell.v.replace(PLACEHOLDER, (whole, key: string) => {
          const value = values[key];
          // An unmapped placeholder is left exactly as it was, visibly. Replacing it with an empty
          // string would hand an accountant a blank cell that looks like a zero.
          return value === undefined || value === null ? whole : String(value);
        });
        writeFilledCell(sheet, address, cell, filled);
      }
    }
  }

  return XLSX.write(book, { type: 'array', bookType: 'xlsx', cellStyles: true }) as Uint8Array;
}
