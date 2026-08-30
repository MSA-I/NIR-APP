import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
/* Layout reads the plan's entitlements through the shared cache, so the shell needs a client
   even where the read never fires: TanStack throws when there is no provider above it, before it
   considers `enabled`. The org scope is deliberately left null here — that is what keeps the
   query disabled and these specs off the network. */
import { QueryClientProvider } from '@tanstack/react-query';
import { createAppQueryClient } from '../lib/query/client';

/**
 * The phone bar's screen name follows the page's own heading (owner ruling, 26.08.2026).
 *
 * He asked for the title gone — at the top of a screen it repeats the `<h1>` two centimetres
 * below it. Measured before deleting: 22 of the owner's 27 destinations have no bottom-action-bar
 * entry, and the back arrow covers 10 record-screen patterns, names the PARENT, and only in
 * `aria-label`. So on 22 screens "gone" means "nothing says where you are once the page scrolls".
 * The title now renders only while the heading is NOT on screen.
 *
 * THESE TESTS DRIVE THE REAL WIRING. jsdom has no `IntersectionObserver`, so a spec that simply
 * rendered the shell would take the fail-safe branch every time and prove only that the guard
 * exists. A fake observer is installed instead, capturing the constructor options and the observed
 * element and handing the callback back to the test — so the target selector, the `rootMargin`,
 * the MutationObserver rebinding and both callback directions are all under assertion. The guard
 * itself gets its own case, with the global genuinely absent.
 */
const io = vi.hoisted(() => ({
  options: [] as (IntersectionObserverInit | undefined)[],
  observed: [] as Element[],
  unobserved: [] as Element[],
  disconnects: 0,
  fire: [] as ((entries: { isIntersecting: boolean }[]) => void)[],
}));

class FakeIntersectionObserver {
  constructor(callback: (entries: { isIntersecting: boolean }[]) => void, options?: IntersectionObserverInit) {
    io.fire.push(callback);
    io.options.push(options);
  }

  observe(element: Element) { io.observed.push(element); }
  unobserve(element: Element) { io.unobserved.push(element); }
  disconnect() { io.disconnects += 1; }
  takeRecords() { return []; }
}

const authState = vi.hoisted(() => ({ role: 'owner' as 'owner' | 'office' }));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'u-1', role: authState.role, full_name: 'בודק בדיקוביץ', org_id: 'org-1' },
    org: { id: 'org-1', name: 'ארגון בדיקה', logo_path: null, logo_updated_at: null },
    roleLabels: { owner: 'בעלים', office: 'מנהל רכש' },
    isPlatformAdmin: false,
    organizationAccess: { mode: 'active', canWrite: true },
    accessStatus: 'authoritative',
    signOut: async () => ({ error: null }),
  }),
}));
vi.mock('../lib/supabase', () => ({
  supabase: { storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: '' } }) }) } },
}));
vi.mock('../lib/useInboxCount', () => ({ useInboxCount: () => null }));
vi.mock('../lib/offlineQueue', () => ({ pendingOfflineWork: async () => ({ actions: 0, uploads: 0 }) }));
vi.mock('../lib/assistant/runSession', () => ({
  assistantAuthorizationFingerprint: () => 'fp',
  useAssistantRunSession: () => null,
}));
vi.mock('./GlobalSearch', () => ({ default: () => null, canGlobalSearch: () => true }));
vi.mock('./Fab', () => ({ default: () => null }));
vi.mock('./AssistantPanel', () => ({ default: () => null }));
vi.mock('./NotificationBell', () => ({ default: () => null }));
vi.mock('./FeedbackButton', () => ({ default: () => null }));
vi.mock('./PlanBadge', () => ({ PlanBadge: () => null }));

import Layout from './Layout';
import { ToastProvider } from './ui';

