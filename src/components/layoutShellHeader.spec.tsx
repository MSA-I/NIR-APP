import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
/* Layout reads the plan's entitlements through the shared cache, so the shell needs a client
   even where the read never fires: TanStack throws when there is no provider above it, before it
   considers `enabled`. The org scope is deliberately left null here — that is what keeps the
   query disabled and these specs off the network. */
import { QueryClientProvider } from '@tanstack/react-query';
import { createAppQueryClient } from '../lib/query/client';

/**
 * The shell header's contract, after the owner's two reports of 26.08.2026.
 *
 * Round one: the phone bar was too crowded, carried too many colours, and the mark was the
 * home-screen icon on its dark square. Round two, against the desktop: the brand pill did not
 * match the search field, `המנוי` was orphaning below the navigation capsule, the note trigger
 * belonged in the menu on BOTH surfaces, the end cluster had to read in the phone's order, and the
 * tier mark had to leave the utility cluster entirely — it describes the TENANT, and standing it
 * beside the avatar said it described the person.
 *
 * All of that is about ORDER, COUNT, and which branch of a conditional renders. None of it is
 * visible by reading `Layout.tsx`, so it is asserted here. The ornaments are stubbed and each
 * prints its own name, so a failure reads as a sequence rather than a diff of class strings.
 */
