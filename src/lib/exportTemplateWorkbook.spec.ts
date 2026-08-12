import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
  WorkbookRejected,
  fillTemplateWorkbook,
  isMacroEnabledName,
  parseTemplateWorkbook,
} from './exportTemplateWorkbook';

/**
 * Package K — the accountant's own workbook as the template.
 *
 * These run against real xlsx bytes rather than a mock, because every claim worth making here is a
 * claim about a file: that a macro-bearing one is refused, that a formula reaching into another
 * workbook is refused, that an unmapped placeholder stays visible instead of turning into a blank
 * cell that reads as zero, and that a supplier name beginning with `=` does not execute in the
 * accountant's Excel.
 */
function workbook(cells: Record<string, XLSX.CellObject>, sheetName = 'דוח'): ArrayBuffer {
  const sheet: XLSX.WorkSheet = { ...cells };
  const addresses = Object.keys(cells).map((a) => XLSX.utils.decode_cell(a));
  sheet['!ref'] = XLSX.utils.encode_range(
    { r: Math.min(...addresses.map((a) => a.r)), c: Math.min(...addresses.map((a) => a.c)) },
    { r: Math.max(...addresses.map((a) => a.r)), c: Math.max(...addresses.map((a) => a.c)) },
  );
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, sheetName);
  return XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

const text = (v: string): XLSX.CellObject => ({ t: 's', v });

describe('what the upload refuses', () => {
  it('refuses a macro-enabled name before it reads a byte', () => {
    for (const name of ['report.xlsm', 'REPORT.XLSB', 'template.xltm']) {
      expect(isMacroEnabledName(name)).toBe(true);
    }
    expect(isMacroEnabledName('report.xlsx')).toBe(false);

    // A template is handed back to an accountant every month under this system's name. A macro
    // travelling inside it is a supply chain, not a template.
    expect(() => parseTemplateWorkbook('report.xlsm', new ArrayBuffer(8)))
      .toThrowError(WorkbookRejected);
    try {
      parseTemplateWorkbook('report.xlsm', new ArrayBuffer(8));
    } catch (error) {
      expect((error as WorkbookRejected).reason).toBe('macro_enabled');
      expect((error as Error).message).toContain('מאקרו');
    }
  });

  it('refuses a formula that reaches into another workbook', () => {
    // Correct on the machine that made it, silently stale everywhere else — which is the worst
    // possible failure for a number an accountant files.
    const bytes = workbook({
      A1: text('סה"כ'),
      B1: { t: 'n', v: 0, f: "[Budget.xlsx]Sheet1!A1" },
    });
    try {
      parseTemplateWorkbook('report.xlsx', bytes);
      throw new Error('an external link was accepted');
    } catch (error) {
      expect((error as WorkbookRejected).reason).toBe('external_links');
    }
  });

  it('refuses bytes that are not a workbook at all', () => {
    // Measured: SheetJS parses a plain string into a one-cell book without complaint, so "it did
    // not throw" proves nothing. The signature check is what makes a renamed CSV a refusal rather
    // than a template with one mysterious cell in it.
    try {
      parseTemplateWorkbook('report.xlsx', new TextEncoder().encode('not a workbook').buffer);
      throw new Error('garbage was accepted');
    } catch (error) {
      expect((error as WorkbookRejected).reason).toBe('unreadable');
    }
  });
});

