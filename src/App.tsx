import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { Component, lazy, Suspense, useState, type ReactNode } from 'react';
import { useAuth, homeFor } from './auth/AuthContext';
import { PageLoader, useToast } from './components/ui';
import { toHebrewError } from './lib/errors';
import type { Role } from './lib/types';

// Eager: the auth shell that must paint before (or regardless of) a resolved session.
// Layout is the persistent chrome around every tenant screen; Login/AcceptInvite are the
// public routes an unauthenticated or fresh-invite visitor lands on first.
import Layout from './components/Layout';
import Login from './pages/Login';
import AcceptInvite from './pages/AcceptInvite';

// Lazy: every screen behind the Layout loads its own chunk on demand, so a supplier hitting
// /my-prices or a payment executor hitting /pay never downloads Dashboard/Reports (and recharts) up front.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Alerts = lazy(() => import('./pages/Alerts'));
const SuppliersList = lazy(() => import('./pages/Suppliers').then((m) => ({ default: m.SuppliersList })));
const SupplierCard = lazy(() => import('./pages/Suppliers').then((m) => ({ default: m.SupplierCard })));
const Products = lazy(() => import('./pages/Products'));
const PriceLists = lazy(() => import('./pages/PriceLists'));
const NewOrder = lazy(() => import('./pages/NewOrder'));
const OrdersList = lazy(() => import('./pages/Orders').then((m) => ({ default: m.OrdersList })));
const OrderDetail = lazy(() => import('./pages/Orders').then((m) => ({ default: m.OrderDetail })));
const ReceivingList = lazy(() => import('./pages/Receiving').then((m) => ({ default: m.ReceivingList })));
const ReceiveOrder = lazy(() => import('./pages/Receiving').then((m) => ({ default: m.ReceiveOrder })));
const InvoicesList = lazy(() => import('./pages/Invoices').then((m) => ({ default: m.InvoicesList })));
const InvoiceNew = lazy(() => import('./pages/InvoiceNew'));
const InvoiceDetail = lazy(() => import('./pages/InvoiceDetail'));
const Credits = lazy(() => import('./pages/Credits'));
const PaymentRequests = lazy(() => import('./pages/PaymentRequests'));
const PayerQueue = lazy(() => import('./pages/PayerQueue'));
const Payments = lazy(() => import('./pages/Payments'));
const Bank = lazy(() => import('./pages/Bank'));
const Exceptions = lazy(() => import('./pages/Exceptions'));
const Reports = lazy(() => import('./pages/Reports'));
const Expenses = lazy(() => import('./pages/Expenses'));
const DocumentsGallery = lazy(() => import('./pages/DocumentsInbox'));
const AuditLogPage = lazy(() => import('./pages/AuditLog'));
const Settings = lazy(() => import('./pages/Settings'));
const SupplierPrices = lazy(() => import('./pages/SupplierPrices'));
const Admin = lazy(() => import('./pages/Admin'));
const Onboarding = lazy(() => import('./pages/Onboarding'));

class LazyRouteErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="card card-pad mx-auto my-8 max-w-lg text-center">
        <h1 className="page-title">לא ניתן לטעון את המסך</h1>
        <p className="mt-2 text-sm text-ink-soft">ייתכן שהאפליקציה עודכנה בזמן שהכרטיסייה הייתה פתוחה.</p>
        <button type="button" className="btn-primary mt-5" onClick={() => window.location.reload()}>רענון וטעינה מחדש</button>
      </div>
    );
  }
}

function LazyPageBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <LazyRouteErrorBoundary key={pathname}>{children}</LazyRouteErrorBoundary>;
}

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
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function handleSignOut() {
    setBusy(true);
    const result = await signOut();
    setBusy(false);
    if (result.error) {
      toast(toHebrewError(result.error), 'error');
      return;
    }
    if (result.pushWarning) toast(result.pushWarning, 'error');
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="card card-pad max-w-md text-center">
        <h1 className="page-title">החשבון אינו זמין</h1>
        <p className="text-ink-soft mt-2">
          לא ניתן לטעון את פרטי החשבון. ייתכן שהגישה הושעתה או שהמשתמש הושבת.
          לפרטים יש לפנות למנהל המערכת.
        </p>
        <button className="btn-secondary mt-5" disabled={busy} onClick={() => void handleSignOut()}>
          {busy ? 'מתנתק…' : 'התנתקות'}
        </button>
      </div>
    </div>
  );
}

