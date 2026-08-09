import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

/**
 * The active-state half of the navigation contract, which `layout.spec.ts` cannot reach: that file
 * asserts the menu data, and `end` only becomes behaviour once NavLink renders it. Between the two
 * sits one expression, `end={item.end}`, which type-checks whatever it compares — it read
 * `item.to === '/orders'` until /documents/archive existed. Rendered here rather than reasoned
 * about, because the defect is invisible in the data: before the fix, standing on
 * /documents/archive marked both /documents and /documents/archive as the current page.
 *
 * The shell is mocked down to its navigation. The session, the unfiled-documents pill and the
 * four ornaments (search, bell, FAB, feedback) are not what is under test, and each would reach the
 * network — as does the flag lookup that decides whether the desktop header exists at all.
 */
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { role: 'owner', full_name: 'בודק', org_id: 'org-1' },
    org: { name: 'ארגון בדיקה' },
    roleLabels: { owner: 'בעלים' },
    isPlatformAdmin: false,
    signOut: async () => ({ error: null }),
  }),
}));
vi.mock('../lib/useInboxCount', () => ({ useInboxCount: () => null }));
vi.mock('./GlobalSearch', () => ({ default: () => null, canGlobalSearch: () => false }));
vi.mock('./Fab', () => ({ default: () => null }));
vi.mock('./NotificationBell', () => ({ default: () => null }));
vi.mock('./FeedbackButton', () => ({ default: () => null }));
vi.mock('../lib/flags', () => ({ useFeatureFlags: () => ({ isEnabled: () => false }) }));

import Layout from './Layout';
import { ToastProvider } from './ui';

// jsdom has no matchMedia, and Layout asks it on mount whether this is a desktop viewport so the
// mobile drawer cannot survive a resize. Answering yes renders the sidebar once, which is what
// makes "how many links claim to be current" a countable question.
beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: true, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

function renderAt(path: string) {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/dashboard" element={null} />
            <Route path="/documents" element={null} />
            <Route path="/documents/archive" element={null} />
            <Route path="/documents/:documentId/review" element={null} />
            <Route path="/orders" element={null} />
            <Route path="/orders/new" element={null} />
            <Route path="/orders/:id" element={null} />
            <Route path="/receiving" element={null} />
            <Route path="/receiving/:id" element={null} />
            <Route path="/invoices" element={null} />
            <Route path="/invoices/:id" element={null} />
            <Route path="/suppliers" element={null} />
            <Route path="/suppliers/:id" element={null} />
            <Route path="/payments" element={null} />
            <Route path="/alerts" element={null} />
            <Route path="/settings" element={null} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

const currentLabels = () =>
  Array.from(document.querySelectorAll('[aria-current="page"]')).map((el) => el.textContent?.trim());

const PATHS = [
  '/dashboard', '/documents', '/documents/abc/review', '/orders', '/orders/new', '/orders/abc',
  '/receiving/abc', '/invoices/abc', '/suppliers/abc', '/payments', '/settings',
];

describe('סימון הפריט הנוכחי בתפריט', () => {
  // aria-current="page" is a claim about where the user is, and two of them is a contradiction —
  // announced twice by a screen reader, and the first match wins the mobile drawer's initialFocus,
  // which queries for exactly this attribute.
  it.each(PATHS)('%s מסמן בדיוק פריט אחד', (path) => {
    renderAt(path);
    expect(currentLabels()).toHaveLength(1);
  });

  it('הארכיון אינו מדליק בטעות את תיקיית המסמכים', () => {
    renderAt('/documents/archive');
    expect(currentLabels()).toEqual([]);
  });

  it('בתיקיית המסמכים מסומנת תיקיית המסמכים', () => {
    renderAt('/documents');
    expect(currentLabels()).toEqual(['תיקיית המסמכים']);
  });

  it('יעד בקרה נדיר גלוי בסרגל הדסקטופ בלי disclosure כלל', () => {
    // Owner decision 09.08.2026: the desktop sidebar is fully open. This used to assert that the
    // group HAPPENED to be open because a child route was active; the guarantee is now stronger —
    // there is no <details> in the desktop nav to be open or closed. The drawer keeps its
    // disclosure, and the test below still renders it.
    renderAt('/payments');
    const current = document.querySelector('[aria-current="page"]');
    expect(current?.textContent?.trim()).toBe('תשלומים');
    expect(current?.closest('details')).toBeNull();
    expect(document.querySelector('nav[aria-label="ניווט ראשי"] details')).toBeNull();
  });

  it('כותרת הדפדפן מפרידה מסך, דייר ומוצר', async () => {
    renderAt('/orders/abc');
    await waitFor(() => expect(document.title).toBe('פרטי הזמנה — ארגון בדיקה · SupplyFlow'));
  });

  it('המגירה מרנדרת שוב את כל יעדי הניווט כי הסרגל התחתון מכיל פעולות', () => {
    renderAt('/suppliers/abc');
    fireEvent.click(screen.getByRole('button', { name: 'פתיחת תפריט' }));
    const drawer = screen.getByRole('dialog', { name: 'תפריט ראשי' });
    expect(within(drawer).getByRole('link', { name: 'מרכז הבקרה' })).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'הזמנות' })).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'חשבוניות' })).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'ספקים' })).toHaveAttribute('aria-current', 'page');
    expect(within(drawer).getByRole('link', { name: 'קבלת סחורה' })).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'הגדרות' })).toBeInTheDocument();
  });
});
