import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const state = vi.hoisted(() => ({ role: 'owner' as 'owner' | 'kitchen' | 'payer' }));

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
  it('מחזיר לבעלים את חמש הפעולות המקוריות בלי להפוך אותן לניווט', () => {
    state.role = 'owner';
    renderAt('/orders/order-1');
    const group = screen.getByRole('group', { name: 'פעולות מהירות' });
    expect([...group.querySelectorAll('.mobile-action')].map((item) => item.textContent)).toEqual([
      'הזמנה חדשה', 'מרכז הבקרה', 'צילום מסמך', 'קבלת סחורה', 'חשבונית חדשה',
    ]);
    expect(screen.queryByRole('navigation', { name: 'ניווט ראשי בנייד' })).toBeNull();
  });

  it('שומר focus mode עם צילום בלבד', () => {
    state.role = 'kitchen';
    renderAt('/receiving/order-1');
    expect(screen.queryByRole('navigation', { name: 'ניווט ראשי בנייד' })).toBeNull();
    expect(screen.getByRole('group', { name: 'פעולות מהירות' }).querySelectorAll('.mobile-action')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'צילום מסמך' })).toBeInTheDocument();
  });

  it('אינו מציג סרגל לתפקיד payer', () => {
    state.role = 'payer';
    renderAt('/pay');
    expect(screen.queryByRole('group', { name: 'פעולות מהירות' })).toBeNull();
    expect(document.querySelector('.mobile-action-bar')).toBeNull();
  });
});
