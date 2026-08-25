import { Link, Outlet, useNavigate, useLocation, useSearchParams } from 'react-router';
import { LayoutDashboard, Truck, Package, Tags, ClipboardList, ShoppingCart, PackageCheck, FileText, FileCheck2, RotateCcw, Send, CreditCard, Landmark, AlertTriangle, BarChart3, Activity, PieChart, Settings, LogOut, Menu, X, Bell, Search, FolderOpen, Archive, ChevronDown, ListChecks, Warehouse, ArrowRight, ScrollText } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useInboxCount } from '../lib/useInboxCount';
import { APP_NAME } from '../lib/branding';
import GlobalSearch, { canGlobalSearch } from './GlobalSearch';
import Fab from './Fab';
import AssistantPanel from './AssistantPanel';
import { assistantAuthorizationFingerprint, useAssistantRunSession } from '../lib/assistant/runSession';
import NotificationBell from './NotificationBell';
import FeedbackButton from './FeedbackButton';
import { PlanBadge } from './PlanBadge';
import { ConfirmDialog, useDialogLayer, useToast } from './ui';
import { ORDER_DRAFT_FLUSH_EVENT, type OrderDraftFlushDetail } from '../lib/orderDrafts';
import { pendingOfflineWork } from '../lib/offlineQueue';
import { isActiveRole, type ActiveRole } from '../lib/types';
import { toHebrewError } from '../lib/errors';
import { supabase } from '../lib/supabase';
import { ACTIVE_ORGANIZATION_ACCESS } from '../lib/organizationAccess';
import { isRouteFamilyActive, sectionOf } from '../lib/quickActions';
import { routeBackPresentation, routePresentationTitle, staticRouteTitle, type StaticRoutePath } from '../lib/routePresentation';

export interface NavItem { to: string; label: string; icon: typeof LayoutDashboard; roles: ActiveRole[] }
export interface NavSection { section: string; items: NavItem[]; collapsible?: boolean }

/* "The menu is open" is a place, not a component state (owner, 19.08.2026: the iPhone back gesture
   left the application instead of returning to the menu the screen was chosen from). Opening the
   drawer PUSHES `?menu=1` onto the router's history; picking a destination navigates to a URL
   without it, so the drawer derives itself shut and the marker entry stays behind for `back` to
   land on. Escape / backdrop / X consume that entry with `navigate(-1)` instead, so closing never
   walks the user out of the application.
   The marker rides the search string rather than the hash because `setSearchParams` resolves an
   empty hash away, and several screens write params from effects while mounted.
   CAUTION for future param writers: this only survives because every writer in the codebase builds
   its next value from `new URLSearchParams(current)`. A writer that passes a fresh object literal
   drops the marker and silently closes the drawer under the user. */
const MENU_PARAM = 'menu';

/* T7.3f pointer atmosphere: --glow-x/y drive the background's oceanic wash (.app-glow) and
   the hero band's inner light (index.css). The canvas base itself is static pure wheat.
   Mouse-only by design — attach nothing on touch devices or under reduced-motion, so those
   users keep the static default position. rAF-throttled; the CSS `--glow-x/y` transition
   supplies the easing, so React never re-renders on mouse move. */
function useGlowPointer() {
  useEffect(() => {
    if (!window.matchMedia('(pointer: fine)').matches) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0;
    let x = 0;
    let y = 0;
    const onMove = (event: PointerEvent) => {
      x = event.clientX;
      y = event.clientY;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const style = document.documentElement.style;
        style.setProperty('--glow-x', `${((x / window.innerWidth) * 100).toFixed(1)}%`);
        style.setProperty('--glow-y', `${((y / window.innerHeight) * 100).toFixed(1)}%`);
      });
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      if (raf) cancelAnimationFrame(raf);
      document.documentElement.style.removeProperty('--glow-x');
      document.documentElement.style.removeProperty('--glow-y');
    };
  }, []);
}

function navItem(to: StaticRoutePath, icon: typeof LayoutDashboard, roles: ActiveRole[]): NavItem {
  return { to, label: staticRouteTitle(to), icon, roles };
}

/* T7.2 pill navigation: the floating pill is one slim row of TEXT items (the reference's), and
   the full Hebrew titles do not fit it. These shorter forms exist for the PILL ONLY — the drawer,
   the dropdown panels, the page titles and the routePresentation catalogue keep the full names,
   so nothing desyncs. A path with no entry here simply shows its full label. */
const NAV_SHORT_LABELS: Partial<Record<string, string>> = {
  '/orders': 'הזמנות',
  '/receiving': 'קבלה',
  '/documents': 'מסמכים',
};

