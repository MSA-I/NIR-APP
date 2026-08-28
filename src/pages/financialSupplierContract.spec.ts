import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase', () => ({ supabase: {} }));

import { financialBankStatusCounts, financialDueExposure } from './FinancialSupplier';
import { NAV_SECTIONS } from '../components/Layout';
import { APP_ROUTE_POLICY } from '../lib/routePolicy';
import { he } from '../lib/i18n/dictionaries/he';

const source = readFileSync(join(process.cwd(), 'src', 'pages', 'FinancialSupplier.tsx'), 'utf8');
const app = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8');
const supplierReader = readFileSync(join(process.cwd(), 'src', 'lib', 'financialSuppliers.ts'), 'utf8');

describe('financial supplier capability boundary', () => {
  it('ignores historical matched requests when deciding whether current due exposure is known', () => {
    expect(financialDueExposure([
      { id: 'matched', number: 1, amount: 500, due_date: null, status: 'matched' },
      { id: 'open', number: 2, amount: 75, due_date: '2026-08-01', status: 'approved' },
    ], '2026-08-08')).toBe(75);
  });

  it('keeps unknown due dates distinct from a real zero', () => {
    expect(financialDueExposure([], '2026-08-08')).toBeNull();
    expect(financialDueExposure([
      { id: 'undated', number: 1, amount: 500, due_date: null, status: 'approved' },
    ], '2026-08-08')).toBeNull();
    expect(financialDueExposure([
      { id: 'future', number: 2, amount: 75, due_date: '2026-08-09', status: 'approved' },
    ], '2026-08-08')).toBe(0);
  });

  it('counts suggested bank matches separately from unmatched transactions', () => {
    expect(financialBankStatusCounts([
      { id: 'u1', tx_date: '2026-08-01', amount: 10, status: 'unmatched' },
      { id: 's1', tx_date: '2026-08-02', amount: 20, status: 'suggested' },
      { id: 'm1', tx_date: '2026-08-03', amount: 30, status: 'matched' },
    ])).toEqual({ unmatched: 1, suggested: 1 });
    // The two headings moved into the dictionary, so the claim splits rather than weakens: the
    // screen renders both keys, and the keys still name the two counts as different things.
    expect(source).toContain("t('financialSupplier.text_3')");
    expect(source).toContain("t('financialSupplier.text_4')");
    expect(he.financialSupplier.text_3).toBe('תנועות בנק לא מותאמות');
    expect(he.financialSupplier.text_4).toBe('התאמות שממתינות לאישור');
  });

  it('does not request procurement-sensitive supplier data', () => {
    expect(source).not.toMatch(/supplier_products|price_history|purchase_orders|bank_details/);
    expect(source).not.toContain("from('suppliers')");
    expect(source).toContain("rpc('read_financial_supplier'");
  });

  it('is routed only to owner and accountant', () => {
    expect(APP_ROUTE_POLICY.financialSupplierDetail).toEqual({
      path: '/finance/suppliers/:id',
      roles: ['owner', 'accountant'],
    });
    expect(app).toContain('path={APP_ROUTE_POLICY.financialSupplierDetail.path}');
    expect(app).toContain('roles={APP_ROUTE_POLICY.financialSupplierDetail.roles}');
  });

  it('does not route accountant into procurement supplier analytics', () => {
    expect(APP_ROUTE_POLICY.analytics.roles).toEqual(['owner', 'office']);
    expect(app).toContain('path={APP_ROUTE_POLICY.analytics.path}');
    expect(app).toContain('roles={APP_ROUTE_POLICY.analytics.roles}');
    const navigation = NAV_SECTIONS.flatMap((section) => section.items)
      .find((item) => item.to === '/analytics');
    expect(navigation).toMatchObject({ roles: ['owner', 'office'] });
    expect(he.nav[navigation!.labelKey.replace(/^nav./, '') as keyof typeof he.nav]).toBe('ביצועי ספקים');
    expect(navigation?.roles).not.toContain('accountant');
  });

  it('uses the server projection on every accountant-facing supplier lookup', () => {
    const files = [
      'Bank.tsx', 'Credits.tsx', 'Exceptions.tsx', 'Expenses.tsx', 'InvoiceDetail.tsx',
      'Invoices.tsx', 'PaymentRequests.tsx', 'Payments.tsx', 'AccountantPaymentQueue.tsx', 'Reports.tsx',
      join('dashboards', 'AccountantDashboard.tsx'),
    ];
    for (const file of files) {
      const page = readFileSync(join(process.cwd(), 'src', 'pages', file), 'utf8');
      expect(page, file).not.toContain("from('suppliers')");
      expect(page, file).not.toMatch(/supplier\s*:\s*suppliers\s*\(/);
    }
  });

  it('keeps full bank destinations out of the general directory and wires them only to edit/payment', () => {
    expect(supplierReader).toContain("from('financial_supplier_directory')");
    expect(supplierReader).toContain("from('financial_supplier_bank_accounts')");
    const fullBankConsumers = [
      'AccountantPaymentQueue.tsx',
      'Suppliers.tsx',
    ];
    for (const file of fullBankConsumers) {
      const page = readFileSync(join(process.cwd(), 'src', 'pages', file), 'utf8');
      expect(page, file).toMatch(/financialSupplierBankAccountMap|readFinancialSupplierBankAccount/);
    }
    for (const file of [
      'Bank.tsx', 'Credits.tsx', 'Exceptions.tsx', 'Expenses.tsx', 'InvoiceDetail.tsx',
      'Invoices.tsx', 'PaymentRequests.tsx', 'Payments.tsx', 'Reports.tsx',
      join('dashboards', 'AccountantDashboard.tsx'),
    ]) {
      const page = readFileSync(join(process.cwd(), 'src', 'pages', file), 'utf8');
      expect(page, file).not.toMatch(/financialSupplierBankAccountMap|readFinancialSupplierBankAccount/);
    }
  });
});
