import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router';
import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { useAuth, homeFor } from './auth/AuthContext';
import { RecordSkeleton, useToast } from './components/ui';
import { toHebrewError } from './lib/errors';
import { reportError } from './lib/observability';
import { isActiveRole, type ActiveRole } from './lib/types';
import { ACTIVE_ORGANIZATION_ACCESS } from './lib/organizationAccess';
import { APP_ROUTE_POLICY } from './lib/routePolicy';
import { capabilityValue, usePlanEntitlements } from './lib/planEntitlements';

// Eager: the auth shell that must paint before (or regardless of) a resolved session.
// Layout is the persistent chrome around every tenant screen; Login/AcceptInvite are the
// public routes an unauthenticated or fresh-invite visitor lands on first.
import Layout from './components/Layout';
import Login from './pages/Login';
import AcceptInvite from './pages/AcceptInvite';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import { TermsOfService, PrivacyPolicy } from './pages/Legal';
// Public and unauthenticated, like Login: a visitor who has no account yet is exactly who
// these two are for (0159).
import Signup from './pages/Signup';
import Pricing from './pages/Pricing';

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
const SupplierProposalReview = lazy(() => import('./pages/SupplierProposalReview'));
const ReceivingList = lazy(() => import('./pages/Receiving').then((m) => ({ default: m.ReceivingList })));
const ReceiveOrder = lazy(() => import('./pages/Receiving').then((m) => ({ default: m.ReceiveOrder })));
const ReceiptDetail = lazy(() => import('./pages/ReceiptDetail'));
const InvoicesList = lazy(() => import('./pages/Invoices').then((m) => ({ default: m.InvoicesList })));
const InvoiceNew = lazy(() => import('./pages/InvoiceNew'));
const InvoiceDetail = lazy(() => import('./pages/InvoiceDetail'));
const Credits = lazy(() => import('./pages/Credits'));
const PaymentRequests = lazy(() => import('./pages/PaymentRequests'));
const AccountantPaymentQueue = lazy(() => import('./pages/AccountantPaymentQueue'));
const Payments = lazy(() => import('./pages/Payments'));
const Bank = lazy(() => import('./pages/Bank'));
const Exceptions = lazy(() => import('./pages/Exceptions'));
const Reports = lazy(() => import('./pages/Reports'));
const ProductPurchaseSummary = lazy(() => import('./pages/ProductPurchaseSummary'));
const Analytics = lazy(() => import('./pages/Analytics'));
const SupplierLog = lazy(() => import('./pages/SupplierLog'));
const Expenses = lazy(() => import('./pages/Expenses'));
const DocumentsGallery = lazy(() => import('./pages/DocumentsInbox'));
const DocumentOperations = lazy(() => import('./pages/DocumentOperations'));
const ConsolidatedInvoices = lazy(() => import('./pages/ConsolidatedInvoices'));
const DocumentReview = lazy(() => import('./pages/DocumentReview'));
const Settings = lazy(() => import('./pages/Settings'));
const WebhookSettings = lazy(() => import('./pages/WebhookSettings'));
const Subscription = lazy(() => import('./pages/Subscription'));
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

function Guard({ roles, children, write = false, capability }: {
  roles: readonly ActiveRole[];
  children: ReactNode;
  write?: boolean;
  capability?: string;
}) {
  const { session, profile, loading, organizationAccess = ACTIVE_ORGANIZATION_ACCESS } = useAuth();
  const entitlements = usePlanEntitlements(!!capability);
  if (loading) return <RecordSkeleton />;
  if (!session || !profile) return <Navigate to="/login" replace />;
  if (!isActiveRole(profile.role) || !roles.includes(profile.role)) return <Navigate to={homeFor(profile.role)} replace />;
  if (write && !organizationAccess.canWrite) return <ReadOnlyUnavailable />;
  if (capability && entitlements.isLoading) return <RecordSkeleton />;
  if (capability && capabilityValue(entitlements.data, capability) !== true) {
    return <PlanCapabilityUnavailable />;
  }
  return <>{children}</>;
}

function PlanCapabilityUnavailable() {
  return (
    <div role="alert" className="card card-pad mx-auto max-w-xl text-center">
      <h1 className="page-title">היכולת אינה כלולה במסלול</h1>
      <p className="mt-2 text-sm text-ink-soft">
        המסך נשאר סגור גם בבקשה ישירה לשרת. אפשר לראות באיזה מסלול הוא נפתח במסך המנוי.
      </p>
      <a className="btn-primary mt-5" href="/settings/subscription">למסלולים ולמחירים</a>
    </div>
  );
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
          : 'הגישה לכתיבה אינה זמינה כרגע. המידע הקיים נשמר וזמין לצפייה ולייצוא; לפרטים יש לפנות למנהל המערכת.'}
      </p>
      <a className="btn-secondary mt-5" href="/dashboard">חזרה למרכז הבקרה</a>
    </div>
  );
}

