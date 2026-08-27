import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, useAuth, inr, num, date, dateTime, ago, today, addDays } from '../lib/api';
import {
  AiBox, Chip, DataTable, Empty, ErrorBanner, Field, Kpi, Layout, Loading, Modal, useApi, useToast,
  FilterBar, FilterTotals, useFilters,
} from '../components/ui';
import { Icon } from '../components/icons';
import { EmailSettingsCard } from './People';

/* ====================================================== INVOICES ======== */
export function InvoiceListPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { data, loading, error } = useApi<any[]>('/costing/invoices');

  const f = useFilters<any>(data, {
    date: (i) => i.invoice_date,
    search: (i) => [i.invoice_no, i.supplier_name, i.po_no].filter(Boolean).join(' '),
    facets: [
      { key: 'status', label: 'status', of: (i) => i.status },
      { key: 'supplier', label: 'supplier', of: (i) => i.supplier_name },
    ],
    totals: [
      { label: 'Billed', of: (i) => Number(i.total), money: true },
      { label: 'Still owed', of: (i) => Number(i.balance ?? 0), money: true },
    ],
  });

  return (
    <Layout title="Supplier invoices" subtitle="What arrived, what is owed, and what needs action"
      actions={can('finance.invoice.create')
        ? <button className="btn primary" onClick={() => nav('/invoices/new')}>Capture invoice</button>
        : undefined}>
      <ErrorBanner error={error} />
      <FilterBar f={f} placeholder="Search invoice number or supplier" />
      <FilterTotals f={f} noun="invoice" />
      <div className="card"><div className="card-body tight">
        <DataTable
          rows={f.rows} loading={loading}
          onRowClick={(i: any) => nav(`/invoices/${i.id}`)}
          rowTone={(i: any) => (i.duplicate_of_id || i.status === 'HOLD' || i.receipt_attention ? 'crit'
            : i.status === 'MISMATCH' || i.receipt_status === 'PARTIAL' ? 'warn' : undefined)}
          cols={[
            { key: 'n', head: 'Invoice', render: (i: any) => (
              <div><b className="mono">{i.invoice_no}</b>
                {i.duplicate_of_id ? <div><Chip tone="danger">possible duplicate</Chip></div> : null}</div>
            ) },
            { key: 'd', head: 'Date', render: (i: any) => date(i.invoice_date) },
            { key: 's', head: 'Supplier', render: (i: any) => i.supplier_name },
            { key: 'po', head: 'Order', render: (i: any) => <span className="mono small">{i.po_no ?? '—'}</span> },
            { key: 'received', head: 'Goods received', render: (i: any) => (
              i.receipt_status === 'RECEIVED' ? <Chip tone="ok">received</Chip> :
              i.receipt_status === 'PARTIAL' ? <Chip tone="warn">partial</Chip> :
              <Chip tone={i.receipt_attention ? 'danger' : 'neutral'}>
                {i.receipt_attention ? 'overdue — not received' : 'not received'}
              </Chip>
            ) },
            { key: 't', head: 'Total', num: true, render: (i: any) => inr(i.total) },
            { key: 'm', head: 'Reconciliation', render: (i: any) =>
              i.match_result && i.match_result !== 'MATCH' ? <Chip value={i.match_result} />
                : <span className="muted small">updated from receipt</span> },
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
                    <td><button className="btn sm ghost" onClick={() => setLines((s) => s.filter((_, j) => j !== i))}><Icon name="alert" size={15} /></button></td>
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

  /* The comparison now runs by itself when the invoice is filed. This is here
     for the case that matters: the bill arrived before the lorry, so there was
     nothing to compare it with, and now there is. */
  const recheck = async () => {
    setBusy(true);
    try {
      const r = await api.post<any>(`/costing/invoices/${id}/match`);
      const n = (r.findings ?? []).length;
      toast(n ? `${n} thing(s) do not agree — see below` : 'This bill agrees with what we received',
        n ? 'err' : 'ok');
      reload();
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <Layout title={`Invoice ${data.invoice_no}`}
      subtitle={`${data.supplier_name} · ${date(data.invoice_date)} · ${inr(data.total)}`}
      actions={
        <div className="btn-row">
          <Chip value={data.status} />
          {can('finance.invoice.match') && !['PAID', 'CANCELLED'].includes(data.status) ? (
            <button className="btn" disabled={busy} onClick={recheck}>
              {busy ? 'Checking…' : 'Check against receipts'}
            </button>
          ) : null}
        </div>
      }>
      <ErrorBanner error={error} />
      {data.receipt_status !== 'RECEIVED' ? (
        <div className={`banner ${data.receipt_attention ? 'danger' : 'warn'} mb`}>
          <span><Icon name={data.receipt_attention ? 'alert' : 'clock'} size={16} /></span>
          <div>
            <b>{data.receipt_status === 'PARTIAL' ? 'Only part of this invoice has been received.' : 'No product from this invoice has been received yet.'}</b>{' '}
            {data.receipt_attention
              ? 'The due date has passed. Admin or Finance should follow up before taking further action.'
              : 'Finance can wait for the gate receipt; reconciliation will update automatically when the delivery is posted.'}
          </div>
        </div>
      ) : (
        <div className="banner ok mb"><span><Icon name="check" size={16} /></span>
          <div><b>Products received.</b> This invoice is now linked to the posted receipt.</div>
        </div>
      )}
      {data.duplicate_of_id ? (
        <div className="banner danger mb"><span><Icon name="alert" size={16} /></span>
          <div><b>This looks like a duplicate invoice.</b> Verify with the supplier before paying.</div></div>
      ) : null}
      {data.ocr_arithmetic_ok === false ? (
        <div className="banner warn mb"><span><Icon name="calculator" size={16} /></span>
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

          {/* Was "Match result", four chips reading QTY / RATE / TAX / CHARGE
              and a column headed "Severity". Nobody in a mandi office talks
              like that, and the whole card said nothing a person could act on.
              What they actually want to know is whether the bill agrees with
              what turned up, and if not, by how much. */}
          {latest ? (
            <div className="card">
              <div className="card-head">
                <h2>How this bill compares</h2>
                <span className="small muted">
                  checked {latest.run_at ? ago(latest.run_at) : 'just now'}
                </span>
              </div>
              <div className="card-body">
                {(latest.findings ?? []).length ? (
                  <>
                    <div className="banner warn mb">
                      <span><Icon name="alert" size={16} /></span>
                      <div>
                        <b>{latest.findings.length} thing(s) on this bill do not agree with
                        what we ordered or received.</b> It can still be paid — Finance
                        decides — but somebody should know.
                      </div>
                    </div>
                    <DataTable
                      rows={latest.findings}
                      cols={[
                        { key: 'l', head: 'Line', width: 56,
                          render: (f: any) => f.lineNo || '—' },
                        { key: 'm', head: 'What does not agree',
                          render: (f: any) => (
                            <div><b>{f.message}</b>
                              <div className="small muted">{String(f.field).replace(/_/g, ' ')}</div>
                            </div>) },
                        { key: 'e', head: 'Should be', num: true,
                          render: (f: any) => f.expected ?? '—' },
                        { key: 'a', head: 'Billed', num: true,
                          render: (f: any) => f.actual },
                      ]}
                    />
                  </>
                ) : (
                  <div className="banner ok"><span><Icon name="check" size={16} /></span>
                    <div>This bill agrees with what we ordered and what we received.</div></div>
                )}
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
  const [tab, setTab] = useState<'due' | 'notes'>('due');
  const { data, loading, error } = useApi<any[]>(`/costing/payments?filter=${filter}`, [filter]);

  const f = useFilters<any>(data, {
    date: (p: any) => p.invoice_date,
    search: (p: any) => [p.invoice_no, p.supplier_name].filter(Boolean).join(' '),
    facets: [
      { key: 'sup', label: 'supplier', of: (p: any) => p.supplier_name },
      { key: 'od', label: 'age', all: 'Any age', of: (p: any) =>
        Number(p.overdue_days) > 7 ? 'more than a week late'
          : Number(p.overdue_days) > 0 ? 'late' : 'in time' },
      { key: 'bl', label: 'block', all: 'Blocked or not', of: (p: any) => (p.is_blocked ? 'blocked' : 'clear') },
    ],
    totals: [
      { label: 'Payable', of: (p: any) => Number(p.payable_amount) || 0, money: true },
      { label: 'Paid', of: (p: any) => Number(p.paid_amount) || 0, money: true },
      { label: 'Still owed', of: (p: any) => Number(p.balance) || 0, money: true },
    ],
  });

  return (
    <Layout title="Payment status" subtitle="Read-only — payments are made in Finance">
      <ErrorBanner error={error} />
      <div className="tabs">
        <button className={`tab ${tab === 'due' ? 'active' : ''}`} onClick={() => setTab('due')}>
          What we owe
        </button>
        <button className={`tab ${tab === 'notes' ? 'active' : ''}`} onClick={() => setTab('notes')}>
          Credit &amp; debit notes
        </button>
      </div>
      {tab === 'notes' ? <NotesPanel /> : <>
      <FilterBar f={f} placeholder="Search invoice or supplier">
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">Everything</option>
          <option value="OPEN">Balance outstanding</option>
          <option value="OVERDUE">Overdue only</option>
        </select>
      </FilterBar>
      <FilterTotals f={f} noun="invoice" />
      <div className="card"><div className="card-body tight">
        <DataTable
          rows={f.rows} loading={loading}
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
          empty={<Empty icon="💳" title={f.active > 0
            ? 'No invoice matches those filters' : 'Nothing payable'} />}
        />
      </div></div>
    </>}
    </Layout>
  );
}

/* ===================================================== SUPPLIERS ======== */
export function SuppliersPage() {
  const toast = useToast();
  const { can } = useAuth();
  const [tab, setTab] = useState<'scores' | 'rates' | 'manage'>('scores');
  const asked = useApi<any[]>(
    can('purchase.rate.compare') ? '/planning/supplier-rates' : null, []);
  const { data, loading, error, reload } = useApi<any[]>('/insights/supplier-performance');
  const [busy, setBusy] = useState(false);
  const mayManage = can('master.supplier.manage');

  const f = useFilters<any>(data, {
    search: (x: any) => [x.trade_name, x.legal_name, x.code, x.source_type]
      .filter(Boolean).join(' '),
    facets: [
      { key: 'ty', label: 'type', of: (x: any) => x.source_type },
      { key: 'st', label: 'status', of: (x: any) => x.status },
      { key: 'rj', label: 'rejections', of: (x: any) =>
        (Number(x.rejection_pct) > 10 ? 'over 10%' : 'under 10%') },
    ],
    totals: [
      { label: 'Orders', of: (x: any) => Number(x.order_count) || 0 },
    ],
  });

  const recompute = async () => {
    setBusy(true);
    try {
      const r = await api.post<any>('/insights/supplier-performance/recompute');
      toast(`Scores recomputed for ${r.updated} supplier(s)`, 'ok');
      reload();
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <Layout title="Suppliers" subtitle="Who you buy from, and how well they deliver"
      actions={tab === 'scores'
        ? <button className="btn primary" disabled={busy} onClick={recompute}>
            {busy ? 'Computing…' : 'Recompute scores'}</button>
        : null}>
      <ErrorBanner error={error} />

      <div className="tabs">
        <button className={`tab ${tab === 'scores' ? 'active' : ''}`} onClick={() => setTab('scores')}>
          Performance
        </button>
        {can('purchase.rate.compare') ? (
          <button className={`tab ${tab === 'rates' ? 'active' : ''}`} onClick={() => setTab('rates')}>
            What they are asking ({(asked.data ?? []).length})
          </button>
        ) : null}
        {mayManage ? (
          <button className={`tab ${tab === 'manage' ? 'active' : ''}`} onClick={() => setTab('manage')}>
            Manage suppliers
          </button>
        ) : null}
      </div>

      {tab === 'rates' ? <AskingRates rows={asked.data ?? []} loading={asked.loading} /> :
       tab === 'manage' && mayManage ? <SupplierManager /> : <>
      <div className="banner info mb">
        <span><Icon name="scale" size={16} /></span>
        <div>
          Performance blends on-time delivery, fill rate, rejection rate and quality score.
          Trust weighs weight variance and document compliance most heavily. A supplier with very
          few orders is pulled towards 50 so a single lucky delivery does not look like excellence.
        </div>
      </div>
      <FilterBar f={f} placeholder="Search supplier or code" />
      <FilterTotals f={f} noun="supplier" />
      <div className="card"><div className="card-body tight">
        <DataTable
          rows={f.rows} loading={loading}
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
          empty={<Empty icon="🤝" title="No suppliers yet"
            action={mayManage
              ? <button className="btn primary" onClick={() => setTab('manage')}>Add a supplier</button>
              : undefined} />}
        />
      </div></div>
      </>}
    </Layout>
  );
}

/* ---------------------------------------------------------------------------
 *  Managing the list itself: add, edit, and take one out.
 *
 *  Suppliers used to be created only from People & Access, as a side effect of
 *  inviting somebody — so the master list could only grow, and a farmer who
 *  stopped selling stayed in every dropdown forever.
 * ------------------------------------------------------------------------ */
const SOURCE_TYPES = [
  { v: 'FARMER', label: 'Farmer — buying direct from the grower' },
  { v: 'AADHTI', label: 'Aadhti — commission agent at a mandi' },
  { v: 'MANDI', label: 'Mandi trader' },
  { v: 'WHOLESALER', label: 'Wholesaler' },
];

/* ---------------------------------------------------------------------------
 * WHAT EVERY SUPPLIER IS ASKING
 *
 * Posted by the suppliers themselves from their own panels, so this is their
 * word rather than a buyer's note of a phone call. Grouped by product, because
 * "who is cheapest on mango today" is the question, not "what is Sahyadri
 * charging for everything".
 * ------------------------------------------------------------------------ */
function AskingRates({ rows, loading }: { rows: any[]; loading: boolean }) {
  const f = useFilters<any>(rows, {
    date: (r: any) => r.quoted_at,
    search: (r: any) => [r.product_name, r.sku, r.supplier_name, r.note]
      .filter(Boolean).join(' '),
    facets: [
      { key: 'p', label: 'product', of: (r: any) => r.product_name },
      { key: 's', label: 'supplier', of: (r: any) => r.supplier_name },
      { key: 'st', label: 'freshness', all: 'Current and out of date', of: (r: any) =>
        (r.is_stale ? 'out of date' : 'current') },
      { key: 'mv', label: 'movement', all: 'Up and down', of: (r: any) =>
        r.change_pct == null ? null
          : Number(r.change_pct) > 0 ? 'dearer than last time'
          : Number(r.change_pct) < 0 ? 'cheaper than last time' : 'same as last time' },
    ],
    totals: [],
  });

  /* The cheapest live rate per product, so the badge means something. */
  const best = React.useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of f.rows) {
      if (r.is_stale) continue;
      const v = Number(r.quoted_rate);
      if (m[r.product_id] == null || v < m[r.product_id]) m[r.product_id] = v;
    }
    return m;
  }, [f.rows]);

  return (
    <>
      <div className="banner info mb">
        <span><Icon name="info" size={16} /></span>
        <div>
          Each supplier posts their own rate from their panel. Nothing here was typed
          by the office, so it is their price, not a note of a phone call. A rate past
          its valid-till is shown faded — it is history, not an offer.
        </div>
      </div>
      <FilterBar f={f} placeholder="Search product or supplier" />
      <FilterTotals f={f} noun="rate" />
      <div className="card"><div className="card-body tight">
        <DataTable
          rows={f.rows} loading={loading}
          rowTone={(r: any) => (r.is_stale ? 'warn' : undefined)}
          cols={[
            { key: 'p', head: 'Product', render: (r: any) => (
              <div className="row" style={{ gap: 8 }}>
                <Icon name={r.icon ?? 'produce'} size={17} />
                <div><b>{r.product_name}</b>
                  <div className="small muted">{r.sku}</div></div>
              </div>) },
            { key: 's', head: 'Supplier', render: (r: any) => (
              <div><b>{r.supplier_name}</b>
                <div className="small muted">{r.source_type}
                  {r.tracking_code ? ` · ${r.tracking_code}` : ''}</div></div>) },
            { key: 'r', head: 'Asking', num: true, render: (r: any) => (
              <div>
                <b>{inr(r.quoted_rate)}</b>
                {!r.is_stale && best[r.product_id] === Number(r.quoted_rate) ? (
                  <div><Chip tone="ok">cheapest</Chip></div>
                ) : null}
              </div>) },
            { key: 'lp', head: 'We last paid', num: true, render: (r: any) =>
              r.last_paid_rate != null
                ? <div>{inr(r.last_paid_rate)}
                    <div className="small muted">
                      {r.last_purchase_at ? date(r.last_purchase_at) : ''}</div></div>
                : <span className="muted small">never</span> },
            { key: 'ch', head: 'Move', num: true, render: (r: any) =>
              r.change_pct == null ? <span className="muted">—</span> : (
                <b className={Number(r.change_pct) > 0 ? 'text-danger' : ''}>
                  {Number(r.change_pct) > 0 ? '+' : ''}{num(r.change_pct, 1)}%
                </b>) },
            { key: 'q', head: 'They have', num: true, render: (r: any) =>
              r.available_qty != null
                ? <span>{num(r.available_qty, 0)} <span className="small muted">{r.uom}</span></span>
                : <span className="muted">—</span> },
            { key: 'g', head: 'Grade', render: (r: any) =>
              r.offered_grade ? <Chip tone="neutral">{r.offered_grade}</Chip>
                : <span className="muted small">—</span> },
            { key: 'v', head: 'Good until', render: (r: any) =>
              r.valid_till
                ? <span className={r.is_stale ? 'chip warn' : 'small'}>{date(r.valid_till)}</span>
                : <span className="muted small">until changed</span> },
            { key: 'n', head: 'They said', render: (r: any) =>
              r.note ? <span className="small">{r.note}</span> : <span className="muted">—</span> },
            { key: 'w', head: 'Posted', render: (r: any) =>
              <span className="small muted">{ago(r.quoted_at)}</span> },
          ]}
          empty={<Empty icon="🏷️"
            title={f.active > 0 ? 'No rate matches those filters' : 'No supplier has posted a rate yet'}
            hint={f.active > 0 ? 'Clear a filter to widen the search.'
              : 'Suppliers set their own rates from their panel — the numbers appear here as they do.'} />}
        />
      </div></div>
    </>
  );
}

function SupplierManager() {
  const toast = useToast();
  const [showBlocked, setShowBlocked] = useState(false);
  const { data, loading, error, reload } = useApi<any[]>(
    `/masters/suppliers?includeBlocked=${showBlocked ? 1 : 0}`, [showBlocked]);
  const [editing, setEditing] = useState<any>(null);
  const [blocking, setBlocking] = useState<any>(null);

  const f = useFilters<any>(data, {
    search: (x: any) => [x.trade_name, x.legal_name, x.code, x.district, x.phone, x.email, x.gstin]
      .filter(Boolean).join(' '),
    facets: [
      { key: 'ty', label: 'type', of: (x: any) => x.source_type },
      { key: 'st', label: 'status', of: (x: any) => x.status },
      { key: 'ds', label: 'district', of: (x: any) => x.district },
      { key: 'gst', label: 'GST', all: 'Any GST status', of: (x: any) =>
        (x.gstin ? 'registered' : x.is_unregistered ? 'unregistered' : 'not recorded') },
      { key: 'lg', label: 'portal', all: 'Signs in or not', of: (x: any) =>
        (Number(x.login_count) > 0 ? 'signs in' : 'never signed in') },
    ],
    totals: [
      { label: 'Orders', of: (x: any) => Number(x.order_count) || 0 },
    ],
  });

  return (
    <>
      <ErrorBanner error={error} />
      <FilterBar f={f} placeholder="Search supplier, code, district, GSTIN">
        <label className="row" style={{ gap: 7 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={showBlocked}
            onChange={(e) => setShowBlocked(e.target.checked)} />
          <span className="small">Show removed</span>
        </label>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setEditing({})}>Add supplier</button>
      </FilterBar>
      <FilterTotals f={f} noun="supplier" />

      <div className="card"><div className="card-body tight">
        <DataTable rows={f.rows} loading={loading}
          rowTone={(s: any) => (s.status === 'BLOCKED' ? 'crit' : undefined)}
          cols={[
            { key: 'n', head: 'Supplier', render: (s: any) => (
              <div><b>{s.trade_name ?? s.legal_name}</b>
                <div className="small muted">{s.code}{s.district ? ` · ${s.district}` : ''}</div></div>) },
            { key: 't', head: 'Type', render: (s: any) => <Chip tone="neutral">{s.source_type}</Chip> },
            { key: 'c', head: 'Contact', render: (s: any) => (
              <div className="small">{s.phone ?? '—'}
                {s.email ? <div className="muted">{s.email}</div> : null}</div>) },
            { key: 'g', head: 'GSTIN', render: (s: any) => (
              <span className="mono small">{s.gstin ?? (s.is_unregistered ? 'unregistered' : '—')}</span>) },
            { key: 'p', head: 'Terms', num: true, render: (s: any) =>
              s.payment_terms_days ? `${s.payment_terms_days}d` : 'on delivery' },
            { key: 'o', head: 'Orders', num: true, render: (s: any) => s.order_count ?? 0 },
            { key: 'l', head: 'Portal login', render: (s: any) =>
              Number(s.login_count) > 0
                ? <Chip tone="ok">{s.login_count}</Chip>
                : <span className="small muted">none</span> },
            { key: 'st', head: 'Status', render: (s: any) => (
              <div><Chip value={s.status} />
                {s.status_reason ? <div className="small muted">{s.status_reason}</div> : null}</div>) },
            { key: 'a', head: '', width: 150, render: (s: any) => (
              <div className="btn-row">
                {s.status === 'BLOCKED' ? (
                  <button className="btn sm" onClick={async () => {
                    try {
                      await api.post(`/masters/suppliers/${s.id}/restore`);
                      toast('Supplier restored', 'ok'); reload();
                    } catch (e: any) { toast(e.message, 'err'); }
                  }}>Restore</button>
                ) : (
                  <>
                    <button className="btn sm" onClick={() => setEditing(s)}>Edit</button>
                    <button className="btn sm danger" onClick={() => setBlocking(s)}>Remove</button>
                  </>
                )}
              </div>) },
          ]}
          empty={<Empty icon="🤝" title="No suppliers on the list"
            hint="Add the farmers, aadhtis and wholesalers you buy from."
            action={<button className="btn primary" onClick={() => setEditing({})}>Add supplier</button>} />}
        />
      </div></div>

      {editing ? (
        <SupplierModal supplier={editing} onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); reload(); }} />
      ) : null}
      {blocking ? (
        <BlockSupplierModal supplier={blocking} onClose={() => setBlocking(null)}
          onDone={() => { setBlocking(null); reload(); }} />
      ) : null}
    </>
  );
}

/** Exported so a buyer can add a supplier without leaving the order. */
export function SupplierModal({ supplier, onClose, onDone }: {
  supplier: any; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const isNew = !supplier.id;
  const [f, setF] = useState({
    code: supplier.code ?? '',
    legalName: supplier.legal_name ?? '',
    tradeName: supplier.trade_name ?? '',
    sourceType: supplier.source_type ?? 'FARMER',
    gstin: supplier.gstin ?? '',
    phone: supplier.phone ?? '',
    email: supplier.email ?? '',
    district: supplier.district ?? '',
    paymentTermsDays: String(supplier.payment_terms_days ?? 0),
    isUnregistered: supplier.is_unregistered ?? false,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);

  // Most farmers are not GST-registered, which changes how the bill is treated.
  const needsGstin = !f.isUnregistered && f.sourceType !== 'FARMER';

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const payload = {
        legalName: f.legalName, tradeName: f.tradeName || undefined,
        sourceType: f.sourceType, gstin: f.gstin || undefined,
        phone: f.phone || undefined, email: f.email || undefined,
        district: f.district || undefined,
        paymentTermsDays: Number(f.paymentTermsDays) || 0,
        isUnregistered: f.isUnregistered,
      };
      if (isNew) await api.post('/masters/suppliers', { ...payload, code: f.code });
      else await api.put(`/masters/suppliers/${supplier.id}`, payload);
      toast(isNew ? 'Supplier added' : 'Supplier updated', 'ok');
      onDone();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  return (
    <Modal title={isNew ? 'Add a supplier' : `Edit ${supplier.trade_name ?? supplier.legal_name}`}
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !f.legalName || (isNew && !f.code)}
          onClick={save}>{busy ? 'Saving…' : isNew ? 'Add supplier' : 'Save changes'}</button>
      </>}>
      <ErrorBanner error={err} />
      <div className="grid c2">
        {isNew ? (
          <Field label="Short code" hint="Appears on orders. Cannot be changed later.">
            <input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })}
              placeholder="SUP-F002" />
          </Field>
        ) : (
          <Field label="Short code"><input readOnly value={supplier.code} /></Field>
        )}
        <Field label="Type">
          <select value={f.sourceType} onChange={(e) => setF({ ...f, sourceType: e.target.value })}>
            {SOURCE_TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
          </select>
        </Field>
        <Field label="Registered name"><input value={f.legalName}
          onChange={(e) => setF({ ...f, legalName: e.target.value })} /></Field>
        <Field label="Trading name" hint="What everyone actually calls them">
          <input value={f.tradeName} onChange={(e) => setF({ ...f, tradeName: e.target.value })} /></Field>
        <Field label="Phone"><input value={f.phone}
          onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="+9190…" /></Field>
        <Field label="Email" hint="Needed later if you give them a portal login">
          <input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="District"><input value={f.district}
          onChange={(e) => setF({ ...f, district: e.target.value })} /></Field>
        <Field label="Payment terms (days)" hint="0 means paid on delivery">
          <input type="number" value={f.paymentTermsDays}
            onChange={(e) => setF({ ...f, paymentTermsDays: e.target.value })} /></Field>
      </div>

      <label className="row mb" style={{ gap: 8 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={f.isUnregistered}
          onChange={(e) => setF({ ...f, isUnregistered: e.target.checked })} />
        <span>Not GST-registered <span className="muted small">— usual for a farmer; the bill is treated under reverse charge</span></span>
      </label>

      {needsGstin ? (
        <Field label="GSTIN" hint="Checked for format; leave blank if you do not have it yet">
          <input value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() })}
            placeholder="27AAAAA0000A1Z5" />
        </Field>
      ) : null}
    </Modal>
  );
}

function BlockSupplierModal({ supplier, onClose, onDone }: {
  supplier: any; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);

  return (
    <Modal title={`Remove ${supplier.trade_name ?? supplier.legal_name}?`} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn danger" disabled={busy || reason.trim().length < 4}
          onClick={async () => {
            setBusy(true); setErr(null);
            try {
              await api.post(`/masters/suppliers/${supplier.id}/block`, { reason });
              toast('Supplier removed from the list', 'ok');
              onDone();
            } catch (e) { setErr(e); } finally { setBusy(false); }
          }}>Remove supplier</button>
      </>}>
      <ErrorBanner error={err} />
      <p className="small muted mb">
        They disappear from every picker, so nobody can raise a new order against them.
        Their past orders, receipts and score stay exactly as they are — nothing is deleted,
        and you can put them back at any time.
      </p>
      <Field label="Why are they being removed?"
        hint="Kept on the record, and shown next to their name if they are restored.">
        <input value={reason} autoFocus onChange={(e) => setReason(e.target.value)}
          placeholder="Stopped supplying / quality problems / duplicate record" />
      </Field>
    </Modal>
  );
}

