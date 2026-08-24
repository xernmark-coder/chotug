import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, useAuth, inr, num, date, dateTime, addDays, ago, pctText } from '../lib/api';
import {
  AiBox, Chip, Col, DataTable, Empty, ErrorBanner, Field, Layout, Loading, Modal, Steps, useApi, useToast,  FilterBar, FilterTotals, useFilters,
} from '../components/ui';
import { Icon } from '../components/icons';
import { SupplierModal } from './Finance';
import { ProductModal } from './Catalogue';

/* ========================================================= PO LIST ======= */
export function PoListPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { data, loading, error } = useApi<any[]>('/planning/purchase-orders');

  const f = useFilters<any>(data, {
    date: (o) => o.order_date,
    search: (o) => [o.po_no, o.supplier_name, o.supplier_legal_name, o.branch_name,
      o.supplier_response_note].filter(Boolean).join(' '),
    facets: [
      { key: 'status', label: 'status', of: (o) => o.status },
      { key: 'supplier', label: 'supplier', of: (o) => o.supplier_name ?? o.supplier_legal_name },
      { key: 'source', label: 'kind of supplier', of: (o) => o.source_type },
      { key: 'answer', label: 'answer', all: 'Any answer', of: (o) => o.supplier_response },
      { key: 'lorry', label: 'transport', all: 'Any transport', of: (o) =>
        o.pickup_no ? 'vehicle arranged'
          : o.transport_requested_at ? 'they want a vehicle' : null },
    ],
    /* Both numbers, because "42 orders" and "₹6.1 lakh" answer different
       questions and somebody filtering by supplier usually wants the second. */
    totals: [
      { label: 'Ordered', of: (o) => Number(o.grand_total), money: true },
      { label: 'Received', of: (o) => Number(o.received_qty ?? 0) },
    ],
  });

  return (
    <Layout title="Purchase orders" subtitle="Every order placed with a supplier"
      actions={can('purchase.po.create')
        ? <button className="btn primary" onClick={() => nav('/purchase-orders/new')}>New order</button>
        : undefined}>
      <ErrorBanner error={error} />
      <FilterBar f={f} placeholder="Search order number or supplier" />
      <FilterTotals f={f} noun="order" />
      <div className="card"><div className="card-body tight">
        <DataTable
          rows={f.rows} loading={loading}
          onRowClick={(o: any) => nav(`/purchase-orders/${o.id}`)}
          rowTone={(o: any) => (o.is_urgent ? 'warn' : Number(o.pending_approvals) > 0 ? 'warn' : undefined)}
          cols={[
            { key: 'n', head: 'Number', render: (o: any) => (
              <div><b className="mono">{o.po_no}</b>{o.revision_no > 0 ? <span className="small muted"> rev {o.revision_no}</span> : null}</div>
            ) },
            { key: 'd', head: 'Ordered', render: (o: any) => date(o.order_date) },
            { key: 's', head: 'Supplier', render: (o: any) => (
              <div><b>{o.supplier_name ?? o.supplier_legal_name}</b>
                <div className="small muted">{o.source_type}</div></div>
            ) },
            { key: 'e', head: 'Expected', render: (o: any) => date(o.expected_date) },
            { key: 'v', head: 'Value', num: true, render: (o: any) => inr(o.grand_total, 0) },
            { key: 'f', head: 'Received', num: true, render: (o: any) =>
              o.fill_pct == null ? '—' : (
                <div style={{ minWidth: 70 }}>
                  <div className="small">{num(o.fill_pct, 0)}%</div>
                  <div className="progress"><i style={{ width: `${Math.min(100, Number(o.fill_pct))}%` }} /></div>
                </div>
              ) },
            /* Our status and theirs are different facts. Ours says where the
               paperwork is; theirs says whether anybody is actually going to
               load a lorry. A CONFIRMED order the supplier declined used to
               look exactly like one being packed right now. */
            { key: 'sr', head: 'Supplier says', render: (o: any) => (
              o.status !== 'CONFIRMED' && o.supplier_response === 'PENDING'
                ? <span className="muted small">—</span>
              : o.supplier_response === 'DECLINED'
                ? <Chip tone="danger">declined{o.supplier_response_note ? ` — ${o.supplier_response_note}` : ''}</Chip>
              : o.supplier_response === 'PENDING'
                ? <Chip tone="warn">no answer yet</Chip>
              : o.payment_status && o.payment_status !== 'PAID'
                ? <Chip tone="warn">accepted · wants {inr(Number(o.payment_amount) - Number(o.payment_paid), 0)}</Chip>
              : <Chip tone="ok">accepted</Chip>
            ) },
            { key: 'st', head: 'Status', render: (o: any) => (
              <div className="row" style={{ gap: 4 }}>
                <Chip value={o.status} />
                {Number(o.pending_approvals) > 0 ? <Chip tone="warn">awaiting approval</Chip> : null}
                {o.is_urgent ? <Chip tone="danger">urgent</Chip> : null}
                {/* Somebody is standing next to crates waiting for an answer.
                    That belongs on the order, not only on Dispatch. */}
                {o.transport_requested_at && !o.pickup_no
                  ? <Chip tone="warn">wants a vehicle</Chip> : null}
                {o.pickup_no ? <Chip tone="ok">vehicle {String(o.pickup_status ?? '').toLowerCase()}</Chip> : null}
              </div>
            ) },
          ]}
          empty={<Empty icon="📦" title="No purchase orders yet" />}
        />
      </div></div>
    </Layout>
  );
}

