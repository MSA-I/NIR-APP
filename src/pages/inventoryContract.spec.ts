import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isRouteAllowed } from '../../qa/config/roles';

const source = readFileSync(join(process.cwd(), 'src', 'pages', 'Inventory.tsx'), 'utf8');
const app = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8');
const layout = readFileSync(join(process.cwd(), 'src', 'components', 'Layout.tsx'), 'utf8');

describe('inventory UI contract', () => {
  it('exposes the route to staff roles and denies finance/supplier roles', () => {
    expect(isRouteAllowed('owner', '/inventory')).toBe(true);
    expect(isRouteAllowed('office', '/inventory')).toBe(true);
    expect(isRouteAllowed('kitchen', '/inventory')).toBe(true);
    expect(isRouteAllowed('payer', '/inventory')).toBe(false);
    expect(isRouteAllowed('accountant', '/inventory')).toBe(false);
    expect(isRouteAllowed('supplier', '/inventory')).toBe(false);
    expect(app).toContain('path="/inventory" element={<Guard roles={STAFF}><Inventory /></Guard>}');
    expect(layout).toContain("{ to: '/inventory', label: 'מלאי'");
  });

  it('keeps unknown inventory distinct from a measured zero', () => {
    expect(source).toContain("value={counted == null ? '—' : fmtNum(counted)}");
    expect(source).toContain('fmtNum(row.quantity_on_hand)');
    expect(source).toContain('זהו מצב לא ידוע, לא מלאי אפס');
    expect(source).toContain("supabase.from('inventory_intelligence')");
    expect(source).toContain('projected_stockout_days == null');
  });

  it('shows evidence-based suggestions without creating procurement', () => {
    expect(source).toContain('צריכה יומית מחושבת רק מתנועות צריכה');
    expect(source).toContain('ההצעה אינה יוצרת הזמנה');
    expect(source).toContain('suggested_reorder_quantity');
    expect(source).toContain('expected_incoming_quantity');
    expect(source).toContain('incoming_without_date_quantity');
    expect(source).toContain('next_expected_incoming_date');
    expect(source).toContain('cheapest_supplier_name');
  });

  it('uses one idempotency UUID for retries, and records a reason without demanding one', () => {
    expect(source).toContain('useState(() => crypto.randomUUID())');
    expect(source.match(/p_movement_id: commandId/g)).toHaveLength(2);
    // The owner made the box optional on 11.08.2026; the LEDGER still gets a sentence, which is
    // what `reasonOr` is for. An empty p_reason would be refused by the server anyway.
    expect(source).not.toContain('if (!reason.trim())');
    expect(source.match(/reasonOr\(reason, /g)).toHaveLength(2);
    expect(source).toContain('maxLength={1000}');
    expect(source).toContain("hidden: !canAdjust");
  });

  it('provides labelled controls, named regions and logical RTL styling', () => {
    expect(source).toContain('aria-labelledby="inventory-overview-title"');
    expect(source).toContain('aria-labelledby="inventory-balances-title"');
    expect(source).toContain('aria-labelledby="inventory-movements-title"');
    expect(source).toContain('aria-label="סינון מצב מלאי"');
    expect(source).toContain('htmlFor="inventory-command-quantity"');
    expect(source).toContain('htmlFor="inventory-command-reason"');
    expect(source).not.toMatch(/\b(?:left|right|ml|mr|pl|pr)-\d/);
  });
});
