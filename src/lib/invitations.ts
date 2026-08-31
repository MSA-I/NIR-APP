// Employee invitations — client side of supabase/migrations/0007_invitations.sql.
//
// Labels/tones live in status.ts (INVITATION_STATUS). `Invitation` is here rather than in
// types.ts only because that file belongs to another workstream; fold it in when convenient.

import { supabase } from './supabase';
import type { ActiveRole, Invitation, InvitationStatus, Role } from './types';

/** The only three product personas. The frozen enum still carries retired historical values. */
export const INVITABLE_ROLES: ActiveRole[] = ['owner', 'office', 'accountant'];
export const ASSIGNABLE_ROLES: ActiveRole[] = ['owner', 'office', 'accountant'];

// Invitation / InvitationStatus live in ./types with the rest of the schema mirror.
export type { Invitation, InvitationStatus };

/** Columns safe to read client-side — deliberately omits token_hash. */
export const INVITATION_COLUMNS =
  'id, org_id, email, role, expires_at, accepted_at, revoked_at, invited_by, last_sent_at, send_count, created_at';

export function invitationStatusOf(inv: Invitation): InvitationStatus {
  if (inv.revoked_at) return 'revoked';
  if (inv.accepted_at) return 'accepted';
  if (new Date(inv.expires_at) <= new Date()) return 'expired';
  return 'pending';
}

/* ---------- Owner side (through the Edge Function, which holds the Resend key) ---------- */

interface InviteError { code: string; message: string }

export interface InviteResult {
  ok: true;
  invitationId: string;
  email: string;
  expiresAt: string;
  /**
   * True when the Edge Function is configured with Resend's sandbox sender, which accepts the
   * request and then delivers only to the Resend account owner (DEBT-REGISTER §25). Absent on an
   * older deployed function, and treated as "not limited" then — the screen degrades to the old
   * wording rather than inventing a warning it cannot support.
   */
  deliveryLimited?: boolean;
}

/** `error` is a Hebrew message ready to show the owner; `result` is set only on success. */
async function callSendInvite(
  body: Record<string, unknown>,
): Promise<{ error: string | null; result: InviteResult | null }> {
  const { data, error } = await supabase.functions.invoke('send-invite', { body });

  if (error) {
    // supabase-js swallows the response body on non-2xx; dig it out so the user sees the
    // real reason ("already a member") instead of "Edge Function returned a non-2xx status".
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      try {
        const parsed = await ctx.json() as { error?: InviteError };
        if (parsed?.error?.message) return { error: parsed.error.message, result: null };
      } catch { /* fall through to the generic message */ }
    }
    // Reached only when the Edge body could not be parsed, i.e. a transport failure — always a
    // machine string, never one of the function's own Hebrew messages (those return above). The
    // owner used to see "Failed to fetch" in a toast.
    return { error: error instanceof Error ? error.message : String(error), result: null };
  }

  const failed = (data as { error?: InviteError } | null)?.error;
  if (failed) return { error: failed.message, result: null };
  return { error: null, result: data as InviteResult };
}

export const sendInvite = (email: string, role: ActiveRole) =>
  callSendInvite({ action: 'create', email, role });

export const resendInvite = (invitationId: string) =>
  callSendInvite({ action: 'resend', invitationId });

export async function revokeInvite(invitationId: string, reason: string): Promise<string | null> {
  const { error } = await supabase.rpc('revoke_invitation', {
    p_id: invitationId,
    p_reason: reason,
  });
  // Raw Postgres otherwise — the owner cancelling an invitation is not the audience for it.
  return error ? error.message : null;
}

/* ---------- Invitee side (public, no session yet) ---------- */

export type LookupStatus = 'valid' | 'expired' | 'accepted' | 'revoked' | 'unknown';

export interface InvitationLookup {
  status: LookupStatus;
  email?: string;
  role?: Role;
  org_name?: string;
  /** The inviting org's `settings.role_labels`, if it set any — the invitee has no session,
   *  so useAuth().roleLabels cannot resolve them. Feed to resolveRoleLabels(). */
  role_labels?: unknown;
  expires_at?: string;
}

export async function lookupInvitation(token: string): Promise<InvitationLookup> {
  const { data, error } = await supabase.rpc('lookup_invitation', { p_token: token });
  if (error) throw new Error(error.message);
  return data as InvitationLookup;
}

/** `termsVersion` is not decoration: 0089 closed the consent-free signature, and the server
 *  stamps the consented version into audit_logs in the same transaction that creates the
 *  profile.
 *
 *  `token` may be null (`0282`). An employee who signs in with a provider never receives one —
 *  the token lives in an email this deployment cannot yet deliver (`DEBT §25`) — so the server
 *  resolves the invitation from the caller's own CONFIRMED address instead. That is the same
 *  binding the token always stood for: an invitation belongs to an address, and the link was only
 *  ever evidence of delivery to it. Everything after the lookup is the same code on both paths. */
export async function acceptInvitation(token: string | null, fullName: string, phone: string, termsVersion: string) {
  const { data, error } = await supabase.rpc('accept_invitation', {
    p_token: token,
    p_full_name: fullName,
    p_phone: phone || null,
    p_terms_version: termsVersion,
  });
  if (error) throw new Error(error.message);
  return data as { org_id: string; role: Role };
}

/**
 * The DB-side codes (0007) this screen can meet.
 *
 * The wording used to live here as a private Hebrew map. That made the INVITEE — a person with no
 * account yet, no session, and nobody in the product to ask — the one reader whose failures came
 * from a second vocabulary. All ten are registered in src/lib/errors.ts now, so the raw code is
 * simply passed through and resolved where it is drawn, in the invitee's own language.
 */
export const ACCEPT_ERROR_CODES = [
  'invitation_unknown', 'invitation_expired', 'invitation_accepted', 'invitation_revoked',
  'email_mismatch', 'profile_exists', 'org_suspended', 'full_name_required',
  'not_authenticated', 'terms_consent_required',
] as const;

/** The matched code, or the raw message when nothing matched — either resolves at the screen. */
export function acceptErrorCondition(raw: string): string {
  return ACCEPT_ERROR_CODES.find((code) => raw.includes(code)) ?? raw;
}
