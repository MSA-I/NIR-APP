import { supabase } from './supabase';
import { tusUploadToDocuments } from './tusUpload';
import { unwrap } from './useQuery';

export const PAYABLE_INVOICE_ROLE = 'payable' as const;

export type ConsolidatedInvoiceStatus =
  | 'awaiting_anchor'
  | 'needs_review'
  | 'reconciling'
  | 'matched'
  | 'warnings'
  | 'blocked';

export type ConsolidatedMatchResult =
  | 'matched'
  | 'missing_source'
  | 'source_not_on_anchor'
  | 'ambiguous'
  | 'quantity_mismatch'
  | 'price_mismatch';

export type ConsolidatedMatchChannel =
  | 'anchor_vs_interim'
  | 'anchor_vs_receipts'
  | 'interim_vs_receipts';

export interface ConsolidatedLegalEntity {
  id: string;
  name: string;
}

export interface ConsolidatedInvoiceCaseSummary {
  case_id: string;
  supplier_id: string;
  supplier_name: string;
  target_month: string;
  legal_entity_id: string;
  status: ConsolidatedInvoiceStatus;
  anchor_invoice_id: string | null;
  current_revision: number;
  warning_count: number;
  updated_at: string;
}

export interface ConsolidatedInvoiceCase {
  id: string;
  supplier_id: string;
  supplier_name: string;
  target_month: string;
  legal_entity_id: string;
  legal_entity_name: string;
  status: ConsolidatedInvoiceStatus;
  anchor_invoice_id: string | null;
  current_revision: number;
  warning_count: number;
  created_at: string;
  updated_at: string;
}

export interface ConsolidatedInvoiceAnchor {
  invoice_id: string;
  document_ids: string[];
  invoice_number: string;
  invoice_date: string;
  amount_before_vat: number;
  vat_amount: number;
  total_amount: number;
  /** The anchor invoice's own currency (0226). Every figure above is money of this one kind. */
  currency: string;
  financial_role: 'payable';
  review_status: string;
  payment_status: string;
}

export interface ConsolidatedInvoiceSource {
  source_type: 'interim_invoice' | 'goods_receipt' | 'supporting_document';
  source_id: string;
  document_id: string | null;
  document_number: string | null;
  document_date: string;
  total_amount: number | null;
  /**
   * The currency this source's value is in (0226). `null` together with a null `total_amount`
   * when a goods receipt's lines came from orders in more than one currency — see
   * `spans_currencies`. A receipt like that has no single value, and the screen says so.
   */
  currency: string | null;
  spans_currencies: boolean;
  financial_role: 'supporting_evidence' | null;
  status: string;
  late_arrival: boolean;
}

export interface ConsolidatedInvoiceMatchLine {
  comparison: ConsolidatedMatchChannel;
  result: ConsolidatedMatchResult;
  product_id: string | null;
  product_name: string | null;
  supplier_sku: string | null;
  barcode: string | null;
  /** The currency this comparison row is grained by (0222) — both sides of it are in it. */
  currency: string;
  anchor_quantity: number | null;
  interim_quantity: number | null;
  received_quantity: number | null;
  anchor_unit_price: number | null;
  interim_unit_price: number | null;
  anchor_amount: number | null;
  interim_amount: number | null;
  difference_quantity: number | null;
  difference_amount: number | null;
  source_ids: string[];
  message_key: string;
  severity: 'info' | 'warning';
}

export interface ConsolidatedInvoiceWarning {
  code: string;
  severity: 'warning';
  message_key: string;
  source_type: string | null;
  source_id: string | null;
  product_id: string | null;
}

export interface ConsolidatedInvoiceRevision {
  id: string;
  revision: number;
  trigger: 'anchor_received' | 'late_arrival' | 'manual_refresh';
  created_at: string;
  created_by: string | null;
}

export interface ConsolidatedInvoiceReviewIntake {
  intake_id: string;
  status: 'uploading' | 'ready' | 'needs_review' | 'received' | 'blocked';
  outcome: string | null;
  reason_code: string | null;
  interpretation_id: string | null;
  completed_at: string | null;
  received_at: string | null;
}