// Four work groups — מסמכים / רכש / כספים / בקרה — under two ungrouped links that need no
// header to explain them. The less self-evident items (מחירונים, דרישות תשלום, התאמות בנק,
// הגדרות, and the focused /pay route) sit where the plain
// procurement/finance/control reading puts them.
// None of it invents business meaning.
//
// יומן ביקורת was here until 10.08.2026 — a page-sized table of raw mutation rows for the whole
// system, which answered no question a business owner actually asks. That screen is NOT coming
// back. What came back on 19.08.2026, by owner decision, is the one question it did answer and
// nothing else: יומן עדכון ספקים (/supplier-log) — `suppliers` and `supplier_products` only, with
// the price read as before→after instead of raw JSON, because "מי שינה את המחיר של המוצר" had no
// surface at all. Owner only: the ledger is owner+accountant while the names in it are
// owner+office, so an accountant would read UUIDs. The LEDGER itself never moved — audit_logs, its
// server-side triggers, the reason on every sensitive command and the immutability rules are what
// make this a financial system and they are untouched.
export const NAV_SECTIONS: NavSection[] = [
  {
    // מרכז הבקרה ראשון: הוא התשובה לסעיף 12 — מה דורש טיפול, עכשיו. הזמנה חדשה אחריו,
    // כי היא הפעולה התכופה ביותר אבל לא זו שפותחים איתה את היום.
    section: '',
    items: [
      navItem('/dashboard', LayoutDashboard, ['owner', 'office', 'accountant']),
      navItem('/orders/new', ShoppingCart, ['owner', 'office']),
    ],
  },
  {
    // Documents stand apart from כספים because a scanned page is not yet a financial fact: it is
    // read and filed first, and only then becomes an invoice or a credit. The queue that does the
    // reading belongs beside the ledgers it feeds, not inside them.
    section: 'מסמכים',
    items: [
      navItem('/documents/operations', Activity, ['owner']),
      navItem('/documents/consolidated-invoices', FileCheck2, ['owner', 'office', 'accountant']),
      navItem('/documents', FolderOpen, ['owner', 'office']),
      navItem('/documents/archive', Archive, ['owner', 'office']),
    ],
  },
  {
    section: 'רכש',
    items: [
      navItem('/orders', ClipboardList, ['owner', 'office']),
      navItem('/receiving', PackageCheck, ['owner', 'office']),
      navItem('/inventory', Warehouse, ['owner', 'office']),
      navItem('/suppliers', Truck, ['owner', 'office']),
      navItem('/products', Package, ['owner', 'office']),
      navItem('/prices', Tags, ['owner', 'office']),
    ],
  },
  {
    section: 'כספים',
    items: [
      navItem('/invoices', FileText, ['owner', 'office', 'accountant']),
      navItem('/credits', RotateCcw, ['owner', 'office', 'accountant']),
      navItem('/payment-requests', Send, ['owner', 'office']),
      navItem('/payments', CreditCard, ['owner', 'accountant']),
      navItem('/bank', Landmark, ['owner', 'accountant']),
      navItem('/pay', CreditCard, ['accountant']),
    ],
  },
  {
    section: 'בקרה',
    items: [
      navItem('/alerts', Bell, ['owner', 'office']),
      navItem('/exceptions', AlertTriangle, ['owner', 'office', 'accountant']),
      navItem('/expenses', PieChart, ['owner', 'accountant']),
      navItem('/reports', BarChart3, ['owner', 'accountant']),
      navItem('/analytics', Activity, ['owner', 'office']),
      navItem('/supplier-log', ScrollText, ['owner']),
      navItem('/settings', Settings, ['owner']),
      // The subscription left the settings screen for an address of its own (owner report
      // 25.08.2026). It is catalogued here beside /settings because this array is the permission
      // record for every authenticated destination; where it SURFACES is decided below, by
      // SUBSCRIPTION_PATHS, and that is its own drawer group rather than a row inside control.
      navItem('/settings/subscription', CreditCard, ['owner']),
      // /onboarding was absent from this catalogue entirely, so nothing could route to it: not the
      // sidebar, not the drawer, not quickActions, and homeFor() always answers /dashboard. The
      // setup wizard was built to be RE-OPENED — it reads live counts on every mount so it shows
      // true completion state rather than a remembered claim (Onboarding.tsx:32-45) — and the one
      // thing missing was a door. It belongs to the owner, beside /settings, not in daily work.
      // The shared presentation catalogue keeps this label identical in the drawer and title bar.
      navItem('/onboarding', ListChecks, ['owner']),
    ],
  },
];

const DAILY_PATHS: Record<ActiveRole, readonly string[]> = {
  owner: ['/dashboard', '/orders', '/receiving', '/invoices', '/documents', '/suppliers'],
  office: ['/dashboard', '/orders', '/receiving', '/invoices', '/documents', '/suppliers'],
  accountant: ['/dashboard', '/invoices', '/pay', '/payments', '/bank'],
};

const MANAGEMENT_PATHS: Partial<Record<ActiveRole, readonly string[]>> = {
  owner: ['/inventory', '/products', '/prices', '/credits', '/payment-requests', '/payments', '/bank'],
  office: ['/inventory', '/products', '/prices', '/credits', '/payment-requests'],
  accountant: ['/credits'],
};

const CONTROL_PATHS: Partial<Record<ActiveRole, readonly string[]>> = {
  owner: ['/documents/operations', '/documents/consolidated-invoices', '/exceptions', '/expenses', '/reports', '/analytics', '/supplier-log'],
  office: ['/documents/consolidated-invoices', '/exceptions', '/analytics'],
  accountant: ['/documents/consolidated-invoices', '/exceptions', '/expenses', '/reports'],
};

/**
 * Its own group, not a row inside 'בקרה' (owner report 25.08.2026). Everything in the three
 * groups above is the business the tenant runs; this is the contract they run it under, and a
 * single-item group is the honest shape for a subject with exactly one screen. Owner only, the
 * same boundary the panel and the route guard already draw (owner decision 23.08.2026).
 */
const SUBSCRIPTION_PATHS: Partial<Record<ActiveRole, readonly string[]>> = {
  owner: ['/settings/subscription'],
};

function catalogItem(path: string, role: ActiveRole): NavItem | null {
  const item = NAV_SECTIONS.flatMap((section) => section.items).find((candidate) => candidate.to === path);
  return item?.roles.includes(role) ? item : null;
}

