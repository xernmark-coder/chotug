import React, { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Area, AreaChart } from 'recharts';
import { api, useAuth, inr, num, date, addDays, pctText } from '../lib/api';
import {
  AiBox, Chip, Col, DataTable, Empty, ErrorBanner, Field, Layout, Loading, Modal, ReasonPicker,
  useApi, useReasonBank, useToast,  FilterBar, FilterTotals, useFilters,
} from '../components/ui';
import { Icon } from '../components/icons';
import { ProductModal } from './Catalogue';
import { CHART } from '../components/charts';

/* ===========================================================================
 * WHAT TO BUY — the answer to §2: "system khud bataye kya aur kitna kharidna
 * hai". One screen, one decision per row, one button to turn it into work.
 * ======================================================================== */
export function BuyListPage() {
  const nav = useNavigate();
  const toast = useToast();
  const { branchId, can } = useAuth();
  const { data, loading, error, reload } = useApi<any>(
    branchId ? `/planning/requirement-note?branchId=${branchId}` : null, [branchId]);

  const [qtyOverride, setQtyOverride] = useState<Record<string, number>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<any>(null);
  const reasonBank = useReasonBank();
  const [insightFor, setInsightFor] = useState<any>(null);
  const [onlyNeeded, setOnlyNeeded] = useState(true);
  const [saving, setSaving] = useState(false);
  const [addingProduct, setAddingProduct] = useState(false);

  const items = useMemo(() => {
    const all = data?.items ?? [];
    return onlyNeeded ? all.filter((i: any) => i.suggestedQty > 0) : all;
  }, [data, onlyNeeded]);

  /* No date facet: this is what to buy *now*, and every row is about today.
     What matters here is finding a product and seeing what the selection will
     cost before committing to it. */
  const f = useFilters<any>(items, {
    /* Was productName / categoryName — neither of which this endpoint returns,
       so the search box matched nothing at all and the category dropdown never
       had a value to show. */
    search: (i) => [i.name, i.nameHi, i.sku, i.categoryName].filter(Boolean).join(' '),
    facets: [
      { key: 'cat', label: 'category', of: (i) => i.categoryName },
      { key: 'urgency', label: 'urgency', of: (i) => i.urgency },
    ],
    totals: [
      { label: 'To order', of: (i) => Number(i.suggestedQty ?? 0) },
      { label: 'At last rate', of: (i) =>
        Number(i.suggestedQty ?? 0) * Number(i.lastRate ?? i.landedRate ?? 0), money: true },
    ],
  });

  const chosen = f.rows.filter((i: any) => selected[i.productId]);

  const finalQty = (i: any) => qtyOverride[i.productId] ?? i.suggestedQty;

  const createRequirement = async () => {
    if (!chosen.length) return;
    const missing = chosen.find((i: any) =>
      finalQty(i) !== i.suggestedQty && !reasons[i.productId]);
    if (missing) {
      toast(`Give a reason for changing the quantity of ${missing.name}`, 'err');
      setEditing(missing);
      return;
    }
    setSaving(true);
    try {
      const r = await api.post<any>('/planning/requirements', {
        branchId,
        requiredDate: addDays(1),
        priority: chosen.some((i: any) => i.urgency === 'URGENT') ? 'URGENT' : 'NORMAL',
        source: 'LOW_STOCK',
        lines: chosen.map((i: any) => ({
          productId: i.productId, uom: i.uom,
          finalQty: finalQty(i), suggestedQty: i.suggestedQty,
          suggestedBy: 'RULE', suggestionReason: i.reasons,
          editReason: reasons[i.productId] ?? null,
          currentStock: i.currentStock, availableStock: i.availableStock,
          openPoQty: i.openPoQty, avgDailySale: i.avgDailySale,
          leadTimeDays: i.leadTimeDays, minStock: i.minStock, maxStock: i.maxStock,
          advanceOrderQty: i.advanceOrderQty,
        })),
      });
      toast(`Requirement ${r.req_no} created with ${r.lineCount} product(s)`, 'ok');
      nav(`/requirements/${r.id}`);
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setSaving(false);
    }
  };

  const cols: Col<any>[] = [
    {
      key: 'sel', head: '', width: 36,
      render: (i) => (
        <input type="checkbox" style={{ width: 18, height: 18 }}
          checked={!!selected[i.productId]}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setSelected((s) => ({ ...s, [i.productId]: e.target.checked }))} />
      ),
    },
    {
      key: 'p', head: 'Product',
      render: (i) => (
        <div className="row" style={{ gap: 8 }}>
          <Icon name={i.icon ?? 'produce'} size={17} />
          <div>
            <b>{i.name}</b>
            {i.nameHi ? <span className="muted small"> · {i.nameHi}</span> : null}
            <div className="small muted">
              {i.categoryName ? `${i.categoryName} · ` : ''}{i.sku}
            </div>
          </div>
        </div>
      ),
    },
    {
      key: 'why', head: 'Why', width: 150,
      render: (i) => (
        <div className="row wrap" style={{ gap: 4 }}>
          {i.triggers.length === 0 ? <span className="small muted">—</span> : null}
          {i.triggers.map((t: string) => (
            <Chip key={t} tone={t === 'LOW_STOCK' ? 'danger' : t === 'ADVANCE_ORDER' ? 'primary' : 'warn'}>
              {t.replace(/_/g, ' ').toLowerCase()}
            </Chip>
          ))}
        </div>
      ),
    },
    { key: 'st', head: 'Stock', num: true, render: (i) => (
      <div>{num(i.currentStock, 0)}
        <div className="small muted">{i.openPoQty > 0 ? `+${num(i.openPoQty, 0)} on order` : 'nothing on order'}</div>
      </div>
    ) },
    { key: 'sale', head: 'Sells/day', num: true, render: (i) => num(i.avgDailySale, 0) },
    { key: 'cov', head: 'Cover', num: true, render: (i) => (
      <Chip tone={i.daysOfCover < 1 ? 'danger' : i.daysOfCover < i.leadTimeDays ? 'warn' : 'neutral'}>
        {i.daysOfCover >= 999 ? '—' : `${num(i.daysOfCover, 1)}d`}
      </Chip>
    ) },
    /* A "0" against a product flagged LOW STOCK reads as a broken suggestion,
       and that is exactly how it was read. Nothing is wrong: there are already
       2,350 kg of it on eleven open orders. Say so on the row rather than
       leaving the buyer to work it out. */
    { key: 'sug', head: 'Suggested', num: true, render: (i) => (
      i.suggestedQty > 0 ? (
        <b className="mono">{num(i.suggestedQty, 0)} <span className="small muted">{i.uom}</span></b>
      ) : (
        <div>
          <b className="mono muted">0</b>
          <div className="small muted">
            {Number(i.openPoQty) > 0
              ? `${num(i.openPoQty, 0)} already on order`
              : Number(i.currentStock) > 0 ? 'enough on the shelf'
              : 'no demand recorded'}
          </div>
        </div>
      )
    ) },
    {
      key: 'qty', head: 'Order qty', num: true, width: 130,
      render: (i) => (
        <div className="row" style={{ justifyContent: 'flex-end', gap: 5 }}>
          {/* The reason dialog used to open on every keystroke: typing 150 over
              a suggested 20 threw it up at "1", then again at "15". Nobody
              could get a number in. It now waits until they have finished —
              blur or Enter — which is also the first moment the number they
              typed actually means anything. */}
          <input className="inline num" style={{ width: 78 }} type="number"
            value={finalQty(i)}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              const v = Number(e.target.value);
              setQtyOverride((s) => ({ ...s, [i.productId]: v }));
              setSelected((s) => ({ ...s, [i.productId]: v > 0 }));
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            onBlur={(e) => {
              const v = Number(e.target.value);
              if (v !== i.suggestedQty && !reasons[i.productId]) setEditing(i);
            }} />
          {finalQty(i) !== i.suggestedQty ? (
            <span title={reasons[i.productId] ?? 'Reason needed'}>
              {reasons[i.productId] ? '📝' : '⚠️'}
            </span>
          ) : null}
        </div>
      ),
    },
    { key: 'rate', head: 'Last rate', num: true, render: (i) => inr(i.lastRate) },
    {
      key: 'ai', head: '', width: 60,
      render: (i) => (
        <button className="btn sm ghost" onClick={(e) => { e.stopPropagation(); setInsightFor(i); }}>
          ✨
        </button>
      ),
    },
  ];

  return (
    <Layout
      title="What to buy"
      subtitle={data ? `${data.needsBuying} product(s) need ordering · calculated from stock, sales and open orders` : 'Calculating…'}
      actions={
        <div className="btn-row">
          <button className="btn sm" onClick={reload}>Recalculate</button>
          {can('purchase.requirement.create') ? (
            <button className="btn primary" disabled={!chosen.length || saving} onClick={createRequirement}>
              {saving ? 'Creating…' : `Create requirement (${chosen.length})`}
            </button>
          ) : null}
        </div>
      }
    >
      <ErrorBanner error={error} />
      <div className="banner info mb">
        <span><Icon name="info" size={16} /></span>
        <div>
          These quantities come from your own stock, the last 28 days of sales, open purchase
          orders, lead time and expected wastage. Change any number you disagree with — the system
          will ask why, and it learns from that.
        </div>
      </div>

      <FilterBar f={f} placeholder="Search a product or its code">
        <label className="check">
          <input type="checkbox" checked={onlyNeeded} onChange={(e) => setOnlyNeeded(e.target.checked)} />
          Only what needs ordering
        </label>
        <span className="spacer" />
        <button className="btn sm" onClick={() => {
          const next: Record<string, boolean> = {};
          items.forEach((i: any) => { if (i.suggestedQty > 0) next[i.productId] = true; });
          setSelected(next);
        }}>Select all suggested</button>
        {/* A product nobody has set up yet is a product nobody can order, and
            this is the screen where you notice it is missing. */}
        {can('master.product.manage') ? (
          <button className="btn sm" onClick={() => setAddingProduct(true)}>+ New product</button>
        ) : null}
      </FilterBar>
      <FilterTotals f={f} noun="product" />

      <div className="card">
        <div className="card-body tight">
          <DataTable
            rows={f.rows} cols={cols} loading={loading}
            rowTone={(i) => (i.urgency === 'URGENT' ? 'crit' : i.urgency === 'HIGH' ? 'warn' : undefined)}
            empty={<Empty icon="👍" title="Nothing needs ordering right now"
              hint="Uncheck the filter above to see every product." />}
          />
        </div>
      </div>

      {addingProduct ? (
        <ProductModal onClose={() => setAddingProduct(false)}
          onDone={() => { setAddingProduct(false); reload(); toast('Product added', 'ok'); }} />
      ) : null}

      {editing ? (
        <Modal title={`Why are you changing ${editing.name}?`} onClose={() => setEditing(null)}
          footer={
            <>
              <button className="btn" onClick={() => {
                setQtyOverride((s) => { const n = { ...s }; delete n[editing.productId]; return n; });
                setEditing(null);
              }}>Use suggested {num(editing.suggestedQty, 0)}</button>
              <button className="btn primary" onClick={() => setEditing(null)}
                disabled={!(reasons[editing.productId] ?? '').trim()}
                onClickCapture={() => reasonBank.remember(reasons[editing.productId] ?? '')}>
                Save reason</button>
            </>
          }>
          <p className="small muted">
            Suggested <b>{num(editing.suggestedQty, 0)} {editing.uom}</b>, you entered{' '}
            <b>{num(finalQty(editing), 0)} {editing.uom}</b>. A short reason keeps the audit trail
            honest and improves future suggestions.
          </p>
          <Field label="Reason" hint="Pick one, or type a new one — it joins the list for everyone.">
            <ReasonPicker
              bank={reasonBank}
              value={reasons[editing.productId] ?? ''}
              onChange={(v) => setReasons((s) => ({ ...s, [editing.productId]: v }))}
            />
          </Field>
          <ul className="reasons">
            {editing.reasons.map((r: any) => (
              <li key={r.code}><span>{r.label}</span><b>{r.value}</b></li>
            ))}
          </ul>
        </Modal>
      ) : null}

      {insightFor ? <InsightModal item={insightFor} onClose={() => setInsightFor(null)} /> : null}
    </Layout>
  );
}

