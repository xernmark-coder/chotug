import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/api';
import { Loading } from './components/ui';
import { DashboardPage, LoginPage, WorkQueuePage } from './pages/Home';
import { BuyListPage, RequirementDetailPage, RequirementListPage } from './pages/Planning';
import { ApprovalsPage, PoCreatePage, PoDetailPage, PoListPage } from './pages/Purchase';
import { ArrivalsPage, GateDetailPage, GateEntryPage, GatePipelinePage } from './pages/Receiving';
import { GrnDetailPage, GrnListPage, PutawayPage, StockPage } from './pages/Grn';
import { FleetPage } from './pages/Fleet';
import { AcceptInvitePage, PeoplePage } from './pages/People';
import { QuickOrderPage } from './pages/QuickOrder';
import { SalesPage } from './pages/Sales';
import { PackingPage } from './pages/Packing';
import { ScanLandingPage, ScanResultPage } from './pages/Scan';
import { SupplierPortalPage } from './pages/SupplierPortal';
import {
  AiCentrePage, AlertsPage, InvoiceCreatePage, InvoiceDetailPage, InvoiceListPage,
  PaymentsPage, ProfilePage, ReportsPage, SettingsPage, SuppliersPage,
} from './pages/Finance';
import {
  CropDetailPage, CropListPage, CropStartPage, DispatchPage, FarmDashboardPage,
  FarmExpensePage, FarmPlanningPage, FarmSetupPage, FarmTodayPage, HarvestPage,
  PlotScanPage,
} from './pages/Farming';

export default function App() {
  const { me, loading } = useAuth();

  if (loading) return <Loading label="Starting up…" />;
  if (!me) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {/* Signed out by definition — an invited person has no account yet. */}
        <Route path="/accept-invite" element={<AcceptInvitePage />} />
        {/* Public by design — a shopkeeper scanning a pack has no account. */}
        <Route path="/p" element={<ScanLandingPage />} />
        <Route path="/p/:code" element={<ScanResultPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  /* An outside contact at a supplier gets their own application, not our
   * sidebar with most of it hidden. Anything they ask for that is not theirs
   * lands back on their own home. */
  if (me.roles.includes('SUPPLIER')) {
    return (
      <Routes>
        <Route path="/" element={<SupplierPortalPage />} />
        <Route path="/p" element={<ScanLandingPage />} />
        <Route path="/p/:code" element={<ScanResultPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="/" element={<WorkQueuePage />} />
      <Route path="/dashboard" element={<DashboardPage />} />
      <Route path="/alerts" element={<AlertsPage />} />

      <Route path="/order-flow" element={<QuickOrderPage />} />
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
      <Route path="/fleet" element={<FleetPage />} />

      <Route path="/grns" element={<GrnListPage />} />
      <Route path="/grns/:id" element={<GrnDetailPage />} />
      <Route path="/putaway" element={<PutawayPage />} />
      <Route path="/stock" element={<StockPage />} />
      <Route path="/packing" element={<PackingPage />} />
      <Route path="/sales" element={<SalesPage />} />

      <Route path="/invoices" element={<InvoiceListPage />} />
      <Route path="/invoices/new" element={<InvoiceCreatePage />} />
      <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
      <Route path="/payments" element={<PaymentsPage />} />
      <Route path="/suppliers" element={<SuppliersPage />} />

      {/* Farming. /farm is the field worker's whole application. */}
      <Route path="/farm" element={<FarmTodayPage />} />
      <Route path="/farm/dashboard" element={<FarmDashboardPage />} />
      <Route path="/farm/crops" element={<CropListPage />} />
      <Route path="/farm/crops/new" element={<CropStartPage />} />
      <Route path="/farm/crops/:id" element={<CropDetailPage />} />
      <Route path="/farm/harvest" element={<HarvestPage />} />
      <Route path="/farm/dispatch" element={<DispatchPage />} />
      <Route path="/farm/expenses" element={<FarmExpensePage />} />
      <Route path="/farm/planning" element={<FarmPlanningPage />} />
      <Route path="/farm/setup" element={<FarmSetupPage />} />
      {/* What the QR on a plot gate resolves to. */}
      <Route path="/farm/plot/:qr" element={<PlotScanPage />} />

      <Route path="/reports" element={<ReportsPage />} />
      <Route path="/ai" element={<AiCentrePage />} />
      <Route path="/people" element={<PeoplePage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/profile" element={<ProfilePage />} />
      {/* Reachable while signed in too, so an admin testing the link, or
          someone already logged in on that browser, still lands correctly. */}
      <Route path="/accept-invite" element={<AcceptInvitePage />} />
      <Route path="/p" element={<ScanLandingPage />} />
      <Route path="/p/:code" element={<ScanResultPage />} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
