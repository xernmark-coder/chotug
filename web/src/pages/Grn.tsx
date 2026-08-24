import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, useAuth, idempotencyKey, inr, num, date, dateTime, pctText } from '../lib/api';
import {
  Chip, DataTable, Empty, ErrorBanner, Field, Layout, Loading, Modal, useApi, useToast,
  FilterBar, FilterTotals, useFilters,
} from '../components/ui';
import { Icon } from '../components/icons';
import { SendToCentreModal } from './Centres';

/* ====================================================== GRN LIST ========= */
export function GrnListPage() {
  const nav = useNavigate();
  const { data, loading, error } = useApi<any[]>('/receiving/grns');

  const f = useFilters<any>(data, {
    date: (g: any) => g.posting_date,
    search: (g: any) => [g.grn_no, g.supplier_name, g.po_no, g.vehicle_reg_captured, g.gate_no]
      .filter(Boolean).join(' '),
    facets: [
      { key: 'sup', label: 'supplier', of: (g: any) => g.supplier_name },
      { key: 'st', label: 'status', of: (g: any) => g.status },
      { key: 'veh', label: 'vehicle', of: (g: any) => g.vehicle_reg_captured },
      { key: 'lc', label: 'costing', all: 'Costed or not', of: (g: any) =>
        (Number(g.has_landing_cost) > 0 ? 'computed' : 'pending') },
    ],
    totals: [
      { label: 'Accepted', of: (g: any) => Number(g.total_accepted_qty) || 0 },
      { label: 'Rejected', of: (g: any) => Number(g.total_rejected_qty) || 0 },
      { label: 'Net kg', of: (g: any) => Number(g.total_net_weight_kg) || 0, decimals: 1 },
      { label: 'Value', of: (g: any) => Number(g.total_value) || 0, money: true },
    ],
  });

  return (
    <Layout title="Goods receipts" subtitle="Everything that has entered stock">
      <ErrorBanner error={error} />
      <FilterBar f={f} placeholder="Search receipt, supplier, order, vehicle" />
      <FilterTotals f={f} noun="receipt" />
      <div className="card"><div className="card-body tight">
        <DataTable
          rows={f.rows} loading={loading}
          onRowClick={(g: any) => nav(`/grns/${g.id}`)}
          rowTone={(g: any) => (g.status === 'REVERSED' ? 'crit'
            : Number(g.total_rejected_qty) > 0 ? 'warn' : undefined)}
          cols={[
            { key: 'n', head: 'Number', render: (g: any) => <b className="mono">{g.grn_no}</b> },
            { key: 'd', head: 'Posted', render: (g: any) => date(g.posting_date) },
            { key: 's', head: 'Supplier', render: (g: any) => g.supplier_name },
            { key: 'v', head: 'Vehicle', render: (g: any) => (
              <div className="small"><span className="mono">{g.vehicle_reg_captured}</span>
                <div className="muted">{g.gate_no}</div></div>
            ) },
            { key: 'po', head: 'Order', render: (g: any) => <span className="mono small">{g.po_no ?? '—'}</span> },
            { key: 'a', head: 'Accepted', num: true, render: (g: any) => num(g.total_accepted_qty, 0) },
            { key: 'r', head: 'Rejected', num: true, render: (g: any) =>
              Number(g.total_rejected_qty) > 0
                ? <b style={{ color: 'var(--danger)' }}>{num(g.total_rejected_qty, 0)}</b> : '—' },
            { key: 'w', head: 'Net kg', num: true, render: (g: any) => num(g.total_net_weight_kg, 1) },
            { key: 'val', head: 'Value', num: true, render: (g: any) => inr(g.total_value, 0) },
            { key: 'lc', head: 'Landed cost', render: (g: any) =>
              Number(g.has_landing_cost) > 0 ? <Chip tone="ok">computed</Chip> : <Chip tone="warn">pending</Chip> },
            { key: 'st', head: 'Status', render: (g: any) => <Chip value={g.status} /> },
          ]}
          empty={<Empty icon="📥" title={f.active > 0
            ? 'No receipt matches those filters' : 'No goods receipts yet'} />}
        />
      </div></div>
    </Layout>
  );
}

