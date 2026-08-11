import { useAuth } from '../auth/AuthContext';
import KitchenDashboard from './dashboards/KitchenDashboard';
import AccountantDashboard from './dashboards/AccountantDashboard';
import SupplierDashboard from './dashboards/SupplierDashboard';

/**
 * Role-tailored control room for the non-finance roles (owner/office keep the full Dashboard). Each
 * branch lives in its own file under dashboards/ and queries ONLY what that role's RLS allows, with
 * KPIs + charts scoped to its own data. Imported statically so all four stay in one lazy chunk.
 */
export default function RoleDashboard() {
  const { profile } = useAuth();
  switch (profile?.role) {
    case 'kitchen': return <KitchenDashboard />;
    // G3, 10.08.2026: the accountant IS the executor, so there is one control room for the
    // payment path instead of two. An existing payer account keeps working — it now opens the
    // accountant's dashboard, which is a superset of what PayerDashboard showed.
    case 'payer':
    case 'accountant': return <AccountantDashboard />;
    case 'supplier': return <SupplierDashboard />;
    default: return null;
  }
}
