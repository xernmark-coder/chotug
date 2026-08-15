import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, useAuth, inr, num, date, dateTime, pctText } from '../lib/api';
import {
  Chip, DataTable, Empty, ErrorBanner, Field, Layout, Loading, Modal, useApi, useToast,
} from '../components/ui';

/* ====================================================== GRN LIST ========= */
export function GrnListPage() {
  const nav = useNavigate();
  const { data, loading, error } = useApi<any[]>('/receiving/grns');

  return (
    <Layout title="Goods receipts" subtitle="Everything that has entered stock">
      <ErrorBanner error={error} />
      <div className="card"><div className="card-body tight">
        <DataTable
          rows={data ?? []} loading={loading}
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
          empty={<Empty icon="📥" title="No goods receipts yet" />}
        />
      </div></div>
    </Layout>
  );
}

/* ==================================================== GRN DETAIL ======== */
export function GrnDetailPage() {
  const { id } = useParams();
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
      {data.is_backdated ? (
        <div className="banner warn mb"><span>📅</span>
          <div>This receipt was back-dated to {date(data.posting_date)}.</div></div>
      ) : null}
      {actual?.is_abnormal ? (
        <div className="banner danger mb">
          <span>💸</span>
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
          <button className="btn sm ghost" onClick={() => setCharges((s) => s.filter((_, j) => j !== i))}>✕</button>
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
        <span>⚠</span>
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

/* ====================================================== PUT-AWAY ======== */
export function PutawayPage() {
  const toast = useToast();
  const { warehouseId, can } = useAuth();
  const { data, loading, error, reload } = useApi<any[]>(
    `/receiving/putaway?warehouseId=${warehouseId ?? ''}`, [warehouseId]);
  const { data: bins } = useApi<any[]>(`/masters/bins?warehouseId=${warehouseId ?? ''}`, [warehouseId]);
  const [task, setTask] = useState<any>(null);
  const [binId, setBinId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    try {
      await api.post(`/receiving/putaway/${task.id}/confirm`, {
        actualBinId: binId, mismatchReason: reason || null,
      });
      toast('Put-away confirmed', 'ok');
      setTask(null); setBinId(''); setReason('');
      reload();
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const mismatch = task && task.suggested_bin_id && binId && binId !== task.suggested_bin_id;

  return (
    <Layout title="Put-away" subtitle="Move received stock to its bin" touch
      actions={<button className="btn sm" onClick={reload}>Refresh</button>}>
      <ErrorBanner error={error} />
      <div className="card"><div className="card-body tight">
        <DataTable
          rows={data ?? []} loading={loading}
          onRowClick={(t: any) => { setTask(t); setBinId(t.suggested_bin_id ?? ''); }}
          cols={[
            { key: 'p', head: 'Product', render: (t: any) => (
              <div><b>{t.product_name}</b><div className="small muted">{t.sku} · {t.storage_type}</div></div>
            ) },
            { key: 'b', head: 'Batch', render: (t: any) => (
              <div className="small"><span className="mono">{t.batch_no}</span>
                {t.expiry_date ? <div className="muted">expires {date(t.expiry_date)}</div> : null}</div>
            ) },
            { key: 'q', head: 'Quantity', num: true, render: (t: any) => (
              <div>{num(t.qty, 0)}<div className="small muted">{num(t.weight_kg, 1)} kg</div></div>
            ) },
            { key: 'r', head: 'Rule', render: (t: any) => <Chip tone="neutral">{t.rotation_rule}</Chip> },
            { key: 's', head: 'Put it here', render: (t: any) => (
              <b className="mono">{t.suggested_zone_code}/{t.suggested_rack_code}/{t.suggested_bin_code ?? '—'}</b>
            ) },
            { key: 'a', head: '', width: 110, render: () => <span className="btn sm primary">Confirm</span> },
          ]}
          empty={<Empty icon="🏷️" title="Nothing waiting to be put away" />}
        />
      </div></div>

      {task ? (
        <Modal title={`Put away ${task.product_name}`} onClose={() => setTask(null)}
          footer={<>
            <button className="btn" onClick={() => setTask(null)}>Cancel</button>
            <button className="btn primary" disabled={busy || !binId || (!!mismatch && reason.length < 3)}
              onClick={confirm}>Confirm put-away</button>
          </>}>
          <dl className="kv mb">
            <dt>Batch</dt><dd className="mono">{task.batch_no}</dd>
            <dt>Quantity</dt><dd>{num(task.qty, 0)} ({num(task.weight_kg, 1)} kg)</dd>
            <dt>Expires</dt><dd>{date(task.expiry_date)}</dd>
            <dt>Rotation</dt><dd>{task.rotation_rule} — oldest goes out first</dd>
            <dt>Suggested bin</dt>
            <dd className="mono">{task.suggested_zone_code}/{task.suggested_rack_code}/{task.suggested_bin_code}</dd>
          </dl>
          <Field label="Which bin did you actually use?">
            <select value={binId} onChange={(e) => setBinId(e.target.value)}>
              <option value="">Choose a bin…</option>
              {(bins ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.zone_code}/{b.rack_code}/{b.code} — {b.storage_type}
                  {b.capacity_kg ? ` (${num(b.current_fill_kg, 0)}/${num(b.capacity_kg, 0)} kg)` : ''}
                </option>
              ))}
            </select>
          </Field>
          {mismatch ? (
            <Field label="Why a different bin?" hint="This is recorded and reviewed">
              <input value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Suggested bin was full" />
            </Field>
          ) : null}
        </Modal>
      ) : null}
    </Layout>
  );
}

/* ==================================================== STOCK & TRACE ===== */
export function StockPage() {
  const { warehouseId } = useAuth();
  const [code, setCode] = useState('');
  const [trace, setTrace] = useState<any>(null);
  const toast = useToast();
  const { data, loading, error } = useApi<any[]>(
    `/insights/stock?warehouseId=${warehouseId ?? ''}`, [warehouseId]);

  const lookup = async () => {
    if (!code) return;
    try {
      setTrace(await api.get<any>(`/receiving/trace/${encodeURIComponent(code.trim())}`));
    } catch (e: any) { toast(e.message, 'err'); }
  };

  return (
    <Layout title="Stock &amp; batches" subtitle="What is in the warehouse, and where it came from">
      <ErrorBanner error={error} />
      <div className="search-bar">
        <input placeholder="Scan or type a label code to trace…" value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && lookup()} />
        <button className="btn" onClick={lookup}>Trace</button>
      </div>

      <div className="card"><div className="card-body tight">
        <DataTable
          rows={data ?? []} loading={loading}
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
          ]}
          empty={<Empty icon="🧺" title="No stock on hand" />}
        />
      </div></div>

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
    </Layout>
  );
}
