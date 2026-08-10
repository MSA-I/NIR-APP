import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/** Nothing here reaches a server: the re-read is exercised through the browser gate, not here. */
vi.mock('../lib/supabase', () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    rpc: async () => ({ data: null, error: null }),
    auth: { getSession: async () => ({ data: { session: null }, error: null }) },
  },
}));

import ReceiptConflictDialog, {
  conflictPresentation, decidedLines,
  type ReceiptConflictLine, type ReceiptConflictState,
} from './ReceiptConflictDialog';
import { RECEIPT_CONFLICT_CODES } from '../lib/offlineQueue';

const line = (over: Partial<ReceiptConflictLine> = {}): ReceiptConflictLine => ({
  orderItemId: 'item-1',
  productName: 'עגבניות',
  unit: 'ק"ג',
  localQty: 40,
  localStatus: 'full',
  localNotes: null,
  orderedQty: 50,
  serverReceivedQty: 20,
  serverRemaining: 30,
  serverDraftQty: null,
  ...over,
});

const state = (over: Partial<ReceiptConflictState> = {}): ReceiptConflictState => ({
  code: 'receipt_qty_exceeds_order',
  orderId: 'order-1',
  orderNumber: 9001,
  supplierName: 'משק ירוק',
  receiptId: 'receipt-1',
  lines: [line()],
  localObservedAt: Date.UTC(2026, 7, 5, 5, 14),
  serverReceiptId: 'receipt-1',
  serverReceiptStatus: 'draft',
  serverReceiptAt: '2026-08-05T11:02:00Z',
  serverActorName: 'דנה כהן',
  serverOrderStatus: 'partial',
  rereadError: null,
  ...over,
});

describe('conflictPresentation — one decision per rejection code', () => {
  it('offers a per-line human decision only where quantities actually disagree', () => {
    const qty = conflictPresentation('receipt_qty_exceeds_order');
    expect(qty.perLineDecision).toBe(true);
    expect(qty.resendable).toBe(true);
    expect(qty.requiresExplanation).toBe(true);
    expect(qty.options.map((option) => option.kind)).toEqual(['resend-decided', 'keep-local']);
    expect(qty.localOnlyNote).toBeNull();
  });

  it('never offers to overwrite a receipt the server has already closed', () => {
    for (const code of ['receipt_already_completed', 'receipt_idempotency_conflict'] as const) {
      const presentation = conflictPresentation(code);
      expect(presentation.resendable).toBe(false);
      expect(presentation.perLineDecision).toBe(false);
      expect(presentation.options.map((option) => option.kind)).toEqual(['keep-local', 'discard-local']);
      // A local-only resolution writes nothing to the server, so it says so instead of implying
      // an audit entry that will never exist.
      expect(presentation.localOnlyNote).toMatch(/[֐-׿]/);
    }
  });

  it('treats a competing draft and an unreceivable order as decisions, not retries', () => {
    for (const code of ['receipt_draft_conflict', 'purchase_order_not_receivable'] as const) {
      const presentation = conflictPresentation(code);
      expect(presentation.resendable).toBe(false);
      expect(presentation.options.some((option) => option.kind === 'discard-local')).toBe(true);
    }
  });

  it('answers all five codes in Hebrew, with a keep-local escape from every one of them', () => {
    expect(RECEIPT_CONFLICT_CODES).toHaveLength(5);
    for (const code of RECEIPT_CONFLICT_CODES) {
      const presentation = conflictPresentation(code);
      expect(presentation.title).toMatch(/[֐-׿]/);
      expect(presentation.summary).toMatch(/[֐-׿]/);
      // Losing what the device saw must never be the only way forward.
      expect(presentation.options.some((option) => option.kind === 'keep-local')).toBe(true);
    }
  });
});

describe('decidedLines — a human decision, never an automatic merge', () => {
  it('keeps the local quantity when the person chose the device', () => {
    const [resolved] = decidedLines([line({ localQty: 12, serverRemaining: 30 })], { 'item-1': 'local' });
    expect(resolved.qty_received).toBe(12);
    expect(resolved.status).toBe('partial');
  });

  it('takes the server remainder when the person chose the server', () => {
    const [resolved] = decidedLines([line({ localQty: 40, serverRemaining: 30 })], { 'item-1': 'server' });
    expect(resolved.qty_received).toBe(30);
    // 'full' must equal the remaining quantity exactly (0023:1518) — re-derived, not carried over.
    expect(resolved.status).toBe('full');
  });

  it('never lets a chosen quantity exceed what the server would accept', () => {
    const [resolved] = decidedLines([line({ localQty: 40, serverRemaining: 30 })], { 'item-1': 'local' });
    expect(resolved.qty_received).toBe(30);
    expect(resolved.status).toBe('full');
  });

  it('leaves a quality judgement about goods alone', () => {
    const [resolved] = decidedLines(
      [line({ localQty: 5, localStatus: 'damaged', serverRemaining: 30 })],
      { 'item-1': 'local' },
    );
    expect(resolved.status).toBe('damaged');
    expect(resolved.qty_received).toBe(5);
  });

  it('fails closed when the server remainder is unknown', () => {
    expect(() => decidedLines(
      [line({ orderedQty: null, serverReceivedQty: null, serverRemaining: null })],
      { 'item-1': 'local' },
    )).toThrow('receipt_conflict_server_state_unknown');
  });
});

describe('the dialog', () => {
  it('shows both claims, both timestamps and who changed the server side', () => {
    render(<ReceiptConflictDialog conflict={state()} onClose={() => {}} onResolve={() => {}} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('דנה כהן')).toBeInTheDocument();
    expect(screen.getByText('08:14')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'שליחה לפי ההכרעה' })).toBeInTheDocument();
    // Both per-line options are offered and neither is applied for the person.
    expect(screen.getByRole('button', { name: 'המכשיר עבור עגבניות' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'השרת עבור עגבניות' })).toBeInTheDocument();
  });

  it('falls back to — when the server actor cannot be named', () => {
    render(<ReceiptConflictDialog conflict={state({ serverActorName: '—' })} onClose={() => {}} onResolve={() => {}} />);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('offers no re-send for a receipt already completed on the server', () => {
    render(<ReceiptConflictDialog conflict={state({ code: 'receipt_already_completed' })} onClose={() => {}} onResolve={() => {}} />);
    expect(screen.queryByRole('button', { name: 'שליחה לפי ההכרעה' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'השארת הטיוטה במכשיר' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'מחיקת הטיוטה המקומית' })).toBeInTheDocument();
  });

  it('shows unknown server quantities as — and blocks re-send after a failed re-read', () => {
    render(<ReceiptConflictDialog
      conflict={state({
        rereadError: 'לא ניתן לקרוא מחדש את נתוני ההזמנה. שליחה מחדש חסומה.',
        lines: [line({ orderedQty: null, serverReceivedQty: null, serverRemaining: null })],
      })}
      onClose={() => {}}
      onResolve={() => {}}
    />);

    expect(screen.getByText(/שליחה מחדש חסומה/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'שליחה לפי ההכרעה' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'השרת עבור עגבניות' })).not.toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });

  it('renders nothing without a conflict', () => {
    const { container } = render(<ReceiptConflictDialog conflict={null} onClose={() => {}} onResolve={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
