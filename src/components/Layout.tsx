import { Link, Outlet, useNavigate, useLocation } from 'react-router';
import { LayoutDashboard, Truck, Package, Tags, ClipboardList, ShoppingCart, PackageCheck, FileText, RotateCcw, Send, CreditCard, Landmark, AlertTriangle, BarChart3, Activity, PieChart, ScrollText, Settings, LogOut, Menu, X, Building2, Bell, Search, FolderOpen, Archive, ChevronDown, ListChecks, Warehouse } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useInboxCount } from '../lib/useInboxCount';
import { APP_NAME } from '../lib/branding';
import GlobalSearch, { canGlobalSearch } from './GlobalSearch';
import Fab from './Fab';
import NotificationBell from './NotificationBell';
import FeedbackButton from './FeedbackButton';
import { ConfirmDialog, Note, useDialogLayer, useToast } from './ui';
import { useFeatureFlags } from '../lib/flags';
import { FEEDBACK_FLAG } from '../lib/feedback';
import { TRIAL_WARNING_DAYS, trialDaysRemaining } from '../lib/trial';
import { fmtDate } from '../lib/format';
import { ORDER_DRAFT_FLUSH_EVENT, type OrderDraftFlushDetail } from '../lib/orderDrafts';
import { pendingOfflineWork } from '../lib/offlineQueue';
import type { Role } from '../lib/types';
import { toHebrewError } from '../lib/errors';
import { supabase } from '../lib/supabase';
import { ACTIVE_ORGANIZATION_ACCESS } from '../lib/trial';
import { isRouteFamilyActive } from '../lib/quickActions';

export interface NavItem { to: string; label: string; icon: typeof LayoutDashboard; roles: Role[] }
export interface NavSection { section: string; items: NavItem[]; collapsible?: boolean }

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
      { to: '/documents/operations', label: 'תפעול מסמכים', icon: Activity, roles: ['owner'] },
      { to: '/documents', label: 'תיקיית המסמכים', icon: FolderOpen, roles: ['owner', 'office', 'kitchen'] },
      { to: '/documents/archive', label: 'ארכיון', icon: Archive, roles: ['owner', 'office', 'kitchen'] },
    ],
  },
  {
    section: 'רכש',
    items: [
      { to: '/orders', label: 'הזמנות', icon: ClipboardList, roles: ['owner', 'office', 'kitchen'] },
      { to: '/receiving', label: 'קבלת סחורה', icon: PackageCheck, roles: ['owner', 'office', 'kitchen'] },
      { to: '/inventory', label: 'מלאי', icon: Warehouse, roles: ['owner', 'office', 'kitchen'] },
      { to: '/suppliers', label: 'ספקים', icon: Truck, roles: ['owner', 'office', 'kitchen'] },
      { to: '/products', label: 'מוצרים', icon: Package, roles: ['owner', 'office', 'kitchen'] },
      { to: '/prices', label: 'מחירונים', icon: Tags, roles: ['owner', 'office', 'kitchen'] },
      { to: '/my-prices', label: 'פורטל הספק', icon: Tags, roles: ['supplier'] },
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
      { to: '/analytics', label: 'ביצועי ספקים', icon: Activity, roles: ['owner', 'office'] },
      { to: '/audit', label: 'יומן ביקורת', icon: ScrollText, roles: ['owner', 'accountant'] },
      { to: '/settings', label: 'הגדרות', icon: Settings, roles: ['owner'] },
      // /onboarding was absent from this catalogue entirely, so nothing could route to it: not the
      // sidebar, not the drawer, not quickActions, and homeFor() always answers /dashboard. The
      // setup wizard was built to be RE-OPENED — it reads live counts on every mount so it shows
      // true completion state rather than a remembered claim (Onboarding.tsx:32-45) — and the one
      // thing missing was a door. It belongs to the owner, beside /settings, not in daily work.
      // „הקמת המערכת”, matching PAGE_TITLE_PATTERNS' existing entry for this route rather than
      // inventing a second name for it — pageTitleFor prefers the nav label, so a different word
      // here would have quietly changed the browser tab title too.
      { to: '/onboarding', label: 'הקמת המערכת', icon: ListChecks, roles: ['owner'] },
    ],
  },
];

const DAILY_PATHS: Record<Role, readonly string[]> = {
  owner: ['/dashboard', '/orders', '/receiving', '/invoices', '/documents', '/suppliers'],
  office: ['/dashboard', '/orders', '/receiving', '/invoices', '/documents', '/suppliers'],
  kitchen: ['/dashboard', '/orders', '/receiving', '/documents', '/suppliers'],
  accountant: ['/dashboard', '/invoices', '/pay', '/payments', '/bank'],
  payer: ['/dashboard', '/pay'],
  supplier: ['/dashboard', '/my-prices'],
};

