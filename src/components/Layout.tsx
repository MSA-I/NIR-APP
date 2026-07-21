import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { LayoutDashboard, Truck, Package, Tags, ClipboardList, ShoppingCart, PackageCheck, FileText, RotateCcw, Send, CreditCard, Landmark, AlertTriangle, BarChart3, ScrollText, Settings, LogOut, Menu, X, Building2, Bell, Search } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { APP_NAME } from '../lib/branding';
import GlobalSearch, { canGlobalSearch } from './GlobalSearch';
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
// order) stays exactly {הזמנה חדשה, הזמנות, קבלת סחורה, חשבוניות} for staff roles.
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
      { to: '/credits', label: 'זיכויים', icon: RotateCcw, roles: ['owner', 'office', 'kitchen', 'accountant'] },
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

  // Deliberately from roleSections: the operator console is a desktop task, and the mobile
  // bar is already capped at 4 — slice(0,4) would silently drop a tenant item to fit it.
  const mobileItems = roleSections.flatMap((s) => s.items).filter((i) => i.mobile).slice(0, 4);

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
      isActive ? 'bg-indigo-600/20 text-white font-medium' : 'text-slate-300 hover:bg-white/5 hover:text-white'
    }`;

  const sidebar = (
    <div className="flex flex-col h-full">
      <div className="px-4 py-5 border-b border-white/10">
        <div className="text-lg font-bold text-white truncate" title={orgName}>{orgName}</div>
        <div className="text-xs text-slate-400">ניהול רכש ותשלומים</div>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {sections.map((s, i) => (
          <div key={i}>
            {showHeaders && s.section && <div className="px-3 pb-1 text-[11px] font-semibold text-slate-500 uppercase">{s.section}</div>}
            <div className="space-y-0.5">
              {s.items.map((item) => (
                <NavLink key={item.to} to={item.to} className={linkCls} onClick={() => setMobileOpen(false)} end={item.to === '/orders'}>
                  <item.icon size={17} />
                  {item.label}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>
      <div className="px-4 py-3 border-t border-white/10">
        <div className="text-sm text-white font-medium">{profile?.full_name}</div>
        <div className="text-xs text-slate-400 mb-2">{role ? roleLabels[role] : ''}</div>
        <button className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white" onClick={() => void handleSignOut()}>
          <LogOut size={13} /> התנתקות
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen">
      {/* Desktop sidebar */}
      <aside className="hidden lg:block fixed inset-y-0 start-0 w-60 bg-slate-900 z-40 no-print">{sidebar}</aside>

      {/* Mobile top bar */}
      <header className="lg:hidden sticky top-0 z-40 bg-slate-900 text-white flex items-center justify-between px-4 py-3 no-print">
        <div className="font-bold truncate me-3" title={orgName}>{orgName}</div>
        <div className="flex items-center gap-1">
          {canSearch && (
            <button className="flex items-center justify-center min-w-11 min-h-11" onClick={() => setSearchOpen(true)} aria-label="חיפוש"><Search size={21} /></button>
          )}
          <button className="flex items-center justify-center min-w-11 min-h-11" onClick={() => setMobileOpen(true)} aria-label="תפריט"><Menu size={22} /></button>
        </div>
      </header>
      {searchOpen && <GlobalSearch variant="mobile" onClose={() => setSearchOpen(false)} />}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50 bg-slate-900/60 no-print" onClick={() => setMobileOpen(false)}>
          <aside className="absolute inset-y-0 start-0 w-72 bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <button className="absolute top-2 end-2 flex items-center justify-center min-w-11 min-h-11 text-slate-400" onClick={() => setMobileOpen(false)} aria-label="סגירה"><X size={20} /></button>
            {sidebar}
          </aside>
        </div>
      )}

      {/* Global search — desktop. Injected above <main>: the headerless desktop area is empty
          today (plan §2), and lg:ms-60 lines it up beside the fixed w-60 sidebar. z-30 keeps it
          below the sidebar (z-40); sticky works because the min-h-screen wrapper has no overflow. */}
      {canSearch && (
        <header className="hidden lg:flex sticky top-0 z-30 lg:ms-60 h-14 items-center border-b border-slate-200 bg-white px-6 no-print">
          <GlobalSearch />
        </header>
      )}

      {/* Content */}
      <main className="lg:ms-60 px-4 sm:px-6 py-5 pb-24 lg:pb-8">
        {/* max-w column centred (mx-auto) in the space beside the sidebar — otherwise a wide
            viewport strands all content on the start side in RTL, leaving a dead zone on the
            end side. keyed by path so each screen change re-triggers the fade (section 11). */}
        <div key={location.pathname} className="page-fade mx-auto max-w-[1400px]">
          <Outlet />
        </div>
      </main>

      {/* Mobile bottom nav */}
      {mobileItems.length > 0 && (
        <nav className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-white border-t border-slate-200 flex no-print" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
          {mobileItems.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === '/orders'}
              className={({ isActive }) => `flex-1 flex flex-col items-center gap-0.5 py-2 text-[11px] ${isActive ? 'text-indigo-700 font-medium' : 'text-slate-500'}`}>
              <item.icon size={20} />
              {item.label}
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  );
}
