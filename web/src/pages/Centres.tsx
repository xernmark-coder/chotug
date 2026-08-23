import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, useAuth, inr, num, date, dateTime, ago, idempotencyKey } from '../lib/api';
import {
  Chip, DataTable, Empty, ErrorBanner, Field, Kpi, Layout, Loading, Modal, useApi, useToast,
  FilterBar, FilterTotals, useFilters,
} from '../components/ui';
import { Icon } from '../components/icons';

/* ===========================================================================
 * CENTRES — the shops
 *
 * A centre is a warehouse that sells. Everything already built applies to it:
 * it holds batches, stock moves through the same ledger, packs sit on the same
 * shelves. These screens add only what is different about a shop —
 *
 *   · stock arrives on a lorry and has to be booked in;
 *   · it is sold to customers, who belong to the shop;
 *   · at closing, somebody declares the takings, and the gap between their
 *     figure and the bills is the thing worth looking at.
 * ======================================================================== */

export function CentresPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const centres = useApi<any[]>('/centres');
  const perf = useApi<any>('/centres/performance?days=30');
  const [tab, setTab] = useState<'centres' | 'compare'>('centres');

  const rows = centres.data ?? [];
  const totalStock = rows.reduce((a, c: any) => a + Number(c.stock_value), 0);
  const totalRevenue = rows.reduce((a, c: any) => a + Number(c.revenue_30d), 0);
  const notClosed = rows.filter((c: any) =>
    c.last_closed_on !== new Date().toISOString().slice(0, 10));

  const today = new Date().toISOString().slice(0, 10);
  const f = useFilters<any>(rows, {
    search: (c: any) => [c.name, c.city, c.manager_name, c.address].filter(Boolean).join(' '),
    facets: [
      { key: 'city', label: 'city', of: (c: any) => c.city },
      { key: 'mgr', label: 'manager', of: (c: any) => c.manager_name },
      { key: 'cl', label: 'day close', of: (c: any) =>
        (c.last_closed_on === today ? 'closed today' : 'not closed today') },
      { key: 'tr', label: 'in transit', of: (c: any) =>
        (Number(c.in_transit_loads) > 0 ? 'load on the way' : 'nothing coming') },
    ],
    totals: [
      { label: 'Centres', of: () => 1 },
      { label: 'Stock', of: (c: any) => Number(c.stock_value) || 0, money: true },
      { label: 'Sold, 30d', of: (c: any) => Number(c.revenue_30d) || 0, money: true },
    ],
  });
  const fPerf = useFilters<any>(perf.data?.centres, {
    search: (c: any) => [c.name, c.city].filter(Boolean).join(' '),
    facets: [
      { key: 'city', label: 'city', of: (c: any) => c.city },
      { key: 'net', label: 'result', of: (c: any) =>
        (Number(c.netMargin) < 0 ? 'losing money' : 'making money') },
    ],
    totals: [
      { label: 'Bills', of: (c: any) => Number(c.bills) || 0 },
      { label: 'Revenue', of: (c: any) => Number(c.revenue) || 0, money: true },
      { label: 'Net after costs', of: (c: any) => Number(c.netMargin) || 0, money: true },
    ],
  });

  return (
    <Layout
      title="Centres"
      subtitle="Every shop, what it is holding and what it is selling"
      actions={<button className="btn sm" onClick={() => nav('/customers')}>Customers</button>}
    >
      <ErrorBanner error={centres.error} />

      <div className="grid c4 mb">
        <Kpi label="Centres open" value={rows.length} />
        <Kpi label="Stock out there" value={inr(totalStock, 0)}
          foot="at landed cost, across all shops" />
        <Kpi label="Sold, 30 days" value={inr(totalRevenue, 0)} />
        <Kpi label="Not closed today" value={notClosed.length}
          tone={notClosed.length ? 'warn' : 'good'}
          foot={notClosed.length ? notClosed.map((c: any) => c.name).join(', ') : 'all closed'} />
      </div>

      <div className="tabs">
        {([['centres', `Centres (${rows.length})`],
           ['compare', 'How they compare']] as const).map(([k, l]) => (
          <button key={k} className={`tab ${tab === k ? 'active' : ''}`}
            onClick={() => setTab(k)}>{l}</button>))}
      </div>

      {tab === 'centres' ? (
        <div className="card"><div className="card-body tight">
          <FilterBar f={f} placeholder="Search centre, city, manager" />
          <FilterTotals f={f} noun="centre" />
          <DataTable
            loading={centres.loading}
            rows={f.rows}
            onRowClick={(c: any) => nav(`/centres/${c.id}`)}
            rowTone={(c: any) => (Number(c.in_transit_loads) > 0 ? 'warn' : undefined)}
            cols={[
              { key: 'n', head: 'Centre', render: (c: any) => (
                <div><b>{c.name}</b>
                  <div className="small muted">{c.city ?? '—'}{c.manager_name ? ` · ${c.manager_name}` : ''}</div></div>) },
              { key: 's', head: 'Holding', num: true, render: (c: any) => (
                <div>{num(c.stock_qty, 0)}<div className="small muted">{inr(c.stock_value, 0)}</div></div>) },
              { key: 't', head: 'On the way', num: true, render: (c: any) =>
                Number(c.in_transit_loads) > 0
                  ? <Chip tone="warn">{c.in_transit_loads} load(s)</Chip>
                  : <span className="muted">—</span> },
              { key: 'r', head: 'Sold, 30 days', num: true, render: (c: any) => (
                <div>{inr(c.revenue_30d, 0)}<div className="small muted">{num(c.sold_30d, 0)} units</div></div>) },
              { key: 'c', head: 'Customers', num: true, render: (c: any) => c.customers },
              { key: 'd', head: 'Last closed', render: (c: any) => {
                const today = new Date().toISOString().slice(0, 10);
                return !c.last_closed_on ? <Chip tone="warn">never</Chip>
                  : c.last_closed_on === today ? <Chip tone="ok">today</Chip>
                  : <Chip tone="warn">{date(c.last_closed_on)}</Chip>;
              } },
            ]}
            empty={<Empty icon="🏪"
              title={f.active > 0 ? 'No centre matches those filters' : 'No centres yet'}
              hint={f.active > 0 ? 'Clear a filter to widen the search.'
                : 'Mark a warehouse as a centre in Settings and it appears here.'} />}
          />
        </div></div>
      ) : (
        <div className="card"><div className="card-body tight">
          <p className="small muted" style={{ padding: '8px 12px 0' }}>
            Ranked by revenue, but read the <b>net after costs</b> column — revenue
            flatters a shop with high rent, a long delivery run and heavy wastage.
          </p>
          <FilterBar f={fPerf} placeholder="Search centre or city" />
          <FilterTotals f={fPerf} noun="centre" />
          <DataTable
            rows={fPerf.rows}
            onRowClick={(c: any) => nav(`/centres/${c.id}`)}
            cols={[
              { key: 'r', head: '#', width: 40, render: (c: any) => <b>{c.rank}</b> },
              { key: 'n', head: 'Centre', render: (c: any) => (
                <div><b>{c.name}</b><div className="small muted">{c.city ?? '—'}</div></div>) },
              { key: 'b', head: 'Bills', num: true, render: (c: any) => c.bills },
              { key: 'v', head: 'Revenue', num: true, render: (c: any) => inr(c.revenue, 0) },
              { key: 'm', head: 'Gross margin', num: true, render: (c: any) => (
                <span className={Number(c.margin) < 0 ? 'text-danger' : ''}>{inr(c.margin, 0)}</span>) },
              { key: 'x', head: 'Costs', num: true, render: (c: any) => (
                <div className="small">{inr(Number(c.expenses) + Number(c.transport_cost), 0)}
                  <div className="muted">{inr(c.transport_cost, 0)} transport</div></div>) },
              { key: 'net', head: 'Net after costs', num: true, render: (c: any) => (
                <b className={c.netMargin < 0 ? 'text-danger' : ''}>{inr(c.netMargin, 0)}</b>) },
              { key: 'st', head: 'Sell-through', num: true, render: (c: any) =>
                c.sellThrough == null ? <span className="muted">—</span> : (
                  <span className={c.sellThrough < 60 ? 'chip warn' : 'small'}>
                    {num(c.sellThrough, 0)}%
                  </span>) },
              { key: 'w', head: 'Wastage', num: true, render: (c: any) =>
                Number(c.wastage) > 0
                  ? <b className="text-danger">{num(c.wastage, 1)}</b>
                  : <span className="muted">—</span> },
              { key: 'cv', head: 'Cash gap', num: true, render: (c: any) =>
                Number(c.cash_variance) > 0
                  ? <b className="text-danger">{inr(c.cash_variance, 0)}</b>
                  : <Chip tone="ok">ties</Chip> },
            ]}
            empty={<Empty title={fPerf.active > 0
              ? 'No centre matches those filters' : 'Nothing to compare yet'} />}
          />
        </div></div>
      )}
    </Layout>
  );
}

