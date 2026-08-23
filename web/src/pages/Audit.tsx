import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { api, useAuth, inr, num, date, dateTime, ago } from '../lib/api';
import {
  Chip, DataTable, Empty, ErrorBanner, Field, Kpi, Layout, Loading, Modal, useApi, useToast,
  FilterBar, FilterTotals, useFilters,
} from '../components/ui';
import { Icon } from '../components/icons';

/* ===========================================================================
 * THE AUDIT DESK
 *
 * Two facts, kept apart on purpose:
 *
 *   a TASK   — somebody was asked to go and look. Who asked, why, by when.
 *   a COUNT  — what was found on one shelf, with the book figure as it stood
 *              at that moment.
 *
 * An audit that finds nothing wrong is still work that was done, and a shelf
 * nobody asked about but somebody counted anyway is still a finding.
 *
 * Nothing here moves stock. The auditor reports; correcting the books is a
 * separate, deliberate act by somebody with that right. An audit that quietly
 * rewrote the ledger would be the easiest theft in the building — so the
 * AUDITOR role cannot issue, adjust or sell.
 * ======================================================================== */

const CONDITIONS = [
  { key: 'GOOD', label: 'All good', tone: 'ok' },
  { key: 'DAMAGED', label: 'Damaged', tone: 'warn' },
  { key: 'SPOILED', label: 'Spoiled', tone: 'danger' },
  { key: 'EXPIRED', label: 'Expired', tone: 'danger' },
  { key: 'MISSING', label: 'Missing', tone: 'danger' },
  { key: 'MISPLACED', label: 'On the wrong shelf', tone: 'warn' },
];

