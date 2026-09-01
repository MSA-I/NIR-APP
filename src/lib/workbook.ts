import { neutralizeSpreadsheetString } from './documentExport';

/**
 * The one styled .xlsx writer in the product.
 *
 * ─── WHY A SECOND SPREADSHEET LIBRARY EXISTS HERE ────────────────────────────────────────────
 * SheetJS CE — the `xlsx` package the rest of the repo reads and writes with — DISCARDS cell
 * fills and fonts on write. That is measured, not assumed: DEBT-REGISTER §37 records a cell
 * carrying `{ fill: { patternType: 'solid', fgColor: { rgb: '1F4E5F' } } }` surviving
 * `XLSX.write(…, { cellStyles: true })` → `XLSX.read` as `{"patternType":"none"}`, silently and
 * without an error. §37 named the two ways out and both were owner decisions: buy SheetJS Pro, or
 * change writer. The owner chose to change writer (28.08.2026).
 *
 * ExcelJS is that writer. It is MIT, and its last release is 4.4.0 from October 2023 — stated
 * plainly rather than discovered later. A workbook writer is the one kind of dependency where a
 * quiet upstream is close to harmless: the .xlsx container is a frozen ISO format, and this module
 * uses only its oldest, most exercised surface (worksheet views, column widths, number formats,
 * fills and fonts). Its transitive `uuid@8` carries a moderate advisory for `v3/v5/v6` called with
 * an explicit `buf`; ExcelJS calls `v4` without one, and `npm audit --audit-level=high` — the CI
 * gate — passes. The newer alternatives measured on the same day were `xlsx-js-style` (last
 * published 2022) and `@office-kit/xlsx` (fresh, but 0.9.0 — a pre-1.0 package is the wrong risk
 * to put under an accountant's financial exports).
 *
 * SheetJS is NOT removed. It still reads every uploaded workbook and round-trips the tenant's own
 * approved export template, where preserving what the tenant's file already contains is the whole
 * job. Reading was never the broken half.
 *
 * ─── AND EVERY SHEET IS RTL ──────────────────────────────────────────────────────────────────
 * `rightToLeft: true` is set HERE, on every worksheet this module creates, and not left to the
 * caller. Twice now a Hebrew workbook has reached an accountant reading left-to-right because one
 * builder never got the line: first the locked snapshot (§37), then the expenses and product
 * purchase fallbacks. A caller that cannot forget it cannot repeat that.
 */

const MONEY_FORMAT = '#,##0.00';
const PERCENT_FORMAT = '0.0%';
const DATE_FORMAT = 'dd/mm/yyyy';

/** Row 1 title, row 2 subtitle, row 3 blank — the header row is therefore row 4. */
const HEADER_ROW = 4;

export type WorkbookCellType = 'text' | 'number' | 'money' | 'percent' | 'date';

export interface WorkbookColumn {
  header: string;
  key: string;
  /** Character width, the unit Excel itself uses for a column. */
  width: number;
  type?: WorkbookCellType;
}

/** A grid: one header row, then one row per record. Most sheets are this. */
export interface WorkbookTableSheet {
  name: string;
  columns: WorkbookColumn[];
  rows: Record<string, unknown>[];
  /**
   * The money number format for THIS sheet, when the default two decimal places is a claim about
   * the currency rather than a fact about it (0217/#294): JPY has none, KWD has three. Callers
   * that split a workbook one sheet per currency set it once here instead of per cell.
   */
  moneyFormat?: string;
}

/**
 * A free-form sheet, for the key/value summary blocks a report opens with. Those are not a table —
 * they are several small sections, and forcing them into `columns`+`rows` would invent a header
 * for a block that has none.
 */
export interface WorkbookMatrixRow {
  cells: readonly unknown[];
  /** This row's money format, for a summary block whose rows each name their own currency. */
  moneyFormat?: string;
  /** Paint this row like a column header — used for the small section headings inside a summary. */
  header?: boolean;
  /** Per-cell type, positionally. Absent entries fall back to `text`. */
  types?: readonly (WorkbookCellType | undefined)[];
}

export interface WorkbookMatrixSheet {
  name: string;
  widths: number[];
  matrix: readonly WorkbookMatrixRow[];
  /** Sheet-wide money format; a row may still override it with its own. */
  moneyFormat?: string;
}

export type WorkbookSheet = WorkbookTableSheet | WorkbookMatrixSheet;

const isTable = (sheet: WorkbookSheet): sheet is WorkbookTableSheet => 'columns' in sheet;

export interface WorkbookSpec {
  title: string;
  subtitle?: string;
  sheets: WorkbookSheet[];
}

/**
 * Excel refuses a sheet name over 31 characters or containing any of the six characters below,
 * and refuses the whole FILE rather than the sheet. Hebrew names are the point of the product, so
 * the rule is enforced here instead of asking every caller to count characters.
 */
