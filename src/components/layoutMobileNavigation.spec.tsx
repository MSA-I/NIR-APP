import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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

function renderAt(path: string, onOpenMenu = vi.fn()) {
  render(<MemoryRouter initialEntries={[path]}><Fab onOpenMenu={onOpenMenu} /></MemoryRouter>);
  return onOpenMenu;
}

describe('ניווט תחתון', () => {
  it('מסמן את משפחת הרשומה הפעילה', () => {
    state.role = 'owner';
    renderAt('/orders/order-1');
    const nav = screen.getByRole('navigation', { name: 'ניווט ראשי בנייד' });
    expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'הזמנות' })).toHaveAttribute('aria-current', 'page');
  });

  it('מסמן עוד במסך שאינו יעד יומי ופותח את המגירה', () => {
    state.role = 'owner';
    const onOpenMenu = renderAt('/suppliers/supplier-1');
    const more = screen.getByRole('button', { name: 'עוד — האזור הנוכחי' });
    expect(more).not.toHaveAttribute('aria-current');
    expect(more).toHaveAttribute('data-active', 'true');
    fireEvent.click(more);
    expect(onOpenMenu).toHaveBeenCalledOnce();
  });

  it('שומר focus mode עם צילום בלבד', () => {
    state.role = 'kitchen';
    renderAt('/receiving/order-1');
    expect(screen.queryByRole('navigation', { name: 'ניווט ראשי בנייד' })).toBeNull();
    expect(screen.getByRole('group', { name: 'פעולות במסך' }).querySelectorAll('.mobile-action')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'צילום מסמך' })).toBeInTheDocument();
  });

  it('אינו מנפח תפקיד payer', () => {
    state.role = 'payer';
    renderAt('/pay');
    const nav = screen.getByRole('navigation', { name: 'ניווט ראשי בנייד' });
    expect(nav.querySelectorAll('a')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /עוד/ })).toBeNull();
  });
});
