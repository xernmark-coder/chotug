import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { api, useAuth } from './lib/api';
import { ErrorBanner, Field, Loading } from './components/ui';
import { AdminDashboardPage, DashboardPage, LoginPage, WorkQueuePage } from './pages/Home';
import { AnalyticsPage } from './pages/Analytics';
import { BuyListPage, RequirementDetailPage, RequirementListPage } from './pages/Planning';
import { ApprovalsPage, PoCreatePage, PoDetailPage, PoListPage } from './pages/Purchase';
import { ArrivalsPage, GateDetailPage, GateEntryPage } from './pages/Receiving';
import { GrnDetailPage, GrnListPage, StockPage } from './pages/Grn';
import { FleetPage } from './pages/Fleet';
import { AcceptInvitePage, PeoplePage } from './pages/People';
import { QuickOrderPage } from './pages/QuickOrder';
import { SalesPage } from './pages/Sales';
import { PackingPage } from './pages/Packing';
import { ScanLandingPage, ScanResultPage } from './pages/Scan';
import { SupplierPortalPage } from './pages/SupplierPortal';
import { WarehouseIntakePage } from './pages/Warehouse';
import { LogisticsDispatchPage } from './pages/Dispatch';
import { RejectionsPage } from './pages/Rejections';
import { DriverAppPage } from './pages/DriverApp';
import {
  AiCentrePage, AlertsPage, InvoiceCreatePage, InvoiceDetailPage, InvoiceListPage,
  PaymentsPage, ProfilePage, ReportsPage, SettingsPage, SuppliersPage,
} from './pages/Finance';
import { CataloguePage } from './pages/Catalogue';
import { FinanceDeskPage } from './pages/FinanceDesk';
import { MoneyFlowPage } from './pages/MoneyFlow';
import { UnloadPage } from './pages/Unload';
import { PackBenchPage } from './pages/PackBench';
import { WarehouseMapPage } from './pages/WarehouseMap';
import { MasterDataPage } from './pages/MasterData';
import { AuditPage, AuditDetailPage } from './pages/Audit';
import { CentresPage, CentreDayPage, CentreRequirementsPage, CustomersPage } from './pages/Centres';
import { PerformancePage } from './pages/Performance';
import { HrPage } from './pages/Hr';
import {
  CropDetailPage, CropListPage, CropStartPage, DispatchPage, FarmDashboardPage,
  FarmExpensePage, FarmPlanningPage, FarmSetupPage, FarmTodayPage, HarvestPage,
  PlotScanPage,
} from './pages/Farming';