function itemsFor(role: ActiveRole, paths: readonly string[]): NavItem[] {
  return paths.map((path) => catalogItem(path, role)).filter((item): item is NavItem => item !== null);
}

// NAV_SECTIONS remains the complete permission-aware route catalogue. This function is the calmer
// presentation: daily work is visible; management and control are progressively disclosed. New
// order, alerts and archive keep their routes and page titles but enter through their contextual
// surfaces instead of competing with modules in the sidebar.
export function sectionsForRole(role: ActiveRole | undefined): NavSection[] {
  // The 'פלטפורמה' section that used to be appended here for a platform admin is gone with the
  // operator console itself (19.08.2026): /admin now lives in the separate operator application
  // (operator.html, src/operator/), and the tenant shell offers no door to it. This catalogue is
  // tenant navigation only.
  return role ? [
    { section: '', items: itemsFor(role, DAILY_PATHS[role]) },
    { section: 'ניהול', items: itemsFor(role, MANAGEMENT_PATHS[role] ?? []), collapsible: true },
    { section: 'בקרה', items: itemsFor(role, CONTROL_PATHS[role] ?? []), collapsible: true },
    // Last, and deliberately not collapsible: one item behind a disclosure is a door with a lid.
    { section: 'המנוי', items: itemsFor(role, SUBSCRIPTION_PATHS[role] ?? []) },
  ].filter((section) => section.items.length > 0) : [];
}

export function footerItemsForRole(role: ActiveRole | undefined): NavItem[] {
  return role === 'owner' ? itemsFor(role, ['/onboarding', '/settings']) : [];
}

export function drawerSectionsForRole(role: ActiveRole | undefined): NavSection[] {
  return sectionsForRole(role).map((section, index) => (
    role && index === 0 ? { ...section, section: 'עבודה שוטפת' } : section
  ));
}

/**
 * Whether the sidebar's group headers earn their space — exported so the rule can be asserted
 * against `sectionsForRole` output rather than inferred from a mounted shell.
 *
 * Group headers only pay for themselves once there is more than one item to organise. The count is
 * over named sections only; `/dashboard` lives in the unnamed leading section.
 */
export function showNavHeaders(sections: readonly NavSection[]): boolean {
  return sections.filter((s) => s.section).reduce((n, s) => n + s.items.length, 0) > 1;
}

export function pageTitleFor(pathname: string): string {
  return routePresentationTitle(pathname) ?? APP_NAME;
}

