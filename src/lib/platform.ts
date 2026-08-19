// Platform-operator layer: helpers for the cross-tenant admin console.
// The row types live in ./types with the rest of the schema mirror; the `ORG_STATUS` label
// map lives in ./status, which is where the admin screen imports it from.

import { supabase } from './supabase';
import type { OrgStatus, PlatformCustomer, PlatformOrg } from './types';

export type { OrgStatus, PlatformCustomer, PlatformOrg };

/**
 * The capability vocabulary, mirroring private.platform_capability_definitions (0151). This is a
 * display mirror only: the console renders an action when the capability is present, but the
 * refusal that matters happens inside the SECURITY DEFINER command, which asks the database the
 * same question. A capability missing from this union simply never gates anything in the UI.
 */
export type PlatformCapability =
  | 'customer.view'
  | 'usage.view'
  | 'billing.view'
  | 'notes.view'
  | 'notes.add'
  | 'incidents.view'
  | 'onboarding.edit'
  | 'subscription.edit'
  | 'entitlement.override'
  | 'org.lifecycle'
  | 'offboarding.handle'
  | 'platform.export';

/** Attention filters accepted by platform_customers(). An unknown value is rejected by the
    server rather than quietly returning nothing, so this union is the whole set. */
export type CustomerAttention = 'offboarding' | 'suspended' | 'no_users' | 'dormant';

export interface CustomerListRequest {
  search: string;
  status: readonly OrgStatus[];
  attention: CustomerAttention | null;
  page: number;
  pageSize: number;
}

export interface CustomerListResult {
  rows: PlatformCustomer[];
  total: number;
}

/**
 * The operator's own capability set, in one round trip. It exists so the console can tell "you
 * may not do this" apart from "there is nothing here" — a zero-row list read cannot say which.
 */
export async function fetchMyCapabilities(): Promise<PlatformCapability[]> {
  const { data, error } = await supabase.rpc('platform_my_capabilities');
  if (error) throw new Error(error.message);
  return (data ?? []) as PlatformCapability[];
}

export async function fetchPlatformCustomers(
  request: CustomerListRequest,
): Promise<CustomerListResult> {
  const { data, error } = await supabase.rpc('platform_customers', {
    p_search: request.search.trim() || null,
    p_status: request.status.length ? request.status : null,
    p_attention: request.attention,
    p_limit: request.pageSize,
    p_offset: request.page * request.pageSize,
  });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as PlatformCustomer[];
  // total_count rides on every row and is absent from an empty page; an empty page IS a total of
  // zero for the current filter, which is exactly what the pager should then show.
  return { rows, total: rows[0]?.total_count ?? 0 };
}

export interface ProvisionPayload {
  name: string;
  owner_email: string;
  owner_name: string;
  owner_password: string;
  vat_rate?: number;
  categories?: string[];
}

export interface ProvisionResult {
  org_id: string;
  owner_user_id: string;
  categories_created: number;
}

export type AdminOutcome<T> = { ok: true; result: T } | { ok: false; message: string };

/**
 * Calls the admin-provision Edge Function — the only path that may create a tenant or issue a
 * password, because it is the only place the service_role key exists. Unpacks the function's
 * typed error body so the operator sees why it failed instead of a bare "non-2xx status".
 */
async function invokeAdmin<T>(body: Record<string, unknown>): Promise<AdminOutcome<T>> {
  const { data, error } = await supabase.functions.invoke<T>('admin-provision', { body });

  if (error) {
    const context = (error as { context?: Response }).context;
    if (context && typeof context.json === 'function') {
      try {
        const payload = (await context.json()) as { error?: { message?: string; detail?: string } };
        if (payload?.error?.message) {
          return {
            ok: false,
            message: payload.error.detail
              ? `${payload.error.message} (${payload.error.detail})`
              : payload.error.message,
          };
        }
      } catch {
        // response had no JSON body — fall back to the transport error
      }
    }
    return { ok: false, message: error.message };
  }

  if (!data) return { ok: false, message: 'הפונקציה לא החזירה תשובה' };
  return { ok: true, result: data };
}

export function provisionOrg(payload: ProvisionPayload): Promise<AdminOutcome<ProvisionResult>> {
  return invokeAdmin<ProvisionResult>({ ...payload });
}

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';

/** Suggested initial password for a new owner. The operator delivers it out of band. */
export function generatePassword(length = 16): string {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]).join('');
}
