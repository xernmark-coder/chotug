import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth, inr, num, date } from '../lib/api';
import {
  Chip, DataTable, Empty, ErrorBanner, Kpi, Layout, useApi, useToast,
  FilterBar, FilterTotals, useFilters,
} from '../components/ui';
import { Icon } from '../components/icons';
import { SellPacksModal } from './Packing';
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
  const nav = useNavigate();
  const toast = useToast();
  const { warehouseId, can, me } = useAuth();
  const [searchParams] = useSearchParams();
  const centreUser = !!me?.roles.includes('CENTRE_EXEC');
  const [days, setDays] = useState(30);
  // Selling a ready-made pack is the common case: somebody already decided the
  // size and the price, so the sale is a tick and a name — not a weight and a
  // rate typed again at the counter.
  const [pickedPacks, setPickedPacks] = useState<Record<string, boolean>>({});
  const [sellingPacks, setSellingPacks] = useState<any[] | null>(null);

  const wh = searchParams.get('warehouseId') || warehouseId || '';
  const summary = useApi<any>(`/inventory/sales-summary?days=${days}&warehouseId=${wh}`, [days, wh]);
  const sugg = useApi<any>(`/inventory/sell-suggestions?warehouseId=${wh}`, [wh]);
  const recent = useApi<any[]>(`/inventory/issues?warehouseId=${wh}&reason=SALE`, [wh]);
  const packs = useApi<any[]>(`/inventory/packs?status=IN_STOCK&warehouseId=${wh}`, [wh]);

  const t = summary.data?.totals ?? {};
  const w = summary.data?.writeOffs ?? {};
  const risk = sugg.data?.atRisk ?? {};
  const showMoney = can('data.cost.view', 'reports.purchase.view');
  const canSell = can('inventory.stock.issue');
  /* Grading a box is what makes it sellable, so the button that leads there is
     gated on the grading right rather than the selling one. */
  const canPack = can('inventory.pack.grade') || can('inventory.stock.issue');

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

      {!centreUser ? <>
      {/* ------------------------------------------------ what to pack --- */}
      <div className="section-head"><h2>Pack these first</h2><span className="rule" /></div>

      {/* Produce leaves this building in a labelled box and no other way. The
          list below is loose stock, so nothing on it can be sold yet — the
          action on every row is the bench. */}
      <div className="banner info mb">
        <span><Icon name="box" size={16} /></span>
        <div className="small">
          <b>Stock is sold as packed boxes.</b> Everything below is still loose:
          grade and label it at the packing bench and it joins the boxes above,
          with its own price, grade and barcode.
        </div>
      </div>

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
                /* This used to sell the batch straight off the shelf. Produce
                   is sold as packed boxes now, so the only honest action here
                   is to send it to the bench — where it is graded, labelled and
                   priced, and after which it can be sold. */
                key: 'a', head: '', width: 100,
                render: (s: any) => canPack
                  ? <button className="btn sm primary"
                      onClick={() => nav(`/pack-bench/${s.batch_id}`)}>Pack it</button>
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
      </> : null}

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

    </Layout>
  );
}

/* --------------------------------------------------------------- sell --- */
