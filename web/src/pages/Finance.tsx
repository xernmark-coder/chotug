import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, useAuth, inr, num, date, dateTime, ago, today, addDays } from '../lib/api';
import {
  AiBox, Chip, DataTable, Empty, ErrorBanner, Field, Layout, Loading, Modal, useApi, useToast,
} from '../components/ui';

/* ====================================================== INVOICES ======== */
export function InvoiceListPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [status, setStatus] = useState('');
  const { data, loading, error } = useApi<any[]>(`/costing/invoices?status=${status}`, [status]);

  return (
    <Layout title="Supplier invoices" subtitle="Captured, matched against receipts, then payable"
      actions={can('finance.invoice.create')
        ? <button className="btn primary" onClick={() => nav('/invoices/new')}>Capture invoice</button>
        : undefined}>
      <ErrorBanner error={error} />
      <div className="search-bar">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {['PENDING', 'MATCHED', 'MISMATCH', 'HOLD', 'PAYABLE', 'PART_PAID', 'PAID'].map((s) =>
            <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
        </select>
      </div>
      <div className="card"><div className="card-body tight">
        <DataTable
          rows={data ?? []} loading={loading}
          onRowClick={(i: any) => nav(`/invoices/${i.id}`)}
          rowTone={(i: any) => (i.duplicate_of_id || i.status === 'HOLD' ? 'crit'
            : i.status === 'MISMATCH' ? 'warn' : undefined)}
          cols={[
            { key: 'n', head: 'Invoice', render: (i: any) => (
              <div><b className="mono">{i.invoice_no}</b>
                {i.duplicate_of_id ? <div><Chip tone="danger">possible duplicate</Chip></div> : null}</div>
            ) },
            { key: 'd', head: 'Date', render: (i: any) => date(i.invoice_date) },
            { key: 's', head: 'Supplier', render: (i: any) => i.supplier_name },
            { key: 'po', head: 'Order', render: (i: any) => <span className="mono small">{i.po_no ?? '—'}</span> },
            { key: 't', head: 'Total', num: true, render: (i: any) => inr(i.total) },
            { key: 'm', head: 'Match', render: (i: any) =>
              i.match_result ? <Chip value={i.match_result} /> : <span className="muted small">not run</span> },
            { key: 'b', head: 'Balance', num: true, render: (i: any) =>
              i.balance != null ? inr(i.balance) : '—' },
            { key: 'st', head: 'Status', render: (i: any) => <Chip value={i.status} /> },
          ]}
          empty={<Empty icon="🧾" title="No invoices captured yet" />}
        />
      </div></div>
    </Layout>
  );
}

export function InvoiceCreatePage() {
  const nav = useNavigate();
  const toast = useToast();
  const { branchId } = useAuth();
  const { data: suppliers } = useApi<any[]>('/masters/suppliers');
  const [form, setForm] = useState<any>({
    supplierId: '', invoiceNo: '', invoiceDate: today(), dueDate: addDays(15), isRcm: false,
  });
  const [lines, setLines] = useState<any[]>([{ rawDescription: '', qty: 0, rate: 0, amount: 0 }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  const subtotal = lines.reduce((a, l) => a + Number(l.amount || 0), 0);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const inv = await api.post<any>('/costing/invoices', {
        branchId, supplierId: form.supplierId, invoiceNo: form.invoiceNo,
        invoiceDate: form.invoiceDate, dueDate: form.dueDate || null, isRcm: form.isRcm,
        subtotal, total: subtotal,
        lines: lines.filter((l) => l.qty > 0).map((l) => ({
          rawDescription: l.rawDescription, qty: Number(l.qty), rate: Number(l.rate),
          amount: Number(l.amount),
        })),
      });
      if (inv.possibleDuplicate) {
        toast(`Warning: looks like a duplicate of ${inv.possibleDuplicate.invoice_no}`, 'err');
      } else {
        toast(`Invoice ${inv.invoice_no} captured`, 'ok');
      }
      nav(`/invoices/${inv.id}`);
    } catch (e: any) { setError(e); } finally { setBusy(false); }
  };

  return (
    <Layout title="Capture supplier invoice" subtitle="Then match it against what actually arrived">
      <ErrorBanner error={error} />
      <div className="card mb">
        <div className="card-head"><h2>Invoice header</h2></div>
        <div className="card-body">
          <div className="grid c4">
            <Field label="Supplier">
              <select value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}>
                <option value="">Choose…</option>
                {(suppliers ?? []).map((s) => (
                  <option key={s.id} value={s.id}>{s.trade_name ?? s.legal_name}</option>
                ))}
              </select>
            </Field>
            <Field label="Invoice number">
              <input value={form.invoiceNo} onChange={(e) => setForm({ ...form, invoiceNo: e.target.value })} />
            </Field>
            <Field label="Invoice date">
              <input type="date" value={form.invoiceDate}
                onChange={(e) => setForm({ ...form, invoiceDate: e.target.value })} />
            </Field>
            <Field label="Due date">
              <input type="date" value={form.dueDate}
                onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
            </Field>
          </div>
          <label className="check">
            <input type="checkbox" checked={form.isRcm}
              onChange={(e) => setForm({ ...form, isRcm: e.target.checked })} />
            Reverse charge (unregistered supplier)
          </label>
        </div>
      </div>

      <div className="card mb">
        <div className="card-head">
          <h2>Lines as printed on the invoice</h2>
          <button className="btn sm" onClick={() => setLines((s) => [...s, { rawDescription: '', qty: 0, rate: 0, amount: 0 }])}>
            Add line
          </button>
        </div>
        <div className="card-body tight">
          <div className="table-wrap">
            <table className="data">
              <thead><tr>
                <th>Description</th><th className="num">Quantity</th><th className="num">Rate</th>
                <th className="num">Amount</th><th></th>
              </tr></thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td><input className="inline" value={l.rawDescription}
                      onChange={(e) => setLines((s) => s.map((x, j) => j === i ? { ...x, rawDescription: e.target.value } : x))} /></td>
                    <td className="num"><input className="inline num" style={{ width: 82 }} type="number" value={l.qty || ''}
                      onChange={(e) => {
                        const qty = Number(e.target.value);
                        setLines((s) => s.map((x, j) => j === i ? { ...x, qty, amount: qty * Number(x.rate || 0) } : x));
                      }} /></td>
                    <td className="num"><input className="inline num" style={{ width: 82 }} type="number" value={l.rate || ''}
                      onChange={(e) => {
                        const rate = Number(e.target.value);
                        setLines((s) => s.map((x, j) => j === i ? { ...x, rate, amount: rate * Number(x.qty || 0) } : x));
                      }} /></td>
                    <td className="num"><input className="inline num" style={{ width: 96 }} type="number" value={l.amount || ''}
                      onChange={(e) => setLines((s) => s.map((x, j) => j === i ? { ...x, amount: Number(e.target.value) } : x))} /></td>
                    <td><button className="btn sm ghost" onClick={() => setLines((s) => s.filter((_, j) => j !== i))}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="row">
        <div><div className="small muted">Invoice total</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{inr(subtotal)}</div></div>
        <div className="spacer" />
        <button className="btn primary lg" disabled={busy || !form.supplierId || !form.invoiceNo || subtotal <= 0}
          onClick={save}>{busy ? 'Saving…' : 'Capture invoice'}</button>
      </div>
    </Layout>
  );
}

