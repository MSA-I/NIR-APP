import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('owner product tour integration contract', () => {
  it('mounts the tour in the authenticated shell and exposes a manual launcher', () => {
    const layout = read('src/components/Layout.tsx');
    expect(layout).toContain("import { OwnerProductTour");
    expect(layout).toContain('<OwnerProductTour');
    expect(layout).toContain('מדריך שימוש');
    expect(layout).toContain('data-tour-anchor={tourNavigationAnchor(item.to)}');
    expect(layout).toContain('data-tour-anchor="primary-navigation"');
    expect(layout).toContain('data-tour-anchor="global-search"');
  });

  it('anchors every always-present product surface used by the 16-step journey', () => {
    const anchors: Array<[string, string]> = [
      ['src/pages/Dashboard.tsx', 'dashboard-heading'],
      ['src/pages/Dashboard.tsx', 'dashboard-attention'],
      ['src/pages/Suppliers.tsx', 'suppliers-new'],
      ['src/pages/PriceLists.tsx', 'prices-upload'],
      ['src/pages/neworder/NewOrder.tsx', 'new-order-flow'],
      ['src/pages/Receiving.tsx', 'receiving-overview'],
      ['src/pages/DocumentsInbox.tsx', 'documents-upload'],
      ['src/pages/Invoices.tsx', 'invoices-overview'],
      ['src/pages/PaymentRequests.tsx', 'payment-requests-overview'],
      ['src/pages/Reports.tsx', 'reports-overview'],
    ];
    for (const [file, anchor] of anchors) expect(read(file)).toContain(`data-tour-anchor="${anchor}"`);
  });

  it('documents and styles the spotlight as a named quiet-control-room pattern', () => {
    const css = read('src/index.css');
    expect(css).toContain('.product-tour-shield');
    expect(css).toContain('.product-tour-spotlight');
    expect(css).toContain('.product-tour-popover');
    expect(read('DESIGN.md')).toContain('סיור מוצר — Spotlight');
  });

  it('adds the owner tour to the CI browser evidence gate', () => {
    const browserGate = read('scripts/check-browser-smoke.cjs');
    expect(browserGate).toContain('async function ownerProductTour');
    expect(browserGate).toContain("run('owner first-run product tour");
    expect(browserGate).toContain('owner-tour-1440-welcome.png');
    expect(browserGate).toContain('owner-tour-390-navigation.png');
  });
});
