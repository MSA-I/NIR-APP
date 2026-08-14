import { Link, Outlet, useNavigate, useLocation } from 'react-router';
import { LayoutDashboard, Truck, Package, Tags, ClipboardList, ShoppingCart, PackageCheck, FileText, FileCheck2, RotateCcw, Send, CreditCard, Landmark, AlertTriangle, BarChart3, Activity, PieChart, Settings, LogOut, Menu, X, Building2, Bell, Search, FolderOpen, Archive, ChevronDown, ListChecks, Warehouse, ArrowRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useInboxCount } from '../lib/useInboxCount';
import { APP_NAME } from '../lib/branding';
import GlobalSearch, { canGlobalSearch } from './GlobalSearch';
import Fab from './Fab';
import NotificationBell from './NotificationBell';
import FeedbackButton from './FeedbackButton';
import { ConfirmDialog, useDialogLayer, useToast } from './ui';
import { ORDER_DRAFT_FLUSH_EVENT, type OrderDraftFlushDetail } from '../lib/orderDrafts';
import { pendingOfflineWork } from '../lib/offlineQueue';
import { isActiveRole, type ActiveRole } from '../lib/types';
import { toHebrewError } from '../lib/errors';
import { supabase } from '../lib/supabase';
import { ACTIVE_ORGANIZATION_ACCESS } from '../lib/organizationAccess';
import { isRouteFamilyActive } from '../lib/quickActions';
import { routeBackPresentation, routePresentationTitle, staticRouteTitle, type StaticRoutePath } from '../lib/routePresentation';

export interface NavItem { to: string; label: string; icon: typeof LayoutDashboard; roles: ActiveRole[] }
export interface NavSection { section: string; items: NavItem[]; collapsible?: boolean }

function navItem(to: StaticRoutePath, icon: typeof LayoutDashboard, roles: ActiveRole[]): NavItem {
  return { to, label: staticRouteTitle(to), icon, roles };
}

// Four work groups — מסמכים / רכש / כספים / בקרה — under two ungrouped links that need no
// header to explain them. The less self-evident items (מחירונים, דרישות תשלום, התאמות בנק,
// הגדרות, and the focused /pay and /admin routes) sit where the plain
// procurement/finance/control reading puts them.
// None of it invents business meaning.
//
// יומן ביקורת was here until 10.08.2026. The LEDGER did not go anywhere — audit_logs, its
// server-side triggers, the reason on every sensitive command and the immutability rules are what
// make this a financial system and they are untouched. What went is the customer-facing SCREEN:
// a page-sized table of raw mutation rows that answered no question a business owner actually
// asks, and that no other surface ever linked to. Privileged inspection stays where it belongs,
// in the platform console and in the database.
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
      navItem('/settings', Settings, ['owner']),
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
  owner: ['/documents/operations', '/documents/consolidated-invoices', '/exceptions', '/expenses', '/reports', '/analytics'],
  office: ['/documents/consolidated-invoices', '/exceptions', '/analytics'],
  accountant: ['/documents/consolidated-invoices', '/exceptions', '/expenses', '/reports'],
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
export function sectionsForRole(role: ActiveRole | undefined, isPlatformAdmin: boolean): NavSection[] {
  const roleSections: NavSection[] = role ? [
    { section: '', items: itemsFor(role, DAILY_PATHS[role]) },
    { section: 'ניהול', items: itemsFor(role, MANAGEMENT_PATHS[role] ?? []), collapsible: true },
    { section: 'בקרה', items: itemsFor(role, CONTROL_PATHS[role] ?? []), collapsible: true },
  ].filter((section) => section.items.length > 0) : [];
  const platform = { section: 'פלטפורמה', collapsible: !!role, items: [{ ...navItem('/admin', Building2, []), roles: [] as ActiveRole[] }] };
  return isPlatformAdmin ? [...roleSections, platform] : roleSections;
}

export function footerItemsForRole(role: ActiveRole | undefined): NavItem[] {
  return role === 'owner' ? itemsFor(role, ['/onboarding', '/settings']) : [];
}