/* ==================================================== GRN DETAIL ======== */
export function GrnDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<any>(`/receiving/grns/${id}`, [id]);
  const { data: chargeTypes } = useApi<any[]>('/masters/charge-types');
  const [costing, setCosting] = useState(false);
  const [reversing, setReversing] = useState(false);

  if (loading) return <Layout title="Goods receipt"><Loading /></Layout>;
  if (!data) return <Layout title="Goods receipt"><ErrorBanner error={error} /></Layout>;

  const actual = data.landingCosts?.find((l: any) => l.cost_status === 'ACTUAL');

  return (
    <Layout title={data.grn_no}
      subtitle={`${data.supplier_name} · ${data.vehicle_reg_captured} · posted ${date(data.posting_date)}`}
      actions={
        <div className="btn-row">
          <Chip value={data.status} />
          {data.status === 'POSTED' && can('costing.landing.recompute') ? (
            <button className="btn primary" onClick={() => setCosting(true)}>
              {actual ? 'Recompute landed cost' : 'Compute landed cost'}
            </button>
          ) : null}
          {data.status === 'POSTED' && can('receiving.grn.reverse') ? (
            <button className="btn danger" onClick={() => setReversing(true)}>Reverse</button>
          ) : null}
        </div>
      }>
      <ErrorBanner error={error} />
      {/* Booking in is not the end of the job. The crates are standing on the
          floor and the batch they belong to has only just come into existence,
          so the next step goes at the top rather than as a button in the last
          column of a wide table. */}
      {data.status === 'POSTED' && can('inventory.pack.grade')
        && (data.lines ?? []).some((l: any) => l.batch_id) ? (
        <div className="banner info mb">
          <span><Icon name="tag" size={16} /></span>
          <div>
            <b>Booked in — the crates are still on the floor.</b>{' '}
            Grade each box as you pack it, label it, and scan it onto a shelf.
          </div>
          <button className="btn sm primary"
            onClick={() => nav(`/pack-bench/${(data.lines ?? []).find((l: any) => l.batch_id).batch_id}`)}>
            Grade &amp; pack &rarr;
          </button>
        </div>
      ) : null}
      {data.is_backdated ? (
        <div className="banner warn mb"><span><Icon name="clipboard" size={16} /></span>
          <div>This receipt was back-dated to {date(data.posting_date)}.</div></div>
      ) : null}
      {actual?.is_abnormal ? (
        <div className="banner danger mb">
          <span><Icon name="coins" size={16} /></span>
          <div><b>The landed cost moved sharply on this receipt.</b> Check selling prices before
            this stock goes out.</div>
        </div>
      ) : null}

      <div className="grid sidebar-right">
        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>Lines</h2></div>
            <div className="card-body tight">
              <DataTable
                rows={data.lines ?? []}
                cols={[
                  { key: 'p', head: 'Product', render: (l: any) => (
                    <div><b>{l.product_name}</b><div className="small muted">{l.sku}</div></div>
                  ) },
                  { key: 'b', head: 'Batch', render: (l: any) => (
                    <div className="small"><span className="mono">{l.batch_no ?? '—'}</span>
                      {l.expiry_date ? <div className="muted">expires {date(l.expiry_date)}</div> : null}</div>
                  ) },
                  { key: 'r', head: 'Received', num: true, render: (l: any) => num(l.received_qty, 0) },
                  { key: 'a', head: 'Accepted', num: true, render: (l: any) => <b>{num(l.accepted_qty, 0)}</b> },
                  { key: 'rj', head: 'Rejected', num: true, render: (l: any) =>
                    Number(l.rejected_qty) > 0
                      ? <div><b style={{ color: 'var(--danger)' }}>{num(l.rejected_qty, 0)}</b>
                          <div className="small muted">{l.rejection_reason_code}</div></div> : '—' },
                  { key: 'w', head: 'Net kg', num: true, render: (l: any) => num(l.net_weight_kg, 1) },
                  { key: 'rate', head: 'Rate', num: true, render: (l: any) => inr(l.rate) },
                  { key: 'g', head: 'Grade', render: (l: any) => <Chip tone="neutral">{l.grade ?? '—'}</Chip> },
                  { key: 'q', head: 'QC score', num: true, render: (l: any) =>
                    l.quality_score != null ? num(l.quality_score, 0) : '—' },
                  { key: 'v', head: 'Value', num: true, render: (l: any) => inr(l.line_value) },
                  /* Straight from the receipt to the bench. Quality and packing
                     are one job, and the person who does it should not have to
                     go and find the batch on another screen. */
                  { key: 'pk', head: '', width: 120, render: (l: any) =>
                    l.batch_id && can('inventory.pack.grade') && data.status === 'POSTED' ? (
                      <button className="btn sm" onClick={() => nav(`/pack-bench/${l.batch_id}`)}>
                        Grade &amp; pack
                      </button>
                    ) : null },
                ]}
              />
            </div>
          </div>

          {actual ? (
            <div className="card">
              <div className="card-head">
                <h2>Landed cost</h2>
                <Chip tone={actual.is_abnormal ? 'danger' : 'ok'}>
                  {actual.is_abnormal ? 'abnormal movement' : 'normal'}
                </Chip>
              </div>
              <div className="card-body tight">
                <DataTable
                  rows={actual.lines ?? []}
                  rowTone={(l: any) => (l.rateChangePct != null && Math.abs(l.rateChangePct) > 15 ? 'crit' : undefined)}
                  cols={[
                    { key: 'p', head: 'Product', render: (l: any) => l.productName },
                    { key: 'q', head: 'Qty', num: true, render: (l: any) => num(l.acceptedQty, 0) },
                    { key: 'b', head: 'Base rate', num: true, render: (l: any) => inr(l.baseRate) },
                    { key: 'c', head: 'Charges', num: true, render: (l: any) => inr(l.allocatedTotal) },
                    { key: 'w', head: 'Wastage', num: true, render: (l: any) => inr(l.wastageAmount) },
                    { key: 'lr', head: 'Landed / unit', num: true, render: (l: any) => <b>{inr(l.landedRatePerUom)}</b> },
                    { key: 'lk', head: 'Landed / kg', num: true, render: (l: any) => inr(l.landedRatePerKg) },
                    { key: 'ch', head: 'vs last', num: true, render: (l: any) =>
                      l.rateChangePct == null ? '—'
                        : <Chip tone={Math.abs(l.rateChangePct) > 15 ? 'danger' : Math.abs(l.rateChangePct) > 5 ? 'warn' : 'ok'}>
                            {pctText(l.rateChangePct)}
                          </Chip> },
                  ]}
                />
                <div className="card-body">
                  <dl className="kv">
                    <dt>Goods value</dt><dd>{inr(actual.base_amount)}</dd>
                    <dt>Charges allocated</dt><dd>{inr(actual.total_charges)}</dd>
                    <dt>Wastage provision</dt><dd>{inr(actual.wastage_provision)}</dd>
                    <dt style={{ fontWeight: 600 }}>Total landed</dt>
                    <dd style={{ fontSize: 17, fontWeight: 700 }}>{inr(actual.total_landed)}</dd>
                    <dt>vs estimate</dt>
                    <dd>{inr(actual.variance_vs_estimate)} ({pctText(actual.variance_vs_estimate_pct)})</dd>
                  </dl>
                </div>
              </div>
            </div>
          ) : (
            <div className="card"><div className="card-body">
              <Empty icon="💰" title="Landed cost not computed yet"
                hint="Until this is done, the true cost of this stock — and therefore the margin — is unknown." />
            </div></div>
          )}
        </div>

        <div className="card">
          <div className="card-head"><h2>Summary</h2></div>
          <div className="card-body">
            <dl className="kv">
              <dt>Gate entry</dt><dd className="mono">{data.gate_no}</dd>
              <dt>Purchase order</dt><dd className="mono">{data.po_no ?? '—'}</dd>
              <dt>Supplier</dt><dd>{data.supplier_name}</dd>
              <dt>Source type</dt><dd>{data.source_type}</dd>
              <dt>Received</dt><dd>{num(data.total_received_qty, 0)}</dd>
              <dt>Accepted</dt><dd>{num(data.total_accepted_qty, 0)}</dd>
              <dt>Rejected</dt><dd>{num(data.total_rejected_qty, 0)}</dd>
              <dt>Net weight</dt><dd>{num(data.total_net_weight_kg, 1)} kg</dd>
              <dt>Value</dt><dd>{inr(data.total_value)}</dd>
              <dt>Posted by</dt><dd>{data.posted_by_name}</dd>
              <dt>Posted at</dt><dd>{dateTime(data.posted_at)}</dd>
            </dl>
          </div>
        </div>
      </div>

      {costing ? (
        <CostingModal grn={data} chargeTypes={chargeTypes ?? []}
          onClose={() => setCosting(false)} onDone={() => { setCosting(false); reload(); }} />
      ) : null}

      {reversing ? (
        <ReverseModal grnId={data.id} grnNo={data.grn_no}
          onClose={() => setReversing(false)} onDone={() => { setReversing(false); reload(); }} />
      ) : null}
    </Layout>
  );
}

