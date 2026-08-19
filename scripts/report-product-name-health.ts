/**
 * report-product-name-health — how many catalogue names can be read at all, and which cannot.
 *
 * WHY THIS EXISTS, AND WHY IT COMES FIRST.
 *
 * Part of the live catalogue was imported from Hebrew spreadsheets and OCR in VISUAL order rather
 * than logical order. A name stored that way reads back with its tokens reversed —
 * `)ב12- אר30*30מטליות מיקרופייבר` — and no display-layer fix repairs it: `bidiIsolate` and
 * `dir="auto"` render a reversed name faithfully reversed. Such a name also cannot be parsed: a
 * size/brand normaliser fed one produces a confident wrong answer, which would then be written
 * into `products.display_name` and shown on every screen that names a product.
 *
 * So before anything renames anything, someone has to see the size of the problem and the actual
 * rows. That is all this script does. It counts and lists; it decides nothing and changes nothing.
 *
 * IT READS NOTHING FROM THE NETWORK. It takes an export file, or stdin. There is no database
 * client here and no credential — deliberately, so it can be run against a copy of production data
 * without being a thing that touches production.
 *
 * USAGE
 *   node scripts/report-product-name-health.ts products.json
 *   node scripts/report-product-name-health.ts products.csv
 *   node scripts/report-product-name-health.ts --format=csv < products.csv
 *   node scripts/report-product-name-health.ts --list=all products.json
 *
 * INPUT
 *   JSON — an array of `{ id?, name }` objects, an array of strings, or an object wrapping one of
 *          those under `products`, `data`, or `rows` (the shape a Supabase/PostgREST export has).
 *   CSV  — a header row containing a `name` column; an `id` or `sku` column is used for labelling.
 *
 * EXIT CODE is 0 whether or not suspects are found. This is a report a person reads, not a gate:
 * failing the build until 39 historical rows are repaired would only teach people to skip it.
 *
 * The visual-order rule below is the same rule `src/lib/productDisplayName.ts` refuses on. The two
 * are separate implementations because this script runs under plain node, which cannot follow that
 * module's extensionless import of `format.ts`. They are held together by a parity test over one
 * corpus in `src/lib/productDisplayName.spec.ts` — if they ever disagree, that test fails.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export type VisualOrderSignal =
  | 'leading_closer'
  | 'unbalanced_brackets'
  | 'closer_before_opener';

const BRACKET_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
];

const SIGNAL_LABELS: Record<VisualOrderSignal, string> = {
  leading_closer: 'name begins with a closing bracket',
  unbalanced_brackets: 'unbalanced brackets',
  closer_before_opener: 'a closing bracket precedes its opener',
};

/**
 * Brackets are the cheap, reliable tell. In logical order an opener precedes its closer; a name
 * stored in visual order has them the other way round, and one mangled by OCR has lost one. None
 * of the three signals proves reversal alone — together they mark a name whose character order
 * cannot be trusted, which is all that is needed to refuse to parse it.
 */
export function visualOrderSignals(name: string): VisualOrderSignal[] {
  const text = name.trim();
  const signals: VisualOrderSignal[] = [];

  if (BRACKET_PAIRS.some(([, close]) => text.startsWith(close))) {
    signals.push('leading_closer');
  }

  const unbalanced = BRACKET_PAIRS.some(([open, close]) => {
    let opens = 0;
    let closes = 0;
    for (const char of text) {
      if (char === open) opens += 1;
      else if (char === close) closes += 1;
    }
    return opens !== closes;
  });
  if (unbalanced) signals.push('unbalanced_brackets');

  const inverted = BRACKET_PAIRS.some(([open, close]) => {
    let depth = 0;
    for (const char of text) {
      if (char === open) depth += 1;
      else if (char === close) {
        if (depth === 0) return true;
        depth -= 1;
      }
    }
    return false;
  });
  if (inverted) signals.push('closer_before_opener');

  return signals;
}

interface ProductRow {
  label: string;
  name: string;
}

/** Minimal RFC4180 reader — quoted fields, embedded commas, doubled quotes, CRLF, BOM. */
function parseCsv(source: string): string[][] {
  const text = source.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\r') continue;
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += char;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((entry) => entry.some((cell) => cell.trim() !== ''));
}

function rowsFromCsv(source: string): ProductRow[] {
  const table = parseCsv(source);
  const header = table.shift();
  if (!header) throw new Error('the CSV is empty — expected a header row with a `name` column');

  const columns = header.map((cell) => cell.trim().toLowerCase());
  const nameAt = columns.indexOf('name');
  if (nameAt < 0) {
    throw new Error(`the CSV has no \`name\` column (columns seen: ${columns.join(', ') || 'none'})`);
  }
  const labelAt = ['id', 'sku', 'barcode'].map((key) => columns.indexOf(key)).find((at) => at >= 0);

  return table.map((cells, index) => ({
    label: (labelAt != null ? cells[labelAt]?.trim() : '') || `row ${index + 2}`,
    name: cells[nameAt] ?? '',
  }));
}

