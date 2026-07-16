import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Truck, Package, Tags, ClipboardList, ShoppingCart, PackageCheck, FileText, RotateCcw, Send, CreditCard, Landmark, AlertTriangle, BarChart3, ScrollText, Settings, LogOut, Menu, X } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { ROLE_LABEL } from '../lib/status';
import type { Role } from '../lib/types';

interface NavItem { to: string; label: string; icon: typeof LayoutDashboard; roles: Role[]; mobile?: boolean }

const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: '',
    items: [
      { to: '/dashboard', label: 'דשבורד', icon: LayoutDashboard, roles: ['owner', 'office'] },
    ],
  },
  {
    section: 'תפעול',
    items: [
      { to: '/orders/new', label: 'הזמנה חדשה', icon: ShoppingCart, roles: ['owner', 'office', 'kitchen'], mobile: true },
      { to: '/orders', label: 'הזמנות', icon: ClipboardList, roles: ['owner', 'office', 'kitchen'], mobile: true },
      { to: '/receiving', label: 'קבלת סחורה', icon: PackageCheck, roles: ['owner', 'office', 'kitchen'], mobile: true },
    ],
  },
  {
    section: 'קטלוג',
    items: [
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
      { to: '/exceptions', label: 'חריגים', icon: AlertTriangle, roles: ['owner', 'office', 'kitchen', 'accountant'] },
      { to: '/reports', label: 'דוח לרו״ח', icon: BarChart3, roles: ['owner', 'office', 'accountant'] },
      { to: '/audit', label: 'יומן ביקורת', icon: ScrollText, roles: ['owner', 'office', 'accountant'] },
      { to: '/settings', label: 'הגדרות', icon: Settings, roles: ['owner'] },
    ],
  },
];

export default function Layout() {
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const role = profile?.role;

  const sections = NAV.map((s) => ({ ...s, items: s.items.filter((i) => role && i.roles.includes(role)) }))
    .filter((s) => s.items.length > 0);
  const mobileItems = sections.flatMap((s) => s.items).filter((i) => i.mobile).slice(0, 4);

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
        <div className="text-lg font-bold text-white">SupplyFlow</div>
        <div className="text-xs text-slate-400">אולמי גאמוס — ניהול רכש ותשלומים</div>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {sections.map((s, i) => (
          <div key={i}>
            {s.section && <div className="px-3 pb-1 text-[11px] font-semibold text-slate-500 uppercase">{s.section}</div>}
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
        <div className="text-xs text-slate-400 mb-2">{role ? ROLE_LABEL[role] : ''}</div>
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
        <div className="font-bold">SupplyFlow <span className="text-slate-400 font-normal text-sm">| גאמוס</span></div>
        <button onClick={() => setMobileOpen(true)} aria-label="תפריט"><Menu size={22} /></button>
      </header>
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50 bg-slate-900/60 no-print" onClick={() => setMobileOpen(false)}>
          <aside className="absolute inset-y-0 start-0 w-72 bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <button className="absolute top-4 end-4 text-slate-400" onClick={() => setMobileOpen(false)} aria-label="סגירה"><X size={20} /></button>
            {sidebar}
          </aside>
        </div>
      )}

      {/* Content */}
      <main className="lg:ms-60 px-4 sm:px-6 py-5 pb-24 lg:pb-8 max-w-[1400px]">
        <Outlet />
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
