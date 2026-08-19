import { Navigate, Route, Routes } from 'react-router';
import { useEffect, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';
import { PageLoader } from '../components/ui';
import Admin from '../pages/Admin';
import OperatorShell from './OperatorShell';
import AutonomyPolicies from './AutonomyPolicies';

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
  return <PageLoader />;
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
  if (!session) return <DocumentRedirect to="/login" />;
  if (!isPlatformAdmin) return <DocumentRedirect to="/" />;
  return <>{children}</>;
}

export default function OperatorRoutes() {
  return (
    <PlatformGuard>
      <Routes>
        <Route element={<OperatorShell />}>
          <Route path="/admin" element={<Admin />} />
          <Route path="/admin/autonomy" element={<AutonomyPolicies />} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Route>
      </Routes>
    </PlatformGuard>
  );
}