function rowsFromJson(source: string): ProductRow[] {
  const parsed: unknown = JSON.parse(source);
  const list = Array.isArray(parsed)
    ? parsed
    : ['products', 'data', 'rows'].reduce<unknown[] | null>((found, key) => {
      if (found) return found;
      const value = (parsed as Record<string, unknown> | null)?.[key];
      return Array.isArray(value) ? value : null;
    }, null);

  if (!list) {
    throw new Error('expected a JSON array of products, or an object with a `products`, `data`, or `rows` array');
  }

  return list.map((entry, index) => {
    if (typeof entry === 'string') return { label: `item ${index + 1}`, name: entry };
    const record = (entry ?? {}) as Record<string, unknown>;
    const name = record['name'];
    if (typeof name !== 'string') {
      throw new Error(`item ${index + 1} has no string \`name\` field`);
    }
    const label = [record['id'], record['sku'], record['barcode']]
      .find((value) => typeof value === 'string' && value.trim() !== '');
    return { label: (label as string | undefined) ?? `item ${index + 1}`, name };
  });
}

export function readRows(source: string, format: 'json' | 'csv'): ProductRow[] {
  return format === 'csv' ? rowsFromCsv(source) : rowsFromJson(source);
}

/** Wide enough for the longest signal label plus its indent, so every count lands in one column. */
const SUMMARY_WIDTH = 44;

const pad = (value: string, width: number) => value + ' '.repeat(Math.max(0, width - value.length));
const dots = (label: string, width: number) => `${label} ${'.'.repeat(Math.max(3, width - label.length))}`;

function render(rows: ProductRow[], sourceLabel: string, listAll: boolean): string {
  const assessed = rows.map((row) => ({ ...row, signals: visualOrderSignals(row.name) }));
  const suspects = assessed.filter((row) => row.signals.length > 0);
  const empty = assessed.filter((row) => row.name.trim() === '');

  const lines: string[] = [];
  lines.push('');
  lines.push(`Product name health — ${assessed.length} name(s) from ${sourceLabel}`);
  lines.push('');
  lines.push(`  ${dots('suspected visual order', SUMMARY_WIDTH)} ${suspects.length}`);
  for (const signal of Object.keys(SIGNAL_LABELS) as VisualOrderSignal[]) {
    const count = assessed.filter((row) => row.signals.includes(signal)).length;
    lines.push(`  ${dots(`  ${SIGNAL_LABELS[signal]}`, SUMMARY_WIDTH)} ${count}`);
  }
  lines.push(`  ${dots('empty name', SUMMARY_WIDTH)} ${empty.length}`);
  lines.push(`  ${dots('readable', SUMMARY_WIDTH)} ${assessed.length - suspects.length}`);
  lines.push('');

  const listed = listAll ? assessed : suspects;
  if (listed.length === 0) {
    lines.push('  No name shows a visual-order signal.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push(`Names to decide about (${listed.length})`);
  lines.push('');
  const labelWidth = Math.min(24, Math.max(...listed.map((row) => row.label.length), 5));
  for (const row of listed) {
    const signals = row.signals.length > 0 ? row.signals.join(' + ') : 'readable';
    lines.push(`  ${pad(row.label.slice(0, labelWidth), labelWidth)}  ${signals}`);
    // The name goes on its own line, undecorated: it is RTL text with reversed punctuation, and
    // anything wrapped around it in a terminal makes it harder to read, not easier.
    lines.push(`  ${' '.repeat(labelWidth)}  ${row.name}`);
  }
  lines.push('');
  lines.push('  A name flagged here cannot be normalised — `proposeDisplayName` returns `blocked`');
  lines.push('  for it rather than guessing. These rows need their stored text repaired, which is');
  lines.push('  a data decision for the owner, not something a parser can do.');
  lines.push('');

  return lines.join('\n');
}

function main(): void {
  const args = process.argv.slice(2);
  const listAll = args.includes('--list=all');
  const formatArg = args.find((arg) => arg.startsWith('--format='))?.slice('--format='.length);
  const path = args.find((arg) => !arg.startsWith('--'));

  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: node scripts/report-product-name-health.ts [--format=json|csv] [--list=all] [export.json|export.csv]');
    return;
  }

  let source: string;
  let sourceLabel: string;
  if (path) {
    source = readFileSync(path, 'utf8');
    sourceLabel = path;
  } else {
    source = readFileSync(0, 'utf8');
    sourceLabel = 'stdin';
  }

  let format: 'json' | 'csv';
  if (formatArg === 'json' || formatArg === 'csv') format = formatArg;
  else if (path && /\.csv$/i.test(path)) format = 'csv';
  else if (path && /\.json$/i.test(path)) format = 'json';
  else format = /^\s*[[{]/.test(source) ? 'json' : 'csv';

  try {
    console.log(render(readRows(source, format), sourceLabel, listAll));
  } catch (error) {
    console.error(`Could not read ${sourceLabel} as ${format}: ${(error as Error).message}`);
    process.exit(2);
  }
}

const entry = process.argv[1];
if (entry && resolve(entry) === resolve(fileURLToPath(import.meta.url))) main();
