import { describe, expect, it } from 'vitest';
import { NAV_SECTIONS, sectionsForRole } from './Layout';
import type { Role } from '../lib/types';

// The literal is not the menu. Between NAV_SECTIONS and the rendered sidebar sit a role filter,
// an empty-group filter and the platform-admin append — so the ordering claims are asserted on
// `sectionsForRole`, the value the shell actually maps over.
const ALL_ROLES: Role[] = ['owner', 'office', 'kitchen', 'payer', 'accountant', 'supplier'];

const pathsFor = (role: Role | undefined, isPlatformAdmin = false) =>
  sectionsForRole(role, isPlatformAdmin).flatMap((s) => s.items).map((i) => i.to);

describe('סדר הניווט', () => {
  // Section 12: the manager must see what needs attention within seconds of arriving. That is
  // true of every role or it is not true — a role whose first link is anything else opens the
  // day on a task list instead of a situation.
  it('מרכז הבקרה הוא הפריט הראשון בכל תפקיד', () => {
    const firstPerRole = Object.fromEntries(ALL_ROLES.map((role) => [role, pathsFor(role)[0]]));
    expect(firstPerRole).toEqual(Object.fromEntries(ALL_ROLES.map((role) => [role, '/dashboard'])));
  });

  it('הזמנה חדשה שנייה — התכופה ביותר, לא הראשונה', () => {
    expect(pathsFor('owner')[1]).toBe('/orders/new');
  });

  it('קיימת קבוצת מסמכים ייעודית', () => {
    const documents = sectionsForRole('owner', false).find((s) => s.section === 'מסמכים');
    expect(documents?.items.map((i) => i.to)).toEqual(['/documents', '/documents/archive']);
  });

  // The same group through the filter that decides who sees it: a supplier has no business in
  // the filing queue, and an empty group must disappear rather than render a bare header.
  it('ספק אינו רואה את קבוצת המסמכים', () => {
    expect(sectionsForRole('supplier', false).map((s) => s.section)).not.toContain('מסמכים');
    expect(pathsFor('supplier')).toEqual(['/dashboard', '/my-prices']);
  });

  it('מדור הפלטפורמה נוסף אחרון, ורק למנהל פלטפורמה', () => {
    expect(sectionsForRole('owner', true).at(-1)?.section).toBe('פלטפורמה');
    expect(sectionsForRole(undefined, true).map((s) => s.section)).toEqual(['פלטפורמה']);
    expect(sectionsForRole('owner', false).map((s) => s.section)).not.toContain('פלטפורמה');
  });

  // Every route reachable from the menu is one item. A duplicate splits the active state across
  // two links and makes pageTitleFor's first-match lookup depend on declaration order.
  it('כל מסלול מופיע פעם אחת בלבד בתפריט', () => {
    const paths = NAV_SECTIONS.flatMap((s) => s.items).map((i) => i.to);
    expect(paths).toHaveLength(new Set(paths).size);
  });
});
