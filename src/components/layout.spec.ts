import { describe, expect, it } from 'vitest';
import { NAV_SECTIONS, barSectionsForRole, drawerSectionsForRole, footerItemsForRole, pageTitleFor, sectionsForRole } from './Layout';
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

  /**
   * ONE grouping, by subject (owner approval 28.08.2026).
   *
   * What this replaces: the file held two groupings of the same screens — by subject in
   * NAV_SECTIONS, by frequency in four per-role path maps — and the drawer rendered the second.
   * So 'ניהול' carried the product catalogue and the bank together, 'בקרה' carried document
   * operations next to the reports, and finding מחירונים meant guessing which of the two mental
   * models the menu was using. The owner's report: "יש בלאגן, לא מבינים את הניווט כמו שצריך".
   */
  it('קבוצה אחת לכל נושא, באותו סדר לכל תפקיד', () => {
    const owner = sectionsForRole('owner');
    // Above every heading: the control room (the answer to §12) and the most frequent action.
    expect(owner[0].items.map((item) => item.to)).toEqual(['/dashboard', '/orders/new']);
    expect(owner.map((section) => section.section)).toEqual([
      '', 'רכש', 'מסמכים', 'כספים', 'בקרה ודוחות', 'החשבון',
    ]);
    // A role never sees the paths its catalogue entry withholds, so one list serves all three
    // without three copies to drift apart: an accountant's 'רכש' resolves to nothing and is
    // dropped rather than shown empty.
    expect(sectionsForRole('accountant').map((section) => section.section))
      .toEqual(['', 'מסמכים', 'כספים', 'בקרה ודוחות']);
    expect(sectionsForRole('office').map((section) => section.section))
      .toEqual(['', 'רכש', 'מסמכים', 'כספים', 'בקרה ודוחות']);
    // Ordered within the group by how a procurement day actually runs, not alphabetically.
    expect(owner[1].items.map((item) => item.to)).toEqual([
      '/orders', '/receiving', '/suppliers', '/products', '/prices', '/inventory',
    ]);
  });

  it('קבוצת החשבון אחרונה, ואינה מופיעה פעמיים בדסקטופ', () => {
    // DESIGN.md:509 — the owner's settings area is not one more work destination. It is last, and
    // on desktop it is reached through the avatar disc, so the pill must not repeat it.
    expect(sectionsForRole('owner').at(-1)?.items.map((item) => item.to))
      .toEqual(['/settings/subscription', '/onboarding', '/settings']);
    expect(barSectionsForRole('owner').map((section) => section.section)).not.toContain('החשבון');
    expect(barSectionsForRole('owner').flatMap((section) => section.items).map((item) => item.to))
      .not.toContain('/settings');
  });

  it('כל יעד מורשה מופיע במקום אחד מוסבר בתפריט', () => {
    const visible = new Set(pathsFor('owner'));
    // /orders/new, /documents/archive and /alerts used to be deliberately absent, reachable only
    // through the FAB, the archive link and the notification bell. That was defensible while the
    // menu was a flat wall of nineteen rows; with the groups it is not — an owner who does not
    // know the bell exists had no route to their own alerts. They keep their contextual doors.
    for (const path of ['/orders/new', '/documents/archive', '/alerts']) {
      expect(visible.has(path)).toBe(true);
    }
    expect(visible.has('/documents/operations')).toBe(true);
    expect(visible.has('/documents/consolidated-invoices')).toBe(true);
    expect(visible.has('/inventory')).toBe(true);
    // The desktop avatar menu holds the same account group the drawer shows as a section.
    expect(footerItemsForRole('owner').map((item) => item.to))
      .toEqual(['/settings/subscription', '/onboarding', '/settings']);
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
    // Under the subject grouping no owner or office group is down to one row. The accountant's
    // 'מסמכים' is: consolidated invoices is the only document screen that role may reach.
    expect(singles('owner')).toEqual([]);
    expect(singles('office')).toEqual([]);
    expect(singles('accountant')).toEqual(['מסמכים']);
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
      expect(item.label).toBe(routePresentationTitle(item.to));
      expect(pageTitleFor(item.to)).toBe(item.label);
    }
  });

  it('כל מסלול מורשה מוצג — אין יותר יעד שרק מי שיודע עליו מוצא', () => {
    // The exclusion list this test used to carry is empty. Every destination a role may reach now
    // has a row in that role's menu; the contextual doors (FAB, bell, archive link) are shortcuts
    // to a place the menu also names, which is what a shortcut is supposed to be.
    for (const role of ACTIVE_ROLES) {
      const allowed = NAV_SECTIONS.flatMap((section) => section.items)
        .filter((item) => item.roles.includes(role)).map((item) => item.to);
      const surfaced = new Set([...pathsFor(role), ...footerItemsForRole(role).map((item) => item.to)]);
      expect(allowed.filter((path) => !surfaced.has(path))).toEqual([]);
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
    const SHORT_FORMS: Record<string, string> = { '/documents': 'מסמכים' };
    for (const action of QUICK_ACTION_LINKS) {
      const path = action.to!.split('?')[0];
      expect(action.label).toBe(SHORT_FORMS[path] ?? routePresentationTitle(path));
    }
    // The two payment screens must not collide anywhere a single role can see both. One label may
    // repeat across surfaces — that is the same screen named twice — but never over two routes.
    expect(routePresentationTitle('/pay')).not.toBe(routePresentationTitle('/payments'));
    const byLabel = new Map<string, Set<string>>();
    for (const { label, to } of [
      ...quickActionsFor('accountant').filter((a) => a.kind === 'link').map((a) => ({ label: a.label, to: a.to!.split('?')[0] })),
      ...sectionsForRole('accountant').flatMap((s) => s.items).map((i) => ({ label: i.label, to: i.to })),
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

  it('מחזיר את כל יעדי הניווט למגירה, כולל מה שהסרגל אינו מציג', () => {
    // The drawer is the complete list; the desktop bar is the one that withholds — it drops the
    // account group because the avatar disc already holds it. 'עבודה שוטפת' used to be pinned here
    // as the drawer's name for the leading group; the drawer prints no headings now (owner,
    // 28.08.2026), so a name that renders nowhere is not a contract worth keeping.
    for (const role of ACTIVE_ROLES) {
      const drawer = drawerSectionsForRole(role);
      expect(drawer.flatMap((section) => section.items)).toEqual(
        sectionsForRole(role).flatMap((section) => section.items),
      );
    }
    expect(drawerSectionsForRole('owner').map((section) => section.section)).toContain('החשבון');
    expect(barSectionsForRole('owner').map((section) => section.section)).not.toContain('החשבון');
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
