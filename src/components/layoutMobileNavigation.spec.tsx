import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { isRouteFamilyActive } from '../lib/quickActions';

const state = vi.hoisted(() => ({
  role: 'owner' as 'owner' | 'office' | 'accountant' | 'kitchen',
  organizationAccess: { mode: 'active' as 'active' | 'read_only' | 'offboarding', canWrite: true },
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ profile: { role: state.role }, organizationAccess: state.organizationAccess }),
}));
vi.mock('./QuickCapture', () => ({
  useQuickCapture: () => ({ openCapture: vi.fn(), element: null, busy: false, retryCount: 0 }),
}));

import Fab from './Fab';

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

beforeEach(() => {
  state.role = 'owner';
  state.organizationAccess = { mode: 'active', canWrite: true };
});

function renderAt(path: string, props: { inboxCount?: number | null } = {}) {
  render(<MemoryRouter initialEntries={[path]}><Fab {...props} /></MemoryRouter>);
}

const items = () => [...screen.getByRole('group', { name: 'קיצורי דרך ופעולות' }).querySelectorAll('.mobile-action')];

describe('סרגל פעולות מהירות תחתון', () => {
  it('מחזיר לבעלים חמישה יעדים כשהצילום באמצע ובקרת מסמכים בסוף', () => {
    state.role = 'owner';
    renderAt('/orders/order-1');
    expect(items().map((item) => item.textContent)).toEqual([
      // 'חשבונית חדשה' left this bar in G1: an invoice is received, not created.
      'הזמנה חדשה', 'מרכז הבקרה', 'צילום מסמך', 'קבלת סחורה', 'בקרת מסמכים',
    ]);
    expect(items()[2]).toHaveAttribute('data-quick-action-key', 'capture');
    expect(screen.getByRole('link', { name: 'בקרת מסמכים' })).toHaveAttribute('href', '/documents/operations');
    expect(screen.queryByRole('navigation', { name: 'ניווט ראשי בנייד' })).toBeNull();
  });

  it('שומר חמישה יעדים גם למנהל רכש ומסמן את המסך הפעיל', () => {
    state.role = 'office';
    renderAt('/documents');
    expect(items().map((item) => item.textContent)).toEqual([
      'הזמנה חדשה', 'מרכז הבקרה', 'צילום מסמך', 'קבלת סחורה', 'מסמכים',
    ]);
    expect(items()[2]).toHaveAttribute('data-quick-action-key', 'capture');
    expect(screen.getByRole('link', { name: 'מסמכים' })).toHaveAttribute('aria-current', 'page');
  });

  it('מסמן הזמנה חדשה כפעילה גם כשהיעד כולל query', () => {
    expect(isRouteFamilyActive('/orders/new', '/orders/new?fresh=1')).toBe(true);
  });

  it('שומר את כל הקיצורים גם במסך קבלה ממוקד', () => {
    state.role = 'office';
    renderAt('/receiving/order-1');
    expect(screen.queryByRole('navigation', { name: 'ניווט ראשי בנייד' })).toBeNull();
    expect(items()).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'צילום מסמך' })).toBeInTheDocument();
  });

  it('אינו מציג סרגל לתפקיד שפרש', () => {
    state.role = 'kitchen';
    renderAt('/dashboard');
    expect(screen.queryByRole('group', { name: 'קיצורי דרך ופעולות' })).toBeNull();
    expect(document.querySelector('.mobile-action-bar')).toBeNull();
  });

  /**
   * A suspended or offboarding tenant used to lose the ENTIRE bar, because the gate returned `[]`
   * rather than filtering the writes out of it. מרכז הבקרה, קבלת סחורה and the documents door are
   * places to LOOK — exactly what a business in that state has been told it may still do, and
   * exactly what it needs on a phone. Only the camera writes.
   */
  it('ארגון לקריאה בלבד שומר את הניווט ומאבד רק את הצילום', () => {
    state.role = 'office';
    state.organizationAccess = { mode: 'read_only', canWrite: false };
    renderAt('/dashboard');
    expect(items().map((item) => item.textContent)).toEqual([
      'הזמנה חדשה', 'מרכז הבקרה', 'קבלת סחורה', 'מסמכים',
    ]);
    expect(screen.queryByRole('button', { name: 'צילום מסמך' })).toBeNull();
    expect(screen.getByRole('link', { name: 'מרכז הבקרה' })).toHaveAttribute('href', '/dashboard');
  });

  /**
   * "You are here" and "you are pressing this" were the same pixel — every item carried
   * `active:bg-surface-selected` and the current page carried `bg-surface-selected` — and the bar
   * marked the current page in a dialect neither the desktop pill nor the drawer speaks.
   *
   * UPDATED 31.08.2026, and the update is the point. The mark became `bg-action`, which is the
   * RAISED CAMERA PUCK's own colour — owner report: "הצבע של הכפתור שלחוץ ... זה אותו הצבע של כפתור
   * המצלמה וזה מבלבל". So the assertion is now the inverse of what it was: the current page must
   * NOT wear `bg-action`, and it must wear the dedicated `nav-current` family whose values were
   * solved against the bar and the puck rather than chosen. See `--color-nav-current` in index.css.
   */
  it('המסך הנוכחי מסומן בצבע משלו — לא בצבע של פוק המצלמה — והלחיצה סימון חלש משלה', () => {
    state.role = 'office';
    renderAt('/receiving');
    const current = screen.getByRole('link', { name: 'קבלת סחורה' });
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(current.className).toContain('bg-nav-current');
    // The whole defect, as a test: the pill and the camera puck may never share a fill again.
    expect(current.className).not.toContain('bg-action');
    // The ring is what separates the pill from the puck in the dark theme, where no fill can.
    expect(current.className).toContain('ring-nav-current-edge');
    expect(current.className).not.toContain('active:bg-surface-selected');
    const other = screen.getByRole('link', { name: 'מרכז הבקרה' });
    expect(other.className).toContain('active:bg-surface-selected');
    expect(other.className).not.toContain('bg-nav-current');
  });

  /**
   * The unfiled-documents count reached the desktop pill and the drawer and stopped there — while
   * on a phone this bar IS the door to that queue for `office`.
   */
  it('מציג את מונה המסמכים הלא-משויכים על יעד התיקייה', () => {
    state.role = 'office';
    renderAt('/dashboard', { inboxCount: 4 });
    expect(screen.getByRole('link', { name: /מסמכים ממתינים לשיוך/ })).toHaveTextContent('4');
  });

  it('אינו ממציא אפס: מונה לא ידוע או ריק אינו מצייר תג', () => {
    state.role = 'office';
    renderAt('/dashboard', { inboxCount: 0 });
    expect(screen.getByRole('link', { name: 'מסמכים' })).toBeInTheDocument();
    renderAt('/dashboard', { inboxCount: null });
    expect(screen.getAllByRole('link', { name: 'מסמכים' })).toHaveLength(2);
  });
});
