import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';

/**
 * "The menu is open" as a place in history (owner, 19.08.2026): open the drawer on a phone, pick a
 * screen, then use the iPhone back gesture — it left the application instead of returning to the
 * menu the screen was chosen from. The drawer used to be component state closed by each link's own
 * onClick, so the whole trip created exactly ONE history entry and `back` could only leave.
 *
 * `createMemoryRouter` rather than `MemoryRouter` (which the sibling layout specs use): the back
 * gesture is `router.navigate(-1)`, and only the data router hands the test that lever. The router
 * is also where the honest cost is measurable — a close must never step the user out of the
 * application, so each case below asserts where the location LANDED, not only what is on screen.
 */
const authState = vi.hoisted(() => ({
  accessStatus: 'authoritative' as 'unknown' | 'authoritative' | 'offline',
  organizationAccess: { mode: 'active' as 'active' | 'read_only' | 'offboarding', canWrite: true },
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { role: 'owner', full_name: 'בודק', org_id: 'org-1' },
    org: { name: 'ארגון בדיקה' },
    roleLabels: { owner: 'בעלים' },
    isPlatformAdmin: false,
    organizationAccess: authState.organizationAccess,
    accessStatus: authState.accessStatus,
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

// jsdom has no matchMedia, and the viewport is not a detail here: Layout closes the mobile layer
// when the viewport crosses into desktop, and that sync also runs once on mount. Only the width
// query is answered from `viewport`, so the pointer-atmosphere queries stay off and cannot make
// this file depend on them.
//
// The default is DESKTOP, deliberately — it is the harder answer. The sync must be a no-op while
// the drawer is shut, or opening it here would be impossible, which is exactly what the sibling
// active-state spec already depends on.
const viewport = { desktop: true };

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('min-width') ? viewport.desktop : false,
    media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => { viewport.desktop = true; });

function mountAt(entry: string) {
  const router = createMemoryRouter([
    {
      element: <Layout />,
      children: [
        { path: '/dashboard', element: <div /> },
        { path: '/suppliers', element: <div /> },
        { path: '/invoices', element: <div /> },
        { path: '/orders', element: <div /> },
        { path: '/receiving', element: <div /> },
        { path: '/documents', element: <div /> },
      ],
    },
  ], { initialEntries: [entry] });
  render(<ToastProvider><RouterProvider router={router} /></ToastProvider>);
  return router;
}

const drawer = () => screen.queryByRole('dialog', { name: 'תפריט ראשי' });
const back = (router: ReturnType<typeof mountAt>) => act(async () => { await router.navigate(-1); });

describe('התפריט הנייד כתחנה בהיסטוריה', () => {
  it('מחזיר את המגירה כשחוזרים אחורה מהמסך שנבחר בה', async () => {
    const router = mountAt('/dashboard');
    expect(drawer()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'פתיחת תפריט' }));
    expect(drawer()).toBeInTheDocument();
    // Opening is a PUSH, so the entry survives the navigation that follows it.
    expect(router.state.location.search).toBe('?menu=1');

    // Choosing a destination does not close the drawer by hand — the destination URL simply has no
    // marker, so the drawer derives itself shut. That deletion IS the feature.
    // Scoped to the drawer: the desktop pill renders the same destination, and the click under test
    // is the one a phone user makes inside the open menu.
    fireEvent.click(within(screen.getByRole('dialog', { name: 'תפריט ראשי' })).getByRole('link', { name: 'ספקים' }));
    expect(router.state.location.pathname).toBe('/suppliers');
    expect(router.state.location.search).toBe('');
    expect(drawer()).toBeNull();

    await back(router);
    expect(router.state.location.pathname).toBe('/dashboard');
    expect(router.state.location.search).toBe('?menu=1');
    expect(drawer()).toBeInTheDocument();
  });

  // The three ways to dismiss the drawer are three separate call sites — the X button, the
  // scrim's onClick and useDialogLayer's Escape handler — and all three must reach one close.
  const CLOSERS: [string, () => void][] = [
    ['הכפתור', () => fireEvent.click(screen.getByRole('button', { name: 'סגירת תפריט' }))],
    ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
    ['הרקע', () => fireEvent.click(screen.getByRole('dialog', { name: 'תפריט ראשי' }).parentElement as HTMLElement)],
  ];

  it.each(CLOSERS)('סגירה דרך %s צורכת את הרשומה שנדחפה ואינה משאירה שכבה תלויה', async (_name, close) => {
    const router = mountAt('/dashboard');
    fireEvent.click(screen.getByRole('button', { name: 'פתיחת תפריט' }));
    expect(drawer()).toBeInTheDocument();

    close();
    expect(router.state.location.search).toBe('');
    expect(drawer()).toBeNull();

    // Nothing marker-shaped is left behind the closed drawer: stepping back again finds no
    // `?menu=1` to reopen, because the close consumed the entry the open had pushed.
    await back(router);
    expect(drawer()).toBeNull();
  });

  it('קישור מודבק שכבר נושא את הסימון נפתח, ו-Escape אינו מוציא מהאפליקציה', async () => {
    // A reload with the marker present and a pasted `…?menu=1` link are the same case: the drawer
    // is open on the FIRST history entry, so there is no entry of ours to consume. Closing rewrites
    // the current URL instead — stepping back from here would leave the application entirely.
    viewport.desktop = false;
    const router = mountAt('/invoices?menu=1');
    expect(drawer()).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(router.state.location.pathname).toBe('/invoices');
    expect(router.state.location.search).toBe('');
    expect(drawer()).toBeNull();

    await back(router);
    expect(router.state.location.pathname).toBe('/invoices');
    expect(drawer()).toBeNull();
  });

  it('בדסקטופ הסימון נמחק מיד ואינו מקים מגירה שאין לה מקום', () => {
    // The drawer is a phone surface (lg:hidden). A `?menu=1` link opened on a desktop viewport must
    // not leave an open dialog with a body scroll lock behind it — the sync rewrites the URL in
    // place (replace, so the entry the user arrived on is not duplicated).
    const router = mountAt('/invoices?menu=1');
    expect(drawer()).toBeNull();
    expect(router.state.location.search).toBe('');
  });

  it('שומר את שאר הפרמטרים של המסך בפתיחה ובסגירה', async () => {
    // The marker is added to and removed from the screen's own query rather than replacing it: a
    // filtered list must survive being looked away from.
    const router = mountAt('/orders?status=open');
    fireEvent.click(screen.getByRole('button', { name: 'פתיחת תפריט' }));
    expect(router.state.location.search).toBe('?status=open&menu=1');

    fireEvent.click(screen.getByRole('button', { name: 'סגירת תפריט' }));
    expect(router.state.location.search).toBe('?status=open');
    expect(drawer()).toBeNull();
  });
});
