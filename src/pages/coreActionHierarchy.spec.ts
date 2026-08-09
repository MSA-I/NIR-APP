import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase', () => ({ supabase: {} }));

import { invoiceLifecycle, invoicePrimaryAction } from './InvoiceDetail';
import { orderLifecycle, orderPrimaryAction } from './Orders';

describe('core record action hierarchy', () => {
  it('chooses exactly one order action for every actionable lifecycle state', () => {
    expect(orderPrimaryAction('draft', true)).toBe('ready');
    expect(orderPrimaryAction('ready', true)).toBe('whatsapp');
    expect(orderPrimaryAction('ready', false)).toBe('sent');
    expect(orderPrimaryAction('sent', true)).toBe('confirm');
    expect(orderPrimaryAction('confirmed', true)).toBe('receive');
    expect(orderPrimaryAction('partial', true)).toBe('receive');
    expect(orderPrimaryAction('received', true)).toBeNull();
    expect(orderPrimaryAction('cancelled', true)).toBeNull();
  });

  it('uses only server-returned invoice transitions and promotes payment after approval', () => {
    const transitions = [{ to: 'pending_approval' }, { to: 'investigation' }] as const;
    expect(invoicePrimaryAction(transitions, 'in_review', 'unpaid')).toBe('pending_approval');
    expect(invoicePrimaryAction([{ to: 'investigation' }], 'in_review', 'unpaid')).toBeNull();
    expect(invoicePrimaryAction([{ to: 'investigation' }], 'approved', 'unpaid')).toBe('payment-request');
    expect(invoicePrimaryAction([{ to: 'investigation' }], 'approved', 'paid')).toBeNull();
  });

  it('does not invent optional order stages that the record never observed', () => {
    expect(orderLifecycle('received', true, false).map((step) => step.key)).toEqual(['sent', 'received']);
    expect(orderLifecycle('partial', true, true).map((step) => step.key)).toEqual(['sent', 'confirmed', 'partial']);
  });

  it('does not claim an invoice passed through an optional approval stage', () => {
    expect(invoiceLifecycle('approved').map((step) => step.key)).toEqual(['approved']);
    expect(invoiceLifecycle('pending_approval').map((step) => step.key)).toEqual(['pending_approval', 'approved']);
  });
});