function BootstrapUnavailable() {
  const { bootstrapError, retryBootstrap, signOut } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function handleSignOut() {
    setBusy(true);
    const result = await signOut();
    setBusy(false);
    if (result.error) {
      toast(toHebrewError(result.error), 'error');
      return;
    }
    if (result.pushWarning) toast(result.pushWarning, 'error');
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="card card-pad max-w-md text-center">
        <h1 className="page-title">לא ניתן לטעון את החשבון</h1>
        <p className="text-ink-soft mt-2">
          {bootstrapError ?? 'אירעה תקלה זמנית בטעינת פרטי החשבון.'} החיבור נשאר פעיל ואפשר לנסות שוב.
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <button className="btn-primary" disabled={busy} onClick={retryBootstrap}>ניסיון חוזר</button>
          <button className="btn-secondary" disabled={busy} onClick={() => void handleSignOut()}>
            {busy ? 'מתנתק…' : 'התנתקות'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const { session, profile, loading, bootstrapError, isPlatformAdmin } = useAuth();
  const { pathname } = useLocation();

  // The public routes must render regardless of a broken session. Someone accepting an
  // invitation is joining fresh — the accept flow creates a NEW user — and may arrive with a
  // leftover session, a deleted account, or a suspended org. Short-circuiting them to
  // AccountUnavailable would trap an invitee on a screen that has nothing to do with them.
  const isPublic = pathname === '/accept-invite' || pathname === '/login';

  // An operator with no tenant profile is legitimate — send them to the console, not to
  // the unavailable screen.
  if (!isPublic && session && !loading && !profile && isPlatformAdmin) {
    return (
      <LazyPageBoundary>
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/admin" element={<PlatformGuard><Admin /></PlatformGuard>} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Routes>
        </Suspense>
      </LazyPageBoundary>
    );
  }
  if (!isPublic && session && !loading && !profile && bootstrapError) return <BootstrapUnavailable />;
  if (!isPublic && session && !loading && !profile) return <AccountUnavailable />;

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/accept-invite" element={<AcceptInvite />} />
      <Route element={session || loading ? <Layout /> : <Navigate to="/login" replace />}>
        {/* One Suspense boundary for every lazy page, nested under the Layout so the shell
            (nav, requires-attention strip) stays mounted and only the content area shows
            PageLoader while a page chunk loads. */}
        <Route element={<LazyPageBoundary><Suspense fallback={<PageLoader />}><Outlet /></Suspense></LazyPageBoundary>}>
        <Route path="/" element={loading ? <PageLoader /> : <Navigate to={homeFor(profile?.role)} replace />} />

        <Route path="/dashboard" element={<Guard roles={FINANCE}><Dashboard /></Guard>} />

        <Route path="/suppliers" element={<Guard roles={STAFF}><SuppliersList /></Guard>} />
        <Route path="/suppliers/:id" element={<Guard roles={STAFF}><SupplierCard /></Guard>} />
        <Route path="/products" element={<Guard roles={STAFF}><Products /></Guard>} />
        <Route path="/prices" element={<Guard roles={STAFF}><PriceLists /></Guard>} />

        <Route path="/orders/new" element={<Guard roles={STAFF}><NewOrder /></Guard>} />
        <Route path="/orders" element={<Guard roles={STAFF}><OrdersList /></Guard>} />
        <Route path="/orders/:id" element={<Guard roles={STAFF}><OrderDetail /></Guard>} />

        <Route path="/receiving" element={<Guard roles={STAFF}><ReceivingList /></Guard>} />
        <Route path="/receiving/:orderId" element={<Guard roles={STAFF}><ReceiveOrder /></Guard>} />

        <Route path="/invoices" element={<Guard roles={READERS}><InvoicesList /></Guard>} />
        <Route path="/invoices/new" element={<Guard roles={STAFF}><InvoiceNew /></Guard>} />
        <Route path="/invoices/:id" element={<Guard roles={READERS}><InvoiceDetail /></Guard>} />
        <Route path="/documents" element={<Guard roles={STAFF}><DocumentsGallery /></Guard>} />
        <Route path="/inbox" element={<Navigate to="/documents?filing=unfiled" replace />} />

        <Route path="/credits" element={<Guard roles={READERS}><Credits /></Guard>} />
        <Route path="/payment-requests" element={<Guard roles={FINANCE}><PaymentRequests /></Guard>} />
        <Route path="/payments" element={<Guard roles={['owner', 'accountant']}><Payments /></Guard>} />
        <Route path="/pay/emergency" element={<Guard roles={['owner']}><PayerQueue mode="emergency" /></Guard>} />
        <Route path="/pay" element={<Guard roles={['payer', 'accountant']}><PayerQueue /></Guard>} />

        <Route path="/bank" element={<Guard roles={['owner', 'accountant']}><Bank /></Guard>} />
        <Route path="/exceptions" element={<Guard roles={READERS}><Exceptions /></Guard>} />
        <Route path="/alerts" element={<Guard roles={FINANCE}><Alerts /></Guard>} />
        <Route path="/expenses" element={<Guard roles={['owner', 'accountant']}><Expenses /></Guard>} />
        <Route path="/reports" element={<Guard roles={['owner', 'accountant']}><Reports /></Guard>} />
        <Route path="/audit" element={<Guard roles={['owner', 'accountant']}><AuditLogPage /></Guard>} />
        <Route path="/settings" element={<Guard roles={['owner']}><Settings /></Guard>} />
        <Route path="/my-prices" element={<Guard roles={['supplier']}><SupplierPrices /></Guard>} />

        <Route path="/onboarding" element={<Guard roles={['owner']}><Onboarding /></Guard>} />
        <Route path="/admin" element={<PlatformGuard><Admin /></PlatformGuard>} />

        <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