const authState = vi.hoisted(() => ({
  role: 'owner' as 'owner' | 'office' | 'accountant',
  logoPath: null as string | null,
  desktop: true,
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'u-1', role: authState.role, full_name: 'בודק בדיקוביץ', org_id: 'org-1' },
    org: { id: 'org-1', name: 'ארגון בדיקה', logo_path: authState.logoPath, logo_updated_at: '2026-08-26' },
    roleLabels: { owner: 'בעלים', office: 'מנהל רכש', accountant: 'רואה חשבון' },
    isPlatformAdmin: false,
    organizationAccess: { mode: 'active', canWrite: true },
    accessStatus: 'authoritative',
    signOut: async () => ({ error: null }),
  }),
}));
vi.mock('../lib/supabase', () => ({
  supabase: {
    storage: { from: () => ({ getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.test/${path}` } }) }) },
  },
}));
vi.mock('../lib/useInboxCount', () => ({ useInboxCount: () => null }));
vi.mock('../lib/offlineQueue', () => ({ pendingOfflineWork: async () => ({ actions: 0, uploads: 0 }) }));
vi.mock('../lib/assistant/runSession', () => ({
  assistantAuthorizationFingerprint: () => 'fp',
  useAssistantRunSession: () => null,
}));
vi.mock('./GlobalSearch', () => ({
  default: () => <div data-shell-mark="search-desktop" />,
  canGlobalSearch: () => true,
}));
vi.mock('./Fab', () => ({ default: () => null }));
vi.mock('./AssistantPanel', () => ({ default: () => <button type="button" data-shell-mark="assistant" /> }));
vi.mock('./NotificationBell', () => ({ default: () => <a href="/alerts" data-shell-mark="bell" /> }));
vi.mock('./FeedbackButton', () => ({
  default: ({ variant }: { variant?: string }) =>
    <button type="button" data-shell-mark={variant === 'menu' ? 'feedback-menu' : 'feedback-icon'} />,
}));
vi.mock('./PlanBadge', () => ({
  PlanBadge: () => (authState.role === 'owner'
    ? <a href="/settings/subscription" data-shell-mark="tier" className="plan-badge-trigger" />
    : null),
}));

import Layout from './Layout';
import { ToastProvider } from './ui';

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: authState.desktop, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

beforeEach(() => {
  authState.role = 'owner';
  authState.logoPath = null;
  authState.desktop = true;
});

function renderAt(path = '/dashboard') {
  render(
    <QueryClientProvider client={createAppQueryClient()}><ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/dashboard" element={null} />
            <Route path="/orders/new" element={null} />
            <Route path="/settings/subscription" element={null} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ToastProvider></QueryClientProvider>,
  );
}

/** The marks of one subtree, in DOM order — which under `dir=rtl` is start → end. */
const marksIn = (root: Element | null) =>
  [...(root?.querySelectorAll('[data-shell-mark]') ?? [])].map((el) => el.getAttribute('data-shell-mark'));

const desktopHeader = () => [...document.querySelectorAll('header')]
  .find((h) => !h.classList.contains('phone-safe-header')) as HTMLElement;
const phoneHeader = () => document.querySelector('header.phone-safe-header') as HTMLElement;
/* The desktop row is three blocks by contract: tenant column · navigation · utilities. Indexing
   them is deliberate — if that ever stops being true, this file should be the thing that says so. */
const desktopRow = () => desktopHeader().firstElementChild as HTMLElement;
const tenantColumn = () => desktopRow().children[0];
const utilities = () => desktopRow().children[2];

describe('אשכול הפעולות בכותרת המעטפת', () => {
  /**
   * Owner: "צריך להיות מסודר מחדש והסדר צריך להתאים למובייל". The phone renders a PREFIX of the
   * desktop sequence — fewer marks, never different ones and never in another order. The phone
   * stops before the account disc because on a phone the account IS the drawer.
   */
  it('שני המשטחים קוראים את אותו רצף, והטלפון עוצר אחרי שלושת הראשונים', () => {
    renderAt();
    expect(marksIn(utilities())).toEqual(['search-desktop', 'assistant', 'bell', 'feedback-menu']);
    // The phone bar is three blocks too: menu button · identity · actions. Only the last one is
    // the cluster under test — the tier mark now lives in the identity block beside it.
    const phoneActions = [...phoneHeader().children[2].querySelectorAll('a,button')]
      .map((el) => el.getAttribute('data-shell-mark') ?? el.getAttribute('aria-label'));
    expect(phoneActions).toEqual(['חיפוש', 'assistant', 'bell']);
  });

  /**
   * The note trigger is a MENU row on both surfaces now (owner: "כמו במובייל שזה חלק מתפריט
   * המגירה"), restoring the 25.08.2026 ruling on the surface it never reached. On desktop the
   * account panel is the menu; `feedback-menu` above proves the icon variant is gone from the bar.
   */
  it('שליחת הערה יושבת בתפריט החשבון, לא על הבר', () => {
    renderAt();
    expect(marksIn(utilities())).not.toContain('feedback-icon');
    const panel = utilities().querySelector('[data-no-capture]');
    expect(panel).not.toBeNull();
    expect(marksIn(panel)).toEqual(['feedback-menu']);
  });

  /**
   * THE CAPTURE TRAP, and it is not the drawer's. The phone drawer is `role="dialog"`, which
   * `SKIP_SELECTOR` skips for free; this panel is a plain div, so without `data-no-capture` a note
   * sent from the account menu arrives as a photograph of the account menu.
   */
  it('פאנל החשבון מוחרג מצילום המסך', () => {
    renderAt();
    const panel = utilities().querySelector('[data-shell-mark="feedback-menu"]')?.closest('[data-no-capture]');
    expect(panel).not.toBeNull();
  });
});

describe('סימן דרגת המנוי', () => {
  /**
   * Owner, twice on 26.08.2026: first "מתחת ללוגו של המותג ובכלל לא קשור לשם", then — looking at
   * that — the greeting line instead. What survives from the first ruling is the NEGATIVE, and it
   * is the part worth locking: the mark must not stand with the account controls, because there it
   * described the person signed in rather than the business. On desktop it is now the dashboard's
   * title block (`Dashboard.tsx`), so the shell header carries no tier mark at all.
   */
  it('בדסקטופ הוא אינו בכותרת המעטפת כלל — לא ליד האווטאר ולא מתחת ללוגו', () => {
    renderAt();
    expect(marksIn(desktopHeader())).not.toContain('tier');
    expect(marksIn(utilities())).not.toContain('tier');
    // The brand pill is a bare link again, not a column with something parked under it.
    expect(tenantColumn().tagName).toBe('A');
    expect(tenantColumn().getAttribute('href')).toBe('/dashboard');
  });

  /** Owner: "במובייל הוא מחליף את הטקסט" — the same slot, not a new one. */
  it('אינו יושב בסרגל הטלפון כלל — לא באשכול ולא בגוש הזהות', () => {
    renderAt();
    expect(marksIn(phoneHeader())).not.toContain('tier');
  });

  /** Nothing role-specific is left in the bar, so a non-owner's reads exactly like an owner's. */
  it('לתפקיד בלי תג — הסרגל זהה, כי לא נשאר בו דבר תלוי-תפקיד', () => {
    authState.role = 'office';
    renderAt();
    expect(marksIn(phoneHeader())).not.toContain('tier');
    expect(phoneHeader().textContent).not.toContain('ארגון בדיקה');
  });

  /**
   * THE THIRD PLACEMENT, and the first that agrees with the owner's own stated reason: a plan is a
   * property of the TENANT, and the drawer header is the only place in the phone shell where the
   * tenant is named. It passed through the icon row and then the account block on the way here.
   * The chip must be a SIBLING of the home link, never inside it — `PlanBadge` is an anchor, and
   * an anchor inside an anchor is invalid HTML that browsers fix by closing the outer one early.
   */
  it('יושב בכותרת המגירה, לצד שם המוצר והארגון ומחוץ לקישור הבית', () => {
    authState.desktop = false;
    renderAt('/dashboard?menu=1');
    const drawer = screen.getByRole('dialog', { name: 'תפריט ראשי' });
    const tier = drawer.querySelector('[data-shell-mark="tier"]') as HTMLElement;
    expect(tier).not.toBeNull();
    const homeLink = drawer.querySelector('a[href="/dashboard"]') as HTMLElement;
    expect(homeLink).not.toBeNull();
    expect(homeLink.contains(tier)).toBe(false);
    // Same row as the tenant identity, not somewhere further down the drawer.
    expect(tier.parentElement?.textContent).toContain('ארגון בדיקה');
  });
});

describe('סימן המותג', () => {
  /**
   * `/icons/icon-192.png` is the HOME-SCREEN icon — the symbol pressed onto a dark rounded square.
   * In the header it produced a dark tile inside a white plate inside a pill. Owner:
   * "הלוגו צריך להיות ללא הריבוע הכהה הוא צריך להיות כמו ה FAVICON".
   */
  /**
   * The ASSERTION changed on 31.08.2026 and the RULING did not. The mark is no longer an
   * `<img src="/favicon.svg">` but an inline `<svg>`, because an external SVG is a separate document
   * and cannot inherit `currentColor` — which is what the owner's later ruling ("the logo follows the
   * ground") requires. So this test keeps checking the thing he actually asked for — the bare mark,
   * no plate, no ring — against the implementation that now delivers it, and adds the two properties
   * the inline form has to have.
   */
  it('הסימן שלנו הוא הסמל החשוף — בלי ריבוע כהה, בלי לוחית לבנה ובלי טבעת', () => {
    renderAt();
    const marks = [...document.querySelectorAll('header svg[aria-hidden="true"], aside svg[aria-hidden="true"]')]
      .filter((svg) => svg.querySelector('path[d^="M 1669.44"]') !== null);
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) {
      // Follows its ground rather than carrying an ink of its own.
      expect(mark.getAttribute('fill')).toBe('currentColor');
      // Decorative: the desktop bar and the drawer are both mounted, so a <title> here would be a
      // duplicated id and a name read twice. The name lives on the wrapping <Link>.
      expect(mark.querySelector('title')).toBeNull();
      expect(mark.getAttribute('class') ?? '').not.toContain('bg-white');
      expect(mark.getAttribute('class') ?? '').not.toContain('ring-');
      expect(mark.getAttribute('class') ?? '').not.toContain('rounded');
    }
    // And OUR mark is never an <img> any more — a tenant's uploaded logo still is.
    const ourImages = [...document.querySelectorAll('header img, aside img')]
      .filter((img) => (img.getAttribute('src') ?? '').includes('favicon'));
    expect(ourImages).toEqual([]);
  });

  /** Owner: "תקטין את הגודל של הלוגו". Both bars now run the identical 28px mark. */
  /**
   * Owner, same day, two rulings apart: shrink the mark, then take it off the phone bar entirely.
   * So the desktop pill is the only bar carrying it, at 28px, and the phone bar carries none —
   * home is still the drawer header and the bottom action bar's מרכז הבקרה.
   */
  it('הסימן נשאר בגלולת הדסקטופ ב-28, ואינו בסרגל הטלפון כלל', () => {
    renderAt();
    // `svg`, not `img`, since 31.08.2026 — the mark is inline so it can follow its ground. Both
    // rulings this test guards are unchanged: 28px, and nothing on the phone bar.
    const desktopMark = desktopHeader().querySelector('svg[aria-hidden="true"][fill="currentColor"]');
    expect(desktopMark).not.toBeNull();
    expect(desktopMark?.getAttribute('width')).toBe('28');
    expect(desktopMark?.getAttribute('class') ?? '').toContain('size-7');
    expect(phoneHeader().querySelector('img')).toBeNull();
    expect(phoneHeader().querySelector('svg[fill="currentColor"]')).toBeNull();
  });

  /**
   * Owner: "הבועה צריכה להתאים בגודלה לאותו גודל של התיבת חיפוש". `.input` is `min-h-11`; the pill
   * is `h-11`. Same 44px from the same token, so the two ends of the row cannot drift apart when
   * the mark inside changes size — which is exactly what just happened to it.
   */
  it('גובה גלולת המותג נעוץ ב-44 כמו שדה החיפוש', () => {
    renderAt();
    const pill = tenantColumn() as HTMLElement;
    expect(pill.className).toContain('h-11');
    expect(pill.className).toContain('min-w-11');
    expect(pill.className).not.toContain('p-1.5');
  });

  /**
   * The plate is not decoration and it does not go: a tenant uploads a PNG that may be transparent
   * or light-on-dark, and it is not ours to redraw. DESIGN.md records `bg-white` as a deliberate
   * literal for exactly this case.
   */
  it('לוגו של דייר שומר על הלוחית הלבנה והטבעת', () => {
    authState.logoPath = 'org-1/logo.png';
    renderAt();
    const mark = desktopHeader().querySelector('img') as HTMLImageElement;
    expect(mark.getAttribute('src')).toContain('https://cdn.test/org-1/logo.png');
    expect(mark.className).toContain('bg-white');
    expect(mark.className).toContain('ring-1');
    expect(mark.className).toContain('rounded-lg');
  });
});