export interface ConsolidatedInvoiceReviewPage {
  page_number: number;
  document_id: string;
  file_name: string;
  is_primary: boolean;
  job_id: string | null;
  job_status: string | null;
  interpretation_id: string | null;
  document_type: string | null;
}

export interface ConsolidatedInvoiceWorkspace {
  case: ConsolidatedInvoiceCase;
  anchor: ConsolidatedInvoiceAnchor | null;
  intake: ConsolidatedInvoiceReviewIntake | null;
  pages: ConsolidatedInvoiceReviewPage[];
  sources: ConsolidatedInvoiceSource[];
  reconciliation: Record<ConsolidatedMatchChannel, ConsolidatedInvoiceMatchLine[]>;
  current_revision: ConsolidatedInvoiceRevision | null;
  warnings: ConsolidatedInvoiceWarning[];
}

export interface ConsolidatedInvoiceIntake {
  intake_id: string;
  case_id: string;
  processing_mode: 'consolidated_supplier_invoice';
  supplier_id: string;
  target_month: string;
  legal_entity_id: string;
  status: 'uploading';
  source_page_count: number;
  idempotent: boolean;
}

export interface ConsolidatedInvoicePageRegistration {
  intake_id: string;
  page_id: string;
  page_number: number;
  document_id: string;
  storage_path: string;
  idempotent: boolean;
}

export interface ConsolidatedInvoiceCompletion {
  intake_id: string;
  case_id: string;
  status: 'ready';
  primary_document_id: string;
  document_ids: string[];
  source_page_count: number;
  idempotent: boolean;
}

export interface ConsolidatedPageResume {
  clientUploadKey: string;
  storagePath: string | null;
  documentId: string | null;
}

export interface PreviousMonth {
  value: string;
  start: string;
  end: string;
  label: string;
}

export function previousJerusalemMonth(now: Date = new Date()): PreviousMonth {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const currentYear = Number(parts.find((part) => part.type === 'year')?.value);
  const currentMonth = Number(parts.find((part) => part.type === 'month')?.value);
  const previous = new Date(Date.UTC(currentYear, currentMonth - 2, 1));
  const year = previous.getUTCFullYear();
  const month = previous.getUTCMonth() + 1;
  const value = `${year}-${String(month).padStart(2, '0')}`;
  const endDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    value,
    start: `${value}-01`,
    end: `${value}-${String(endDay).padStart(2, '0')}`,
    label: new Intl.DateTimeFormat('he-IL', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(previous),
  };
}

// One state, one string. `נדרשת בדיקה` is the canonical wording in documentStatus.ts, and a page
// that says `דורשת בדיקה` sends the reader looking for a label the product never shows.
export function consolidatedStatusLabel(status: ConsolidatedInvoiceStatus): string {
  return ({
    awaiting_anchor: 'ממתינה לחשבונית מרכזת',
    needs_review: 'נדרשת בדיקה',
    reconciling: 'מבצעת התאמה',
    matched: 'מותאם',
    warnings: 'נרשמה עם אזהרות',
    blocked: 'חסומה לרישום',
  } as const)[status];
}

// The packet page list used to print `page.document_type` and `page.job_status` straight into the
// sentence, so a Hebrew screen showed raw pipeline tokens (`queued`, `leased`, `delivery_note`).
// Unknown values are named as unknown rather than echoed.
export function consolidatedPageTypeLabel(documentType: string | null): string {
  if (!documentType) return 'ממתין לזיהוי';
  return ({
    invoice: 'חשבונית',
    delivery_note: 'תעודת משלוח',
    credit_note: 'חשבונית זיכוי',
    price_list: 'מחירון',
    quote: 'הצעת מחיר',
    payment_confirmation: 'אישור תשלום',
    tax_receipt: 'קבלה',
    other: 'מסמך אחר',
  } as Record<string, string>)[documentType] ?? 'ממתין לזיהוי';
}

