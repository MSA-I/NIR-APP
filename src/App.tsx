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

function Guard({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { session, profile, loading } = useAuth();
  if (loading) return <PageLoader />;
  if (!session || !profile) return <Navigate to="/login" replace />;
  if (!roles.includes(profile.role)) return <Navigate to={homeFor(profile.role)} replace />;
  return <>{children}</>;
}

const STAFF: Role[] = ['owner', 'office', 'kitchen'];
const FINANCE: Role[] = ['owner', 'office'];
const READERS: Role[] = ['owner', 'office', 'kitchen', 'accountant'];

export default function App() {
  const { session, profile, loading } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
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

        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
