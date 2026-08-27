import React, { useState } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useNavigate } from 'react-router-dom';
import { inr, num, date, useAuth } from '../lib/api';
import { Chip, Empty, ErrorBanner, Kpi, Layout, Loading, useApi } from '../components/ui';

const TABS = ['Overview', 'Sales', 'Purchases', 'Inventory', 'Suppliers', 'Finance'] as const;
type Tab = typeof TABS[number];

export function AnalyticsPage() {
  const [tab, setTab] = useState<Tab>('Overview');
  const { branchId, warehouseId } = useAuth();
  const nav = useNavigate();

  const destinations: Record<Exclude<Tab, 'Overview'>, string> = {
    Sales: '/sales', Purchases: '/reports', Inventory: '/stock',
    Suppliers: '/suppliers', Finance: '/finance',
  };
  const selectTab = (item: Tab) => item === 'Overview' ? setTab(item) : nav(destinations[item]);
  return <AnalyticsOverview branchId={branchId} warehouseId={warehouseId}
    tabs={TABS} tab={tab} selectTab={selectTab} nav={nav} />;
}

function AnalyticsOverview({ branchId, warehouseId, tabs, tab, selectTab, nav }: {
  branchId: string | null; warehouseId: string | null; tabs: readonly Tab[]; tab: Tab;
  selectTab: (tab: Tab) => void; nav: (to: string) => void;
}) {
  const dashboard = useApi<any>(`/insights/dashboard?branchId=${branchId ?? ''}`, [branchId]);
  const sales = useApi<any>('/inventory/sales-summary?days=30');
  const stock = useApi<any[]>(`/insights/stock?warehouseId=${warehouseId ?? ''}`, [warehouseId]);

  if (dashboard.loading || sales.loading || stock.loading) return <Layout title="Analytics"><Loading /></Layout>;

  const k = dashboard.data?.kpis ?? {};
  const totals = sales.data?.totals ?? {};
  const products = sales.data?.byProduct ?? [];
  const trend = sales.data?.trend ?? [];
  const alerts = (dashboard.data?.topSuppliers ?? []).filter((s: any) => Number(s.performance_score) < 60);
  const inventoryValue = (stock.data ?? []).reduce((sum, item) => sum + Number(item.qty ?? 0) * Number(item.landed_rate ?? 0), 0);

  return (
    <Layout title="Analytics" subtitle="Trends, causes, comparisons, and performance"
      actions={<button className="btn" onClick={() => nav('/')}>Back to dashboard</button>}>
      <ErrorBanner error={dashboard.error ?? sales.error} />
      <div className="tabs">
        {tabs.map((item) => <button key={item} className={`tab ${tab === item ? 'active' : ''}`} onClick={() => selectTab(item)}>{item}</button>)}
      </div>

      <div className="grid c4 mb">
        <Kpi label="Revenue" value={inr(totals.revenue, 0)} foot="last 30 days" />
        <Kpi label="Purchases" value={inr(k.purchase_value_mtd, 0)} foot="month to date" />
        <Kpi label="Gross Margin" value={inr(totals.profit, 0)} tone={Number(totals.profit) < 0 ? 'crit' : 'good'} foot={totals.marginPct == null ? 'no sales yet' : `${num(totals.marginPct, 1)}% margin`} />
        <Kpi label="Inventory Value" value={inr(inventoryValue, 0)} foot="current stock position" />
      </div>

      <div className="grid c2 mb">
        <div className="card"><div className="card-head"><h2>Revenue trend</h2></div><div className="card-body">
          {trend.length ? <ResponsiveContainer width="100%" height={240}><AreaChart data={trend}><CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} /><XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d) => date(d).slice(0, 6)} /><YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}k`} /><Tooltip formatter={(v: any) => inr(v, 0)} /><Area type="monotone" dataKey="revenue" stroke="#0891B2" fill="#0891B2" fillOpacity={0.12} /></AreaChart></ResponsiveContainer> : <Empty title="No sales trend yet" />}
        </div></div>
        <div className="card"><div className="card-head"><h2>Sales vs purchases</h2></div><div className="card-body">
          {trend.length ? <ResponsiveContainer width="100%" height={240}><BarChart data={trend}><CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} /><XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d) => date(d).slice(0, 6)} /><YAxis tick={{ fontSize: 11 }} /><Tooltip formatter={(v: any) => inr(v, 0)} /><Legend /><Bar dataKey="revenue" name="sales" fill="#0891B2" /><Bar dataKey="profit" name="margin" fill="#16A34A" /></BarChart></ResponsiveContainer> : <Empty title="No comparison data yet" />}
        </div></div>
      </div>

      <div className="grid sidebar-right">
        <div className="card"><div className="card-head"><h2>Product performance</h2><button className="btn sm ghost" onClick={() => selectTab('Sales')}>View sales →</button></div><div className="card-body tight">
          {products.length ? <ResponsiveContainer width="100%" height={Math.max(220, Math.min(360, products.slice(0, 8).length * 38))}><BarChart data={products.slice(0, 8)} layout="vertical" margin={{ left: 80, right: 16 }}><CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" horizontal={false} /><XAxis type="number" tick={{ fontSize: 11 }} /><YAxis type="category" dataKey="name" width={76} tick={{ fontSize: 11 }} /><Tooltip formatter={(v: any) => inr(v, 0)} /><Bar dataKey="revenue" name="revenue" fill="#D97706" radius={[0, 3, 3, 0]} /></BarChart></ResponsiveContainer> : <Empty title="No product activity yet" />}
+        </div></div>
        <div className="stack">
          <div className="card"><div className="card-head"><h2>Business alerts</h2></div><div className="card-body tight">
            {alerts.length ? alerts.map((s: any) => <div className="row" key={s.id} style={{ padding: '10px 0' }}><Chip tone="warn">Review</Chip><span style={{ flex: 1 }}>{s.name} performance is below target</span><button className="btn sm" onClick={() => selectTab('Suppliers')}>View</button></div>) : <Empty icon="✅" title="No unusual supplier performance" />}
          </div></div>
          <div className="card"><div className="card-head"><h2>Explore detail</h2></div><div className="card-body"><p className="small muted">Use the tabs above to inspect sales, purchases, stock, suppliers, and finance without crowding the operational dashboard.</p></div></div>
        </div>
      </div>
    </Layout>
  );
}
