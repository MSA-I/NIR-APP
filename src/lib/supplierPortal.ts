import { supabase } from './supabase';
import { toHebrewError } from './errors';
import type { SupplierOrderLink, SupplierOrderProposal, SupplierOrderProposalLine } from './types';

// Tenant-side surface of the supplier portal (0167): issuing and revoking links, reading the
// proposal, deciding on it, and creating a revision. All writes are reasoned RPCs; the raw
// token exists only in the issue response and is the caller's to hand to the supplier.

/** The portal URL puts the token in the FRAGMENT so it never reaches server or CDN logs. */
export function buildPortalUrl(token: string, origin = window.location.origin): string {
  return `${origin}/portal#token=${token}`;
}

export type LinkState = 'live' | 'submitted' | 'expired' | 'revoked';

export function linkState(link: SupplierOrderLink): LinkState {
  if (link.revoked_at) return 'revoked';
  if (link.submitted_at) return 'submitted';
  if (new Date(link.expires_at).getTime() < Date.now()) return 'expired';
  return 'live';
}

export async function fetchOrderLink(orderId: string): Promise<SupplierOrderLink | null> {
  const res = await supabase.from('supplier_order_links')
    .select('id, org_id, purchase_order_id, supplier_id, expires_at, issued_by, opened_at, open_count, submitted_at, revoked_at, revoked_by, revoked_reason, failed_attempts, locked_until, created_at, updated_at')
    .eq('purchase_order_id', orderId)
    .is('revoked_at', null)
    .maybeSingle();
  if (res.error) throw new Error(toHebrewError(res.error.message));
  return res.data as SupplierOrderLink | null;
}

export interface IssuedLink {
  link_id: string;
  token: string;
  expires_at: string;
  order_number: number;
}

export async function issueOrderLink(orderId: string, reason: string): Promise<IssuedLink> {
  const res = await supabase.rpc('issue_supplier_order_link', {
    p_order_id: orderId,
    p_reason: reason,
  });
  if (res.error) throw new Error(toHebrewError(res.error.message));
  return res.data as IssuedLink;
}

export async function revokeOrderLink(linkId: string, reason: string): Promise<void> {
  const res = await supabase.rpc('revoke_supplier_order_link', {
    p_link_id: linkId,
    p_reason: reason,
  });
  if (res.error) throw new Error(toHebrewError(res.error.message));
}

export type ProposalWithLines = SupplierOrderProposal & { lines: SupplierOrderProposalLine[] };

export async function fetchOrderProposal(orderId: string): Promise<ProposalWithLines | null> {
  const res = await supabase.from('supplier_order_proposals')
    .select('*, lines:supplier_order_proposal_lines(*)')
    .eq('purchase_order_id', orderId)
    .order('submitted_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (res.error) throw new Error(toHebrewError(res.error.message));
  if (!res.data) return null;
  const proposal = res.data as ProposalWithLines;
  proposal.lines.sort((a, b) => a.position - b.position);
  return proposal;
}

export async function fetchProposal(proposalId: string): Promise<ProposalWithLines | null> {
  const res = await supabase.from('supplier_order_proposals')
    .select('*, lines:supplier_order_proposal_lines(*)')
    .eq('id', proposalId)
    .maybeSingle();
  if (res.error) throw new Error(toHebrewError(res.error.message));
  if (!res.data) return null;
  const proposal = res.data as ProposalWithLines;
  proposal.lines.sort((a, b) => a.position - b.position);
  return proposal;
}

export interface ProposalDecisionInput {
  lineDecisions: { line_id: string; decision: 'accepted' | 'rejected' }[];
  acceptDeliveryDate: boolean;
  reason: string | null;
}

export async function decideProposal(proposalId: string, input: ProposalDecisionInput): Promise<void> {
  const res = await supabase.rpc('decide_supplier_order_proposal', {
    p_proposal_id: proposalId,
    p_line_decisions: input.lineDecisions,
    p_accept_delivery_date: input.acceptDeliveryDate,
    p_reason: input.reason,
  });
  if (res.error) throw new Error(toHebrewError(res.error.message));
}

export async function createRevisionFromProposal(proposalId: string, reason: string): Promise<string> {
  const res = await supabase.rpc('create_purchase_order_revision_from_proposal', {
    p_proposal_id: proposalId,
    p_reason: reason,
  });
  if (res.error) throw new Error(toHebrewError(res.error.message));
  return res.data as string;
}
