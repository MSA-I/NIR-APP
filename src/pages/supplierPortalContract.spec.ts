import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), 'utf8');

const supplierPrices = read('src', 'pages', 'SupplierPrices.tsx');
const supplierPortalMigration = read('supabase', 'migrations', '0109_supplier_purchase_order_portal.sql');
const browserSmoke = read('scripts', 'check-browser-smoke.cjs');

const functionBody = (name: string, nextName: string) => {
  const start = browserSmoke.indexOf(`async function ${name}`);
  const end = browserSmoke.indexOf(`async function ${nextName}`, start + 1);
  expect(start, `${name} is missing from browser smoke`).toBeGreaterThanOrEqual(0);
  expect(end, `${nextName} is missing after ${name}`).toBeGreaterThan(start);
  return browserSmoke.slice(start, end);
};

describe('supplier portal projection contract', () => {
  it('reads the supplier commerce status only from the scoped portal RPC', () => {
    expect(supplierPrices).toContain("supabase.rpc('supplier_portal_context')");
    expect(supplierPrices).toContain('supplierStatus: portal.supplier.status');
    expect(supplierPrices).not.toContain("from('suppliers')");
  });

  it('includes status in the narrow supplier projection', () => {
    expect(supplierPortalMigration).toContain(
      'select o.name, s.name, s.status into v_org_name, v_supplier_name, v_supplier_status',
    );
    expect(supplierPortalMigration).toMatch(/'supplier', jsonb_build_object\([\s\S]*?'status', v_supplier_status/);
  });

  it('mocks the financial supplier projection with UUID identifiers in finance browser scenarios', () => {
    const paymentRequests = functionBody('paymentRequestNamesAndModalStack', 'bankContextualNames');
    const bank = functionBody('bankContextualNames', 'alertsPartialFailure');

    for (const scenario of [paymentRequests, bank]) {
      expect(scenario).toContain('/rest/v1/financial_supplier_directory?**');
      expect(scenario).not.toContain('/rest/v1/suppliers?**');
      expect(scenario).toMatch(/const supplierId = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}'/);
    }
  });
});
