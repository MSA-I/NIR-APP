import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { LayoutDashboard, Truck, Package, Tags, ClipboardList, ShoppingCart, PackageCheck, FileText, RotateCcw, Send, CreditCard, Landmark, AlertTriangle, BarChart3, PieChart, ScrollText, Settings, LogOut, Menu, X, Building2, Bell, Search, Inbox } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useInboxCount } from '../lib/useInboxCount';
import { APP_NAME } from '../lib/branding';
import GlobalSearch, { canGlobalSearch } from './GlobalSearch';
import Fab from './Fab';
import type { Role } from '../lib/types';

interface NavItem { to: string; label: string; icon: typeof LayoutDashboard; roles: Role[]; mobile?: boolean }

// Section 8 regroup — Nir's three working groups (רכש / כספים / בקרה), המשך פיתוח.txt:116-138.
//
// Two deliberate departures from a literal reading, both flagged to the user:
//  - Dashboard stays pinned in the headerless section at the top, not folded into בקרה where
//    Nir listed it. It is the landing route for owner/office (AuthContext homeFor), and
//    sections 1-3 make it THE control centre — burying it three groups down would undercut
//    exactly the screen those sections are trying to elevate.
//  - Nine items Nir did not place (מחירונים, הזמנה חדשה, דרישות תשלום, התאמות בנק, יומן
//    ביקורת, הגדרות, and the single-role /pay, /my-prices, /admin) are slotted by the
//    obvious procurement/finance/control reading. None of it invents business meaning.
//
// Order inside רכש keeps the three order-flow items (new/list/receiving) contiguous and
// ahead of חשבוניות so the mobile bottom bar (mobileItems, keyed off `mobile` + declaration
// order) stays exactly {הזמנה חדשה, הזמנות, קבלת סחורה, חשבוניות, זיכויים} for staff roles.
const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: '',
    items: [
      { to: '/dashboard', label: 'דשבורד', icon: LayoutDashboard, roles: ['owner', 'office'] },
    ],
  },
  {
    section: 'רכש',
    items: [
      { to: '/orders/new', label: 'הזמנה חדשה', icon: ShoppingCart, roles: ['owner', 'office', 'kitchen'], mobile: true },
      { to: '/orders', label: 'הזמנות', icon: ClipboardList, roles: ['owner', 'office', 'kitchen'], mobile: true },
      { to: '/receiving', label: 'קבלת סחורה', icon: PackageCheck, roles: ['owner', 'office', 'kitchen'], mobile: true },
      { to: '/suppliers', label: 'ספקים', icon: Truck, roles: ['owner', 'office', 'kitchen', 'accountant'] },
      { to: '/products', label: 'מוצרים', icon: Package, roles: ['owner', 'office', 'kitchen'] },
      { to: '/prices', label: 'מחירונים', icon: Tags, roles: ['owner', 'office', 'kitchen'] },
      { to: '/my-prices', label: 'המחירון שלי', icon: Tags, roles: ['supplier'], mobile: true },
    ],
  },
  {
    section: 'כספים',
    items: [
      { to: '/invoices', label: 'חשבוניות', icon: FileText, roles: ['owner', 'office', 'kitchen', 'accountant'], mobile: true },
      { to: '/credits', label: 'זיכויים', icon: RotateCcw, roles: ['owner', 'office', 'kitchen', 'accountant'], mobile: true },
      { to: '/inbox', label: 'מסמכים', icon: Inbox, roles: ['owner', 'office', 'kitchen'] },
      { to: '/payment-requests', label: 'דרישות תשלום', icon: Send, roles: ['owner', 'office'] },
      { to: '/payments', label: 'תשלומים', icon: CreditCard, roles: ['owner', 'office', 'accountant'] },
      { to: '/bank', label: 'התאמות בנק', icon: Landmark, roles: ['owner', 'office', 'accountant'] },
      { to: '/pay', label: 'תשלומים לביצוע', icon: CreditCard, roles: ['payer'], mobile: true },
    ],
  },
  {
    section: 'בקרה',
    items: [
      { to: '/alerts', label: 'התראות', icon: Bell, roles: ['owner', 'office'] },
      { to: '/exceptions', label: 'חריגים', icon: AlertTriangle, roles: ['owner', 'office', 'kitchen', 'accountant'] },
      { to: '/expenses', label: 'ריכוז הוצאות', icon: PieChart, roles: ['owner', 'office', 'accountant'] },
      { to: '/reports', label: 'דוח לרו״ח', icon: BarChart3, roles: ['owner', 'office', 'accountant'] },
      { to: '/audit', label: 'יומן ביקורת', icon: ScrollText, roles: ['owner', 'office', 'accountant'] },
      { to: '/settings', label: 'הגדרות', icon: Settings, roles: ['owner'] },
    ],
  },
];

