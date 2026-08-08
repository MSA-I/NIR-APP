import { describe, expect, it } from 'vitest';
import { NAV_SECTIONS, drawerSectionsForRole, footerItemsForRole, sectionsForRole } from './Layout';
import {
  isRouteFamilyActive, mobileNavigationFor, mobileNavigationForPath, quickActionsFor,
} from '../lib/quickActions';
import type { Role } from '../lib/types';

const ALL_ROLES: Role[] = ['owner', 'office', 'kitchen', 'payer', 'accountant', 'supplier'];
const pathsFor = (role: Role | undefined, isPlatformAdmin = false) =>
  sectionsForRole(role, isPlatformAdmin).flatMap((section) => section.items).map((item) => item.to);

describe('מעטפת הניווט', () => {
  it('מרכז הבקרה הוא הפריט הראשון בכל תפקיד', () => {
    expect(Object.fromEntries(ALL_ROLES.map((role) => [role, pathsFor(role)[0]])))
      .toEqual(Object.fromEntries(ALL_ROLES.map((role) => [role, '/dashboard'])));
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
    expect(footerItemsForRole('owner').map((item) => item.to)).toEqual(['/settings']);
  });

  it('תפקידים ממוקדים נשארים עם שני יעדים בלבד', () => {
    expect(pathsFor('supplier')).toEqual(['/dashboard', '/my-prices']);
    expect(pathsFor('payer')).toEqual(['/dashboard', '/pay']);
    expect(footerItemsForRole('supplier')).toEqual([]);
  });

  it('מדור הפלטפורמה נוסף אחרון ורק למנהל פלטפורמה', () => {
    expect(sectionsForRole('owner', true).at(-1)?.section).toBe('פלטפורמה');
    expect(sectionsForRole(undefined, true).map((section) => section.section)).toEqual(['פלטפורמה']);
    expect(sectionsForRole('owner', false).map((section) => section.section)).not.toContain('פלטפורמה');
  });

  it('קטלוג המסלולים נשאר מלא וללא כפילויות', () => {
    const paths = NAV_SECTIONS.flatMap((section) => section.items).map((item) => item.to);
    expect(paths).toHaveLength(new Set(paths).size);
    expect(paths).toEqual(expect.arrayContaining(['/orders/new', '/documents/archive', '/alerts', '/settings']));
  });

  it('כל מסלול מורשה מוצג או מוחרג במכוון ל-surface הקשרי', () => {
    const contextual = new Set(['/orders/new', '/documents/archive', '/alerts']);
    for (const role of ALL_ROLES) {
      const allowed = NAV_SECTIONS.flatMap((section) => section.items)
        .filter((item) => item.roles.includes(role)).map((item) => item.to);
      const surfaced = new Set([...pathsFor(role), ...footerItemsForRole(role).map((item) => item.to)]);
      expect(allowed.filter((path) => !surfaced.has(path))).toEqual(allowed.filter((path) => contextual.has(path)));
    }
    expect(pathsFor('accountant')).toContain('/credits');
  });
});

describe('ניווט מובייל תפקידי', () => {
  const targets = (role: Role) => mobileNavigationFor(role).map((item) => item.to ?? item.kind);

  it('מפריד ניווט מצילום ומעוד בלי יעד כפול', () => {
    expect(targets('owner')).toEqual(['/dashboard', '/invoices', 'capture', '/orders', 'more']);
    expect(targets('office')).toEqual(['/dashboard', '/orders', 'capture', '/invoices', 'more']);
    expect(targets('kitchen')).toEqual(['/dashboard', '/receiving', 'capture', '/documents', 'more']);
    expect(targets('accountant')).toEqual(['/dashboard', '/invoices', '/pay', '/bank', 'more']);
    for (const role of ALL_ROLES) {
      const destinations = mobileNavigationFor(role).flatMap((item) => item.to ?? []);
      expect(destinations).toHaveLength(new Set(destinations).size);
    }
  });

  it('המגירה היא משלים של הסרגל התחתון, לא עותק שלו', () => {
    for (const role of ALL_ROLES) {
      const bottom = new Set(mobileNavigationFor(role).flatMap((item) => item.to ?? []));
      const drawer = drawerSectionsForRole(role, false).flatMap((section) => section.items.map((item) => item.to));
      expect(drawer.filter((path) => bottom.has(path))).toEqual([]);
    }
  });

  it('במסלול עבודה ממוקד נשאר רק צילום למי שמורשה', () => {
    expect(mobileNavigationForPath('kitchen', '/receiving/order-1').map((item) => item.kind)).toEqual(['capture']);
    expect(mobileNavigationForPath('accountant', '/invoices/new')).toEqual([]);
  });

  it('ה-speed dial בדסקטופ מכיל פקודות בלבד', () => {
    expect(quickActionsFor('owner').map((item) => item.key)).toEqual(['order', 'capture', 'invoice']);
    expect(quickActionsFor('accountant')).toEqual([]);
  });
});

describe('התאמת משפחת מסלול', () => {
  it('מדליק פרטי רשומה בלי לבלוע מסלול אח', () => {
    expect(isRouteFamilyActive('/orders/42', '/orders')).toBe(true);
    expect(isRouteFamilyActive('/invoices/42', '/invoices')).toBe(true);
    expect(isRouteFamilyActive('/suppliers/42', '/suppliers')).toBe(true);
    expect(isRouteFamilyActive('/receiving/42', '/receiving')).toBe(true);
    expect(isRouteFamilyActive('/documents/42/review', '/documents')).toBe(true);
    expect(isRouteFamilyActive('/documents/archive', '/documents')).toBe(false);
    expect(isRouteFamilyActive('/documents/archive', '/documents/archive')).toBe(true);
    expect(isRouteFamilyActive('/payment-requests', '/pay')).toBe(false);
  });
});
