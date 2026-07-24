// submit-price-list -- trusted monthly supplier price-list intake.
//
// Required environment (injected by Supabase; never expose these as VITE_* values):
//   SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY
//   ALLOWED_ORIGINS -- optional comma-separated browser origins; defaults to APP_BASE_URL
//   APP_BASE_URL    -- canonical application origin
//
// The browser uploads an unregistered private object, then sends only its immutable identity.
// This function claims that object, downloads the exact bytes, hashes and parses them here, and
// stages the canonical rows through a service_role-only RPC. The final command is deliberately
// called with the user's JWT so Postgres remains the role/tenant command boundary.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.91.1';
import * as PapaModule from 'https://esm.sh/papaparse@5.4.1?target=denonext';
import * as XLSX from 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';

// esm.sh exposes PapaParse as a CommonJS default at runtime, while @types/papaparse declares
// named members only. Resolve that interop boundary explicitly so Deno types and Edge agree.
const Papa = (
  (PapaModule as unknown as { default?: typeof PapaModule }).default ?? PapaModule
);

const BUCKET = 'price-submissions';
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 5000;
const PAGE_SIZE = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONTH_START = /^\d{4}-(0[1-9]|1[0-2])-01$/;

type ErrorCode =
  | 'unauthenticated'
  | 'not_authorized'
  | 'invalid_request'
  | 'file_missing'
  | 'file_too_large'
  | 'invalid_file_type'
  | 'invalid_csv_encoding'
  | 'invalid_csv_row'
  | 'damaged_spreadsheet'
  | 'missing_columns'
  | 'empty_file'
  | 'too_many_rows'
  | 'intake_busy'
  | 'intake_required'
  | 'file_changed'
  | 'supplier_unavailable'
  | 'idempotency_conflict'
  | 'catalog_changed'
  | 'service_unavailable';

const MESSAGE: Record<ErrorCode, string> = {
  unauthenticated: 'נדרשת התחברות מחדש לפני הגשת המחירון.',
  not_authorized: 'אין לך הרשאה להגיש מחירון עבור הספק שנבחר.',
  invalid_request: 'פרטי ההגשה אינם תקינים. רענן את המסך ונסה שוב.',
  file_missing: 'הקובץ הזמני לא נמצא. בחר את הקובץ מחדש ונסה שוב.',
  file_too_large: 'הקובץ גדול מ־10MB. יש לפצל אותו ולנסות שוב.',
  invalid_file_type: 'סוג הקובץ אינו נתמך. ניתן להגיש CSV UTF-8 או Excel מסוג XLS/XLSX.',
  invalid_csv_encoding: 'קידוד ה־CSV אינו UTF-8. שמור אותו כ־CSV UTF-8 ונסה שוב.',
  invalid_csv_row: 'מבנה שורת CSV אינו תקין. תקן את מספר העמודות או המרכאות ונסה שוב.',
  damaged_spreadsheet: 'קובץ ה־Excel פגום או שאינו תואם לסיומת שלו. שמור עותק חדש ונסה שוב.',
  missing_columns: 'נדרשות עמודת product_id או מוצר, וכן עמודת מחיר. מומלץ להשתמש בתבנית.',
  empty_file: 'לא נמצאו שורות נתונים בקובץ.',
  too_many_rows: 'הקובץ מכיל יותר מ־5,000 שורות. יש לפצל אותו.',
  intake_busy: 'הקובץ כבר נמצא בתהליך קליטה. המתן רגע ונסה שוב.',
  intake_required: 'חלון הקליטה של הקובץ פג. בחר את הקובץ מחדש ונסה שוב.',
  file_changed: 'הקובץ השתנה בזמן הקליטה. בחר אותו מחדש ונסה שוב.',
  supplier_unavailable: 'הספק אינו זמין עוד. רענן את המסך לפני הגשה נוספת.',
  idempotency_conflict: 'מזהה ההגשה כבר נקלט עם קובץ אחר. רענן את היסטוריית ההגשות ונסה שוב.',
  catalog_changed: 'קטלוג המוצרים השתנה בזמן הקליטה. רענן את המסך ובדוק שוב את הקובץ.',
  service_unavailable: 'שירות קליטת המחירונים אינו זמין כרגע. נסה שוב בעוד מספר דקות.',
};

class IntakeError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(MESSAGE[code]);
  }
}

interface SubmitRequest {
  submissionId?: string;
  supplierId?: string;
  targetMonth?: string;
  fileName?: string;
  storagePath?: string;
  reason?: string;
}

interface ProfileRow {
  org_id: string;
  role: 'owner' | 'office' | 'supplier' | string;
  supplier_id: string | null;
  active: boolean;
}

