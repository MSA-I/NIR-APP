import { NavLink, Outlet, useNavigate, useLocation } from 'react-router';
import { LayoutDashboard, Truck, Package, Tags, ClipboardList, ShoppingCart, PackageCheck, FileText, RotateCcw, Send, CreditCard, Landmark, AlertTriangle, BarChart3, Activity, PieChart, ScrollText, Settings, LogOut, Menu, X, Building2, Bell, Search, FolderOpen, Archive } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useInboxCount } from '../lib/useInboxCount';
import { APP_NAME } from '../lib/branding';
import GlobalSearch, { canGlobalSearch } from './GlobalSearch';
import Fab from './Fab';
import NotificationBell from './NotificationBell';
import { ConfirmDialog, useDialogLayer, useToast } from './ui';
import { ORDER_DRAFT_FLUSH_EVENT, type OrderDraftFlushDetail } from '../lib/orderDrafts';
import { pendingOfflineWork } from '../lib/offlineQueue';
import type { Role } from '../lib/types';
import { toHebrewError } from '../lib/errors';

// `end` switches off NavLink's default prefix matching, and belongs on every path that is a
// parent of another path in this menu. Without it /documents and /documents/archive are both
// active on the archive page: two elements carrying aria-current="page", which is wrong for a
// screen reader and picks the wrong target for the drawer's initialFocus below, since that
// queries for exactly that attribute. It is not free — /documents stops highlighting while a
// document is open at /documents/:documentId/review, so the sidebar shows nothing selected on
// that screen. One unlit item on a detail page is the smaller harm of the two.
export interface NavItem { to: string; label: string; icon: typeof LayoutDashboard; roles: Role[]; end?: boolean }
export interface NavSection { section: string; items: NavItem[] }

// Four work groups — מסמכים / רכש / כספים / בקרה — under two ungrouped links that need no
// header to explain them. The less self-evident items (מחירונים, דרישות תשלום, התאמות בנק,
// יומן ביקורת, הגדרות, and the focused /pay, /my-prices, /admin routes) sit where the plain
// procurement/finance/control reading puts them, and /pay is shared by payer and accountant.
// None of it invents business meaning.
export const NAV_SECTIONS: NavSection[] = [
  {
    // מרכז הבקרה ראשון: הוא התשובה לסעיף 12 — מה דורש טיפול, עכשיו. הזמנה חדשה אחריו,
    // כי היא הפעולה התכופה ביותר אבל לא זו שפותחים איתה את היום.
    section: '',
    items: [
      { to: '/dashboard', label: 'מרכז הבקרה', icon: LayoutDashboard, roles: ['owner', 'office', 'kitchen', 'payer', 'accountant', 'supplier'] },
      { to: '/orders/new', label: 'הזמנה חדשה', icon: ShoppingCart, roles: ['owner', 'office', 'kitchen'] },
    ],
  },
  {
    // Documents stand apart from כספים because a scanned page is not yet a financial fact: it is
    // read and filed first, and only then becomes an invoice or a credit. The queue that does the
    // reading belongs beside the ledgers it feeds, not inside them.
    section: 'מסמכים',
    items: [
      { to: '/documents', label: 'תיקיית המסמכים', icon: FolderOpen, roles: ['owner', 'office', 'kitchen'], end: true },
      { to: '/documents/archive', label: 'ארכיון', icon: Archive, roles: ['owner', 'office', 'kitchen'] },
    ],
  },
  {
    section: 'רכש',
    items: [
      { to: '/orders', label: 'הזמנות', icon: ClipboardList, roles: ['owner', 'office', 'kitchen'], end: true },
      { to: '/receiving', label: 'קבלת סחורה', icon: PackageCheck, roles: ['owner', 'office', 'kitchen'] },
      { to: '/suppliers', label: 'ספקים', icon: Truck, roles: ['owner', 'office', 'kitchen'] },
      { to: '/products', label: 'מוצרים', icon: Package, roles: ['owner', 'office', 'kitchen'] },
      { to: '/prices', label: 'מחירונים', icon: Tags, roles: ['owner', 'office', 'kitchen'] },
      { to: '/my-prices', label: 'המחירון שלי', icon: Tags, roles: ['supplier'] },
    ],
  },
  {
    section: 'כספים',
    items: [
      { to: '/invoices', label: 'חשבוניות', icon: FileText, roles: ['owner', 'office', 'kitchen', 'accountant'] },
      { to: '/credits', label: 'זיכויים', icon: RotateCcw, roles: ['owner', 'office', 'kitchen', 'accountant'] },
      { to: '/payment-requests', label: 'דרישות תשלום', icon: Send, roles: ['owner', 'office'] },
      { to: '/payments', label: 'תשלומים', icon: CreditCard, roles: ['owner', 'accountant'] },
      { to: '/bank', label: 'התאמות בנק', icon: Landmark, roles: ['owner', 'accountant'] },
      { to: '/pay', label: 'תשלומים לביצוע', icon: CreditCard, roles: ['payer', 'accountant'] },
    ],
  },
  {
    section: 'בקרה',
    items: [
      { to: '/alerts', label: 'התראות', icon: Bell, roles: ['owner', 'office'] },
      { to: '/exceptions', label: 'חריגים', icon: AlertTriangle, roles: ['owner', 'office', 'kitchen', 'accountant'] },
      { to: '/expenses', label: 'ריכוז הוצאות', icon: PieChart, roles: ['owner', 'accountant'] },
      { to: '/reports', label: 'דוח לרו״ח', icon: BarChart3, roles: ['owner', 'accountant'] },
      { to: '/analytics', label: 'ביצועי ספקים', icon: Activity, roles: ['owner', 'office', 'accountant'] },
      { to: '/audit', label: 'יומן ביקורת', icon: ScrollText, roles: ['owner', 'accountant'] },
      { to: '/settings', label: 'הגדרות', icon: Settings, roles: ['owner'] },
    ],
  },
];

