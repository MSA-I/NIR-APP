import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase', () => ({ supabase: {} }));

import { financialDueExposure } from './FinancialSupplier';

const source = readFileSync(join(process.cwd(), 'src', 'pages', 'FinancialSupplier.tsx'), 'utf8');
const app = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8');
const layout = readFileSync(join(process.cwd(), 'src', 'components', 'Layout.tsx'), 'utf8');

describe('financial supplier capability boundary', () => {
  it('ignores historical matched requests when deciding whether current due exposure is known', () => {
    expect(financialDueExposure([
      { id: 'matched', number: 1, amount: 500, due_date: null, status: 'matched' },
      { id: 'open', number: 2, amount: 75, due_date: '2026-08-01', status: 'approved' },
    ], '2026-08-08')).toBe(75);
  });

  it('does not request procurement-sensitive supplier data', () => {
    expect(source).not.toMatch(/supplier_products|price_history|purchase_orders|bank_details/);
    expect(source).not.toContain("from('suppliers')");
    expect(source).toContain("rpc('read_financial_supplier'");
  });

  it('is routed only to owner and accountant', () => {
    expect(app).toContain('path="/finance/suppliers/:id"');
    expect(app).toContain("roles={['owner', 'accountant']}");
  });

  it('does not route accountant into procurement supplier analytics', () => {
    expect(app).toContain("roles={['owner', 'office']}><Analytics");
    expect(layout).toContain("to: '/analytics'");
    expect(layout).not.toContain("to: '/analytics', label: 'ביצועי ספקים', icon: Activity, roles: ['owner', 'office', 'accountant']");
  });

  it('uses the server projection on every accountant-facing supplier lookup', () => {
    const files = [
      'Bank.tsx', 'Credits.tsx', 'Exceptions.tsx', 'Expenses.tsx', 'InvoiceDetail.tsx',
      'Invoices.tsx', 'PaymentRequests.tsx', 'Payments.tsx', 'PayerQueue.tsx', 'Reports.tsx',
      join('dashboards', 'AccountantDashboard.tsx'),
    ];
    for (const file of files) {
      const page = readFileSync(join(process.cwd(), 'src', 'pages', file), 'utf8');
      expect(page, file).not.toContain("from('suppliers')");
      expect(page, file).not.toMatch(/supplier\s*:\s*suppliers\s*\(/);
    }
  });
});
