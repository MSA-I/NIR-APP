import { useAuth } from '../auth/AuthContext';
import KitchenDashboard from './dashboards/KitchenDashboard';
import AccountantDashboard from './dashboards/AccountantDashboard';
import PayerDashboard from './dashboards/PayerDashboard';
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
    case 'accountant': return <AccountantDashboard />;
    case 'payer': return <PayerDashboard />;
    case 'supplier': return <SupplierDashboard />;
    default: return null;
  }
}