/* ------------------------------------------------------- one centre ------ */

export function CentreDayPage() {
  const { id } = useParams();
  const toast = useToast();
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<any>(`/centres/${id}/today`, [id]);
  const [receiving, setReceiving] = useState<any>(null);
  const [closing, setClosing] = useState(false);
  const [asking, setAsking] = useState(false);

  /* Above the loading guard — a hook cannot sit behind an early return. */
  const fStock = useFilters<any>(data?.stock, {
    search: (x: any) => [x.product_name, x.sku, x.batch_no, x.grade].filter(Boolean).join(' '),
    facets: [
      { key: 'p', label: 'product', of: (x: any) => x.product_name },
      { key: 'g', label: 'grade', of: (x: any) => x.grade },
    ],
    totals: [
      { label: 'On the shelves', of: (x: any) => Number(x.qty) || 0 },
      { label: 'Worth', of: (x: any) =>
        (Number(x.qty) || 0) * (Number(x.landed_rate) || 0), money: true },
    ],
  });
  const fBills = useFilters<any>(data?.salesToday, {
    search: (x: any) => [x.issue_no, x.customer_name, x.party_name].filter(Boolean).join(' '),
    facets: [
      { key: 'who', label: 'customer', of: (x: any) =>
        x.customer_name ?? x.party_name ?? 'walk-in' },
    ],
    totals: [
      { label: 'Bills', of: () => 1 },
      { label: 'Taken', of: (x: any) => Number(x.total_value) || 0, money: true },
    ],
  });
  const fCloses = useFilters<any>(data?.closes, {
    date: (x: any) => x.close_date,
    search: (x: any) => [x.close_date, x.note].filter(Boolean).join(' '),
    facets: [
      { key: 'v', label: 'cash', of: (x: any) =>
        (Math.abs(Number(x.variance)) > 0.01 ? 'does not tie' : 'ties') },
    ],
    totals: [
      { label: 'Days', of: () => 1 },
      { label: 'Declared', of: (x: any) => Number(x.declared_total) || 0, money: true },
      { label: 'Gap', of: (x: any) => Number(x.variance) || 0, money: true },
    ],
  });

  if (loading) return <Layout title="Centre"><Loading /></Layout>;
  if (error) return <Layout title="Centre"><ErrorBanner error={error} /></Layout>;

  const c = data.centre;

  return (
    <Layout
      title={c.name}
      subtitle={`${c.city ?? ''}${c.address ? ` · ${c.address}` : ''}`}
      actions={
        <div className="btn-row">
          {can('purchase.requirement.create') ? (
            <button className="btn sm" onClick={() => setAsking(true)}>Ask for stock</button>
          ) : null}
          {can('centre.day.close') ? (
            <button className={`btn sm ${data.closedToday ? '' : 'primary'}`}
              onClick={() => setClosing(true)}>
              {data.closedToday ? 'Correct today’s close' : 'Close the day'}
            </button>
          ) : null}
        </div>
      }
    >
      <div className="grid c4 mb">
        <Kpi label="Sold today" value={inr(data.revenueToday, 0)}
          foot={`${num(data.soldToday, 0)} units · ${data.salesToday.length} bills`} />
        <Kpi label="Holding now" value={num(
          data.stock.reduce((a: number, s: any) => a + Number(s.qty), 0), 0)}
          foot={`${data.stock.length} products`} />
        <Kpi label="On the way" value={data.incoming.length}
          tone={data.incoming.length ? 'warn' : 'good'}
          foot={data.incoming.length ? 'book it in when it arrives' : 'nothing in transit'} />
        <Kpi label="Day closed" value={data.closedToday ? 'yes' : 'not yet'}
          tone={data.closedToday ? 'good' : 'warn'}
          foot={c.upi_id ? `UPI ${c.upi_id}` : 'no UPI set'} />
      </div>

      {data.incoming.length ? (
        <div className="card mb">
          <div className="card-head"><h2>Coming to you</h2></div>
          <div className="card-body tight">
            <DataTable
              rows={data.incoming}
              rowTone={() => 'warn'}
              cols={[
                { key: 'n', head: 'Transfer', render: (t: any) => (
                  <div><b className="mono">{t.issue_no}</b>
                    <div className="small muted">from {t.from_warehouse} · {ago(t.dispatched_at)}</div></div>) },
                { key: 'c', head: 'What is on it', render: (t: any) => t.contents ?? '—' },
                { key: 'v', head: 'Vehicle', render: (t: any) => (
                  <div>{t.vehicle_reg ?? '—'}
                    <div className="small muted">{t.driver_name ?? ''}</div></div>) },
                { key: 'q', head: 'Sent', num: true, render: (t: any) => num(t.total_qty, 1) },
                { key: 'a', head: '', width: 130, render: (t: any) =>
                  can('centre.stock.receive')
                    ? <button className="btn sm primary" onClick={() => setReceiving(t)}>It arrived</button>
                    : null },
              ]}
            />
          </div>
        </div>
      ) : null}

      <div className="grid c2">
        <div className="card">
          <div className="card-head"><h2>On the shelves</h2></div>
          <div className="card-body tight">
            <FilterBar f={fStock} placeholder="Search product or batch" />
            <FilterTotals f={fStock} noun="batch" />
            <DataTable
              rows={fStock.rows}
              cols={[
                { key: 'p', head: 'Product', render: (s: any) => (
                  <div className="row" style={{ gap: 8 }}>
                    <Icon name={s.icon ?? 'produce'} size={18} />
                    <div><b>{s.product_name}</b>
                      <div className="small muted">{s.sku}</div></div>
                  </div>) },
                { key: 'q', head: 'Have', num: true, render: (s: any) =>
                  <b>{num(s.qty, 1)} <span className="small muted">{s.base_uom}</span></b> },
                { key: 'e', head: 'Oldest goes off', render: (s: any) => {
                  if (!s.soonest_expiry) return <span className="muted small">—</span>;
                  const days = Math.round(
                    (new Date(s.soonest_expiry).getTime() - Date.now()) / 86400000);
                  /* "-2d — sell first" is not advice anybody can act on. Past
                     the date it is not stock, it is waste. */
                  return days < 0 ? <Chip tone="danger">{Math.abs(days)}d past — write it off</Chip>
                    : days === 0 ? <Chip tone="danger">today — sell first</Chip>
                    : days <= 2 ? <Chip tone="danger">{days}d — sell first</Chip>
                    : days <= 5 ? <Chip tone="warn">{days} days</Chip>
                    : <span className="small">{date(s.soonest_expiry)}</span>;
                } },
              ]}
              empty={<Empty icon="📦"
                title={fStock.active > 0 ? 'Nothing matches those filters' : 'Nothing on the shelves'}
                hint={fStock.active > 0 ? 'Clear a filter to widen the search.'
                  : 'Ask the warehouse to send stock.'} />}
            />
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>Today's bills</h2></div>
            <div className="card-body tight">
              <FilterBar f={fBills} placeholder="Search bill or customer" />
              <FilterTotals f={fBills} noun="bill" />
              <DataTable
                rows={fBills.rows}
                cols={[
                  { key: 'n', head: 'Bill', render: (s: any) => (
                    <div><b className="mono">{s.issue_no}</b>
                      <div className="small muted">{ago(s.posted_at)}</div></div>) },
                  { key: 'c', head: 'Who', render: (s: any) =>
                    s.customer_name ?? s.party_name ?? 'walk-in' },
                  { key: 'v', head: 'Value', num: true, render: (s: any) => inr(s.total_value, 0) },
                ]}
                empty={<Empty title={fBills.active > 0
                  ? 'No bill matches those filters' : 'Nothing sold yet today'} />}
              />
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h2>Last two weeks</h2></div>
            <div className="card-body tight">
              <FilterBar f={fCloses} placeholder="Search a day" />
              <FilterTotals f={fCloses} noun="day" />
              <DataTable
                rows={fCloses.rows}
                rowTone={(d: any) => (Math.abs(Number(d.variance)) > 0.01 ? 'warn' : undefined)}
                cols={[
                  { key: 'd', head: 'Day', render: (d: any) => date(d.close_date) },
                  { key: 's', head: 'Bills say', num: true, render: (d: any) => inr(d.system_revenue, 0) },
                  { key: 'c', head: 'Declared', num: true, render: (d: any) => inr(d.declared_revenue, 0) },
                  { key: 'v', head: 'Gap', num: true, render: (d: any) => {
                    const v = Number(d.variance);
                    return Math.abs(v) < 0.01 ? <Chip tone="ok">ties</Chip>
                      : <b className="text-danger">{v > 0 ? '+' : ''}{inr(v, 0)}</b>;
                  } },
                ]}
                empty={<Empty title="No days closed yet" />}
              />
            </div>
          </div>
        </div>
      </div>

      {receiving ? (
        <ReceiveLoadModal transfer={receiving} onClose={() => setReceiving(null)}
          onDone={(m) => { setReceiving(null); reload(); toast(m, 'ok'); }} />
      ) : null}
      {closing ? (
        <DayCloseModal centre={c} onClose={() => setClosing(false)}
          onDone={(m) => { setClosing(false); reload(); toast(m, 'ok'); }} />
      ) : null}
      {asking ? (
        <AskForStockModal centre={c} onClose={() => setAsking(false)}
          onDone={(m) => { setAsking(false); toast(m, 'ok'); }} />
      ) : null}
    </Layout>
  );
}

