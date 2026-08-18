import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { api, useAuth, inr, num, date, ago } from '../lib/api';
import {
  Chip, Col, DataTable, Empty, ErrorBanner, Kpi, Layout, Loading, useApi, useToast,
} from '../components/ui';
import {
  CHART, ChartCard, compact, inrCompact, Meter, RankedBars, Spark, StackedStatus, TrendArea,
} from '../components/charts';
import { Icon } from '../components/icons';

/* ========================================================== LOGIN ======== */
const DEMO = [
  { email: 'owner@chotug.in', role: 'Owner — sees everything' },
  { email: 'buyer@chotug.in', role: 'Purchase Executive' },
  { email: 'manager@chotug.in', role: 'Purchase Manager' },
  { email: 'gate@chotug.in', role: 'Gate Executive' },
  { email: 'qc@chotug.in', role: 'QC Executive' },
  { email: 'wh@chotug.in', role: 'Warehouse Executive' },
  { email: 'finance@chotug.in', role: 'Finance Executive' },
];

export function LoginPage() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('owner@chotug.in');
  const [password, setPassword] = useState('chotug123');
  const [error, setError] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      nav('/');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <h1>ChotuG</h1>
        <p className="muted small mb">Purchase &amp; Receiving</p>
        <ErrorBanner error={error} />
        <div className="field">
          <label>Email or phone</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button className="btn primary block lg" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <div className="demo-users">
          <div className="small muted mb">Demo logins — password <b>chotug123</b></div>
          {DEMO.map((d) => (
            <div key={d.email} className="demo-user" onClick={() => setEmail(d.email)}>
              <b>{d.email}</b><span>{d.role}</span>
            </div>
          ))}
        </div>
      </form>
    </div>
  );
}

/* ======================================================== MY WORK ======== */
const QUEUE_ROUTE: Record<string, (t: any) => string> = {
  REQUIREMENT_REVIEW: (t) => `/requirements/${t.doc_id}`,
  APPROVAL: (t) => `/approvals`,
  // Straight to the order, where the Confirm button lives.
  PO_CONFIRM: (t) => `/purchase-orders/${t.doc_id}`,
  EXPECTED_ARRIVAL: (t) => `/gate/new?poId=${t.doc_id}`,
  WEIGH_PENDING: (t) => `/gate/${t.doc_id}`,
  QC_PENDING: (t) => `/gate/${t.doc_id}`,
  GRN_PENDING: (t) => `/gate/${t.doc_id}`,
  PUTAWAY_PENDING: () => `/putaway`,
  INVOICE_MATCH: (t) => `/invoices/${t.doc_id}`,
  AI_SUGGESTION: () => `/buy-list`,
  ALERT: () => `/alerts`,
  FINANCE_EXCEPTION: () => `/invoices`,
  FARM_TASK: (t) => `/farm?farmId=${t.doc_id}`,
  FARM_HARVEST: () => `/farm/dispatch`,
  FARM_RECEIVE: () => `/farm/dispatch`,
};

const QUEUE_LABEL: Record<string, string> = {
  REQUIREMENT_REVIEW: 'Requirement', APPROVAL: 'Approval', EXPECTED_ARRIVAL: 'Arrival',
  WEIGH_PENDING: 'Weighment', QC_PENDING: 'Quality check', GRN_PENDING: 'Goods receipt',
  PUTAWAY_PENDING: 'Put-away', INVOICE_MATCH: 'Invoice', AI_SUGGESTION: 'Suggestion',
  ALERT: 'Alert', FINANCE_EXCEPTION: 'Finance', PO_CONFIRM: 'Confirm order',
  FARM_TASK: 'Farm work', FARM_HARVEST: 'Harvest', FARM_RECEIVE: 'Farm delivery',
};

/* The queue text is written once, on the server, in requestApprovals() and
 * pushTask() — the same sentence that goes into the audit trail. This page
 * used to rewrite it here, which meant two places to keep honest and a
 * lower-cased supplier name. It renders what it is given. */

