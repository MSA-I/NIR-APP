import type { LocalVerificationRuntime } from './runtime.ts';
import { createVerificationResult, type VerificationCheck, type VerificationResult } from './types.ts';

export type Scalar = string | number | boolean | null;

export interface DatabaseFilter {
  column: string;
  operator: 'eq' | 'is' | 'in';
  value: Scalar | Scalar[];
}

export interface DatabaseRowExpectation {
  id: string;
  table: string;
  select: string;
  filters?: DatabaseFilter[];
  expectedCount?: number;
  minCount?: number;
  maxCount?: number;
  expectedSubsets?: Array<Record<string, Scalar>>;
}

interface QueryResponse {
  data: unknown;
  error: { message?: string } | null;
  count: number | null;
}

interface ReadQuery extends PromiseLike<QueryResponse> {
  eq(column: string, value: unknown): ReadQuery;
  is(column: string, value: null | boolean): ReadQuery;
  in(column: string, values: readonly unknown[]): ReadQuery;
}

interface SelectOnlyClient {
  from(table: string): {
    select(columns: string, options: { count: 'exact' }): ReadQuery;
  };
}

function safeIdentifier(value: string, label: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`${label} contains unsafe characters.`);
  return value;
}

function safeSelect(value: string): string {
  if (!/^[a-z0-9_*,().:!\s-]+$/i.test(value) || value.includes(';')) {
    throw new Error('Database select expression contains unsafe characters.');
  }
  return value;
}

function asRows(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object');
}

function rowContains(row: Record<string, unknown>, expected: Record<string, Scalar>): boolean {
  return Object.entries(expected).every(([key, value]) => Object.is(row[key], value));
}

async function verifyExpectation(
  client: SelectOnlyClient,
  expectation: DatabaseRowExpectation,
): Promise<VerificationCheck> {
  const table = safeIdentifier(expectation.table, 'table');
  let query = client.from(table).select(safeSelect(expectation.select), { count: 'exact' });
  for (const filter of expectation.filters ?? []) {
    const column = safeIdentifier(filter.column, 'filter column');
    if (filter.operator === 'eq') query = query.eq(column, filter.value);
    else if (filter.operator === 'is') {
      const value = filter.value;
      if (!(value === null || typeof value === 'boolean')) {
        throw new Error('is filters accept only null or boolean values.');
      }
      query = query.is(column, value);
    } else {
      if (!Array.isArray(filter.value)) throw new Error('in filters require an array.');
      query = query.in(column, filter.value);
    }
  }

  const response = await query;
  if (response.error) {
    return {
      id: expectation.id,
      status: 'BLOCKED',
      summary: `SELECT-only verification could not read ${table}.`,
      evidence: { table, errorPresent: true },
    };
  }
  const rows = asRows(response.data);
  const count = response.count ?? rows.length;
  const failures: string[] = [];
  if (expectation.expectedCount !== undefined && count !== expectation.expectedCount) failures.push('exact count');
  if (expectation.minCount !== undefined && count < expectation.minCount) failures.push('minimum count');
  if (expectation.maxCount !== undefined && count > expectation.maxCount) failures.push('maximum count');
  let matchedSubsets = 0;
  for (const subset of expectation.expectedSubsets ?? []) {
    if (rows.some((row) => rowContains(row, subset))) matchedSubsets += 1;
  }
  if (matchedSubsets !== (expectation.expectedSubsets?.length ?? 0)) failures.push('expected row subsets');

  return {
    id: expectation.id,
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    summary: failures.length === 0
      ? `${table} matched the declared SELECT-only expectation.`
      : `${table} failed: ${failures.join(', ')}.`,
    evidence: {
      table,
      observedCount: count,
      expectedCount: expectation.expectedCount,
      minCount: expectation.minCount,
      maxCount: expectation.maxCount,
      expectedSubsetCount: expectation.expectedSubsets?.length ?? 0,
      matchedSubsets,
      filterColumns: (expectation.filters ?? []).map(({ column }) => column),
    },
  };
}

export async function verifyDatabaseRows(
  runtime: LocalVerificationRuntime,
  expectations: readonly DatabaseRowExpectation[],
): Promise<VerificationResult> {
  if (expectations.length === 0) {
    return createVerificationResult('database', 'No database expectations were supplied.', [{
      id: 'database-expectations-missing',
      status: 'BLOCKED',
      summary: 'A database verifier cannot PASS without explicit expected rows/counts.',
    }]);
  }
  const client = runtime.createServiceClient() as unknown as SelectOnlyClient;
  const checks: VerificationCheck[] = [];
  for (const expectation of expectations) checks.push(await verifyExpectation(client, expectation));
  return createVerificationResult(
    'database',
    'Service-role evidence was acquired with SELECT-only query builders.',
    checks,
    { expectationCount: expectations.length, mutationMethodsExposed: false },
  );
}