export function consolidatedPageStatusLabel(jobStatus: string | null): string {
  if (!jobStatus) return 'ממתין לעיבוד';
  return ({
    awaiting_scan: 'ממתין לסריקה',
    queued: 'ממתין לעיבוד',
    leased: 'בעיבוד',
    extracted: 'בעיבוד',
    interpreting: 'בעיבוד',
    review: 'נדרשת בדיקה',
    completed: 'הושלם',
    failed: 'העיבוד נכשל',
  } as Record<string, string>)[jobStatus] ?? 'ממתין לעיבוד';
}

export function consolidatedStatusTone(status: ConsolidatedInvoiceStatus): 'idle' | 'info' | 'alert' | 'await' | 'done' {
  if (status === 'matched') return 'done';
  if (status === 'blocked') return 'alert';
  if (status === 'warnings' || status === 'needs_review') return 'await';
  if (status === 'reconciling') return 'info';
  return 'idle';
}

export function matchGroupLabel(result: ConsolidatedMatchResult): string {
  return ({
    matched: 'מותאם',
    missing_source: 'חסר מקור',
    source_not_on_anchor: 'מקור שלא הופיע במרכזת',
    ambiguous: 'עמום',
    quantity_mismatch: 'פער כמות',
    price_mismatch: 'פער מחיר',
  } as const)[result];
}

export function matchChannelLabel(channel: ConsolidatedMatchChannel): string {
  return ({
    anchor_vs_interim: 'מרכזת מול חשבוניות ביניים',
    anchor_vs_receipts: 'מרכזת מול קבלות שהושלמו',
    interim_vs_receipts: 'חשבוניות ביניים מול קבלות',
  } as const)[channel];
}

export function consolidatedWarningLabel(code: string): string {
  return ({
    consolidated_supplier_unresolved: 'לא ניתן לזהות ספק קנוני באופן חד־משמעי.',
    consolidated_supplier_mismatch: 'הספק שנמצא במסמך שונה מהספק שנבחר לתיק.',
    consolidated_target_month_invalid: 'תאריך החשבונית אינו שייך לחודש הקליטה הנעול.',
    consolidated_duplicate_anchor: 'כבר קיימת חשבונית מרכזת פעילה לספק, לישות ולחודש.',
    consolidated_core_fields_missing: 'חסרים מספר חשבונית, תאריך או סכומי ליבה.',
    consolidated_payable_conflict: 'נמצא חוב נוסף שעלול ליצור ספירה כפולה.',
    consolidated_late_revision_created: 'מסמך מאוחר יצר גרסת התאמה חדשה; החוב לא שונה.',
    supporting_document_pending: 'מסמך תומך עדיין ממתין לתיוק כחשבונית ביניים או כקבלת סחורה.',
    receipt_not_completed: 'קבלת הסחורה עדיין לא הושלמה ולכן אינה מוכיחה כמות שנכנסה.',
    receipt_sources_missing: 'לא נמצאו קבלות סחורה לאותו ספק ולחודש.',
    interim_sources_missing: 'לא נמצאו חשבוניות ביניים לאותו ספק ולחודש.',
    anchor_line_evidence_missing: 'לא נמצאו שורות מוצר תקינות בחשבונית המרכזת.',
    interim_source_line_evidence_missing: 'בחשבונית ביניים חסרות שורות מוצר תקינות להשוואה.',
  } as Record<string, string>)[code] ?? 'נמצא פער שדורש בדיקה בתיק ההתאמה.';
}

export async function listConsolidatedInvoiceLegalEntities(): Promise<ConsolidatedLegalEntity[]> {
  return unwrap(await supabase.rpc('list_consolidated_invoice_legal_entities')) as ConsolidatedLegalEntity[];
}

export async function listConsolidatedInvoiceCases(targetMonth: string): Promise<ConsolidatedInvoiceCaseSummary[]> {
  return unwrap(await supabase.rpc('list_consolidated_invoice_cases', {
    p_target_month: `${targetMonth}-01`,
  })) as ConsolidatedInvoiceCaseSummary[];
}

