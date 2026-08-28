// The supplier portal's only data channel: the supplier-portal Edge Function, POST-only so the
// bearer token never appears in a URL. No Supabase client, no session, no tenant surface — the
// portal page must stay incapable of reaching anything beyond its one snapshotted order.

export interface PortalSnapshotItem {
  order_item_id: string;
  position: number;
  product_name: string;
  unit: string | null;
  qty: number;
  unit_price: number;
}

export interface PortalSnapshot {
  order_id: string;
  order_number: number;
  revision_number: number;
  expected_date: string | null;
  notes: string | null;
  supplier_name: string | null;
  org_name: string;
  /**
   * The order's currency, as the snapshot recorded it.
   *
   * OPTIONAL, and deliberately so: a snapshot is EVIDENCE — the exact sheet a supplier was sent —
   * and evidence is never rewritten. Snapshots issued before the currency existed carry no such
   * field, and their currency is decided by INTERPRETATION at read time (see `portalCurrency`),
   * not by editing what was signed.
   */
  currency?: string;
  issued_at: string;
  items: PortalSnapshotItem[];
}

export interface PortalProposalSummary {
  status: 'submitted' | 'accepted' | 'partially_accepted' | 'rejected';
  submitted_at: string;
  proposed_delivery_date: string | null;
  total_delta: number;
}

export interface PortalView {
  state: 'open' | 'submitted';
  snapshot: PortalSnapshot;
  expires_at: string;
  proposal: PortalProposalSummary | null;
}

export interface PortalProposalLineInput {
  order_item_id: string;
  proposed_qty?: number | null;
  proposed_unit_price?: number | null;
  availability: 'available' | 'unavailable';
  replacement_note?: string | null;
}

export interface PortalProposalInput {
  proposed_delivery_date?: string | null;
  supplier_note?: string | null;
  lines: PortalProposalLineInput[];
}

export type PortalErrorCode =
  | 'link_invalid' | 'rate_limited' | 'proposal_already_submitted'
  | 'proposal_invalid' | 'service_unavailable' | 'invalid_request';

export class PortalError extends Error {
  readonly code: PortalErrorCode;
  constructor(code: PortalErrorCode) {
    super(code);
    this.code = code;
  }
}

const ENDPOINT = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/supplier-portal`;

async function call<T>(body: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new PortalError('service_unavailable');
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = (payload as { error?: string } | null)?.error;
    throw new PortalError(
      code === 'link_invalid' || code === 'rate_limited'
        || code === 'proposal_already_submitted' || code === 'proposal_invalid'
        ? code
        : 'service_unavailable');
  }
  return payload as T;
}

export function resolvePortalLink(token: string): Promise<PortalView> {
  return call<PortalView>({ action: 'resolve', token });
}

export function submitPortalProposal(
  token: string,
  proposal: PortalProposalInput,
): Promise<{ proposal_id: string; status: string; replayed?: boolean }> {
  return call({ action: 'submit', token, proposal });
}

/** The token travels in the URL FRAGMENT (#token=...) so it never reaches server logs; the
 *  query form (?t=) is accepted as a fallback for channels that strip fragments. */
export function tokenFromLocation(hash: string, search: string): string | null {
  const fromHash = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash).get('token');
  const fromQuery = new URLSearchParams(search).get('t');
  const raw = (fromHash ?? fromQuery ?? '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(raw) ? raw : null;
}
