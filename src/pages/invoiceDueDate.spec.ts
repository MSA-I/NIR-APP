// The due-date field on the invoice screen — a contract about what it must NOT do.
//
// The field is three lines of JSX; the decisions behind it are the part worth pinning. It writes
// through an audited command because `p1_financial_command_guard` (0023) refuses a plain update,
// it is optional because an empty field means "not known", and nothing on this screen derives a
// date from `suppliers.payment_terms` — free text nobody parses, which is exactly how a card about
// scheduled payments would end up reporting a debt the document never dated.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { he } from '../lib/i18n/dictionaries/he';
import { en } from '../lib/i18n/dictionaries/en';

const source = readFileSync(resolve(process.cwd(), 'src/pages/InvoiceDetail.tsx'), 'utf8');

describe('the date an invoice is due', () => {
  it('is written through the audited command, never as an update', () => {
    expect(source).toContain("supabase.rpc('set_invoice_due_date'");
    // A plain update would be refused by the guard, so an attempt at one is a bug that only
    // shows up at runtime for a user.
    expect(source).not.toMatch(/from\('invoices'\)[\s\S]{0,120}\.update\([^)]*due_date/);
  });

  /** Optional, because an empty field is a real answer and the card counts its own coverage. */
  it('offers an empty value rather than demanding a date', () => {
    expect(source).toContain("p_due_date: next === '' ? null : next");
    expect(he.invoices.dueDateCleared).toContain('לא ידוע');
    expect(en.invoices.dueDateCleared).toContain('not known');
  });

  /**
   * THE ONE THAT MATTERS. `payment_terms` is free text; parsing it would produce an invented debt
   * with a date attached. The screen must not reach for it.
   */
  it('never derives a date from the supplier’s payment terms', () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toContain('payment_terms');
  });

  /** The field shows what the record holds, so a stale value cannot read as saved. */
  it('is seeded from the record rather than from its own state', () => {
    expect(source).toContain('const invoiceDueDate = data?.invoice?.due_date');
    expect(source).toContain('useEffect(() => { setDueDate(invoiceDueDate); }, [invoiceDueDate]);');
  });

  /** Owner and office, matching what the command enforces rather than guessing wider. */
  it('is editable only by a role the command would accept', () => {
    expect(source).toContain('{canEdit ? (');
    expect(source).toContain("const canEdit = organizationAccess.canWrite && profile && ['owner', 'office'].includes(profile.role);");
  });

  /** A failed write puts the record's value back rather than leaving an unsaved one on screen. */
  it('restores the stored value when the command refuses', () => {
    expect(source).toContain("setDueDate(inv.due_date ?? '');");
  });

  it('names the field in both languages', () => {
    expect(he.invoices.dueDate).toBe('תאריך לתשלום');
    expect(en.invoices.dueDate).toBe('Payable by');
  });
});