export function WorkQueuePage() {
  const nav = useNavigate();
  const { me } = useAuth();
  const { data, loading, error, reload } = useApi<any[]>('/insights/work-queue');

  const tasks = data ?? [];
  const breached = tasks.filter((t) => t.sla_breached).length;

  const cols: Col<any>[] = [
    { key: 'k', head: 'What', width: 150, render: (t) => <Chip tone={t.severity === 'critical' ? 'danger' : t.severity === 'warn' ? 'warn' : 'primary'}>{QUEUE_LABEL[t.queue_key] ?? t.queue_key}</Chip> },
    { key: 't', head: 'Task', render: (t) => (
      <div>
        <div style={{ fontWeight: 600 }}>{t.title}</div>
        {t.subtitle ? <div className="small muted">{t.subtitle}</div> : null}
      </div>
    ) },
    { key: 'd', head: 'Document', render: (t) => <span className="mono small">{t.doc_no ?? '—'}</span> },
    { key: 'w', head: 'Where', render: (t) => <span className="small muted">{t.warehouse_name ?? t.branch_name}</span> },
    { key: 'a', head: 'Waiting', render: (t) => (
      <span className={t.sla_breached ? 'chip danger' : 'small muted'}>
        {t.sla_breached ? 'Overdue' : ago(t.created_at)}
      </span>
    ) },
    { key: 'go', head: '', width: 90, render: () => <span className="btn sm primary">Open →</span> },
  ];

  return (
    <Layout
      title={`Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, ${me?.fullName?.split(' ')[0] ?? ''}`}
      subtitle={tasks.length ? `${tasks.length} thing${tasks.length === 1 ? '' : 's'} waiting for you` : 'Nothing is waiting for you'}
      actions={<button className="btn sm" onClick={reload}>Refresh</button>}
    >
      <ErrorBanner error={error} />
      {breached > 0 ? (
        <div className="banner danger mb">
          <span>⏰</span>
          <div><b>{breached} task{breached === 1 ? ' is' : 's are'} past the agreed time.</b> They are at the top of the list.</div>
        </div>
      ) : null}

      <div className="card">
        <div className="card-head"><h2>Your queue</h2></div>
        <div className="card-body tight">
          <DataTable
            rows={tasks} cols={cols} loading={loading}
            rowTone={(t) => (t.sla_breached || t.severity === 'critical' ? 'crit' : t.severity === 'warn' ? 'warn' : undefined)}
            onRowClick={(t) => nav((QUEUE_ROUTE[t.queue_key] ?? (() => '/dashboard'))(t))}
            empty={<Empty icon="✅" title="You are all caught up"
              hint="New work appears here the moment someone hands it to you." />}
          />
        </div>
      </div>
    </Layout>
  );
}