function ReceiveLoadModal({ transfer, onClose, onDone }: {
  transfer: any; onClose: () => void; onDone: (m: string) => void;
}) {
  const { data } = useApi<any>(`/inventory/issues?id=${transfer.id}`, [transfer.id]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  const [got, setGot] = useState<Record<string, string>>({});

  const lines = data?.[0]?.lines ?? [];
  const short = lines.some((l: any) =>
    got[l.id] !== undefined && Number(got[l.id]) < Number(l.qty) - 0.001);

  return (
    <Modal
      title={`${transfer.issue_no} arrived`}
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Not yet</button>
        <button className="btn primary" disabled={busy || (short && !note.trim())}
          onClick={async () => {
            setBusy(true); setError(null);
            try {
              const r = await api.post<any>(`/centres/transfers/${transfer.id}/receive`, {
                note: note.trim() || undefined,
                lines: lines.map((l: any) => ({
                  lineId: l.id,
                  receivedQty: got[l.id] !== undefined ? Number(got[l.id]) : Number(l.qty),
                })),
              });
              onDone(r.message);
            } catch (e: any) { setError(e); } finally { setBusy(false); }
          }}>Book it in</button>
      </>}
    >
      <ErrorBanner error={error} />
      <p className="small muted mb">
        Count it before booking it in. Only what you confirm becomes your stock —
        anything missing is recorded against the trip, not against your shop.
      </p>
      <table className="mini mb">
        <tbody>
          {lines.map((l: any) => (
            <tr key={l.id}>
              <td><b>{l.product_name}</b>
                <div className="small muted">sent {num(l.qty, 1)} {l.uom}</div></td>
              <td className="num" style={{ width: 120 }}>
                <input className="inline num" type="number" step="0.001"
                  value={got[l.id] ?? String(l.qty)}
                  onChange={(e) => setGot((s) => ({ ...s, [l.id]: e.target.value }))} />
              </td>
            </tr>
          ))}
          {!lines.length ? <tr><td className="muted small">Loading the load…</td></tr> : null}
        </tbody>
      </table>
      {short ? (
        <>
          <div className="banner danger mb">
            <span><Icon name="alert" size={16} /></span>
            <div className="small">
              Less arrived than was sent. The buyer will be told, and the
              difference stays against this trip.
            </div>
          </div>
          <Field label="What happened? (required)">
            <input value={note} autoFocus onChange={(e) => setNote(e.target.value)}
              placeholder="Two crates crushed in transit" />
          </Field>
        </>
      ) : null}
    </Modal>
  );
}

