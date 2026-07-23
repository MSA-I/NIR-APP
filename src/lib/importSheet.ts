// Shared Excel/CSV ingestion for the price-list importer and the onboarding wizard.
// Extracted from PriceLists.tsx so both callers parse, match columns and report
// skipped rows the same way. Everything here treats the file as untrusted input.

import Papa from 'papaparse';
import * as XLSX from 'xlsx';

export type SheetRow = Record<string, unknown>;

export interface SheetData {
  fileName: string;
  headers: string[];
  rows: SheetRow[];
}

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ROWS = 5000;
const MAX_TEXT = 200;

/** Thrown for problems the user can act on; the message is Hebrew and displayable as-is. */
export class SheetError extends Error {}

const isBlank = (row: SheetRow) => !row || Object.values(row).every((v) => String(v ?? '').trim() === '');

/** Reads the first sheet of an .xlsx/.xls file, or a UTF-8 CSV, into plain rows keyed by header. */
export async function readSheet(file: File): Promise<SheetData> {
  if (file.size === 0) throw new SheetError('הקובץ ריק');
  if (file.size > MAX_FILE_BYTES) {
    throw new SheetError(`הקובץ גדול מ־${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB ולא ניתן לייבוא`);
  }
  if (!/\.(csv|xlsx|xls)$/i.test(file.name)) {
    throw new SheetError('סוג הקובץ אינו נתמך. ניתן להעלות Excel (xlsx/xls) או CSV בקידוד UTF-8.');
  }
  const buf = await file.arrayBuffer();

  let rows: SheetRow[];
  try {
    if (/\.csv$/i.test(file.name)) {
      // A BOM is optional. Fatal decoding distinguishes a damaged/non-UTF-8 Hebrew file from
      // a valid CSV whose first header simply has no BOM marker.
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^\uFEFF/, '');
      } catch {
        throw new SheetError('קידוד ה־CSV אינו UTF-8. שמור את הקובץ כ־CSV UTF-8 ונסה שוב.');
      }
      const parsed = Papa.parse<SheetRow>(text, { header: true, skipEmptyLines: true });
      // Field-count mismatches are row-level input defects and remain available to the caller's
      // partial-acceptance report. Broken quoting/delimiter detection makes the whole file unsafe.
      const structuralError = parsed.errors.find((error) => error.type !== 'FieldMismatch');
      if (structuralError) {
        const firstRow = structuralError.row;
        throw new SheetError(`מבנה ה־CSV אינו תקין${firstRow == null ? '' : ` ליד שורה ${firstRow + 2}`}. בדוק מפרידים ומרכאות.`);
      }
      rows = parsed.data;
    } else {
      const wb = XLSX.read(buf);
      const first = wb.SheetNames[0];
      if (!first) throw new SheetError('לא נמצא גיליון בקובץ');
      rows = XLSX.utils.sheet_to_json<SheetRow>(wb.Sheets[first]);
    }
  } catch (e) {
    if (e instanceof SheetError) throw e;
    throw new SheetError('לא ניתן לקרוא את הקובץ. נתמכים קבצי Excel (xlsx/xls) ו־CSV בקידוד UTF-8.');
  }

  rows = rows.filter((r) => !isBlank(r));
  // also the landing spot for a corrupt file: xlsx parses arbitrary bytes into an empty sheet
  if (!rows.length) {
    throw new SheetError('לא נמצאו שורות נתונים בקובץ. ודא שזהו קובץ Excel או CSV תקין, עם שורת כותרות ולפחות שורת נתונים אחת.');
  }
  if (rows.length > MAX_ROWS) {
    throw new SheetError(`הקובץ מכיל ${rows.length} שורות. המגבלה היא ${MAX_ROWS} שורות בייבוא אחד — יש לפצל אותו.`);
  }

  // a cell that is empty in the first row is omitted by sheet_to_json, so union across rows
  const headers: string[] = [];
  for (const row of rows) for (const key of Object.keys(row)) if (!headers.includes(key)) headers.push(key);
  if (!headers.length) throw new SheetError('לא נמצאו כותרות עמודות בקובץ');

  return { fileName: file.name, headers, rows };
}

