import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { api, useAuth, inr, num, date, ago } from '../lib/api';
import {
  Chip, Col, DataTable, Empty, ErrorBanner, Kpi, Layout, Loading, useApi, useToast,
  FilterBar, FilterTotals, LanguageSelector, useFilters,
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
      <div className="login-language"><LanguageSelector /></div>
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
  // Straight to the order, where "Send to supplier" lives.
  PO_CONFIRM: (t) => `/purchase-orders/${t.doc_id}`,
  EXPECTED_ARRIVAL: (t) => `/gate/new?poId=${t.doc_id}`,
  WEIGH_PENDING: (t) => `/gate/${t.doc_id}`,
  QC_PENDING: (t) => `/gate/${t.doc_id}`,
  GRN_PENDING: (t) => `/gate/${t.doc_id}`,
  /* Straight to the bench for that batch. Put-away as a separate step is
     gone — grading, labelling and shelving are one job at one table. */
  PUTAWAY_PENDING: (t) => `/pack-bench/${t.doc_id}`,
  INVOICE_MATCH: (t) => `/invoices/${t.doc_id}`,
  AI_SUGGESTION: () => `/buy-list`,
  ALERT: () => `/alerts`,
  FINANCE_EXCEPTION: () => `/invoices`,
  FARM_TASK: (t) => `/farm?farmId=${t.doc_id}`,
  FARM_HARVEST: () => `/farm/dispatch`,
  FARM_RECEIVE: () => `/farm/dispatch`,
  // Straight to Dispatch, where the vehicle gets arranged.
  TRANSPORT_REQUEST: () => `/dispatch`,
};