export function InvoiceDetailPage() {
  const { id } = useParams();
  const toast = useToast();
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<any>(`/costing/invoices/${id}`, [id]);
  const { data: candidates } = useApi<any[]>(`/costing/invoices/${id}/candidates`, [id]);
  const [busy, setBusy] = useState(false);

  if (loading) return <Layout title="Invoice"><Loading /></Layout>;
  if (!data) return <Layout title="Invoice"><ErrorBanner error={error} /></Layout>;

  const latest = data.matchResults?.[0];

  const runMatch = async () => {
    setBusy(true);
    try {
      const r = await api.post<any>(`/costing/invoices/${id}/match`);
      toast(r.overall === 'MATCH'
        ? 'Matched — invoice moved to payable'
        : `${r.overall.replace(/_/g, ' ').toLowerCase()} — ${r.findings.length} issue(s) found`,
        r.overall === 'MATCH' ? 'ok' : 'err');
      reload();
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const linkLine = async (lineId: string, grnLineId: string) => {
    toast('Link the line, then run the match again', 'info');
  };

  return (
    <Layout title={`Invoice ${data.invoice_no}`}
      subtitle={`${data.supplier_name} · ${date(data.invoice_date)} · ${inr(data.total)}`}
      actions={
        <div className="btn-row">
          <Chip value={data.status} />
          {can('finance.invoice.match') && !['PAID', 'CANCELLED'].includes(data.status) ? (
            <button className="btn primary" disabled={busy} onClick={runMatch}>
              {busy ? 'Matching…' : 'Run 3-way match'}
            </button>
          ) : null}
        </div>
      }>
      <ErrorBanner error={error} />
      {data.duplicate_of_id ? (
        <div className="banner danger mb"><span>⚠</span>
          <div><b>This looks like a duplicate invoice.</b> Verify with the supplier before paying.</div></div>
      ) : null}
      {data.ocr_arithmetic_ok === false ? (
        <div className="banner warn mb"><span>🧮</span>
          <div>The line amounts on this invoice do not add up to the stated subtotal.</div></div>
      ) : null}

      <div className="grid sidebar-right">
        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>Invoice lines vs what we received</h2></div>
            <div className="card-body tight">
              <DataTable
                rows={data.lines ?? []}
                rowTone={(l: any) => (!l.matched_grn_line_id ? 'crit' : undefined)}
                cols={[
                  { key: 'd', head: 'Description', render: (l: any) => l.product_name ?? l.raw_description },
                  { key: 'q', head: 'Billed qty', num: true, render: (l: any) => num(l.qty, 2) },
                  { key: 'g', head: 'Received qty', num: true, render: (l: any) =>
                    l.grn_qty != null ? num(l.grn_qty, 2)
                      : <Chip tone="danger">no receipt</Chip> },
                  { key: 'r', head: 'Billed rate', num: true, render: (l: any) => inr(l.rate) },
                  { key: 'pr', head: 'PO rate', num: true, render: (l: any) =>
                    l.po_rate != null ? inr(l.po_rate) : '—' },
                  { key: 'a', head: 'Amount', num: true, render: (l: any) => inr(l.amount) },
                ]}
              />
            </div>
          </div>

          {latest ? (
            <div className="card">
              <div className="card-head">
                <h2>Match result</h2>
                <Chip value={latest.overall} />
              </div>
              <div className="card-body">
                <div className="grid c4 mb">
                  {(['qty_result', 'rate_result', 'tax_result', 'charge_result'] as const).map((k) => (
                    <div key={k}>
                      <div className="small muted">{k.replace('_result', '').toUpperCase()}</div>
                      <Chip tone={latest[k] === 'OK' ? 'ok' : latest[k] === 'WARN' ? 'warn' : 'danger'}>
                        {latest[k]}
                      </Chip>
                    </div>
                  ))}
                </div>
                {(latest.findings ?? []).length ? (
                  <DataTable
                    rows={latest.findings}
                    cols={[
                      { key: 'l', head: 'Line', render: (f: any) => f.lineNo || '—' },
                      { key: 'f', head: 'Field', render: (f: any) => f.field },
                      { key: 's', head: 'Severity', render: (f: any) =>
                        <Chip tone={f.severity === 'FAIL' ? 'danger' : 'warn'}>{f.severity}</Chip> },
                      { key: 'm', head: 'What is wrong', render: (f: any) => f.message },
                      { key: 'e', head: 'Expected', num: true, render: (f: any) => f.expected ?? '—' },
                      { key: 'a', head: 'On invoice', num: true, render: (f: any) => f.actual },
                    ]}
                  />
                ) : <div className="banner ok"><span>✓</span><div>Everything matched within tolerance.</div></div>}
              </div>
            </div>
          ) : null}

          {data.notes?.length ? (
            <div className="card">
              <div className="card-head"><h2>Credit / debit notes</h2></div>
              <div className="card-body tight">
                <DataTable rows={data.notes} cols={[
                  { key: 'n', head: 'Number', render: (n: any) => <span className="mono">{n.note_no}</span> },
                  { key: 't', head: 'Type', render: (n: any) => <Chip tone={n.note_type === 'DEBIT' ? 'warn' : 'primary'}>{n.note_type}</Chip> },
                  { key: 'r', head: 'Reason', render: (n: any) => n.reason_code.replace(/_/g, ' ') },
                  { key: 'a', head: 'Amount', num: true, render: (n: any) => inr(n.total) },
                  { key: 's', head: 'Status', render: (n: any) => <Chip value={n.status} /> },
                  { key: 'auto', head: '', render: (n: any) => n.auto_drafted ? <Chip tone="primary">auto-drafted</Chip> : null },
                ]} />
              </div>
            </div>
          ) : null}
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>Summary</h2></div>
            <div className="card-body">
              <dl className="kv">
                <dt>Supplier</dt><dd>{data.supplier_name}</dd>
                <dt>Order</dt><dd className="mono">{data.po_no ?? '—'}</dd>
                <dt>Subtotal</dt><dd>{inr(data.subtotal)}</dd>
                <dt>Tax</dt><dd>{inr(data.tax_amount)}</dd>
                <dt style={{ fontWeight: 600 }}>Total</dt>
                <dd style={{ fontSize: 17, fontWeight: 700 }}>{inr(data.total)}</dd>
                <dt>Due</dt><dd>{date(data.due_date)}</dd>
                {data.is_rcm ? <><dt>RCM</dt><dd>Yes</dd></> : null}
              </dl>
            </div>
          </div>
          {data.payment ? (
            <div className="card">
              <div className="card-head"><h2>Payment</h2></div>
              <div className="card-body">
                <dl className="kv">
                  <dt>Payable</dt><dd>{inr(data.payment.payable_amount)}</dd>
                  <dt>Paid</dt><dd>{inr(data.payment.paid_amount)}</dd>
                  <dt>Balance</dt><dd><b>{inr(data.payment.balance)}</b></dd>
                  <dt>Overdue by</dt><dd>{data.payment.overdue_days ?? 0} days</dd>
                </dl>
                <p className="small muted">
                  Payment is made in Finance. This module only shows the status.
                </p>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </Layout>
  );
}

/* ====================================================== PAYMENTS ======== */
export function PaymentsPage() {
  const nav = useNavigate();
  const [filter, setFilter] = useState('');
  const { data, loading, error } = useApi<any[]>(`/costing/payments?filter=${filter}`, [filter]);

  return (
    <Layout title="Payment status" subtitle="Read-only — payments are made in Finance">
      <ErrorBanner error={error} />
      <div className="search-bar">
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">Everything</option>
          <option value="OPEN">Balance outstanding</option>
          <option value="OVERDUE">Overdue only</option>
        </select>
      </div>
      <div className="card"><div className="card-body tight">
        <DataTable
          rows={data ?? []} loading={loading}
          onRowClick={(p: any) => nav(`/invoices/${p.invoice_id}`)}
          rowTone={(p: any) => (Number(p.overdue_days) > 7 ? 'crit' : Number(p.overdue_days) > 0 ? 'warn' : undefined)}
          cols={[
            { key: 'i', head: 'Invoice', render: (p: any) => <b className="mono">{p.invoice_no}</b> },
            { key: 's', head: 'Supplier', render: (p: any) => p.supplier_name },
            { key: 'd', head: 'Invoice date', render: (p: any) => date(p.invoice_date) },
            { key: 'due', head: 'Due', render: (p: any) => date(p.due_date) },
            { key: 'p', head: 'Payable', num: true, render: (p: any) => inr(p.payable_amount) },
            { key: 'pd', head: 'Paid', num: true, render: (p: any) => inr(p.paid_amount) },
            { key: 'b', head: 'Balance', num: true, render: (p: any) => <b>{inr(p.balance)}</b> },
            { key: 'o', head: 'Overdue', num: true, render: (p: any) =>
              Number(p.overdue_days) > 0 ? <Chip tone="danger">{p.overdue_days}d</Chip> : '—' },
            { key: 'bl', head: '', render: (p: any) => p.is_blocked ? <Chip tone="danger">blocked</Chip> : null },
          ]}
          empty={<Empty icon="💳" title="Nothing payable" />}
        />
      </div></div>
    </Layout>
  );
}

/* ===================================================== SUPPLIERS ======== */
export function SuppliersPage() {
  const toast = useToast();
  const { data, loading, error, reload } = useApi<any[]>('/insights/supplier-performance');
  const [busy, setBusy] = useState(false);

  const recompute = async () => {
    setBusy(true);
    try {
      const r = await api.post<any>('/insights/supplier-performance/recompute');
      toast(`Scores recomputed for ${r.updated} supplier(s)`, 'ok');
      reload();
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <Layout title="Suppliers" subtitle="Scored on delivery, quality and honesty of weight"
      actions={<button className="btn primary" disabled={busy} onClick={recompute}>
        {busy ? 'Computing…' : 'Recompute scores'}</button>}>
      <ErrorBanner error={error} />
      <div className="banner info mb">
        <span>📐</span>
        <div>
          Performance blends on-time delivery, fill rate, rejection rate and quality score.
          Trust weighs weight variance and document compliance most heavily. A supplier with very
          few orders is pulled towards 50 so a single lucky delivery does not look like excellence.
        </div>
      </div>
      <div className="card"><div className="card-body tight">
        <DataTable
          rows={data ?? []} loading={loading}
          rowTone={(s: any) => (s.status === 'BLOCKED' ? 'crit'
            : s.status === 'ON_HOLD' || Number(s.rejection_pct) > 10 ? 'warn' : undefined)}
          cols={[
            { key: 'n', head: 'Supplier', render: (s: any) => (
              <div><b>{s.trade_name ?? s.legal_name}</b><div className="small muted">{s.code}</div></div>
            ) },
            { key: 't', head: 'Type', render: (s: any) => <Chip tone="neutral">{s.source_type}</Chip> },
            { key: 'st', head: 'Status', render: (s: any) => <Chip value={s.status} /> },
            { key: 'p', head: 'Performance', num: true, render: (s: any) =>
              s.performance_score == null ? '—'
                : <Chip tone={s.performance_score >= 75 ? 'ok' : s.performance_score >= 55 ? 'warn' : 'danger'}>
                    {num(s.performance_score, 0)}</Chip> },
            { key: 'tr', head: 'Trust', num: true, render: (s: any) =>
              s.trust_score == null ? '—'
                : <Chip tone={s.trust_score >= 75 ? 'ok' : s.trust_score >= 55 ? 'warn' : 'danger'}>
                    {num(s.trust_score, 0)}</Chip> },
            { key: 'ot', head: 'On time', num: true, render: (s: any) =>
              s.on_time_pct != null ? `${num(s.on_time_pct, 0)}%` : '—' },
            { key: 'rj', head: 'Rejection', num: true, render: (s: any) =>
              s.rejection_pct != null ? `${num(s.rejection_pct, 1)}%` : '—' },
            { key: 'wv', head: 'Weight var', num: true, render: (s: any) =>
              s.weight_variance_pct != null ? `${num(s.weight_variance_pct, 2)}%` : '—' },
            { key: 'r', head: 'Receipts 90d', num: true, render: (s: any) => s.receipts_90d },
            { key: 'v', head: 'Value 90d', num: true, render: (s: any) => inr(s.value_90d, 0) },
          ]}
          empty={<Empty icon="🤝" title="No suppliers yet" />}
        />
      </div></div>
    </Layout>
  );
}

/* ======================================================== ALERTS ======== */
export function AlertsPage() {
  const toast = useToast();
  const [status, setStatus] = useState('OPEN');
  const { data, loading, error, reload } = useApi<any[]>(`/insights/alerts?status=${status}`, [status]);

  const act = async (id: string, action: string) => {
    try {
      await api.post(`/insights/alerts/${id}/ack`, { action });
      toast(action === 'RESOLVE' ? 'Marked resolved' : 'Acknowledged', 'ok');
      reload();
    } catch (e: any) { toast(e.message, 'err'); }
  };

  return (
    <Layout title="Alerts" subtitle="Things the system noticed that need a person">
      <ErrorBanner error={error} />
      <div className="search-bar">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {['OPEN', 'ACK', 'RESOLVED'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div className="card"><div className="card-body tight">
        <DataTable
          rows={data ?? []} loading={loading}
          rowTone={(a: any) => (a.severity === 'CRITICAL' ? 'crit' : a.severity === 'HIGH' ? 'warn' : undefined)}
          cols={[
            { key: 's', head: 'Severity', width: 100, render: (a: any) => <Chip value={a.severity} /> },
            { key: 't', head: 'Alert', render: (a: any) => (
              <div><b>{a.title}</b><div className="small muted">{a.message}</div></div>
            ) },
            { key: 'ty', head: 'Type', render: (a: any) => <span className="small muted">{a.alert_type.replace(/_/g, ' ')}</span> },
            { key: 'w', head: 'When', render: (a: any) => <span className="small">{ago(a.created_at)}</span> },
            { key: 'st', head: 'Status', render: (a: any) => <Chip value={a.status} /> },
            { key: 'a', head: '', width: 190, render: (a: any) => a.status === 'OPEN' ? (
              <div className="btn-row" onClick={(e) => e.stopPropagation()}>
                <button className="btn sm" onClick={() => act(a.id, 'ACK')}>Acknowledge</button>
                <button className="btn sm primary" onClick={() => act(a.id, 'RESOLVE')}>Resolve</button>
              </div>
            ) : null },
          ]}
          empty={<Empty icon="🔕" title="No alerts" hint="Nothing needs your attention." />}
        />
      </div></div>
    </Layout>
  );
}

/* ======================================================= REPORTS ======== */
const REPORTS = [
  { key: 'purchase-register', name: 'Purchase register', desc: 'Every line received, with rate and landed cost' },
  { key: 'quality-rejection', name: 'Quality & rejection', desc: 'What was rejected, why, and by whom' },
  { key: 'weight-variance', name: 'Weight variance', desc: 'Where the weighbridge disagreed with the order' },
  { key: 'landing-cost', name: 'Landed cost analysis', desc: 'True cost per kg and how it moved' },
  { key: 'pending-po', name: 'Pending purchase orders', desc: 'Ordered but not yet received' },
  { key: 'stock-position', name: 'Stock position', desc: 'On-hand by batch with expiry risk' },
  { key: 'ai-acceptance', name: 'AI acceptance', desc: 'How often people take the AI suggestion' },
];

export function ReportsPage() {
  const [key, setKey] = useState('purchase-register');
  const [from, setFrom] = useState(addDays(-30));
  const [to, setTo] = useState(today());
  const { data, loading, error } = useApi<any>(
    `/insights/reports/${key}?from=${from}&to=${to}`, [key, from, to]);
  const { can } = useAuth();

  const download = () => {
    if (!data?.rows?.length) return;
    const cols = Object.keys(data.rows[0]);
    const csv = [cols.join(','), ...data.rows.map((r: any) =>
      cols.map((c) => {
        const v = r[c];
        const s = v === null || v === undefined ? '' : String(v);
        return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${key}-${today()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const cols = data?.rows?.length ? Object.keys(data.rows[0]) : [];

  return (
    <Layout title="Reports" subtitle="Numbers you can take to a meeting"
      actions={can('data.export')
        ? <button className="btn primary" disabled={!data?.rows?.length} onClick={download}>Download CSV</button>
        : undefined}>
      <ErrorBanner error={error} />
      <div className="grid c4 mb">
        {REPORTS.map((r) => (
          <div key={r.key} className={`kpi ${key === r.key ? 'good' : ''}`}
            style={{ cursor: 'pointer' }} onClick={() => setKey(r.key)}>
            <div style={{ fontWeight: 600 }}>{r.name}</div>
            <div className="small muted">{r.desc}</div>
          </div>
        ))}
      </div>

      <div className="search-bar">
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <span className="spacer" />
        <span className="small muted">{data?.count ?? 0} rows</span>
      </div>

      <div className="card"><div className="card-body tight">
        {loading ? <Loading /> : !data?.rows?.length ? (
          <Empty icon="📈" title="No data for this period" />
        ) : (
          <div className="table-wrap" style={{ maxHeight: '65vh', overflowY: 'auto' }}>
            <table className="data">
              <thead><tr>{cols.map((c) => <th key={c}>{c.replace(/_/g, ' ')}</th>)}</tr></thead>
              <tbody>
                {data.rows.slice(0, 500).map((r: any, i: number) => (
                  <tr key={i}>{cols.map((c) => (
                    <td key={c} className={typeof r[c] === 'number' ? 'num mono' : ''}>
                      {r[c] === null || r[c] === undefined ? '—'
                        : Array.isArray(r[c]) ? r[c].join(', ')
                        : typeof r[c] === 'object' ? JSON.stringify(r[c])
                        : typeof r[c] === 'number' ? num(r[c], 2)
                        : String(r[c])}
                    </td>
                  ))}</tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div></div>
    </Layout>
  );
}

/* ====================================================== AI CENTRE ======= */
export function AiCentrePage() {
  const toast = useToast();
  const { can } = useAuth();
  const { data: features, reload } = useApi<any[]>('/insights/ai/features');
  const { data: runs, loading } = useApi<any[]>('/insights/ai/runs');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const ask = async () => {
    if (!question.trim()) return;
    setBusy(true);
    try {
      setAnswer(await api.post<any>('/insights/ai/assistant', { question }));
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const toggle = async (key: string, isEnabled: boolean) => {
    try {
      await api.put(`/insights/ai/features/${key}`, { isEnabled });
      reload();
    } catch (e: any) { toast(e.message, 'err'); }
  };

  const FEATURE_NAMES: Record<string, string> = {
    F1_DEMAND_FORECAST: 'Demand forecast — how much will sell',
    F2_BUY_SUGGESTION: 'Buy suggestion — how much to order',
    F4_PRICE_SIGNAL: 'Price signal — buy now or wait',
    F5_QC_ASSIST: 'Quality photo assist — pre-fill the checklist',
    F8_ANOMALY: 'Anomaly detection — unusual rates and weights',
    F9_ASSISTANT: 'Assistant — ask questions in plain language',
  };

  return (
    <Layout title="AI centre" subtitle="Every suggestion is advisory — a person always decides">
      <div className="grid sidebar-right">
        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>Ask about your purchases</h2></div>
            <div className="card-body">
              <div className="row mb">
                <input placeholder="e.g. Which suppliers are we waiting on today?"
                  value={question} onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && ask()} />
                <button className="btn primary" disabled={busy} onClick={ask}>
                  {busy ? 'Thinking…' : 'Ask'}
                </button>
              </div>
              {answer ? (
                <AiBox title="Answer" confidence={answer.confidence} usedFallback={answer.usedFallback}>
                  <p style={{ margin: 0 }}>{answer.answer}</p>
                </AiBox>
              ) : (
                <p className="small muted">
                  The assistant only sees data you are allowed to see. If your role cannot view
                  cost, it cannot tell you a cost.
                </p>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h2>Recent AI runs</h2></div>
            <div className="card-body tight">
              <DataTable
                rows={runs ?? []} loading={loading}
                rowTone={(r: any) => (r.accepted === false ? 'warn' : undefined)}
                cols={[
                  { key: 'f', head: 'Feature', render: (r: any) => (
                    <span className="small">{FEATURE_NAMES[r.feature_key]?.split('—')[0] ?? r.feature_key}</span>
                  ) },
                  { key: 'm', head: 'Model', render: (r: any) => <span className="small mono">{r.model_name}</span> },
                  { key: 'c', head: 'Confidence', num: true, render: (r: any) =>
                    r.confidence != null ? `${Math.round(r.confidence * 100)}%` : '—' },
                  { key: 'a', head: 'Person', render: (r: any) =>
                    r.accepted === true ? <Chip tone="ok">accepted</Chip>
                      : r.accepted === false ? <Chip tone="warn">overridden</Chip>
                      : <span className="muted small">not yet</span> },
                  { key: 'fb', head: '', render: (r: any) =>
                    r.used_fallback ? <Chip tone="neutral">statistics only</Chip> : null },
                  { key: 'l', head: 'Time', num: true, render: (r: any) => `${r.latency_ms ?? 0} ms` },
                  { key: 'w', head: 'When', render: (r: any) => <span className="small muted">{ago(r.created_at)}</span> },
                ]}
                empty={<Empty icon="✨" title="No AI runs yet" />}
              />
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h2>Features</h2></div>
          <div className="card-body stack">
            {(features ?? []).map((f) => (
              <div key={f.feature_key}>
                <label className="check">
                  <input type="checkbox" checked={f.is_enabled}
                    disabled={!can('ai.feature.manage')}
                    onChange={(e) => toggle(f.feature_key, e.target.checked)} />
                  <span>
                    <b className="small">{FEATURE_NAMES[f.feature_key] ?? f.feature_key}</b>
                    <div className="small muted">
                      falls back to {String(f.fallback_mode).toLowerCase()} ·
                      needs {Math.round(Number(f.min_confidence) * 100)}% confidence
                    </div>
                  </span>
                </label>
              </div>
            ))}
            <div className="banner info small">
              <span>ℹ</span>
              <div>
                With no model configured, forecasting and buy suggestions still work from your own
                sales history. Only the written explanations disappear.
              </div>
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}

/* ====================================================== SETTINGS ======== */
export function SettingsPage() {
  const toast = useToast();
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<any[]>('/masters/settings');
  const [edits, setEdits] = useState<Record<string, string>>({});

  const LABELS: Record<string, string> = {
    'purchase.weight_tolerance_pct': 'Weight tolerance (%) before a variance is flagged',
    'purchase.rate_tolerance_pct': 'Rate tolerance (%) before approval is needed',
    'purchase.qty_tolerance_pct': 'Quantity tolerance (%)',
    'purchase.fy': 'Financial year for document numbering',
    'planning.forecast_horizon_days': 'Forecast horizon (days)',
    'planning.service_level_z': 'Service level factor (1.65 ≈ 95% availability)',
    'ai.auto_purchase_enabled': 'Allow AI to place orders automatically',
    'costing.abnormal_jump_pct': 'Landed cost jump (%) that raises an alert',
  };

  const save = async (key: string) => {
    try {
      const raw = edits[key];
      const value = raw === 'true' ? true : raw === 'false' ? false
        : isNaN(Number(raw)) ? raw : Number(raw);
      await api.put(`/masters/settings/${key}`, { value });
      toast('Saved', 'ok');
      setEdits((s) => { const n = { ...s }; delete n[key]; return n; });
      reload();
    } catch (e: any) { toast(e.message, 'err'); }
  };

  return (
    <Layout title="Settings" subtitle="Thresholds that change how the system behaves">
      <ErrorBanner error={error} />
      {loading ? <Loading /> : (
        <div className="card"><div className="card-body">
          {(data ?? []).map((s) => (
            <div className="field" key={s.key}>
              <label>{LABELS[s.key] ?? s.key}</label>
              <div className="prefill">
                <input value={edits[s.key] ?? String(s.value)}
                  disabled={!can('admin.settings.manage')}
                  onChange={(e) => setEdits((x) => ({ ...x, [s.key]: e.target.value }))} />
                {edits[s.key] !== undefined ? (
                  <button className="btn primary sm" onClick={() => save(s.key)}>Save</button>
                ) : null}
              </div>
              <div className="hint mono small">{s.key}</div>
            </div>
          ))}
        </div></div>
      )}
    </Layout>
  );
}

/* ======================================================= PROFILE ======== */
export function ProfilePage() {
  const { me } = useAuth();
  if (!me) return <Layout title="Profile"><Loading /></Layout>;
  return (
    <Layout title={me.fullName} subtitle={`${me.companyName} · ${me.email}`}>
      <div className="grid c2">
        <div className="card">
          <div className="card-head"><h2>Your access</h2></div>
          <div className="card-body">
            <dl className="kv">
              <dt>Roles</dt><dd>{me.roles.join(', ') || '—'}</dd>
              <dt>Employee code</dt><dd>{me.employeeCode ?? '—'}</dd>
              <dt>Branches</dt><dd>{me.branches.map((b) => b.name).join(', ')}</dd>
              <dt>PO approval limit</dt>
              <dd>{me.limits.maxPoValue ? inr(me.limits.maxPoValue, 0) : 'no limit set'}</dd>
              <dt>Approval level</dt><dd>Level {me.limits.maxApprovalLevel}</dd>
              <dt>Back-dating</dt><dd>{me.limits.maxBackdateDays} day(s)</dd>
            </dl>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2>Permissions</h2></div>
          <div className="card-body">
            <div className="row wrap" style={{ gap: 5 }}>
              {me.permissions.map((p) => <Chip key={p} tone="neutral">{p}</Chip>)}
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}
