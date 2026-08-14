import { describe, expect, it } from 'vitest';
import { NAV_SECTIONS, drawerSectionsForRole, footerItemsForRole, sectionsForRole } from './Layout';
import { isRouteFamilyActive, quickActionsFor } from '../lib/quickActions';
import type { ActiveRole } from '../lib/types';

const ACTIVE_ROLES: ActiveRole[] = ['owner', 'office', 'accountant'];
const pathsFor = (role: ActiveRole | undefined, isPlatformAdmin = false) =>
  sectionsForRole(role, isPlatformAdmin).flatMap((section) => section.items).map((item) => item.to);

describe('מעטפת הניווט', () => {
  it('מרכז הבקרה הוא הפריט הראשון בכל חשבון פעיל', () => {
    expect(Object.fromEntries(ACTIVE_ROLES.map((role) => [role, pathsFor(role)[0]])))
      .toEqual(Object.fromEntries(ACTIVE_ROLES.map((role) => [role, '/dashboard'])));
  });

  it('העבודה היומית גלויה ומוגבלת, והאזורים הנדירים מתקפלים', () => {
    const owner = sectionsForRole('owner', false);
    expect(owner[0].items.map((item) => item.to)).toEqual([
      '/dashboard', '/orders', '/receiving', '/invoices', '/documents', '/suppliers',
    ]);
    expect(owner[0].items).toHaveLength(6);
    expect(owner.slice(1).map((section) => [section.section, section.collapsible])).toEqual([
      ['ניהול', true], ['בקרה', true],
    ]);
  });

  it('פעולות ויעדים הקשריים אינם מתחרים בתפריט', () => {
    const visible = new Set(pathsFor('owner'));
    expect(visible.has('/orders/new')).toBe(false);
    expect(visible.has('/documents/archive')).toBe(false);
    expect(visible.has('/alerts')).toBe(false);
    // The campaign's two new destinations are daily work, so they belong in the menu proper.
    expect(visible.has('/documents/operations')).toBe(true);
    expect(visible.has('/documents/consolidated-invoices')).toBe(true);
    expect(visible.has('/inventory')).toBe(true);
    // /onboarding joined the footer (09.08.2026) and this list is pinned, so the addition has to
    // argue for itself here rather than slip in. The argument: the route existed with NO door at
    // all — absent from NAV_SECTIONS, from quickActions, and from homeFor() — so the setup wizard
    // could not be reopened by the owner it belongs to, even though it was built to be reopened.
    // It sits in the footer, beside /settings, precisely so it does NOT compete with daily work,
    // which is what the rest of this test protects.
    expect(footerItemsForRole('owner').map((item) => item.to)).toEqual(['/onboarding', '/settings']);
  });

  it('לרואה החשבון נשאר מסלול הביצוע', () => {
    expect(pathsFor('accountant')).toEqual(expect.arrayContaining(['/dashboard', '/invoices', '/pay']));
  });

  it('מדור הפלטפורמה נוסף אחרון ורק למנהל פלטפורמה', () => {
    expect(sectionsForRole('owner', true).at(-1)?.section).toBe('פלטפורמה');
    expect(sectionsForRole(undefined, true).map((section) => section.section)).toEqual(['פלטפורמה']);
    expect(sectionsForRole('owner', false).map((section) => section.section)).not.toContain('פלטפורמה');
  });

  it('קטלוג המסלולים נשאר מלא וללא כפילויות', () => {
    const paths = NAV_SECTIONS.flatMap((section) => section.items).map((item) => item.to);
    expect(paths).toHaveLength(new Set(paths).size);
    expect(paths).toEqual(expect.arrayContaining([
      '/orders/new', '/documents/operations', '/documents/archive', '/inventory', '/alerts', '/settings',
      '/documents/consolidated-invoices',
    ]));
  });

  it('כל מסלול מורשה מוצג או מוחרג במכוון ל-surface הקשרי', () => {
    const contextual = new Set(['/orders/new', '/documents/archive', '/alerts']);
    for (const role of ACTIVE_ROLES) {
      const allowed = NAV_SECTIONS.flatMap((section) => section.items)
        .filter((item) => item.roles.includes(role)).map((item) => item.to);
      const surfaced = new Set([...pathsFor(role), ...footerItemsForRole(role).map((item) => item.to)]);
      expect(allowed.filter((path) => !surfaced.has(path))).toEqual(allowed.filter((path) => contextual.has(path)));
    }
    expect(pathsFor('accountant')).toContain('/credits');
  });
});

describe('סרגל הפעולות המהירות במובייל', () => {
  it('מחזיר פעולות מסך תפקידיות כשהצילום נמצא בדיוק באמצע', () => {
    // 'invoice' (→ /invoices/new) left this bar in G1, 10.08.2026: this application receives
    // supplier invoices and does not issue them. 'capture' is what replaced it — the invoice that
    // arrives is photographed, read and approved.
    expect(quickActionsFor('owner').map((item) => item.key)).toEqual(['order', 'dashboard', 'capture', 'receive', 'document-operations']);
    expect(quickActionsFor('office').map((item) => item.key)).toEqual(['order', 'dashboard', 'capture', 'receive', 'documents']);
    expect(quickActionsFor('accountant').map((item) => item.key)).toEqual(['dashboard', 'invoices', 'pay']);
  });

  it('מחזיר את כל יעדי הניווט הרגילים למגירה', () => {
    for (const role of ACTIVE_ROLES) {
      expect(drawerSectionsForRole(role, false)).toEqual(sectionsForRole(role, false));
    }
  });

  // The desktop speed-dial test that used to sit here went with the speed-dial itself (owner
  // decision 09.08.2026). Nothing replaced it: the test above already pins the phone list per role,
  // and a second assertion of the same fact is not coverage.
});

describe('התאמת משפחת מסלול', () => {
  it('מדליק פרטי רשומה בלי לבלוע מסלול אח', () => {
    expect(isRouteFamilyActive('/orders/42', '/orders')).toBe(true);
    expect(isRouteFamilyActive('/invoices/42', '/invoices')).toBe(true);
    expect(isRouteFamilyActive('/suppliers/42', '/suppliers')).toBe(true);
    expect(isRouteFamilyActive('/receiving/42', '/receiving')).toBe(true);
    expect(isRouteFamilyActive('/documents/42/review', '/documents')).toBe(true);
    expect(isRouteFamilyActive('/documents/consolidated-invoices', '/documents')).toBe(false);
    expect(isRouteFamilyActive('/documents/consolidated-invoices', '/documents/consolidated-invoices')).toBe(true);
    expect(isRouteFamilyActive('/documents/archive', '/documents')).toBe(false);
    expect(isRouteFamilyActive('/documents/archive', '/documents/archive')).toBe(true);
    expect(isRouteFamilyActive('/payment-requests', '/pay')).toBe(false);
  });
});
