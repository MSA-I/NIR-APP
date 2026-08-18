import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { orderImageModel, orderImageFileName } from './orderImage';
import type { WhatsAppOrder } from './share';

const order: WhatsAppOrder = {
  id: 'order-1',
  org_id: 'org-1',
  number: 42,
  status: 'ready',
  expected_date: '2026-08-12',
  notes: 'לתאם עם המחסן',
  supplier: { name: 'ירקות השדה', phone: '050-1234567', whatsapp: null },
  items: [
    { qty: 2, unit_price: 10, product: { name: 'עגבניות שרי', unit: 'ק״ג', sku: 'VEG-17' } },
    { qty: 12, unit_price: 4, product: { name: 'מטליות מיקרופייבר 30*30', unit: 'יח׳', sku: null } },
  ],
};

describe('orderImageModel — the pure half of the order image', () => {
  it('maps every line item in order, without any price field', () => {
    const model = orderImageModel(order, 'המסעדה');

    expect(model.title).toBe('הזמנת רכש #42');
    expect(model.supplierName).toBe('ירקות השדה');
    expect(model.notes).toBe('לתאם עם המחסן');
    expect(model.rows).toHaveLength(2);
    expect(model.rows[0]).toEqual({ index: 1, name: 'עגבניות שרי', qty: expect.stringContaining('2'), sku: 'VEG-17' });
    expect(model.rows[1].sku).toBeNull();
    // No prices anywhere — the whole model must be money-free.
    expect(JSON.stringify(model)).not.toContain('₪');
    expect(JSON.stringify(model)).not.toContain('unit_price');
    expect(Object.keys(model.rows[0])).toEqual(['index', 'name', 'qty', 'sku']);
  });

  it('omits the expected-date row instead of inventing a value', () => {
    expect(orderImageModel({ ...order, expected_date: null }, '').expectedDate).toBeNull();
    expect(orderImageModel(order, '').expectedDate).toBeTruthy();
  });

  it('names the file after the order number', () => {
    expect(orderImageFileName(order)).toBe('order-42.png');
  });
});

describe('renderOrderImage — the painted half, pinned by contract (jsdom cannot paint)', () => {
  const source = readFileSync('src/lib/orderImage.ts', 'utf8');

  it('uses html2canvas-pro dynamically, waits for fonts, renders at scale 2, hides from feedback capture', () => {
    expect(source).toContain("import('html2canvas-pro')");
    expect(source).not.toMatch(/from 'html2canvas'/);
    expect(source).toContain('document.fonts.ready');
    expect(source).toContain('scale: 2');
    expect(source).toContain('data-no-capture');
  });

  it('escapes user text and isolates names before it touches innerHTML', () => {
    expect(source).toContain('innerHTML');
    expect(source).toMatch(/esc\(/);
    expect(source).toContain('<bdi>');
  });
});
