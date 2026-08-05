import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { createVerificationResult, type VerificationCheck, type VerificationResult } from './types.ts';

interface ExportExpectationBase {
  id: string;
  filePath: string;
  expectedHeaders?: readonly string[];
  expectedRowSubsets?: readonly Readonly<Record<string, string | number | boolean | null>>[];
  exactRowCount?: number;
  minRowCount?: number;
}

export interface SpreadsheetExportExpectation extends ExportExpectationBase {
  kind: 'xlsx';
  sheetName?: string;
  forbidFormulas?: boolean;
  total?: { column: string; expected: number; tolerance?: number };
}

export interface CsvExportExpectation extends ExportExpectationBase {
  kind: 'csv';
  total?: { column: string; expected: number; tolerance?: number };
}

export interface PdfExportExpectation extends ExportExpectationBase {
  kind: 'pdf';
  expectedText?: readonly string[];
}

export interface JpegExportExpectation extends ExportExpectationBase {
  kind: 'jpg';
}

export type ExportExpectation =
  | SpreadsheetExportExpectation
  | CsvExportExpectation
  | PdfExportExpectation
  | JpegExportExpectation;

const MAX_EXPORT_BYTES = 50 * 1024 * 1024;

function assertInsideRoot(filePath: string, allowedRoot: string): string {
  const absolute = path.resolve(filePath);
  const root = path.resolve(allowedRoot);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Export evidence path must be a file inside the declared artifact root.');
  }
  return absolute;
}

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = '';
    } else field += character;
  }
  if (quoted) throw new Error('CSV ended inside a quoted field.');
  row.push(field.replace(/\r$/, ''));
  if (row.some((value) => value.length > 0)) rows.push(row);
  if (rows[0]?.[0]) rows[0][0] = rows[0][0].replace(/^\uFEFF/, '');
  return rows;
}

function rowCountCheck(
  expectation: ExportExpectationBase,
  rowCount: number,
): { passed: boolean; reason?: string } {
  if (expectation.exactRowCount !== undefined && rowCount !== expectation.exactRowCount) {
    return { passed: false, reason: 'exact row count' };
  }
  if (expectation.minRowCount !== undefined && rowCount < expectation.minRowCount) {
    return { passed: false, reason: 'minimum row count' };
  }
  return { passed: true };
}

function headersMatch(actual: readonly string[], expected: readonly string[] | undefined): boolean {
  if (!expected) return true;
  return expected.every((header) => actual.includes(header));
}