export async function getConsolidatedInvoiceWorkspace(caseId: string): Promise<ConsolidatedInvoiceWorkspace> {
  const workspace = unwrap(await supabase.rpc('get_consolidated_invoice_workspace', {
    p_case_id: caseId,
  })) as ConsolidatedInvoiceWorkspace;
  return {
    ...workspace,
    intake: workspace.intake ?? null,
    pages: workspace.pages ?? [],
  };
}

export async function openConsolidatedInvoiceIntake(input: {
  supplierId: string;
  targetMonth: string;
  legalEntityId: string;
  pageCount: number;
  idempotencyKey: string;
}): Promise<ConsolidatedInvoiceIntake> {
  return unwrap(await supabase.rpc('open_consolidated_invoice_intake', {
    p_idempotency_key: input.idempotencyKey,
    p_supplier_id: input.supplierId,
    p_target_month: `${input.targetMonth}-01`,
    p_legal_entity_id: input.legalEntityId,
    p_source_page_count: input.pageCount,
  })) as ConsolidatedInvoiceIntake;
}

export async function uploadConsolidatedInvoicePage(input: {
  orgId: string;
  intakeId: string;
  pageNumber: number;
  file: File;
  mimeType: string;
  resume: ConsolidatedPageResume;
  onProgress?: (percent: number) => void;
  registerAbort?: (abort: (() => void | Promise<void>) | null) => void;
  onStored?: () => void;
  onResume?: (resume: ConsolidatedPageResume) => void;
}): Promise<{ registration: ConsolidatedInvoicePageRegistration; resume: ConsolidatedPageResume }> {
  const safeName = input.file.name.replace(/[^\w.\-]+/g, '_');
  const storagePath = input.resume.storagePath
    ?? `${input.orgId}/consolidated-invoices/${input.intakeId}/page-${input.pageNumber}/${safeName}`;
  let resume = input.resume;
  if (!input.resume.storagePath) {
    const handle = tusUploadToDocuments(input.file, {
      objectName: storagePath,
      contentType: input.mimeType,
      onProgress: input.onProgress,
    });
    input.registerAbort?.(handle.abort);
    await handle.done;
    input.registerAbort?.(null);
    input.onStored?.();
    // A storage path becomes resumable only after the source bytes are durable. Persisting it
    // before TUS succeeds would make a retry skip the upload and register a missing object.
    resume = { ...input.resume, storagePath };
    input.onResume?.(resume);
  }
  if (resume.documentId) {
    return {
      resume,
      registration: {
        intake_id: input.intakeId,
        page_id: '',
        page_number: input.pageNumber,
        document_id: resume.documentId,
        storage_path: storagePath,
        idempotent: true,
      },
    };
  }
  const registration = unwrap(await supabase.rpc('register_consolidated_invoice_page', {
    p_intake_id: input.intakeId,
    p_page_number: input.pageNumber,
    p_client_upload_key: resume.clientUploadKey,
    p_storage_path: storagePath,
    p_file_name: input.file.name,
    p_mime_type: input.mimeType,
  })) as ConsolidatedInvoicePageRegistration;
  const registeredResume = { ...resume, documentId: registration.document_id };
  input.onResume?.(registeredResume);
  return { registration, resume: registeredResume };
}

export async function completeConsolidatedInvoiceIntake(input: {
  intakeId: string;
  idempotencyKey: string;
}): Promise<ConsolidatedInvoiceCompletion> {
  const completed = unwrap(await supabase.rpc('complete_consolidated_invoice_intake', {
    p_intake_id: input.intakeId,
    p_idempotency_key: input.idempotencyKey,
  })) as ConsolidatedInvoiceCompletion;
  for (const documentId of completed.document_ids) {
    unwrap(await supabase.rpc('enqueue_document_processing', {
      p_document_id: documentId,
    }));
  }
  return completed;
}

export async function refreshConsolidatedInvoiceReconciliation(input: {
  caseId: string;
  idempotencyKey: string;
  reason: string;
}): Promise<void> {
  unwrap(await supabase.rpc('refresh_consolidated_invoice_reconciliation', {
    p_case_id: input.caseId,
    p_idempotency_key: input.idempotencyKey,
    p_reason: input.reason,
  }));
}
