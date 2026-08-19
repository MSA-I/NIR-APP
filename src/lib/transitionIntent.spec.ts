import { describe, expect, it } from 'vitest';
import { reasonDemandFor, type ReasonDemand, type TransitionEntity } from './transitionIntent';

/**
 * The pairs that matter, stated as data.
 *
 * Every `from` here is a status the app can actually be sitting in, and every `to` is one a button
 * on the screen can reach — the invoice actions in `INVOICE_REVIEW_ACTIONS` and the payment-request
 * buttons in `PaymentRequests`. The server graphs (0023 for invoices, 0073 for payment requests)
 * decide which of these are legal at all; this table only says which of them owe a sentence.
 */
const CASES: { entity: TransitionEntity; from: string; to: string; exceptional?: boolean; demand: ReasonDemand; why: string }[] = [
  // ── invoice_review: the ordinary ladder, the thing the owner complained about ──────────────
  { entity: 'invoice_review', from: 'received', to: 'in_review', demand: null, why: 'העברה לבדיקה — one rung up' },
  { entity: 'invoice_review', from: 'in_review', to: 'pending_approval', demand: null, why: 'העברה לאישור' },
  { entity: 'invoice_review', from: 'pending_approval', to: 'approved', demand: null, why: 'אישור לתשלום' },
  // Skipping a rung is still forward: the server allows in_review → approved directly (0023).
  { entity: 'invoice_review', from: 'in_review', to: 'approved', demand: null, why: 'forward, two rungs' },

  // ── invoice_review: the moves that owe an explanation ──────────────────────────────────────
  { entity: 'invoice_review', from: 'received', to: 'investigation', demand: 'investigation', why: 'סימון לבירור' },
  { entity: 'invoice_review', from: 'in_review', to: 'investigation', demand: 'investigation', why: 'סימון לבירור' },
  // OPEN-DECISIONS #105: the server has always allowed this, and it is exactly when a reason helps.
  { entity: 'invoice_review', from: 'approved', to: 'investigation', demand: 'investigation', why: 'a problem found after approval' },
  { entity: 'invoice_review', from: 'investigation', to: 'pending_approval', demand: 'backward', why: 'leaving an investigation — what was found?' },
  { entity: 'invoice_review', from: 'approved', to: 'in_review', demand: 'backward', why: 'undoing an approval' },
  { entity: 'invoice_review', from: 'pending_approval', to: 'in_review', demand: 'backward', why: 'sent back for more checking' },

  // ── payment_request: the ordinary ladder ───────────────────────────────────────────────────
  { entity: 'payment_request', from: 'draft', to: 'pending_approval', demand: null, why: 'שליחה לאישור' },
  { entity: 'payment_request', from: 'pending_approval', to: 'approved', demand: null, why: 'אישור הדרישה' },
  { entity: 'payment_request', from: 'approved', to: 'sent_for_execution', demand: null, why: 'העברה לגורם המבצע' },
  { entity: 'payment_request', from: 'sent_for_execution', to: 'executed', demand: null, why: 'the money moved' },
  { entity: 'payment_request', from: 'executed', to: 'matched', demand: null, why: 'bank line matched' },

  // ── payment_request: the moves that owe an explanation ─────────────────────────────────────
  { entity: 'payment_request', from: 'draft', to: 'cancelled', demand: 'cancel', why: 'ביטול' },
  { entity: 'payment_request', from: 'pending_approval', to: 'cancelled', demand: 'cancel', why: 'ביטול' },
  { entity: 'payment_request', from: 'approved', to: 'cancelled', demand: 'cancel', why: 'ביטול — after approval' },
  { entity: 'payment_request', from: 'sent_for_execution', to: 'cancelled', demand: 'cancel', why: 'ביטול — money already on its way' },
  { entity: 'payment_request', from: 'draft', to: 'investigation', demand: 'investigation', why: 'diverted out of the flow' },
  { entity: 'payment_request', from: 'pending_approval', to: 'investigation', demand: 'investigation', why: 'diverted out of the flow' },
  // Approving out of investigation or a duplicate suspicion is a return to the flow after a doubt.
  { entity: 'payment_request', from: 'investigation', to: 'approved', demand: 'backward', why: 'what resolved the investigation?' },
  { entity: 'payment_request', from: 'suspected_duplicate', to: 'approved', demand: 'backward', why: 'why is it not a duplicate?' },
  { entity: 'payment_request', from: 'approved', to: 'pending_approval', demand: 'backward', why: 'un-approving' },

  // ── the exceptional flag wins over everything, including an ordinary forward step ───────────
  { entity: 'payment_request', from: 'pending_approval', to: 'approved', exceptional: true, demand: 'exceptional_approval', why: 'אישור למרות האזהרות' },
  { entity: 'payment_request', from: 'draft', to: 'pending_approval', exceptional: true, demand: 'exceptional_approval', why: 'flag beats the ladder' },
  { entity: 'invoice_review', from: 'pending_approval', to: 'approved', exceptional: true, demand: 'exceptional_approval', why: 'flag beats the ladder' },
];

describe('reasonDemandFor — a dialog only where a sentence is owed', () => {
  for (const testCase of CASES) {
    const label = testCase.exceptional ? `${testCase.from} → ${testCase.to} (חריג)` : `${testCase.from} → ${testCase.to}`;
    it(`${testCase.entity}: ${label} → ${testCase.demand ?? 'no dialog'} — ${testCase.why}`, () => {
      expect(reasonDemandFor(
        testCase.entity, testCase.from, testCase.to,
        testCase.exceptional ? { exceptional: true } : undefined,
      )).toBe(testCase.demand);
    });
  }

  it('covers every always-reasoned destination the app can reach', () => {
    // The point of the table above: no destination that always demands a reason may be missing
    // from it. If one is added to the module and not here, this fails.
    const reached = new Set(CASES.filter((c) => !c.exceptional).map((c) => `${c.entity}:${c.to}`));
    expect(reached.has('invoice_review:investigation')).toBe(true);
    expect(reached.has('payment_request:investigation')).toBe(true);
    expect(reached.has('payment_request:cancelled')).toBe(true);
  });

  it('asks when it does not recognise where the record is coming from', () => {
    // An unknown status is not evidence that the move is routine. Falling to "ask" keeps a status
    // added later from silently becoming an unexplained one-tap transition.
    expect(reasonDemandFor('invoice_review', 'a_status_added_later', 'approved')).toBe('backward');
    expect(reasonDemandFor('payment_request', 'cancelled', 'pending_approval')).toBe('backward');
  });

  it('asks when it does not recognise where the record is going', () => {
    expect(reasonDemandFor('payment_request', 'draft', 'suspected_duplicate')).toBe('backward');
  });

  it('does not treat a no-op as a step forward', () => {
    expect(reasonDemandFor('invoice_review', 'approved', 'approved')).toBe('backward');
    expect(reasonDemandFor('payment_request', 'draft', 'draft')).toBe('backward');
  });
});
