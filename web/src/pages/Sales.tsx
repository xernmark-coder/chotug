import React, { useState } from 'react';
import { api, useAuth, inr, num, date, idempotencyKey } from '../lib/api';
import {
  Chip, DataTable, Empty, ErrorBanner, Field, Kpi, Layout, Loading, Modal, useApi, useToast,
  FilterBar, FilterTotals, useFilters,
} from '../components/ui';
import { Icon } from '../components/icons';
import { SellPacksModal } from './Packing';
import { AddCustomerModal } from './Centres';
import {
  CHART, ChartCard, compact, inrCompact, Meter, StackedStatus,
} from '../components/charts';

/* ===========================================================================
 * SELLING
 *
 * Stock could always leave — but only one batch at a time, from a row action
 * buried on the batch list, with nowhere to read whether the sale made money.
 * This is the other half: sell from a ranked list, and see what it earned.
 *
 * Produce loses value on a clock. The list is ordered by shelf life first and
 * money second, because the cheapest way to lose ₹30,000 is to hold out for a
 * better rate on a crate that expires on Thursday.
 * ======================================================================== */

const URGENCY_TONE: Record<string, 'danger' | 'warn' | 'primary' | 'neutral'> = {
  CRITICAL: 'danger', HIGH: 'warn', MEDIUM: 'primary', NONE: 'neutral',
};

