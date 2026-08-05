import type { Scalar } from './database-verifier.ts';
import type { LocalVerificationRuntime } from './runtime.ts';
import { createVerificationResult, type VerificationCheck, type VerificationResult } from './types.ts';

export interface EntityIntegrityExpectation {
  id: string;
  table: string;
  rowId: string;
  orgId: string;
  expectedFields?: Record<string, Scalar>;
}

export interface DocumentIntegrityExpectation {
  id: string;
  documentId: string;
  orgId: string;
  expectedDeleted?: boolean;
}

export interface InvoiceFinancialExpectation {
  id: string;
  invoiceId: string;
  orgId: string;
  expectedPaidAmount?: number;
  expectedCreditedAmount?: number;
  expectedBalance?: number;
  expectedPaymentStatus?: string;
  tolerance?: number;
}

export interface DataIntegrityInput {
  entities?: readonly EntityIntegrityExpectation[];
  documents?: readonly DocumentIntegrityExpectation[];
  invoices?: readonly InvoiceFinancialExpectation[];
}

interface QueryResponse<T> {
  data: T | null;
  error: { message?: string } | null;
}

interface ReadOneQuery<T> extends PromiseLike<QueryResponse<T[]>> {
  eq(column: string, value: unknown): ReadOneQuery<T>;
  maybeSingle(): PromiseLike<QueryResponse<T>>;
}

interface SelectOnlyClient {
  from(table: string): {
    select(columns: string): ReadOneQuery<Record<string, unknown>>;
  };
}

function safeIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error('Unsafe database identifier.');
  return value;
}

function numberValue(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) throw new Error('Expected a finite numeric database value.');
  return number;
}