const BAR_HEIGHT = 71;

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  /* jsdom measures everything as zero, which would make "rootMargin is the bar height" pass on
     `-0px` no matter which element the code measured. Only the phone bar reports a height here, so
     measuring the wrong element — or none — produces `-0px` and the assertion fails. */
  const real = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function bounds(this: Element) {
    const box = real.call(this);
    // jsdom's rect is a plain object with no `toJSON`, so it is rebuilt field by field.
    if (this.classList?.contains('phone-safe-header')) {
      return {
        x: box.x, y: box.y, top: box.top, left: box.left, right: box.right,
        bottom: box.bottom, width: box.width, height: BAR_HEIGHT, toJSON: () => ({}),
      } as DOMRect;
    }
    return box;
  };
});

beforeEach(() => {
  authState.role = 'owner';
  io.options = [];
  io.observed = [];
  io.unobserved = [];
  io.disconnects = 0;
  io.fire = [];
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
});

afterEach(() => { vi.unstubAllGlobals(); });

/** A screen that shows a skeleton first and grows its heading a tick later — the real shape. */
function LateHeading() {
  const [ready, setReady] = useState(false);
  useEffect(() => { setReady(true); }, []);
  return ready
    ? <h1 className="page-title">מרכז הבקרה</h1>
    : <div className="skeleton">טוען</div>;
}

/** A screen that has its heading and then loses it — a refetch dropping back to its skeleton. */
function DisappearingHeading() {
  const [shown, setShown] = useState(true);
  return shown
    ? <><h1 className="page-title">מרכז הבקרה</h1><button type="button" data-drop onClick={() => setShown(false)}>drop</button></>
    : <div className="skeleton">טוען</div>;
}

function renderAt(element: React.ReactNode = null) {
  render(
    <QueryClientProvider client={createAppQueryClient()}><ToastProvider>
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/dashboard" element={element} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ToastProvider></QueryClientProvider>,
  );
}

/* The name is ALWAYS mounted — a grid column cannot animate from nothing — so "is it showing" is
   the identity block's state, not the presence of a node. Reading the state attribute rather than
   the class string keeps these assertions about behaviour instead of about Tailwind. */
const identity = () => document.querySelector('[data-shell-identity]') as HTMLElement;
const showsScreenName = () => identity().getAttribute('data-shell-identity') === 'screen';
const barTitle = () => document.querySelector('[data-shell-title]') as HTMLElement;
const fireIntersection = (isIntersecting: boolean) => act(() => {
  for (const callback of io.fire) callback([{ isIntersecting }]);
});

