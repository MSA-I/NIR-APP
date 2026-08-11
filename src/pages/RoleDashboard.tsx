import { useAuth } from '../auth/AuthContext';
import AccountantDashboard from './dashboards/AccountantDashboard';

/**
 * Role-tailored control room for the accountant (owner/office keep the full Dashboard).
 */
export default function RoleDashboard() {
  const { profile } = useAuth();
  switch (profile?.role) {
    case 'accountant': return <AccountantDashboard />;
    default: return null;
  }
}
