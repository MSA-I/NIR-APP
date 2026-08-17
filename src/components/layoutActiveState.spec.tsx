import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

const authState = vi.hoisted(() => ({
  accessStatus: 'authoritative' as 'unknown' | 'authoritative' | 'offline',
  organizationAccess: { mode: 'active' as 'active' | 'read_only' | 'offboarding', canWrite: true },
}));

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
  '/dashboard', '/documents', '/documents/operations', '/documents/abc/review', '/orders', '/orders/new', '/orders/abc',
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
    // there is no <details> in either navigation surface to be open or closed.
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
    expect(within(drawer).getByRole('link', { name: 'הזמנות רכש' })).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'חשבוניות' })).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'ספקים' })).toHaveAttribute('aria-current', 'page');
    expect(within(drawer).getByRole('link', { name: 'קבלת סחורה' })).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'הגדרות מערכת' })).toBeInTheDocument();
    expect(within(drawer).getByText('עבודה שוטפת')).toBeInTheDocument();
    expect(within(drawer).getByText('ניהול').closest('details')).toBeNull();
    expect(within(drawer).getByText('בקרה').closest('details')).toBeNull();
  });

  it('משאיר במגירה את קבוצת המסך הפעיל פתוחה ללא disclosure', () => {
    renderAt('/payments');
    fireEvent.click(screen.getByRole('button', { name: 'פתיחת תפריט' }));
    const drawer = screen.getByRole('dialog', { name: 'תפריט ראשי' });
    const current = within(drawer).getByRole('link', { name: 'תשלומים' });
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(current.closest('details')).toBeNull();
  });

  it('מציג במסך משני חזרה קבועה לרשימת האב', () => {
    renderAt('/invoices/abc');
    const backLink = screen.getByRole('link', { name: 'חזרה לחשבוניות' });
    expect(backLink).toHaveAttribute('href', '/invoices');
    expect(backLink).not.toHaveClass('mobile-shell-mark');
  });
});

/**
 * The navigation half of the section-accent contract. `quickActions.spec.ts` pins the route→domain
 * map and the wall between the two colour languages against the stylesheet; this pins the thing a
 * user actually sees, which no amount of correct data guarantees: that the one item claiming to be
 * the current page is also the one wearing the accent, that the accent rides its ICON and not a
 * fill behind its label, and that a screen with no work domain wears none.
 */
const activeLink = () => document.querySelector<HTMLElement>('nav[aria-label="ניווט ראשי"] [aria-current="page"]');
const mainRegion = () => document.getElementById('main');

describe('מבטא האזור בסמן הניווט הפעיל', () => {
  it.each([
    ['/invoices/abc', 'money'],
    ['/orders', 'procurement'],
    ['/documents', 'documents'],
    ['/payments', 'money'],
  ])('%s לובש את מבטא %s על האייקון של הפריט הפעיל', (path, section) => {
    renderAt(path);
    const current = activeLink();
    expect(current).toHaveAttribute('data-section', section);
    // The glyph, not the pill: the accent clears 3:1 on the paper pill and only ~2.2:1 on the
    // shell, and a fill behind the label would be the badge/note idiom, which belongs to tones.
    expect(current?.querySelector('svg')).toHaveClass('section-glyph');
    expect(mainRegion()).toHaveAttribute('data-section', section);
  });

  it('מסך שמביט על פני כל התחומים אינו לובש מבטא כלל', () => {
    renderAt('/dashboard');
    expect(activeLink()).not.toHaveAttribute('data-section');
    expect(activeLink()?.querySelector('svg')).not.toHaveClass('section-glyph');
    expect(mainRegion()).not.toHaveAttribute('data-section');
  });

  it('הגדרות אינן תחום עבודה', () => {
    renderAt('/settings');
    expect(mainRegion()).not.toHaveAttribute('data-section');
  });

  it('אזור העבודה יודע את התחום גם כשאין פריט תפריט פעיל', () => {
    // /documents/archive is a contextual destination: it is deliberately absent from the sidebar,
    // so no item is current. The domain still comes from the URL — which is the point of deriving
    // the accent from the route rather than from whichever link happens to be highlighted.
    renderAt('/documents/archive');
    expect(activeLink()).toBeNull();
    expect(mainRegion()).toHaveAttribute('data-section', 'documents');
  });

  it('פריט נושא מבטא לעולם אינו נושא גם מחלקת טון', () => {
    // The two languages never meet on one element. If a future change gave the active item a
    // `badge-*`/`note-*`/`text-*-fg` class, the accent would stop being unmistakably about place.
    renderAt('/invoices/abc');
    for (const node of document.querySelectorAll('[data-section]')) {
      expect(node.className.toString()).not.toMatch(/\b(?:badge|note)-(?:done|await|alert|info|idle)\b/);
      expect(node.className.toString()).not.toMatch(/\btext-(?:done|await|alert|info|idle)-fg\b/);
    }
  });
});

describe('מצב גישת הארגון בזמן bootstrap', () => {
  it('אינו מהבהב בהודעת קריאה בלבד לפני תשובה סמכותית או מטמון offline', () => {
    authState.organizationAccess = { mode: 'read_only', canWrite: false };
    authState.accessStatus = 'unknown';
    renderAt('/dashboard');
    expect(screen.queryByText(/הגישה לכתיבה אינה זמינה כרגע/)).toBeNull();
  });

  it('מציג את ההודעה לאחר שהמצב נעשה סמכותי', () => {
    authState.organizationAccess = { mode: 'read_only', canWrite: false };
    authState.accessStatus = 'authoritative';
    renderAt('/dashboard');
    expect(screen.getByText(/הגישה לכתיבה אינה זמינה כרגע/)).toBeInTheDocument();
  });
});
