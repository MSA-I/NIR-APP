import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router';
import { Component, lazy, Suspense, useState, type ReactNode } from 'react';
import { useAuth, homeFor } from './auth/AuthContext';
import { PageLoader, useToast } from './components/ui';
import { toHebrewError } from './lib/errors';
import { reportError } from './lib/observability';
import { ACTIVE_ACCOUNT_ROLES, type Role } from './lib/types';
import { ACTIVE_ORGANIZATION_ACCESS } from './lib/trial';

// Eager: the auth shell that must paint before (or regardless of) a resolved session.
// Layout is the persistent chrome around every tenant screen; Login/AcceptInvite are the
// public routes an unauthenticated or fresh-invite visitor lands on first.
import Layout from './components/Layout';
import Login from './pages/Login';
import AcceptInvite from './pages/AcceptInvite';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import { TermsOfService, PrivacyPolicy } from './pages/Legal';

// Lazy: every screen behind the Layout loads its own chunk on demand.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const RoleDashboard = lazy(() => import('./pages/RoleDashboard'));
const Alerts = lazy(() => import('./pages/Alerts'));
const SuppliersList = lazy(() => import('./pages/Suppliers').then((m) => ({ default: m.SuppliersList })));
const SupplierCard = lazy(() => import('./pages/Suppliers').then((m) => ({ default: m.SupplierCard })));
const FinancialSupplier = lazy(() => import('./pages/FinancialSupplier'));
const Products = lazy(() => import('./pages/Products'));
const Inventory = lazy(() => import('./pages/Inventory'));
const PriceLists = lazy(() => import('./pages/PriceLists'));
const NewOrder = lazy(() => import('./pages/neworder/NewOrder'));
const OrdersList = lazy(() => import('./pages/Orders').then((m) => ({ default: m.OrdersList })));
const OrderDetail = lazy(() => import('./pages/Orders').then((m) => ({ default: m.OrderDetail })));
const ReceivingList = lazy(() => import('./pages/Receiving').then((m) => ({ default: m.ReceivingList })));
const ReceiveOrder = lazy(() => import('./pages/Receiving').then((m) => ({ default: m.ReceiveOrder })));
const ReceiptDetail = lazy(() => import('./pages/ReceiptDetail'));
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
const ProductPurchaseSummary = lazy(() => import('./pages/ProductPurchaseSummary'));
const Analytics = lazy(() => import('./pages/Analytics'));
const Expenses = lazy(() => import('./pages/Expenses'));
const DocumentsGallery = lazy(() => import('./pages/DocumentsInbox'));
const DocumentOperations = lazy(() => import('./pages/DocumentOperations'));
const DocumentReview = lazy(() => import('./pages/DocumentReview'));
const Settings = lazy(() => import('./pages/Settings'));
const Admin = lazy(() => import('./pages/Admin'));
const Onboarding = lazy(() => import('./pages/Onboarding'));

class LazyRouteErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  // The screen already tells the user what to do; this is the half that tells us it happened.
  componentDidCatch(error: unknown, info: { componentStack?: string | null }) {
    reportError(error, { componentStack: info.componentStack ?? null });
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

function Guard({ roles, children, write = false }: { roles: readonly Role[]; children: ReactNode; write?: boolean }) {
  const { session, profile, loading, organizationAccess = ACTIVE_ORGANIZATION_ACCESS } = useAuth();
  if (loading) return <PageLoader />;
  if (!session || !profile) return <Navigate to="/login" replace />;
  if (!roles.includes(profile.role)) return <Navigate to={homeFor(profile.role)} replace />;
  if (write && !organizationAccess.canWrite) return <ReadOnlyUnavailable />;
  return <>{children}</>;
}

function ReadOnlyUnavailable() {
  const { organizationAccess = ACTIVE_ORGANIZATION_ACCESS } = useAuth();
  const offboarding = organizationAccess.mode === 'offboarding';
  return (
    <div role="alert" className="card card-pad mx-auto max-w-xl text-center">
      <h1 className="page-title">המערכת במצב קריאה בלבד</h1>
      <p className="mt-2 text-sm text-ink-soft">
        {offboarding
          ? 'הארגון נמצא בתהליך סיום שירות ולכן המערכת במצב קריאה בלבד. המידע הקיים נשמר וזמין לצפייה ולייצוא עד להשלמת התהליך.'
          : 'תקופת הניסיון הסתיימה. המערכת נמצאת כעת במצב קריאה בלבד. כל המידע הקיים נשמר וזמין לצפייה ולייצוא. להפעלת המערכת מחדש יש לפנות למנהל השירות.'}
      </p>
      <a className="btn-secondary mt-5" href="/dashboard">חזרה למרכז הבקרה</a>
    </div>
  );
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

const STAFF: Role[] = ['owner', 'office'];
const FINANCE: Role[] = ['owner', 'office'];
const READERS: Role[] = ['owner', 'office', 'accountant'];
const DOCUMENT_REVIEWERS: Role[] = ['owner', 'office'];

/** /dashboard is every role's home: finance gets the full Dashboard, others a role-tailored one. */
function DashboardHome() {
  const { profile } = useAuth();
  return profile && FINANCE.includes(profile.role) ? <Dashboard /> : <RoleDashboard />;
}

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
    <div className="min-h-dvh flex items-center justify-center p-6">
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

/*
 * The whole-app `TrialExpired` stop screen (09.08.2026) was removed here on 10.08.2026, when
 * `0092` made the read-only floor server-authoritative. The two disagreed about what an expired
 * tenant may do: the screen stopped the app outright, while `0092` — already deployed — keeps
 * SELECT open and fails only writes, at the row. Blocking reads in the UI would have been
 * stricter than the contract the database actually enforces. Write gating now lives per route in
 * `RequireAuth` (`write && !organizationAccess.canWrite` -> `ReadOnlyUnavailable`).
 * See OPEN-DECISIONS #15.
 */
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
    <div className="min-h-dvh flex items-center justify-center p-6">
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

function OfflineReceivingOnly() {
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="card card-pad max-w-md text-center">
        <h1 className="page-title">העבודה הלא־מקוונת מוגבלת לקבלת סחורה</h1>
        <p className="mt-2 text-ink-soft">
          זהות המשתמש והארגון נטענו מהאימות האחרון במכשיר. עד חזרת הרשת אפשר לפתוח רק משימות קבלה שכבר נשמרו כאן; הרשאות ושינויים בשרת יאומתו מחדש לפני סנכרון.
        </p>
        <a className="btn-primary mt-5" href="/receiving">מעבר לקבלת סחורה</a>
      </div>
    </div>
  );
}

export default function App() {
  const { session, profile, loading, bootstrapError, offlineBootstrap, isPlatformAdmin } = useAuth();
  const { pathname } = useLocation();

  // The public routes must render regardless of a broken session. Someone accepting an
  // invitation is joining fresh — the accept flow creates a NEW user — and may arrive with a
  // leftover session, a deleted account, or a suspended org. Short-circuiting them to
  // AccountUnavailable would trap an invitee on a screen that has nothing to do with them.
  // Recovery links arrive with an Auth session before the tenant profile resolves. Legal pages
  // must remain public as well.
  const isPublic = ['/accept-invite', '/login', '/forgot-password', '/reset-password', '/terms', '/privacy']
    .includes(pathname);
  const isOfflineReceivingRoute = pathname === '/receiving' || pathname.startsWith('/receiving/');

  if (!isPublic && offlineBootstrap && !isOfflineReceivingRoute) return <OfflineReceivingOnly />;

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
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/terms" element={<TermsOfService />} />
      <Route path="/privacy" element={<PrivacyPolicy />} />
      <Route element={session || loading ? <Layout /> : <Navigate to="/login" replace />}>
        {/* One Suspense boundary for every lazy page, nested under the Layout so the shell
            (nav, requires-attention strip) stays mounted and only the content area shows
            PageLoader while a page chunk loads. */}
        <Route element={<LazyPageBoundary><Suspense fallback={<PageLoader />}><Outlet /></Suspense></LazyPageBoundary>}>
        <Route path="/" element={loading ? <PageLoader /> : <Navigate to={homeFor(profile?.role)} replace />} />

        <Route path="/dashboard" element={<Guard roles={ACTIVE_ACCOUNT_ROLES}><DashboardHome /></Guard>} />

        <Route path="/suppliers" element={<Guard roles={STAFF}><SuppliersList /></Guard>} />
        <Route path="/suppliers/:id" element={<Guard roles={STAFF}><SupplierCard /></Guard>} />
        <Route path="/finance/suppliers/:id" element={<Guard roles={['owner', 'accountant']}><FinancialSupplier /></Guard>} />
        <Route path="/products" element={<Guard roles={STAFF}><Products /></Guard>} />
        <Route path="/inventory" element={<Guard roles={STAFF}><Inventory /></Guard>} />
        <Route path="/prices" element={<Guard roles={STAFF}><PriceLists /></Guard>} />

        <Route path="/orders/new" element={<Guard roles={STAFF} write><NewOrder /></Guard>} />
        <Route path="/orders" element={<Guard roles={STAFF}><OrdersList /></Guard>} />
        <Route path="/orders/:id" element={<Guard roles={STAFF}><OrderDetail /></Guard>} />

        <Route path="/receiving" element={<Guard roles={STAFF}><ReceivingList /></Guard>} />
        <Route path="/receiving/:orderId" element={<Guard roles={STAFF} write><ReceiveOrder /></Guard>} />
        <Route path="/receipts/:receiptId" element={<Guard roles={STAFF}><ReceiptDetail /></Guard>} />

        <Route path="/invoices" element={<Guard roles={READERS}><InvoicesList /></Guard>} />
        <Route path="/invoices/new" element={<Guard roles={STAFF} write><InvoiceNew /></Guard>} />
        <Route path="/invoices/:id" element={<Guard roles={READERS}><InvoiceDetail /></Guard>} />
        <Route path="/documents" element={<Guard roles={STAFF}><DocumentsGallery /></Guard>} />
        <Route path="/documents/operations" element={<Guard roles={['owner']}><DocumentOperations /></Guard>} />
        {/* The same register, narrowed to what the interpretation layer could not place. A second
            component would be a second answer to "what is a document row", so the gallery takes a
            prop instead and this route is the only thing that turns it on. */}
        <Route path="/documents/archive" element={<Guard roles={STAFF}><DocumentsGallery archive /></Guard>} />
        <Route path="/documents/:documentId/review" element={<Guard roles={DOCUMENT_REVIEWERS}><DocumentReview /></Guard>} />
        <Route path="/inbox" element={<Navigate to="/documents?filing=unfiled" replace />} />

        <Route path="/credits" element={<Guard roles={READERS}><Credits /></Guard>} />
        <Route path="/payment-requests" element={<Guard roles={FINANCE}><PaymentRequests /></Guard>} />
        <Route path="/payments" element={<Guard roles={['owner', 'accountant']}><Payments /></Guard>} />
        <Route path="/pay" element={<Guard roles={['accountant']} write><PayerQueue /></Guard>} />

        <Route path="/bank" element={<Guard roles={['owner', 'accountant']}><Bank /></Guard>} />
        <Route path="/exceptions" element={<Guard roles={READERS}><Exceptions /></Guard>} />
        <Route path="/alerts" element={<Guard roles={FINANCE}><Alerts /></Guard>} />
        <Route path="/expenses" element={<Guard roles={['owner', 'accountant']}><Expenses /></Guard>} />
        <Route path="/reports" element={<Guard roles={['owner', 'accountant']}><Reports /></Guard>} />
        {/* The product purchase summary reads spend per product — the tenant's commercial
            position — so its readers are the money roles, matching get_product_purchase_summary's
            own role check rather than being wider than it. */}
        <Route path="/reports/products" element={<Guard roles={['owner', 'office', 'accountant']}><ProductPurchaseSummary /></Guard>} />
        <Route path="/analytics" element={<Guard roles={['owner', 'office']}><Analytics /></Guard>} />
        <Route path="/settings" element={<Guard roles={['owner']}><Settings /></Guard>} />
        <Route path="/onboarding" element={<Guard roles={['owner']} write><Onboarding /></Guard>} />
        <Route path="/admin" element={<PlatformGuard><Admin /></PlatformGuard>} />

        <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
