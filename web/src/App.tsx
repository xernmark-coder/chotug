import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/api';
import { Loading } from './components/ui';
import { DashboardPage, LoginPage, WorkQueuePage } from './pages/Home';
import { BuyListPage, RequirementDetailPage, RequirementListPage } from './pages/Planning';
import { ApprovalsPage, PoCreatePage, PoDetailPage, PoListPage } from './pages/Purchase';
import { ArrivalsPage, GateDetailPage, GateEntryPage, GatePipelinePage } from './pages/Receiving';
import { GrnDetailPage, GrnListPage, PutawayPage, StockPage } from './pages/Grn';
import {
  AiCentrePage, AlertsPage, InvoiceCreatePage, InvoiceDetailPage, InvoiceListPage,
  PaymentsPage, ProfilePage, ReportsPage, SettingsPage, SuppliersPage,
} from './pages/Finance';

export default function App() {
  const { me, loading } = useAuth();

  if (loading) return <Loading label="Starting up…" />;
  if (!me) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="/" element={<WorkQueuePage />} />
      <Route path="/dashboard" element={<DashboardPage />} />
      <Route path="/alerts" element={<AlertsPage />} />

      <Route path="/buy-list" element={<BuyListPage />} />
      <Route path="/requirements" element={<RequirementListPage />} />
      <Route path="/requirements/:id" element={<RequirementDetailPage />} />

      <Route path="/purchase-orders" element={<PoListPage />} />
      <Route path="/purchase-orders/new" element={<PoCreatePage />} />
      <Route path="/purchase-orders/:id" element={<PoDetailPage />} />
      <Route path="/approvals" element={<ApprovalsPage />} />

      <Route path="/arrivals" element={<ArrivalsPage />} />
      <Route path="/gate" element={<GatePipelinePage />} />
      <Route path="/gate/new" element={<GateEntryPage />} />
      <Route path="/gate/:id" element={<GateDetailPage />} />

      <Route path="/grns" element={<GrnListPage />} />
      <Route path="/grns/:id" element={<GrnDetailPage />} />
      <Route path="/putaway" element={<PutawayPage />} />
      <Route path="/stock" element={<StockPage />} />

      <Route path="/invoices" element={<InvoiceListPage />} />
      <Route path="/invoices/new" element={<InvoiceCreatePage />} />
      <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
      <Route path="/payments" element={<PaymentsPage />} />
      <Route path="/suppliers" element={<SuppliersPage />} />

      <Route path="/reports" element={<ReportsPage />} />
      <Route path="/ai" element={<AiCentrePage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/profile" element={<ProfilePage />} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