/* ======================================================== ALERTS ======== */
export function AlertsPage() {
  const toast = useToast();
  const [status, setStatus] = useState('OPEN');
  const { data, loading, error, reload } = useApi<any[]>(`/insights/alerts?status=${status}`, [status]);

  const f = useFilters<any>(data, {
    date: (a: any) => a.created_at,
    search: (a: any) => [a.title, a.message, a.alert_type].filter(Boolean).join(' '),
    facets: [
      { key: 'sv', label: 'severity', of: (a: any) => a.severity },
      { key: 'ty', label: 'type', of: (a: any) => String(a.alert_type).replace(/_/g, ' ') },
      { key: 'st', label: 'status', of: (a: any) => a.status },
    ],
    totals: [],
  });

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
      <FilterBar f={f} placeholder="Search alerts">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {['OPEN', 'ACK', 'RESOLVED'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </FilterBar>
      <FilterTotals f={f} noun="alert" />
      <div className="card"><div className="card-body tight">
        <DataTable
          rows={f.rows} loading={loading}
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
          empty={<Empty icon="🔕"
            title={f.active > 0 ? 'No alert matches those filters' : 'No alerts'}
            hint={f.active > 0 ? 'Clear a filter to widen the search.'
              : 'Nothing needs your attention.'} />}
        />
      </div></div>
    </Layout>
  );
}

/* ======================================================= REPORTS ======== */
/* A report is a table whose columns depend on which report you picked, so the
 * filters have to be declared per report rather than per page. Each entry says
 * which column carries the date, which columns are worth narrowing by, and
 * what the remaining rows should add up to — the same three things every other
 * list in the app declares, just keyed by report. */
type ReportDef = {
  key: string;
  name: string;
  desc: string;
  noun: string;
  /** Column holding the row's date. Omitted where a time window is meaningless. */
  date?: string;
  facets: [col: string, label: string][];
  totals: { col: string; label: string; money?: boolean; decimals?: number }[];
  search: string[];
};

const REPORTS: ReportDef[] = [
  {
    key: 'purchase-register',
    name: 'Purchase register',
    desc: 'Every line received, with rate and landed cost',
    noun: 'line', date: 'posting_date',
    facets: [['supplier', 'supplier'], ['product', 'product'], ['grade', 'grade'],
      ['source_type', 'source'], ['uom', 'unit']],
    totals: [
      { col: 'accepted_qty', label: 'Accepted' },
      { col: 'rejected_qty', label: 'Rejected' },
      { col: 'net_weight_kg', label: 'Weight kg', decimals: 1 },
      { col: 'line_value', label: 'Value', money: true },
    ],
    search: ['grn_no', 'po_no', 'sku', 'product', 'supplier'],
  },
  {
    key: 'quality-rejection',
    name: 'Quality & rejection',
    desc: 'What was rejected, why, and by whom',
    noun: 'inspection', date: 'date',
    facets: [['supplier', 'supplier'], ['product', 'product'],
      ['assigned_grade', 'grade'], ['inspector', 'inspector']],
    totals: [
      { col: 'received_qty', label: 'Received' },
      { col: 'accepted_qty', label: 'Accepted' },
      { col: 'rejected_qty', label: 'Rejected' },
      { col: 'hold_qty', label: 'On hold' },
    ],
    search: ['inspection_no', 'product', 'sku', 'supplier', 'inspector'],
  },
  {
    key: 'weight-variance',
    name: 'Weight variance',
    desc: 'Where the weighbridge disagreed with the order',
    noun: 'weighment', date: 'date',
    facets: [['supplier', 'supplier'], ['variance_band', 'band'], ['kind', 'kind'],
      ['capture_mode', 'capture'], ['weighed_by', 'weighed by']],
    totals: [
      { col: 'net_kg', label: 'Net kg', decimals: 1 },
      { col: 'expected_kg', label: 'Expected kg', decimals: 1 },
      { col: 'variance_kg', label: 'Variance kg', decimals: 1 },
    ],
    search: ['gate_no', 'vehicle_reg_captured', 'supplier', 'po_no', 'weighed_by'],
  },
  {
    key: 'landing-cost',
    name: 'Landed cost analysis',
    desc: 'True cost per kg and how it moved',
    noun: 'line', date: 'posting_date',
    facets: [['supplier', 'supplier'], ['product', 'product']],
    totals: [
      { col: 'base_value', label: 'Bought for', money: true },
      { col: 'allocated_total', label: 'Overheads', money: true },
      { col: 'wastage_amount', label: 'Wastage', money: true },
      { col: 'landed_value', label: 'Landed', money: true },
    ],
    search: ['grn_no', 'supplier', 'product', 'sku'],
  },
  {
    key: 'pending-po',
    name: 'Pending purchase orders',
    desc: 'Ordered but not yet received',
    noun: 'line', date: 'order_date',
    facets: [['supplier', 'supplier'], ['product', 'product'], ['status', 'status'],
      ['line_status', 'line status']],
    totals: [
      { col: 'ordered', label: 'Ordered' },
      { col: 'received_qty', label: 'Received' },
      { col: 'balance_qty', label: 'Still to come' },
    ],
    search: ['po_no', 'supplier', 'product'],
  },
  {
    key: 'stock-position',
    name: 'Stock position',
    desc: 'On-hand by batch with expiry risk',
    /* No time window: stock is a position, not a period. The date boxes above
     * already read as "expiring between", which is the only sense a date makes
     * here — a second "last 30 days" control would mean something different
     * again and quietly hide stock. */
    noun: 'batch',
    facets: [['product_name', 'product'], ['grade', 'grade'], ['status', 'status']],
    totals: [
      { col: 'qty', label: 'On hand' },
      { col: 'available_qty', label: 'Available' },
      { col: 'weight_kg', label: 'Weight kg', decimals: 1 },
    ],
    search: ['sku', 'product_name', 'batch_no'],
  },
  {
    key: 'ai-acceptance',
    name: 'AI acceptance',
    desc: 'How often people take the AI suggestion',
    noun: 'week', date: 'week',
    facets: [['feature_key', 'feature']],
    totals: [
      { col: 'runs', label: 'Runs' },
      { col: 'accepted', label: 'Accepted' },
      { col: 'overridden', label: 'Overridden' },
    ],
    search: ['feature_key'],
  },
];

export function ReportsPage() {
  const [key, setKey] = useState('purchase-register');
  const [from, setFrom] = useState(addDays(-30));
  const [to, setTo] = useState(today());
  const { data, loading, error } = useApi<any>(
    `/insights/reports/${key}?from=${from}&to=${to}`, [key, from, to]);
  const { can } = useAuth();
  const def = REPORTS.find((r) => r.key === key)!;

  /* Only offer a facet the chosen report actually has a column for, and only
   * when more than one value appears — a "supplier" dropdown holding one
   * supplier is a control that cannot do anything. */
  const present = React.useMemo(() => {
    const rows: any[] = data?.rows ?? [];
    const cols = new Set(rows.length ? Object.keys(rows[0]) : []);
    return def.facets.filter(([c]) => cols.has(c)
      && new Set(rows.map((r) => r[c]).filter((v) => v != null && v !== '')).size > 1);
  }, [data, def]);

  const f = useFilters<any>(data?.rows, React.useMemo(() => ({
    date: def.date ? (r: any) => r[def.date!] : undefined,
    search: (r: any) => def.search.map((c) => r[c]).filter(Boolean).join(' '),
    facets: present.map(([col, label]) => ({ key: col, label, of: (r: any) => r[col] })),
    totals: def.totals.map((t) => ({
      label: t.label, money: t.money, decimals: t.decimals,
      of: (r: any) => Number(r[t.col]) || 0,
    })),
  }), [def, present]));

  /* Switching report clears the filters. Several reports share a facet name —
   * "supplier", "product", "grade" — and without this, picking a supplier on
   * the purchase register silently narrowed the quality report you opened
   * next. The control showed it, but the number at the top was the number
   * somebody would have quoted, and it would have been wrong. */
  React.useEffect(() => { f.clear(); }, [key]);

  const download = () => {
    // Exports what is on the screen. Downloading 5,000 rows after narrowing to
    // nine is not the file anyone meant to ask for.
    if (!f.rows.length) return;
    const cols = Object.keys(f.rows[0]);
    const csv = [cols.join(','), ...f.rows.map((r: any) =>
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

  const cols = f.rows.length ? Object.keys(f.rows[0]) : [];

  return (
    <Layout title="Reports" subtitle="Numbers you can take to a meeting"
      actions={can('data.export')
        ? <button className="btn primary" disabled={!f.rows.length} onClick={download}>
            Download CSV{f.active > 0 ? ` (${f.rows.length})` : ''}
          </button>
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

      <FilterBar f={f} placeholder={`Search ${def.name.toLowerCase()}`}>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
          title={key === 'stock-position' ? 'Expiring from' : 'From'} />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
          title={key === 'stock-position' ? 'Expiring until' : 'To'} />
      </FilterBar>
      <FilterTotals f={f} noun={def.noun} />

      <div className="card"><div className="card-body tight">
        {loading ? <Loading /> : !f.rows.length ? (
          <Empty icon="📈"
            title={f.active > 0 ? 'Nothing matches those filters' : 'No data for this period'}
            hint={f.active > 0 ? 'Clear a filter to widen the search.' : undefined} />
        ) : (
          <div className="table-wrap" style={{ maxHeight: '65vh', overflowY: 'auto' }}>
            <table className="data">
              <thead><tr>{cols.map((c) => <th key={c}>{c.replace(/_/g, ' ')}</th>)}</tr></thead>
              <tbody>
                {f.rows.slice(0, 500).map((r: any, i: number) => (
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
            {f.rows.length > 500 ? (
              <div className="small muted" style={{ padding: '8px 12px' }}>
                Showing the first 500 of {f.rows.length}. Narrow the filters, or download the CSV
                for all of them.
              </div>
            ) : null}
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
  const [tab, setTab] = useState<'settings' | 'trail'>('settings');

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
      {can('admin.audit.view') ? (
        <div className="tabs">
          {([['settings', 'Settings'], ['trail', 'What people did']] as const).map(([k, l]) => (
            <button key={k} className={`tab ${tab === k ? 'active' : ''}`}
              onClick={() => setTab(k)}>{l}</button>))}
        </div>
      ) : null}

      {tab === 'trail' ? <AuditTrail /> : <>
      <div className="mb"><CompanyCard /></div>
      <div className="mb"><EmailSettingsCard /></div>
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
      </>}
    </Layout>
  );
}

/* ---------------------------------------------------------------------------
 * WHAT PEOPLE DID
 *
 * "everything will be recorded such as who, how, when how much" — the client
 * meant the audit team, but the same sentence is true of the system itself.
 * Every write already landed in audit_log and the endpoint to read it already
 * existed; there was simply no screen, so 3,000 entries sat there unreadable
 * and the answer to "who changed that rate" was a database console.
 * ------------------------------------------------------------------------ */
function AuditTrail() {
  const [table, setTable] = useState('');
  const { data, loading, error } = useApi<any[]>(
    `/masters/audit?table=${encodeURIComponent(table)}`, [table]);

  const f = useFilters<any>(data, {
    date: (a: any) => a.occurred_at,
    search: (a: any) => [a.entity_type, a.action, a.actor_name, a.actor_role,
      a.reason_text, a.reason_code].filter(Boolean).join(' '),
    facets: [
      { key: 'who', label: 'person', of: (a: any) => a.actor_name ?? 'the system' },
      { key: 'what', label: 'record', of: (a: any) => a.entity_type },
      { key: 'act', label: 'action', of: (a: any) => a.action },
      { key: 'role', label: 'role', of: (a: any) => a.actor_role },
    ],
    totals: [],
  });

  return (
    <>
      <ErrorBanner error={error} />
      <div className="banner info mb">
        <span><Icon name="info" size={16} /></span>
        <div>
          Every change anybody makes, with who made it and when. It is written
          automatically and nothing on any screen can edit or delete it — which
          is the only thing that makes it worth reading.
        </div>
      </div>
      <FilterBar f={f} placeholder="Search person, record, reason">
        <select value={table} onChange={(e) => setTable(e.target.value)}>
          <option value="">Everything</option>
          {['purchase_orders', 'supplier_invoices', 'payments', 'payment_requests',
            'grns', 'stock_issues', 'products', 'suppliers', 'users']
            .map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
        </select>
      </FilterBar>
      <FilterTotals f={f} noun="entry" />
      <div className="card"><div className="card-body tight">
        <DataTable
          rows={f.rows} loading={loading}
          cols={[
            { key: 'w', head: 'When', render: (a: any) => (
              <div className="small"><b>{ago(a.occurred_at)}</b>
                <div className="muted">{dateTime(a.occurred_at)}</div></div>) },
            { key: 'who', head: 'Who', render: (a: any) => (
              <div><b>{a.actor_name ?? 'the system'}</b>
                {a.actor_role ? <div className="small muted">{a.actor_role}</div> : null}</div>) },
            { key: 'did', head: 'Did what', render: (a: any) => (
              <div>
                <Chip tone={/delete|reverse|cancel/i.test(a.action) ? 'danger'
                  : /create|insert/i.test(a.action) ? 'ok' : 'primary'}>
                  {String(a.action).replace(/_/g, ' ').toLowerCase()}
                </Chip>
                <div className="small muted">{String(a.entity_type).replace(/_/g, ' ')}</div>
              </div>) },
            { key: 'why', head: 'Why', render: (a: any) =>
              a.reason_text ? <span className="small">{a.reason_text}</span>
                : a.reason_code ? <span className="small muted">{a.reason_code}</span>
                : <span className="muted">—</span> },
            /* The diff is the answer to "what exactly changed", and it is
               JSON. Shown small and monospaced rather than pretty-printed —
               anybody reading this far wants the raw fact. */
            { key: 'd', head: 'What changed', render: (a: any) => {
              const d = a.diff;
              if (!d || (typeof d === 'object' && !Object.keys(d).length)) {
                return <span className="muted">—</span>;
              }
              const txt = typeof d === 'string' ? d : JSON.stringify(d);
              return <span className="mono small" title={txt}>
                {txt.length > 90 ? `${txt.slice(0, 90)}…` : txt}
              </span>;
            } },
          ]}
          empty={<Empty icon="📄"
            title={f.active > 0 ? 'Nothing matches those filters' : 'Nothing recorded yet'} />}
        />
      </div></div>
    </>
  );
}

/* ======================================================= PROFILE ======== */
export function ProfilePage() {
  const { me } = useAuth();
  const [changing, setChanging] = useState(false);
  if (!me) return <Layout title="Profile"><Loading /></Layout>;
  return (
    <Layout title={me.fullName} subtitle={`${me.companyName} · ${me.email}`}
      /* A password was set once from an invite link and could never be changed
         again — not by the person, not by anyone. Somebody who thinks a
         colleague watched them type it had no recourse at all. */
      actions={<button className="btn sm" onClick={() => setChanging(true)}>
        Change password
      </button>}>
      {changing ? (
        <ChangePasswordModal onClose={() => setChanging(false)} />
      ) : null}
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

/* =============================================== CREDIT & DEBIT NOTES ==== */

const NOTE_ACTIONS: Record<string, { action: string; label: string; primary?: boolean }[]> = {
  DRAFT:    [{ action: 'issue', label: 'Send to supplier', primary: true }, { action: 'cancel', label: 'Cancel' }],
  ISSUED:   [{ action: 'accept', label: 'They accepted', primary: true }, { action: 'cancel', label: 'Cancel' }],
  ACCEPTED: [{ action: 'settle', label: 'Settle against invoice', primary: true }],
  SETTLED:  [],
  CANCELLED: [],
};

/**
 * The claims we have on suppliers. A debit note takes money off what we owe;
 * a credit note adds to it. Nothing moves until it is settled, and settling
 * needs a linked invoice with a live balance — which is why the direction is
 * spelled out on screen rather than left to be inferred from the word.
 */
function NotesPanel() {
  const toast = useToast();
  const { can } = useAuth();
  const [status, setStatus] = useState('');
  const { data, loading, error, reload } = useApi<any[]>(`/costing/notes?status=${status}`, [status]);
  const [busy, setBusy] = useState<string | null>(null);

  const f = useFilters<any>(data, {
    date: (n: any) => n.note_date ?? n.created_at,
    search: (n: any) => [n.note_no, n.supplier_name, n.invoice_no, n.reason_code]
      .filter(Boolean).join(' '),
    facets: [
      { key: 'sup', label: 'supplier', of: (n: any) => n.supplier_name },
      { key: 'ty', label: 'direction', of: (n: any) =>
        (n.note_type === 'DEBIT' ? 'we claim back' : 'we owe more') },
      { key: 'rc', label: 'reason', of: (n: any) =>
        String(n.reason_code ?? '').replace(/_/g, ' ') },
      { key: 'st', label: 'status', of: (n: any) => n.status },
      { key: 'src', label: 'raised by', of: (n: any) =>
        (n.auto_drafted ? 'the match engine' : 'a person') },
    ],
    totals: [
      { label: 'Value', of: (n: any) => Number(n.amount) || 0, money: true },
    ],
  });

  const act = async (n: any, action: string) => {
    if (action === 'cancel') {
      const reason = window.prompt(`Why is ${n.note_no} being cancelled?`);
      if (!reason || reason.trim().length < 4) return;
      setBusy(n.id);
      try {
        await api.post(`/costing/notes/${n.id}/cancel`, { reason });
        toast(`${n.note_no} cancelled`, 'ok'); reload();
      } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(null); }
      return;
    }
    setBusy(n.id);
    try {
      const r = await api.post<any>(`/costing/notes/${n.id}/${action}`, {});
      toast(r.balanceAfter != null
        ? `${n.note_no} settled — invoice balance is now ${inr(r.balanceAfter, 0)}`
        : `${n.note_no} is now ${String(r.status).toLowerCase()}`, 'ok');
      reload();
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(null); }
  };

  const open = (data ?? []).filter((n: any) => ['DRAFT', 'ISSUED', 'ACCEPTED'].includes(n.status));
  const recoverable = open
    .filter((n: any) => n.note_type === 'DEBIT')
    .reduce((a: number, n: any) => a + Number(n.total), 0);

  return (
    <>
      <div className="grid c3 mb">
        <Kpi label="Open claims" value={open.length}
          foot="raised but not settled" />
        <Kpi label="Money to recover" value={inr(recoverable, 0)}
          tone={recoverable > 0 ? 'warn' : 'good'}
          foot="debit notes not yet settled" />
        <Kpi label="Auto-drafted" value={(data ?? []).filter((n: any) => n.auto_drafted).length}
          foot="raised by the match engine" />
      </div>

      <FilterBar f={f} placeholder="Search note, supplier, invoice">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Every note</option>
          <option value="DRAFT">Draft</option>
          <option value="ISSUED">Sent to supplier</option>
          <option value="ACCEPTED">Accepted</option>
          <option value="SETTLED">Settled</option>
        </select>
      </FilterBar>
      <FilterTotals f={f} noun="note" />

      <ErrorBanner error={error} />
      <div className="card"><div className="card-body tight">
        <DataTable
          rows={f.rows} loading={loading}
          rowTone={(n: any) => (n.status === 'DRAFT' && n.auto_drafted ? 'warn' : undefined)}
          cols={[
            { key: 'n', head: 'Note', render: (n: any) => (
              <div>
                <b className="mono">{n.note_no}</b>
                <div className="small muted">
                  {n.supplier_name}{n.invoice_no ? ` · ${n.invoice_no}` : ' · not linked'}
                </div>
              </div>
            ) },
            { key: 't', head: 'Direction', render: (n: any) => (
              <div>
                <Chip tone={n.note_type === 'DEBIT' ? 'danger' : 'primary'}>
                  {n.note_type === 'DEBIT' ? 'we claim back' : 'we owe more'}
                </Chip>
                <div className="small muted">{String(n.reason_code).replace(/_/g, ' ').toLowerCase()}</div>
              </div>
            ) },
            { key: 'a', head: 'Amount', num: true, render: (n: any) => (
              <b style={{ color: n.note_type === 'DEBIT' ? 'var(--danger)' : 'var(--primary)' }}>
                {n.note_type === 'DEBIT' ? '−' : '+'}{inr(n.total, 0)}
              </b>
            ) },
            { key: 's', head: 'Status', render: (n: any) => (
              <div>
                <Chip value={n.status} />
                {n.auto_drafted ? <div className="small muted">from the match</div> : null}
              </div>
            ) },
            { key: 'r', head: 'Why', render: (n: any) => (
              <span className="small muted">{n.remarks ?? '—'}</span>
            ) },
            { key: 'act', head: '', width: 230, render: (n: any) => can('finance.invoice.match') ? (
              <div className="btn-row">
                {(NOTE_ACTIONS[n.status] ?? []).map((a) => (
                  <button key={a.action} disabled={busy === n.id}
                    className={`btn sm ${a.primary ? 'primary' : ''}`}
                    onClick={() => act(n, a.action)}>{a.label}</button>
                ))}
              </div>
            ) : null },
          ]}
          empty={<Empty icon="🧾" title="No credit or debit notes"
            hint="The match engine raises one automatically when a supplier bills for more than we received." />}
        />
      </div></div>
    </>
  );
}


/* ---------------------------------------------------------------------------
 * The company's own details: the UPI code every shop prints, and the two
 * numbers behind the minimum sell price.
 * ------------------------------------------------------------------------ */
function CompanyCard() {
  const toast = useToast();
  const { can } = useAuth();
  const { data, reload } = useApi<any>('/masters/company');
  const [f, setF] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data && !f) {
      setF({
        upiId: data.upi_id ?? '', upiPayeeName: data.upi_payee_name ?? '',
        defaultMarginPct: String(data.default_margin_pct ?? 15),
        overheadWindowDays: String(data.overhead_window_days ?? 30),
      });
    }
  }, [data]); // eslint-disable-line

  if (!data || !f) return null;
  const set = (k: string) => (e: any) => setF((s: any) => ({ ...s, [k]: e.target.value }));
  const editable = can('admin.settings.manage');

  return (
    <div className="card">
      <div className="card-head">
        <h2>{data.trade_name ?? data.legal_name}</h2>
        {editable ? (
          <button className="btn sm primary" disabled={busy} onClick={async () => {
            setBusy(true);
            try {
              const r = await api.patch<any>('/masters/company', {
                upiId: f.upiId || undefined,
                upiPayeeName: f.upiPayeeName || undefined,
                defaultMarginPct: Number(f.defaultMarginPct) || undefined,
                overheadWindowDays: Number(f.overheadWindowDays) || undefined,
              });
              toast(r.message, 'ok'); reload();
            } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
          }}>Save</button>
        ) : null}
      </div>
      <div className="card-body">
        <div className="grid c2">
          <Field label="Company UPI code"
            hint="Every centre prints this unless it has its own.">
            <input value={f.upiId} disabled={!editable} onChange={set('upiId')}
              placeholder="chotug@okhdfcbank" />
          </Field>
          <Field label="Name shown when they pay">
            <input value={f.upiPayeeName} disabled={!editable} onChange={set('upiPayeeName')}
              placeholder="ChotuG Agro" />
          </Field>
        </div>
        <div className="grid c2">
          <Field label="Minimum margin (%)"
            hint="The profit built into every product's floor price, unless the product sets its own.">
            <input type="number" value={f.defaultMarginPct} disabled={!editable}
              onChange={set('defaultMarginPct')} />
          </Field>
          <Field label="Overhead is averaged over (days)"
            hint="Running costs paid, divided by kilos handled, across this many days.">
            <input type="number" value={f.overheadWindowDays} disabled={!editable}
              onChange={set('overheadWindowDays')} />
          </Field>
        </div>

        <div className="section-head sm"><h3>What each place prints</h3><span className="rule" /></div>
        <table className="mini">
          <tbody>
            {(data.places ?? []).map((pl: any) => (
              <tr key={pl.warehouse_id}>
                <td><b>{pl.place_name}</b></td>
                <td className="mono small">{pl.upi_id ?? <span className="muted">nothing set</span>}</td>
                <td style={{ width: 120 }}>
                  <Chip tone={pl.is_own_code ? 'primary' : 'neutral'}>
                    {pl.is_own_code ? 'its own' : "the company's"}
                  </Chip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  /* Checked here as well as on the server, because being told "at least 8
     characters" after pressing the button means typing all three again. */
  const tooShort = next.length > 0 && next.length < 8;
  const mismatch = again.length > 0 && next !== again;

  return (
    <Modal
      title="Change your password"
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary"
          disabled={busy || !current || next.length < 8 || next !== again}
          onClick={async () => {
            setBusy(true); setError(null);
            try {
              await api.post('/auth/change-password', {
                currentPassword: current, newPassword: next,
              });
              toast('Password changed', 'ok');
              onClose();
            } catch (e: any) { setError(e); } finally { setBusy(false); }
          }}>Change it</button>
      </>}
    >
      <ErrorBanner error={error} />
      <Field label="Your password now">
        <input type="password" autoFocus value={current}
          onChange={(e) => setCurrent(e.target.value)} />
      </Field>
      <Field label="New password"
        hint={tooShort ? 'At least 8 characters.' : 'At least 8 characters.'}>
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label="Type it again" hint={mismatch ? 'These two do not match.' : undefined}>
        <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} />
      </Field>
      {mismatch ? (
        <div className="banner warn"><span><Icon name="alert" size={16} /></span>
          <div className="small">The two new passwords do not match.</div></div>
      ) : null}
    </Modal>
  );
}