// What the sidebar actually renders, derived rather than declared: NAV_SECTIONS is the menu on
// paper, this is the menu a given person sees. Kept pure and exported so the order and the role
// filtering can be asserted without mounting the shell — the literal alone cannot prove either.
//
// Platform operators are a separate axis from tenant roles, so the console cannot ride
// NAV_SECTIONS' `roles: Role[]` filter — appending a synthetic Role would misrepresent the
// user_role enum the RLS policies are built on. It is appended after the tenant sections
// to keep the visual separation between "running this business" and "running the platform".
export function sectionsForRole(role: Role | undefined, isPlatformAdmin: boolean): NavSection[] {
  const roleSections = NAV_SECTIONS
    .map((s) => ({ ...s, items: s.items.filter((i) => role && i.roles.includes(role)) }))
    .filter((s) => s.items.length > 0);
  return isPlatformAdmin
    ? [...roleSections, { section: 'פלטפורמה', items: [{ to: '/admin', label: 'ניהול לקוחות', icon: Building2, roles: [] as Role[] }] }]
    : roleSections;
}

/**
 * Whether the sidebar's group headers earn their space — exported so the rule can be asserted
 * against `sectionsForRole` output rather than inferred from a mounted shell.
 *
 * Group headers only pay for themselves once there is more than one item to organise. supplier and
 * payer each see a single grouped link, and a "רכש" header over a vendor's own price list reads as
 * if they were doing the buying.
 *
 * G1, finding 12 (companion): the count is over the NAMED sections only. It used to count every
 * item, and once /dashboard was added for all roles (NAV_SECTIONS:37) — it lives in the unnamed
 * leading section and so never had a header to suppress — supplier and payer crossed the threshold
 * and started seeing exactly the "רכש"/"כספים" headers the rule exists to prevent. The premise
 * expired; the intent did not.
 */
export function showNavHeaders(sections: readonly NavSection[]): boolean {
  return sections.filter((s) => s.section).reduce((n, s) => n + s.items.length, 0) > 1;
}

const PAGE_TITLE_PATTERNS: [RegExp, string][] = [
  [/^\/suppliers\/[^/]+$/, 'כרטיס ספק'],
  [/^\/orders\/[^/]+$/, 'פרטי הזמנה'],
  [/^\/receiving\/[^/]+$/, 'קבלת סחורה'],
  [/^\/receipts\/[^/]+$/, 'פרטי קבלה'],
  [/^\/invoices\/new$/, 'חשבונית חדשה'],
  [/^\/invoices\/[^/]+$/, 'פרטי חשבונית'],
  [/^\/onboarding$/, 'הקמת המערכת'],
  [/^\/admin$/, 'ניהול פלטפורמה'],
];

function pageTitleFor(pathname: string): string {
  const navTitle = NAV_SECTIONS.flatMap((section) => section.items).find((item) => item.to === pathname)?.label;
  return navTitle ?? PAGE_TITLE_PATTERNS.find(([pattern]) => pattern.test(pathname))?.[1] ?? APP_NAME;
}