const MANAGEMENT_PATHS: Partial<Record<Role, readonly string[]>> = {
  owner: ['/inventory', '/products', '/prices', '/credits', '/payment-requests', '/payments', '/bank'],
  office: ['/inventory', '/products', '/prices', '/credits', '/payment-requests'],
  kitchen: ['/inventory', '/products', '/prices', '/invoices', '/credits'],
  accountant: ['/credits'],
};

const CONTROL_PATHS: Partial<Record<Role, readonly string[]>> = {
  owner: ['/documents/operations', '/exceptions', '/expenses', '/reports', '/analytics', '/audit'],
  office: ['/exceptions', '/analytics'],
  kitchen: ['/exceptions'],
  accountant: ['/exceptions', '/expenses', '/reports', '/audit'],
};

function catalogItem(path: string, role: Role): NavItem | null {
  const item = NAV_SECTIONS.flatMap((section) => section.items).find((candidate) => candidate.to === path);
  return item?.roles.includes(role) ? item : null;
}

function itemsFor(role: Role, paths: readonly string[]): NavItem[] {
  return paths.map((path) => catalogItem(path, role)).filter((item): item is NavItem => item !== null);
}

// NAV_SECTIONS remains the complete permission-aware route catalogue. This function is the calmer
// presentation: daily work is visible; management and control are progressively disclosed. New
// order, alerts and archive keep their routes and page titles but enter through their contextual
// surfaces instead of competing with modules in the sidebar.
export function sectionsForRole(role: Role | undefined, isPlatformAdmin: boolean): NavSection[] {
  const roleSections: NavSection[] = role ? [
    { section: '', items: itemsFor(role, DAILY_PATHS[role]) },
    { section: 'ניהול', items: itemsFor(role, MANAGEMENT_PATHS[role] ?? []), collapsible: true },
    { section: 'בקרה', items: itemsFor(role, CONTROL_PATHS[role] ?? []), collapsible: true },
  ].filter((section) => section.items.length > 0) : [];
  const platform = { section: 'פלטפורמה', collapsible: !!role, items: [{ to: '/admin', label: 'ניהול לקוחות', icon: Building2, roles: [] as Role[] }] };
  return isPlatformAdmin ? [...roleSections, platform] : roleSections;
}

export function footerItemsForRole(role: Role | undefined): NavItem[] {
  return role === 'owner' ? itemsFor(role, ['/onboarding', '/settings']) : [];
}

export function drawerSectionsForRole(role: Role | undefined, isPlatformAdmin: boolean): NavSection[] {
  return sectionsForRole(role, isPlatformAdmin);
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
  [/^\/documents\/[^/]+\/review$/, 'בדיקת מסמך'],
  [/^\/pay\/emergency$/, 'תשלום חירום'],
  [/^\/onboarding$/, 'הקמת המערכת'],
  [/^\/admin$/, 'ניהול פלטפורמה'],
];