export function AuditPage() {
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const [tab, setTab] = useState<'todo' | 'done' | 'findings'>('todo');
  const tasks = useApi<any[]>('/warehouse/audits');
  const summary = useApi<any>('/warehouse/audits-summary');
  const [raising, setRaising] = useState(false);
  const [scanning, setScanning] = useState(false);

  const rows = tasks.data ?? [];
  const todo = rows.filter((t: any) => ['OPEN', 'IN_PROGRESS'].includes(t.status));
  const done = rows.filter((t: any) => !['OPEN', 'IN_PROGRESS'].includes(t.status));

  const f = useFilters<any>(tab === 'todo' ? todo : done, {
    date: (t: any) => t.raised_at,
    search: (t: any) => [t.task_no, t.scope_path, t.product_name, t.warehouse_name,
      t.reason, t.raised_by_name].filter(Boolean).join(' '),
    facets: [
      { key: 'wh', label: 'warehouse', of: (t: any) => t.warehouse_name },
      { key: 'pr', label: 'product', of: (t: any) => t.product_name },
      { key: 'pi', label: 'priority', of: (t: any) => t.priority },
      { key: 'by', label: 'asked by', of: (t: any) => t.raised_by_name },
      { key: 'st', label: 'state', of: (t: any) => t.status },
      { key: 'ls', label: 'outcome', of: (t: any) =>
        (Number(t.loss_qty) > 0 ? 'loss found' : Number(t.counts) > 0 ? 'matched' : null) },
    ],
    totals: [
      { label: 'Audits', of: () => 1 },
      { label: 'Shelves counted', of: (t: any) => Number(t.counts) || 0 },
      { label: 'Loss', of: (t: any) => Number(t.loss_value) || 0, money: true },
    ],
  });
  const k = summary.data?.kpis ?? {};

  return (
    <Layout
      title="Audit"
      subtitle="Count what is actually there, and record what is wrong with it"
      actions={
        <div className="btn-row">
          {can('audit.count.record') ? (
            <button className="btn sm primary" onClick={() => setScanning(true)}>
              <Icon name="compass" size={15} /> Scan a shelf
            </button>
          ) : null}
          {can('audit.task.raise') ? (
            <button className="btn sm" onClick={() => setRaising(true)}>Ask for an audit</button>
          ) : null}
        </div>
      }
    >
      <ErrorBanner error={tasks.error} />

      <div className="grid c4 mb">
        <Kpi label="Waiting to be counted" value={k.open ?? 0}
          tone={(k.overdue ?? 0) > 0 ? 'crit' : (k.open ?? 0) > 0 ? 'warn' : 'good'}
          foot={(k.overdue ?? 0) > 0 ? `${k.overdue} past due` : `${k.in_progress ?? 0} in progress`} />
        <Kpi label="Shelves counted, 30 days" value={k.counts_30d ?? 0} />
        <Kpi label="Did not match the books" value={k.mismatches_30d ?? 0}
          tone={(k.mismatches_30d ?? 0) > 0 ? 'warn' : 'good'}
          foot="of everything counted" />
        <Kpi label="Written off, 30 days" value={inr(k.loss_value_30d, 0)}
          tone={Number(k.loss_value_30d) > 0 ? 'crit' : 'good'}
          foot="at landed cost" />
      </div>

      <div className="tabs">
        {([['todo', `To count (${todo.length})`],
           ['done', `Done (${done.length})`],
           ['findings', 'What we keep losing']] as const).map(([key, label]) => (
          <button key={key} className={`tab ${tab === key ? 'active' : ''}`}
            onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>

      {tab !== 'findings' ? (
        <div className="card"><div className="card-body tight">
          <FilterBar f={f} placeholder="Search audit, shelf, product, reason" />
          <FilterTotals f={f} noun="audit" />
          <DataTable
            loading={tasks.loading}
            rows={f.rows}
            rowTone={(t: any) => (t.overdue ? 'crit' : t.priority === 'URGENT' ? 'warn' : undefined)}
            onRowClick={(t: any) => nav(`/audit/${t.id}`)}
            cols={[
              { key: 'n', head: 'Audit', render: (t: any) => (
                <div><b className="mono">{t.task_no}</b>
                  <div className="small muted">{ago(t.raised_at)} · {t.raised_by_name}</div></div>) },
              { key: 'w', head: 'What to look at', render: (t: any) => (
                <div><b>{t.scope_path ?? t.product_name ?? t.warehouse_name ?? 'Whole warehouse'}</b>
                  <div className="small muted">{t.reason}</div></div>) },
              { key: 'p', head: '', render: (t: any) =>
                t.priority === 'URGENT' ? <Chip tone="danger">urgent</Chip>
                : t.priority === 'HIGH' ? <Chip tone="warn">high</Chip> : null },
              { key: 'd', head: 'Due', render: (t: any) => (
                t.due_date
                  ? <span className={t.overdue ? 'chip danger' : 'small'}>{date(t.due_date)}</span>
                  : <span className="muted small">—</span>) },
              { key: 'c', head: 'Counted', num: true, render: (t: any) => t.counts },
              { key: 'l', head: 'Loss', num: true, render: (t: any) =>
                Number(t.loss_qty) > 0
                  ? <b className="text-danger">{num(t.loss_qty, 1)} · {inr(t.loss_value, 0)}</b>
                  : <span className="muted">—</span> },
              { key: 's', head: '', render: (t: any) => (
                t.status === 'DONE' ? <Chip tone="ok">done</Chip>
                : t.status === 'IN_PROGRESS' ? <Chip tone="primary">counting</Chip>
                : t.status === 'CANCELLED' ? <Chip>cancelled</Chip>
                : <Chip tone="warn">to do</Chip>) },
            ]}
            empty={<Empty icon="🔎"
              title={f.active > 0 ? 'No audit matches those filters'
                : tab === 'todo' ? 'Nothing waiting to be counted' : 'No audits closed yet'}
              hint={f.active > 0 ? 'Clear a filter to widen the search.'
                : tab === 'todo' ? 'Anyone can ask for a shelf or a product to be checked.' : undefined} />}
          />
        </div></div>
      ) : (
        <div className="grid c2">
          <div className="card">
            <div className="card-head"><h2>Where the losses are, 90 days</h2></div>
            <div className="card-body">
              {(summary.data?.worst ?? []).length ? (
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={summary.data.worst} layout="vertical" margin={{ left: 90, right: 16 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 11 }}
                      tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}k`} />
                    <YAxis type="category" dataKey="product_name" width={86} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v: any) => inr(v, 0)} />
                    <Bar dataKey="loss_value" fill="#B91C1C" radius={[0, 3, 3, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <Empty icon="✅" title="Nothing written off in 90 days" />}
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h2>What was wrong with it</h2></div>
            <div className="card-body tight">
              <DataTable rows={summary.data?.byCondition ?? []} cols={[
                { key: 'c', head: 'Condition', render: (r: any) => {
                  const c = CONDITIONS.find((x) => x.key === r.condition);
                  return <Chip tone={(c?.tone ?? 'neutral') as any}>{c?.label ?? r.condition}</Chip>;
                } },
                { key: 'n', head: 'Times', num: true, render: (r: any) => r.n },
                { key: 'q', head: 'Quantity lost', num: true, render: (r: any) => num(r.loss_qty, 1) },
                { key: 'v', head: 'Value', num: true, render: (r: any) => inr(r.loss_value, 0) },
              ]} empty={<Empty title="Nothing recorded yet" />} />
            </div>
          </div>
        </div>
      )}

      {raising ? (
        <RaiseAuditModal onClose={() => setRaising(false)}
          onDone={(m) => { setRaising(false); tasks.reload(); summary.reload(); toast(m, 'ok'); }} />
      ) : null}
      {scanning ? (
        <ScanShelfModal onClose={() => setScanning(false)}
          onDone={() => { tasks.reload(); summary.reload(); }} />
      ) : null}
    </Layout>
  );
}

/* --------------------------------------------------------- one audit ----- */

export function AuditDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<any>(`/warehouse/audits/${id}`, [id]);
  const [scanning, setScanning] = useState(false);
  const [closing, setClosing] = useState(false);

  if (loading) return <Layout title="Audit"><Loading /></Layout>;
  if (error) return <Layout title="Audit"><ErrorBanner error={error} /></Layout>;

  const open = ['OPEN', 'IN_PROGRESS'].includes(data.status);
  const loss = (data.counts ?? []).reduce((a: number, c: any) => a + Number(c.loss_value ?? 0), 0);

  return (
    <Layout
      title={data.task_no}
      subtitle={data.reason}
      actions={
        <div className="btn-row">
          <button className="btn sm" onClick={() => nav('/audit')}>All audits</button>
          {open && can('audit.count.record') ? (
            <>
              <button className="btn sm" onClick={() => setScanning(true)}>Count a shelf</button>
              <button className="btn sm primary" onClick={() => setClosing(true)}>Close this audit</button>
            </>
          ) : null}
        </div>
      }
    >
      <div className="grid c4 mb">
        <Kpi label="Shelves counted" value={(data.counts ?? []).length} />
        <Kpi label="Did not match" value={(data.counts ?? [])
          .filter((c: any) => Math.abs(Number(c.variance_qty)) > 0.001).length}
          tone={(data.counts ?? []).some((c: any) => Math.abs(Number(c.variance_qty)) > 0.001)
            ? 'warn' : 'good'} />
        <Kpi label="Written off" value={inr(loss, 0)} tone={loss > 0 ? 'crit' : 'good'} />
        <Kpi label="Status" value={data.status.replace('_', ' ').toLowerCase()}
          foot={data.assigned_to_name ? `with ${data.assigned_to_name}` : 'unassigned'} />
      </div>

      {data.findings ? (
        <div className="card mb">
          <div className="card-head"><h2>What the audit found</h2></div>
          <div className="card-body">
            <p>{data.findings}</p>
            <p className="small muted">
              Closed {dateTime(data.completed_at)} · asked for by {data.raised_by_name}
            </p>
          </div>
        </div>
      ) : null}

      <div className="card">
        <div className="card-head"><h2>Every shelf counted</h2></div>
        <div className="card-body tight">
          <DataTable
            rows={data.counts ?? []}
            rowTone={(c: any) => (Number(c.loss_qty) > 0 ? 'crit'
              : Math.abs(Number(c.variance_qty)) > 0.001 ? 'warn' : undefined)}
            cols={[
              { key: 'w', head: 'Where', render: (c: any) => (
                c.bin_code
                  ? <div><b>{c.bin_code}</b><div className="small muted">rack {c.rack_code}</div></div>
                  : <span className="muted small">no shelf</span>) },
              { key: 'p', head: 'Product', render: (c: any) => (
                <div>{c.product_name}
                  {c.batch_no ? <div className="small muted mono">{c.batch_no}</div> : null}</div>) },
              { key: 'e', head: 'Books said', num: true, render: (c: any) => num(c.expected_qty, 1) },
              { key: 'c', head: 'Counted', num: true, render: (c: any) => <b>{num(c.counted_qty, 1)}</b> },
              { key: 'v', head: 'Difference', num: true, render: (c: any) => {
                const v = Number(c.variance_qty);
                return Math.abs(v) < 0.001
                  ? <Chip tone="ok">matches</Chip>
                  : <b className={v < 0 ? 'text-danger' : ''}>{v > 0 ? '+' : ''}{num(v, 1)}</b>;
              } },
              { key: 'q', head: 'Condition', render: (c: any) => {
                const x = CONDITIONS.find((y) => y.key === c.condition);
                return <div><Chip tone={(x?.tone ?? 'neutral') as any}>{x?.label ?? c.condition}</Chip>
                  {c.note ? <div className="small muted">{c.note}</div> : null}</div>;
              } },
              { key: 'l', head: 'Written off', num: true, render: (c: any) =>
                Number(c.loss_qty) > 0
                  ? <div><b className="text-danger">{num(c.loss_qty, 1)}</b>
                      <div className="small muted">{inr(c.loss_value, 0)}</div></div>
                  : <span className="muted">—</span> },
              { key: 'b', head: 'By', render: (c: any) => (
                <div className="small">{c.counted_by_name}
                  <div className="muted">{ago(c.counted_at)}</div></div>) },
            ]}
            empty={<Empty icon="📋" title="Nothing counted yet"
              hint="Scan a shelf and record what is on it." />}
          />
        </div>
      </div>

      {scanning ? (
        <ScanShelfModal taskId={id} onClose={() => setScanning(false)} onDone={reload} />
      ) : null}
      {closing ? (
        <CloseAuditModal task={data} onClose={() => setClosing(false)}
          onDone={(m) => { setClosing(false); reload(); toast(m, 'ok'); }} />
      ) : null}
    </Layout>
  );
}

/* ------------------------------------------------------------- modals ---- */

/**
 * Scan, then count. The shelf tells you what the books think is on it before
 * you say what is actually there — which is the right order: the auditor should
 * see the claim they are checking.
 */
function ScanShelfModal({ taskId, onClose, onDone }: {
  taskId?: string; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [code, setCode] = useState('');
  const [found, setFound] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  const [productId, setProductId] = useState('');
  const [batchId, setBatchId] = useState('');
  const [counted, setCounted] = useState('');
  const [condition, setCondition] = useState('GOOD');
  const [lossQty, setLossQty] = useState('');
  const [note, setNote] = useState('');

  const scan = async () => {
    if (!code.trim()) return;
    setBusy(true); setError(null);
    try {
      const r = await api.get<any>(`/warehouse/scan/${encodeURIComponent(code.trim())}`);
      if (!r.found) { toast(r.message, 'err'); setFound(null); return; }
      if (r.kind === 'PACK') {
        toast(`That is a box label (${r.pack.product_name}). Scan the shelf instead.`, 'err');
        return;
      }
      setFound(r);
      if (r.contents?.length === 1) {
        setProductId(r.contents[0].product_id ?? '');
        setBatchId(r.contents[0].batch_id ?? '');
      }
    } catch (e: any) { setError(e); } finally { setBusy(false); }
  };

  const record = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.post<any>('/warehouse/audits/counts', {
        taskId, scannedQr: found.location.qr_code, productId,
        batchId: batchId || undefined,
        countedQty: Number(counted) || 0,
        condition,
        lossQty: Number(lossQty) || 0,
        note: note.trim() || undefined,
      });
      toast(r.message, Math.abs(Number(r.variance_qty)) > 0.001 ? 'err' : 'ok');
      setCounted(''); setLossQty(''); setNote(''); setCondition('GOOD');
      onDone();
    } catch (e: any) { setError(e); } finally { setBusy(false); }
  };

  const needsNote = condition !== 'GOOD' || Number(lossQty) > 0;

  return (
    <Modal
      title="Count a shelf"
      onClose={onClose}
      wide
      footer={<>
        <button className="btn" onClick={onClose}>Done</button>
        {found ? (
          <button className="btn primary"
            disabled={busy || !productId || counted === '' || (needsNote && !note.trim())}
            onClick={record}>Record what is there</button>
        ) : (
          <button className="btn primary" disabled={busy || !code.trim()} onClick={scan}>
            {busy ? 'Looking…' : 'Find the shelf'}
          </button>
        )}
      </>}
    >
      <ErrorBanner error={error} />
      <Field label="Scan the shelf label, or type its code"
        hint="Point the camera at the sticker — the code lands here as if it were typed.">
        <input value={code} autoFocus onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); scan(); } }}
          placeholder="SH-D63H9A" />
      </Field>

      {found ? (
        <>
          <div className="banner info mb">
            <span><Icon name="info" size={16} /></span>
            <div>
              <b>{found.location.path}</b>
              <div className="small">
                {found.contents.length
                  ? found.contents.map((c: any) =>
                      `${c.product_name} ${c.grade}: books say ${num(c.qty, 1)} ${c.uom}`).join(' · ')
                  : 'The books say this shelf is empty.'}
              </div>
            </div>
          </div>

          {found.contents.length ? (
            <Field label="Which product">
              <select value={productId ? `${productId}|${batchId}` : ''}
                onChange={(e) => {
                  const [p, b] = e.target.value.split('|');
                  setProductId(p ?? ''); setBatchId(b ?? '');
                }}>
                <option value="">Choose…</option>
                {found.contents.map((c: any) => (
                  <option key={`${c.product_id}-${c.batch_id}-${c.grade}`}
                    value={`${c.product_id}|${c.batch_id ?? ''}`}>
                    {c.product_name} · grade {c.grade} · books say {num(c.qty, 1)} {c.uom}
                    {c.batch_no ? ` · ${c.batch_no}` : ''}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <p className="small muted mb">
              Nothing is booked to this shelf. If there is stock on it anyway, that
              is a finding — record it against the product you can see.
            </p>
          )}

          <div className="grid c2">
            <Field label="How much is actually there">
              <input type="number" step="0.001" value={counted}
                onChange={(e) => setCounted(e.target.value)} />
            </Field>
            <Field label="What state is it in">
              <select value={condition} onChange={(e) => setCondition(e.target.value)}>
                {CONDITIONS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </Field>
          </div>
          <div className="grid c2">
            <Field label="How much is a write-off"
              hint="Only the part that cannot be sold at all.">
              <input type="number" step="0.001" value={lossQty}
                onChange={(e) => setLossQty(e.target.value)} />
            </Field>
            <Field label={needsNote ? 'What did you see? (required)' : 'Anything worth noting'}>
              <input value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="Two crates wet at the back" />
            </Field>
          </div>

          <div className="banner warn">
            <span><Icon name="info" size={16} /></span>
            <div className="small">
              Recording this does not change the stock figures. It records what you
              found; correcting the books is somebody else's decision, made against
              your finding.
            </div>
          </div>
        </>
      ) : null}
    </Modal>
  );
}

function RaiseAuditModal({ onClose, onDone }: { onClose: () => void; onDone: (m: string) => void }) {
  const { me } = useAuth();
  const { data: products } = useApi<any[]>('/masters/products');
  const [scope, setScope] = useState('WAREHOUSE');
  const [warehouseId, setWarehouseId] = useState('');
  const [productId, setProductId] = useState('');
  const [batchId, setBatchId] = useState('');
  const [reason, setReason] = useState('');
  const [priority, setPriority] = useState('NORMAL');
  const [dueDate, setDueDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  return (
    <Modal
      title="Ask the audit team to check something"
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || reason.trim().length < 3}
          onClick={async () => {
            setBusy(true); setError(null);
            try {
              const r = await api.post<any>('/warehouse/audits', {
                scope,
                warehouseId: warehouseId || undefined,
                productId: scope === 'PRODUCT' ? productId : undefined,
                reason: reason.trim(), priority, dueDate: dueDate || undefined,
              });
              onDone(r.message);
            } catch (e: any) { setError(e); } finally { setBusy(false); }
          }}>Send it</button>
      </>}
    >
      <ErrorBanner error={error} />
      <div className="grid c2">
        <Field label="What should they look at">
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="WAREHOUSE">A whole warehouse</option>
            <option value="PRODUCT">One product, wherever it is</option>
          </select>
        </Field>
        <Field label="Which warehouse">
          <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">Any</option>
            {(me?.warehouses ?? []).map((w: any) => (
              <option key={w.id} value={w.id}>{w.name}</option>))}
          </select>
        </Field>
      </div>
      {scope === 'PRODUCT' ? (
        <Field label="Which product">
          <select value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">Choose…</option>
            {(products ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
      ) : null}
      <Field label="Why" hint="The auditor reads this before they walk over. Say what looks wrong.">
        <input value={reason} autoFocus onChange={(e) => setReason(e.target.value)}
          placeholder="Mango stock looks light against the book" />
      </Field>
      <div className="grid c2">
        <Field label="How urgent">
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>
            {['LOW', 'NORMAL', 'HIGH', 'URGENT'].map((p) =>
              <option key={p} value={p}>{p.toLowerCase()}</option>)}
          </select>
        </Field>
        <Field label="Needed by">
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function CloseAuditModal({ task, onClose, onDone }: {
  task: any; onClose: () => void; onDone: (m: string) => void;
}) {
  const [findings, setFindings] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  const loss = (task.counts ?? []).reduce((a: number, c: any) => a + Number(c.loss_qty ?? 0), 0);

  return (
    <Modal
      title={`Close ${task.task_no}`}
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Not yet</button>
        <button className="btn primary" disabled={busy || findings.trim().length < 3}
          onClick={async () => {
            setBusy(true); setError(null);
            try {
              const r = await api.post<any>(`/warehouse/audits/${task.id}/complete`,
                { findings: findings.trim() });
              onDone(r.message);
            } catch (e: any) { setError(e); } finally { setBusy(false); }
          }}>Close it</button>
      </>}
    >
      <ErrorBanner error={error} />
      <p className="small muted mb">
        {(task.counts ?? []).length} shelves counted
        {loss > 0 ? `, ${num(loss, 1)} written off` : ', nothing written off'}.
      </p>
      <Field label="What did you find?"
        hint="In your own words. This is what the owner reads.">
        <input value={findings} autoFocus onChange={(e) => setFindings(e.target.value)}
          placeholder="Two crates spoiled from a roof leak above R-A2. Rest tallies." />
      </Field>
    </Modal>
  );
}
