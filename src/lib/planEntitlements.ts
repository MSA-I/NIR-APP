import { useQuery } from '@tanstack/react-query';
import { supabase } from './supabase';
import { DOMAIN, key } from './query/keys';
import { useOrgScope } from './query/orgScope';

export type DisplayCurrency = 'ILS' | 'USD';

export interface PlanEntitlementRow {
  entitlement_key: string;
  kind: 'numeric' | 'boolean';
  label: string;
  boolean_value: boolean | null;
  measured: boolean;
  source: 'plan' | 'intro' | 'override' | 'unavailable';
  /**
   * The numeric half of the same row. `my_entitlements()` has returned both since 0154 — the
   * ceiling and whether there is one — and this interface simply did not name them, because until
   * `OWN-06` the only reader was the capability gate in `App.tsx`. Naming a column the server
   * already sends is not a contract change; leaving it unnamed is how a screen ends up refetching
   * the same answer from a second place.
   */
  unlimited: boolean;
  numeric_limit: number | null;
}

export interface PlanFeatureRowData {
  plan_key: string;
  entitlement_key: string;
  label: string;
  display_order: number;
  included: boolean;
  intro_included: boolean;
}

export interface PlanCataloguePriceRow {
  plan_key: string;
  currency: DisplayCurrency;
  monthly_amount: number | null;
  yearly_amount: number | null;
}

/** Display choice only. Billing remains bound to the verified MoR country (#208/#295). */
export function displayCurrencyForLanguage(language: string | null | undefined): DisplayCurrency {
  const normalized = (language ?? '').trim().toLowerCase();
  return normalized === '' || normalized.startsWith('he') ? 'ILS' : 'USD';
}

export function usePlanEntitlements(enabled = true) {
  const org = useOrgScope();
  return useQuery({
    queryKey: key(org, DOMAIN.subscription, 'entitlements'),
    queryFn: async () => {
      const { data, error } = await supabase.rpc('my_entitlements');
      if (error) throw new Error(error.message);
      return (data ?? []) as PlanEntitlementRow[];
    },
    enabled: enabled && org !== null,
  });
}

export function capabilityValue(
  rows: readonly PlanEntitlementRow[] | undefined,
  entitlementKey: string,
): boolean | null {
  const row = rows?.find((candidate) => candidate.entitlement_key === entitlementKey);
  if (!row || row.kind !== 'boolean' || !row.measured || row.boolean_value === null) return null;
  return row.boolean_value;
}