const QUEUE_LABEL: Record<string, string> = {
  REQUIREMENT_REVIEW: 'Requirement', APPROVAL: 'Approval', EXPECTED_ARRIVAL: 'Arrival',
  WEIGH_PENDING: 'Weighment', QC_PENDING: 'Quality check', GRN_PENDING: 'Goods receipt',
  PUTAWAY_PENDING: 'Grade & pack', INVOICE_MATCH: 'Invoice', AI_SUGGESTION: 'Suggestion',
  ALERT: 'Alert', FINANCE_EXCEPTION: 'Finance', PO_CONFIRM: 'Order',
  TRANSPORT_REQUEST: 'Vehicle wanted',
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

  const f = useFilters<any>(tasks, {
    date: (t: any) => t.created_at,
    search: (t: any) => [t.title, t.subtitle, t.reference_no, QUEUE_LABEL[t.queue_key]]
      .filter(Boolean).join(' '),
    facets: [
      { key: 'q', label: 'kind', of: (t: any) => QUEUE_LABEL[t.queue_key] ?? t.queue_key },
      { key: 'sv', label: 'urgency', of: (t: any) => t.severity },
      { key: 'sla', label: 'timing', all: 'Early and late', of: (t: any) =>
        (t.sla_breached ? 'past the agreed time' : 'in time') },
    ],
    totals: [],
  });

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
          <span><Icon name="clock" size={16} /></span>
          <div><b>{breached} task{breached === 1 ? ' is' : 's are'} past the agreed time.</b> They are at the top of the list.</div>
        </div>
      ) : null}

      <div className="card">
        <div className="card-head"><h2>Your queue</h2></div>
        <div className="card-body tight">
          <FilterBar f={f} placeholder="Search the queue" />
          <FilterTotals f={f} noun="task" />
          <DataTable
            rows={f.rows} cols={cols} loading={loading}
            rowTone={(t) => (t.sla_breached || t.severity === 'critical' ? 'crit' : t.severity === 'warn' ? 'warn' : undefined)}
            onRowClick={(t) => nav((QUEUE_ROUTE[t.queue_key] ?? (() => '/dashboard'))(t))}
            empty={<Empty icon="✅"
              title={f.active > 0 ? 'Nothing matches those filters' : 'You are all caught up'}
              hint={f.active > 0 ? 'Clear a filter to widen the search.'
                : 'New work appears here the moment someone hands it to you.'} />}
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

  /* Above the loading guard — a hook cannot sit behind an early return. */
  const fLow = useFilters<any>(data?.criticalStock, {
    search: (p2: any) => [p2.name, p2.sku].filter(Boolean).join(' '),
    facets: [
      { key: 'c', label: 'cover', all: 'Any cover', of: (p2: any) =>
        p2.days_of_cover == null ? null
          : p2.days_of_cover < 1 ? 'gone today'
          : p2.days_of_cover < 2 ? 'gone tomorrow' : 'a few days left' },
    ],
    totals: [{ label: 'Products', of: () => 1 }],
  });

  if (loading) return <Layout title="Dashboard"><Loading /></Layout>;

  const k = data?.kpis ?? {};
  const q = data?.quality ?? {};
  const prev = data?.prev ?? {};
  const trend = data?.trend ?? [];

  /* Which parts of the business this person actually owns. A quality inspector
   * has no use for outstanding payables and a gate clerk has none for the
   * buy list, so each block below is shown to the people whose job it is —
   * the same permission that guards the page it links to. */
  const isApprover = can('purchase.po.approve', 'purchase.requirement.approve', 'finance.invoice.approve');
  const isGate     = can('receiving.gate.create');
  const isQc       = can('quality.inspection.create', 'quality.inspection.approve');
  const isStore    = can('receiving.grn.submit', 'receiving.putaway.confirm', 'inventory.stock.issue');
  const isBuyer    = can('purchase.po.create', 'purchase.requirement.create');
  const isFinance  = can('finance.invoice.match', 'finance.invoice.create', 'finance.payment.view',
                         'finance.request.verify', 'finance.payment.make');
  // Confirming an order is now an approver's act, so it is their tile.
  const canConfirm = can('purchase.po.approve');
  const seesReports = can('reports.purchase.view');
  const auditor = me?.roles.includes('AUDITOR') ?? false;
  // The pipeline strip is only meaningful to someone who works somewhere in it.
  const seesFlow   = isBuyer || isGate || isStore || seesReports;
  const seesAlerts = !auditor && can('reports.purchase.view', 'admin.settings.manage',
                         'quality.inspection.approve', 'farming.report.view');
  // Everyone gets at least one tile; if none of the above fired, the work
  // queue is the whole dashboard rather than an empty page.
  /* isGate / isStore are deliberately broad — a purchase manager holds
   * receiving.gate.create and inventory.stock.issue so they can handle an
   * exception, and they should still see the pipeline. But an exception power
   * is not a day job: gating the sections on those made a purchase manager's
   * dashboard eighteen tiles across five teams. These two narrower checks are
   * the permissions only the gate and the store actually hold. */
  const worksGate  = can('receiving.gate.submit');
  const worksStore = can('receiving.putaway.confirm', 'receiving.grn.submit');
  const seesNeedsPerson = isApprover || canConfirm || seesAlerts;
  /* Spend and payables are a manager's, an owner's and finance's business.
   * A buyer holds reports.purchase.view, which used to be enough to show them
   * the payables ledger — so they get their own spend figure in "Your buying"
   * instead, and this block stays with the people who act on it. */
  const showMoney = can('data.cost.view') || isFinance;


  const day = (d: string) => date(d).slice(0, 6);

  const spend30 = Number(prev.value_30d ?? 0);
  const spendPrev = Number(prev.value_prev_30d ?? 0);
  const spendDelta = spendPrev > 0 ? ((spend30 - spendPrev) / spendPrev) * 100 : null;

  const accepted = Number(prev.accepted_30d ?? 0);
  const rejected = Number(prev.rejected_30d ?? 0);
  const acceptPct = accepted + rejected > 0 ? (accepted / (accepted + rejected)) * 100 : null;

  const flow = data?.flow ?? {};
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
    <Layout title={isQc && !isBuyer ? 'Quality dashboard'
      : isStore && !isBuyer ? 'Warehouse dashboard'
      : isGate && !isBuyer && !isStore ? 'Gate dashboard'
      : isFinance && !isBuyer ? 'Finance dashboard'
      : 'Purchase dashboard'} subtitle="Today at a glance">
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
        {/* The one-flow screen skips every checkpoint between requirement and
            confirmed order, so it is an owner's shortcut, not a buyer's tool.
            The sidebar has always gated it on admin.override; this button was
            gated on purchase.po.create, which every buyer holds — so the
            shortcut was one click away from the people it exists to bypass. */}
        {can('admin.override') ? (
          <button className="btn lg" onClick={() => nav('/order-flow')}>
            <Icon name="bolt" />
            Order in one flow
          </button>
        ) : null}
      </div>

      <QuickActions can={can} nav={nav} />

      {seesFlow ? (
        <>
          <div className="section-head"><h2>Where everything is</h2><span className="rule" /></div>
          <FlowStrip flow={data?.flow ?? {}} overdue={Number(k.overdue_approvals ?? 0)} nav={nav} />
        </>
      ) : null}

      {/* Shared across roles: a decision to make, or something broken. */}
      {seesNeedsPerson ? (
        <>
          <div className="section-head"><h2>Needs a person</h2><span className="rule" /></div>
          <div className="grid c4 mb">
            {isApprover ? (
              <Kpi label="Needs approval" value={k.pending_approvals ?? 0}
                tone={k.overdue_approvals > 0 ? 'crit' : k.pending_approvals > 0 ? 'warn' : undefined}
                foot={k.overdue_approvals > 0 ? `${k.overdue_approvals} past the agreed time` : 'all within time'}
                onClick={() => nav('/approvals')} />
            ) : null}
            {/* Was "To confirm with supplier", which described a phone call
                nobody makes any more. Approved orders are waiting to be SENT;
                the supplier does the confirming, on their own panel. */}
            {canConfirm ? (
              <Kpi label="To send to suppliers" value={flow.to_confirm ?? 0}
                tone={(flow.to_confirm ?? 0) > 0 ? 'warn' : 'good'}
                foot="approved, not yet on their panel"
                onClick={() => nav('/purchase-orders?status=APPROVED')} />
            ) : null}
            {seesAlerts ? (
              <Kpi label="Open alerts" value={k.open_alerts ?? 0}
                tone={(k.open_alerts ?? 0) > 0 ? 'crit' : 'good'}
                foot="high or critical" onClick={() => nav('/alerts')} />
            ) : null}
          </div>
        </>
      ) : null}

      {/* --- One section per job. -------------------------------------------
          Every role used to land on the same page and simply have the parts
          that were not theirs removed, which left a gate clerk with two tiles
          and a buyer with a payables figure they cannot act on. Each block
          below is the numbers that person can do something about today, and
          each tile links to the screen where they do it. */}

      {isBuyer ? (
        <>
          <div className="section-head"><h2>Your buying</h2><span className="rule" /></div>
          <div className="grid c5 mb">
            <Kpi label="Below reorder point" value={(data?.criticalStock ?? []).length}
              tone={(data?.criticalStock ?? []).length > 0 ? 'warn' : 'good'}
              foot="products to buy today" onClick={() => nav('/buy-list')} />
            <Kpi label="Open requirements" value={k.open_requirements ?? 0}
              foot="raised, not yet ordered" onClick={() => nav('/requirements')} />
            <Kpi label="Orders in progress" value={k.pending_pos ?? 0}
              foot="draft or waiting for approval" onClick={() => nav('/purchase-orders')} />
            {/* An order placed is not an order agreed. Until the supplier
                answers, the buyer is planning against a promise nobody made —
                and a decline is worth knowing today, not on delivery day. */}
            <Kpi label="Suppliers not answered"
              value={(k.po_unanswered ?? 0) + (k.po_declined ?? 0)}
              tone={(k.po_declined ?? 0) > 0 ? 'crit'
                : (k.po_unanswered ?? 0) > 0 ? 'warn' : 'good'}
              foot={(k.po_declined ?? 0) > 0
                ? `${k.po_declined} declined — buy elsewhere`
                : (k.po_unanswered ?? 0) > 0 ? 'waiting for their yes' : 'all confirmed both ways'}
              onClick={() => nav('/purchase-orders')} />
            <Kpi label="Bought today" value={inr(k.purchase_value_today, 0)}
              foot={`${inr(k.purchase_value_mtd, 0)} this month`} />
          </div>
        </>
      ) : null}

      {worksGate ? (
        <>
          <div className="section-head"><h2>Your gate</h2><span className="rule" /></div>
          <div className="grid c4 mb">
            <Kpi label="Arriving today" value={k.arrivals_today ?? 0}
              tone={(k.arrivals_today ?? 0) > 0 ? 'warn' : undefined}
              foot="expected vehicles" onClick={() => nav('/arrivals')} />
            <Kpi label="Waiting to be weighed" value={k.awaiting_weighment ?? 0}
              tone={(k.awaiting_weighment ?? 0) > 0 ? 'warn' : 'good'}
              foot="in the yard, not on the weighbridge" onClick={() => nav('/arrivals')} />
            <Kpi label="At the gate now" value={gateTotal}
              foot={`${k.awaiting_qc ?? 0} at QC · ${k.awaiting_grn ?? 0} to post`}
              onClick={() => nav('/arrivals')} />
          </div>
        </>
      ) : null}

      {worksStore ? (
        <>
          <div className="section-head"><h2>Your warehouse</h2><span className="rule" /></div>
          <div className="grid c4 mb">
            <Kpi label="To post as receipt" value={k.awaiting_grn ?? 0}
              tone={(k.awaiting_grn ?? 0) > 0 ? 'warn' : 'good'}
              foot="quality checked, not yet stock" onClick={() => nav('/arrivals')} />
            <Kpi label="Waiting to be packed" value={k.awaiting_putaway ?? 0}
              tone={(k.awaiting_putaway ?? 0) > 0 ? 'warn' : 'good'}
              foot="booked in, no boxes made yet" onClick={() => nav('/packing')} />
            <Kpi label="Posted today" value={k.receipts_today ?? 0}
              foot="receipts booked into stock" onClick={() => nav('/grns')} />
            <Kpi label="Expiring within 7 days" value={k.expiring_7d ?? 0}
              tone={(k.expiring_7d ?? 0) > 0 ? 'crit' : 'good'}
              foot="batches to move first" onClick={() => nav('/stock')} />
          </div>
        </>
      ) : null}

      {isFinance ? (
        <>
          <div className="section-head"><h2>Your desk</h2><span className="rule" /></div>
          <div className="grid c4 mb">
            {/* Leads with what is waiting on this person, not with the payables
                total — a number nobody can do anything about at 9am. */}
            <Kpi label="Waiting to be checked" value={k.money_to_verify ?? 0}
              tone={(k.money_to_verify ?? 0) > 0 ? 'warn' : 'good'}
              foot="requests for money" onClick={() => nav('/finance')} />
            <Kpi label="Verified, to pay" value={inr(k.money_to_pay_value, 0)}
              tone={Number(k.overdue_payable) > 0 ? 'crit' : 'good'}
              foot={`${k.money_to_pay ?? 0} request(s)`} onClick={() => nav('/finance')} />
            <Kpi label="Money to confirm" value={k.money_to_confirm ?? 0}
              tone={(k.money_to_confirm ?? 0) > 0 ? 'warn' : 'good'}
              foot="collected, not yet in the bank" onClick={() => nav('/finance')} />
            <Kpi label="Outstanding payable" value={inr(k.outstanding_payable, 0)}
              tone={Number(k.overdue_payable) > 0 ? 'warn' : undefined}
              foot={Number(k.overdue_payable) > 0
                ? `${inr(k.overdue_payable, 0)} overdue` : 'nothing overdue'}
              onClick={() => nav('/payments')} />
          </div>
        </>
      ) : null}

      {/* The inspector's own numbers. Without this a QC login saw a page about
          spend and payables and nothing at all about quality. */}
      {isQc ? (
        <>
          <div className="section-head"><h2>Quality, last 30 days</h2><span className="rule" /></div>
          <div className="grid c4 mb">
            <Kpi label="Waiting for you" value={k.awaiting_qc ?? 0}
              tone={(k.awaiting_qc ?? 0) > 0 ? 'warn' : 'good'}
              foot="vehicles to inspect" onClick={() => nav('/arrivals')} />
            <Kpi label="Inspections done" value={q.inspections_30d ?? 0}
              foot="in the last 30 days" />
            <Kpi label="Rejection rate" value={`${num(q.rejection_pct_30d, 1)}%`}
              tone={Number(q.rejection_pct_30d) > 8 ? 'crit'
                : Number(q.rejection_pct_30d) > 4 ? 'warn' : 'good'}
              foot="of everything you inspected" />
            <Kpi label="Average score" value={num(q.avg_quality_score_30d, 0)}
              foot="across all checklists" />
          </div>
        </>
      ) : null}

      {showMoney ? (
        <>
          <div className="section-head"><h2>Money</h2><span className="rule" /></div>
          <div className="grid c4 mb">
            <Kpi label="Purchased, 30 days" value={inr(spend30, 0)}
              delta={spendDelta} deltaLabel="vs previous 30"
              spark={<Spark data={trend} y="value" />} />
            <Kpi label="Purchased today" value={inr(k.purchase_value_today, 0)}
              foot={`${inr(k.purchase_value_mtd, 0)} this month`} />
            {/* Finance already has payables on their own desk above — showing it
                twice on one page makes the reader check whether the two agree. */}
            {!isFinance ? (
              <Kpi label="Outstanding payable" value={inr(k.outstanding_payable, 0)}
                tone={Number(k.overdue_payable) > 0 ? 'warn' : undefined}
                foot={Number(k.overdue_payable) > 0
                  ? `${inr(k.overdue_payable, 0)} overdue` : 'nothing overdue'}
                onClick={() => nav('/payments')} />
            ) : null}
            <Kpi label="Accepted on arrival"
              value={acceptPct == null ? '—' : `${num(acceptPct, 1)}%`}
              tone={Number(q.rejection_pct_30d) > 8 ? 'crit'
                : Number(q.rejection_pct_30d) > 4 ? 'warn' : 'good'}
              foot={`${num(q.rejection_pct_30d, 1)}% rejected · avg score ${num(q.avg_quality_score_30d, 0)}`} />
          </div>
        </>
      ) : null}

      {/* Trend charts, supplier mix and the buy list are a buyer's and an
          owner's view of the business. A gate clerk or an inspector has no
          decision to make with them. */}
      {seesReports || isBuyer ? (<>
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
              <FilterBar f={fLow} placeholder="Search product" />
              <FilterTotals f={fLow} noun="product" />
              <DataTable
                rows={fLow.rows}
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
      </>) : null}

    </Layout>
  );
}

