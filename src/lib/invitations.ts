// Employee invitations — client side of supabase/migrations/0007_invitations.sql.
//
// Labels/tones live in status.ts (INVITATION_STATUS). `Invitation` is here rather than in
// types.ts only because that file belongs to another workstream; fold it in when convenient.

import { supabase } from './supabase';
import type { Invitation, InvitationStatus, Role } from './types';

/** Roles an owner may invite. `supplier` is excluded — a supplier agent profile needs a
 *  supplier_id (migration 0004) that this flow has no way to supply, and the DB refuses it. */
export const INVITABLE_ROLES: Role[] = ['owner', 'office', 'kitchen', 'payer', 'accountant'];

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
    return { error: error.message, result: null };
  }

  const failed = (data as { error?: InviteError } | null)?.error;
  if (failed) return { error: failed.message, result: null };
  return { error: null, result: data as InviteResult };
}

export const sendInvite = (email: string, role: Role) =>
  callSendInvite({ action: 'create', email, role });

export const resendInvite = (invitationId: string) =>
  callSendInvite({ action: 'resend', invitationId });

export async function revokeInvite(invitationId: string): Promise<string | null> {
  const { error } = await supabase.rpc('revoke_invitation', { p_id: invitationId });
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

export async function acceptInvitation(token: string, fullName: string, phone: string) {
  const { data, error } = await supabase.rpc('accept_invitation', {
    p_token: token,
    p_full_name: fullName,
    p_phone: phone || null,
  });
  if (error) throw new Error(error.message);
  return data as { org_id: string; role: Role };
}

/** DB-side codes (0007) → Hebrew. Anything unmapped falls back to the raw message. */
export const ACCEPT_ERROR: Record<string, string> = {
  invitation_unknown: 'קישור ההזמנה אינו תקין. בקש מהעסק לשלוח הזמנה חדשה.',
  invitation_expired: 'תוקף ההזמנה פג. בקש מהעסק לשלוח הזמנה חדשה.',
  invitation_accepted: 'ההזמנה כבר נוצלה. אפשר להתחבר עם הפרטים שהוגדרו.',
  invitation_revoked: 'ההזמנה בוטלה על ידי העסק.',
  email_mismatch: 'כתובת האימייל של החשבון אינה תואמת לזו שההזמנה נשלחה אליה.',
  profile_exists: 'החשבון הזה כבר משויך לעסק במערכת.',
  org_suspended: 'חשבון העסק מושהה. יש לפנות לעסק שהזמין אותך.',
  full_name_required: 'יש להזין שם מלא.',
  not_authenticated: 'ההתחברות נכשלה. נסה שוב.',
};

export function acceptErrorMessage(raw: string): string {
  const key = Object.keys(ACCEPT_ERROR).find((k) => raw.includes(k));
  return key ? ACCEPT_ERROR[key] : raw;
}