export function SalesPage() {
  const toast = useToast();
  const { warehouseId, can } = useAuth();
  const [days, setDays] = useState(30);
  const [selling, setSelling] = useState<any>(null);
  // Selling a ready-made pack is the common case: somebody already decided the
  // size and the price, so the sale is a tick and a name — not a weight and a
  // rate typed again at the counter.
  const [pickedPacks, setPickedPacks] = useState<Record<string, boolean>>({});
  const [sellingPacks, setSellingPacks] = useState<any[] | null>(null);

  const wh = warehouseId ?? '';
  const summary = useApi<any>(`/inventory/sales-summary?days=${days}&warehouseId=${wh}`, [days, wh]);
  const sugg = useApi<any>(`/inventory/sell-suggestions?warehouseId=${wh}`, [wh]);
  const recent = useApi<any[]>(`/inventory/issues?warehouseId=${wh}&reason=SALE`, [wh]);
  const packs = useApi<any[]>(`/inventory/packs?status=IN_STOCK&warehouseId=${wh}`, [wh]);

  const t = summary.data?.totals ?? {};
  const w = summary.data?.writeOffs ?? {};
  const risk = sugg.data?.atRisk ?? {};
  const showMoney = can('data.cost.view', 'reports.purchase.view');
  const canSell = can('inventory.stock.issue');

  const profit = Number(t.profit ?? 0);
  const onHandValue = (summary.data?.byProduct ?? [])
    .reduce((a: number, p: any) => a + Number(p.value_left ?? 0), 0);

  const reloadAll = () => { summary.reload(); sugg.reload(); recent.reload(); packs.reload(); };
  const inStockPacks = packs.data ?? [];

  const fPacks = useFilters<any>(inStockPacks, {
    search: (p: any) => [p.code, p.product_name, p.batch_no, p.group_label].filter(Boolean).join(' '),
    facets: [
      { key: 'prod', label: 'product', of: (p: any) => p.product_name },
      { key: 'grade', label: 'grade', of: (p: any) => p.grade },
      { key: 'batch', label: 'batch', of: (p: any) => p.batch_no },
    ],
    totals: [
      { label: 'Worth', of: (p: any) => Number(p.price) || 0, money: true },
    ],
  });
  const fSugg = useFilters<any>(sugg.data?.suggestions, {
    search: (x: any) => [x.product_name, x.batch_no, x.grade].filter(Boolean).join(' '),
    facets: [
      { key: 'prod', label: 'product', of: (x: any) => x.product_name },
      { key: 'urg', label: 'urgency', of: (x: any) => x.urgency },
      { key: 'grade', label: 'grade', of: (x: any) => x.grade },
    ],
    totals: [
      { label: 'On hand', of: (x: any) => Number(x.available_qty) || 0 },
      { label: 'Money on it', of: (x: any) => Number(x.valueAtRisk) || 0, money: true },
    ],
  });
  const fByProduct = useFilters<any>(summary.data?.byProduct, {
    search: (p2: any) => [p2.name, p2.sku].filter(Boolean).join(' '),
    facets: [],
    totals: [
      { label: 'Products', of: () => 1 },
      { label: 'Sold', of: (p2: any) => Number(p2.sold_qty ?? p2.sold) || 0 },
    ],
  });
  const fRecent = useFilters<any>(recent.data, {
    date: (x: any) => x.issue_date,
    search: (x: any) => [x.issue_no, x.party_name].filter(Boolean).join(' '),
    facets: [
      { key: 'party', label: 'buyer', of: (x: any) => x.party_name },
    ],
    totals: [
      { label: 'Sales', of: () => 1 },
      { label: 'Value', of: (x: any) => Number(x.total_value) || 0, money: true },
    ],
  });
  const chosenPacks = inStockPacks.filter((p: any) => pickedPacks[p.id]);

  return (
    <Layout
      title="Sales &amp; profit"
      subtitle="What went out of the warehouse, what it earned, and what to move next"
      actions={
        <select className="branch-select" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      }
    >
      <ErrorBanner error={summary.error} />

      {showMoney ? (
        <>
          <div className="section-head"><h2>Money in, money out</h2><span className="rule" /></div>
          <div className="grid c4 mb">
            <Kpi label="Revenue" value={inr(t.revenue ?? 0, 0)}
              foot={`${t.sales ?? 0} sale(s) · ${num(t.qty_sold, 0)} units`} />
            <Kpi label="Cost of what sold" value={inr(t.cost ?? 0, 0)}
              foot="what those units cost you" />
            <Kpi label={profit >= 0 ? 'Profit' : 'Loss'}
              value={inr(Math.abs(profit), 0)}
              tone={profit > 0 ? 'good' : profit < 0 ? 'crit' : undefined}
              foot={t.marginPct == null ? 'no sales yet'
                : `${num(t.marginPct, 1)}% margin${profit < 0 ? ' — selling below cost' : ''}`} />
            <Kpi label="Thrown away" value={inr(w.cost ?? 0, 0)}
              tone={Number(w.cost) > 0 ? 'warn' : 'good'}
              foot={Number(w.cost) > 0
                ? `${num(w.qty, 0)} units written off` : 'nothing written off'} />
          </div>
        </>
      ) : null}

      {/* --------------------------------------------- ready-made packs ---
          Packs are made and priced on the Packing screen; this is where they
          are sold. Selling one posts a stock issue for what is inside it, so
          the pack count and the kilos on the shelf both come down together. */}
      {canSell ? (
        <>
          <div className="section-head"><h2>Sell ready-made packs</h2><span className="rule" /></div>
          <div className="card mb">
            <div className="card-head">
              <h2>{inStockPacks.length} pack(s) on the shelf</h2>
              {chosenPacks.length ? (
                <>
                  <Chip tone="primary">
                    {chosenPacks.length} selected ·{' '}
                    {inr(chosenPacks.reduce((a: number, p: any) => a + Number(p.price), 0), 0)}
                  </Chip>
                  <button className="btn sm" onClick={() => setPickedPacks({})}>Clear</button>
                  <button className="btn sm primary" onClick={() => setSellingPacks(chosenPacks)}>
                    Sell {chosenPacks.length} pack(s)
                  </button>
                </>
              ) : null}
            </div>
            <div className="card-body tight">
              <FilterBar f={fPacks} placeholder="Search barcode, product, batch" />
              <FilterTotals f={fPacks} noun="pack" />
              <DataTable
                loading={packs.loading}
                rows={fPacks.rows}
                onRowClick={(p: any) =>
                  setPickedPacks((s2) => ({ ...s2, [p.id]: !s2[p.id] }))}
                cols={[
                  { key: 'sel', head: '', width: 34, render: (p: any) => (
                    <input type="checkbox" style={{ width: 17, height: 17 }}
                      checked={!!pickedPacks[p.id]} readOnly />
                  ) },
                  { key: 'c', head: 'Barcode', render: (p: any) => (
                    <div><b className="mono">{p.code}</b>
                      <div className="small muted">{p.group_label ?? `pack ${p.pack_no}`}</div></div>
                  ) },
                  { key: 'p', head: 'Product', render: (p: any) => (
                    <div>{p.product_name}<div className="small muted mono">{p.batch_no}</div></div>
                  ) },
                  { key: 'q', head: 'Contains', num: true, render: (p: any) =>
                    <span>{num(p.qty, 2)} <span className="small muted">{p.uom}</span></span> },
                  { key: 'r', head: 'Sells for', num: true, render: (p: any) => <b>{inr(p.price)}</b> },
                ]}
                empty={<Empty icon="📦"
                  title={fPacks.active > 0 ? 'No pack matches those filters' : 'No packs made up yet'}
                  hint={fPacks.active > 0 ? 'Clear a filter to widen the search.'
                    : 'Make packs on the Packing screen and they appear here to sell.'} />}
              />
            </div>
          </div>
        </>
      ) : null}

      {/* ------------------------------------------------ what to sell --- */}
      <div className="section-head"><h2>Sell these first</h2><span className="rule" /></div>

      {Number(risk.value) > 0 ? (
        <div className="banner warn mb">
          <span><Icon name="clock" size={16} /></span>
          <div>
            <b>{inr(risk.value, 0)} of stock is close to the end of its shelf life.</b>
            <div className="small">
              {risk.critical ?? 0} batch(es) need to go today, {risk.high ?? 0} this week.
              Ranked by days left, then by how much money is sitting on it.
            </div>
          </div>
        </div>
      ) : null}

      <div className="card mb">
        <div className="card-body tight">
          <FilterBar f={fSugg} placeholder="Search product or batch" />
          <FilterTotals f={fSugg} noun="batch" />
          <DataTable
            loading={sugg.loading}
            rows={fSugg.rows}
            rowTone={(s: any) => (s.urgency === 'CRITICAL' ? 'crit' : s.urgency === 'HIGH' ? 'warn' : undefined)}
            cols={[
              {
                key: 'p', head: 'Product',
                render: (s: any) => (
                  <div>
                    <b>{s.product_name}</b>
                    <div className="small muted mono">{s.batch_no}{s.grade ? ` · ${s.grade}` : ''}</div>
                  </div>
                ),
              },
              {
                key: 'u', head: 'When',
                render: (s: any) => (
                  <div>
                    <Chip tone={URGENCY_TONE[s.urgency]}>{s.action}</Chip>
                    <div className="small muted">
                      {s.days_left == null ? 'no expiry recorded'
                        : s.days_left <= 0 ? 'past its date'
                        : `${s.days_left} day(s) left`}
                    </div>
                  </div>
                ),
              },
              {
                key: 'q', head: 'On hand', num: true,
                render: (s: any) => (
                  <div>{num(s.available_qty, 0)} <span className="small muted">{s.base_uom}</span></div>
                ),
              },
              ...(showMoney ? [{
                key: 'v', head: 'Money on it', num: true,
                render: (s: any) => inr(s.valueAtRisk, 0),
              }, {
                key: 'r', head: 'Suggested rate', num: true,
                render: (s: any) => s.suggestedRate == null ? <span className="muted">—</span> : (
                  <div>
                    <b>{inr(s.suggestedRate)}</b>
                    <div className="small muted">
                      cost {inr(s.landed_rate)}
                      {s.recent_sale_rate ? ` · usually ${inr(s.recent_sale_rate)}` : ''}
                    </div>
                  </div>
                ),
              }] : []),
              {
                key: 'a', head: '', width: 90,
                render: (s: any) => canSell
                  ? <button className="btn sm primary" onClick={() => setSelling(s)}>Sell</button>
                  : null,
              },
            ]}
            empty={<Empty icon="👍"
              title={fSugg.active > 0 ? 'No batch matches those filters' : 'Nothing is close to expiring'}
              hint={fSugg.active > 0 ? 'Clear a filter to widen the search.'
                : 'Every batch in the warehouse has room on its shelf life.'} />}
          />
        </div>
      </div>

      {/* --------------------------------------------- sold vs on hand --- */}
      <div className="grid sidebar-right">
        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>Sold, and what is left</h2></div>
            <div className="card-body tight">
              <FilterBar f={fByProduct} placeholder="Search product" />
              <FilterTotals f={fByProduct} noun="product" />
              <DataTable
                loading={summary.loading}
                rows={fByProduct.rows}
                cols={[
                  { key: 'p', head: 'Product', render: (p: any) => (
                    <div><b>{p.name}</b><div className="small muted">{p.sku}</div></div>
                  ) },
                  { key: 's', head: 'Sold', num: true, render: (p: any) => (
                    <div>{num(p.qty_sold, 0)} <span className="small muted">{p.base_uom}</span></div>
                  ) },
                  { key: 'l', head: 'Still here', num: true, render: (p: any) => (
                    <div>{num(p.qty_left, 0)} <span className="small muted">{p.base_uom}</span></div>
                  ) },
                  { key: 'pc', head: 'Share sold', num: true, render: (p: any) => {
                    const total = Number(p.qty_sold) + Number(p.qty_left);
                    if (!total) return <span className="muted">—</span>;
                    const pct = (Number(p.qty_sold) / total) * 100;
                    return <Meter pct={pct} tone={pct >= 50 ? 'ok' : pct >= 20 ? 'warn' : 'danger'}
                      label={`${num(pct, 0)}%`} />;
                  } },
                  ...(showMoney ? [{
                    key: 'm', head: 'Profit', num: true, render: (p: any) => {
                      const v = Number(p.profit);
                      if (!Number(p.qty_sold)) return <span className="muted">—</span>;
                      return <b style={{ color: v >= 0 ? 'var(--ok)' : 'var(--danger)' }}>
                        {v >= 0 ? '' : '−'}{inr(Math.abs(v), 0)}
                      </b>;
                    },
                  }] : []),
                ]}
                empty={<Empty icon="📦" title="Nothing sold or in stock yet" />}
              />
            </div>
          </div>

          {showMoney ? (
            <ChartCard
              title="Revenue and profit"
              legend={[
                { label: 'Profit', color: CHART.status.ok },
                { label: 'Cost', color: CHART.status.neutral },
              ]}
              hint="Each day's sales, split into what it cost you and what you kept."
              empty={!summary.data?.trend?.length
                ? <Empty icon="📈" title="No sales in this period" /> : undefined}
            >
              <StackedStatus
                data={(summary.data?.trend ?? []).map((d: any) => ({
                  date: d.date,
                  cost: Math.max(0, Number(d.revenue) - Number(d.profit)),
                  profit: Math.max(0, Number(d.profit)),
                }))}
                x="date"
                labelFmt={(d: any) => date(d).slice(0, 6)}
                valueFmt={(v: any) => inrCompact(Number(v))}
                series={[
                  { key: 'cost', label: 'Cost', color: CHART.status.neutral },
                  { key: 'profit', label: 'Profit', color: CHART.status.ok },
                ]}
              />
            </ChartCard>
          ) : null}
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>Recent sales</h2></div>
            <div className="card-body tight">
              <FilterBar f={fRecent} placeholder="Search sale or buyer" />
              <FilterTotals f={fRecent} noun="sale" />
              <DataTable
                rows={fRecent.rows}
                cols={[
                  { key: 'n', head: 'Sale', render: (s: any) => (
                    <div>
                      <b className="mono small">{s.issue_no}</b>
                      <div className="small muted">{s.party_name ?? 'no buyer recorded'}</div>
                    </div>
                  ) },
                  { key: 'd', head: 'When', render: (s: any) => (
                    <span className="small">{date(s.issue_date)}</span>
                  ) },
                  ...(showMoney ? [{
                    key: 'v', head: 'Value', num: true,
                    render: (s: any) => inr(s.total_value, 0),
                  }] : []),
                ]}
                empty={<Empty icon="🧾" title={fRecent.active > 0
                  ? 'No sale matches those filters' : 'No sales recorded yet'} />}
              />
            </div>
          </div>

          {showMoney ? (
            <div className="card">
              <div className="card-head"><h2>Stock still on the shelf</h2></div>
              <div className="card-body">
                <div className="kpi" style={{ border: 'none', boxShadow: 'none', padding: 0 }}>
                  <div className="label">Value on hand</div>
                  <div className="value">{inr(onHandValue, 0)}</div>
                  <div className="foot">at what it cost you, across every batch</div>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {sellingPacks ? (
        <SellPacksModal packs={sellingPacks} onClose={() => setSellingPacks(null)}
          onDone={() => { setSellingPacks(null); setPickedPacks({}); reloadAll(); }} />
      ) : null}

      {selling ? (
        <SellModal row={selling} onClose={() => setSelling(null)}
          onDone={() => { setSelling(null); reloadAll(); }} />
      ) : null}
    </Layout>
  );
}

/* --------------------------------------------------------------- sell --- */

function SellModal({ row, onClose, onDone }: { row: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [qty, setQty] = useState(String(row.available_qty ?? ''));
  const [rate, setRate] = useState(row.suggestedRate != null ? String(row.suggestedRate) : '');
  const [party, setParty] = useState('');
  /* A name typed into a box is not a customer — it is a different spelling
     every time, and "who buys from us" becomes unanswerable. So the buyer is
     picked from the list, and adding one is a button beside it rather than a
     trip to another screen while somebody waits at the counter. */
  const [customerId, setCustomerId] = useState('');
  const [addingCustomer, setAddingCustomer] = useState(false);
  const customers = useApi<any[]>(
    `/centres/customers/list?warehouseId=${row.warehouse_id ?? ''}`, [row.warehouse_id]);
  const centres = useApi<any[]>('/centres');
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => idempotencyKey('sale'));

  const uom = row.base_uom;
  const available = Number(row.available_qty ?? 0);
  const n = Number(qty) || 0;
  const r = Number(rate) || 0;
  const cost = Number(row.landed_rate ?? 0);
  const over = n > available + 0.001;

  /* Three prices, not one. "Below cost" only counts what this crate was bought
     for; the floor that actually keeps the business alive includes the wages,
     the electricity and the cold store, and allows for what gets thrown away. */
  const overhead = Number(row.overhead_per_kg ?? 0);
  const trueCost = Number(row.true_cost ?? cost);
  const minSell = Number(row.min_sell_price ?? 0);
  const revenue = n * r;
  const costOut = n * cost;
  const margin = revenue - costOut;
  const belowCost = r > 0 && r < cost;
  const belowTrueCost = r > 0 && r >= cost && r < trueCost;
  const belowMin = r > 0 && minSell > 0 && r >= trueCost && r < minSell;

  const post = async () => {
    setBusy(true);
    try {
      const res = await api.post<any>('/inventory/issues', {
        idempotencyKey: key,
        warehouseId: row.warehouse_id,
        reason: 'SALE',
        partyName: party || undefined,
        customerId: customerId || undefined,
        referenceNo: ref || undefined,
        lines: [{ batchId: row.batch_id, qty: n, rate: r }],
      });
      toast(`${res.issue_no} — ${num(n, 0)} ${uom} sold`, 'ok');
      onDone();
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const customerModal = addingCustomer ? (
    <AddCustomerModal
      centres={centres.data ?? []}
      defaultCentre={row.warehouse_id}
      onClose={() => setAddingCustomer(false)}
      onDone={(m, c) => {
        setAddingCustomer(false);
        customers.reload();
        if (c?.id) { setCustomerId(c.id); setParty(c.name); }
        toast(m, 'ok');
      }} />
  ) : null;

  return (
    <>
    {customerModal}
    <Modal
      title={`Sell ${row.product_name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !n || over || !r} onClick={post}>
            {busy ? 'Recording…' : `Record sale — ${inr(revenue, 0)}`}
          </button>
        </>
      }
    >
      <dl className="kv mb">
        <dt>Batch</dt><dd className="mono">{row.batch_no}</dd>
        <dt>Available</dt><dd>{num(available, 2)} {uom}</dd>
        <dt>Shelf life</dt>
        <dd>{row.days_left == null ? 'not recorded'
          : row.days_left <= 0 ? 'past its date' : `${row.days_left} day(s) left`}</dd>
        <dt>It cost you</dt><dd>{inr(cost)} per {uom}</dd>
      </dl>

      <div className="grid c2">
        <Field label={`How much (${uom})`}
          error={over ? `Only ${num(available, 2)} ${uom} available` : undefined}>
          <input type="number" step="0.01" value={qty} autoFocus
            onChange={(e) => setQty(e.target.value)} />
        </Field>
        <Field label={`Selling rate (₹ per ${uom})`}
          hint={row.suggestedRate != null ? `Suggested ${inr(row.suggestedRate)}` : undefined}>
          <input type="number" step="0.01" value={rate}
            onChange={(e) => setRate(e.target.value)} />
        </Field>
      </div>

      <div className="grid c2">
        <Field label="Sold to" hint="Pick the customer so their history builds up.">
          <div className="row" style={{ gap: 6 }}>
            <select style={{ flex: 1 }} value={customerId}
              onChange={(e) => {
                setCustomerId(e.target.value);
                const c = (customers.data ?? []).find((x: any) => x.id === e.target.value);
                setParty(c?.name ?? '');
              }}>
              <option value="">Walk-in — no name</option>
              {(customers.data ?? []).map((c: any) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.phone ? ` · ${c.phone}` : ''}
                </option>))}
            </select>
            <button className="btn sm" onClick={() => setAddingCustomer(true)}>+ New</button>
          </div>
        </Field>
        <Field label="Their reference" hint="Challan or order number, if any.">
          <input value={ref} onChange={(e) => setRef(e.target.value)} />
        </Field>
      </div>

      {/* The whole cost of a crate, spelled out, because "it cost 110" and
          "we cannot sell it under 140" are different sentences and the person
          at the till needs the second one. */}
      {trueCost > 0 ? (
        <div className="price-ladder mb">
          <div><span>Bought for</span><b>{inr(cost)}</b></div>
          <div><span>Running costs</span><b>+ {inr(overhead)}</b>
            <em>wages, power, cold store — per {row.base_uom}</em></div>
          <div className="tot"><span>Really cost</span><b>{inr(trueCost)}</b></div>
          {minSell > 0 ? (
            <div className="floor">
              <span>Do not sell below</span><b>{inr(minSell)}</b>
              <em>{num(row.wastage_pct, 1)}% goes to waste · {num(row.margin_pct, 0)}% margin</em>
            </div>
          ) : null}
        </div>
      ) : null}

      {n > 0 && r > 0 ? (
        <div className={`banner ${belowCost || belowTrueCost ? 'danger'
          : belowMin ? 'warn' : margin > 0 ? 'ok' : 'warn'}`}>
          <span>{belowCost ? '⚠' : margin > 0 ? '✓' : 'ℹ'}</span>
          <div>
            <b>
              {belowCost
                ? `Below what it cost — you lose ${inr(Math.abs(margin), 0)} on this sale`
                : belowTrueCost
                  ? `Covers the purchase but not the running costs — ${inr(minSell)} is the floor`
                  : belowMin
                    ? `Under the minimum of ${inr(minSell)} — thinner margin than intended`
                    : margin > 0
                      ? `You make ${inr(margin, 0)} on this sale`
                      : 'You break even on this sale'}
            </b>
            <div className="small">
              {inr(revenue, 0)} in, {inr(costOut, 0)} of cost out
              {revenue > 0 ? ` · ${num((margin / revenue) * 100, 1)}% margin` : ''}
            </div>
            {belowCost ? (
              <div className="small mt">
                Sometimes right — recovering something beats throwing it away. It is recorded
                either way, so the loss shows up in the numbers instead of vanishing.
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </Modal>
    </>
  );
}
