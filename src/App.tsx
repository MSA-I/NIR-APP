import { Navigate, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth, homeFor } from './auth/AuthContext';
import { PageLoader } from './components/ui';
import type { Role } from './lib/types';

import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import { SuppliersList, SupplierCard } from './pages/Suppliers';
import Products from './pages/Products';
import PriceLists from './pages/PriceLists';
import NewOrder from './pages/NewOrder';
import { OrdersList, OrderDetail } from './pages/Orders';
import { ReceivingList, ReceiveOrder } from './pages/Receiving';
import { InvoicesList } from './pages/Invoices';
import InvoiceNew from './pages/InvoiceNew';
import InvoiceDetail from './pages/InvoiceDetail';
import Credits from './pages/Credits';
import PaymentRequests from './pages/PaymentRequests';
import PayerQueue from './pages/PayerQueue';
import Payments from './pages/Payments';
import Bank from './pages/Bank';
import Exceptions from './pages/Exceptions';
import Reports from './pages/Reports';
import AuditLogPage from './pages/AuditLog';
import Settings from './pages/Settings';
import SupplierPrices from './pages/SupplierPrices';
import Admin from './pages/Admin';
import AcceptInvite from './pages/AcceptInvite';
import Onboarding from './pages/Onboarding';

function Guard({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { session, profile, loading } = useAuth();
  if (loading) return <PageLoader />;
  if (!session || !profile) return <Navigate to="/login" replace />;
  if (!roles.includes(profile.role)) return <Navigate to={homeFor(profile.role)} replace />;
  return <>{children}</>;
}

/**
 * Platform operators are a different axis from tenant roles, so they get their own guard
 * rather than a synthetic entry in the Role union — that union mirrors the user_role enum
 * the RLS policies are built on, and inventing a value there would be a lie about the DB.
 * A platform admin need not have a tenant profile at all, so this must not require one.
 */
function PlatformGuard({ children }: { children: ReactNode }) {
  const { session, loading, isPlatformAdmin } = useAuth();
  if (loading) return <PageLoader />;
  if (!session) return <Navigate to="/login" replace />;
  if (!isPlatformAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

const STAFF: Role[] = ['owner', 'office', 'kitchen'];
const FINANCE: Role[] = ['owner', 'office'];
const READERS: Role[] = ['owner', 'office', 'kitchen', 'accountant'];

/**
 * A live session whose profile will not load. Before 0006 this was unreachable in practice;
 * suspension makes it a real state, because auth_org() returns null for a suspended org and
 * the tenant can no longer read even their own profile row. Bouncing to /login would be a
 * lie — the credentials are fine — and would loop, since sign-in succeeds every time.
 * The message stays deliberately vague: the client cannot distinguish suspension from a
 * deactivated user or a missing profile, so it must not guess which one it is.
 */
function AccountUnavailable() {
  const { signOut } = useAuth();
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="card card-pad max-w-md text-center">
        <h1 className="page-title">החשבון אינו זמין</h1>
        <p className="text-slate-600 mt-2">
          לא ניתן לטעון את פרטי החשבון. ייתכן שהגישה הושעתה או שהמשתמש הושבת.
          לפרטים יש לפנות למנהל המערכת.
        </p>
        <button className="btn-secondary mt-5" onClick={() => void signOut()}>התנתקות</button>
      </div>
    </div>
  );
}

export default function App() {
  const { session, profile, loading, isPlatformAdmin } = useAuth();

  // An operator with no tenant profile is legitimate — send them to the console, not to
  // the unavailable screen.
  if (session && !loading && !profile && isPlatformAdmin) {
    return (
      <Routes>
        <Route path="/admin" element={<PlatformGuard><Admin /></PlatformGuard>} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    );
  }
  if (session && !loading && !profile) return <AccountUnavailable />;

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/accept-invite" element={<AcceptInvite />} />
      <Route element={session || loading ? <Layout /> : <Navigate to="/login" replace />}>
        <Route path="/" element={loading ? <PageLoader /> : <Navigate to={homeFor(profile?.role)} replace />} />

        <Route path="/dashboard" element={<Guard roles={FINANCE}><Dashboard /></Guard>} />

        <Route path="/suppliers" element={<Guard roles={READERS}><SuppliersList /></Guard>} />
        <Route path="/suppliers/:id" element={<Guard roles={READERS}><SupplierCard /></Guard>} />
        <Route path="/products" element={<Guard roles={STAFF}><Products /></Guard>} />
        <Route path="/prices" element={<Guard roles={STAFF}><PriceLists /></Guard>} />

        <Route path="/orders/new" element={<Guard roles={STAFF}><NewOrder /></Guard>} />
        <Route path="/orders" element={<Guard roles={READERS}><OrdersList /></Guard>} />
        <Route path="/orders/:id" element={<Guard roles={READERS}><OrderDetail /></Guard>} />

        <Route path="/receiving" element={<Guard roles={STAFF}><ReceivingList /></Guard>} />
        <Route path="/receiving/:orderId" element={<Guard roles={STAFF}><ReceiveOrder /></Guard>} />

        <Route path="/invoices" element={<Guard roles={READERS}><InvoicesList /></Guard>} />
        <Route path="/invoices/new" element={<Guard roles={STAFF}><InvoiceNew /></Guard>} />
        <Route path="/invoices/:id" element={<Guard roles={READERS}><InvoiceDetail /></Guard>} />

        <Route path="/credits" element={<Guard roles={READERS}><Credits /></Guard>} />
        <Route path="/payment-requests" element={<Guard roles={FINANCE}><PaymentRequests /></Guard>} />
        <Route path="/payments" element={<Guard roles={['owner', 'office', 'accountant']}><Payments /></Guard>} />
        <Route path="/pay" element={<Guard roles={['payer']}><PayerQueue /></Guard>} />

        <Route path="/bank" element={<Guard roles={['owner', 'office', 'accountant']}><Bank /></Guard>} />
        <Route path="/exceptions" element={<Guard roles={READERS}><Exceptions /></Guard>} />
        <Route path="/reports" element={<Guard roles={['owner', 'office', 'accountant']}><Reports /></Guard>} />
        <Route path="/audit" element={<Guard roles={['owner', 'office', 'accountant']}><AuditLogPage /></Guard>} />
        <Route path="/settings" element={<Guard roles={['owner']}><Settings /></Guard>} />
        <Route path="/my-prices" element={<Guard roles={['supplier']}><SupplierPrices /></Guard>} />

        <Route path="/onboarding" element={<Guard roles={['owner']}><Onboarding /></Guard>} />
        <Route path="/admin" element={<PlatformGuard><Admin /></PlatformGuard>} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
