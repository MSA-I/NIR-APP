import { supabase } from './supabase';
import { fetchAll, fetchInChunks } from './supabasePaging';

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
