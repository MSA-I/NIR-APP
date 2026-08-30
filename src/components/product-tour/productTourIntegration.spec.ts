import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('owner product tour integration contract', () => {
  it('mounts the tour in the authenticated shell and exposes a manual launcher', () => {
    const layout = read('src/components/Layout.tsx');
    expect(layout).toContain("import { OwnerProductTour");
    expect(layout).toContain('<OwnerProductTour');
    // The launcher's label moved into the dictionary, so asserting the Hebrew words against the
    // SOURCE would only prove the shell had not been translated. The contract is that the button
    // is named, in both languages — which is what a reader needs and what the literal used to
    // stand in for.
    expect(layout).toContain("t('nav.productGuide')");
    expect(read('src/lib/i18n/dictionaries/he.ts')).toContain("productGuide: 'מדריך שימוש'");
    expect(read('src/lib/i18n/dictionaries/en.ts')).toContain("productGuide: 'Product guide'");
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

  // Regression, 30.08.2026. `prepare` opened the desktop nav group holding the step's target, and
  // it named that group by its Hebrew WORDS — `'ניהול'`, `'בקרה'` — while `NavSection.section` is a
  // `TKey`. So the comparison in `topNavGroup` could never be true, and two steps of the owner tour
  // pointed at links inside a group that stayed shut. Nothing failed loudly, which is why it
  // survived: the tour still advanced, it just spotlighted nothing. Asserting the mapping lands on
  // a section this file actually declares is what makes the next rename fail here instead.
  it('prepares a nav group the shell really has, by key and not by its words', () => {
    const layout = read('src/components/Layout.tsx');
    const sections = new Set([...layout.matchAll(/section: '([^']+)'/g)].map((m) => m[1]));
    expect(sections.size).toBeGreaterThan(0);

    const prepared = [...layout.matchAll(/step\.prepare === '[a-z]+' \? '([^']+)'/g)].map((m) => m[1]);
    expect(prepared.length).toBeGreaterThan(0);
    for (const target of prepared) {
      // 'account' is the one group that is not a nav section — it is the profile disclosure.
      if (target === 'account') continue;
      expect(sections).toContain(target);
    }
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
    expect(browserGate).toContain('owner-tour-1440-welcome-en.png');
    expect(browserGate).toContain('owner-tour-390-navigation.png');
  });
});