export default function Layout() {
  const { profile, org, roleLabels, isPlatformAdmin, signOut } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [pendingOffline, setPendingOffline] = useState<{ actions: number; uploads: number } | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const role = profile?.role;
  // Section 5: payer/supplier get no search box — their routes are dead ends for it.
  const canSearch = canGlobalSearch(role);
  // Unfiled-documents pill (0014): counted only for staff who can act on that queue. The
  // Only procurement staff can act on the gallery queue. A known count > 0 is required,
  // so null (loading) and 0 never fabricate an all-clear or workload.
  const inboxCount = useInboxCount(!!role && (['owner', 'office', 'kitchen'] as Role[]).includes(role));
  // Layout also renders during the initial load, before `org` arrives. Falling back to
  // the product name keeps the header honest — it is never another tenant's name.
  const orgName = org?.name ?? APP_NAME;

  const sections = sectionsForRole(role, isPlatformAdmin);

  const showHeaders = showNavHeaders(sections);

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
    document.title = `${pageTitleFor(location.pathname)} — ${orgName}`;
    const frame = requestAnimationFrame(() => document.getElementById('main')?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [location.pathname, orgName]);

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

  const linkCls = ({ isActive }: { isActive: boolean }) =>
    `flex min-h-11 items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset ${
      isActive ? 'bg-shell-ink text-shell font-medium' : 'text-shell-ink-soft hover:bg-shell-ink/10 hover:text-shell-ink'
    }`;

  const sidebar = (
    <div className="flex flex-col h-full">
      <div className="px-4 py-5 border-b border-shell-ink/10">
        <div className="text-lg font-bold text-shell-ink truncate" title={orgName}>{orgName}</div>
        <div className="text-xs text-shell-ink-dim">ניהול רכש ותשלומים</div>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {sections.map((s, i) => (
          <div key={i}>
            {showHeaders && s.section && <div className="px-3 pb-1 text-[11px] font-semibold text-shell-heading">{s.section}</div>}
            <div className="space-y-0.5">
              {s.items.map((item) => (
                <NavLink key={item.to} to={item.to} className={linkCls} onClick={() => { if (mobileOpen) closeMobileMenu(); }} end={item.end}>
                  <item.icon size={17} />
                  {item.label}
                  {/* TaskLine's count-pill anatomy at the item's logical end; both the desktop
                      sidebar and the mobile drawer render this same `sidebar` tree. */}
                  {item.to === '/documents' && inboxCount != null && inboxCount > 0 && (
                    <span className="badge num bg-action-soft text-action-on-soft ms-auto">{inboxCount}</span>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>
      <div className="px-4 py-3 border-t border-shell-ink/10">
        <div className="text-sm text-shell-ink font-medium">{profile?.full_name}</div>
        <div className="text-xs text-shell-ink-dim mb-2">{role ? roleLabels[role] : ''}</div>
        <button className="flex min-h-11 items-center gap-1.5 rounded-lg text-xs text-shell-ink-dim hover:text-shell-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" onClick={() => void handleSignOut()}>
          <LogOut size={13} /> התנתקות
        </button>
      </div>
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
      <aside className="hidden lg:block fixed inset-y-0 start-0 w-60 bg-shell border-e border-shell-ink/10 z-40 no-print">{sidebar}</aside>

      {/* Mobile top bar */}
      <header className="phone-safe-header lg:hidden sticky top-0 z-40 bg-shell text-shell-ink border-b border-shell-ink/10 flex min-w-0 items-center no-print">
        <button ref={menuButtonRef} type="button"
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          onClick={() => setMobileOpen(true)} aria-label="פתיחת תפריט" aria-expanded={mobileOpen} aria-controls="mobile-navigation">
          <Menu size={22} />
        </button>
        <div className="flex min-h-11 min-w-0 flex-1 items-center px-2 font-bold" title={orgName}>{orgName}</div>
        <div className="flex items-center gap-1">
          <NotificationBell onShell />
          {canSearch && (
            <button className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" onClick={() => setSearchOpen(true)}
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
            {sidebar}
          </aside>
        </div>
      )}

      {/* Global search — desktop. Injected above <main>: the headerless desktop area is empty
          today (plan §2), and lg:ms-60 lines it up beside the fixed w-60 sidebar. z-30 keeps it
          below the sidebar (z-40); sticky works because the min-h-screen wrapper has no overflow. */}
      {canSearch && (
        <header className="hidden lg:flex sticky top-0 z-30 lg:ms-60 h-14 items-center gap-3 border-b border-line bg-surface px-6 no-print">
          <GlobalSearch />
          <NotificationBell />
        </header>
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