export function AdminDashboardPage() {
  const nav = useNavigate();
  const { branchId, warehouseId, me, can } = useAuth();
  const dashboard = useApi<any>(`/insights/dashboard?branchId=${branchId ?? ''}`, [branchId]);
  const queue = useApi<any[]>('/insights/work-queue');
  const sales = useApi<any>('/inventory/sales-summary?days=1');
  const stockData = useApi<any[]>(`/insights/stock?warehouseId=${warehouseId ?? ''}`, [warehouseId]);

  if (dashboard.loading || sales.loading || queue.loading || stockData.loading) return <Layout title="Dashboard"><Loading /></Layout>;

  const k = dashboard.data?.kpis ?? {};
  const stock = dashboard.data?.criticalStock ?? [];
  const inventoryValue = (stockData.data ?? []).reduce((sum, item) => sum + Number(item.qty ?? 0) * Number(item.landed_rate ?? 0), 0);
  const tasks = queue.data ?? [];
  const operations = [
    { label: 'Incoming deliveries', total: Number(k.arrivals_today ?? 0), pending: Number(k.awaiting_weighment ?? 0) + Number(k.awaiting_qc ?? 0) + Number(k.awaiting_grn ?? 0), pendingLabel: 'in progress', to: '/arrivals' },
    { label: 'Purchase orders', total: Number(k.pending_pos ?? 0) + Number(k.pending_approvals ?? 0), pending: Number(k.pending_approvals ?? 0), pendingLabel: 'awaiting approval', to: '/purchase-orders' },
    { label: 'Sales', total: Number(sales.data?.totals?.sales ?? 0), pending: 0, pendingLabel: 'processing', to: '/sales' },
  ];
  const attention = [
    ...tasks.slice(0, 4).map((task: any) => ({
      severity: task.severity ?? (task.sla_breached ? 'HIGH' : 'NORMAL'),
      text: task.title,
      detail: [task.subtitle, task.doc_no].filter(Boolean).join(' · '),
      action: 'Review',
      to: (QUEUE_ROUTE[task.queue_key] ?? (() => '/my-work'))(task),
    })),
    ...(stock.length ? [{
      severity: stock.some((p: any) => Number(p.days_of_cover) < 1) ? 'CRITICAL' : 'HIGH',
      text: `${stock.length} product${stock.length === 1 ? '' : 's'} critically low`,
      detail: stock.slice(0, 2).map((p: any) => p.name).join(', '),
      action: 'View inventory', to: '/buy-list',
    }] : []),
  ].slice(0, 5);

  return (
    <Layout title="Admin dashboard" subtitle="What is happening right now">
      <ErrorBanner error={dashboard.error ?? sales.error} />
      <div className="hero">
        <div><h1>{greeting()}, {me?.fullName?.split(' ')[0] ?? 'Admin'}</h1><p>{date(new Date().toISOString())} · Today at a glance</p></div>
        <span className="spacer" />
        <button className="btn primary lg" onClick={() => nav('/analytics')}>View Analytics →</button>
      </div>

      <QuickActions can={can} nav={nav} />

      <div className="section-head"><h2>Needs Attention</h2><span className="rule" /></div>
      <div className="card mb"><div className="card-body tight">
        {attention.length ? attention.map((item, index) => (
          <div className="row" key={`${item.text}-${index}`} style={{ padding: '13px 0', borderBottom: index < attention.length - 1 ? '1px solid var(--line)' : undefined }}>
            <Chip value={item.severity} />
            <div style={{ flex: 1, minWidth: 0 }}><b>{item.text}</b><div className="small muted">{item.detail || 'Needs a decision today'}</div></div>
            <button className="btn sm primary" onClick={() => nav(item.to)}>{item.action}</button>
          </div>
        )) : <Empty icon="✅" title="Everything looks good" hint="Nothing needs your attention right now." />}
      </div></div>

      <div className="section-head"><h2>Today's Operations</h2><span className="rule" /></div>
      <div className="grid c3 mb">{operations.map((item) => <div className="card" key={item.label}>
        <div className="card-body"><div className="small muted">{item.label}</div><div className="value" style={{ fontSize: 28, fontWeight: 700 }}>{item.total}</div><div className="small">{item.pending} {item.pendingLabel}</div><button className="btn sm ghost mt" onClick={() => nav(item.to)}>View details →</button></div>
      </div>)}</div>

      <div className="section-head"><h2>Essential KPIs</h2><span className="rule" /></div>
      <div className="grid c4 mb">
        <Kpi label="Today's Sales" value={inr(sales.data?.totals?.revenue, 0)} foot={`${sales.data?.totals?.sales ?? 0} orders`} onClick={() => nav('/sales')} />
        <Kpi label="Today's Purchases" value={inr(k.purchase_value_today, 0)} foot={`${k.receipts_today ?? 0} receipts`} onClick={() => nav('/grns')} />
        <Kpi label="Pending Payments" value={inr(k.outstanding_payable, 0)} tone={Number(k.overdue_payable) > 0 ? 'crit' : Number(k.outstanding_payable) > 0 ? 'warn' : 'good'} foot={Number(k.overdue_payable) > 0 ? `${inr(k.overdue_payable, 0)} overdue` : 'outstanding balance'} onClick={() => nav('/payments')} />
        <Kpi label="Low Stock / Critical Items" value={stock.length} tone={stock.length ? 'warn' : 'good'} foot="items below reorder point" onClick={() => nav('/buy-list')} />
      </div>

      <div className="section-head"><h2>Business Snapshot</h2><span className="rule" /></div>
      <div className="card"><div className="card-body"><div className="grid c3">
        <div><div className="small muted">Revenue today</div><b>{inr(sales.data?.totals?.revenue, 0)}</b></div>
        <div><div className="small muted">Purchases today</div><b>{inr(k.purchase_value_today, 0)}</b></div>
        <div><div className="small muted">Inventory value</div><b>{inr(inventoryValue, 0)}</b></div>
      </div><button className="btn sm primary mt" onClick={() => nav('/analytics')}>View Analytics →</button></div></div>
    </Layout>
  );
}