function numericTotal(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
  total: { column: string; expected: number; tolerance?: number } | undefined,
): { matches: boolean; actual?: number } {
  if (!total) return { matches: true };
  const index = headers.indexOf(total.column);
  if (index < 0) return { matches: false };
  const actual = rows.reduce((sum, row) => {
    const value = typeof row[index] === 'number'
      ? row[index] as number
      : Number(String(row[index] ?? '').replace(/[₪,\s]/g, ''));
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
  return { matches: Math.abs(actual - total.expected) <= (total.tolerance ?? 0.01), actual };
}

function numericCell(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : Number(String(value ?? '').replace(/[₪,\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function cellMatches(actual: unknown, expected: string | number | boolean | null): boolean {
  if (expected === null) return actual === null || actual === undefined || String(actual).trim() === '';
  if (typeof expected === 'number') {
    const parsed = numericCell(actual);
    return parsed !== null && Math.abs(parsed - expected) <= 0.01;
  }
  if (typeof expected === 'boolean') return actual === expected;
  return String(actual ?? '').trim() === expected.trim();
}

function expectedRowsMatch(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
  expectedRows: ExportExpectationBase['expectedRowSubsets'],
): { matches: boolean; matchedCount: number; expectedCount: number } {
  if (!expectedRows?.length) return { matches: true, matchedCount: 0, expectedCount: 0 };
  const headerIndexes = new Map(headers.map((header, index) => [header, index]));
  let matchedCount = 0;
  const availableRows = new Set(rows.map((_row, index) => index));
  for (const expected of expectedRows) {
    const match = [...availableRows].find((rowIndex) => Object.entries(expected).every(([header, value]) => {
      const columnIndex = headerIndexes.get(header);
      return columnIndex !== undefined && cellMatches(rows[rowIndex]?.[columnIndex], value);
    }));
    if (match === undefined) continue;
    availableRows.delete(match);
    matchedCount += 1;
  }
  return {
    matches: matchedCount === expectedRows.length,
    matchedCount,
    expectedCount: expectedRows.length,
  };
}

async function verifyXlsx(
  expectation: SpreadsheetExportExpectation,
  buffer: Buffer,
): Promise<VerificationCheck> {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: true });
  const sheetName = expectation.sheetName ?? workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    return { id: expectation.id, status: 'FAIL', summary: 'Expected workbook sheet is missing.', evidence: { sheetName } };
  }
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null });
  const headers = (rows[0] ?? []).map((value) => String(value ?? '').trim());
  const dataRows = rows.slice(1).filter((row) => row.some((value) => value !== null && value !== ''));
  const formulaCells = Object.entries(sheet)
    .filter(([address, cell]) => !address.startsWith('!') && typeof (cell as XLSX.CellObject).f === 'string')
    .map(([address]) => address);
  const rowsCheck = rowCountCheck(expectation, dataRows.length);
  const headerCheck = headersMatch(headers, expectation.expectedHeaders);
  const expectedRowsCheck = expectedRowsMatch(headers, dataRows, expectation.expectedRowSubsets);
  const totalCheck = numericTotal(headers, dataRows, expectation.total);
  const formulasAllowed = expectation.forbidFormulas === false || formulaCells.length === 0;
  const passed = rowsCheck.passed && headerCheck && expectedRowsCheck.matches
    && totalCheck.matches && formulasAllowed;
  return {
    id: expectation.id,
    status: passed ? 'PASS' : 'FAIL',
    summary: passed ? 'Workbook structure, rows, totals, and formula policy match.' : 'Workbook validation failed.',
    evidence: {
      sheetName,
      headerCount: headers.length,
      expectedHeadersPresent: headerCheck,
      rowCount: dataRows.length,
      rowCountFailure: rowsCheck.reason,
      expectedRowSubsetCount: expectedRowsCheck.expectedCount,
      matchedRowSubsetCount: expectedRowsCheck.matchedCount,
      expectedRowSubsetsPresent: expectedRowsCheck.matches,
      totalMatches: totalCheck.matches,
      actualTotal: totalCheck.actual,
      formulaCellCount: formulaCells.length,
    },
  };
}

async function verifyCsv(
  expectation: CsvExportExpectation,
  buffer: Buffer,
): Promise<VerificationCheck> {
  const rows = parseCsv(buffer.toString('utf8'));
  const headers = rows[0] ?? [];
  const dataRows = rows.slice(1);
  const rowsCheck = rowCountCheck(expectation, dataRows.length);
  const headerCheck = headersMatch(headers, expectation.expectedHeaders);
  const expectedRowsCheck = expectedRowsMatch(headers, dataRows, expectation.expectedRowSubsets);
  const totalCheck = numericTotal(headers, dataRows, expectation.total);
  const passed = rowsCheck.passed && headerCheck && expectedRowsCheck.matches && totalCheck.matches;
  return {
    id: expectation.id,
    status: passed ? 'PASS' : 'FAIL',
    summary: passed ? 'CSV structure, rows, and totals match.' : 'CSV validation failed.',
    evidence: {
      headerCount: headers.length,
      expectedHeadersPresent: headerCheck,
      rowCount: dataRows.length,
      rowCountFailure: rowsCheck.reason,
      expectedRowSubsetCount: expectedRowsCheck.expectedCount,
      matchedRowSubsetCount: expectedRowsCheck.matchedCount,
      expectedRowSubsetsPresent: expectedRowsCheck.matches,
      totalMatches: totalCheck.matches,
      actualTotal: totalCheck.actual,
    },
  };
}

async function verifyPdf(expectation: PdfExportExpectation, buffer: Buffer): Promise<VerificationCheck> {
  const text = buffer.toString('latin1');
  const structureValid = text.startsWith('%PDF-') && /%%EOF\s*$/.test(text);
  const expectedTextPresent = (expectation.expectedText ?? []).every((value) => text.includes(value));
  const passed = structureValid && expectedTextPresent;
  return {
    id: expectation.id,
    status: passed ? 'PASS' : 'FAIL',
    summary: passed ? 'PDF structure and requested plain-text markers match.' : 'PDF structure or text markers failed.',
    evidence: { structureValid, expectedTextMarkerCount: expectation.expectedText?.length ?? 0, expectedTextPresent },
  };
}

async function verifyJpeg(expectation: JpegExportExpectation, buffer: Buffer): Promise<VerificationCheck> {
  const structureValid = buffer.length >= 4
    && buffer[0] === 0xff
    && buffer[1] === 0xd8
    && buffer.at(-2) === 0xff
    && buffer.at(-1) === 0xd9;
  return {
    id: expectation.id,
    status: structureValid ? 'PASS' : 'FAIL',
    summary: structureValid ? 'JPEG has valid SOI/EOI markers.' : 'JPEG structure is invalid.',
    evidence: { structureValid },
  };
}

async function verifyOne(expectation: ExportExpectation, allowedRoot: string): Promise<VerificationCheck> {
  let filePath: string;
  try {
    filePath = assertInsideRoot(expectation.filePath, allowedRoot);
  } catch {
    return {
      id: expectation.id,
      status: 'BLOCKED',
      summary: 'Export path is outside the declared artifact root.',
      evidence: { fileName: path.basename(expectation.filePath), unsafePath: true },
    };
  }

  let buffer: Buffer;
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > MAX_EXPORT_BYTES) {
      return {
        id: expectation.id,
        status: 'FAIL',
        summary: 'Export is missing, empty, not a file, or exceeds the verifier size limit.',
        evidence: { fileName: path.basename(filePath), size: fileStat.size },
      };
    }
    buffer = await readFile(filePath);
  } catch {
    return {
      id: expectation.id,
      status: 'FAIL',
      summary: 'Expected export file could not be read.',
      evidence: { fileName: path.basename(filePath), fileReadable: false },
    };
  }

  try {
    const check = expectation.kind === 'xlsx'
      ? await verifyXlsx(expectation, buffer)
      : expectation.kind === 'csv'
        ? await verifyCsv(expectation, buffer)
        : expectation.kind === 'pdf'
          ? await verifyPdf(expectation, buffer)
          : await verifyJpeg(expectation, buffer);
    return {
      ...check,
      evidence: { ...check.evidence, fileName: path.basename(filePath), fileSize: buffer.byteLength },
    };
  } catch {
    return {
      id: expectation.id,
      status: 'FAIL',
      summary: 'Export parser rejected the downloaded file structure.',
      evidence: { fileName: path.basename(filePath), parserRejected: true, fileSize: buffer.byteLength },
    };
  }
}

export async function verifyExportFiles(
  expectations: readonly ExportExpectation[],
  allowedArtifactRoot: string,
): Promise<VerificationResult> {
  if (expectations.length === 0) {
    return createVerificationResult('export', 'No export expectations were supplied.', [{
      id: 'export-expectations-missing',
      status: 'BLOCKED',
      summary: 'Export verification requires explicit files, formats, and expected structure.',
    }]);
  }
  const checks: VerificationCheck[] = [];
  for (const expectation of expectations) checks.push(await verifyOne(expectation, allowedArtifactRoot));
  return createVerificationResult('export', 'Downloaded files were parsed inside the run artifact root.', checks, {
    artifactRoot: path.resolve(allowedArtifactRoot),
    fileCount: expectations.length,
    maxFileBytes: MAX_EXPORT_BYTES,
  });
}
