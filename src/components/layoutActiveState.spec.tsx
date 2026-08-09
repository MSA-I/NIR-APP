import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
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
 * three ornaments (search, bell, FAB) are not what is under test, and each would reach the network.
 */
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { role: 'owner', full_name: 'בודק', org_id: 'org-1' },
    org: { name: 'ארגון בדיקה' },
    roleLabels: { owner: 'בעלים' },
    isPlatformAdmin: false,
    organizationAccess: { mode: 'active', canWrite: true },
    signOut: async () => ({ error: null }),
  }),
}));
vi.mock('../lib/useInboxCount', () => ({ useInboxCount: () => null }));
vi.mock('./GlobalSearch', () => ({ default: () => null, canGlobalSearch: () => false }));
vi.mock('./Fab', () => ({ default: () => null }));
vi.mock('./NotificationBell', () => ({ default: () => null }));

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
            <Route path="/documents/operations" element={null} />
            <Route path="/documents/archive" element={null} />
            <Route path="/documents/:documentId/review" element={null} />
            <Route path="/orders" element={null} />
            <Route path="/orders/new" element={null} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

const currentLabels = () =>
  Array.from(document.querySelectorAll('[aria-current="page"]')).map((el) => el.textContent?.trim());

// Both nested pairs in the menu, plus a detail route under one of them. /documents/:id/review is
// here for the price `end` buys: it now marks nothing at all. That is accepted — see the NavItem
// comment in Layout.tsx — and it is asserted as "at most one" rather than "exactly none" so that a
// later fix lighting the parent without duplicating the claim reads as an improvement this suite
// allows, not a failure it reports.
const PATHS = ['/dashboard', '/documents', '/documents/operations', '/documents/archive', '/documents/abc/review', '/orders', '/orders/new'];

describe('סימון הפריט הנוכחי בתפריט', () => {
  // aria-current="page" is a claim about where the user is, and two of them is a contradiction —
  // announced twice by a screen reader, and the first match wins the mobile drawer's initialFocus,
  // which queries for exactly this attribute.
  it.each(PATHS)('%s מסמן פריט אחד לכל היותר', (path) => {
    renderAt(path);
    expect(currentLabels().length).toBeLessThanOrEqual(1);
  });

  it('בארכיון מסומן הארכיון, ולא תיקיית המסמכים שמעליו', () => {
    renderAt('/documents/archive');
    expect(currentLabels()).toEqual(['ארכיון']);
  });

  it('בתיקיית המסמכים מסומנת תיקיית המסמכים', () => {
    renderAt('/documents');
    expect(currentLabels()).toEqual(['תיקיית המסמכים']);
  });
});