function CostingModal({ grn, chargeTypes, onClose, onDone }: {
  grn: any; chargeTypes: any[]; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [charges, setCharges] = useState<{ chargeTypeId: string; amount: number }[]>([
    { chargeTypeId: '', amount: 0 },
  ]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);

  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post<any>(`/costing/landing-cost/${grn.id}/compute`, {
        costStatus: 'ACTUAL',
        charges: charges.filter((c) => c.chargeTypeId && c.amount > 0),
      });
      setResult(r);
      toast(r.isAbnormal
        ? `Landed cost computed — abnormal movement on ${r.abnormalProducts.join(', ')}`
        : 'Landed cost computed', r.isAbnormal ? 'err' : 'ok');
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <Modal title={`Landed cost for ${grn.grn_no}`} onClose={onClose} wide
      footer={<>
        <button className="btn" onClick={onClose}>{result ? 'Close' : 'Cancel'}</button>
        {result ? <button className="btn primary" onClick={onDone}>Done</button>
          : <button className="btn primary" disabled={busy} onClick={run}>
              {busy ? 'Computing…' : 'Compute'}</button>}
      </>}>
      <p className="small muted mb">
        Add every cost that came with this load. Charges from the purchase order are already
        included. Transport is spread by weight, commission by value — so a heavy cheap crate does
        not subsidise a light expensive one.
      </p>
      {charges.map((c, i) => (
        <div className="row mb" key={i}>
          <select style={{ flex: 2 }} value={c.chargeTypeId}
            onChange={(e) => setCharges((s) => s.map((x, j) => j === i ? { ...x, chargeTypeId: e.target.value } : x))}>
            <option value="">Charge type…</option>
            {chargeTypes.map((ct) => (
              <option key={ct.id} value={ct.id}>{ct.name} (by {ct.allocation_basis.toLowerCase()})</option>
            ))}
          </select>
          <input style={{ flex: 1 }} type="number" placeholder="Amount ₹" value={c.amount || ''}
            onChange={(e) => setCharges((s) => s.map((x, j) => j === i ? { ...x, amount: Number(e.target.value) } : x))} />
          <button className="btn sm ghost" onClick={() => setCharges((s) => s.filter((_, j) => j !== i))}><Icon name="alert" size={15} /></button>
        </div>
      ))}
      <button className="btn sm" onClick={() => setCharges((s) => [...s, { chargeTypeId: '', amount: 0 }])}>
        Add another charge
      </button>

      {result ? (
        <div className="mt">
          <div className="table-wrap">
            <table className="data">
              <thead><tr>
                <th>Product</th><th className="num">Base</th><th className="num">Charges</th>
                <th className="num">Wastage</th><th className="num">Landed /kg</th><th className="num">vs last</th>
              </tr></thead>
              <tbody>
                {result.lines.map((l: any) => (
                  <tr key={l.grnLineId} className={l.rateChangePct != null && Math.abs(l.rateChangePct) > 15 ? 'row-crit' : ''}>
                    <td>{l.productName}</td>
                    <td className="num mono">{inr(l.baseRate)}</td>
                    <td className="num mono">{inr(l.allocatedTotal)}</td>
                    <td className="num mono">{inr(l.wastageAmount)}</td>
                    <td className="num mono"><b>{inr(l.landedRatePerKg)}</b></td>
                    <td className="num">{l.rateChangePct == null ? '—' : pctText(l.rateChangePct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

function ReverseModal({ grnId, grnNo, onClose, onDone }: {
  grnId: string; grnNo: string; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      await api.post(`/receiving/grns/${grnId}/reverse`, { reason });
      toast(`${grnNo} reversed`, 'ok');
      onDone();
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <Modal title={`Reverse ${grnNo}?`} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn danger" disabled={busy || reason.length < 6} onClick={run}>
          {busy ? 'Reversing…' : 'Reverse receipt'}
        </button>
      </>}>
      <div className="banner danger mb">
        <span><Icon name="alert" size={16} /></span>
        <div>
          This removes the stock again and reopens the purchase order lines. It only works if the
          stock has not already moved out. The original receipt stays in the records.
        </div>
      </div>
      <Field label="Reason" hint="Kept permanently in the audit trail">
        <textarea value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Wrong product posted against the order line" />
      </Field>
    </Modal>
  );
}

/* ===========================================================================
 * Put-away used to live here: a task list telling somebody to move a whole
 * batch into a bin, raised automatically when a receipt was posted.
 *
 * It is gone. The client's floor grades each box as they pack it, sticks a
 * label on it and scans it onto a shelf — that is the packing bench, and it
 * already placed the stock. Keeping both meant the same crates were placed
 * twice, once as a batch and once as boxes, and the second placement silently
 * disagreed with the first.
 *
 * Posting a receipt now raises a "grade & pack" job instead, pointing at the
 * bench for that batch. See receiving.ts, postGrn().
 * ======================================================================== */

export function StockPage() {
  const { warehouseId, can } = useAuth();
  const [code, setCode] = useState('');
  const [trace, setTrace] = useState<any>(null);
  const [issuing, setIssuing] = useState<any>(null);
  const [tab, setTab] = useState<'stock' | 'out'>('stock');
  const [sending, setSending] = useState(false);
  const centres = useApi<any[]>('/centres');
  const toast = useToast();
  const { data, loading, error, reload } = useApi<any[]>(
    `/insights/stock?warehouseId=${warehouseId ?? ''}`, [warehouseId]);
  const { data: issues, reload: reloadIssues } = useApi<any[]>(
    `/inventory/issues?warehouseId=${warehouseId ?? ''}`, [warehouseId]);

  const f = useFilters<any>(data, {
    search: (x: any) => [x.product_name, x.sku, x.batch_no, x.grade].filter(Boolean).join(' '),
    facets: [
      { key: 'p', label: 'product', of: (x: any) => x.product_name },
      { key: 'g', label: 'grade', of: (x: any) => x.grade },
      { key: 's', label: 'status', of: (x: any) => x.status },
      /* Not a column on the row — a question the warehouse asks daily and
       * could not previously answer without reading every line. */
      { key: 'exp', label: 'shelf life', all: 'Any shelf life', of: (x: any) =>
        x.days_to_expiry == null ? null
          : x.days_to_expiry <= 1 ? 'goes today'
          : x.days_to_expiry <= 3 ? 'this week' : 'plenty of time' },
    ],
    totals: [
      { label: 'On hand', of: (x: any) => Number(x.qty) || 0 },
      { label: 'Available', of: (x: any) => Number(x.available_qty) || 0 },
      { label: 'Weight kg', of: (x: any) => Number(x.weight_kg) || 0, decimals: 1 },
      { label: 'Worth', of: (x: any) =>
        (Number(x.qty) || 0) * (Number(x.landed_rate) || 0), money: true },
    ],
  });
  const fOut = useFilters<any>(issues, {
    date: (r: any) => r.issue_date,
    search: (r: any) => [r.issue_no, r.party_name, r.reference_no, r.note, r.posted_by_name,
      ...(r.lines ?? []).map((l: any) => `${l.productName} ${l.batchNo}`)].filter(Boolean).join(' '),
    facets: [
      { key: 'why', label: 'reason', of: (r: any) => r.reason },
      { key: 'to', label: 'destination', of: (r: any) => r.party_name },
      { key: 'by', label: 'posted by', of: (r: any) => r.posted_by_name },
      { key: 'st', label: 'state', all: 'Any state', of: (r: any) =>
        (r.status === 'CANCELLED' ? 'cancelled' : 'posted') },
    ],
    totals: [
      { label: 'Issues', of: () => 1 },
      { label: 'Quantity', of: (r: any) => Number(r.total_qty) || 0, decimals: 1 },
      { label: 'Value', of: (r: any) => Number(r.total_value) || 0, money: true },
    ],
  });

  const lookup = async () => {
    if (!code) return;
    try {
      setTrace(await api.get<any>(`/receiving/trace/${encodeURIComponent(code.trim())}`));
    } catch (e: any) { toast(e.message, 'err'); }
  };

  return (
    <Layout title="Stock &amp; batches"
      subtitle="What is in the warehouse, where it came from, and where it went"
      /* The warehouse person stands on this page. Sending a load to a shop is
         something they do from here, not from a screen about shops. */
      actions={can('inventory.stock.issue') ? (
        <button className="btn sm primary" onClick={() => setSending(true)}>
          Send to a centre
        </button>
      ) : undefined}>
      <ErrorBanner error={error} />
      <div className="tabs">
        <button className={`tab ${tab === 'stock' ? 'active' : ''}`} onClick={() => setTab('stock')}>
          On hand
        </button>
        <button className={`tab ${tab === 'out' ? 'active' : ''}`} onClick={() => setTab('out')}>
          Issued out{issues?.length ? ` (${issues.length})` : ''}
        </button>
      </div>
      {tab === 'out' ? <IssuedOutTable f={fOut} /> : <>
      {/* Tracing and filtering are different questions — "show me this exact
          label" against "show me these batches" — and two identical-looking
          boxes stacked one above the other made people type into the wrong one.
          One bar, with the scanner box marked as its own thing. */}
      <FilterBar f={f} placeholder="Search product, batch, grade">
        <span className="spacer" />
        <input className="mono" style={{ maxWidth: 230 }} value={code}
          placeholder="Scan a label to trace…"
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && lookup()} />
        <button className="btn" disabled={!code.trim()} onClick={lookup}>Trace</button>
      </FilterBar>
      <FilterTotals f={f} noun="batch" />
      <div className="card"><div className="card-body tight">
        <DataTable
          rows={f.rows} loading={loading}
          rowTone={(s: any) => (s.days_to_expiry != null && s.days_to_expiry <= 1 ? 'crit'
            : s.days_to_expiry != null && s.days_to_expiry <= 3 ? 'warn' : undefined)}
          cols={[
            { key: 'p', head: 'Product', render: (s: any) => (
              <div><b>{s.product_name}</b><div className="small muted">{s.sku}</div></div>
            ) },
            { key: 'b', head: 'Batch', render: (s: any) => <span className="mono small">{s.batch_no}</span> },
            { key: 'g', head: 'Grade', render: (s: any) => <Chip tone="neutral">{s.grade ?? '—'}</Chip> },
            { key: 'q', head: 'Quantity', num: true, render: (s: any) => num(s.qty, 0) },
            { key: 'a', head: 'Available', num: true, render: (s: any) => num(s.available_qty, 0) },
            { key: 'w', head: 'Weight', num: true, render: (s: any) => `${num(s.weight_kg, 1)} kg` },
            { key: 'e', head: 'Expires', render: (s: any) => (
              <div className="small">{date(s.effective_expiry)}
                {s.days_to_expiry != null ? (
                  <div><Chip tone={s.days_to_expiry <= 1 ? 'danger' : s.days_to_expiry <= 3 ? 'warn' : 'neutral'}>
                    {s.days_to_expiry}d left</Chip></div>
                ) : null}</div>
            ) },
            { key: 'r', head: 'Landed rate', num: true, render: (s: any) => inr(s.landed_rate) },
            { key: 's', head: 'Status', render: (s: any) => <Chip value={s.status} /> },
            ...(can('inventory.stock.issue') ? [{
              key: 'x', head: '', width: 92,
              render: (s: any) => (
                <button className="btn sm" onClick={(e) => { e.stopPropagation(); setIssuing(s); }}>
                  Issue →
                </button>),
            }] : []),
          ]}
          empty={<Empty icon="🧺" title={f.active > 0
            ? 'No batch matches those filters' : 'No stock on hand'} />}
        />
      </div></div>
      </>}

      {sending ? (
        <SendToCentreModal
          centres={(centres.data ?? []).filter((c: any) => c.is_centre)}
          fromWarehouseId={warehouseId ?? ''}
          onClose={() => setSending(false)}
          onDone={(m) => { setSending(false); reload(); reloadIssues(); toast(m, 'ok'); setTab('out'); }} />
      ) : null}

      {trace ? (
        <Modal title={`Label ${trace.code}`} onClose={() => setTrace(null)}
          footer={<button className="btn" onClick={() => setTrace(null)}>Close</button>}>
          <dl className="kv">
            <dt>Product</dt><dd>{trace.product_name} ({trace.sku})</dd>
            <dt>Batch</dt><dd className="mono">{trace.batch_no}</dd>
            <dt>Grade</dt><dd>{trace.grade ?? '—'}</dd>
            <dt>Received</dt><dd>{date(trace.received_date)}</dd>
            <dt>Expires</dt><dd>{date(trace.expiry_date)}</dd>
            <dt>Quantity left</dt><dd>{num(trace.remaining_qty, 0)} of {num(trace.initial_qty, 0)}</dd>
            <dt>Supplier</dt><dd>{trace.supplier_name} ({trace.source_type})</dd>
            {trace.farm_name ? <><dt>Farm</dt><dd>{trace.farm_name}, {trace.village}</dd></> : null}
            <dt>Goods receipt</dt><dd className="mono">{trace.grn_no}</dd>
            <dt>Came in on</dt><dd className="mono">{trace.vehicle_reg_captured} · {trace.gate_no}</dd>
            {trace.actual_weight_kg ? <><dt>Crate weight</dt><dd>{num(trace.actual_weight_kg, 2)} kg</dd></> : null}
          </dl>
        </Modal>
      ) : null}

      {issuing ? (
        <IssueStockModal row={issuing} onClose={() => setIssuing(null)}
          onDone={() => { setIssuing(null); reload(); reloadIssues(); }} />
      ) : null}
    </Layout>
  );
}

/* ===========================================================================
 * WHERE STOCK WENT.
 *
 * The counterpart to the goods-receipt list. Until this existed the warehouse
 * could only ever see what arrived, never what left — so the balance was the
 * only evidence a crate had gone, and it carried no reason and no name.
 * ======================================================================== */
function IssuedOutTable({ f }: { f: ReturnType<typeof useFilters<any>> }) {
  return (
    <div className="card"><div className="card-body tight">
      <FilterBar f={f} placeholder="Search issue, destination, product" />
      <FilterTotals f={f} noun="issue" />
      <DataTable rows={f.rows} cols={[
        { key: 'n', head: 'Issue', render: (r: any) => (
          <div><b className="mono">{r.issue_no}</b>
            <div className="small muted">{date(r.issue_date)}</div></div>) },
        { key: 'r', head: 'Why', render: (r: any) => (
          <Chip tone={r.reason === 'SALE' ? 'ok'
            : ['WASTAGE', 'ADJUSTMENT'].includes(r.reason) ? 'danger' : 'primary'}>
            {r.reason.replace(/_/g, ' ').toLowerCase()}
          </Chip>) },
        { key: 'w', head: 'What', render: (r: any) => (
          <div className="small">
            {(r.lines ?? []).map((l: any, i: number) => (
              <div key={i}>{l.productName} · {num(l.qty, 1)} {l.uom}
                <span className="muted"> ({l.batchNo})</span></div>))}
          </div>) },
        { key: 'p', head: 'To / why', render: (r: any) => (
          <div>{r.party_name ?? '—'}
            {r.reference_no ? <div className="small muted">{r.reference_no}</div> : null}
            {r.note ? <div className="small muted">{r.note}</div> : null}</div>) },
        { key: 'q', head: 'Qty', num: true, render: (r: any) => num(r.total_qty, 1) },
        { key: 'v', head: 'Value', num: true, render: (r: any) => inr(r.total_value, 0) },
        { key: 'b', head: 'By', render: (r: any) => (
          <span className="small muted">{r.posted_by_name}</span>) },
        { key: 's', head: '', render: (r: any) =>
          r.status === 'CANCELLED' ? <Chip tone="neutral">cancelled</Chip> : null },
      ]} rowTone={(r: any) => (r.status !== 'CANCELLED'
        && ['WASTAGE', 'ADJUSTMENT'].includes(r.reason) ? 'warn' : undefined)}
        empty={<Empty icon="📤"
          title={f.active > 0 ? 'Nothing matches those filters'
            : 'Nothing has left the warehouse yet'}
          hint={f.active > 0 ? 'Clear a filter to widen the search.'
            : 'Sales, transfers, wastage and consumption all appear here.'} />} />
    </div></div>
  );
}

const ISSUE_REASONS = [
  { v: 'SALE',         label: 'Sale — sold to a customer',                       needsNote: false },
  { v: 'TRANSFER_OUT', label: 'Transfer — sent to another branch or warehouse',  needsNote: true },
  { v: 'CONSUMPTION',  label: 'Consumed — used internally, staff, samples',      needsNote: true },
  { v: 'RETURN',       label: 'Returned to the supplier',                        needsNote: true },
  { v: 'WASTAGE',      label: 'Wastage — spoiled or thrown away',                needsNote: true, writeOff: true },
  { v: 'ADJUSTMENT',   label: 'Adjustment — correcting a count',                 needsNote: true, writeOff: true },
];

/**
 * Issuing is receiving in reverse, so it asks the same three questions a
 * receipt asks — what, how much, and why — and guesses none of them.
 */
function IssueStockModal({ row, onClose, onDone }: {
  row: any; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const { can } = useAuth();
  const [reason, setReason] = useState('SALE');
  const [qty, setQty] = useState('');
  const [rate, setRate] = useState('');
  const [party, setParty] = useState('');
  const [ref, setRef] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => idempotencyKey('issue'));

  const def = ISSUE_REASONS.find((r) => r.v === reason)!;
  const uom = row.base_uom ?? 'KG';
  const available = Number(row.available_qty ?? row.qty);
  const n = Number(qty) || 0;
  const cost = Number(row.landed_rate ?? 0);
  const over = n > available + 0.001;
  const canWriteOff = can('inventory.stock.writeoff');

  // A sale has a margin; everything else is simply value leaving.
  const value = reason === 'SALE' ? n * (Number(rate) || 0) : n * cost;
  const margin = reason === 'SALE' ? value - n * cost : null;

  return (
    <Modal title={`Issue ${row.product_name} out of stock`} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary"
          disabled={busy || !n || over || (def.needsNote && !note.trim())
            || (!!def.writeOff && !canWriteOff)}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api.post<any>('/inventory/issues', {
                idempotencyKey: key,
                warehouseId: row.warehouse_id,
                reason,
                partyName: party || undefined,
                referenceNo: ref || undefined,
                note: note || undefined,
                lines: [{ batchId: row.batch_id, qty: n, rate: rate ? Number(rate) : null }],
              });
              toast(`${r.issue_no} posted — ${num(r.totalQty, 1)} ${uom} out of stock`, 'ok');
              onDone();
            } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
          }}>Post issue</button>
      </>}>

      <dl className="kv mb">
        <dt>Batch</dt><dd className="mono">{row.batch_no}</dd>
        <dt>Available</dt><dd>{num(available, 2)} {uom}</dd>
        <dt>Expires</dt><dd>{date(row.effective_expiry ?? row.expiry_date)}</dd>
        <dt>Cost carried</dt><dd>{inr(cost)} per {uom}</dd>
      </dl>

      <Field label="Why is it leaving?">
        <select value={reason} onChange={(e) => setReason(e.target.value)}>
          {ISSUE_REASONS.map((r) => (
            <option key={r.v} value={r.v} disabled={!!r.writeOff && !canWriteOff}>
              {r.label}{r.writeOff && !canWriteOff ? ' — needs a manager' : ''}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid c2">
        <Field label={`Quantity (${uom})`}
          error={over ? `Only ${num(available, 2)} ${uom} available` : undefined}>
          <input type="number" step="0.01" value={qty} autoFocus
            onChange={(e) => setQty(e.target.value)} />
        </Field>
        {reason === 'SALE' ? (
          <Field label={`Selling rate (₹ per ${uom})`} hint={`It cost you ${inr(cost)}`}>
            <input type="number" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} />
          </Field>
        ) : (
          <Field label="Value leaving" hint="Valued at what it cost you">
            <input readOnly value={inr(value)} />
          </Field>
        )}
      </div>

      {reason === 'SALE' ? (
        <div className="grid c2">
          <Field label="Sold to"><input value={party} placeholder="Customer or shop"
            onChange={(e) => setParty(e.target.value)} /></Field>
          <Field label="Their reference"><input value={ref} placeholder="SO / challan no."
            onChange={(e) => setRef(e.target.value)} /></Field>
        </div>
      ) : null}

      <Field label={def.needsNote ? 'Reason (required)' : 'Note (optional)'}
        hint={def.needsNote
          ? 'Stock that disappears without a written reason is exactly what this system exists to prevent.'
          : undefined}>
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>

      {n > 0 && !over ? (
        <div className={`banner ${margin != null && margin < 0 ? 'warn' : 'info'}`}>
          <span>{margin != null && margin < 0 ? '⚠' : 'ℹ'}</span>
          <div className="small">
            <b>{num(n, 2)} {uom}</b> leaves, {num(available - n, 2)} {uom} stays.
            {margin != null ? (
              margin < 0
                ? <> Selling at {inr(Number(rate) || 0)} against a cost of {inr(cost)} —
                    a loss of <b>{inr(Math.abs(margin), 0)}</b> on this issue.</>
                : <> Revenue {inr(value, 0)}, cost {inr(n * cost, 0)}, margin <b>{inr(margin, 0)}</b>.</>
            ) : <> Value written out of stock: <b>{inr(value, 0)}</b>.</>}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