/* ======================================================= DASHBOARD ======= */
export function DashboardPage() {
  const nav = useNavigate();
  const { branchId, can, me } = useAuth();
  const { data, loading, error } = useApi<any>(`/insights/dashboard?branchId=${branchId ?? ''}`, [branchId]);
  const queue = useApi<any[]>('/insights/work-queue');
  const queueCount = (queue.data ?? []).length;

  if (loading) return <Layout title="Dashboard"><Loading /></Layout>;

  const k = data?.kpis ?? {};
  const q = data?.quality ?? {};
  const prev = data?.prev ?? {};
  const trend = data?.trend ?? [];
  const showMoney = can('data.cost.view', 'reports.purchase.view');

  const day = (d: string) => date(d).slice(0, 6);

  const spend30 = Number(prev.value_30d ?? 0);
  const spendPrev = Number(prev.value_prev_30d ?? 0);
  const spendDelta = spendPrev > 0 ? ((spend30 - spendPrev) / spendPrev) * 100 : null;

  const accepted = Number(prev.accepted_30d ?? 0);
  const rejected = Number(prev.rejected_30d ?? 0);
  const acceptPct = accepted + rejected > 0 ? (accepted / (accepted + rejected)) * 100 : null;

  const gateTotal = (k.awaiting_weighment ?? 0) + (k.awaiting_qc ?? 0) + (k.awaiting_grn ?? 0);

  const mix = (data?.sourceMix ?? []).map((m: any) => ({
    name: String(m.source_type ?? '—').toLowerCase(),
    value: Number(m.value_30d),
    receipts: Number(m.receipts_30d),
  }));

  const suppliers = (data?.topSuppliers ?? []).slice(0, 6).map((s: any) => ({
    name: s.name, value: Number(s.value_30d), score: s.performance_score,
  }));

  return (
    <Layout title="Purchase dashboard" subtitle="Today at a glance">
      <ErrorBanner error={error} />

      <div className="hero">
        <div>
          <h1>{greeting()}, {me?.fullName?.split(' ')[0]}</h1>
          <p>
            {queueCount > 0
              ? `${queueCount} thing${queueCount === 1 ? '' : 's'} are waiting on you.`
              : 'Nothing is waiting on you right now.'}
          </p>
        </div>
        <span className="spacer" />
        <button className="btn ghost-light lg" onClick={() => nav('/my-work')}>
          <Icon name="target" />
          My work
          {queueCount > 0 ? <span className="hero-badge">{queueCount}</span> : null}
        </button>
        {can('purchase.po.create') ? (
          <button className="btn lg" onClick={() => nav('/order-flow')}>
            <Icon name="bolt" />
            Order in one flow
          </button>
        ) : null}
      </div>

      <div className="section-head"><h2>Where everything is</h2><span className="rule" /></div>
      <FlowStrip flow={data?.flow ?? {}} overdue={Number(k.overdue_approvals ?? 0)} nav={nav} />

      <div className="section-head"><h2>Needs a person</h2><span className="rule" /></div>
      <div className="grid c4 mb">
        <Kpi label="Needs approval" value={k.pending_approvals ?? 0}
          tone={k.overdue_approvals > 0 ? 'crit' : k.pending_approvals > 0 ? 'warn' : undefined}
          foot={k.overdue_approvals > 0 ? `${k.overdue_approvals} past the agreed time` : 'all within time'}
          onClick={() => nav('/approvals')} />
        <Kpi label="Arriving today" value={k.arrivals_today ?? 0}
          foot="expected vehicles" onClick={() => nav('/arrivals')} />
        <Kpi label="At the gate" value={gateTotal}
          tone={(k.awaiting_qc ?? 0) > 0 ? 'warn' : undefined}
          foot={`${k.awaiting_weighment ?? 0} to weigh · ${k.awaiting_qc ?? 0} QC · ${k.awaiting_grn ?? 0} to post`}
          onClick={() => nav('/gate')} />
        <Kpi label="Open alerts" value={k.open_alerts ?? 0}
          tone={(k.open_alerts ?? 0) > 0 ? 'crit' : 'good'}
          foot="high or critical" onClick={() => nav('/alerts')} />
      </div>

      {showMoney ? (
        <>
          <div className="section-head"><h2>Money</h2><span className="rule" /></div>
          <div className="grid c4 mb">
            <Kpi label="Purchased, 30 days" value={inr(spend30, 0)}
              delta={spendDelta} deltaLabel="vs previous 30"
              spark={<Spark data={trend} y="value" />} />
            <Kpi label="Purchased today" value={inr(k.purchase_value_today, 0)}
              foot={`${inr(k.purchase_value_mtd, 0)} this month`} />
            <Kpi label="Outstanding payable" value={inr(k.outstanding_payable, 0)}
              tone={Number(k.overdue_payable) > 0 ? 'warn' : undefined}
              foot={Number(k.overdue_payable) > 0
                ? `${inr(k.overdue_payable, 0)} overdue` : 'nothing overdue'}
              onClick={() => nav('/payments')} />
            <Kpi label="Accepted on arrival"
              value={acceptPct == null ? '—' : `${num(acceptPct, 1)}%`}
              tone={Number(q.rejection_pct_30d) > 8 ? 'crit'
                : Number(q.rejection_pct_30d) > 4 ? 'warn' : 'good'}
              foot={`${num(q.rejection_pct_30d, 1)}% rejected · avg score ${num(q.avg_quality_score_30d, 0)}`} />
          </div>
        </>
      ) : null}

      <div className="section-head"><h2>Last 30 days</h2><span className="rule" /></div>
      <div className="grid c2 mb">
        <ChartCard
          title="What you spent"
          hint="Posted goods receipts, by the day they were posted."
          empty={!trend.length ? (
            <Empty icon="📊" title="No receipts posted yet"
              hint="Post a goods receipt and this fills in." />
          ) : undefined}
        >
          <TrendArea data={trend} x="date" y="value" labelFmt={day}
            valueFmt={(v: any) => inrCompact(Number(v))} />
        </ChartCard>

        <ChartCard
          title="What you kept, and what you sent back"
          legend={[
            { label: 'Accepted', color: CHART.status.ok },
            { label: 'Rejected', color: CHART.status.danger },
          ]}
          hint="Quantity received each day, split by the quality decision."
          empty={!trend.length ? (
            <Empty icon="🧪" title="Nothing inspected yet" />
          ) : undefined}
        >
          <StackedStatus data={trend} x="date" labelFmt={day}
            valueFmt={(v: any) => compact(Number(v))}
            series={[
              { key: 'accepted_qty', label: 'Accepted', color: CHART.status.ok },
              { key: 'rejected_qty', label: 'Rejected', color: CHART.status.danger },
            ]} />
        </ChartCard>
      </div>

      <div className="grid sidebar-right">
        <div className="stack">
          {showMoney ? (
            <ChartCard
              title="Biggest suppliers"
              action={<button className="btn sm ghost" onClick={() => nav('/suppliers')}>All suppliers →</button>}
              hint="Value of posted receipts in the last 30 days."
              empty={!suppliers.length ? <Empty icon="🤝" title="No supplier activity yet" /> : undefined}
            >
              <RankedBars data={suppliers} label="name" value="value"
                valueFmt={(v: any) => inrCompact(Number(v))} />
            </ChartCard>
          ) : null}

          {showMoney && mix.length ? (
            <ChartCard
              title="Where you bought from"
              legend={mix.map((m: any, i: number) => ({
                label: m.name, color: CHART.series[i % CHART.series.length],
              }))}
              hint="Source type is a property of the supplier, not of the order."
            >
              <RankedBars data={mix} label="name" value="value" height={mix.length * 34 + 20}
                colors={CHART.series}
                valueFmt={(v: any) => inrCompact(Number(v))} />
            </ChartCard>
          ) : null}
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head">
              <h2>Running low</h2>
              <button className="btn sm primary" onClick={() => nav('/buy-list')}>Buy list →</button>
            </div>
            <div className="card-body tight">
              <DataTable
                rows={data?.criticalStock ?? []}
                cols={[
                  { key: 'p', head: 'Product', render: (p: any) => (
                    <div><b>{p.name}</b><div className="small muted">{p.sku}</div></div>
                  ) },
                  { key: 's', head: 'Stock', num: true, render: (p: any) => (
                    <div>{num(p.current_stock, 0)}<div className="small muted">of {num(p.reorder_point, 0)}</div></div>
                  ) },
                  { key: 'd', head: 'Days of cover', num: true, render: (p: any) =>
                    p.days_of_cover == null ? <span className="muted">—</span> : (
                      <Meter
                        pct={Math.min(100, (Number(p.days_of_cover) / 7) * 100)}
                        tone={p.days_of_cover < 1 ? 'danger' : p.days_of_cover < 2 ? 'warn' : 'ok'}
                        label={`${num(p.days_of_cover, 1)}d`} />
                    ) },
                ]}
                onRowClick={() => nav('/buy-list')}
                rowTone={(p: any) => (p.days_of_cover != null && p.days_of_cover < 1 ? 'crit' : undefined)}
                empty={<Empty icon="👍" title="Nothing below reorder point" />}
              />
            </div>
          </div>

        </div>
      </div>
    </Layout>
  );
}

