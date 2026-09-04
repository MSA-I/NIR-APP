import { Navigate, Route, Routes } from 'react-router';
import { useEffect, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useT } from '../lib/i18n/LocaleProvider';
import { RecordSkeleton } from '../components/ui';
import Admin from '../pages/Admin';
import OperatorShell from './OperatorShell';
import Overview from './Overview';
import Users from './Users';
import UserDetail from './UserDetail';
import Team from './Team';
import AutonomyPolicies from './AutonomyPolicies';
import Customers from './Customers';
import CustomerDetail from './CustomerDetail';
import Funnel from './Funnel';
import SignupQuarantine from './SignupQuarantine';
import PurgeCandidates from './PurgeCandidates';

/**
 * SECURITY NOTE — read before treating "separate app" as "isolated".
 *
 * The operator console is a separate BUILD (operator.html, its own entry chunk, zero operator
 * code in the tenant bundle), but it shares the tenant application's origin — and therefore its
 * Supabase session in localStorage. For a platform admin that is the point: one sign-in. It
 * also means this separation is an architectural boundary, NOT a security one. The security
 * boundary stays on the server: platform_set_autonomy_policy / platform_get_autonomy_policies
 * raise `not_platform_admin` (0076:270-272, 0147), platform_orgs and
 * platform_offboarding_requests filter on is_platform_admin(), and the RLS on platform_admins
 * answers false for everyone else. PlatformGuard below is UX — it decides what renders, never
 * what is permitted.
 */

/** Leaves the operator document entirely. The tenant routes do not exist in this entry, so a
    refused visitor gets a full navigation back to the application that does own their URL. */
function DocumentRedirect({ to }: { to: string }) {
  useEffect(() => {
    window.location.replace(to);
  }, [to]);
  return <RecordSkeleton />;
}

/**
 * Platform operators are a different axis from tenant roles, so they get their own guard
 * rather than a synthetic entry in the Role union — that union mirrors the user_role enum
 * the RLS policies are built on, and inventing a value there would be a lie about the DB.
 * A platform admin need not have a tenant profile at all, so this must not require one.
 */
function PlatformGuard({ children }: { children: ReactNode }) {
  const { session, loading, isPlatformAdmin } = useAuth();
  if (loading) return <RecordSkeleton />;
  if (!session) return <DocumentRedirect to="/login" />;
  // PERM-04's fourth silent case. A signed-in visitor who is not a platform operator used to be
  // thrown out of the document with no message, which reads as "the console is broken" rather
  // than "this is not yours". Say which, and leave the way out as a link they choose to take.
  if (!isPlatformAdmin) return <OperatorConsoleNotPermitted />;
  return <>{children}</>;
}

function OperatorConsoleNotPermitted() {
  const { t } = useT();
  return (
    <div role="alert" className="card card-pad mx-auto mt-10 max-w-xl text-center">
      <h1 className="page-title">{t('nav.notPermittedTitle')}</h1>
      <p className="mt-2 text-sm text-ink-soft">{t('nav.operatorConsoleNotPermittedBody')}</p>
      <a className="btn-secondary mt-5" href="/">{t('nav.notPermittedAction')}</a>
    </div>
  );
}

export default function OperatorRoutes() {
  return (
    <PlatformGuard>
      <Routes>
        <Route element={<OperatorShell />}>
          {/* The console opens on a decision screen, not on a queue. `Admin` keeps every
              platform-operations table it always had; it simply is no longer the first thing an
              operator sees on arrival. */}
          <Route path="/admin" element={<Overview />} />
          <Route path="/admin/platform" element={<Admin />} />
          <Route path="/admin/users" element={<Users />} />
          <Route path="/admin/users/:userId" element={<UserDetail />} />
          <Route path="/admin/team" element={<Team />} />
          <Route path="/admin/customers" element={<Customers />} />
          <Route path="/admin/customers/:orgId" element={<CustomerDetail />} />
          <Route path="/admin/funnel" element={<Funnel />} />
          <Route path="/admin/autonomy" element={<AutonomyPolicies />} />
          <Route path="/admin/signups" element={<SignupQuarantine />} />
          <Route path="/admin/purge" element={<PurgeCandidates />} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Route>
      </Routes>
    </PlatformGuard>
  );
}