function DayCloseModal({ centre, onClose, onDone }: {
  centre: any; onClose: () => void; onDone: (m: string) => void;
}) {
  const { data: draft } = useApi<any>(`/centres/${centre.id}/day-close-draft`);
  const [declaredRevenue, setDeclaredRevenue] = useState('');
  const [declaredQty, setDeclaredQty] = useState('');
  const [cash, setCash] = useState('');
  const [online, setOnline] = useState('');
  const [expenses, setExpenses] = useState('');
  const [wastage, setWastage] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  const system = Number(draft?.system_revenue ?? 0);
  const declared = Number(declaredRevenue) || 0;
  const gap = declared - system;
  const needsNote = Math.abs(gap) > 0.01;
  const handedOver = (Number(cash) || 0) + (Number(online) || 0);

  return (
    <Modal
      title={`Closing ${centre.name}`}
      onClose={onClose}
      wide
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary"
          disabled={busy || declaredRevenue === '' || (needsNote && !note.trim())}
          onClick={async () => {
            setBusy(true); setError(null);
            try {
              const r = await api.post<any>(`/centres/${centre.id}/day-close`, {
                declaredQty: Number(declaredQty) || 0,
                declaredRevenue: declared,
                cashAmount: Number(cash) || 0,
                onlineAmount: Number(online) || 0,
                expenses: Number(expenses) || 0,
                wastageQty: Number(wastage) || 0,
                note: note.trim() || undefined,
              });
              onDone(r.message);
            } catch (e: any) { setError(e); } finally { setBusy(false); }
          }}>Close the day</button>
      </>}
    >
      <ErrorBanner error={error} />
      <div className="banner info mb">
        <span><Icon name="info" size={16} /></span>
        <div>
          <b>The bills say {inr(system)} across {draft?.bills ?? 0} sales.</b>
          <div className="small">
            Put in what you actually took. If the two differ, say why — that gap
            is the whole point of closing the day.
          </div>
        </div>
      </div>
      <div className="grid c2">
        <Field label="What you took today (₹)">
          <input type="number" step="0.01" autoFocus value={declaredRevenue}
            onChange={(e) => setDeclaredRevenue(e.target.value)} />
        </Field>
        <Field label="How much you sold (units)">
          <input type="number" step="0.001" value={declaredQty}
            onChange={(e) => setDeclaredQty(e.target.value)} />
        </Field>
      </div>
      <div className="grid c3">
        <Field label="Cash (₹)"><input type="number" value={cash}
          onChange={(e) => setCash(e.target.value)} /></Field>
        <Field label="Online / UPI (₹)"><input type="number" value={online}
          onChange={(e) => setOnline(e.target.value)} /></Field>
        <Field label="Spent today (₹)" hint="Small shop expenses out of the till.">
          <input type="number" value={expenses} onChange={(e) => setExpenses(e.target.value)} />
        </Field>
      </div>
      <Field label="Thrown away (units)" hint="What went bad and could not be sold.">
        <input type="number" step="0.001" value={wastage}
          onChange={(e) => setWastage(e.target.value)} />
      </Field>

      {handedOver > 0 && Math.abs(handedOver - declared) > 0.01 ? (
        <div className="banner warn mb">
          <span><Icon name="info" size={16} /></span>
          <div className="small">
            Cash and online add up to <b>{inr(handedOver, 0)}</b> but you took{' '}
            <b>{inr(declared, 0)}</b>. Check before closing.
          </div>
        </div>
      ) : null}

      {needsNote ? (
        <>
          <div className={`banner ${Math.abs(gap) > system * 0.05 ? 'danger' : 'warn'} mb`}>
            <span><Icon name="alert" size={16} /></span>
            <div>
              <b>{inr(Math.abs(gap), 0)} {gap > 0 ? 'more' : 'less'} than the bills.</b>
              <div className="small">This is flagged for the owner and for Finance.</div>
            </div>
          </div>
          <Field label="What happened? (required)">
            <input value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Gave the hotel a 40 rupee discount" />
          </Field>
        </>
      ) : null}

      <p className="small muted">
        Closing hands {inr(handedOver, 0)} to Finance as a declaration. They
        confirm what actually lands, and any difference is theirs to chase.
      </p>
    </Modal>
  );
}

