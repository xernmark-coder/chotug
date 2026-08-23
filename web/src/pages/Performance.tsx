import React, { useMemo, useState } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import { inr, num, date } from '../lib/api';
import { Chip, Empty, ErrorBanner, Kpi, Layout, Loading, useApi } from '../components/ui';
import { Icon } from '../components/icons';

/* ===========================================================================
 * PRODUCT AND CATEGORY PERFORMANCE
 *
 *   "how much it got sold total, how much revenue by that product, supplier of
 *    that products, where it is being sold, loss in that product, everything in
 *    that card of the report for each product. also same for the category."
 *
 * The temptation with a page like this is a wall of numbers. What a person
 * actually asks is "which of these is worth my attention", so the ordering and
 * the two headline columns do that work: **net margin after waste**, and
 * **sell-through**. A product with good revenue, 40% wastage and 30%
 * sell-through is losing money, and on a revenue-sorted table it sits at the
 * top looking like a success.
 * ======================================================================== */

const TONE = ['#4338CA', '#0891B2', '#D97706', '#16A34A', '#B91C1C', '#7C3AED'];

export function PerformancePage() {
  const [days, setDays] = useState(30);
  const [tab, setTab] = useState<'products' | 'categories'>('products');
  const [openCard, setOpenCard] = useState<string | null>(null);
  const { data, loading, error } = useApi<any>(`/insights/product-performance?days=${days}`, [days]);

  const products = data?.products ?? [];
  const categories = data?.categories ?? [];

  const totals = useMemo(() => products.reduce((a: any, p: any) => ({
    revenue: a.revenue + Number(p.revenue),
    margin: a.margin + Number(p.margin),
    waste: a.waste + Number(p.wasteValue),
    bought: a.bought + Number(p.boughtValue),
  }), { revenue: 0, margin: 0, waste: 0, bought: 0 }), [products]);

  if (loading) return <Layout title="Performance"><Loading /></Layout>;

  return (
    <Layout
      title="Product performance"
      subtitle="What each product and category is actually earning, and what it is losing"
      actions={
        <select className="branch-select" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={365}>Last year</option>
        </select>
      }
    >
      <ErrorBanner error={error} />

      <div className="grid c4 mb">
        <Kpi label={`Sold, ${days} days`} value={inr(totals.revenue, 0)} />
        <Kpi label="Gross margin" value={inr(totals.margin, 0)}
          tone={totals.margin < 0 ? 'crit' : 'good'}
          foot={totals.revenue > 0
            ? `${num((totals.margin / totals.revenue) * 100, 1)}% of revenue` : '—'} />
        <Kpi label="Lost to waste" value={inr(totals.waste, 0)}
          tone={totals.waste > 0 ? 'warn' : 'good'}
          foot="thrown away, spoiled, or short on audit" />
        <Kpi label="After waste" value={inr(totals.margin - totals.waste, 0)}
          tone={totals.margin - totals.waste < 0 ? 'crit' : 'good'}
          foot="what actually stayed in the business" />
      </div>

      <div className="tabs">
        {([['products', `Products (${products.length})`],
           ['categories', `Categories (${categories.length})`]] as const).map(([k, l]) => (
          <button key={k} className={`tab ${tab === k ? 'active' : ''}`}
            onClick={() => setTab(k)}>{l}</button>))}
      </div>

      {tab === 'categories' ? (
        <>
          <div className="grid c2 mb">
            <div className="card">
              <div className="card-head"><h2>Revenue by category</h2></div>
              <div className="card-body">
                {categories.length ? (
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={categories} layout="vertical" margin={{ left: 90, right: 16 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 11 }}
                        tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}k`} />
                      <YAxis type="category" dataKey="name" width={86} tick={{ fontSize: 11 }} />
                      <Tooltip formatter={(v: any) => inr(v, 0)} />
                      <Bar dataKey="revenue" radius={[0, 3, 3, 0]}>
                        {categories.map((_: any, i: number) => (
                          <Cell key={i} fill={TONE[i % TONE.length]} />))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : <Empty title="Nothing sold in this period" />}
              </div>
            </div>
            <div className="card">
              <div className="card-head"><h2>What it earns against what it loses</h2></div>
              <div className="card-body">
                {categories.length ? (
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={categories} margin={{ left: 8, right: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }}
                        tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}k`} />
                      <Tooltip formatter={(v: any) => inr(v, 0)} />
                      <Legend />
                      <Bar dataKey="margin" name="margin" fill="#16A34A" radius={[3, 3, 0, 0]} />
                      <Bar dataKey="wasteValue" name="waste" fill="#B91C1C" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : <Empty title="Nothing to compare" />}
              </div>
            </div>
          </div>

          <div className="grid c3">
            {categories.map((c: any) => (
              <div className="card" key={c.categoryId ?? 'none'}>
                <div className="card-head"><h2>{c.name}</h2>
                  <span className="small muted">{c.products} products</span></div>
                <div className="card-body">
                  <dl className="kv">
                    <dt>Bought</dt><dd>{num(c.boughtQty, 0)} · {inr(c.boughtValue, 0)}</dd>
                    <dt>Sold</dt><dd>{num(c.soldQty, 0)} · <b>{inr(c.revenue, 0)}</b></dd>
                    <dt>Margin</dt>
                    <dd className={c.margin < 0 ? 'text-danger' : ''}>
                      <b>{inr(c.margin, 0)}</b>{c.marginPct != null ? ` · ${c.marginPct}%` : ''}
                    </dd>
                    <dt>Lost</dt>
                    <dd className={c.wasteValue > 0 ? 'text-danger' : ''}>
                      {inr(c.wasteValue, 0)}{c.wastePct != null ? ` · ${c.wastePct}% of what came in` : ''}
                    </dd>
                    <dt>Still here</dt><dd>{num(c.stockQty, 0)} · {inr(c.stockValue, 0)}</dd>
                    <dt>Sell-through</dt>
                    <dd>{c.sellThrough == null ? '—'
                      : <Chip tone={c.sellThrough < 60 ? 'warn' : 'ok'}>{c.sellThrough}%</Chip>}</dd>
                  </dl>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="stack">
          {!products.length ? (
            <Empty icon="📊" title="Nothing moved in this period"
              hint="Buy or sell something and it appears here." />
          ) : null}
          {products.map((p: any) => {
            const open = openCard === p.productId;
            const bad = p.netMargin < 0;
            return (
              <div className={`card perf-card ${bad ? 'bad' : ''}`} key={p.productId}>
                <button className="perf-head"
                  onClick={() => setOpenCard(open ? null : p.productId)}>
                  <span className="row" style={{ gap: 10, minWidth: 200 }}>
                    <Icon name={p.icon ?? 'produce'} size={26} />
                    <span>
                      <b>{p.name}</b>
                      <span className="small muted"> {p.sku}</span>
                      <div className="small muted">{p.categoryName ?? 'uncategorised'}</div>
                    </span>
                  </span>
                  <span className="perf-nums">
                    <span><em>sold</em>{num(p.soldQty, 0)} {p.uom}</span>
                    <span><em>revenue</em>{inr(p.revenue, 0)}</span>
                    <span><em>margin</em>
                      <b className={p.margin < 0 ? 'text-danger' : ''}>{inr(p.margin, 0)}</b>
                      {p.marginPct != null ? <i> {p.marginPct}%</i> : null}
                    </span>
                    <span><em>lost</em>
                      <b className={p.wasteValue > 0 ? 'text-danger' : ''}>{inr(p.wasteValue, 0)}</b>
                    </span>
                    <span><em>after waste</em>
                      <b className={bad ? 'text-danger' : ''}>{inr(p.netMargin, 0)}</b>
                    </span>
                    <span><em>sell-through</em>
                      {p.sellThrough == null ? '—' : (
                        <Chip tone={p.sellThrough < 60 ? 'warn' : 'ok'}>{p.sellThrough}%</Chip>)}
                    </span>
                  </span>
                  <span className="muted">{open ? '−' : '+'}</span>
                </button>

                {open ? (
                  <div className="card-body perf-body">
                    <div className="grid c3">
                      <div>
                        <div className="section-head sm"><h3>Bought from</h3><span className="rule" /></div>
                        {p.suppliers.length ? p.suppliers.map((s: any) => (
                          <div className="perf-line" key={s.name}>
                            <span>{s.name}</span>
                            <b>{num(s.qty, 0)} {p.uom}</b>
                            <em>{inr(s.value, 0)}</em>
                          </div>
                        )) : <p className="small muted">Nothing bought in this period.</p>}
                        <div className="perf-line tot">
                          <span>Rejected at the gate</span>
                          <b className={p.rejectedQty > 0 ? 'text-danger' : ''}>
                            {num(p.rejectedQty, 1)} {p.uom}
                          </b>
                          <em>{p.loads} load(s)</em>
                        </div>
                      </div>

                      <div>
                        <div className="section-head sm"><h3>Sold at</h3><span className="rule" /></div>
                        {p.places.length ? p.places.map((s: any) => (
                          <div className="perf-line" key={s.name}>
                            <span>{s.name}</span>
                            <b>{num(s.qty, 0)} {p.uom}</b>
                            <em>{inr(s.revenue, 0)}</em>
                          </div>
                        )) : <p className="small muted">Not sold anywhere in this period.</p>}
                        <div className="perf-line tot">
                          <span>Bills · customers</span>
                          <b>{p.bills}</b><em>{p.customers} customer(s)</em>
                        </div>
                      </div>

                      <div>
                        <div className="section-head sm"><h3>Where it stands</h3><span className="rule" /></div>
                        <div className="perf-line">
                          <span>Bought</span><b>{num(p.boughtQty, 0)} {p.uom}</b>
                          <em>{inr(p.boughtValue, 0)}</em>
                        </div>
                        <div className="perf-line">
                          <span>Still on the shelf</span><b>{num(p.stockQty, 0)} {p.uom}</b>
                          <em>{inr(p.stockValue, 0)}</em>
                        </div>
                        <div className="perf-line">
                          <span>Thrown away or short</span>
                          <b className={p.wasteQty > 0 ? 'text-danger' : ''}>
                            {num(p.wasteQty, 1)} {p.uom}
                          </b>
                          <em>{p.wastePct != null ? `${p.wastePct}% of intake` : '—'}</em>
                        </div>
                        <div className="perf-line tot">
                          <span>Kept after waste</span>
                          <b className={bad ? 'text-danger' : ''}>{inr(p.netMargin, 0)}</b>
                          <em>{bad ? 'losing money' : 'earning'}</em>
                        </div>
                      </div>
                    </div>

                    {p.trend.length > 1 ? (
                      <div className="mt">
                        <div className="section-head sm"><h3>Sold, day by day</h3><span className="rule" /></div>
                        <ResponsiveContainer width="100%" height={160}>
                          <AreaChart data={p.trend}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
                            <XAxis dataKey="date" tick={{ fontSize: 10 }}
                              tickFormatter={(d) => date(d).slice(0, 6)} />
                            <YAxis tick={{ fontSize: 10 }}
                              tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}k`} />
                            <Tooltip formatter={(v: any) => inr(v, 0)}
                              labelFormatter={(l) => date(l)} />
                            <Area type="monotone" dataKey="revenue" stroke="#4338CA"
                              fill="#4338CA" fillOpacity={0.12} strokeWidth={2} />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    ) : (
                      <p className="small muted mt">
                        Only one day of sales in this period — not enough for a trend.
                      </p>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Layout>
  );
}
