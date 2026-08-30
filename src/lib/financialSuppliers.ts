import { supabase } from './supabase';
import { fetchAll, fetchInChunks } from './supabasePaging';
import { unwrap } from './useQuery';
import type { SupplierBankDetails, SupplierBankMigrationItem } from './types';
import type { TKey } from './i18n/t.ts';

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

/**
 * A pure module composing a line a person reads, so it takes the translator rather than a
 * language — the precedent `model.ts` and `supplierLogChanges.ts` already set.
 *
 * The account holder, the numbers and `IBAN`/`BIC` are facts and stay exactly as they arrived;
 * only the three Hebrew words naming which number is which were ever copy.
 */
export function formatSupplierBankAccount(
  account: SupplierBankDetails | null | undefined,
  t: (key: TKey, vars?: Record<string, string | number>) => string,
) {
  if (!account) return null;
  if (account.country_code === 'IL') {
    // `?? ''` rather than the previous template's behaviour: an absent code used to interpolate
    // as the literal word `null` onto a payment screen, which reads as data.
    return t('financialSupplier.israeliAccount', {
      holder: account.account_holder,
      bank: account.bank_code ?? '',
      branch: account.branch_code ?? '',
      account: account.account_number ?? '',
    });
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