/**
 * The platform operator's console is the separate operator application (operator.html,
 * src/operator/) — a second Vite entry on the same origin with its own bundle. The tenant
 * application carries none of its code and none of its routes, so handing an operator over is
 * a full document navigation, not a client-side route.
 */
function OperatorHandoff() {
  useEffect(() => {
    window.location.replace('/operator');
  }, []);
  return <RecordSkeleton />;
}

const STAFF: readonly ActiveRole[] = ['owner', 'office'];
const FINANCE: readonly ActiveRole[] = ['owner', 'office'];
const READERS: readonly ActiveRole[] = ['owner', 'office', 'accountant'];
const DOCUMENT_REVIEWERS: readonly ActiveRole[] = ['owner', 'office'];

/** /dashboard is every role's home: finance gets the full Dashboard, others a role-tailored one. */
function DashboardHome() {
  const { profile } = useAuth();
  return profile && isActiveRole(profile.role) && FINANCE.includes(profile.role) ? <Dashboard /> : <RoleDashboard />;
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
  const isPublic = ['/accept-invite', '/login', '/forgot-password', '/reset-password', '/terms', '/privacy',
    '/signup', '/pricing']
    .includes(pathname);
  const isOfflineReceivingRoute = pathname === '/receiving' || pathname.startsWith('/receiving/');

  if (!isPublic && offlineBootstrap && !isOfflineReceivingRoute) return <OfflineReceivingOnly />;

  // An operator with no tenant profile is legitimate — send them to the console, not to
  // the unavailable screen. The console is the separate operator application, so this is a
  // document handoff rather than a route.
  if (!isPublic && session && !loading && !profile && isPlatformAdmin) {
    return <OperatorHandoff />;
  }
  if (!isPublic && session && !loading && !profile && bootstrapError) return <BootstrapUnavailable />;
  if (!isPublic && session && !loading && !profile) return <AccountUnavailable />;

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/pricing" element={<Pricing />} />
      <Route path="/accept-invite" element={<AcceptInvite />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/terms" element={<TermsOfService />} />
      <Route path="/privacy" element={<PrivacyPolicy />} />
      <Route element={session || loading ? <Layout /> : <Navigate to="/login" replace />}>
        {/* One Suspense boundary for every lazy page, nested under the Layout so the shell
            (nav, requires-attention strip) stays mounted and only the content area shows a
            skeleton while a page chunk loads. */}
        <Route element={<LazyPageBoundary><Suspense fallback={<RecordSkeleton />}><Outlet /></Suspense></LazyPageBoundary>}>
        <Route path="/" element={loading ? <RecordSkeleton /> : <Navigate to={homeFor(profile?.role)} replace />} />

        <Route path={APP_ROUTE_POLICY.dashboard.path} element={<Guard roles={APP_ROUTE_POLICY.dashboard.roles}><DashboardHome /></Guard>} />

        <Route path="/suppliers" element={<Guard roles={STAFF}><SuppliersList /></Guard>} />
        <Route path={APP_ROUTE_POLICY.supplierDetail.path} element={<Guard roles={APP_ROUTE_POLICY.supplierDetail.roles}><SupplierCard /></Guard>} />
        <Route path={APP_ROUTE_POLICY.financialSupplierDetail.path} element={<Guard roles={APP_ROUTE_POLICY.financialSupplierDetail.roles}><FinancialSupplier /></Guard>} />
        <Route path={APP_ROUTE_POLICY.products.path} element={<Guard roles={APP_ROUTE_POLICY.products.roles}><Products /></Guard>} />
        <Route path={APP_ROUTE_POLICY.inventory.path} element={<Guard roles={APP_ROUTE_POLICY.inventory.roles}><Inventory /></Guard>} />
        <Route path={APP_ROUTE_POLICY.prices.path} element={<Guard roles={APP_ROUTE_POLICY.prices.roles}><PriceLists /></Guard>} />

        <Route path="/orders/new" element={<Guard roles={STAFF} write><NewOrder /></Guard>} />
        <Route path={APP_ROUTE_POLICY.orders.path} element={<Guard roles={APP_ROUTE_POLICY.orders.roles}><OrdersList /></Guard>} />
        {/* Before /orders/:id so "proposals" is not read as an order id. */}
        <Route path="/orders/proposals/:proposalId" element={<Guard roles={STAFF}><SupplierProposalReview /></Guard>} />
        <Route path={APP_ROUTE_POLICY.orderDetail.path} element={<Guard roles={APP_ROUTE_POLICY.orderDetail.roles}><OrderDetail /></Guard>} />

        <Route path="/receiving" element={<Guard roles={STAFF}><ReceivingList /></Guard>} />
        <Route path="/receiving/:orderId" element={<Guard roles={STAFF} write><ReceiveOrder /></Guard>} />
        <Route path="/receipts/:receiptId" element={<Guard roles={STAFF}><ReceiptDetail /></Guard>} />

        <Route path={APP_ROUTE_POLICY.invoices.path} element={<Guard roles={APP_ROUTE_POLICY.invoices.roles}><InvoicesList /></Guard>} />
        <Route path="/invoices/new" element={<Guard roles={STAFF} write><InvoiceNew /></Guard>} />
        <Route path={APP_ROUTE_POLICY.invoiceDetail.path} element={<Guard roles={APP_ROUTE_POLICY.invoiceDetail.roles}><InvoiceDetail /></Guard>} />
        <Route path="/documents" element={<Guard roles={STAFF}><DocumentsGallery /></Guard>} />
        <Route path="/documents/operations" element={<Guard roles={['owner']}><DocumentOperations /></Guard>} />
        <Route path="/documents/consolidated-invoices" element={<Guard roles={READERS} capability="invoices.consolidated"><ConsolidatedInvoices /></Guard>} />
        {/* The same register, narrowed to what the interpretation layer could not place. A second
            component would be a second answer to "what is a document row", so the gallery takes a
            prop instead and this route is the only thing that turns it on. */}
        <Route path="/documents/archive" element={<Guard roles={STAFF}><DocumentsGallery archive /></Guard>} />
        <Route path="/documents/:documentId/review" element={<Guard roles={DOCUMENT_REVIEWERS}><DocumentReview /></Guard>} />
        <Route path="/inbox" element={<Navigate to="/documents?filing=unfiled" replace />} />

        <Route path={APP_ROUTE_POLICY.credits.path} element={<Guard roles={APP_ROUTE_POLICY.credits.roles}><Credits /></Guard>} />
        <Route path={APP_ROUTE_POLICY.paymentRequests.path} element={<Guard roles={APP_ROUTE_POLICY.paymentRequests.roles}><PaymentRequests /></Guard>} />
        <Route path={APP_ROUTE_POLICY.payments.path} element={<Guard roles={APP_ROUTE_POLICY.payments.roles}><Payments /></Guard>} />
        <Route path="/pay" element={<Guard roles={['accountant']} write capability="payments.accountant_queue"><AccountantPaymentQueue /></Guard>} />

        <Route path={APP_ROUTE_POLICY.bank.path} element={<Guard roles={APP_ROUTE_POLICY.bank.roles} capability="bank.reconciliation"><Bank /></Guard>} />
        <Route path={APP_ROUTE_POLICY.exceptions.path} element={<Guard roles={APP_ROUTE_POLICY.exceptions.roles}><Exceptions /></Guard>} />
        <Route path={APP_ROUTE_POLICY.alerts.path} element={<Guard roles={APP_ROUTE_POLICY.alerts.roles}><Alerts /></Guard>} />
        <Route path={APP_ROUTE_POLICY.expenses.path} element={<Guard roles={APP_ROUTE_POLICY.expenses.roles}><Expenses /></Guard>} />
        <Route path="/reports" element={<Guard roles={['owner', 'accountant']} capability="reports.advanced"><Reports /></Guard>} />
        {/* The product purchase summary reads spend per product — the tenant's commercial
            position — so its readers are the money roles, matching get_product_purchase_summary's
            own role check rather than being wider than it. */}
        <Route path={APP_ROUTE_POLICY.productReport.path} element={<Guard roles={APP_ROUTE_POLICY.productReport.roles}><ProductPurchaseSummary /></Guard>} />
        <Route path={APP_ROUTE_POLICY.analytics.path} element={<Guard roles={APP_ROUTE_POLICY.analytics.roles} capability="reports.advanced"><Analytics /></Guard>} />
        {/* owner only, and not by preference: audit_logs is owner+accountant (0031:208) while the
            supplier, price-row and product names it has to resolve are owner+office (0133:128-172).
            The intersection is one role, and an accountant would read a wall of UUIDs. */}
        <Route path="/supplier-log" element={<Guard roles={['owner']}><SupplierLog /></Guard>} />
        <Route path="/settings" element={<Guard roles={['owner']}><Settings /></Guard>} />
        <Route path="/settings/webhooks" element={<Guard roles={['owner']} capability="integrations.api"><WebhookSettings /></Guard>} />
        <Route path="/settings/subscription" element={<Guard roles={['owner']}><Subscription /></Guard>} />
        <Route path="/onboarding" element={<Guard roles={['owner']} write><Onboarding /></Guard>} />

        <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
