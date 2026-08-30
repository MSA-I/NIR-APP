import { describe, expect, it } from 'vitest';
import { PRODUCT_HELP_ENTRIES } from './assistant/productHelpRegistry';
import {
  OWNER_FIRST_RUN_TOUR,
  OWNER_FIRST_RUN_TOUR_ID,
  loadProductTourProgress,
  productTourProgressKey,
  productTourRegistryDefects,
  resolveProductTourCopy,
  saveProductTourProgress,
  tourNavigationAnchor,
} from './productTourRegistry';

describe('owner first-run product tour registry', () => {
  it('defines the approved 16-step owner journey with stable endpoints', () => {
    expect(OWNER_FIRST_RUN_TOUR).toHaveLength(16);
    expect(new Set(OWNER_FIRST_RUN_TOUR.map((step) => step.id)).size).toBe(16);
    expect(OWNER_FIRST_RUN_TOUR[0]).toMatchObject({
      id: 'welcome', route: '/dashboard', anchor: 'dashboard-heading', advance: 'next',
    });
    expect(OWNER_FIRST_RUN_TOUR.at(-1)).toMatchObject({
      id: 'start-onboarding', route: '/dashboard', anchor: 'onboarding-start', advance: 'click',
    });
    expect(tourNavigationAnchor('/onboarding')).toBe('onboarding-start');
  });

  it('resolves every instruction from the canonical product-help registry', () => {
    expect(productTourRegistryDefects(OWNER_FIRST_RUN_TOUR, PRODUCT_HELP_ENTRIES)).toEqual([]);
    for (const step of OWNER_FIRST_RUN_TOUR) {
      for (const locale of ['he', 'en'] as const) {
        const copy = resolveProductTourCopy(step, PRODUCT_HELP_ENTRIES, locale);
        expect(copy.title.length, `${locale}:${step.id}`).toBeGreaterThan(0);
        expect(copy.body.length, `${locale}:${step.id}`).toBeGreaterThan(0);
        if (locale === 'en') expect(copy.title, step.id).not.toMatch(/[א-ת]/);
      }
    }
  });

  it('allows real clicks only on safe navigation targets', () => {
    expect(OWNER_FIRST_RUN_TOUR.filter((step) => step.advance === 'click').map((step) => step.anchor)).toEqual([
      'nav-suppliers',
      'nav-prices',
      'onboarding-start',
    ]);
  });

  it('scopes progress to organization, user and tour id and rejects malformed storage', () => {
    const key = productTourProgressKey('org-1', 'user-1');
    expect(key).toContain('org-1');
    expect(key).toContain('user-1');
    expect(key).toContain(OWNER_FIRST_RUN_TOUR_ID);

    localStorage.setItem(key, '{broken');
    expect(loadProductTourProgress('org-1', 'user-1')).toBeNull();

    saveProductTourProgress('org-1', 'user-1', {
      tourId: OWNER_FIRST_RUN_TOUR_ID,
      status: 'active',
      stepId: 'supplier-screen',
      updatedAt: '2026-08-27T00:00:00.000Z',
    });
    expect(loadProductTourProgress('org-1', 'user-1')).toMatchObject({
      status: 'active', stepId: 'supplier-screen',
    });
  });
});
