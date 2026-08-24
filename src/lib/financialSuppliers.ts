import { supabase } from './supabase';
import { fetchAll, fetchInChunks } from './supabasePaging';
import { unwrap } from './useQuery';
import type { SupplierBankDetails, SupplierBankMigrationItem } from './types';

export interface FinancialSupplierDirectoryRow {
  id: string;
  name: string;
  tax_id: string | null;
  payment_terms: string | null;
  status: string;
  bank_details: string | null;
}

const readPage = (ids?: readonly string[]) => fetchAll<FinancialSupplierDirectoryRow>((from, to) => {
  let query = supabase.from('financial_supplier_directory')
    .select('id, name, tax_id, payment_terms, status, bank_details')
    .order('id').range(from, to);
  if (ids) query = query.in('id', [...ids]);
  return query;
});

export async function readFinancialSuppliers(ids?: readonly string[]) {
  if (!ids) return readPage();
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return [];
  return fetchInChunks(unique, (chunk) => readPage(chunk));
}

export async function financialSupplierMap(ids: readonly string[]) {
  return new Map((await readFinancialSuppliers(ids)).map((supplier) => [supplier.id, supplier]));
}

const readBankAccountPage = (ids: readonly string[]) => fetchAll<SupplierBankDetails>((from, to) =>
  supabase.from('financial_supplier_bank_accounts')
    .select('supplier_id, account_holder, country_code, bank_code, branch_code, account_number, iban, bic, migration_pending')
    .in('supplier_id', [...ids])
    .order('supplier_id')
    .range(from, to));

export async function financialSupplierBankAccountMap(ids: readonly string[]) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map<string, SupplierBankDetails>();
  const rows = await fetchInChunks(unique, (chunk) => readBankAccountPage(chunk));
  return new Map(rows.map((account) => [account.supplier_id!, account]));
}

export function formatSupplierBankAccount(account: SupplierBankDetails | null | undefined) {
  if (!account) return null;
  if (account.country_code === 'IL') {
    return `${account.account_holder} · בנק ${account.bank_code} · סניף ${account.branch_code} · חשבון ${account.account_number}`;
  }
  return `${account.account_holder} · IBAN ${account.iban}${account.bic ? ` · BIC ${account.bic}` : ''}`;
}

export async function readFinancialSupplierBankAccount(supplierId: string) {
  const result = unwrap(await supabase.from('financial_supplier_bank_accounts')
    .select('supplier_id, account_holder, country_code, bank_code, branch_code, account_number, iban, bic, migration_pending')
    .eq('supplier_id', supplierId)
    .maybeSingle()) as SupplierBankDetails | null;
  return result;
}

export async function readSupplierBankMigrationItem(supplierId: string) {
  const rows = unwrap(await supabase.rpc('read_supplier_bank_migration_item', {
    p_supplier_id: supplierId,
  })) as SupplierBankMigrationItem[];
  return rows[0] ?? null;
}