interface ProductRow {
  id: string;
  name: string;
}

type SheetRow = Record<string, unknown>;

interface SubmissionRow {
  source_row: number;
  product_id: string | null;
  product_name: string;
  price_text: string;
  available: boolean;
}

interface SubmissionReceipt {
  submission_id: string;
  revision: number;
  status: 'accepted' | 'accepted_with_rejections' | 'rejected';
  accepted_count: number;
  rejected_count: number;
  unchanged_count: number;
  rejections: Record<string, unknown>[];
  storage_path: string;
  idempotent: boolean;
}

function corsFor(req: Request): Record<string, string> {
  const allowed = (Deno.env.get('ALLOWED_ORIGINS') ?? Deno.env.get('APP_BASE_URL') ?? '')
    .split(',').map((origin) => origin.trim().replace(/\/+$/, '')).filter(Boolean);
  const origin = req.headers.get('Origin')?.replace(/\/+$/, '') ?? '';
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : (allowed[0] ?? ''),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

function fail(cors: Record<string, string>, error: IntakeError) {
  const body: { error: { code: ErrorCode; message: string; detail?: string } } = {
    error: { code: error.code, message: error.message },
  };
  if (error.detail) body.error.detail = error.detail;
  return new Response(JSON.stringify(body), {
    status: error.status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

function ok(cors: Record<string, string>, receipt: SubmissionReceipt) {
  return new Response(JSON.stringify(receipt), {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

const cleanMime = (value: string) => value.toLowerCase().split(';', 1)[0].trim();
const fileExtension = (value: string) => value.match(/\.(csv|xlsx|xls)$/i)?.[1].toLowerCase() ?? '';
const isBlank = (row: SheetRow) => Object.values(row).every((value) => String(value ?? '').trim() === '');
const cellText = (row: SheetRow, column: string, max = 200) =>
  column ? String(row[column] ?? '').trim().slice(0, max) : '';
const normalize = (value: string) => value
  .replace(/["'״׳.:_-]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const nameKey = (value: string) => value
  .replace(/["'״׳]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

function matchColumn(headers: string[], aliases: string[]): string {
  const normalized = headers.map((header) => [header, normalize(header)] as const);
  for (const alias of aliases) {
    const match = normalized.find(([, header]) => header === normalize(alias));
    if (match) return match[0];
  }
  return '';
}

function sheetData(rows: SheetRow[]): { rows: SheetRow[]; headers: string[] } {
  const nonBlank = rows.filter((row) => row && !isBlank(row));
  if (!nonBlank.length) throw new IntakeError('empty_file', 400);
  if (nonBlank.length > MAX_ROWS) throw new IntakeError('too_many_rows', 400);
  const headers: string[] = [];
  for (const row of nonBlank) {
    for (const key of Object.keys(row)) if (!headers.includes(key)) headers.push(key);
  }
  if (!headers.length) throw new IntakeError('empty_file', 400);
  return { rows: nonBlank, headers };
}

function parseCsv(bytes: Uint8Array): { rows: SheetRow[]; headers: string[] } {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    throw new IntakeError('invalid_csv_encoding', 400);
  }

  const parsed = Papa.parse<SheetRow>(text, { header: true, skipEmptyLines: true });
  const parseError = parsed.errors[0];
  if (parseError) {
    const row = typeof parseError.row === 'number' ? parseError.row + 2 : undefined;
    throw new IntakeError('invalid_csv_row', 400, row ? `שורה ${row}` : undefined);
  }
  return sheetData(parsed.data);
}

function parseWorkbook(bytes: Uint8Array, extension: string): { rows: SheetRow[]; headers: string[] } {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const isOle = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
    .every((value, index) => bytes[index] === value);
  if ((extension === 'xlsx' && !isZip) || (extension === 'xls' && !isOle)) {
    throw new IntakeError('damaged_spreadsheet', 400);
  }

  try {
    const workbook = XLSX.read(bytes, { type: 'array', raw: true, sheetRows: MAX_ROWS + 2 });
    const first = workbook.SheetNames[0];
    if (!first) throw new IntakeError('damaged_spreadsheet', 400);
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[first], {
      defval: '', raw: true, blankrows: false,
    }) as SheetRow[];
    return sheetData(rows);
  } catch (error) {
    if (error instanceof IntakeError) throw error;
    throw new IntakeError('damaged_spreadsheet', 400);
  }
}

function canonicalRows(
  rows: SheetRow[],
  headers: string[],
  products: ProductRow[],
): SubmissionRow[] {
  const columns = {
    productId: matchColumn(headers, ['מזהה מוצר', 'מזהה_מוצר', 'product_id', 'product id']),
    product: matchColumn(headers, ['מוצר', 'שם מוצר', 'product', 'product_name']),
    price: matchColumn(headers, ['מחיר', 'price']),
    available: matchColumn(headers, ['זמין', 'זמינות', 'available']),
  };
  if ((!columns.productId && !columns.product) || !columns.price) {
    throw new IntakeError('missing_columns', 400);
  }

  const byId = new Map(products.map((product) => [product.id, product]));
  const byName = new Map<string, ProductRow | null>();
  for (const product of products) {
    const key = nameKey(product.name);
    byName.set(key, byName.has(key) ? null : product);
  }

  return rows.map((row, index) => {
    const suppliedId = cellText(row, columns.productId);
    const suppliedName = cellText(row, columns.product);
    const product = suppliedId
      ? byId.get(suppliedId)
      : (byName.get(nameKey(suppliedName)) ?? undefined);
    const availability = nameKey(cellText(row, columns.available));
    return {
      source_row: index + 2,
      product_id: product?.id ?? null,
      product_name: product?.name ?? (suppliedName || suppliedId),
      price_text: cellText(row, columns.price, 64),
      available: !['0', 'false', 'no', 'n', 'לא', 'לא זמין', 'unavailable'].includes(availability),
    };
  });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function fetchProducts(admin: SupabaseClient, orgId: string): Promise<ProductRow[]> {
  const products: ProductRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await admin.from('products').select('id, name')
      .eq('org_id', orgId).eq('active', true).order('id')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new IntakeError('service_unavailable', 503);
    const page = (data ?? []) as ProductRow[];
    products.push(...page);
    if (page.length < PAGE_SIZE) return products;
  }
}

function receiptFromRow(row: Record<string, unknown>): SubmissionReceipt {
  return {
    submission_id: String(row.id),
    revision: Number(row.revision),
    status: row.status as SubmissionReceipt['status'],
    accepted_count: Number(row.accepted_count),
    rejected_count: Number(row.rejected_count),
    unchanged_count: Number(row.unchanged_count),
    rejections: Array.isArray(row.rejections) ? row.rejections as Record<string, unknown>[] : [],
    storage_path: String(row.storage_path),
    idempotent: true,
  };
}

function pgError(message: string): IntakeError {
  if (/JWT expired|Invalid Refresh Token|refresh_token_not_found/i.test(message)) {
    return new IntakeError('unauthenticated', 401);
  }
  if (message.includes('price_submission_not_authorized')
      || message.includes('price_import_not_authorized')) {
    return new IntakeError('not_authorized', 403);
  }
  if (message.includes('price_submission_file_missing')) return new IntakeError('file_missing', 404);
  if (message.includes('price_submission_intake_busy')) return new IntakeError('intake_busy', 409);
  if (message.includes('price_submission_intake_required')) return new IntakeError('intake_required', 409);
  if (message.includes('price_submission_file_changed')) return new IntakeError('file_changed', 409);
  if (message.includes('price_submission_supplier_invalid')) return new IntakeError('supplier_unavailable', 409);
  if (message.includes('price_submission_idempotency_conflict')) {
    return new IntakeError('idempotency_conflict', 409);
  }
  if (message.includes('price_import_target_invalid') || message.includes('supplier_product_not_found')) {
    return new IntakeError('catalog_changed', 409);
  }
  if (message.includes('price_submission_invalid')
      || message.includes('price_submission_intake_invalid')
      || message.includes('price_import_invalid')
      || message.includes('price_values_invalid')) {
    return new IntakeError('invalid_request', 400);
  }
  return new IntakeError('service_unavailable', 503);
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = corsFor(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail(cors, new IntakeError('invalid_request', 405));

  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceKey) {
    return fail(cors, new IntakeError('service_unavailable', 500));
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return fail(cors, new IntakeError('unauthenticated', 401));
  }

  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { data: userData, error: userError } = await caller.auth.getUser();
  if (userError || !userData.user) return fail(cors, new IntakeError('unauthenticated', 401));

  let body: SubmitRequest;
  try {
    body = await req.json() as SubmitRequest;
  } catch {
    return fail(cors, new IntakeError('invalid_request', 400));
  }

  const submissionId = body.submissionId ?? '';
  const supplierId = body.supplierId ?? '';
  const targetMonth = body.targetMonth ?? '';
  const fileName = body.fileName?.trim() ?? '';
  const storagePath = body.storagePath ?? '';
  const reason = body.reason?.trim() ?? '';
  const extension = fileExtension(fileName);
  const pathParts = storagePath.split('/');

  if (!UUID.test(submissionId) || !UUID.test(supplierId) || !MONTH_START.test(targetMonth)
      || !fileName || fileName.length > 255 || /[\\/]/.test(fileName)
      || !extension || reason.length < 1 || reason.length > 1000
      || pathParts.length !== 5 || pathParts[2] !== supplierId
      || pathParts[3] !== submissionId || !pathParts[4]
      || fileExtension(pathParts[4]) !== extension) {
    return fail(cors, new IntakeError('invalid_request', 400));
  }

  const { data: profileData, error: profileError } = await admin.from('profiles')
    .select('org_id, role, supplier_id, active').eq('id', userData.user.id).maybeSingle();
  const profile = profileData as ProfileRow | null;
  if (profileError || !profile?.active) return fail(cors, new IntakeError('not_authorized', 403));
  if (!['owner', 'office', 'supplier'].includes(profile.role)
      || (profile.role === 'supplier' && profile.supplier_id !== supplierId)
      || pathParts[0] !== profile.org_id || pathParts[1] !== 'price-submissions') {
    return fail(cors, new IntakeError('not_authorized', 403));
  }

  const [{ data: org }, { data: supplier }] = await Promise.all([
    admin.from('organizations').select('status').eq('id', profile.org_id).maybeSingle(),
    admin.from('suppliers').select('id').eq('org_id', profile.org_id)
      .eq('id', supplierId).is('deleted_at', null).maybeSingle(),
  ]);
  if (!org || (org as { status: string }).status === 'suspended' || !supplier) {
    return fail(cors, new IntakeError('not_authorized', 403));
  }

  const intakeId = crypto.randomUUID();
  let claimed = false;
  try {
    const claim = await admin.rpc('claim_supplier_price_intake', {
      p_intake_id: intakeId,
      p_actor_id: userData.user.id,
      p_supplier_id: supplierId,
      p_submission_id: submissionId,
      p_target_month: targetMonth,
      p_file_name: fileName,
      p_storage_path: storagePath,
      p_reason: reason,
    });
    if (claim.error) throw pgError(claim.error.message);
    claimed = true;

    const downloaded = await admin.storage.from(BUCKET).download(storagePath);
    if (downloaded.error || !downloaded.data) throw new IntakeError('file_missing', 404);
    if (downloaded.data.size === 0) throw new IntakeError('empty_file', 400);
    if (downloaded.data.size > MAX_FILE_BYTES) throw new IntakeError('file_too_large', 413);

    const expectedMime = extension === 'csv'
      ? 'text/csv'
      : extension === 'xls'
      ? 'application/vnd.ms-excel'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const downloadedMime = cleanMime(downloaded.data.type);
    if (downloadedMime && downloadedMime !== expectedMime) {
      throw new IntakeError('invalid_file_type', 400);
    }

    const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
    const [checksum, products] = await Promise.all([
      sha256(bytes),
      fetchProducts(admin, profile.org_id),
    ]);
    const parsed = extension === 'csv' ? parseCsv(bytes) : parseWorkbook(bytes, extension);
    const rows = canonicalRows(parsed.rows, parsed.headers, products);

    const prepared = await admin.rpc('prepare_supplier_price_intake', {
      p_intake_id: intakeId,
      p_actor_id: userData.user.id,
      p_file_checksum: checksum,
      p_file_size: bytes.byteLength,
      p_rows: rows,
    });
    if (prepared.error) throw pgError(prepared.error.message);

    const submitted = await caller.rpc('submit_supplier_price_list', { p_intake_id: intakeId });
    if (!submitted.error && submitted.data) {
      return ok(cors, submitted.data as SubmissionReceipt);
    }

    // A lost RPC response is ambiguous. Reconcile against the immutable ledger using the
    // server-computed checksum before returning an error or allowing the orphan to be removed.
    const byId = await caller.from('supplier_price_submissions').select('*')
      .eq('id', submissionId).maybeSingle();
    if (!byId.error && byId.data) return ok(cors, receiptFromRow(byId.data));
    const byChecksum = await caller.from('supplier_price_submissions').select('*')
      .eq('supplier_id', supplierId).eq('target_month', targetMonth)
      .eq('file_checksum', checksum).maybeSingle();
    if (!byChecksum.error && byChecksum.data) return ok(cors, receiptFromRow(byChecksum.data));

    throw pgError(submitted.error?.message ?? 'submission_failed');
  } catch (error) {
    const safe = error instanceof IntakeError ? error : new IntakeError('service_unavailable', 503);
    console.error('submit-price-list failed:', safe.code);
    return fail(cors, safe);
  } finally {
    if (claimed) {
      // Best effort only. Successful submission already consumed the row in its DB transaction;
      // failures release the Storage claim so the browser can remove the orphan immediately.
      await admin.rpc('discard_supplier_price_intake', {
        p_intake_id: intakeId,
        p_actor_id: userData.user.id,
      });
    }
  }
});