export default function Layout() {
  const { profile, org, roleLabels, isPlatformAdmin, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const role = profile?.role;
  // Section 5: payer/supplier get no search box — their only routes are dead ends for it.
  const canSearch = canGlobalSearch(role);
  // Documents-inbox pill (0014): counted only for the roles that see the /inbox item; the
  // pill renders solely for a known count > 0 — null (loading) and 0 both render nothing,
  // so it never fabricates an all-clear or a workload (CLAUDE.md).
  const inboxCount = useInboxCount(!!role && (['owner', 'office', 'kitchen'] as Role[]).includes(role));
  // Layout also renders during the initial load, before `org` arrives. Falling back to
  // the product name keeps the header honest — it is never another tenant's name.
  const orgName = org?.name ?? APP_NAME;

  const roleSections = NAV.map((s) => ({ ...s, items: s.items.filter((i) => role && i.roles.includes(role)) }))
    .filter((s) => s.items.length > 0);

  // Platform operators are a separate axis from tenant roles, so the console cannot ride
  // NAV's `roles: Role[]` filter — appending a synthetic Role would misrepresent the
  // user_role enum the RLS policies are built on. It is appended after the tenant sections
  // to keep the visual separation between "running this business" and "running the platform".
  const sections = isPlatformAdmin
    ? [...roleSections, { section: 'פלטפורמה', items: [{ to: '/admin', label: 'ניהול לקוחות', icon: Building2, roles: [] as Role[] }] }]
    : roleSections;

  // Deliberately from roleSections: the operator console is a desktop task. The five-item cap
  // fits the complete staff bar without letting the platform route displace a tenant item.
  const mobileItems = roleSections.flatMap((s) => s.items).filter((i) => i.mobile).slice(0, 5);

  // Group headers only earn their space once there is more than one item to organise. supplier
  // and payer each see a single link, and a "רכש" header over a vendor's own price list reads
  // as if they were doing the buying. Below the threshold the header is noise, so drop it.
  const showHeaders = sections.reduce((n, s) => n + s.items.length, 0) > 1;

  async function handleSignOut() {
    await signOut();
    navigate('/login');
  }

  const linkCls = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
      isActive ? 'bg-shell-ink text-shell font-medium' : 'text-shell-ink-soft hover:bg-shell-ink/10 hover:text-shell-ink'
    }`;

  const sidebar = (
    <div className="flex flex-col h-full">
      <NavLink to="/dashboard" aria-label={`${orgName} — חזרה לדשבורד`}
        className="block px-4 py-5 border-b border-shell-ink/10 transition-colors hover:bg-shell-ink/5 active:bg-shell-ink/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus">
        <div className="text-lg font-bold text-shell-ink truncate" title={orgName}>{orgName}</div>
        <div className="text-xs text-shell-ink-dim">ניהול רכש ותשלומים</div>
      </NavLink>
      <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {sections.map((s, i) => (
          <div key={i}>
            {showHeaders && s.section && <div className="px-3 pb-1 text-[11px] font-semibold text-shell-heading uppercase">{s.section}</div>}
            <div className="space-y-0.5">
              {s.items.map((item) => (
                <NavLink key={item.to} to={item.to} className={linkCls} onClick={() => setMobileOpen(false)} end={item.to === '/orders'}>
                  <item.icon size={17} />
                  {item.label}
                  {/* TaskLine's count-pill anatomy at the item's logical end; both the desktop
                      sidebar and the mobile drawer render this same `sidebar` tree. */}
                  {item.to === '/inbox' && inboxCount != null && inboxCount > 0 && (
                    <span className="badge num bg-action-soft text-action-on-soft ms-auto">{inboxCount}</span>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>
      <div className="px-4 py-3 border-t border-shell-ink/10">
        <NavLink to="/dashboard" className="inline-block rounded text-sm text-shell-ink font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
          {profile?.full_name}
        </NavLink>
        <div className="text-xs text-shell-ink-dim mb-2">{role ? roleLabels[role] : ''}</div>
        <button className="flex items-center gap-1.5 text-xs text-shell-ink-dim hover:text-shell-ink" onClick={() => void handleSignOut()}>
          <LogOut size={13} /> התנתקות
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen">
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
      <header className="lg:hidden sticky top-0 z-40 bg-shell text-shell-ink border-b border-shell-ink/10 flex items-center justify-between px-4 py-3 no-print">
        <NavLink to="/dashboard" aria-label={`${orgName} — חזרה לדשבורד`}
          className="flex min-h-11 flex-1 items-center rounded font-bold truncate me-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          title={orgName}>{orgName}</NavLink>
        <div className="flex items-center gap-1">
          {canSearch && (
            <button className="flex items-center justify-center min-w-11 min-h-11" onClick={() => setSearchOpen(true)} aria-label="חיפוש"><Search size={21} /></button>
          )}
          <button className="flex items-center justify-center min-w-11 min-h-11" onClick={() => setMobileOpen(true)} aria-label="תפריט"><Menu size={22} /></button>
        </div>
      </header>
      {searchOpen && <GlobalSearch variant="mobile" onClose={() => setSearchOpen(false)} />}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50 bg-shell/60 no-print" onClick={() => setMobileOpen(false)}>
          <aside className="absolute inset-y-0 start-0 w-72 bg-shell border-e border-shell-ink/10" onClick={(e) => e.stopPropagation()}>
            <button className="absolute top-2 end-2 flex items-center justify-center min-w-11 min-h-11 text-shell-ink-dim" onClick={() => setMobileOpen(false)} aria-label="סגירה"><X size={20} /></button>
            {sidebar}
          </aside>
        </div>
      )}

      {/* Global search — desktop. Injected above <main>: the headerless desktop area is empty
          today (plan §2), and lg:ms-60 lines it up beside the fixed w-60 sidebar. z-30 keeps it
          below the sidebar (z-40); sticky works because the min-h-screen wrapper has no overflow. */}
      {canSearch && (
        <header className="hidden lg:flex sticky top-0 z-30 lg:ms-60 h-14 items-center border-b border-line bg-surface px-6 no-print">
          <GlobalSearch />
        </header>
      )}

      {/* Content — id/tabIndex are the skip-link target; focus lands here without a ring. */}
      <main id="main" tabIndex={-1} className="lg:ms-60 px-4 sm:px-6 py-5 pb-24 lg:pb-8 focus:outline-none">
        {/* max-w column centred (mx-auto) in the space beside the sidebar — otherwise a wide
            viewport strands all content on the start side in RTL, leaving a dead zone on the
            end side. keyed by path so each screen change re-triggers the fade (section 11). */}
        <div key={location.pathname} className="page-fade mx-auto max-w-[1400px]">
          <Outlet />
        </div>
      </main>

      {/* Mobile bottom nav */}
      {mobileItems.length > 0 && (
        <nav className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-surface border-t border-line flex no-print" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
          {mobileItems.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === '/orders'}
              className={({ isActive }) => `flex-1 flex flex-col items-center gap-0.5 py-2 text-[11px] ${isActive ? 'text-action font-medium' : 'text-ink-muted'}`}>
              <item.icon size={20} />
              {item.label}
            </NavLink>
          ))}
        </nav>
      )}

      {/* Global quick-actions FAB — self-gating (role + suppressed routes); Layout only
          wraps authed routes, so it never reaches the public pages. */}
      <Fab />
    </div>
  );
}
