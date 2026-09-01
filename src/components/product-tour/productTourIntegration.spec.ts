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

  /*
   * Regression, 30.08.2026, and the SECOND half of it, 31.08.2026.
   *
   * The first half: `prepare` named the group to open by its Hebrew WORDS — `'ניהול'`, `'בקרה'` —
   * while `NavSection.section` is a `TKey`, so the comparison in `topNavGroup` could never be
   * true and two steps of the owner tour pointed into a group that stayed shut. Nothing failed
   * loudly: the tour advanced and simply spotlighted nothing.
   *
   * The fix then was to swap the words for `'nav.text_6'` / `'nav.text_8'`, and the guard written
   * beside it collected every `section: '…'` literal in `Layout.tsx` and required the mapping to
   * land on one. **That guard passed on code that was already broken again**, because
   * `Layout.tsx` declares `section:` in TWO lists: `NAV_SECTIONS`, the permission-aware route
   * catalogue, and `NAV_GROUPS`, which is what the bar actually renders. `nav.text_6` and
   * `nav.text_8` live in the FORMER. The subject regrouping of 28.08.2026 moved the bar to
   * `nav.groupPurchasing` and friends, the map kept naming catalogue keys, and a guard that
   * merged both lists could not see the difference.
   *
   * So the shape is gone rather than re-pointed: the group is DERIVED from the step's
   * `destination` through `NAV_GROUPS` (`tourGroupForDestination`). This file asserts the wiring
   * and forbids the literal map from returning; `src/components/layout.spec.ts` asserts the
   * BEHAVIOUR, against `barSectionsForRole` — the list the bar really draws, and the one the old
   * guard should have been reading.
   */
  it('derives the prepared nav group from the destination instead of naming it', () => {
    const layout = read('src/components/Layout.tsx');
    expect(layout).toContain('setOpenGroup(tourGroupForDestination(step.destination))');
    expect(layout).toContain('const group = NAV_GROUPS.find((candidate) => candidate.paths.includes(destination));');
    // The old shape, forbidden by name: a literal that maps a `prepare` word to a group key is
    // exactly what drifted twice, and it drifts silently because a dead key still READS right.
    expect(layout).not.toMatch(/step\.prepare === '[a-z]+' \? '/);
    // `prepare` is a flag now. A step that carries a group name again would mean the registry has
    // taken back a decision it cannot keep correct.
    expect(read('src/lib/productTourRegistry.ts')).not.toMatch(/prepare: '[a-z]+'/);
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
