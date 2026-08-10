// Platform-operator layer: helpers for the cross-tenant admin console.
// The row types live in ./types with the rest of the schema mirror; the `ORG_STATUS` label
// map lives in ./status, which is where the admin screen imports it from.

import { supabase } from './supabase';
import type { OrgStatus, PlatformOrg } from './types';

export type { OrgStatus, PlatformOrg };

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