describe('what the mapping screen is given', () => {
  it('reads the sheets, their headers and every placeholder with its cell', () => {
    const bytes = workbook({
      A1: text('ספק'), B1: text('סכום'),
      A2: text('{{supplier_name}}'), B2: text('{{net_total}}'),
    });
    const parsed = parseTemplateWorkbook('report.xlsx', bytes);

    expect(parsed.sheets).toHaveLength(1);
    expect(parsed.sheets[0].name).toBe('דוח');
    expect(parsed.sheets[0].headers).toEqual(['ספק', 'סכום']);
    // The cell address, not just the key: "which cell is this going into" is the question the
    // person approving the mapping is actually asking.
    expect(parsed.placeholders).toEqual([
      { key: 'supplier_name', sheet: 'דוח', cell: 'A2' },
      { key: 'net_total', sheet: 'דוח', cell: 'B2' },
    ]);
  });

  it('reads a Hebrew placeholder key, because the accountant writes the template', () => {
    const parsed = parseTemplateWorkbook('report.xlsx', workbook({ A1: text('{{סהכ_חודשי}}') }));
    expect(parsed.placeholders[0].key).toBe('סהכ_חודשי');
  });
});

describe('filling it in', () => {
  const read = (bytes: Uint8Array, address: string) => {
    const book = XLSX.read(bytes, { type: 'array' });
    return book.Sheets[book.SheetNames[0]][address] as XLSX.CellObject | undefined;
  };

  it('puts a number in as a number, so the accountant’s own SUM keeps working', () => {
    const filled = fillTemplateWorkbook(
      workbook({ A1: text('{{net_total}}') }), { net_total: 1234.5 });
    const cell = read(filled, 'A1');
    expect(cell?.t).toBe('n');
    expect(cell?.v).toBe(1234.5);
  });

  it('leaves an unmapped placeholder visible rather than blanking it', () => {
    // A blank cell reads as zero to whoever opens the file. A visible {{key}} reads as "nobody
    // filled this in", which is the truth.
    const filled = fillTemplateWorkbook(workbook({ A1: text('{{never_mapped}}') }), {});
    expect(read(filled, 'A1')?.v).toBe('{{never_mapped}}');
  });

  it('neutralises a value that Excel would treat as a formula', () => {
    // A supplier name is not our text. `=HYPERLINK(...)` in a supplier field executes on open, in
    // an accountant's Excel, on a file we sent them.
    const filled = fillTemplateWorkbook(
      workbook({ A1: text('{{supplier_name}}') }), { supplier_name: '=HYPERLINK("http://x")' });
    expect(String(read(filled, 'A1')?.v)).toBe("'=HYPERLINK(\"http://x\")");
  });

  it('leaves everything it was not asked to change', () => {
    const filled = fillTemplateWorkbook(
      workbook({ A1: text('כותרת קבועה'), A2: text('{{net_total}}') }), { net_total: 10 });
    expect(read(filled, 'A1')?.v).toBe('כותרת קבועה');
  });

  it('keeps a value with a leading zero as text, so an account number survives', () => {
    const filled = fillTemplateWorkbook(
      workbook({ A1: text('{{account}}') }), { account: '0123456' });
    const cell = read(filled, 'A1');
    expect(cell?.t).toBe('s');
    expect(cell?.v).toBe('0123456');
  });

  it('uses the approved sheet, cell and source instead of filling by placeholder name alone', () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, { A1: text('{{total}}'), '!ref': 'A1' }, 'ראשי');
    XLSX.utils.book_append_sheet(book, { A1: text('{{total}}'), '!ref': 'A1' }, 'משני');
    const bytes = XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const filled = fillTemplateWorkbook(bytes, { gross_total: 120, net_expense: 95 }, [
      { key: 'total', sheet: 'ראשי', cell: 'A1', source: 'gross_total' },
      { key: 'total', sheet: 'משני', cell: 'A1', source: 'net_expense' },
    ]);
    const result = XLSX.read(filled, { type: 'array' });
    expect(result.Sheets['ראשי'].A1.v).toBe(120);
    expect(result.Sheets['משני'].A1.v).toBe(95);
  });

  it('refuses an approved mapping when its exact cell no longer carries the placeholder', () => {
    expect(() => fillTemplateWorkbook(
      workbook({ A1: text('{{gross_total}}') }),
      { gross_total: 120 },
      [{ key: 'gross_total', sheet: 'דוח', cell: 'B2', source: 'gross_total' }],
    )).toThrow('export_template_cell_missing');
  });
});