describe('שם המסך בסרגל הטלפון', () => {
  /**
   * THE FAIL-SAFE, and the reason it points this way. A screen with no `h1` is exactly the screen
   * that needs the bar to name it; defaulting to hidden would fail silently and only there.
   */
  it('מסך בלי כותרת עמוד — הסרגל נושא את השם, והמשקיף אינו מופעל על דבר', () => {
    renderAt(<p>מסך בלי כותרת</p>);
    expect(showsScreenName()).toBe(true);
    expect(barTitle()).toHaveTextContent('מרכז הבקרה');
    expect(barTitle().getAttribute('aria-hidden')).toBe('false');
    expect(io.observed).toHaveLength(0);
  });

  /** The same branch, reached the other way: no observer at all, which is every other Layout spec. */
  it('סביבה בלי IntersectionObserver נופלת לאותו ענף בטוח', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    renderAt(<h1 className="page-title">מרכז הבקרה</h1>);
    expect(showsScreenName()).toBe(true);
    expect(io.observed).toHaveLength(0);
  });

  /**
   * The wiring itself. If the selector stops matching what `PageHeader` renders, or the observer
   * is pointed at the wrong node, `observed[0]` is not this heading and this fails.
   */
  it('משקיף על כותרת העמוד שבתוך אזור התוכן', () => {
    renderAt(<h1 className="page-title">מרכז הבקרה</h1>);
    const heading = document.querySelector('#main h1.page-title');
    expect(io.observed).toEqual([heading]);
  });

  /**
   * SCOPED TO `#main`, and this is the case that proves it. A `page-title` outside the content
   * area — a stale node, a portal, a print header — is not the heading this screen is showing, and
   * observing it would tie the bar's name to something that never scrolls. Without the `#main`
   * scope the observer finds this stray first (document order) and the assertion below fails.
   */
  it('מתעלם מכותרת שאינה בתוך אזור התוכן', () => {
    const stray = document.createElement('h1');
    stray.className = 'page-title';
    stray.textContent = 'כותרת נודדת';
    document.body.prepend(stray);
    try {
      renderAt(<p>מסך בלי כותרת</p>);
      expect(io.observed).toHaveLength(0);
      expect(showsScreenName()).toBe(true);
    } finally {
      stray.remove();
    }
  });

  /**
   * THE ELSE BRANCH, which a green suite hid once already. When a screen refetches and drops back
   * to its skeleton the heading disappears, and the bar must take the name back — otherwise it
   * stays blank over a page that is no longer naming itself either.
   */
  it('כותרת שנעלמת שוב מחזירה את השם לסרגל', async () => {
    renderAt(<DisappearingHeading />);
    await act(async () => { await Promise.resolve(); });
    fireIntersection(true);
    expect(showsScreenName()).toBe(false);
    // The screen drops back to a skeleton; the heading it was watching is gone.
    act(() => { document.querySelector('#main [data-drop]')?.dispatchEvent(new Event('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector('#main h1.page-title')).toBeNull();
    expect(showsScreenName()).toBe(true);
  });

  /**
   * THE MARGIN IS THE BAR. Without it the name appears only once the heading clears the whole
   * viewport, 71px after it has actually disappeared under the sticky bar. Drop `rootMargin` and
   * this reads `undefined`; measure the wrong element and it reads `-0px`.
   */
  it('שולי המשקיף הם בדיוק גובה הסרגל', () => {
    renderAt(<h1 className="page-title">מרכז הבקרה</h1>);
    expect(io.options[0]?.rootMargin).toBe(`-${BAR_HEIGHT}px 0px 0px 0px`);
  });

  /**
   * At rest the name's column has NO width, and after the owner's third pass there is nothing else
   * in the row either — the tier chip and the brand mark both left it. So on a top-level screen the
   * identity block is genuinely empty until you scroll, which is the duplication he objected to,
   * removed. The name stays mounted (a column cannot animate from nothing) and is taken out of the
   * accessibility tree, because in this state the page's own `<h1>` is the authoritative copy.
   */
  it('כותרת העמוד גלויה — עמודת השם ברוחב אפס והשורה ריקה', () => {
    renderAt(<h1 className="page-title">מרכז הבקרה</h1>);
    fireIntersection(true);
    expect(showsScreenName()).toBe(false);
    expect(identity().className).toContain('grid-cols-[auto_0fr]');
    expect(barTitle().getAttribute('aria-hidden')).toBe('true');
  });

  /**
   * THE REVEAL. One property changes — the name's column grows from `0fr` to `1fr` — and with
   * `truncate` on the text that reads as a wipe in from the leading edge, which under `dir="rtl"`
   * is out from behind the menu button. It used to push a tier chip ahead of it; the chip is gone
   * and the growth is now the whole event.
   */
  it('כותרת העמוד נגללה — עמודת השם נפתחת והשם מתגלה', () => {
    renderAt(<h1 className="page-title">מרכז הבקרה</h1>);
    fireIntersection(true);
    expect(identity().className).toContain('grid-cols-[auto_0fr]');
    fireIntersection(false);
    expect(showsScreenName()).toBe(true);
    expect(identity().className).toContain('grid-cols-[auto_1fr]');
    expect(barTitle()).toHaveTextContent('מרכז הבקרה');
    expect(barTitle().getAttribute('aria-hidden')).toBe('false');
  });

  /**
   * THE MOTION IS ON THE INLINE AXIS, and this is the assertion that keeps it there. `translate-x`
   * is physical: it does not mirror under `dir="rtl"` and would send the badge the wrong way —
   * the same trap that once put a glow outside its own button. Grid columns run along the inline
   * axis, so "toward the end" needs no direction-aware second code path.
   */
  it('התנועה היא על ציר לוגי — אין translate פיזי בגוש הזהות', () => {
    renderAt(<h1 className="page-title">מרכז הבקרה</h1>);
    expect(identity().className).toContain('transition-[grid-template-columns]');
    expect(identity().className).not.toContain('translate-x');
    expect(barTitle().className).not.toContain('translate-x');
  });

  /**
   * REDUCED MOTION REMOVES THE MOVEMENT, NOT THE NAME. This is the path most likely to be written
   * once and never exercised, so it is asserted twice: the variant is present here, and the
   * browser check measures `transition-property: none` under an emulated `reduce`.
   */
  it('תחת reduce — הקפיצה מיידית, אבל השם עדיין מתגלה', () => {
    renderAt(<h1 className="page-title">מרכז הבקרה</h1>);
    expect(identity().className).toContain('motion-reduce:transition-none');
    fireIntersection(true);
    expect(showsScreenName()).toBe(false);
    fireIntersection(false);
    expect(showsScreenName()).toBe(true);
    expect(barTitle()).toHaveTextContent('מרכז הבקרה');
  });

  /**
   * NOTHING IN THIS ROW IS ROLE-DEPENDENT ANY MORE. It was, twice: the tier chip for an owner and
   * `InPlace · <org>` for everyone else, each yielding on its own terms. Both left the bar in the
   * owner's third pass, so the two roles now take an identical path and this case exists to keep
   * it that way — a per-role branch reappearing here is a regression, not a feature.
   */
  it('לתפקיד בלי תג — אותו מסלול בדיוק, בלי ענף לפי תפקיד', () => {
    authState.role = 'office';
    renderAt(<h1 className="page-title">מרכז הבקרה</h1>);
    fireIntersection(true);
    expect(showsScreenName()).toBe(false);
    expect(identity().textContent).not.toContain('ארגון בדיקה');
    fireIntersection(false);
    expect(showsScreenName()).toBe(true);
    expect(barTitle()).toHaveTextContent('מרכז הבקרה');
    // The whole block is the name and nothing else.
    expect(identity().textContent?.trim()).toBe('מרכז הבקרה');
  });

  /**
   * THE ONE A ROUTE-ONLY BINDING FAILS. Screens return a skeleton first, so at effect time there
   * is no heading to observe. Without the MutationObserver the bar would keep the fail-safe and
   * print the title forever — on exactly the screens that load slowest, which is the least
   * visible way for this to be broken.
   */
  it('כותרת שמגיעה אחרי שלד הטעינה נתפסת בכל זאת', async () => {
    renderAt(<LateHeading />);
    // The skeleton frame observes nothing; the heading arrives, and the rebinding catches it.
    await act(async () => { await Promise.resolve(); });
    const heading = document.querySelector('#main h1.page-title');
    expect(heading).not.toBeNull();
    expect(io.observed).toEqual([heading]);
    fireIntersection(true);
    expect(showsScreenName()).toBe(false);
  });

  /** Leaving the shell must not leave two observers running over a detached tree. */
  it('מנתק את המשקיפים בפירוק', () => {
    const view = render(
      <QueryClientProvider client={createAppQueryClient()}><ToastProvider>
        <MemoryRouter initialEntries={['/dashboard']}>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/dashboard" element={<h1 className="page-title">מרכז הבקרה</h1>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider></QueryClientProvider>,
    );
    expect(io.disconnects).toBe(0);
    view.unmount();
    expect(io.disconnects).toBeGreaterThan(0);
  });

  /**
   * NO HEIGHT JUMP. jsdom cannot measure it, so what is asserted here is the MECHANISM — the block
   * is pinned to a fixed 44px rather than growing with its contents. The outcome is measured in
   * the browser (`.tmp/shell-shots`), where both states report the same header height.
   */
  it('גוש הזהות נעול לגובה קבוע כדי שהסרגל לא יגדל תוך כדי גלילה', () => {
    renderAt(<h1 className="page-title">מרכז הבקרה</h1>);
    const identity = document.querySelector('.mobile-shell-identity') as HTMLElement;
    expect(identity.className).toContain('h-11');
    expect(identity.className).not.toContain('min-h-11');
  });
});
