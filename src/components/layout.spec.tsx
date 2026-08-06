import { describe, expect, it } from 'vitest';
import { NAV_SECTIONS } from './Layout';

describe('סדר הניווט', () => {
  it('מרכז הבקרה הוא הפריט הראשון', () => {
    const first = NAV_SECTIONS.flatMap((s) => s.items)[0];
    expect(first.to).toBe('/dashboard');
  });

  it('קיימת קבוצת מסמכים ייעודית', () => {
    const documents = NAV_SECTIONS.find((s) => s.section === 'מסמכים');
    expect(documents?.items.map((i) => i.to)).toEqual(['/documents', '/documents/archive']);
  });

  it('גלריית המסמכים אינה יושבת עוד תחת כספים', () => {
    const finance = NAV_SECTIONS.find((s) => s.section === 'כספים');
    expect(finance?.items.some((i) => i.to.startsWith('/documents'))).toBe(false);
  });
});
