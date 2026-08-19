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
  | 'customer.edit'
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

/* ---------- Wave 2: the customer record (0152) ---------- */

/** `platform_customer_detail()`. Every field a later wave owns — plan, usage, health — is simply
    absent rather than zero; the screen renders nothing for what it cannot yet measure. */
export interface CustomerDetail {
  org_id: string;
  name: string;
  status: OrgStatus;
  vat_rate: number;
  created_at: string;
  access_mode: string;
  active_user_count: number;
  last_activity_at: string | null;
  internal_owner: string | null;
  internal_owner_email: string | null;
  customer_since: string | null;
  open_follow_up_count: number;
  offboarding_status: string | null;
}

export interface CustomerContact {
  id: string;
  kind: 'primary' | 'billing' | 'technical';
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  preferred_channel: 'email' | 'phone' | 'whatsapp' | null;
  updated_at: string;
}

export interface CustomerNote {
  id: string;
  kind: 'note' | 'support' | 'follow_up';
  body: string;
  author_email: string | null;
  created_at: string;
  follow_up_due_at: string | null;
  resolved_at: string | null;
  resolved_by_email: string | null;
  resolution: string | null;
  total_count: number;
}

export interface PlatformTimelineEvent {
  id: string;
  occurred_at: string;
  actor_email: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  old_values: unknown;
  new_values: unknown;
  reason: string;
  correlation_id: string | null;
  total_count: number;
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export interface PlatformOperator {
  user_id: string;
  email: string;
  note: string | null;
  roles: string[];
}

/** The operator roster (0153) — strictly the platform_admins intersection of auth.users, so the
    account-owner picker can never become a directory of the tenants' users. */
export async function fetchPlatformOperators(): Promise<PlatformOperator[]> {
  return (await rpc<PlatformOperator[]>('platform_operators', {})) ?? [];
}

export function fetchCustomerDetail(orgId: string): Promise<CustomerDetail | null> {
  return rpc<CustomerDetail | null>('platform_customer_detail', { p_org_id: orgId });
}

export async function fetchCustomerContacts(orgId: string): Promise<CustomerContact[]> {
  return (await rpc<CustomerContact[]>('platform_customer_contacts', { p_org_id: orgId })) ?? [];
}

export async function fetchCustomerNotes(orgId: string): Promise<CustomerNote[]> {
  return (await rpc<CustomerNote[]>('platform_customer_notes', { p_org_id: orgId })) ?? [];
}

export async function fetchCustomerTimeline(orgId: string): Promise<PlatformTimelineEvent[]> {
  return (await rpc<PlatformTimelineEvent[]>('platform_customer_timeline', { p_org_id: orgId })) ?? [];
}

export function setCustomerAccount(input: {
  orgId: string; internalOwner: string | null; customerSince: string | null; reason: string;
}): Promise<unknown> {
  return rpc('platform_set_customer_account', {
    p_org_id: input.orgId,
    p_internal_owner: input.internalOwner,
    p_customer_since: input.customerSince,
    p_reason: input.reason,
  });
}

export function upsertCustomerContact(input: {
  orgId: string; kind: string; name: string; title: string | null;
  email: string | null; phone: string | null; preferredChannel: string | null; reason: string;
}): Promise<unknown> {
  return rpc('platform_upsert_customer_contact', {
    p_org_id: input.orgId,
    p_kind: input.kind,
    p_name: input.name,
    p_title: input.title,
    p_email: input.email,
    p_phone: input.phone,
    p_preferred_channel: input.preferredChannel,
    p_reason: input.reason,
  });
}

export function removeCustomerContact(contactId: string, reason: string): Promise<unknown> {
  return rpc('platform_remove_customer_contact', { p_contact_id: contactId, p_reason: reason });
}

/** No reason argument, deliberately: the note body IS the reason, and demanding a second
    sentence to justify writing the first is how "asdf" ends up in a ledger. */
export function addInternalNote(input: {
  orgId: string; kind: string; body: string; followUpDueAt: string | null;
}): Promise<unknown> {
  return rpc('platform_add_internal_note', {
    p_org_id: input.orgId,
    p_kind: input.kind,
    p_body: input.body,
    p_follow_up_due_at: input.followUpDueAt,
  });
}

export function resolveFollowUp(noteId: string, resolution: string): Promise<unknown> {
  return rpc('platform_resolve_follow_up', { p_note_id: noteId, p_resolution: resolution });
}
