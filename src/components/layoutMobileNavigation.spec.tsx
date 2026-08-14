import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { isRouteFamilyActive } from '../lib/quickActions';

const state = vi.hoisted(() => ({ role: 'owner' as 'owner' | 'office' | 'accountant' | 'kitchen' }));

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ profile: { role: state.role } }) }));
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

function renderAt(path: string) {
  render(<MemoryRouter initialEntries={[path]}><Fab /></MemoryRouter>);
}

describe('סרגל פעולות מהירות תחתון', () => {
  it('מחזיר לבעלים חמישה יעדים כשהצילום באמצע ובקרת מסמכים בסוף', () => {
    state.role = 'owner';
    renderAt('/orders/order-1');
    const group = screen.getByRole('group', { name: 'קיצורי דרך ופעולות' });
    expect([...group.querySelectorAll('.mobile-action')].map((item) => item.textContent)).toEqual([
      // 'חשבונית חדשה' left this bar in G1: an invoice is received, not created.
      'הזמנה חדשה', 'מרכז הבקרה', 'צילום מסמך', 'קבלת סחורה', 'בקרת מסמכים',
    ]);
    expect([...group.querySelectorAll('.mobile-action')][2]).toHaveAttribute('data-quick-action-key', 'capture');
    expect(screen.getByRole('link', { name: 'בקרת מסמכים' })).toHaveAttribute('href', '/documents/operations');
    expect(screen.queryByRole('navigation', { name: 'ניווט ראשי בנייד' })).toBeNull();
  });

  it('שומר חמישה יעדים גם למנהל רכש ומסמן את המסך הפעיל', () => {
    state.role = 'office';
    renderAt('/documents');
    const group = screen.getByRole('group', { name: 'קיצורי דרך ופעולות' });
    expect([...group.querySelectorAll('.mobile-action')].map((item) => item.textContent)).toEqual([
      'הזמנה חדשה', 'מרכז הבקרה', 'צילום מסמך', 'קבלת סחורה', 'מסמכים',
    ]);
    expect([...group.querySelectorAll('.mobile-action')][2]).toHaveAttribute('data-quick-action-key', 'capture');
    expect(screen.getByRole('link', { name: 'מסמכים' })).toHaveAttribute('aria-current', 'page');
  });

  it('מסמן הזמנה חדשה כפעילה גם כשהיעד כולל query', () => {
    expect(isRouteFamilyActive('/orders/new', '/orders/new?fresh=1')).toBe(true);
  });

  it('שומר את כל הקיצורים גם במסך קבלה ממוקד', () => {
    state.role = 'office';
    renderAt('/receiving/order-1');
    expect(screen.queryByRole('navigation', { name: 'ניווט ראשי בנייד' })).toBeNull();
    expect(screen.getByRole('group', { name: 'קיצורי דרך ופעולות' }).querySelectorAll('.mobile-action')).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'צילום מסמך' })).toBeInTheDocument();
  });

  it('אינו מציג סרגל לתפקיד שפרש', () => {
    state.role = 'kitchen';
    renderAt('/dashboard');
    expect(screen.queryByRole('group', { name: 'קיצורי דרך ופעולות' })).toBeNull();
    expect(document.querySelector('.mobile-action-bar')).toBeNull();
  });
});
