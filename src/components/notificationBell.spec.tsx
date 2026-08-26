import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

/**
 * The bell's four states — audit of 26.08.2026.
 *
 * The owner: "מה לגבי התראות הפעמון... נראה שיש מלא דברים שחסרים." The defect the audit found is
 * not in the count arithmetic, it is that FOUR situations were rendering as two. A bell with no
 * chip said "nothing is waiting" whether nothing was waiting, the read had not returned yet, or
 * the read had FAILED — and the failure branch was literally unwritable, because the hook only
 * assigned state inside `if (!error)`.
 *
 * Loading may still look like silence: it lasts a moment, and a skeleton in the chrome would flash
 * on every route change. A failure may not, because it persists until the next window focus and it
 * is exactly the state in which unseen work is most likely to exist. The count is still never
 * invented — what changes is the name the control answers to.
 */
const state = vi.hoisted(() => ({
  role: 'owner' as 'owner' | 'office' | 'accountant',
  unread: { count: null as number | null, failed: false },
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'u-1', role: state.role } }),
}));
vi.mock('../lib/notifications', () => ({
  useUnreadNotifications: () => state.unread,
}));

import NotificationBell from './NotificationBell';

function renderBell() {
  render(<MemoryRouter><NotificationBell /></MemoryRouter>);
  return document.querySelector('[data-notification-state]') as HTMLElement | null;
}

beforeEach(() => {
  state.role = 'owner';
  state.unread = { count: null, failed: false };
});

describe('פעמון ההתראות', () => {
  it('מונה ידוע וחיובי — צ׳יפ ושם שאומר כמה', () => {
    state.unread = { count: 3, failed: false };
    const bell = renderBell();
    expect(bell).toHaveAttribute('data-notification-state', 'unread');
    expect(screen.getByRole('link', { name: '3 התראות חדשות' })).toBeInTheDocument();
    expect(bell?.textContent).toBe('3');
  });

  it('אפס ידוע — בלי צ׳יפ, והשם הנייטרלי', () => {
    state.unread = { count: 0, failed: false };
    const bell = renderBell();
    expect(bell).toHaveAttribute('data-notification-state', 'clear');
    expect(screen.getByRole('link', { name: 'התראות' })).toBeInTheDocument();
    expect(bell?.textContent).toBe('');
  });

  it('בזמן טעינה השתיקה מותרת — היא נמשכת רגע', () => {
    state.unread = { count: null, failed: false };
    expect(renderBell()).toHaveAttribute('data-notification-state', 'loading');
    expect(screen.getByRole('link', { name: 'התראות' })).toBeInTheDocument();
  });

  /* The one that did not exist before: silence after a failed read is a claim we cannot back. */
  it('קריאה שנכשלה אינה מתחזה ל״אין חדש״', () => {
    state.unread = { count: null, failed: true };
    const bell = renderBell();
    expect(bell).toHaveAttribute('data-notification-state', 'unknown');
    expect(screen.getByRole('link', { name: /לא ניתן לבדוק כרגע/ })).toBeInTheDocument();
    // Still no number — an unknown count is not a zero and not a guess.
    expect(bell?.textContent).toBe('');
  });

  it('מונה גדול נחתך ל-99+ ולא שובר את הצ׳יפ', () => {
    state.unread = { count: 412, failed: false };
    expect(renderBell()?.textContent).toBe('99+');
    expect(screen.getByRole('link', { name: '412 התראות חדשות' })).toBeInTheDocument();
  });

  /* `/alerts` is owner+office, and so is the door to it. An accountant gets no bell at all rather
     than a bell that leads to a screen they cannot open. */
  it('אינו מרונדר לרואה חשבון', () => {
    state.role = 'accountant';
    state.unread = { count: 7, failed: false };
    expect(renderBell()).toBeNull();
  });
});