/** Browser-native SHA-256 used as the retry/idempotency key for an uploaded file. */
export async function sha256File(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/* ---------- column matching ---------- */

const normHeader = (s: string) => s.replace(/["'״׳.:_-]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Resolves one of `aliases` to an actual header. Exact (normalized) matches always win;
 * `fuzzy` additionally allows a header that merely contains an alias.
 */
export function matchColumn(headers: string[], aliases: readonly string[], fuzzy = true): string {
  const normed = headers.map((h) => [h, normHeader(h)] as const);
  for (const alias of aliases) {
    const hit = normed.find(([, h]) => h === normHeader(alias));
    if (hit) return hit[0];
  }
  if (!fuzzy) return '';
  for (const alias of aliases) {
    const na = normHeader(alias);
    const hit = normed.find(([, h]) => h.includes(na));
    if (hit) return hit[0];
  }
  return '';
}

export interface FieldSpec {
  key: string;
  label: string;
  aliases: readonly string[];
  required?: boolean;
}

/** Best-effort mapping of every field to a header, never handing the same header to two fields. */
export function autoMapColumns(headers: string[], fields: readonly FieldSpec[]): Record<string, string> {
  const taken = new Set<string>();
  const map: Record<string, string> = {};
  for (const field of fields) {
    const hit = matchColumn(headers.filter((h) => !taken.has(h)), [field.label, ...field.aliases]);
    map[field.key] = hit;
    if (hit) taken.add(hit);
  }
  return map;
}

/* ---------- row mapping with skip reporting ---------- */

export interface SkippedRow {
  /** 1-based line in the source file, counting the header row. */
  row: number;
  reason: string;
}

export interface MapResult<T> {
  valid: T[];
  skipped: SkippedRow[];
}

interface SkipSignal { __skip: string }

/** Returned from a row mapper to drop the row and record why. */
export const skipRow = (reason: string): SkipSignal => ({ __skip: reason });

const isSkip = (v: unknown): v is SkipSignal =>
  typeof v === 'object' && v !== null && typeof (v as SkipSignal).__skip === 'string';

/**
 * Runs `map` over every row. The mapper returns the parsed value, or `skipRow(reason)`
 * to reject it; a thrown error rejects the row too rather than failing the whole file.
 */
export function mapRows<T>(rows: SheetRow[], map: (row: SheetRow, rowNumber: number) => T | SkipSignal): MapResult<T> {
  const valid: T[] = [];
  const skipped: SkippedRow[] = [];
  rows.forEach((row, i) => {
    const rowNumber = i + 2; // +1 for zero-based index, +1 for the header line
    let out: T | SkipSignal;
    try {
      out = map(row, rowNumber);
    } catch (e) {
      skipped.push({ row: rowNumber, reason: e instanceof Error ? e.message : 'שורה לא תקינה' });
      return;
    }
    if (isSkip(out)) skipped.push({ row: rowNumber, reason: out.__skip });
    else valid.push(out);
  });
  return { valid, skipped };
}

/* ---------- cell coercion ---------- */

/** Trimmed text from a cell, length-capped. Returns '' for an unmapped column or empty cell. */
export function cellText(row: SheetRow, column: string, max = MAX_TEXT): string {
  if (!column) return '';
  const v = row[column];
  if (v == null) return '';
  return String(v).trim().slice(0, max);
}

/** Number from a cell, tolerating ₪ and thousands separators. Returns null when absent or unparsable. */
export function cellNumber(row: SheetRow, column: string): number | null {
  if (!column) return null;
  const raw = row[column];
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const cleaned = String(raw).replace(/[₪,\s]/g, '').replace(/[^\d.-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Key for matching names typed by hand across a spreadsheet and the database. */
export const nameKey = (s: string) => s.replace(/["'״׳]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/* ---------- reporting ---------- */

/** Groups skipped rows by reason, most frequent first, for a compact "what was dropped" panel. */
export function groupSkipped(skipped: SkippedRow[]): { reason: string; rows: number[] }[] {
  const byReason = new Map<string, number[]>();
  for (const s of skipped) {
    const list = byReason.get(s.reason);
    if (list) list.push(s.row);
    else byReason.set(s.reason, [s.row]);
  }
  return [...byReason.entries()]
    .map(([reason, rows]) => ({ reason, rows }))
    .sort((a, b) => b.rows.length - a.rows.length);
}
