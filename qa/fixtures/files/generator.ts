import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { assertSafeRunId, createSyntheticQaData } from '../data-factory.ts';

export type SyntheticFixtureKind = 'bank-csv' | 'price-list-xlsx' | 'invoice-pdf' | 'receipt-jpg';

export interface GeneratedFixtureFile {
  kind: SyntheticFixtureKind;
  path: string;
  mimeType: string;
  size: number;
  sha256: string;
}

export interface GeneratedFixtureManifest {
  schemaVersion: 1;
  runId: string;
  generatedAt: string;
  directory: string;
  files: GeneratedFixtureFile[];
}

export interface GenerateFixtureOptions {
  runId: string;
  directory: string;
}

export const FIXTURE_MANIFEST_FILE = 'manifest.json';

const ONE_PIXEL_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDpvgp/zHP+3f8A9qUUUUo7GGG/hI//2Q==',
  'base64',
);

function csvCell(value: string | number): string {
  const text = String(value);
  const formulaSafe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(formulaSafe) ? `"${formulaSafe.replaceAll('"', '""')}"` : formulaSafe;
}

function createBankCsv(runId: string): Buffer {
  const data = createSyntheticQaData(runId);
  const date = new Date().toISOString().slice(0, 10);
  const rows = [
    ['date', 'description', 'amount', 'reference', 'qa_run_id'],
    [date, data.bankTransaction.description, data.bankTransaction.amount, data.bankTransaction.reference, runId],
  ];
  return Buffer.from(`\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`, 'utf8');
}

function createPriceListXlsx(runId: string): Buffer {
  const data = createSyntheticQaData(runId);
  const rows = data.products.map((product) => ({
    product_id: product.id,
    product_name: product.name,
    price: product.price,
    qa_run_id: runId,
  }));
  const sheet = XLSX.utils.json_to_sheet(rows, {
    header: ['product_id', 'product_name', 'price', 'qa_run_id'],
  });
  sheet['!cols'] = [{ wch: 40 }, { wch: 24 }, { wch: 12 }, { wch: 40 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'prices');
  return Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true }));
}

