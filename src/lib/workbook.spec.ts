import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { buildWorkbook, safeFileName, sheetName } from './workbook';

/**
 * Read back what the writer actually produced.
 *
 * An assertion against the in-memory ExcelJS object proves only that we set a property.
 * `rightToLeft="1"` inside `xl/worksheets/sheetN.xml` is what an accountant's Excel reads, and it
 * is the thing that was missing twice. SheetJS is the reader here on purpose — a second library
 * checking the first one's bytes is a stronger statement than ExcelJS agreeing with itself.
 */
function worksheetXml(bytes: Uint8Array): string[] {
  const reopened = XLSX.read(bytes, { type: 'array', bookFiles: true }) as XLSX.WorkBook & {
    files?: Record<string, { content: Uint8Array }>;
  };
  return Object.entries(reopened.files ?? {})
    .filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .map(([, file]) => Buffer.from(file.content).toString('utf8'));
}

/**
 * The naive instant an Excel serial names. Day 1 is 1900-01-01 and the 1900 leap-year bug makes
 * 1899-12-30 the practical epoch — the same arithmetic every spreadsheet reader performs.
 */
const naiveDate = (serial: number) =>
  new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86_400_000)).toISOString();

const SPEC = {
  title: 'ריכוז הוצאות — עסק לדוגמה',
  subtitle: '01/08/2026 – 31/08/2026',
  sheets: [
    {
      name: 'לפי ספק',
      columns: [
        { header: 'ספק', key: 'supplier', width: 30 },
        { header: 'תאריך', key: 'date', width: 14, type: 'date' as const },
        { header: 'סה״כ', key: 'total', width: 16, type: 'money' as const },
        { header: '% מהסך', key: 'share', width: 12, type: 'percent' as const },
      ],
      rows: [
        { supplier: 'אחים כהן', date: '2026-08-12', total: 1234.5, share: 0.42 },
        { supplier: '=HYPERLINK("http://x","click")', date: null, total: null, share: null },
      ],
    },
  ],
};

describe('styled workbook writer', () => {
  it('writes every sheet right-to-left', async () => {
    const sheets = worksheetXml(await buildWorkbook(SPEC));
    expect(sheets).toHaveLength(1);
    for (const xml of sheets) expect(xml).toContain('rightToLeft="1"');
  });

  it('carries column widths and the money, percent and date number formats', async () => {
    const bytes = await buildWorkbook(SPEC);
    // Widths are asserted on the sheet XML rather than through SheetJS's `!cols`: the reader
    // normalises what it finds, and the claim here is about the bytes the accountant receives.
    const [xml] = worksheetXml(bytes);
    expect(xml).toMatch(/<col\b[^>]*\bwidth="3[0-9](\.\d+)?"/);
    const book = XLSX.read(bytes, { type: 'array', cellNF: true, cellDates: true });
    const sheet = book.Sheets['לפי ספק'];
    // Header row 4, so the first data row is 5.
    expect(sheet.C5.z).toBe('#,##0.00');
    expect(sheet.D5.z).toBe('0.0%');
    // A date must arrive as a DATE cell, not the string it was read from the database as: a text
    // date does not sort chronologically and cannot feed an Excel date function.
    expect(sheet.B5.t).toBe('d');
  });

  /**
   * The off-by-one that would file the first invoice of a month under the previous one.
   *
   * Asserted on the SERIAL the file stores, not on a Date some reader reconstructed: an .xlsx date
   * is naive, and both this writer and every reader apply a timezone of their own on the way in and
   * out. The serial is the only value that is actually in the file. Before the fix this cell held
   * `46234.875` — 31 July, 21:00 — for a date the database called 1 August.
   */
  it('keeps the calendar day a date-only value named', async () => {
    const book = XLSX.read(await buildWorkbook(SPEC), { type: 'array' });
    expect(naiveDate(book.Sheets['לפי ספק'].B5.v as number)).toBe('2026-08-12T00:00:00.000Z');
  });

  it('neutralizes a tenant string that Excel would treat as a formula', async () => {
    const bytes = await buildWorkbook(SPEC);
    const book = XLSX.read(bytes, { type: 'array' });
    expect(String(book.Sheets['לפי ספק'].A6.v)).toMatch(/^'?=HYPERLINK/);
    expect(book.Sheets['לפי ספק'].A6.f).toBeUndefined();
  });

  it('leaves an absent number empty rather than writing a fake zero', async () => {
    const bytes = await buildWorkbook(SPEC);
    const book = XLSX.read(bytes, { type: 'array' });
    expect(book.Sheets['לפי ספק'].C6).toBeUndefined();
  });

  it('keeps a sheet name inside the limits Excel refuses the whole file over', () => {
    expect(sheetName('חריגים פתוחים כרגע')).toBe('חריגים פתוחים כרגע');
    expect(sheetName('a'.repeat(40))).toHaveLength(31);
    expect(sheetName('לפי/ספק:2026')).toBe('לפי ספק 2026');
    expect(sheetName('***')).toBe('גיליון');
  });

  it('strips only what a filesystem objects to, and keeps Hebrew', () => {
    expect(safeFileName('דוח: אוגוסט/2026.xlsx', 'x')).toBe('דוח אוגוסט2026.xlsx');
    expect(safeFileName('///', 'inplace-export.xlsx')).toBe('inplace-export.xlsx');
  });
});

/**
 * THE GUARD, and the reason this file is worth more than its assertions.
 *
 * Right-to-left has now been forgotten twice, in a different builder each time, and both times it
 * reached an accountant before anyone noticed — a workbook that opens left-to-right is not an
 * error, it is a file that reads wrong. Neither round was caught by a test, because the test that
 * would have caught it was written against the builder that already had the line.
 *
 * So the rule is enforced over the SOURCE instead: a file that creates a workbook must be a file
 * that turns RTL on. `src/lib/workbook.ts` does it unconditionally for every sheet it makes;
 * anything else that reaches for a writer has to say so in its own body.
 */
describe('no workbook is built without a right-to-left view', () => {
  // `process.cwd()`, the idiom productDisplayName.spec.ts and noteProse.spec.ts already use for
  // the same job. Deriving the root from `import.meta.url` does not survive the test transform,
  // and on this Windows checkout the repository path is Hebrew with spaces.
  const SRC = join(process.cwd(), 'src');

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.tsx?$/.test(entry.name) && !/\.spec\.tsx?$/.test(entry.name) ? [path] : [];
    });
  }

  it('every workbook creator sets RTL in its own body', () => {
    const offenders = sourceFiles(SRC)
      .map((path) => ({ path, text: readFileSync(path, 'utf8') }))
      .filter(({ text }) => /XLSX\.utils\.book_new\(\)|new Workbook\(\)|addWorksheet\(/.test(text))
      .filter(({ text }) => !/RTL:\s*true|rightToLeft:\s*true/.test(text))
      .map(({ path }) => path.slice(SRC.length));
    expect(offenders).toEqual([]);
  });
});
