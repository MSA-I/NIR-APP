import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

/**
 * The focus half of the route-announcement contract: Layout moves keyboard focus to #main so a
 * route change skips the navigation shell — but the same effect also re-runs when the tab TITLE's
 * inputs settle (orgName resolves moments after login, currentTitle re-derives), and before the
 * guard those re-runs stole focus from whatever the user was typing in. The global search panel
 * lives on :focus, so the theft blanked results mid-search — the "search gives nothing" symptom.
 * Rendered rather than reasoned about, because the defect is invisible in the effect's body: its
 * dependency list is what fires it.
 */
const authState = vi.hoisted(() => ({ orgName: 'ארגון בדיקה' }));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { role: 'owner', full_name: 'בודק', org_id: 'org-1' },
    org: { name: authState.orgName },
    roleLabels: { owner: 'בעלים' },
    isPlatformAdmin: false,
    organizationAccess: { mode: 'active', canWrite: true },
    accessStatus: 'authoritative',
    signOut: async () => ({ error: null }),
  }),
}));
vi.mock('../lib/useInboxCount', () => ({ useInboxCount: () => null }));
// A real input in the header, standing in for the global search box the theft was blanking.
vi.mock('./GlobalSearch', () => ({
  default: () => <input aria-label="חיפוש כללי" />,
  canGlobalSearch: () => true,
}));
vi.mock('./Fab', () => ({ default: () => null }));
vi.mock('./NotificationBell', () => ({ default: () => null }));
vi.mock('./FeedbackButton', () => ({ default: () => null }));
vi.mock('../lib/flags', () => ({ useFeatureFlags: () => ({ isEnabled: () => false }) }));

import Layout from './Layout';
import { ToastProvider } from './ui';

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: true, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

function tree() {
  return (
    <ToastProvider>
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/dashboard" element={null} />
            <Route path="/orders/new" element={null} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Layout — focus moves to #main only on an actual navigation', () => {
  it('keeps focus in the search box when only the title inputs settle, and still hands off on navigation', async () => {
    const { rerender } = render(tree());

    // Mount behaviour is unchanged: the shell is skipped once.
    await waitFor(() => expect(document.activeElement?.id).toBe('main'));

    const search = screen.getByLabelText('חיפוש כללי');
    search.focus();
    expect(document.activeElement).toBe(search);

    // orgName resolving is a title update, not a navigation — focus must survive it.
    authState.orgName = 'ארגון בדיקה בע״מ';
    rerender(tree());
    await waitFor(() => expect(document.title).toContain('ארגון בדיקה בע״מ'));
    // Two animation frames of grace: the old behaviour stole focus inside one.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(document.activeElement).toBe(search);

    // A real route change still announces itself by moving focus past the shell. The
    // destination is one of the bar's two plain links: after the 28.08.2026 grouping every other
    // desktop destination sits inside a group panel that is `hidden` until its trigger is
    // pressed, and a hidden link is not in the accessibility tree to be clicked.
    fireEvent.click(screen.getAllByRole('link', { name: /הזמנה חדשה/ })[0]);
    await waitFor(() => expect(document.activeElement?.id).toBe('main'));
  });
});