/* ======================================================= PO CREATE ======= */
type Line = {
  productId: string; name: string; sku: string; uom: string;
  qty: number; rate: number; expectedWeightKg: number | null;
  requirementLineId?: string | null; expectedGrade?: string;
};

export function PoCreatePage() {
  const nav = useNavigate();
  const toast = useToast();
  const { branchId, me, can } = useAuth();
  const [sp] = useSearchParams();
  const requirementId = sp.get('requirementId');

  const { data: products, reload: reloadProducts } = useApi<any[]>('/masters/products');
  const { data: suppliers, reload: reloadSuppliers } = useApi<any[]>('/masters/suppliers');
  const { data: chargeTypes } = useApi<any[]>('/masters/charge-types');
  const { data: requirement } = useApi<any>(requirementId ? `/planning/requirements/${requirementId}` : null);

  const [supplierId, setSupplierId] = useState('');
  const [addingSupplier, setAddingSupplier] = useState(false);
  const [addingProduct, setAddingProduct] = useState(false);
  const [expectedDate, setExpectedDate] = useState(addDays(1));
  const [isUrgent, setIsUrgent] = useState(false);
  const [remarks, setRemarks] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [charges, setCharges] = useState<{ chargeTypeId: string; amount: number; allocationBasis: string }[]>([]);
  const [compareFor, setCompareFor] = useState<Line | null>(null);
  const [rateWarnings, setRateWarnings] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  // Seed the order straight from the requirement so nothing is retyped.
  useEffect(() => {
    if (!requirement?.lines) return;
    setLines(requirement.lines.map((l: any) => ({
      productId: l.product_id, name: l.product_name, sku: l.sku, uom: l.uom,
      qty: Number(l.final_qty) - Number(l.converted_qty ?? 0),
      rate: 0, expectedWeightKg: null, requirementLineId: l.id,
    })).filter((l: Line) => l.qty > 0));
  }, [requirement]);

  const supplier = suppliers?.find((s) => s.id === supplierId);
  const subtotal = lines.reduce((a, l) => a + l.qty * l.rate, 0);
  const chargeTotal = charges.reduce((a, c) => a + c.amount, 0);
  const total = subtotal + chargeTotal;
  const overLimit = me?.limits.maxPoValue != null && total > me.limits.maxPoValue;

  const checkRate = async (l: Line, rate: number) => {
    if (!rate) return;
    try {
      const r = await api.get<any>(`/costing/rate-check?productId=${l.productId}&rate=${rate}`);
      setRateWarnings((s) => ({ ...s, [l.productId]: r.message ?? '' }));
    } catch { /* advisory only */ }
  };

  const save = async (submitAfter: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const po = await api.post<any>('/planning/purchase-orders', {
        branchId, requirementId: requirementId ?? null,
        supplierId, sourceType: supplier?.source_type,
        expectedDate, isUrgent, remarks: remarks || undefined,
        paymentTermsDays: supplier?.payment_terms_days ?? 0,
        lines: lines.map((l) => ({
          productId: l.productId, requirementLineId: l.requirementLineId ?? null,
          qty: l.qty, uom: l.uom, rate: l.rate,
          expectedWeightKg: l.expectedWeightKg, expectedGrade: l.expectedGrade,
        })),
        charges: charges.filter((c) => c.chargeTypeId && c.amount > 0)
          .map((c) => ({ ...c, allocationBasis: c.allocationBasis as any })),
      });
      if (submitAfter) {
        const r = await api.post<any>(`/planning/purchase-orders/${po.id}/submit`);
        toast(r.message, 'ok');
      } else {
        toast(`${po.po_no} saved as draft`, 'ok');
      }
      nav(`/purchase-orders/${po.id}`);
    } catch (e: any) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Layout title="New purchase order"
      subtitle={requirement ? `From requirement ${requirement.req_no}` : 'Choose a source, then the products'}>
      <ErrorBanner error={error} />
      <Steps steps={['Choose source', 'Add products', 'Charges', 'Submit']}
        current={!supplierId ? 0 : lines.length === 0 ? 1 : 2} />

      <div className="grid sidebar-right">
        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>Source</h2></div>
            <div className="card-body">
              <div className="grid c2">
                <Field label="Supplier" hint="Blocked suppliers cannot be selected">
                  <div className="row" style={{ gap: 6 }}>
                    <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                      <option value="">Choose a supplier…</option>
                      {(suppliers ?? []).filter((s) => s.status !== 'BLOCKED').map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.trade_name ?? s.legal_name} — {s.source_type}
                          {s.performance_score ? ` (score ${Math.round(s.performance_score)})` : ''}
                        </option>
                      ))}
                    </select>
                    {/* You meet a new aadhti at the mandi and buy from him the
                        same morning. Making that a trip to a master screen is
                        how orders end up on the wrong supplier. */}
                    {can('master.supplier.manage') ? (
                      <button className="btn sm" onClick={() => setAddingSupplier(true)}>+ New</button>
                    ) : null}
                  </div>
                </Field>
                <Field label="Expected delivery date">
                  <input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
                </Field>
              </div>
              {supplier ? (
                <div className="row wrap" style={{ gap: 8 }}>
                  <Chip value={supplier.status} />
                  <Chip tone="neutral">{supplier.source_type}</Chip>
                  {supplier.payment_terms_days > 0
                    ? <Chip tone="primary">{supplier.payment_terms_days} day credit</Chip>
                    : <Chip tone="warn">cash / immediate</Chip>}
                  {supplier.commission_pct ? <Chip tone="warn">{supplier.commission_pct}% commission</Chip> : null}
                  {supplier.trust_score ? <span className="small muted">trust {Math.round(supplier.trust_score)}</span> : null}
                </div>
              ) : null}
              <label className="check mt">
                <input type="checkbox" checked={isUrgent} onChange={(e) => setIsUrgent(e.target.checked)} />
                Mark urgent (needs a manager's approval)
              </label>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Products</h2>
              <select style={{ width: 250 }} value=""
                onChange={(e) => {
                  const p = products?.find((x) => x.id === e.target.value);
                  if (!p || lines.some((l) => l.productId === p.id)) return;
                  setLines((s) => [...s, {
                    productId: p.id, name: p.name, sku: p.sku, uom: p.purchase_uom,
                    qty: 0, rate: 0, expectedWeightKg: null,
                  }]);
                }}>
                <option value="">Add a product…</option>
                {(products ?? []).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}
              </select>
              {can('master.product.manage') ? (
                <button className="btn sm" onClick={() => setAddingProduct(true)}>+ New</button>
              ) : null}
            </div>
            <div className="card-body tight">
              {lines.length === 0 ? (
                <Empty icon="🧺" title="No products yet" hint="Add products from the dropdown above." />
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr>
                      <th>Product</th><th className="num">Quantity</th><th className="num">Rate</th>
                      <th className="num">Expected kg</th><th className="num">Line total</th><th></th>
                    </tr></thead>
                    <tbody>
                      {lines.map((l, i) => (
                        <React.Fragment key={l.productId}>
                          <tr>
                            <td><b>{l.name}</b><div className="small muted">{l.sku}</div></td>
                            <td className="num">
                              <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                                <input className="inline num" style={{ width: 82 }} type="number" value={l.qty}
                                  onChange={(e) => setLines((s) => s.map((x, j) =>
                                    j === i ? { ...x, qty: Number(e.target.value) } : x))} />
                                <span className="small muted">{l.uom}</span>
                              </div>
                            </td>
                            <td className="num">
                              <input className="inline num" style={{ width: 82 }} type="number" value={l.rate}
                                onChange={(e) => setLines((s) => s.map((x, j) =>
                                  j === i ? { ...x, rate: Number(e.target.value) } : x))}
                                onBlur={(e) => checkRate(l, Number(e.target.value))} />
                            </td>
                            <td className="num">
                              <input className="inline num" style={{ width: 82 }} type="number"
                                value={l.expectedWeightKg ?? ''}
                                placeholder="—"
                                onChange={(e) => setLines((s) => s.map((x, j) =>
                                  j === i ? { ...x, expectedWeightKg: e.target.value ? Number(e.target.value) : null } : x))} />
                            </td>
                            <td className="num mono"><b>{inr(l.qty * l.rate)}</b></td>
                            <td>
                              <div className="row" style={{ gap: 4 }}>
                                <button className="btn sm ghost" title="Compare sources"
                                  onClick={() => setCompareFor(l)}>⚖️</button>
                                <button className="btn sm ghost"
                                  onClick={() => setLines((s) => s.filter((_, j) => j !== i))}><Icon name="alert" size={15} /></button>
                              </div>
                            </td>
                          </tr>
                          {rateWarnings[l.productId] ? (
                            <tr><td colSpan={6} style={{ paddingTop: 0 }}>
                              <div className="banner warn small"><span><Icon name="alert" size={16} /></span><div>{rateWarnings[l.productId]}</div></div>
                            </td></tr>
                          ) : null}
                        </React.Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Charges</h2>
              <button className="btn sm" onClick={() => setCharges((s) => [...s, { chargeTypeId: '', amount: 0, allocationBasis: 'VALUE' }])}>
                Add charge
              </button>
            </div>
            <div className="card-body">
              <p className="small muted">
                Commission, transport, hamali and mandi fee all become part of the landed cost.
                Leaving them out here means the margin you see later is wrong.
              </p>
              {charges.map((c, i) => (
                <div className="row mb" key={i}>
                  <select style={{ flex: 2 }} value={c.chargeTypeId}
                    onChange={(e) => {
                      const ct = chargeTypes?.find((x) => x.id === e.target.value);
                      setCharges((s) => s.map((x, j) => j === i
                        ? { ...x, chargeTypeId: e.target.value, allocationBasis: ct?.allocation_basis ?? 'VALUE' } : x));
                    }}>
                    <option value="">Charge type…</option>
                    {(chargeTypes ?? []).map((ct) => <option key={ct.id} value={ct.id}>{ct.name}</option>)}
                  </select>
                  <input style={{ flex: 1 }} type="number" placeholder="Amount" value={c.amount || ''}
                    onChange={(e) => setCharges((s) => s.map((x, j) => j === i ? { ...x, amount: Number(e.target.value) } : x))} />
                  <span className="small muted" style={{ width: 90 }}>by {c.allocationBasis.toLowerCase()}</span>
                  <button className="btn sm ghost" onClick={() => setCharges((s) => s.filter((_, j) => j !== i))}><Icon name="alert" size={15} /></button>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>Order summary</h2></div>
            <div className="card-body">
              <dl className="kv">
                <dt>Products</dt><dd>{lines.length}</dd>
                <dt>Goods value</dt><dd>{inr(subtotal)}</dd>
                <dt>Charges</dt><dd>{inr(chargeTotal)}</dd>
                <dt style={{ fontWeight: 600 }}>Order total</dt>
                <dd style={{ fontSize: 18, fontWeight: 700 }}>{inr(total)}</dd>
              </dl>
              {overLimit ? (
                <div className="banner warn mt small">
                  <span><Icon name="alert" size={16} /></span>
                  <div>This is above your approval limit of {inr(me?.limits.maxPoValue, 0)}. It will go to
                    a higher approver after you submit.</div>
                </div>
              ) : null}
              <Field label="Remarks">
                <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)}
                  placeholder="Anything the supplier or approver should know" />
              </Field>
              <div className="btn-row">
                <button className="btn primary block"
                  disabled={busy || !supplierId || !lines.length || lines.some((l) => !l.qty || !l.rate)}
                  onClick={() => save(true)}>
                  {busy ? 'Saving…' : 'Save & submit'}
                </button>
                <button className="btn block" disabled={busy || !supplierId || !lines.length}
                  onClick={() => save(false)}>Save as draft</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {compareFor ? (
        <CompareModal line={compareFor} suppliers={suppliers ?? []}
          onClose={() => setCompareFor(null)}
          onPick={(supId, rate) => {
            setSupplierId(supId);
            setLines((s) => s.map((x) => x.productId === compareFor.productId ? { ...x, rate } : x));
            setCompareFor(null);
          }} />
      ) : null}

      {addingSupplier ? (
        <SupplierModal supplier={{}} onClose={() => setAddingSupplier(false)}
          onDone={() => { setAddingSupplier(false); reloadSuppliers(); toast('Supplier added', 'ok'); }} />
      ) : null}

      {addingProduct ? (
        <ProductModal onClose={() => setAddingProduct(false)}
          onDone={(created?: any) => {
            setAddingProduct(false);
            reloadProducts();
            /* Straight onto the order. Adding a product in order to buy it and
               then having to find it again in the dropdown is the kind of small
               indignity that makes people keep a paper list instead. */
            if (created?.id) {
              setLines((s) => s.some((l) => l.productId === created.id) ? s : [...s, {
                productId: created.id, name: created.name, sku: created.sku,
                uom: created.purchase_uom ?? created.base_uom,
                qty: 0, rate: 0, expectedWeightKg: null,
              }]);
            }
            toast('Product added', 'ok');
          }} />
      ) : null}
    </Layout>
  );
}

/* §7 — source comparison on landed cost, not headline rate. */
/**
 * Landed-cost comparison across sources. Exported because the guided order
 * flow needs exactly this, and a second copy would be a second set of bugs.
 * The prop is the four fields it actually reads, not the PO page's Line, so
 * any caller with a product and a quantity can use it.
 */
export function CompareModal({ line, suppliers, onClose, onPick }: {
  line: { productId: string; name: string; uom: string; qty: number };
  suppliers: any[]; onClose: () => void;
  onPick: (supplierId: string, rate: number) => void;
}) {
  const toast = useToast();
  const [quotes, setQuotes] = useState(
    suppliers.filter((s) => s.status !== 'BLOCKED').slice(0, 4).map((s) => ({
      supplierId: s.id, name: s.trade_name ?? s.legal_name, sourceType: s.source_type,
      paymentTermsDays: s.payment_terms_days ?? 0,
      quotedRate: 0, commission: 0, transport: 0, loading: 0,
    })));
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const compare = async () => {
    const active = quotes.filter((q) => q.quotedRate > 0);
    if (!active.length) { toast('Enter at least one rate', 'err'); return; }
    setBusy(true);
    try {
      const r = await api.post<any>('/planning/quotes', {
        productId: line.productId,
        quotes: active.map((q) => ({
          supplierId: q.supplierId, sourceType: q.sourceType, quotedRate: q.quotedRate,
          uom: line.uom, paymentTermsDays: q.paymentTermsDays, qtyKg: line.qty || 1,
          charges: { commission: q.commission, transport: q.transport, loading: q.loading },
        })),
      });
      setResult(r);
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <Modal title={`Compare sources — ${line.name}`} onClose={onClose} wide
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={compare}>
          {busy ? 'Comparing…' : 'Compare landed cost'}
        </button>
      </>}>
      <p className="small muted mb">
        The cheapest rate is often not the cheapest purchase. This compares the true landed rate
        after commission, transport, expected rejection and the value of credit terms.
      </p>
      {/* The rate is per unit but the charges are for the whole load — that is
          how a mandi quotes, and leaving it unlabelled is how the wrong number
          gets typed into the wrong box. */}
      <div className="banner info mb">
        <span>ℹ</span>
        <div className="small">
          <b>Rate is ₹ per {line.uom}.</b> Commission, transport and loading are
          <b> ₹ for the whole load</b> of {num(line.qty, 0)} {line.uom} — not per {line.uom}.
          The system divides them out for you.
        </div>
      </div>
      <div className="table-wrap mb">
        <table className="data">
          <thead><tr>
            <th>Supplier</th>
            <th className="num">Rate<div className="small muted">₹ / {line.uom}</div></th>
            <th className="num">Commission<div className="small muted">₹ whole load</div></th>
            <th className="num">Transport<div className="small muted">₹ whole load</div></th>
            <th className="num">Loading<div className="small muted">₹ whole load</div></th>
            <th className="num">Credit<div className="small muted">days</div></th>
          </tr></thead>
          <tbody>
            {quotes.map((q, i) => (
              <tr key={q.supplierId}>
                <td><b>{q.name}</b><div className="small muted">{q.sourceType}</div></td>
                {(['quotedRate', 'commission', 'transport', 'loading'] as const).map((f) => (
                  <td className="num" key={f}>
                    <input className="inline num" style={{ width: 78 }} type="number" value={(q as any)[f] || ''}
                      onChange={(e) => setQuotes((s) => s.map((x, j) =>
                        j === i ? { ...x, [f]: Number(e.target.value) } : x))} />
                  </td>
                ))}
                <td className="num small muted">{q.paymentTermsDays}d</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {result ? (
        <>
          <AiBox title="Recommendation">
            <p style={{ margin: 0 }}>{result.recommendation.note}</p>
          </AiBox>
          <div className="table-wrap mt">
            <table className="data">
              <thead><tr>
                <th>#</th><th>Supplier</th>
                <th className="num">Quoted<div className="small muted">₹ / {line.uom}</div></th>
                <th className="num">Landed<div className="small muted">₹ / {line.uom}</div></th>
                <th className="num">Rejection<div className="small muted">%</div></th>
                <th className="num">On time<div className="small muted">%</div></th>
                <th></th>
              </tr></thead>
              <tbody>
                {result.quotes.map((q: any) => (
                  <tr key={q.quoteId} className={q.rank === 1 ? 'row-warn' : ''}>
                    <td><b>{q.rank}</b></td>
                    <td>
                      <b>{q.supplierName}</b>
                      {q.isNewSupplier ? <Chip tone="warn">new supplier</Chip> : null}
                      <div className="small muted">{q.sourceType}</div>
                    </td>
                    <td className="num mono">{inr(q.quotedRate)}</td>
                    <td className="num mono"><b>{inr(q.landedRate)}</b></td>
                    <td className="num">{q.rejectionPct != null ? `${num(q.rejectionPct, 1)}%` : '—'}</td>
                    <td className="num">{q.onTimePct != null ? `${num(q.onTimePct, 0)}%` : '—'}</td>
                    <td>
                      <button className="btn sm primary" onClick={() => onPick(q.supplierId, q.quotedRate)}>
                        Use this
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </Modal>
  );
}

/* ======================================================= PO DETAIL ======= */
export function PoDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<any>(`/planning/purchase-orders/${id}`, [id]);
  const [busy, setBusy] = useState(false);
  const [revising, setRevising] = useState(false);

  if (loading) return <Layout title="Purchase order"><Loading /></Layout>;
  if (!data) return <Layout title="Purchase order"><ErrorBanner error={error} /></Layout>;

  const act = async (path: string, msg: string) => {
    setBusy(true);
    try {
      const r = await api.post<any>(path);
      toast(r.message ?? msg, 'ok');
      reload();
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const stepIndex = ['DRAFT', 'SUBMITTED', 'APPROVED', 'CONFIRMED', 'PART_RECEIVED', 'RECEIVED']
    .indexOf(data.status);

  return (
    <Layout title={`${data.po_no}`}
      subtitle={`${data.supplier_name ?? data.supplier_legal_name} · ${data.branch_name} · expected ${date(data.expected_date)}`}
      actions={
        <div className="btn-row">
          <Chip value={data.status} />
          {data.status === 'DRAFT' && can('purchase.po.submit') ? (
            <button className="btn primary" disabled={busy}
              onClick={() => act(`/planning/purchase-orders/${id}/submit`, 'Submitted')}>Submit</button>
          ) : null}
          {/* This used to read "Confirm with supplier", which described a phone
              call and quietly claimed the supplier had agreed. They had not.
              This button only PLACES the order on their panel; the supplier
              confirms it there, and that answer comes back on its own. */}
          {data.status === 'APPROVED' && can('purchase.po.approve') ? (
            <button className="btn primary" disabled={busy}
              onClick={() => act(`/planning/purchase-orders/${id}/confirm`, 'Sent to the supplier')}>
              Send to supplier
            </button>
          ) : null}
          {['APPROVED', 'CONFIRMED'].includes(data.status) && can('logistics.pickup.manage') ? (
            <button className="btn" onClick={() => nav('/dispatch')}>Arrange a vehicle</button>
          ) : null}
          {['APPROVED', 'CONFIRMED', 'PART_RECEIVED'].includes(data.status) && can('purchase.po.revise') ? (
            <button className="btn" onClick={() => setRevising(true)}>Revise</button>
          ) : null}
        </div>
      }>
      <ErrorBanner error={error} />
      {stepIndex >= 0 ? (
        <Steps steps={['Draft', 'Submitted', 'Approved', 'Confirmed', 'Receiving', 'Received']} current={stepIndex} />
      ) : null}

      {/* Where the order actually stands with the person who has to supply it.
          The status chip says CONFIRMED as soon as the buyer sends it, which
          says nothing about whether the supplier has agreed — this does. */}
      {data.status === 'CONFIRMED' && data.supplier_response === 'PENDING' ? (
        <div className="banner info mb">
          <span><Icon name="clock" size={16} /></span>
          <div>
            <b>Waiting for {data.supplier_name ?? 'the supplier'} to accept.</b>{' '}
            It is on their panel now. They confirm it there — you will be told when they do.
            {data.supplier_phone ? <> Ring them on{' '}
              <a href={`tel:${data.supplier_phone}`} className="mono">{data.supplier_phone}</a>{' '}
              if it is urgent.</> : null}
          </div>
        </div>
      ) : null}

      {data.supplier_response === 'ACCEPTED' ? (
        <div className={`banner ${data.payment_status === 'PAID' ? 'ok' : 'warn'} mb`}>
          <span><Icon name={data.payment_status === 'PAID' ? 'check' : 'coins'} size={16} /></span>
          <div>
            <b>{data.supplier_name ?? 'The supplier'} has accepted this order.</b>{' '}
            {data.payment_status === 'PAID'
              ? `Paid — ${data.payment_request_no}. They can send it.`
              : data.payment_request_no
                ? <>They have asked for payment — <b>{data.payment_request_no}</b> is with Finance
                    ({String(data.payment_status ?? '').toLowerCase() || 'waiting'}).</>
                : 'Arrange payment so they can dispatch.'}
            {data.supplier_response_note ? <div className="small">"{data.supplier_response_note}"</div> : null}
          </div>
        </div>
      ) : null}

      {data.transport_requested_at && !data.pickup_no ? (
        <div className="banner warn mb">
          <span><Icon name="truck" size={16} /></span>
          <div>
            <b>{data.supplier_name ?? 'The supplier'} is asking for a vehicle.</b>{' '}
            {data.transport_request_note ?? 'No details given.'}{' '}
            {can('logistics.pickup.manage')
              ? <>Arrange one on <a href="/dispatch">Dispatch</a>.</>
              : 'Finance or the office will arrange one.'}
          </div>
        </div>
      ) : null}

      {data.pickup_no ? (
        <div className="banner ok mb">
          <span><Icon name="truck" size={16} /></span>
          <div>
            <b>Vehicle {data.pickup_no}</b> —{' '}
            {String(data.pickup_status ?? '').toLowerCase() || 'arranged'}.
          </div>
        </div>
      ) : null}

      {data.supplier_response === 'DECLINED' ? (
        <div className="banner danger mb">
          <span><Icon name="alert" size={16} /></span>
          <div>
            <b>{data.supplier_name ?? 'The supplier'} declined this order.</b>{' '}
            {data.supplier_response_note ?? 'No reason given.'} Place it elsewhere.
          </div>
        </div>
      ) : null}

      {data.approvals?.filter((a: any) => a.status === 'PENDING').length ? (
        <div className="banner warn mb">
          <span><Icon name="clock" size={16} /></span>
          <div>
            <b>Waiting for approval.</b>{' '}
            {data.approvals.filter((a: any) => a.status === 'PENDING')
              .map((a: any) => `Level ${a.level} (${a.triggers.join(', ')})`).join(' · ')}
          </div>
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
                  { key: 'n', head: '#', width: 40, render: (l: any) => l.line_no },
                  { key: 'p', head: 'Product', render: (l: any) => (
                    <div><b>{l.product_name}</b><div className="small muted">{l.sku}</div></div>
                  ) },
                  { key: 'q', head: 'Ordered', num: true, render: (l: any) => `${num(l.qty, 0)} ${l.uom}` },
                  { key: 'r', head: 'Rate', num: true, render: (l: any) => inr(l.rate) },
                  { key: 'rec', head: 'Received', num: true, render: (l: any) => num(l.received_qty, 0) },
                  { key: 'acc', head: 'Accepted', num: true, render: (l: any) => num(l.accepted_qty, 0) },
                  { key: 'rej', head: 'Rejected', num: true, render: (l: any) =>
                    Number(l.rejected_qty) > 0 ? <b style={{ color: 'var(--danger)' }}>{num(l.rejected_qty, 0)}</b> : '—' },
                  { key: 't', head: 'Total', num: true, render: (l: any) => inr(l.line_total) },
                  { key: 's', head: 'Status', render: (l: any) => <Chip value={l.line_status} /> },
                ]}
              />
            </div>
          </div>

          {data.charges?.length ? (
            <div className="card">
              <div className="card-head"><h2>Charges</h2></div>
              <div className="card-body tight">
                <DataTable rows={data.charges} cols={[
                  { key: 'n', head: 'Charge', render: (c: any) => c.name },
                  { key: 'b', head: 'Allocated by', render: (c: any) => <span className="small muted">{c.allocation_basis}</span> },
                  { key: 'w', head: 'Borne by', render: (c: any) => <Chip tone="neutral">{c.borne_by}</Chip> },
                  { key: 'a', head: 'Amount', num: true, render: (c: any) => inr(c.amount) },
                ]} />
              </div>
            </div>
          ) : null}

          {data.revisions?.length ? (
            <div className="card">
              <div className="card-head"><h2>Revision history</h2></div>
              <div className="card-body tight">
                <DataTable rows={data.revisions} cols={[
                  { key: 'r', head: 'Rev', render: (r: any) => r.revision_no },
                  { key: 'w', head: 'By', render: (r: any) => r.changed_by_name },
                  { key: 'd', head: 'When', render: (r: any) => dateTime(r.changed_at) },
                  { key: 'why', head: 'Reason', render: (r: any) => r.reason_text },
                  { key: 'diff', head: 'Changed', render: (r: any) => (
                    <span className="small mono">
                      {(r.diff ?? []).map((d: any) =>
                        `L${d.lineNo}: ${d.qty.from}→${d.qty.to} @ ${d.rate.from}→${d.rate.to}`).join('; ')}
                    </span>
                  ) },
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
                <dt>Goods value</dt><dd>{inr(data.subtotal)}</dd>
                <dt>Charges</dt><dd>{inr(data.charge_total)}</dd>
                <dt style={{ fontWeight: 600 }}>Order total</dt>
                <dd style={{ fontSize: 17, fontWeight: 700 }}>{inr(data.grand_total)}</dd>
                <dt>Payment terms</dt><dd>{data.payment_terms_days} days</dd>
                <dt>Transport by</dt><dd>{data.transport_by}</dd>
                <dt>Raised by</dt><dd>{data.created_by_name}</dd>
                {data.approved_by_name ? <><dt>Approved by</dt><dd>{data.approved_by_name}</dd></> : null}
              </dl>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h2>Supplier</h2></div>
            <div className="card-body">
              <div style={{ fontWeight: 600 }}>{data.supplier_name ?? data.supplier_legal_name}</div>
              <div className="small muted mb">
                {data.supplier_source_type} ·{' '}
                {/* A number to ring if you want to, not a step in the flow. */}
                {data.supplier_phone
                  ? <a href={`tel:${data.supplier_phone}`} className="mono">{data.supplier_phone}</a>
                  : 'no phone'}
              </div>
              <div className="row wrap" style={{ gap: 6 }}>
                {data.performance_score ? <Chip tone={data.performance_score >= 70 ? 'ok' : 'warn'}>
                  performance {Math.round(data.performance_score)}</Chip> : null}
                {data.trust_score ? <Chip tone="neutral">trust {Math.round(data.trust_score)}</Chip> : null}
              </div>
            </div>
          </div>

          {data.approvals?.length ? (
            <div className="card">
              <div className="card-head"><h2>Approvals</h2></div>
              <div className="card-body stack">
                {data.approvals.map((a: any) => (
                  <div key={a.id} className="row" style={{ alignItems: 'flex-start' }}>
                    <Chip value={a.status} />
                    <div className="small">
                      <div>Level {a.level} · {a.triggers.join(', ')}</div>
                      <div className="muted">
                        {a.requester_name} → {a.approver_name ?? 'pending'}
                        {a.decided_at ? ` · ${dateTime(a.decided_at)}` : ` · ${ago(a.requested_at)}`}
                      </div>
                      {a.reason_text ? <div className="muted">"{a.reason_text}"</div> : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {revising ? <ReviseModal po={data} onClose={() => setRevising(false)} onDone={reload} /> : null}
    </Layout>
  );
}

function ReviseModal({ po, onClose, onDone }: { po: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState(po.lines.map((l: any) => ({
    lineId: l.id, name: l.product_name, qty: Number(l.qty), rate: Number(l.rate),
    receivedQty: Number(l.received_qty),
  })));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/planning/purchase-orders/${po.id}/revise`, {
        reasonText: reason,
        lines: lines.map((l: any) => ({ lineId: l.lineId, qty: l.qty, rate: l.rate })),
      });
      toast('Order revised — it goes back for approval', 'ok');
      onDone();
      onClose();
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <Modal title={`Revise ${po.po_no}`} onClose={onClose} wide
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || reason.length < 4} onClick={save}>Save revision</button>
      </>}>
      <div className="banner warn mb">
        <span><Icon name="alert" size={16} /></span>
        <div>A revision re-opens approval and is recorded with the old and new values.
          You cannot reduce a line below what has already been received.</div>
      </div>
      <div className="table-wrap mb">
        <table className="data">
          <thead><tr><th>Product</th><th className="num">Received</th><th className="num">Quantity</th><th className="num">Rate</th></tr></thead>
          <tbody>
            {lines.map((l: any, i: number) => (
              <tr key={l.lineId}>
                <td>{l.name}</td>
                <td className="num mono">{num(l.receivedQty, 0)}</td>
                <td className="num">
                  <input className="inline num" style={{ width: 82 }} type="number" value={l.qty}
                    onChange={(e) => setLines((s: any) => s.map((x: any, j: number) =>
                      j === i ? { ...x, qty: Number(e.target.value) } : x))} />
                </td>
                <td className="num">
                  <input className="inline num" style={{ width: 82 }} type="number" value={l.rate}
                    onChange={(e) => setLines((s: any) => s.map((x: any, j: number) =>
                      j === i ? { ...x, rate: Number(e.target.value) } : x))} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Field label="Reason for revision" hint="Shown to the approver and kept in the audit trail">
        <textarea value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Supplier could only supply 800 kg instead of 1000 kg" />
      </Field>
    </Modal>
  );
}

/* ====================================================== APPROVALS ======== */
export function ApprovalsPage() {
  const nav = useNavigate();
  const toast = useToast();
  const { data, loading, error, reload } = useApi<any[]>('/planning/approvals?status=PENDING');
  const [decide, setDecide] = useState<{ a: any; action: 'APPROVE' | 'HOLD' | 'REJECT' } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const f = useFilters<any>(data, {
    date: (a: any) => a.requested_at,
    search: (a: any) => [a.doc_no, a.requester_name, a.doc_summary?.supplier,
      ...(a.triggers ?? [])].filter(Boolean).join(' '),
    facets: [
      { key: 'sup', label: 'supplier', of: (a: any) => a.doc_summary?.supplier },
      { key: 'by', label: 'raised by', of: (a: any) => a.requester_name },
      { key: 'lv', label: 'level', of: (a: any) => `L${a.level}` },
      { key: 'ty', label: 'document', of: (a: any) => a.doc_type },
      { key: 'sla', label: 'timing', all: 'Early and late', of: (a: any) =>
        (a.sla_breached ? 'overdue' : 'in time') },
    ],
    totals: [
      { label: 'Waiting', of: () => 1 },
      { label: 'Value', of: (a: any) => Number(a.doc_summary?.total) || 0, money: true },
    ],
  });

  const submit = async () => {
    if (!decide) return;
    setBusy(true);
    try {
      await api.post(`/planning/approvals/${decide.a.id}/decide`, {
        decision: decide.action,
        reasonText: reason || undefined,
      });
      toast(`${decide.a.doc_no} ${decide.action.toLowerCase()}d`, 'ok');
      setDecide(null);
      setReason('');
      reload();
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <Layout title="Approvals" subtitle="Approve, hold, or reject — nothing else"
      actions={<button className="btn sm" onClick={reload}>Refresh</button>}>
      <ErrorBanner error={error} />
      <FilterBar f={f} placeholder="Search document, supplier, person" />
      <FilterTotals f={f} noun="approval" />
      <div className="card"><div className="card-body tight">
        <DataTable
          rows={f.rows} loading={loading}
          rowTone={(a: any) => (a.sla_breached ? 'crit' : a.level >= 3 ? 'warn' : undefined)}
          cols={[
            { key: 'd', head: 'Document', render: (a: any) => (
              <div>
                <b className="mono">{a.doc_no}</b>
                <div className="small muted">{a.doc_type.replace(/_/g, ' ')}</div>
              </div>
            ) },
            { key: 'w', head: 'Why', render: (a: any) => (
              <div className="row wrap" style={{ gap: 4 }}>
                {a.triggers.map((t: string) => <Chip key={t} tone="warn">{t.replace(/_/g, ' ').toLowerCase()}</Chip>)}
              </div>
            ) },
            { key: 'v', head: 'Value', num: true, render: (a: any) =>
              a.doc_summary?.total ? inr(a.doc_summary.total, 0) : '—' },
            { key: 's', head: 'Supplier', render: (a: any) => a.doc_summary?.supplier ?? '—' },
            { key: 'l', head: 'Level', num: true, render: (a: any) => <Chip tone={a.level >= 3 ? 'danger' : 'primary'}>L{a.level}</Chip> },
            { key: 'r', head: 'Raised by', render: (a: any) => (
              <div className="small">{a.requester_name}<div className="muted">{ago(a.requested_at)}</div></div>
            ) },
            { key: 'sla', head: 'Due', render: (a: any) =>
              a.sla_breached ? <Chip tone="danger">overdue</Chip> : <span className="small muted">{dateTime(a.sla_due_at)}</span> },
            { key: 'act', head: '', width: 220, render: (a: any) => (
              <div className="btn-row" onClick={(e) => e.stopPropagation()}>
                <button className="btn sm primary" onClick={() => setDecide({ a, action: 'APPROVE' })}>Approve</button>
                <button className="btn sm" onClick={() => setDecide({ a, action: 'HOLD' })}>Hold</button>
                <button className="btn sm danger" onClick={() => setDecide({ a, action: 'REJECT' })}>Reject</button>
              </div>
            ) },
          ]}
          onRowClick={(a: any) => a.doc_type === 'PO' && nav(`/purchase-orders/${a.doc_id}`)}
          empty={<Empty icon="✅" title={f.active > 0
            ? 'Nothing matches those filters' : 'Nothing waiting for your approval'} />}
        />
      </div></div>

      {decide ? (
        <Modal title={`${decide.action[0]}${decide.action.slice(1).toLowerCase()} ${decide.a.doc_no}?`}
          onClose={() => setDecide(null)}
          footer={<>
            <button className="btn" onClick={() => setDecide(null)}>Cancel</button>
            <button className={`btn ${decide.action === 'REJECT' ? 'danger' : 'primary'}`}
              disabled={busy || (decide.action !== 'APPROVE' && reason.length < 3)}
              onClick={submit}>Confirm</button>
          </>}>
          <dl className="kv mb">
            <dt>Triggered by</dt><dd>{decide.a.triggers.join(', ')}</dd>
            {decide.a.doc_summary?.total ? <><dt>Value</dt><dd>{inr(decide.a.doc_summary.total)}</dd></> : null}
            {decide.a.doc_summary?.supplier ? <><dt>Supplier</dt><dd>{decide.a.doc_summary.supplier}</dd></> : null}
            <dt>Raised by</dt><dd>{decide.a.requester_name}</dd>
          </dl>
          <Field label={decide.action === 'APPROVE' ? 'Note (optional)' : 'Reason (required)'}>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder={decide.action === 'REJECT'
                ? 'Tell the buyer what to fix' : 'Why is this being held?'} />
          </Field>
        </Modal>
      ) : null}
    </Layout>
  );
}