function closeEnough(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

async function verifyEntity(
  client: SelectOnlyClient,
  expectation: EntityIntegrityExpectation,
): Promise<VerificationCheck> {
  const table = safeIdentifier(expectation.table);
  const fields = Object.keys(expectation.expectedFields ?? {}).map(safeIdentifier);
  const columns = [...new Set(['id', 'org_id', ...fields])].join(',');
  const response = await client.from(table).select(columns).eq('id', expectation.rowId).maybeSingle();
  if (response.error || !response.data) {
    return {
      id: expectation.id,
      status: response.error ? 'BLOCKED' : 'FAIL',
      summary: response.error ? `Could not read ${table} integrity evidence.` : `${table} row was not found.`,
      evidence: { table, rowFound: false, errorPresent: Boolean(response.error) },
    };
  }
  const row = response.data;
  const tenantMatches = row.org_id === expectation.orgId;
  const mismatchedFields = Object.entries(expectation.expectedFields ?? {})
    .filter(([field, expected]) => !Object.is(row[field], expected))
    .map(([field]) => field);
  const passed = tenantMatches && mismatchedFields.length === 0;
  return {
    id: expectation.id,
    status: passed ? 'PASS' : 'FAIL',
    summary: passed ? `${table} retained expected tenant and field values.` : `${table} integrity values diverged.`,
    evidence: {
      table,
      rowId: expectation.rowId,
      tenantMatches,
      checkedFields: fields,
      mismatchedFields,
    },
  };
}

async function verifyDocument(
  client: SelectOnlyClient,
  expectation: DocumentIntegrityExpectation,
): Promise<VerificationCheck> {
  const response = await client.from('documents')
    .select('id,org_id,storage_path,deleted_at')
    .eq('id', expectation.documentId)
    .maybeSingle();
  if (response.error || !response.data) {
    return {
      id: expectation.id,
      status: response.error ? 'BLOCKED' : 'FAIL',
      summary: response.error ? 'Could not read document evidence.' : 'Expected document was not found.',
      evidence: { documentId: expectation.documentId, rowFound: false, errorPresent: Boolean(response.error) },
    };
  }
  const row = response.data;
  const tenantMatches = row.org_id === expectation.orgId;
  const storagePathValid = typeof row.storage_path === 'string'
    && row.storage_path.startsWith(`${expectation.orgId}/`);
  const deleted = row.deleted_at !== null;
  const deletionMatches = expectation.expectedDeleted === undefined || deleted === expectation.expectedDeleted;
  const passed = tenantMatches && storagePathValid && deletionMatches;
  return {
    id: expectation.id,
    status: passed ? 'PASS' : 'FAIL',
    summary: passed
      ? 'Document ownership, storage prefix, and deletion state match.'
      : 'Document tenant, storage prefix, or deletion state is invalid.',
    evidence: {
      documentId: expectation.documentId,
      tenantMatches,
      storagePathValid,
      deleted,
      expectedDeleted: expectation.expectedDeleted,
    },
  };
}

async function verifyInvoiceFinancials(
  client: SelectOnlyClient,
  expectation: InvoiceFinancialExpectation,
): Promise<VerificationCheck> {
  const [invoiceResponse, allocationsResponse, creditsResponse] = await Promise.all([
    client.from('invoices')
      .select('id,org_id,total_amount,payment_status,deleted_at')
      .eq('id', expectation.invoiceId)
      .maybeSingle(),
    client.from('payment_allocations')
      .select('id,org_id,invoice_id,credit_id,amount')
      .eq('invoice_id', expectation.invoiceId),
    client.from('credit_requests')
      .select('id,org_id,invoice_id,amount,status')
      .eq('invoice_id', expectation.invoiceId),
  ]);

  if (invoiceResponse.error || allocationsResponse.error || creditsResponse.error) {
    return {
      id: expectation.id,
      status: 'BLOCKED',
      summary: 'Financial SELECT-only evidence could not be acquired.',
      evidence: { invoiceId: expectation.invoiceId, errorPresent: true },
    };
  }
  const invoice = invoiceResponse.data;
  if (!invoice) {
    return {
      id: expectation.id,
      status: 'FAIL',
      summary: 'Expected invoice was not found.',
      evidence: { invoiceId: expectation.invoiceId, rowFound: false },
    };
  }
  const allocations = allocationsResponse.data ?? [];
  const credits = creditsResponse.data ?? [];
  const totalAmount = numberValue(invoice.total_amount);
  const paidAmount = allocations.reduce((sum, row) => sum + numberValue(row.amount), 0);
  const creditedAmount = credits
    .filter((row) => row.status === 'offset' || row.status === 'closed')
    .reduce((sum, row) => sum + numberValue(row.amount), 0);
  const balance = Number((totalAmount - paidAmount - creditedAmount).toFixed(2));
  const computedStatus = balance <= 1 ? 'paid' : paidAmount > 0 ? 'partial' : 'unpaid';
  const tolerance = expectation.tolerance ?? 0.01;
  const tenantMatches = invoice.org_id === expectation.orgId
    && allocations.every((row) => row.org_id === expectation.orgId)
    && credits.every((row) => row.org_id === expectation.orgId);
  const allocationTargetsValid = allocations.every((row) => row.invoice_id === expectation.invoiceId && row.credit_id === null);
  const activeInvoice = invoice.deleted_at === null;
  const expectationsMatch = [
    expectation.expectedPaidAmount === undefined || closeEnough(paidAmount, expectation.expectedPaidAmount, tolerance),
    expectation.expectedCreditedAmount === undefined || closeEnough(creditedAmount, expectation.expectedCreditedAmount, tolerance),
    expectation.expectedBalance === undefined || closeEnough(balance, expectation.expectedBalance, tolerance),
    expectation.expectedPaymentStatus === undefined || invoice.payment_status === expectation.expectedPaymentStatus,
  ].every(Boolean);
  const storedStatusMatchesComputation = invoice.payment_status === computedStatus;
  const passed = tenantMatches && allocationTargetsValid && activeInvoice && expectationsMatch && storedStatusMatchesComputation;

  return {
    id: expectation.id,
    status: passed ? 'PASS' : 'FAIL',
    summary: passed
      ? 'Invoice balance is derived consistently from N:M payment/credit rows.'
      : 'Invoice tenant, allocation targets, computed balance, or payment status diverged.',
    evidence: {
      invoiceId: expectation.invoiceId,
      tenantMatches,
      allocationTargetsValid,
      activeInvoice,
      allocationCount: allocations.length,
      creditCount: credits.length,
      totalAmount,
      paidAmount,
      creditedAmount,
      balance,
      storedPaymentStatus: invoice.payment_status,
      computedPaymentStatus: computedStatus,
      expectationsMatch,
    },
  };
}

export async function verifyDataIntegrity(
  runtime: LocalVerificationRuntime,
  input: DataIntegrityInput,
): Promise<VerificationResult> {
  const client = runtime.createServiceClient() as unknown as SelectOnlyClient;
  const checks: VerificationCheck[] = [];
  for (const expectation of input.entities ?? []) checks.push(await verifyEntity(client, expectation));
  for (const expectation of input.documents ?? []) checks.push(await verifyDocument(client, expectation));
  for (const expectation of input.invoices ?? []) checks.push(await verifyInvoiceFinancials(client, expectation));
  if (checks.length === 0) {
    checks.push({
      id: 'data-integrity-expectations-missing',
      status: 'BLOCKED',
      summary: 'Data-integrity verification requires explicit entity, document, or invoice expectations.',
    });
  }
  return createVerificationResult(
    'data-integrity',
    'Integrity evidence was collected after user actions; the verifier issued no mutations.',
    checks,
    { mutationMethodsExposed: false },
  );
}
