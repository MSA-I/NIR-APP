import { describe, expect, it } from 'vitest';
import { NAV_SECTIONS, drawerSectionsForRole, footerItemsForRole, pageTitleKeyFor, sectionsForRole } from './Layout';
import { he } from '../lib/i18n/dictionaries/he';

/** The words a key stands for, so a claim about COLLIDING LABELS stays a claim about words. */
const say = (key: string) => (he.nav as Record<string, string>)[key.replace(/^nav\./, '')];
import { isRouteFamilyActive, quickActionsFor } from '../lib/quickActions';
import type { ActiveRole } from '../lib/types';
import { routePresentationTitle, STATIC_ROUTE_TITLES } from '../lib/routePresentation';

const ACTIVE_ROLES: ActiveRole[] = ['owner', 'office', 'accountant'];
const pathsFor = (role: ActiveRole | undefined) =>
  sectionsForRole(role).flatMap((section) => section.items).map((item) => item.to);

describe('מעטפת הניווט', () => {
  it('מרכז הבקרה הוא הפריט הראשון בכל חשבון פעיל', () => {
    expect(Object.fromEntries(ACTIVE_ROLES.map((role) => [role, pathsFor(role)[0]])))
      .toEqual(Object.fromEntries(ACTIVE_ROLES.map((role) => [role, '/dashboard'])));
  });

  it('העבודה היומית גלויה ומוגבלת, והאזורים הנדירים מתקפלים', () => {
    const owner = sectionsForRole('owner');
    expect(owner[0].items.map((item) => item.to)).toEqual([
      '/dashboard', '/orders', '/receiving', '/invoices', '/documents', '/suppliers',
    ]);
    expect(owner[0].items).toHaveLength(6);
    // 'המנוי' is last and NOT collapsible: one item behind a disclosure is a door with a lid,
    // and the point of the group (owner report 25.08.2026) was to stop the subscription being
    // something you find by scrolling a settings screen.
    expect(owner.slice(1).map((section) => [section.section, section.collapsible])).toEqual([
      ['layoutTail.management', true], ['nav.text_8', true], ['nav.text_4', undefined],
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

  /**
   * DESIGN.md:507 — "דיסקלוזר מעל פריט אחד הוא דלת עם מכסה". The data half of the rule: which
   * named groups hold exactly one destination, so the shell knows to render them as a plain link.
   * `layoutActiveState.spec.tsx` asserts the rendered half.
   */
  it('קבוצה בעלת שם עם יעד אחד היא קישור, לא דיסקלוזר', () => {
    const singles = (role: ActiveRole) => sectionsForRole(role)
      .filter((section) => section.section && section.items.length === 1)
      .map((section) => section.section);
    expect(singles('owner')).toEqual(['nav.text_4']);
    expect(singles('accountant')).toEqual(['layoutTail.management']);
    expect(singles('office')).toEqual([]);
  });

  it('לרואה החשבון נשאר מסלול הביצוע', () => {
    expect(pathsFor('accountant')).toEqual(expect.arrayContaining(['/dashboard', '/invoices', '/pay']));
  });

  it('הקונסולה התפעולית אינה קיימת בניווט הדייר — לאף תפקיד ולאף מפעיל', () => {
    // The 'פלטפורמה' section moved to the operator application (operator.html, src/operator/,
    // 19.08.2026). The tenant catalogue must carry no /admin door at all — this pins the removal
    // so it cannot quietly return as "just one more section".
    for (const role of [...ACTIVE_ROLES, undefined]) {
      expect(sectionsForRole(role).map((section) => section.section)).not.toContain('פלטפורמה');
    }
    expect(NAV_SECTIONS.flatMap((section) => section.items).map((item) => item.to)).not.toContain('/admin');
    expect(sectionsForRole(undefined)).toEqual([]);
  });

  it('קטלוג המסלולים נשאר מלא וללא כפילויות', () => {
    const paths = NAV_SECTIONS.flatMap((section) => section.items).map((item) => item.to);
    expect(paths).toHaveLength(new Set(paths).size);
    expect(paths).toEqual(expect.arrayContaining([
      '/orders/new', '/documents/operations', '/documents/archive', '/inventory', '/alerts', '/settings',
      '/documents/consolidated-invoices',
    ]));
  });

  it('כל תווית ניווט נגזרת משם המסך הקנוני', () => {
    for (const item of NAV_SECTIONS.flatMap((section) => section.items)) {
      expect(item.labelKey).toBe(routePresentationTitle(item.to));
      expect(pageTitleKeyFor(item.to)).toBe(item.labelKey);
    }
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

const QUICK_ACTION_LINKS = (['owner', 'office', 'accountant'] as const)
  .flatMap((role) => quickActionsFor(role))
  .filter((action) => action.kind === 'link');

describe('סרגל הפעולות המהירות במובייל', () => {
  it('מחזיר פעולות מסך תפקידיות כשהצילום נמצא בדיוק באמצע', () => {
    // 'invoice' (→ /invoices/new) left this bar in G1, 10.08.2026: this application receives
    // supplier invoices and does not issue them. 'capture' is what replaced it — the invoice that
    // arrives is photographed, read and approved.
    expect(quickActionsFor('owner').map((item) => item.key)).toEqual(['order', 'dashboard', 'capture', 'receive', 'document-operations']);
    expect(quickActionsFor('office').map((item) => item.key)).toEqual(['order', 'dashboard', 'capture', 'receive', 'documents']);
    expect(quickActionsFor('accountant').map((item) => item.key)).toEqual(['dashboard', 'invoices', 'pay']);
  });

  /**
   * The accountant's bar said 'תשלומים' for `/pay` while the drawer, one swipe away, said
   * 'תשלומים' for `/payments`. Two screens, one word, for the single role whose work is the
   * difference between "still to be transferred" and "already paid". The catalogue had always
   * named them apart; only this bar was writing its own labels.
   */
  it('תווית בסרגל היא שם המסך הקנוני, ואין שתי מילים זהות לשני מסכים', () => {
    const SHORT_FORMS: Record<string, string> = { '/documents': 'nav.barDocuments' };
    for (const action of QUICK_ACTION_LINKS) {
      const path = action.to!.split('?')[0];
      expect(action.labelKey).toBe(SHORT_FORMS[path] ?? routePresentationTitle(path));
    }
    // The short form is a DIFFERENT word from the catalogue's, not the same one under another key.
    expect(say('nav.barDocuments')).toBe('מסמכים');
    expect(say(routePresentationTitle('/documents')!)).not.toBe(say('nav.barDocuments'));
    // The two payment screens must not collide anywhere a single role can see both. One label may
    // repeat across surfaces — that is the same screen named twice — but never over two routes.
    expect(routePresentationTitle('/pay')).not.toBe(routePresentationTitle('/payments'));
    const byLabel = new Map<string, Set<string>>();
    for (const { label, to } of [
      ...quickActionsFor('accountant').filter((a) => a.kind === 'link').map((a) => ({ label: say(a.labelKey), to: a.to!.split('?')[0] })),
      ...sectionsForRole('accountant').flatMap((s) => s.items).map((i) => ({ label: say(i.labelKey), to: i.to })),
    ]) {
      byLabel.set(label, (byLabel.get(label) ?? new Set()).add(to));
    }
    expect([...byLabel].filter(([, paths]) => paths.size > 1)).toEqual([]);
  });

  it('כל תווית קיצור מצביעה על מסלול שקיים בקטלוג ההצגה', () => {
    for (const action of QUICK_ACTION_LINKS) {
      expect(Object.keys(STATIC_ROUTE_TITLES)).toContain(action.to!.split('?')[0]);
    }
  });

  it('מחזיר את כל יעדי הניווט למגירה תחת שכבת עבודה שוטפת', () => {
    for (const role of ACTIVE_ROLES) {
      const drawer = drawerSectionsForRole(role);
      expect(drawer[0].section).toBe('layoutTail.currentWork');
      expect(drawer.flatMap((section) => section.items)).toEqual(
        sectionsForRole(role).flatMap((section) => section.items),
      );
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