function escapePdfText(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

function createInvoicePdf(runId: string): Buffer {
  const data = createSyntheticQaData(runId);
  const text = [
    `SupplyFlow synthetic invoice`,
    `Run: ${runId}`,
    `Invoice: ${data.invoice.number}`,
    `Total: ${data.invoice.total.toFixed(2)} ILS`,
  ];
  const commands = text
    .map((line, index) => `BT /F1 12 Tf 72 ${760 - index * 24} Td (${escapePdfText(line)}) Tj ET`)
    .join('\n');
  const stream = `${commands}\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n% SupplyFlow synthetic fixture\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}

function createReceiptJpeg(runId: string): Buffer {
  const comment = Buffer.from(`SupplyFlow synthetic receipt; run=${runId}`, 'utf8');
  const commentLength = Buffer.alloc(2);
  commentLength.writeUInt16BE(comment.length + 2);
  return Buffer.concat([
    ONE_PIXEL_JPEG.subarray(0, 2),
    Buffer.from([0xff, 0xfe]),
    commentLength,
    comment,
    ONE_PIXEL_JPEG.subarray(2),
  ]);
}

function digest(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function fileRecord(
  directory: string,
  fileName: string,
  kind: SyntheticFixtureKind,
  mimeType: string,
  content: Buffer,
): Promise<GeneratedFixtureFile> {
  const filePath = path.join(directory, fileName);
  await writeFile(filePath, content, { flag: 'wx' });
  return { kind, path: filePath, mimeType, size: content.byteLength, sha256: digest(content) };
}

export async function assertGeneratedFixtureFiles(manifest: GeneratedFixtureManifest): Promise<void> {
  assertSafeRunId(manifest.runId);
  const expectedKinds = new Set<SyntheticFixtureKind>([
    'bank-csv',
    'price-list-xlsx',
    'invoice-pdf',
    'receipt-jpg',
  ]);
  if (manifest.files.length !== expectedKinds.size) throw new Error('Fixture manifest must contain exactly four files.');

  for (const file of manifest.files) {
    if (!expectedKinds.delete(file.kind)) throw new Error(`Duplicate or unexpected fixture kind: ${file.kind}`);
    const absolute = path.resolve(file.path);
    const relative = path.relative(path.resolve(manifest.directory), absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Fixture path escaped its run directory.');
    const content = await readFile(absolute);
    if (content.byteLength !== file.size || digest(content) !== file.sha256) {
      throw new Error(`Fixture integrity mismatch: ${path.basename(file.path)}`);
    }
    if (file.kind === 'bank-csv') {
      const text = content.toString('utf8');
      if (!text.includes(manifest.runId) || !text.includes('qa_run_id')) throw new Error('CSV is missing its run marker.');
    } else if (file.kind === 'price-list-xlsx') {
      const workbook = XLSX.read(content, { type: 'buffer' });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(firstSheet);
      if (rows.length < 1 || rows.some((row) => row.qa_run_id !== manifest.runId)) {
        throw new Error('XLSX is missing its run marker or product rows.');
      }
    } else if (file.kind === 'invoice-pdf') {
      const text = content.toString('latin1');
      if (!text.startsWith('%PDF-') || !text.endsWith('%%EOF\n') || !text.includes(manifest.runId)) {
        throw new Error('PDF structure or run marker is invalid.');
      }
    } else if (file.kind === 'receipt-jpg') {
      if (content[0] !== 0xff || content[1] !== 0xd8 || content.at(-2) !== 0xff || content.at(-1) !== 0xd9) {
        throw new Error('JPG SOI/EOI markers are invalid.');
      }
      if (!content.includes(Buffer.from(manifest.runId, 'utf8'))) throw new Error('JPG is missing its run marker.');
    }
  }
  if (expectedKinds.size > 0) throw new Error('Fixture manifest is missing required file kinds.');
}

export async function generateSyntheticFixtureFiles(
  options: GenerateFixtureOptions,
): Promise<GeneratedFixtureManifest> {
  const runId = assertSafeRunId(options.runId);
  const directory = path.resolve(options.directory);
  await mkdir(directory, { recursive: true });

  const files = await Promise.all([
    fileRecord(directory, `bank-${runId}.csv`, 'bank-csv', 'text/csv', createBankCsv(runId)),
    fileRecord(
      directory,
      `supplier-prices-${runId}.xlsx`,
      'price-list-xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      createPriceListXlsx(runId),
    ),
    fileRecord(directory, `invoice-${runId}.pdf`, 'invoice-pdf', 'application/pdf', createInvoicePdf(runId)),
    fileRecord(directory, `receipt-${runId}.jpg`, 'receipt-jpg', 'image/jpeg', createReceiptJpeg(runId)),
  ]);

  const manifest: GeneratedFixtureManifest = {
    schemaVersion: 1,
    runId,
    generatedAt: new Date().toISOString(),
    directory,
    files,
  };
  await assertGeneratedFixtureFiles(manifest);
  await writeFile(
    path.join(directory, FIXTURE_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  );
  return manifest;
}

function isGeneratedFixtureManifest(value: unknown): value is GeneratedFixtureManifest {
  if (!value || typeof value !== 'object') return false;
  const manifest = value as Partial<GeneratedFixtureManifest>;
  return manifest.schemaVersion === 1
    && typeof manifest.runId === 'string'
    && typeof manifest.generatedAt === 'string'
    && typeof manifest.directory === 'string'
    && Array.isArray(manifest.files)
    && manifest.files.every((file) => Boolean(file)
      && typeof file === 'object'
      && typeof file.kind === 'string'
      && typeof file.path === 'string'
      && typeof file.mimeType === 'string'
      && typeof file.size === 'number'
      && typeof file.sha256 === 'string');
}

export async function loadGeneratedFixtureManifest(directory: string): Promise<GeneratedFixtureManifest> {
  const manifestPath = path.join(path.resolve(directory), FIXTURE_MANIFEST_FILE);
  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!isGeneratedFixtureManifest(parsed)) throw new Error('Synthetic fixture manifest is malformed.');
  if (path.resolve(parsed.directory) !== path.resolve(directory)) {
    throw new Error('Synthetic fixture manifest belongs to a different directory.');
  }
  await assertGeneratedFixtureFiles(parsed);
  return parsed;
}