/* ===========================================================================
 * THE PIPELINE
 *
 * Produce moves in one direction — a need becomes an order, an order becomes a
 * vehicle, a vehicle becomes stock, stock becomes money — and the number that
 * matters at each stage is how much is SITTING there. Read left to right it is
 * the whole business on one line, and every step opens the screen where that
 * work is actually done.
 * ======================================================================== */

const FLOW_STEPS: {
  key: string; label: string; icon: string; to: string;
  /** Sitting here is normal up to this many; past it, it is a queue. */
  hot?: number;
}[] = [
  { key: 'need',       label: 'To buy',      icon: 'calculator', to: '/buy-list' },
  { key: 'approve',    label: 'Approve',     icon: 'checkDoc',   to: '/approvals', hot: 1 },
  { key: 'to_confirm', label: 'Confirm',     icon: 'box',        to: '/purchase-orders', hot: 1 },
  { key: 'in_transit', label: 'On the road', icon: 'route',      to: '/dispatch' },
  { key: 'at_gate',    label: 'At the gate', icon: 'gate',       to: '/intake', hot: 1 },
  { key: 'in_qc',      label: 'Quality',     icon: 'scale',      to: '/gate', hot: 1 },
  { key: 'to_book',    label: 'Book in',     icon: 'inbox',      to: '/gate', hot: 1 },
  { key: 'to_putaway', label: 'Put away',    icon: 'shelf',      to: '/putaway', hot: 1 },
  { key: 'packed',     label: 'Packed',      icon: 'tag',        to: '/packing' },
  { key: 'to_match',   label: 'Match bills', icon: 'invoice',    to: '/invoices', hot: 1 },
  { key: 'to_pay',     label: 'To pay',      icon: 'card',       to: '/payments' },
];

function FlowStrip({ flow, overdue, nav }: {
  flow: Record<string, any>; overdue: number; nav: (to: string) => void;
}) {
  return (
    <div className="flow">
      {FLOW_STEPS.map((s) => {
        const n = Number(flow[s.key] ?? 0);
        // Approvals are the one stage where late is worse than many.
        const crit = s.key === 'approve' && overdue > 0;
        const hot = !crit && s.hot != null && n >= s.hot;
        return (
          <a
            key={s.key}
            className={`flow-step ${crit ? 'crit' : hot ? 'hot' : n === 0 ? 'idle' : ''}`}
            onClick={(e) => { e.preventDefault(); nav(s.to); }}
            href={s.to}
            title={`${n} at ${s.label.toLowerCase()} — open`}
          >
            <span className="ic"><Icon name={s.icon} size={16} /></span>
            <span className="n">{n}</span>
            <span className="t">{s.label}</span>
            {crit ? <span className="small" style={{ color: 'var(--danger)' }}>{overdue} late</span> : null}
          </a>
        );
      })}
    </div>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}