function QuickActions({ can, nav }: { can: (...permissions: string[]) => boolean; nav: (to: string) => void }) {
  const actions = [
    { label: 'Order in one flow', icon: 'bolt', to: '/order-flow', perms: ['admin.override'] },
    { label: 'What to buy', icon: 'calculator', to: '/buy-list', perms: ['purchase.requirement.create'] },
    { label: 'Requirements', icon: 'clipboard', to: '/requirements', perms: ['purchase.requirement.create'] },
    { label: 'Purchase orders', icon: 'box', to: '/purchase-orders', perms: ['purchase.po.create', 'purchase.po.approve'] },
    { label: 'Receiving', icon: 'truckIn', to: '/arrivals', perms: ['receiving.gate.create'] },
    { label: 'Inventory', icon: 'crates', to: '/stock', perms: ['receiving.grn.create', 'inventory.pack.grade', 'inventory.stock.issue', 'reports.purchase.view'] },
  ].filter((action) => can(...action.perms));

  if (!actions.length) return null;

  return (
    <div className="quick-actions mb">
      <div className="section-head"><h2>Quick actions</h2><span className="rule" /></div>
      <div className="btn-row">
        {actions.map((action) => (
          <button key={action.to} className={`btn ${action.to === '/order-flow' ? 'primary' : ''}`}
            onClick={() => nav(action.to)}>
            <Icon name={action.icon} size={16} /> {action.label}
          </button>
        ))}
      </div>
    </div>
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
  /* Counts requirements raised, so it says requirements and goes to them.
   * Labelled "To buy" and pointed at the buy list, it invited the same
   * complaint as the low-stock panel: a 10 here, a 1 on the page it opened.
   * The buy list is reached from "Below reorder point" and from Running low. */
  { key: 'need',       label: 'Requirements', icon: 'clipboard', to: '/requirements' },
  { key: 'approve',    label: 'Approve',     icon: 'checkDoc',   to: '/approvals', hot: 1 },
  { key: 'to_confirm', label: 'Send',        icon: 'box',        to: '/purchase-orders', hot: 1 },
  { key: 'in_transit', label: 'On the road', icon: 'route',      to: '/dispatch' },
  { key: 'at_gate',    label: 'At the gate', icon: 'gate',       to: '/arrivals', hot: 1 },
  { key: 'in_qc',      label: 'Quality',     icon: 'scale',      to: '/arrivals', hot: 1 },
  { key: 'to_book',    label: 'Book in',     icon: 'inbox',      to: '/arrivals', hot: 1 },
  { key: 'to_putaway', label: 'To pack',     icon: 'shelf',      to: '/packing', hot: 1 },
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