function InsightModal({ item, onClose }: { item: any; onClose: () => void }) {
  const { branchId } = useAuth();
  const { data, loading } = useApi<any>(
    `/planning/insight/${item.productId}?branchId=${branchId}`, [item.productId]);

  return (
    <Modal title={`${item.name} — forecast and price`} onClose={onClose} wide
      footer={<button className="btn" onClick={onClose}>Close</button>}>
      {loading ? <Loading label="Asking the model…" /> : (
        <div className="stack">
          {data?.suggestion ? (
            <AiBox title="Buy suggestion" confidence={data.suggestion.confidence}
              usedFallback={data.suggestion.usedFallback}>
              <div style={{ fontSize: 18, fontWeight: 700 }}>
                {num(data.suggestion.suggestedQty, 0)} {item.uom}
              </div>
              {data.suggestion.narrative ? <p className="small">{data.suggestion.narrative}</p> : null}
              {data.suggestion.risk ? (
                <div className="banner warn small"><span><Icon name="alert" size={16} /></span><div>{data.suggestion.risk}</div></div>
              ) : null}
              <ul className="reasons">
                {data.suggestion.reasons.map((r: any) => (
                  <li key={r.code}><span>{r.label}</span><b>{r.value}</b></li>
                ))}
              </ul>
            </AiBox>
          ) : null}

          {data?.forecast?.points?.length ? (
            <div className="card">
              <div className="card-head"><h3>Expected demand, next 7 days</h3></div>
              <div className="card-body">
                <ResponsiveContainer width="100%" height={180}>
                  <AreaChart data={data.forecast.points}>
                    <CartesianGrid strokeDasharray="0" stroke={CHART.grid} vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d) => date(d).slice(0, 6)} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip labelFormatter={(l) => date(l)} />
                    <Area dataKey="p90" stroke="none" fill="#C7D2FE" />
                    <Area dataKey="p10" stroke="none" fill="#FFFFFF" />
                    <Line dataKey="p50" stroke="#4338CA" strokeWidth={2} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
                <div className="small muted">
                  Model: {data.forecast.model} · average {num(data.forecast.avgDaily, 1)}/day
                </div>
              </div>
            </div>
          ) : (
            <Empty icon="📉" title="Not enough sales history to forecast yet" />
          )}

          {data?.price?.trend && data.price.trend !== 'UNKNOWN' ? (
            <div className="card">
              <div className="card-head">
                <h3>Mandi price</h3>
                <Chip tone={data.price.trend === 'RISING' ? 'danger' : data.price.trend === 'FALLING' ? 'ok' : 'neutral'}>
                  {data.price.trend} {pctText(data.price.changePct)}
                </Chip>
              </div>
              <div className="card-body">
                <ResponsiveContainer width="100%" height={140}>
                  <LineChart data={data.price.points}>
                    <CartesianGrid strokeDasharray="0" stroke={CHART.grid} vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d) => date(d).slice(0, 6)} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v: any) => inr(v)} />
                    <Line dataKey="price" stroke="#D97706" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
                {data.price.recommendation ? (
                  <div className="banner info small mt"><span><Icon name="info" size={16} /></span><div>{data.price.recommendation}</div></div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

/* ======================================================= REQUIREMENTS ==== */
export function RequirementListPage() {
  const nav = useNavigate();
  const { data, loading, error } = useApi<any[]>('/planning/requirements');

  /* Everything the client asked for on this list — by time, priority, who
     raised it, which centre, and a search — plus what the filtered set adds
     up to, which is the reason anybody filters. */
  const f = useFilters<any>(data, {
    date: (r) => r.req_date,
    search: (r) => [r.req_no, r.branch_name, r.created_by_name, r.remarks,
      r.reasoning, r.raised_for_centre, r.product_names].filter(Boolean).join(' '),
    facets: [
      { key: 'status', label: 'status', of: (r) => r.status },
      { key: 'priority', label: 'priority', of: (r) => r.priority },
      { key: 'who', label: 'raiser', of: (r) => r.created_by_name },
      { key: 'centre', label: 'centre', of: (r) => r.raised_for_centre },
    ],
    totals: [
      { label: 'Products', of: (r) => Number(r.line_count) },
      { label: 'Quantity', of: (r) => Number(r.total_qty) },
    ],
  });

  return (
    <Layout title="Requirements" subtitle="What each branch and centre has asked to buy"
      actions={<button className="btn primary" onClick={() => nav('/buy-list')}>New from buy list</button>}>
      <ErrorBanner error={error} />
      <FilterBar f={f} placeholder="Search number, branch, who raised it, or why" />
      <FilterTotals f={f} noun="requirement" />
      <div className="card"><div className="card-body tight">
        <DataTable
          rows={f.rows} loading={loading}
          onRowClick={(r: any) => nav(`/requirements/${r.id}`)}
          rowTone={(r: any) => (r.priority === 'URGENT' ? 'crit' : undefined)}
          cols={[
            { key: 'n', head: 'Number', render: (r: any) => <b className="mono">{r.req_no}</b> },
            { key: 'd', head: 'Needed by', render: (r: any) => date(r.required_date) },
            { key: 'b', head: 'Branch', render: (r: any) => r.branch_name },
            { key: 'p', head: 'Priority', render: (r: any) => <Chip value={r.priority} /> },
            { key: 'src', head: 'Source', render: (r: any) => <span className="small muted">{r.source.replace(/_/g, ' ')}</span> },
            { key: 'l', head: 'Products', sort: (r: any) => r.product_names, render: (r: any) => (
              <div><b>{r.product_names ?? '—'}</b>
                <div className="small muted">{r.line_count} product{Number(r.line_count) === 1 ? '' : 's'}</div>
              </div>) },
            /* A shop asking for twenty 5 kg boxes is asking for a pack size,
               not just a quantity — and the person who has to answer it needs
               to see which. "100 KG" is only the arithmetic of the request. */
            { key: 'q', head: 'How much', num: true, desc: true,
              sort: (r: any) => Number(r.total_qty) || 0, render: (r: any) => (
              <div>
                {r.boxes_wanted
                  ? <><b>{r.boxes_wanted}</b>
                      <div className="small muted">{num(r.total_qty, 0)} kg in all</div></>
                  : num(r.total_qty, 0)}
              </div>) },
            { key: 's', head: 'Status', render: (r: any) => <Chip value={r.status} /> },
            { key: 'u', head: 'Raised by', render: (r: any) => (
              <div className="small">{r.created_by_name}
                {r.raised_for_centre ? (
                  <div className="muted">for {r.raised_for_centre}</div>) : null}
                {r.reasoning ? <div className="muted">{r.reasoning}</div> : null}
              </div>) },
          ]}
          empty={<Empty icon="📝" title="No requirements yet"
            hint="Start from the buy list — the system already knows what you are short of." />}
        />
      </div></div>
    </Layout>
  );
}

export function RequirementDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<any>(`/planning/requirements/${id}`, [id]);
  const [busy, setBusy] = useState(false);

  if (loading) return <Layout title="Requirement"><Loading /></Layout>;
  if (!data) return <Layout title="Requirement"><ErrorBanner error={error} /></Layout>;

  const submit = async () => {
    setBusy(true);
    try {
      await api.post(`/planning/requirements/${id}/submit`);
      toast('Requirement submitted for sourcing', 'ok');
      reload();
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <Layout title={`Requirement ${data.req_no}`}
      subtitle={`${data.branch_name} · needed by ${date(data.required_date)}`}
      actions={
        <div className="btn-row">
          <Chip value={data.status} />
          {data.status === 'DRAFT' && can('purchase.requirement.submit') ? (
            <button className="btn primary" disabled={busy} onClick={submit}>Submit</button>
          ) : null}
          {['APPROVED', 'SUBMITTED'].includes(data.status) && can('purchase.po.create') ? (
            <button className="btn primary" onClick={() => nav(`/purchase-orders/new?requirementId=${id}`)}>
              Compare sources &amp; order
            </button>
          ) : null}
        </div>
      }>
      <ErrorBanner error={error} />
      <div className="card">
        <div className="card-head"><h2>Products requested</h2></div>
        <div className="card-body tight">
          <DataTable
            rows={data.lines ?? []}
            cols={[
              { key: 'n', head: '#', width: 40, render: (l: any) => l.line_no },
              { key: 'p', head: 'Product', render: (l: any) => (
                <div><b>{l.product_name}</b><div className="small muted">{l.sku}</div></div>
              ) },
              { key: 'st', head: 'Stock then', num: true, render: (l: any) => num(l.current_stock, 0) },
              { key: 'sug', head: 'Suggested', num: true, render: (l: any) => num(l.suggested_qty, 0) },
              { key: 'f', head: 'Asked for', num: true, render: (l: any) => (
                l.pack_size_kg
                  /* What the shop actually asked for. The total underneath it
                     because that is what gets bought, but the boxes are the
                     request and the bench packs to them. */
                  ? <div>
                      <b>{num(l.pack_count, 0)} × {num(l.pack_size_kg, Number(l.pack_size_kg) % 1 ? 1 : 0)} kg boxes</b>
                      <div className="small muted">{num(l.final_qty, 0)} {l.uom} in all</div>
                    </div>
                  : <b>{num(l.final_qty, 0)} {l.uom}</b>
              ) },
              { key: 'e', head: 'Change reason', render: (l: any) =>
                l.edit_reason ? <span className="small">{l.edit_reason}</span> : <span className="muted small">—</span> },
              { key: 'c', head: 'Converted', num: true, render: (l: any) => num(l.converted_qty, 0) },
              { key: 's', head: 'Status', render: (l: any) => <Chip value={l.line_status} /> },
            ]}
          />
        </div>
      </div>

      {data.lines?.some((l: any) => l.duplicate_warning) ? (
        <div className="banner warn mt">
          <span><Icon name="alert" size={16} /></span>
          <div>Some of these products already have an open requirement. Check before ordering twice.</div>
        </div>
      ) : null}
    </Layout>
  );
}