export default function App() {
  const { me, loading } = useAuth();

  if (loading) return <Loading label="Starting up…" />;
  /* Somebody signed in with a password an admin typed for them. For those few
     minutes two people know it, so the app asks for a replacement before
     anything else — this is the only mitigation that actually works, and
     leaving it to a banner they can ignore means it never happens. */
  if (me?.mustChangePassword) return <ForcePasswordChange />;
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
  if (me.roles.includes('DRIVER')) {
    return (
      <Routes>
        <Route path="/" element={<DriverAppPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }

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

  if (me.roles.includes('CENTRE_EXEC')) {
    return (
      <Routes>
        <Route path="/" element={<CentreHomeRoute />} />
        <Route path="/dashboard" element={<CentreDayPage />} />
        <Route path="/sell" element={<SalesPage />} />
        <Route path="/requirements" element={<CentreRequirementsPage />} />
        <Route path="/centres/:id" element={<CentreDayPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      {/* The dashboard is the landing page: a list of tasks is what you open
          next, not what you want to be shown the moment you sign in. */}
      <Route path="/" element={me.permissions.includes('admin.override')
        ? <AdminDashboardPage /> : <DashboardPage />} />
      <Route path="/my-work" element={<WorkQueuePage />} />
      <Route path="/dashboard" element={<Navigate to="/" replace />} />
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
      <Route path="/intake" element={<WarehouseIntakePage />} />
      <Route path="/unload/:id" element={<UnloadPage />} />
      <Route path="/pack-bench/:batchId" element={<PackBenchPage />} />
      <Route path="/warehouse-map" element={<WarehouseMapPage />} />
      <Route path="/audit" element={<AuditPage />} />
      <Route path="/audit/:id" element={<AuditDetailPage />} />
      <Route path="/centres" element={<CentresPage />} />
      <Route path="/centres/:id" element={<CentreDayPage />} />
      <Route path="/customers" element={<CustomersPage />} />
      <Route path="/performance" element={<PerformancePage />} />
      <Route path="/analytics" element={<AnalyticsPage />} />
      <Route path="/hr" element={<HrPage />} />
      <Route path="/dispatch" element={<LogisticsDispatchPage />} />
        {/* Gate and receiving share one landing page; keep the old URL usable
          for bookmarks while the entry and detail routes remain unchanged. */}
        <Route path="/gate" element={<Navigate to="/arrivals" replace />} />
      <Route path="/gate/new" element={<GateEntryPage />} />
      <Route path="/gate/:id" element={<GateDetailPage />} />
      <Route path="/fleet" element={<FleetPage />} />

      <Route path="/rejections" element={<RejectionsPage />} />
      <Route path="/grns" element={<GrnListPage />} />
      <Route path="/grns/:id" element={<GrnDetailPage />} />
      {/* Put-away is gone: grading, labelling and shelving happen together at
          the packing bench. The old path is kept as a redirect so a bookmark
          or an old link lands somewhere sensible rather than on nothing. */}
      <Route path="/putaway" element={<Navigate to="/packing" replace />} />
      <Route path="/stock" element={<Navigate to="/analytics?tab=Inventory" replace />} />
      <Route path="/packing" element={<PackingPage />} />
      <Route path="/sales" element={<SalesPage />} />

      <Route path="/invoices" element={<InvoiceListPage />} />
      <Route path="/invoices/new" element={<InvoiceCreatePage />} />
      <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
      {/* Merged into the invoice list, which is where it was redirecting. */}
      <Route path="/payments" element={<Navigate to="/invoices" replace />} />
      <Route path="/suppliers" element={<Navigate to="/analytics?tab=Suppliers" replace />} />

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

      <Route path="/catalogue" element={<CataloguePage />} />
      <Route path="/master-data" element={<MasterDataPage />} />
      <Route path="/finance" element={<FinanceDeskPage />} />
      <Route path="/money" element={<MoneyFlowPage />} />
      <Route path="/reports" element={<Navigate to="/analytics?tab=Purchases" replace />} />
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

function CentreHomeRoute() {
  const { warehouseId } = useAuth();
  return warehouseId
    ? <Navigate to="/dashboard" replace />
    : <Navigate to="/profile" replace />;
}


/**
 * The one screen an account with an admin-set password sees until it has its
 * own. Deliberately not dismissable: a "change it later" link is a password
 * that never gets changed.
 */
function ForcePasswordChange() {
  const { me, logout, refresh } = useAuth();
  const [next, setNext] = React.useState('');
  const [again, setAgain] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<any>(null);
  const [current, setCurrent] = React.useState('');

  const mismatch = again.length > 0 && next !== again;

  return (
    <div className="login-page">
      <div className="card" style={{ maxWidth: 440, width: '100%', margin: 'auto' }}>
        <div className="card-head"><h2>Choose your own password</h2></div>
        <div className="card-body">
          <p className="small muted mb">
            Welcome, {me?.fullName?.split(' ')[0]}. The password you signed in with
            was set for you by an administrator, so somebody else knows it.
            Pick one only you know before you carry on.
          </p>
          <ErrorBanner error={error} />
          <Field label="The password you just used">
            <input type="password" autoFocus value={current}
              onChange={(e) => setCurrent(e.target.value)} />
          </Field>
          <Field label="Your new password" hint="At least 8 characters.">
            <input type="password" value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Field label="Type it again" hint={mismatch ? 'These two do not match.' : undefined}>
            <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} />
          </Field>
          <div className="btn-row mt">
            <button className="btn primary"
              disabled={busy || !current || next.length < 8 || next !== again}
              onClick={async () => {
                setBusy(true); setError(null);
                try {
                  await api.post('/auth/change-password',
                    { currentPassword: current, newPassword: next });
                  await refresh();
                } catch (e: any) { setError(e); } finally { setBusy(false); }
              }}>Save it and carry on</button>
            <button className="btn ghost" onClick={logout}>Sign out</button>
          </div>
        </div>
      </div>
    </div>
  );
}