function AskForStockModal({ centre, onClose, onDone }: {
  centre: any; onClose: () => void; onDone: (m: string) => void;
}) {
  const { data: products } = useApi<any[]>('/masters/products');
  const [productId, setProductId] = useState('');
  const [qty, setQty] = useState('');
  const [reasoning, setReasoning] = useState('');
  const [priority, setPriority] = useState('NORMAL');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  return (
    <Modal
      title="Ask for stock"
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary"
          disabled={busy || !productId || !Number(qty) || reasoning.trim().length < 3}
          onClick={async () => {
            setBusy(true); setError(null);
            try {
              const r = await api.post<any>('/planning/requirements', {
                branchId: centre.branch_id,
                warehouseId: centre.id,
                raisedForWarehouseId: centre.id,
                requiredDate: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10),
                priority,
                source: 'MANUAL',
                reasoning: reasoning.trim(),
                remarks: `${centre.name}: ${reasoning.trim()}`,
                lines: [{ productId, qty: Number(qty) }],
              });
              onDone(r.message ?? `Sent to the purchase manager (${r.req_no ?? ''}).`);
            } catch (e: any) { setError(e); } finally { setBusy(false); }
          }}>Send to purchase</button>
      </>}
    >
      <ErrorBanner error={error} />
      <p className="small muted mb">
        This goes to the purchase manager, who decides whether to buy more. Say
        why you need it — "festival on Friday" gets a different answer from
        "ran out".
      </p>
      <div className="grid c2">
        <Field label="What do you need">
          <select value={productId} autoFocus onChange={(e) => setProductId(e.target.value)}>
            <option value="">Choose…</option>
            {(products ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="How much">
          <input type="number" step="0.001" value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
      </div>
      <Field label="Why" hint="The purchase manager reads this before deciding.">
        <input value={reasoning} onChange={(e) => setReasoning(e.target.value)}
          placeholder="Ganpati this weekend — we sold out of mango by noon" />
      </Field>
      <Field label="How urgent">
        <select value={priority} onChange={(e) => setPriority(e.target.value)}>
          {['LOW', 'NORMAL', 'HIGH', 'URGENT'].map((p) =>
            <option key={p} value={p}>{p.toLowerCase()}</option>)}
        </select>
      </Field>
    </Modal>
  );
}