export function sheetName(name: string): string {
  const cleaned = name.replace(/[[\]*?/\\:]/g, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned.length > 31 ? cleaned.slice(0, 31).trim() : cleaned) || 'גיליון';
}

/**
 * A design token as the ARGB string ExcelJS wants.
 *
 * The palette is oklch and lives only in `src/index.css`; `check:tokens` forbids a hex literal in
 * product source, and it is right to — a second spelling of a brand colour is a repaint waiting to
 * go half-done. Painting the token into a 1×1 canvas and reading the bytes back is the same route
 * `src/lib/loginAurora.ts` takes, and it is the only conversion guaranteed to agree with what CSS
 * itself renders.
 *
 * Returns null off-DOM (unit tests, a worker) or when a token is absent. A null palette means this
 * module writes an UNCOLOURED workbook — structure, widths, formats and RTL all intact — rather
 * than inventing a colour, because a fabricated brand colour is worse than none.
 */
function readPalette(tokens: readonly string[]): Record<string, string> | null {
  if (typeof document === 'undefined') return null;
  const probe = document.createElement('canvas').getContext('2d');
  if (probe === null) return null;
  const css = getComputedStyle(document.documentElement);
  const palette: Record<string, string> = {};
  for (const token of tokens) {
    const value = css.getPropertyValue(token).trim();
    if (value === '') return null;
    probe.fillStyle = value;
    probe.fillRect(0, 0, 1, 1);
    const [red, green, blue] = probe.getImageData(0, 0, 1, 1).data;
    palette[token] = `FF${[red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
  }
  return palette;
}

/**
 * #309 — the workbook is a DOCUMENT, so it reads the document tokens and not the screens'.
 *
 * The header row was oceanic because that is the app's action colour, which is the wrong claim on
 * paper: a spreadsheet head is not an action, it is the top of a table, and the document family it
 * belongs to is onyx. The four names below are the same four roles as before; only the family they
 * resolve against moved. `--color-doc-*` aliases the app tokens where a value already existed, so
 * this is a rename at the point of use rather than a second palette.
 */
const HEADER_FILL = '--color-doc-plate';
const HEADER_INK = '--color-doc-ink';
const TITLE_INK = '--color-doc-plate';
const RULE = '--color-doc-line';
/** Every other data row, so a wide grid keeps the reader on one line across eleven columns. */
const BAND = '--color-doc-paper-sink';

/**
 * A cell value in the type Excel should hold it as.
 *
 * A date written as `'2026-08-28'` is TEXT to Excel: it will not sort chronologically, will not
 * follow the reader's locale, and cannot be the argument of a date function. The accountant this
 * file is built for does all three. An unparseable date stays the original string rather than
 * becoming an Invalid Date, and `null` stays null — an empty cell is an absence, and CLAUDE.md
 * forbids the fake `0` that would otherwise fill it.
 */
/**
 * A date the way a spreadsheet holds one — and the off-by-one this avoids is real money.
 *
 * AN .xlsx DATE HAS NO TIMEZONE. The file stores a naive serial number, and ExcelJS derives that
 * serial from the JS Date's UTC fields. So handing it the instant is wrong twice over:
 *
 *   * A database date column arrives as `'2026-08-01'`. Parsed and written straight through, the
 *     cell lands on 31 July 21:00 for a business at UTC+3 — MEASURED, not feared: the raw serial
 *     came out `46234.875`. A Hebrew accountant reconciling August would find its first invoice
 *     filed under July.
 *   * A timestamp like `created_at` would be stored as its UTC reading, three hours off the time
 *     every screen in the product shows for the same event.
 *
 * One rule fixes both: write the naive value that equals the LOCAL wall clock. A date-only string
 * becomes exactly midnight of that calendar day; a timestamp becomes the moment as the reader
 * already saw it.
 */
function toSpreadsheetDate(raw: unknown): Date | null {
  const dateOnly = raw instanceof Date ? null : /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw));
  const local = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : raw instanceof Date ? raw : new Date(String(raw));
  if (Number.isNaN(local.getTime())) return null;
  return new Date(local.getTime() - local.getTimezoneOffset() * 60_000);
}

function cellValue(raw: unknown, type: WorkbookCellType): string | number | Date | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (type === 'date') {
    const parsed = toSpreadsheetDate(raw);
    return parsed ?? String(neutralizeSpreadsheetString(String(raw)));
  }
  if (type === 'number' || type === 'money' || type === 'percent') {
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  // Tenant text on its way into a file somebody opens in Excel: a leading `=` or `@` is a formula
  // there whatever we meant by it. Same neutralizer as documentExport.ts, which owns the rule.
  return String(neutralizeSpreadsheetString(String(raw)));
}

const NUMBER_FORMAT: Partial<Record<WorkbookCellType, string>> = {
  money: MONEY_FORMAT,
  percent: PERCENT_FORMAT,
  date: DATE_FORMAT,
};

export async function buildWorkbook(spec: WorkbookSpec): Promise<Uint8Array> {
  const { Workbook } = await import('exceljs');
  const book = new Workbook();
  const palette = readPalette([HEADER_FILL, HEADER_INK, TITLE_INK, RULE, BAND]);

  const paintHeader = (cell: { alignment?: unknown; font?: unknown; fill?: unknown }) => {
    cell.alignment = { horizontal: 'right', vertical: 'middle', wrapText: true };
    if (!palette) return;
    cell.font = { bold: true, color: { argb: palette[HEADER_INK] } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: palette[HEADER_FILL] } };
  };

  for (const sheet of spec.sheets) {
    const widths = isTable(sheet) ? sheet.columns.map((column) => column.width) : sheet.widths;
    const worksheet = book.addWorksheet(sheetName(sheet.name), {
      // `ySplit` freezes everything above the first data row, so an eleven-column invoice grid
      // keeps its headings while the accountant scrolls a 400-row month. A summary sheet has no
      // repeating header to hold, so it freezes only its title block.
      views: [{ rightToLeft: true, state: 'frozen', ySplit: isTable(sheet) ? HEADER_ROW : 2 }],
    });
    worksheet.columns = widths.map((width) => ({ width }));

    const lastColumn = Math.max(widths.length, 1);
    const title = worksheet.getRow(1);
    title.getCell(1).value = spec.title;
    title.font = { bold: true, size: 14, ...(palette ? { color: { argb: palette[TITLE_INK] } } : {}) };
    worksheet.mergeCells(1, 1, 1, lastColumn);
    if (spec.subtitle) {
      const subtitle = worksheet.getRow(2);
      subtitle.getCell(1).value = spec.subtitle;
      subtitle.font = { size: 10, ...(palette ? { color: { argb: palette[TITLE_INK] } } : {}) };
      worksheet.mergeCells(2, 1, 2, lastColumn);
    }

    if (!isTable(sheet)) {
      sheet.matrix.forEach((row, rowIndex) => {
        const target = worksheet.getRow(HEADER_ROW + rowIndex);
        row.cells.forEach((raw, columnIndex) => {
          const cell = target.getCell(columnIndex + 1);
          const type = row.types?.[columnIndex] ?? 'text';
          cell.value = cellValue(raw, type);
          const format = type === 'money'
            ? row.moneyFormat ?? sheet.moneyFormat ?? MONEY_FORMAT
            : NUMBER_FORMAT[type];
          if (format) cell.numFmt = format;
          if (row.header) paintHeader(cell);
        });
      });
      continue;
    }

    const header = worksheet.getRow(HEADER_ROW);
    sheet.columns.forEach((column, index) => {
      const cell = header.getCell(index + 1);
      cell.value = column.header;
      paintHeader(cell);
    });
    header.height = 22;

    sheet.rows.forEach((row, rowIndex) => {
      const target = worksheet.getRow(HEADER_ROW + 1 + rowIndex);
      sheet.columns.forEach((column, columnIndex) => {
        const type = column.type ?? 'text';
        const cell = target.getCell(columnIndex + 1);
        cell.value = cellValue(row[column.key], type);
        const format = type === 'money' ? sheet.moneyFormat ?? MONEY_FORMAT : NUMBER_FORMAT[type];
        if (format) cell.numFmt = format;
        if (palette) {
          cell.border = { bottom: { style: 'hair', color: { argb: palette[RULE] } } };
          // Banding, not a status: it says "same row", never "look here". Every other row, so a
          // reader tracking a figure across eleven columns does not change lines by accident.
          if (rowIndex % 2 === 1) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: palette[BAND] } };
          }
        }
      });
    });

    if (sheet.rows.length > 0) {
      worksheet.autoFilter = {
        from: { row: HEADER_ROW, column: 1 },
        to: { row: HEADER_ROW + sheet.rows.length, column: lastColumn },
      };
    }
  }

  return new Uint8Array(await book.xlsx.writeBuffer());
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Strip what a filesystem objects to. Hebrew survives — a Hebrew report name is the point. */
export function safeFileName(name: string, fallback: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '').trim() || fallback;
}

/**
 * Hand a generated file to the browser.
 *
 * The anchor is APPENDED before it is clicked and the object URL is revoked on a later task, and
 * both halves are load-bearing: a detached anchor is a no-op in Firefox, and revoking in the same
 * turn as the click can cancel a download that has not started reading yet. The previous copy of
 * this code in reportTemplateExport.ts did neither.
 */
export function downloadBytes(bytes: Uint8Array, fileName: string, mimeType: string): void {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([buffer], { type: mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function downloadWorkbook(spec: WorkbookSpec, fileName: string): Promise<void> {
  const bytes = await buildWorkbook(spec);
  downloadBytes(bytes, safeFileName(fileName, 'inplace-export.xlsx'), XLSX_MIME);
}