export function pageTitleFor(pathname: string): string {
  const navTitle = NAV_SECTIONS.flatMap((section) => section.items).find((item) => item.to === pathname)?.label;
  return navTitle ?? PAGE_TITLE_PATTERNS.find(([pattern]) => pattern.test(pathname))?.[1] ?? APP_NAME;
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
  const role = profile?.role;
  // Section 5: payer/supplier get no search box — their routes are dead ends for it.
  const canSearch = canGlobalSearch(role);
  // Read here only to decide whether the desktop header exists at all; FeedbackButton gates
  // itself on the same flag, fail-closed. The flag governs UI, never permission (0059's flag law).
  const feedbackOn = useFeatureFlags().isEnabled(FEEDBACK_FLAG);
  // null unless this is a trial with a future end date — see trialDaysRemaining for why an already
  // expired trial answers null rather than 0.
  const trialDays = trialDaysRemaining(org);
  // Unfiled-documents pill (0014): counted only for staff who can act on that queue. The
  // Only procurement staff can act on the gallery queue. A known count > 0 is required,
  // so null (loading) and 0 never fabricate an all-clear or workload.
  const inboxCount = useInboxCount(!!role && (['owner', 'office', 'kitchen'] as Role[]).includes(role));
  const orgName = org?.name ?? '';
  const orgLogoUrl = org?.logo_path
    ? `${supabase.storage.from('organization-branding').getPublicUrl(org.logo_path).data.publicUrl}?v=${encodeURIComponent(org.logo_updated_at ?? '')}`
    : null;
  const currentTitle = pageTitleFor(location.pathname);

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
   * The groups were born collapsed in the UX-polish campaign, on the reasoning that "ניהול" and
   * "בקרה" are rare destinations and progressive disclosure keeps the daily list short. On a phone
   * that still holds: the drawer is a temporary overlay competing with the content behind it, and
   * it keeps the disclosure. On a desktop the sidebar is a permanent 240px column with room to
   * spare — hiding six destinations behind two chevrons costs a click and buys nothing.
   *
   * Note this renders them through the EXISTING non-collapsible branch rather than forcing
   * `<details open>`: an always-open disclosure is a control that lies about being a control.
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
      <nav aria-label={navLabel} className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
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
        <div className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-2">
          {/* Only the mark is the link, not the whole block: the text beside it is the CURRENT
              page's title, and wrapping that in a "go to dashboard" link would make the screen
              name its own destination — the one place a logo home-link reliably confuses people. */}
          <Link to="/dashboard" aria-label={`${APP_NAME} — מעבר למרכז הבקרה`}
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
            <img src={orgLogoUrl ?? '/icons/icon-192.png'} alt="" width="28" height="28"
              className="size-7 rounded-md bg-white object-contain p-px ring-1 ring-shell-ink/15" />
          </Link>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-sm font-semibold" title={currentTitle}>{currentTitle}</div>
            <div className="truncate text-[11px] text-shell-ink-dim" title={orgName || APP_NAME}>{APP_NAME}{orgName ? ` · ${orgName}` : ''}</div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <NotificationBell onShell />
          <FeedbackButton onShell />
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
            {sidebar(drawerSections, 'יעדים נוספים', false, false)}
          </aside>
        </div>
      )}

      {/* Global search — desktop. Injected above <main>: the headerless desktop area is empty
          today (plan §2), and lg:ms-60 lines it up beside the fixed w-60 sidebar. z-30 keeps it
          below the sidebar (z-40); sticky works because the min-h-dvh wrapper has no overflow. */}
      {/* The header exists when it has something to hold. Until package 0 that was the search box
          alone, which left payer and supplier — the two roles with the most blocked tasks in
          DEAD-ENDS-AUDIT — with no desktop slot to report from. */}
      {(canSearch || feedbackOn) && (
        <header className="hidden lg:flex sticky top-0 z-30 lg:ms-60 h-14 items-center gap-3 border-b border-line bg-surface px-6 no-print">
          {canSearch && <GlobalSearch />}
          <NotificationBell />
          <FeedbackButton />
        </header>
      )}
      {organizationAccess.mode === 'grace' && (
        <div role="status" className="no-print border-b border-await-line bg-await-wash px-4 py-3 text-sm text-await-fg lg:ms-60 lg:px-6">
          תקופת הניסיון הסתיימה. נותרו <span className="num font-semibold">{organizationAccess.graceDaysRemaining}</span> ימים להמשך שימוש מלא במערכת. לאחר מכן המערכת תעבור למצב קריאה בלבד והמידע שלך יישאר זמין לצפייה ולייצוא.
        </div>
      )}
      {organizationAccess.mode === 'read_only' && (
        <div role="alert" className="no-print border-b border-alert-line bg-alert-wash px-4 py-3 text-sm text-alert-fg lg:ms-60 lg:px-6">
          תקופת הניסיון הסתיימה. המערכת נמצאת כעת במצב קריאה בלבד. כל המידע הקיים נשמר וזמין לצפייה ולייצוא. להפעלת המערכת מחדש יש לפנות למנהל השירות.
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
        {/* #15 shipped the soft block but nothing announced it in advance: the first thing the owner
            learned was a full-screen stop. Owner only — a kitchen user cannot arrange the
            continuation, and a banner nobody can act on for a week is noise; the expired screen
            still tells everyone at the moment it matters. Wording matches that screen ("מפעיל
            השירות", "הנתונים שמורים") so the two never contradict each other. */}
        {profile?.role === 'owner' && trialDays !== null && trialDays <= TRIAL_WARNING_DAYS && (
          <div className="mx-auto mb-4 min-w-0 max-w-[1400px] px-4 no-print sm:px-6">
            <Note tone="await">
              תקופת הניסיון מסתיימת ב-{fmtDate(org?.trial_ends_at)}
              {' — '}
              {trialDays === 1 ? 'נותר יום אחד' : `נותרו ${trialDays} ימים`}. הנתונים שמורים במלואם;
              להמשך השימוש יש להסדיר את ההמשך מול מפעיל השירות.
            </Note>
          </div>
        )}
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