/* ------------------------------------------------------------ customers -- */

export function CustomersPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [centre, setCentre] = useState('');
  const centres = useApi<any[]>('/centres');
  const [adding, setAdding] = useState(false);

  /* The search box does double duty. The list is capped at 200 by spend, so a
   * small customer has to be findable by asking the server for them — the same
   * text then narrows what came back. Typing one thing and having it mean the
   * same thing in both places is the only version of this that is not
   * confusing. */
  const [serverQ, setServerQ] = useState('');
  const list = useApi<any[]>(
    `/centres/customers/list?q=${encodeURIComponent(serverQ)}${centre ? `&warehouseId=${centre}` : ''}`,
    [serverQ, centre]);

  const rows = list.data ?? [];
  const spent = rows.reduce((a, c: any) => a + Number(c.spent), 0);

  const f = useFilters<any>(rows, {
    date: (c: any) => c.last_bought,
    search: (c: any) => [c.name, c.phone, c.centre_name, c.kind].filter(Boolean).join(' '),
    facets: [
      { key: 'kind', label: 'kind', of: (c: any) => c.kind },
      { key: 'centre', label: 'shop', of: (c: any) => c.centre_name ?? 'us directly' },
      { key: 'act', label: 'activity', of: (c: any) =>
        (c.last_bought ? 'has bought' : 'never bought') },
    ],
    totals: [
      { label: 'Customers', of: () => 1 },
      { label: 'Orders', of: (c: any) => Number(c.orders) || 0 },
      { label: 'Spent', of: (c: any) => Number(c.spent) || 0, money: true },
    ],
  });
  /* One box, two consumers: the server after a pause, the rows immediately. */
  React.useEffect(() => {
    const t = setTimeout(() => setServerQ(f.q.trim()), 250);
    return () => clearTimeout(t);
  }, [f.q]);

  return (
    <Layout
      title="Customers"
      subtitle="Who buys from us, and from which shop"
      actions={can('master.customer.manage')
        ? <button className="btn sm primary" onClick={() => setAdding(true)}>Add a customer</button>
        : undefined}
    >
      <ErrorBanner error={list.error} />
      <div className="grid c3 mb">
        <Kpi label="Customers" value={rows.length} />
        <Kpi label="Bought from us" value={inr(spent, 0)} foot="all time" />
        <Kpi label="Bought this month" value={rows.filter((c: any) =>
          c.last_bought && c.last_bought >= new Date().toISOString().slice(0, 8) + '01').length}
          foot="active customers" />
      </div>

      <FilterBar f={f} placeholder="Search by name or phone">
        <select value={centre} onChange={(e) => setCentre(e.target.value)}>
          <option value="">Every centre</option>
          {(centres.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </FilterBar>
      <FilterTotals f={f} noun="customer" />

      <div className="card"><div className="card-body tight">
        <DataTable
          loading={list.loading}
          rows={f.rows}
          cols={[
            { key: 'n', head: 'Customer', render: (c: any) => (
              <div><b>{c.name}</b>
                <div className="small muted">{c.phone ?? 'no phone'} · {c.kind.replace('_', ' ').toLowerCase()}</div></div>) },
            { key: 'c', head: 'Buys from', render: (c: any) =>
              c.centre_name ?? <span className="muted small">us directly</span> },
            { key: 'o', head: 'Orders', num: true, render: (c: any) => c.orders },
            { key: 's', head: 'Spent', num: true, render: (c: any) => inr(c.spent, 0) },
            { key: 'l', head: 'Last bought', render: (c: any) =>
              c.last_bought ? date(c.last_bought) : <span className="muted small">never</span> },
          ]}
          empty={<Empty icon="🧑"
            title={f.active > 0 ? 'No customer matches those filters' : 'No customers yet'}
            hint={f.active > 0 ? 'Clear a filter to widen the search.'
              : 'They can be added here, or from the dropdown when selling.'} />}
        />
      </div></div>

      {adding ? (
        <AddCustomerModal centres={centres.data ?? []} onClose={() => setAdding(false)}
          onDone={(m) => { setAdding(false); list.reload(); toast(m, 'ok'); }} />
      ) : null}
    </Layout>
  );
}

/** Exported so selling can add a customer without leaving the till. */
export function AddCustomerModal({ centres, defaultCentre, onClose, onDone }: {
  centres: any[]; defaultCentre?: string; onClose: () => void;
  onDone: (m: string, customer?: any) => void;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [kind, setKind] = useState('WALK_IN');
  const [warehouseId, setWarehouseId] = useState(defaultCentre ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  return (
    <Modal
      title="Add a customer"
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !name.trim()}
          onClick={async () => {
            setBusy(true); setError(null);
            try {
              const r = await api.post<any>('/centres/customers', {
                name: name.trim(), phone: phone.trim() || undefined, kind,
                warehouseId: warehouseId || undefined,
              });
              onDone(r.message, r);
            } catch (e: any) { setError(e); } finally { setBusy(false); }
          }}>Add</button>
      </>}
    >
      <ErrorBanner error={error} />
      <div className="grid c2">
        <Field label="Name"><input value={name} autoFocus
          onChange={(e) => setName(e.target.value)} placeholder="Hotel Suvarna" /></Field>
        <Field label="Phone"><input value={phone}
          onChange={(e) => setPhone(e.target.value)} placeholder="98220 44556" /></Field>
      </div>
      <div className="grid c2">
        <Field label="What kind">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="WALK_IN">Walk-in</option>
            <option value="SHOP">Shop</option>
            <option value="HOTEL">Hotel or restaurant</option>
            <option value="WHOLESALER">Wholesaler</option>
            <option value="INSTITUTION">Institution</option>
            <option value="ONLINE">Online</option>
          </select>
        </Field>
        <Field label="Which centre">
          <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">Buys from us directly</option>
            {centres.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
      </div>
    </Modal>
  );
}