export function drawerSectionsForRole(role: ActiveRole | undefined, isPlatformAdmin: boolean): NavSection[] {
  return sectionsForRole(role, isPlatformAdmin).map((section, index) => (
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
  const { profile, org, roleLabels, isPlatformAdmin, organizationAccess = ACTIVE_ORGANIZATION_ACCESS, signOut } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
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

  const sections = sectionsForRole(role, isPlatformAdmin);
  const drawerSections = drawerSectionsForRole(role, isPlatformAdmin);
  const footerItems = footerItemsForRole(role);

  const { panelRef: drawerRef, requestClose: closeMobileMenu } = useDialogLayer<HTMLElement>({
    open: mobileOpen,
    onClose: () => setMobileOpen(false),
    initialFocus: (panel) => panel.querySelector<HTMLElement>('[aria-current="page"]')
      ?? panel.querySelector<HTMLElement>('button, a'),
  });

  // Crossing into desktop closes the mobile layer so its scroll lock cannot survive a resize.
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 64rem)');
    const sync = () => { if (desktop.matches) setMobileOpen(false); };
    desktop.addEventListener('change', sync);
    sync();
    return () => {
      desktop.removeEventListener('change', sync);
    };
  }, []);

  // Route changes announce themselves through the tab title and move keyboard focus past the
  // persistent navigation shell. Query-only filter changes keep focus where the user left it.
  useEffect(() => {
    document.title = `${currentTitle} — ${orgName ? `${orgName} · ` : ''}${APP_NAME}`;
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

  const linkCls = (isActive: boolean) =>
    `flex min-h-11 items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset ${
      isActive ? 'bg-shell-ink text-shell font-medium' : 'text-shell-ink-soft hover:bg-shell-ink/10 hover:text-shell-ink'
    }`;

  const navLinks = (items: readonly NavItem[]) => items.map((item) => {
    const active = isRouteFamilyActive(location.pathname, item.to);
    return (
      <Link key={item.to} to={item.to} className={linkCls(active)} aria-current={active ? 'page' : undefined}
        onClick={() => { if (mobileOpen) closeMobileMenu(); }}>
        <item.icon size={17} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {item.to === '/documents' && inboxCount != null && inboxCount > 0 && (
          <span className="badge num bg-action-soft text-action-on-soft ms-auto">{inboxCount}</span>
        )}
      </Link>
    );
  });

  /**
   * `expandGroups` — the desktop sidebar shows every group open (owner decision 09.08.2026).
   *
   * Both navigation surfaces stay fully expanded by owner decision. The phone drawer scrolls as
   * one direct list; no destination requires opening a disclosure first.
   */
  const accountBlock = (
    <div className="px-1 pt-3">
      <div className="text-sm text-shell-ink font-medium">{profile?.full_name}</div>
      <div className="text-xs text-shell-ink-dim mb-2">{role ? roleLabels[role] : ''}</div>
      <button className="flex min-h-11 items-center gap-1.5 rounded-lg text-xs text-shell-ink-dim hover:text-shell-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" onClick={() => void handleSignOut()}>
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
        onClick={() => { if (mobileOpen) closeMobileMenu(); }}
        className="flex items-center gap-3 border-b border-shell-ink/10 px-4 py-4 pe-12 hover:bg-shell-ink/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset lg:pe-4">
        <img src={orgLogoUrl ?? '/icons/icon-192.png'} alt="" width="40" height="40"
          className="size-10 shrink-0 rounded-lg bg-white object-contain p-0.5 ring-1 ring-shell-ink/15" />
        <div className="min-w-0">
          <div className="text-base font-bold text-shell-ink">{APP_NAME}</div>
          <div className="truncate text-xs text-shell-ink-dim" title={orgName || undefined}>{orgName || 'ניהול רכש ותשלומים'}</div>
        </div>
      </Link>
      <nav aria-label={navLabel} className="scrollbar-hidden flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {[...displaySections, ...(stickyFooter || footerItems.length === 0 ? [] : [{ section: 'החשבון והמערכת', items: footerItems }])].map((s, i) => (
          s.collapsible && !expandGroups ? (
            <details key={`${s.section}-${location.pathname}`} className="group" open={s.items.some((item) => isRouteFamilyActive(location.pathname, item.to)) || undefined}>
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between rounded-lg px-3 text-xs font-semibold text-shell-heading hover:bg-shell-ink/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [&::-webkit-details-marker]:hidden">
                {s.section}<ChevronDown size={15} aria-hidden="true" className="transition-transform group-open:rotate-180" />
              </summary>
              <div className="mt-0.5 space-y-0.5">{navLinks(s.items)}</div>
            </details>
          ) : (
            <div key={s.section || i}>
              {s.section && <div className="px-3 pb-1 text-[11px] font-semibold text-shell-heading">{s.section}</div>}
              <div className="space-y-0.5">{navLinks(s.items)}</div>
            </div>
          )
        ))}
        {/* On a phone the account block travels WITH the menu instead of pinning to the bottom.
            The drawer is 100dvh of overlay: a fixed strip there is a second bar competing with the
            list scrolling behind it, and on a short viewport it ate the last destinations. On the
            desktop sidebar the strip is right — that column is permanent, has room, and the strip
            is the one place the signed-in identity lives. Same markup, different anchoring. */}
        {!stickyFooter && accountBlock}
      </nav>
      {stickyFooter && (
        <div className="border-t border-shell-ink/10 px-3 py-3">
          {footerItems.length > 0 && <div className="mb-2 space-y-0.5">{navLinks(footerItems)}</div>}
          {accountBlock}
        </div>
      )}
    </div>
  );

  return (
    <div className="min-h-dvh min-w-0">
      {/* Skip-to-content (audit round 2): the first focusable element, so a keyboard user can
          jump past the ~19 sidebar links straight to the page. Hidden until focused, then styled
          like a primary button at the logical start, z-above the sidebar (z-40). */}
      <a href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:start-3 focus:z-50 focus:rounded-lg focus:bg-action focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-action-line">
        דלג לתוכן
      </a>
      {/* Desktop sidebar */}
      <aside className="hidden lg:block fixed inset-y-0 start-0 w-60 bg-shell border-e border-shell-ink/10 z-40 no-print">{sidebar(sections, 'ניווט ראשי', true)}</aside>

      {/* Mobile top bar */}
      <header className="phone-safe-header lg:hidden sticky top-0 z-40 bg-shell text-shell-ink border-b border-shell-ink/10 flex min-w-0 items-center no-print">
        <button ref={menuButtonRef} type="button"
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          onClick={() => setMobileOpen(true)} aria-label="פתיחת תפריט" aria-expanded={mobileOpen} aria-controls="mobile-navigation">
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
            <div className="mobile-shell-subtitle truncate text-[11px] text-shell-ink-dim" title={orgName || APP_NAME}>{APP_NAME}{orgName ? ` · ${orgName}` : ''}</div>
          </div>
        </div>
        <div className="mobile-shell-actions flex shrink-0 items-center overflow-hidden rounded-lg bg-shell-ink/5 ring-1 ring-inset ring-shell-ink/15">
          <NotificationBell onShell />
          <FeedbackButton onShell />
          {canSearch && (
            <button className="flex min-h-[44px] min-w-[44px] items-center justify-center text-shell-ink-soft transition-colors hover:bg-shell-ink/10 hover:text-shell-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" onClick={() => setSearchOpen(true)}
              aria-label="חיפוש" aria-expanded={searchOpen} aria-controls="mobile-global-search"><Search size={21} /></button>
          )}
        </div>
      </header>
      {searchOpen && <GlobalSearch variant="mobile" onClose={() => setSearchOpen(false)} />}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50 bg-shell/60 no-print" onClick={() => closeMobileMenu()}>
          <aside id="mobile-navigation" ref={drawerRef} role="dialog" aria-modal="true" aria-label="תפריט ראשי"
            tabIndex={-1} className="phone-safe-drawer absolute inset-y-0 start-0 w-72 bg-shell border-e border-shell-ink/10 focus:outline-none" onClick={(e) => e.stopPropagation()}>
            <button className="absolute top-2 end-2 flex items-center justify-center min-w-11 min-h-11 rounded-lg text-shell-ink-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" onClick={() => closeMobileMenu()} aria-label="סגירת תפריט"><X size={20} /></button>
            {sidebar(drawerSections, 'יעדים נוספים', true, false)}
          </aside>
        </div>
      )}

      {/* Global search — desktop. Injected above <main>: the headerless desktop area is empty
          today (plan §2), and lg:ms-60 lines it up beside the fixed w-60 sidebar. z-30 keeps it
          below the sidebar (z-40); sticky works because the min-h-dvh wrapper has no overflow. */}
      {/* The header exists only when it has something to hold. */}
      {(canSearch || feedbackOn) && (
        <header className="hidden lg:flex sticky top-0 z-30 lg:ms-60 h-14 items-center gap-3 border-b border-line bg-surface px-6 no-print">
          {canSearch && <GlobalSearch />}
          <NotificationBell />
          <FeedbackButton />
        </header>
      )}
      {organizationAccess.mode === 'read_only' && (
        <div role="alert" className="no-print border-b border-alert-line bg-alert-wash px-4 py-3 text-sm text-alert-fg lg:ms-60 lg:px-6">
          הגישה לכתיבה אינה זמינה כרגע. המידע הקיים נשמר וזמין לצפייה ולייצוא; לפרטים יש לפנות למנהל המערכת.
        </div>
      )}
      {organizationAccess.mode === 'offboarding' && (
        <div role="alert" className="no-print border-b border-alert-line bg-alert-wash px-4 py-3 text-sm text-alert-fg lg:ms-60 lg:px-6">
          הארגון נמצא בתהליך סיום שירות והמערכת במצב קריאה בלבד. המידע נשמר וזמין לצפייה ולייצוא. בעל הארגון יכול לבטל את הבקשה בתוך 30 ימים ממועד הגשתה.
        </div>
      )}
      {/* Content — id/tabIndex are the skip-link target; focus lands here without a ring. */}
      <main id="main" tabIndex={-1}
        className="phone-safe-main min-w-0 lg:ms-60 pt-5 focus:outline-none">
        {/* max-w column centred (mx-auto) in the space beside the sidebar — otherwise a wide
            viewport strands all content on the start side in RTL, leaving a dead zone on the
            end side. keyed by path so each screen change re-triggers the fade (section 11). */}
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