export default function Layout() {
  useGlowPointer();
  const { session, profile, org, roleLabels, organizationAccess = ACTIVE_ORGANIZATION_ACCESS, accessStatus = 'unknown', signOut } = useAuth();
  const assistantSession = useAssistantRunSession(assistantAuthorizationFingerprint({
    userId: session?.user.id,
    profileId: profile?.id,
    orgId: org?.id ?? profile?.org_id,
    role: profile?.role,
    profileActive: profile?.active,
    orgStatus: org?.status,
    accessMode: organizationAccess.mode,
    accessStatus,
  }));
  const navigate = useNavigate();
  const toast = useToast();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  // Derived, never stored: the URL is the single source of truth for the drawer, which is what
  // makes reload, a pasted `?menu=1` link and the back gesture all agree without extra handling.
  const mobileOpen = searchParams.has(MENU_PARAM);
  // Whether THIS session pushed the marker entry (as opposed to arriving on one), which decides
  // whether closing consumes a history entry or rewrites the current one.
  const pushedMenuRef = useRef(false);
  const mobileOpenRef = useRef(mobileOpen);
  mobileOpenRef.current = mobileOpen;
  const [searchOpen, setSearchOpen] = useState(false);
  /* T7.1 top navigation: which desktop dropdown group is open (one at a time; null = none).
     Disclosure-nav pattern — aria-expanded button + a list of real links, no menu roles. */
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const topNavRef = useRef<HTMLElement>(null);
  const [pendingOffline, setPendingOffline] = useState<{ actions: number; uploads: number } | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const role = isActiveRole(profile?.role) ? profile.role : undefined;
  const canSearch = canGlobalSearch(role);
  // Feedback is now a product surface for every active account, not a rollout flag that can make
  // the user's screenshot option disappear between sessions.
  const feedbackOn = !!profile;
  // Unfiled-documents pill (0014): counted only for staff who can act on that queue. The
  // Only procurement staff can act on the gallery queue. A known count > 0 is required,
  // so null (loading) and 0 never fabricate an all-clear or workload.
  const inboxCount = useInboxCount(role === 'owner' || role === 'office');
  const orgName = org?.name ?? '';
  const orgLogoUrl = org?.logo_path
    ? `${supabase.storage.from('organization-branding').getPublicUrl(org.logo_path).data.publicUrl}?v=${encodeURIComponent(org.logo_updated_at ?? '')}`
    : null;
  const currentTitle = pageTitleFor(location.pathname);
  const routeBack = routeBackPresentation(location.pathname);

  const sections = sectionsForRole(role);
  const drawerSections = drawerSectionsForRole(role);
  const footerItems = footerItemsForRole(role);

  // The current screen with a rewritten query — the pathname and hash are carried through so the
  // marker never doubles as a navigation.
  const hereWith = (params: URLSearchParams) => {
    const search = params.toString();
    return { pathname: location.pathname, search: search ? `?${search}` : '', hash: location.hash };
  };

  function openMobileMenu() {
    const next = new URLSearchParams(searchParams);
    next.set(MENU_PARAM, '1');
    pushedMenuRef.current = true;
    navigate(hereWith(next)); // a PUSH — this entry is what the back gesture returns to
  }

  const { panelRef: drawerRef, requestClose: closeMobileMenu } = useDialogLayer<HTMLElement>({
    open: mobileOpen,
    // Every deliberate close — Escape, the backdrop, the X, a resize into desktop — arrives here.
    onClose: () => {
      const next = new URLSearchParams(searchParams);
      next.delete(MENU_PARAM);
      if (pushedMenuRef.current) {
        pushedMenuRef.current = false;
        navigate(-1); // consume the entry we pushed rather than stack a second one on top of it
      } else {
        // Reload, or a link someone pasted with the marker already in it: there is no entry of
        // ours to consume, and stepping back would leave the application.
        navigate(hereWith(next), { replace: true });
      }
    },
    initialFocus: (panel) => panel.querySelector<HTMLElement>('[aria-current="page"]')
      ?? panel.querySelector<HTMLElement>('button, a'),
  });

  // Choosing a destination is not a close: the link navigates to a URL without the marker, the
  // drawer derives itself shut, and useDialogLayer's cleanup releases the scroll lock and focus
  // exactly as a manual close would — while the marker entry survives behind the new screen.
  useEffect(() => { if (!mobileOpen) pushedMenuRef.current = false; }, [mobileOpen]);

  // Crossing into desktop closes the mobile layer so its scroll lock cannot survive a resize.
  // Guarded on the drawer actually being open: this also runs once on mount, and a desktop
  // viewport must not rewrite the URL of every page load. `closeMobileMenu` is stable, so the
  // listener is registered once and reads the live state through the ref.
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 64rem)');
    const sync = () => { if (desktop.matches && mobileOpenRef.current) closeMobileMenu(); };
    desktop.addEventListener('change', sync);
    sync();
    return () => {
      desktop.removeEventListener('change', sync);
    };
  }, [closeMobileMenu]);

  // An open top-nav dropdown closes on outside pointer, on Escape (focus returns to its
  // trigger), and on any route change. One listener set, mounted only while a group is open.
  useEffect(() => {
    if (!openGroup) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!topNavRef.current?.contains(event.target as Node)) setOpenGroup(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      document.getElementById(`top-nav-group-${openGroup}`)?.focus();
      setOpenGroup(null);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [openGroup]);
  useEffect(() => { setOpenGroup(null); }, [location.pathname]);

  // Route changes announce themselves through the tab title and move keyboard focus past the
  // persistent navigation shell. Query-only filter changes keep focus where the user left it.
  // The focus move fires only on an actual pathname change: the title also re-renders when
  // orgName resolves (moments after login) and when currentTitle settles, and stealing focus
  // then blanks the global-search panel mid-typing (its panel lives on :focus).
  const focusedPathRef = useRef<string | null>(null); // null → the mount still focuses #main once
  useEffect(() => {
    document.title = `${currentTitle} — ${orgName ? `${orgName} · ` : ''}${APP_NAME}`;
    if (focusedPathRef.current === location.pathname) return;
    focusedPathRef.current = location.pathname;
    const frame = requestAnimationFrame(() => document.getElementById('main')?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [location.pathname, currentTitle, orgName]);

  // Layout is the single owner of authenticated route titles. Restore the neutral title
  // only when leaving the authenticated shell, never when tenant data finishes loading.
  useEffect(() => () => { document.title = APP_NAME; }, []);

  async function handleSignOut(confirmedWithPendingWork = false) {
    const detail: OrderDraftFlushDetail = { pending: [] };
    window.dispatchEvent(new CustomEvent<OrderDraftFlushDetail>(ORDER_DRAFT_FLUSH_EVENT, { detail }));
    if (detail.pending.length) {
      const saved = await Promise.all(detail.pending);
      if (saved.some((result) => !result)) {
        toast('לא ניתן להתנתק לפני שמירת טיוטת ההזמנה. יש לנסות שוב.', 'error');
        return;
      }
    }
    // Signing out clears the session, and a receipt still waiting in the device queue can only be
    // sent with a session (`OFFLINE-SYNC-DESIGN.md:87-88`). So it is asked, with the counts named,
    // through ConfirmDialog — never `confirm()`, which cannot be styled, translated or tested.
    if (!confirmedWithPendingWork) {
      const pending = await pendingOfflineWork();
      if (pending.actions > 0 || pending.uploads > 0) {
        setPendingOffline(pending);
        return;
      }
    }
    const result = await signOut();
    if (result.error) {
      toast(toHebrewError(result.error), 'error');
      return;
    }
    navigate('/login');
    if (result.pushWarning) toast(result.pushWarning, 'error');
  }

  /* Three navigation surfaces, one vocabulary: the dark mobile drawer keeps the paper-pill
     active state; the light floating pill and the LIGHT dropdown panels (T7.3h, owner: "להפוך
     את הצבעים" — panels flipped from deep oceanic to paper) both mark the active item with the
     small OCEANIC pill — the blue is the marker, the surface is bright. */
  const linkCls = (isActive: boolean, surface: 'shell' | 'pill' | 'panel' = 'shell') => (surface === 'shell'
    ? `flex min-h-11 items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset ${
      isActive ? 'bg-shell-ink text-shell font-medium' : 'text-shell-ink-soft hover:bg-shell-ink/10 hover:text-shell-ink'
    }`
    : surface === 'panel'
      ? `flex min-h-11 items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset ${
        isActive ? 'bg-action text-on-solid font-medium' : 'text-ink-body hover:bg-surface-hover hover:text-ink'
      }`
      : `relative flex min-h-10 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset ${
        isActive ? 'bg-action text-on-solid font-medium' : 'text-ink-soft hover:bg-surface-hover hover:text-ink'
      }`);

  /* Section identity in navigation (T7.2). The floating pill is TEXT-only (the reference's), so
     the accent cannot ride an icon there; the active pill-item carries the SAME `.section-mark`
     rule the page titles use — a 28×3px accent underline, sitting on the pill's paper surface
     (the accents clear 5:1 on paper, and fail on Onyx, which is why the mark hangs BELOW the dark
     active pill rather than inside it). On the dark surfaces (drawer/panels) the icon still takes
     `.section-glyph` exactly as before. Both consumers are the two the CSS contract already pins. */
  const navLinks = (items: readonly NavItem[], opts?: { surface?: 'shell' | 'pill' | 'panel' }) => items.map((item) => {
    const surface = opts?.surface ?? 'shell';
    const active = isRouteFamilyActive(location.pathname, item.to);
    const section = active ? sectionOf(item.to) : null;
    const pillLabel = NAV_SHORT_LABELS[item.to] ?? item.label;
    return (
      <Link key={item.to} to={item.to} className={linkCls(active, surface)} aria-current={active ? 'page' : undefined}
        data-section={section ?? undefined} title={surface === 'pill' && pillLabel !== item.label ? item.label : undefined}
        onClick={() => setOpenGroup(null)}>
        {/* Light panel (T7.3h): the icon inherits — a section-glyph accent would vanish on the
            active item's oceanic pill (accent == pill color). */}
        {surface !== 'pill' && <item.icon size={17} aria-hidden="true" className={surface === 'shell' && section ? 'section-glyph' : undefined} />}
        <span className="min-w-0 flex-1 truncate">{surface === 'pill' ? pillLabel : item.label}</span>
        {item.to === '/documents' && inboxCount != null && inboxCount > 0 && (
          <span className="badge num bg-action-soft text-action-on-soft ms-auto">{inboxCount}</span>
        )}
        {/* T7.3: no accent underline in the pill — the owner read it as an unexplained color.
            The active oceanic pill alone carries "you are here"; the page-title mark remains
            the accent surface. */}
      </Link>
    );
  });

  /**
   * `expandGroups` — the desktop sidebar shows every group open (owner decision 09.08.2026).
   *
   * Both navigation surfaces stay fully expanded by owner decision. The phone drawer scrolls as
   * one direct list; no destination requires opening a disclosure first.
   */
  /**
   * The drawer has to be OFF SCREEN before the note's screenshot runs, or the picture is of the
   * menu rather than of the screen being reported (FeedbackButton's `beforeCapture` explains why
   * the order matters at all). Two frames, not one: the first lets React commit the unmount the
   * URL change triggers, the second lets the browser paint without it. One frame still catches
   * the drawer mid-dismissal.
   */
  const dismissDrawerForCapture = () => new Promise<void>((resolve) => {
    closeMobileMenu();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

  const accountBlock = (
    <div className="px-1 pt-3">
      <div className="text-sm text-ink font-medium">{profile?.full_name}</div>
      <div className="text-xs text-ink-muted mb-2">{role ? roleLabels[role] : ''}</div>
      <button className="flex min-h-11 items-center gap-1.5 rounded-lg text-xs text-ink-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" onClick={() => void handleSignOut()}>
        <LogOut size={13} /> התנתקות
      </button>
    </div>
  );

  const sidebar = (displaySections: readonly NavSection[], navLabel: string, expandGroups = false, stickyFooter = true) => (
    <div className="flex flex-col h-full">
      {/* The mark is a door. Every product trains people that the logo goes home, and here it went
          nowhere — a 40px target in the corner of every screen that silently did nothing. It is a
          Link rather than a decorated div so it lands in the tab order, announces itself and
          honours a middle click; the image stays alt="" because the accessible name belongs to the
          link, and repeating it would make a screen reader say the brand twice. */}
      <Link to="/dashboard" aria-label={`${APP_NAME} — מעבר למרכז הבקרה`}
        className="flex items-center gap-3 border-b border-line-soft px-4 py-4 pe-12 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset lg:pe-4">
        <img src={orgLogoUrl ?? '/icons/icon-192.png'} alt="" width="40" height="40"
          className="size-10 shrink-0 rounded-lg bg-white object-contain p-0.5 ring-1 ring-line-soft" />
        <div className="min-w-0">
          <div className="text-base font-semibold text-ink">{APP_NAME}</div>
          <div className="truncate text-xs text-ink-muted" title={orgName || undefined}>{orgName || 'ניהול רכש ותשלומים'}</div>
        </div>
      </Link>
      <nav aria-label={navLabel} className="scrollbar-hidden flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {[...displaySections, ...(stickyFooter || footerItems.length === 0 ? [] : [{ section: 'החשבון והמערכת', items: footerItems }])].map((s, i) => (
          s.collapsible && !expandGroups ? (
            <details key={`${s.section}-${location.pathname}`} className="group" open={s.items.some((item) => isRouteFamilyActive(location.pathname, item.to)) || undefined}>
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between rounded-lg px-3 text-xs font-semibold text-ink-muted hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [&::-webkit-details-marker]:hidden">
                {s.section}<ChevronDown size={15} aria-hidden="true" className="transition-transform group-open:rotate-180" />
              </summary>
              <div className="mt-0.5 space-y-0.5">{navLinks(s.items, { surface: 'panel' })}</div>
            </details>
          ) : (
            <div key={s.section || i}>
              {s.section && <div className="px-3 pb-1 text-xs font-semibold text-ink-muted">{s.section}</div>}
              <div className="space-y-0.5">{navLinks(s.items, { surface: 'panel' })}</div>
            </div>
          )
        ))}
        {/* On a phone the account block travels WITH the menu instead of pinning to the bottom.
            The drawer is 100dvh of overlay: a fixed strip there is a second bar competing with the
            list scrolling behind it, and on a short viewport it ate the last destinations. On the
            desktop sidebar the strip is right — that column is permanent, has room, and the strip
            is the one place the signed-in identity lives. Same markup, different anchoring. */}
        {/* The note trigger, in the drawer because the phone top bar gave its slot to the tier
            mark (owner report 25.08.2026). It sits with the account rather than with the
            destinations: it goes nowhere, it opens a dialog. */}
        {!stickyFooter && feedbackOn && (
          <FeedbackButton variant="menu" beforeCapture={dismissDrawerForCapture} />
        )}
        {!stickyFooter && accountBlock}
      </nav>
      {stickyFooter && (
        <div className="border-t border-line-soft px-3 py-3">
          {footerItems.length > 0 && <div className="mb-2 space-y-0.5">{navLinks(footerItems, { surface: 'panel' })}</div>}
          {accountBlock}
        </div>
      )}
    </div>
  );

  /* ---- T7.1 desktop top navigation (owner decision, reference layout) ----
     The fixed sidebar became a top bar: brand at the logical start, navigation in the middle,
     search / bell / feedback / account at the end. The 19 owner destinations do not fit one row,
     so each named NAV_SECTIONS group becomes a disclosure dropdown (aria-expanded button + the
     same navLinks inside a dark panel); the unnamed first group's links stay top-level. The
     active LINK keeps the paper pill + section glyph — same language as before; a group that
     contains the active screen marks its trigger. Mobile (<lg) is untouched. */
  const groupContainsActive = (items: readonly NavItem[]) =>
    items.some((item) => isRouteFamilyActive(location.pathname, item.to));
  /* Pill-surface group trigger (T7.3): the group holding the active screen wears the same small
     OCEANIC pill as an active item. T7.3i (owner, image #21): an OPEN group wears the deep
     oceanic pill too — the trigger of the opened panel is the blue marker. */
  const groupTriggerCls = (active: boolean, open: boolean) =>
    `relative flex min-h-10 items-center gap-1 whitespace-nowrap rounded-full px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset ${
      active || open ? 'bg-action text-on-solid font-medium' : 'text-ink-soft hover:bg-surface-hover hover:text-ink'
    }`;
  const topNavGroup = (s: NavSection) => {
    const open = openGroup === s.section;
    const active = groupContainsActive(s.items);
    const holdsInboxLink = s.items.some((item) => item.to === '/documents');
    return (
      <div key={s.section} className="relative">
        <button type="button" id={`top-nav-group-${s.section}`} aria-expanded={open}
          className={groupTriggerCls(active, open)}
          onClick={() => setOpenGroup(open ? null : s.section)}>
          <span className="whitespace-nowrap">{s.section}</span>
          {holdsInboxLink && inboxCount != null && inboxCount > 0 && (
            <span className="badge num bg-action-soft text-action-on-soft">{inboxCount}</span>
          )}
          <ChevronDown size={14} aria-hidden="true" className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        {/* Mounted always, hidden when closed: the active link keeps existing in the DOM (the
            accessibility contract in layoutActiveState.spec queries it), and reopening costs
            nothing. `hidden` removes it from the a11y tree and the tab order while closed.
            T7.3h (owner, image #18): the panel is LIGHT paper — dark ink items, the active one
            marked by the small oceanic pill ("בהיר עם סימון כחול"). */}
        <div hidden={!open} className="absolute start-0 top-full z-50 mt-2 w-64 rounded-2xl bg-surface p-2 shadow-menu ring-1 ring-line-soft">
          <div className="space-y-0.5">{navLinks(s.items, { surface: 'panel' })}</div>
        </div>
      </div>
    );
  };
  const accountOpen = openGroup === 'account';
  // The reference's account affordance: an avatar circle on the background. Initials on an
  // OCEANIC disc (T7.3 — the blue leads); the menu is the same deep-oceanic panel.
  const initials = (profile?.full_name ?? '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('') || '·';
  const topAccountMenu = (
    <div className="relative">
      <button type="button" id="top-nav-group-account" aria-expanded={accountOpen}
        aria-label={`תפריט החשבון של ${profile?.full_name || 'המשתמש'}`}
        className={`grid size-10 place-items-center rounded-full bg-action text-sm font-medium text-on-solid shadow-card transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${accountOpen ? 'scale-95' : 'hover:scale-105'}`}
        onClick={() => setOpenGroup(accountOpen ? null : 'account')}>
        <span aria-hidden="true">{initials}</span>
      </button>
      {/* Mounted always, hidden when closed — same reasoning as the nav groups: the settings
          link must exist for the active-state contract even while the menu is shut.
          T7.3h: light paper panel, same as the nav dropdowns. */}
      <div hidden={!accountOpen} className="absolute end-0 top-full z-50 mt-2 w-64 rounded-2xl bg-surface p-3 shadow-menu ring-1 ring-line-soft">
        <div className="text-sm font-medium text-ink">{profile?.full_name}</div>
        <div className="text-xs text-ink-muted">{role ? roleLabels[role] : ''}{orgName ? ` · ${orgName}` : ''}</div>
        {footerItems.length > 0 && <div className="mt-2 space-y-0.5">{navLinks(footerItems, { surface: 'panel' })}</div>}
        <button className="mt-2 flex min-h-11 w-full items-center gap-1.5 rounded-lg px-3 text-sm text-ink-soft hover:bg-surface-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          onClick={() => void handleSignOut()}>
          <LogOut size={14} /> התנתקות
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-dvh min-w-0">
      {/* T7.3f: the pointer's oceanic wash drifts on the background itself (.app-glow, fixed,
          z -1) over a static pure-wheat canvas — no static color base under it, no card
          spotlights. T7.3i: the dashboard hero band is gone — every screen shares this. */}
      <div aria-hidden="true" className="app-glow no-print" />
      {/* Skip-to-content (audit round 2): the first focusable element, so a keyboard user can
          jump past the navigation bar straight to the page. Hidden until focused, then styled
          like a primary button at the logical start, z-above the top bar (z-40). */}
      <a href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:start-3 focus:z-50 focus:rounded-lg focus:bg-action focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-on-solid focus:shadow-menu focus:outline-none focus:ring-2 focus:ring-focus">
        דלג לתוכן
      </a>
      {/* Desktop navigation (T7.2, reference layout) — no bar. Floating pills on the glowing
          canvas: an outlined logo pill at the start, a centered WHITE pill holding the text-only
          navigation (active item = small dark pill + accent underline), and at the end the search
          pill, bell, feedback and the avatar disc — sitting straight on the background. */}
      <header ref={topNavRef} className="hidden lg:block sticky top-0 z-40 bg-topbar/75 backdrop-blur-sm no-print">
        <div className="mx-auto flex min-h-[4.25rem] max-w-[1400px] items-center gap-3 px-4 py-2">
          <Link to="/dashboard" aria-label={`${APP_NAME} — מעבר למרכז הבקרה`}
            className="flex shrink-0 items-center gap-2 rounded-full bg-surface/85 py-1 ps-1.5 pe-3 shadow-card ring-1 ring-line-soft transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus xl:pe-4">
            <img src={orgLogoUrl ?? '/icons/icon-192.png'} alt="" width="32" height="32"
              className="size-8 shrink-0 rounded-full bg-white object-contain p-0.5" />
            <span className="hidden text-sm font-semibold text-ink xl:block">{APP_NAME}</span>
          </Link>
          <div className="flex min-w-0 flex-1 justify-center">
            <nav aria-label="ניווט ראשי"
              className="flex items-center gap-0.5 rounded-full bg-surface/90 p-1.5 shadow-card ring-1 ring-line-soft backdrop-blur">
              {sections.map((s) => (
                s.section
                  ? topNavGroup(s)
                  : <div key="primary" className="flex items-center gap-0.5">{navLinks(s.items, { surface: 'pill' })}</div>
              ))}
            </nav>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {canSearch && <div className="w-44 xl:w-64 [&_input]:rounded-full [&_input]:bg-surface/90"><GlobalSearch /></div>}
            {/* Self-gated on assistant.ui (fail-closed); renders nothing while the flag is off. */}
            <AssistantPanel session={assistantSession} />
            <NotificationBell />
            {feedbackOn && <FeedbackButton />}
            {topAccountMenu}
          </div>
        </div>
      </header>

      {/* Mobile top bar */}
      {/* T7.3j: the phone shell joins the desktop language — cool-gray translucent bar, paper
          drawer with the oceanic active pill. */}
      <header className="phone-safe-header lg:hidden sticky top-0 z-40 bg-topbar/75 backdrop-blur-sm text-ink border-b border-line-soft flex min-w-0 items-center no-print">
        <button ref={menuButtonRef} type="button"
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          onClick={openMobileMenu} aria-label="פתיחת תפריט" aria-expanded={mobileOpen} aria-controls="mobile-navigation">
          <Menu size={22} />
        </button>
        <div className="mobile-shell-identity flex min-h-11 min-w-0 flex-1 items-center gap-2 px-2">
          {/* Only the mark is the link, not the whole block: the text beside it is the CURRENT
              page's title, and wrapping that in a "go to dashboard" link would make the screen
              name its own destination — the one place a logo home-link reliably confuses people. */}
          {routeBack ? (
            <Link to={routeBack.to} aria-label={routeBack.label} title={routeBack.label}
              className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
              <ArrowRight size={21} aria-hidden="true" />
            </Link>
          ) : (
            <Link to="/dashboard" aria-label={`${APP_NAME} — מעבר למרכז הבקרה`}
              className="mobile-shell-mark flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
              <img src={orgLogoUrl ?? '/icons/icon-192.png'} alt="" width="28" height="28"
                className="size-7 rounded-md bg-white object-contain p-px ring-1 ring-shell-ink/15" />
            </Link>
          )}
          <div className="min-w-0 leading-tight">
            <div className="truncate text-sm font-semibold" title={currentTitle}>{currentTitle}</div>
            <div className="mobile-shell-subtitle truncate text-xs text-shell-ink-dim" title={orgName || APP_NAME}>{APP_NAME}{orgName ? ` · ${orgName}` : ''}</div>
          </div>
        </div>
        {/* T7.3k (owner, images #33-34 "אתה רואה את ההבדלים בשפה?"): the desktop language —
            bare round icon targets in dark ink straight on the bar, no boxed cluster. */}
        {/* Owner report 25.08.2026: the note trigger left this cluster and the tier mark took its
            slot. The note is not gone — it is a row in the drawer, where the same click also has
            room for a word. Four icon targets and a phone title do not fit on a 390px bar, and
            the one of them a person uses least often is the one that moves. */}
        <div className="mobile-shell-actions flex shrink-0 items-center gap-0.5">
          <AssistantPanel session={assistantSession} />
          <NotificationBell />
          <PlanBadge />
          {canSearch && (
            <button className="grid size-[44px] shrink-0 place-items-center rounded-full text-ink-soft transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" onClick={() => setSearchOpen(true)}
              aria-label="חיפוש" aria-expanded={searchOpen} aria-controls="mobile-global-search"><Search size={21} /></button>
          )}
        </div>
      </header>
      {searchOpen && <GlobalSearch variant="mobile" onClose={() => setSearchOpen(false)} />}
      {/* T7.3k (owner, image #35): neutral dark scrim — the oceanic one read as a strange
          blue tint over the page. */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50 bg-shell/50 no-print" onClick={() => closeMobileMenu()}>
          {/* T7.3k fix (owner, image #29): OPAQUE light gray — translucency here sat over the
              dark backdrop and the page behind it, and the blend read as a murky blue tint.
              The top bar can stay translucent because only the light canvas scrolls under it. */}
          <aside id="mobile-navigation" ref={drawerRef} role="dialog" aria-modal="true" aria-label="תפריט ראשי"
            tabIndex={-1} className="phone-safe-drawer absolute inset-y-0 start-0 w-72 bg-topbar border-e border-line-soft focus:outline-none" onClick={(e) => e.stopPropagation()}>
            <button className="absolute top-2 end-2 flex items-center justify-center min-w-11 min-h-11 rounded-lg text-ink-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" onClick={() => closeMobileMenu()} aria-label="סגירת תפריט"><X size={20} /></button>
            {sidebar(drawerSections, 'יעדים נוספים', true, false)}
          </aside>
        </div>
      )}

      {/* The utility header merged into the top bar (T7.1); search/bell/feedback live there now. */}
      {accessStatus !== 'unknown' && organizationAccess.mode === 'read_only' && (
        <div role="alert" className="no-print border-b border-alert-line bg-alert-wash px-4 py-3 text-sm text-alert-fg lg:px-6">
          הגישה לכתיבה אינה זמינה כרגע. המידע הקיים נשמר וזמין לצפייה ולייצוא; לפרטים יש לפנות למנהל המערכת.
        </div>
      )}
      {accessStatus !== 'unknown' && organizationAccess.mode === 'offboarding' && (
        <div role="alert" className="no-print border-b border-alert-line bg-alert-wash px-4 py-3 text-sm text-alert-fg lg:px-6">
          הארגון נמצא בתהליך סיום שירות והמערכת במצב קריאה בלבד. המידע נשמר וזמין לצפייה ולייצוא. בעל הארגון יכול לבטל את הבקשה בתוך 30 ימים ממועד הגשתה.
        </div>
      )}
      {/* Content — id/tabIndex are the skip-link target; focus lands here without a ring.
          `data-section` is the paper half of the section identity and the ONLY place the accent
          enters the working area: it resolves `--section-accent` for everything below it, which
          today means the short rule under the page title (`.section-mark`). It is set from the
          URL, never from data, so no screen can turn it into a status; a screen with no work
          domain (/dashboard, the בקרה screens, settings) simply carries no attribute and the
          mark stays hidden. */}
      <main id="main" tabIndex={-1} data-section={sectionOf(location.pathname) ?? undefined}
        className="phone-safe-main min-w-0 pt-5 focus:outline-none">
        {/* max-w column centred (mx-auto) under the top bar — the same 1400px measure the bar
            itself uses, so navigation and content share one grid. keyed by path so each screen
            change re-triggers the fade (section 11). */}
        <div key={location.pathname} className="page-fade mx-auto min-w-0 max-w-[1400px]">
          <Outlet />
        </div>
      </main>

      {/* Role-aware quick actions — direct mobile bar and desktop speed dial. The component
          self-gates by role and focused route; Layout never wraps public pages. */}
      <Fab />

      {/* Unsynced receiving work + logout. The counts are named rather than summarised: "2 פעולות"
          and "1 העלאה" are different work, and a person deciding whether to sign out on a phone
          with no signal needs to know which of the two they are about to leave behind. */}
      <ConfirmDialog open={pendingOffline !== null} danger
        title="יש נתונים שטרם סונכרנו"
        message={pendingOffline
          ? `במכשיר הזה ממתינות ${pendingOffline.actions} פעולות קבלה ו-${pendingOffline.uploads} העלאות שלא נשלחו לשרת. `
            + 'התנתקות מוחקת את הסשן, והפעולות האלה יישלחו רק לאחר התחברות מחדש באותו מכשיר ובאותו דפדפן. '
            + 'מומלץ להתחבר לרשת, לסנכרן, ורק אז להתנתק.'
          : ''}
        confirmLabel="התנתקות בכל זאת"
        onClose={() => setPendingOffline(null)}
        onConfirm={() => { setPendingOffline(null); void handleSignOut(true); }} />
    </div>
  );
}
