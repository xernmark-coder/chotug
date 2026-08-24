import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, useAuth, inr, num, date, ago, addDays } from '../lib/api';
import {
  Chip, DataTable, Empty, ErrorBanner, Field, Layout, Loading, ReasonPicker, Steps,
  useApi, useReasonBank, useToast,
} from '../components/ui';
import { Icon } from '../components/icons';
import { SupplierModal } from './Finance';
import { CompareModal } from './Purchase';

/* ===========================================================================
 * GUIDED ORDER
 *
 * The same four server calls the separate screens make — requirement, submit,
 * purchase order, submit, confirm — driven as one Next / Next / Next flow for
 * somebody who owns the whole decision and should not have to walk between
 * four screens to make it.
 *
 * Nothing here is a shortcut around a rule. Every approval threshold, rate
 * warning and maker-checker constraint is exactly the server's, and when an
 * approval is genuinely somebody else's to give, the flow stops and says so
 * rather than pretending the order is placed.
 * ======================================================================== */

type Pick = {
  productId: string; name: string; sku: string; uom: string;
  suggestedQty: number; qty: number; editReason: string;
  currentStock: number; availableStock: number; openPoQty: number;
  avgDailySale: number; leadTimeDays: number; minStock: number; maxStock: number;
  advanceOrderQty: number; lastRate: number | null; urgency: string;
  triggers: string[]; reasons: any;
  rate: number; requirementLineId?: string | null; rateNote?: string;
};

/** One slice of a line: this much, from this supplier, at this rate. */
type Alloc = { supplierId: string; qty: number; rate: number };

/** A purchase order this flow raised, and what happened to it. */
type PlacedOrder = {
  po: any; supplierId: string; outcome: any; confirmed: any; confirming?: boolean;
};

const STEPS = ['What to buy', 'Confirm need', 'Supplier & rates', 'Raise orders', 'Send to suppliers'];

export function QuickOrderPage() {
  const nav = useNavigate();
  const toast = useToast();
  const { branchId, me, can } = useAuth();

  /* This page raises, approves and confirms in one sweep, so opening it is the
   * same as holding every step's authority at once. The sidebar hides it from
   * everyone but the Owner; this refuses the URL as well, because a hidden link
   * is not a permission check. The server still guards each call underneath. */
  if (!can('admin.override')) {
    return (
      <Layout title="Order in one flow">
        <Empty icon="lock" title="This shortcut is for the owner only"
          hint="Raising an order, approving it and sending it to the supplier are
                separate jobs for separate people. Use What to Buy, then Requirements,
                then Purchase Orders." />
      </Layout>
    );
  }


  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  /* --- step 0 ------------------------------------------------------------ */
  const buy = useApi<any>(branchId ? `/planning/requirement-note?branchId=${branchId}` : null, [branchId]);
  const [picked, setPicked] = useState<Record<string, Pick>>({});
  const reasonBank = useReasonBank();
  const [onlyNeeded, setOnlyNeeded] = useState(true);

  const items = useMemo(() => {
    const all = buy.data?.items ?? [];
    return onlyNeeded ? all.filter((i: any) => i.suggestedQty > 0) : all;
  }, [buy.data, onlyNeeded]);

  // Ticked and orderable are different things: a product that is not short
  // suggests 0, so ticking it alone would silently contribute nothing. Keep
  // both, and make the gap block the step instead of disappearing.
  const ticked = Object.values(picked);
  const chosen = ticked.filter((p) => p.qty > 0);
  const needsQty = ticked.filter((p) => !(p.qty > 0));

  const toggle = (i: any, on: boolean) => {
    setPicked((s) => {
      const next = { ...s };
      if (!on) { delete next[i.productId]; return next; }
      next[i.productId] = {
        productId: i.productId, name: i.name, sku: i.sku, uom: i.uom,
        suggestedQty: i.suggestedQty, qty: i.suggestedQty, editReason: '',
        currentStock: i.currentStock, availableStock: i.availableStock,
        openPoQty: i.openPoQty, avgDailySale: i.avgDailySale,
        leadTimeDays: i.leadTimeDays, minStock: i.minStock, maxStock: i.maxStock,
        advanceOrderQty: i.advanceOrderQty, lastRate: i.lastRate, urgency: i.urgency,
        triggers: i.triggers ?? [], reasons: i.reasons,
        rate: Number(i.lastRate ?? 0),
      };
      return next;
    });
  };

  const patch = (id: string, p: Partial<Pick>) =>
    setPicked((s) => ({ ...s, [id]: { ...s[id], ...p } }));

  /* --- step 1 ------------------------------------------------------------ */
  const [requiredDate, setRequiredDate] = useState(addDays(1));
  const [priority, setPriority] = useState<'NORMAL' | 'HIGH' | 'URGENT'>('NORMAL');
  const [requirement, setRequirement] = useState<any>(null);
  const [reqOutcome, setReqOutcome] = useState<any>(null);

  /* --- step 2 ------------------------------------------------------------ */
  const suppliers = useApi<any[]>('/masters/suppliers');
  const [allocs, setAllocs] = useState<Record<string, Alloc[]>>({});
  const [compareFor, setCompareFor] = useState<{ line: Pick; index: number } | null>(null);
  const [addingSupplier, setAddingSupplier] = useState<{ line: Pick; index: number } | null>(null);
  // The compare endpoint is permission-gated server-side; hide the button
  // rather than offer a click that can only 403.
  const canCompare = can('purchase.quote.compare');

  /* What the suppliers are asking, posted by them from their own panel. The
     buyer used to type a rate he had been told on the phone; now the number
     is already here and he picks one. */
  /* Orders raised on an earlier run of this flow and never sent. Leaving the
     page half way used to lose them: the flow restarted at step 0 and the
     orders sat in APPROVED with nobody looking at them. */
  const unsent = useApi<any[]>('/planning/purchase-orders?status=APPROVED');

  const askedRates = useApi<any[]>(
    can('purchase.rate.compare') ? '/planning/supplier-rates' : null, []);
  const ratesFor = (productId: string) =>
    (askedRates.data ?? []).filter((r: any) => r.product_id === productId);
  const [expectedDate, setExpectedDate] = useState(addDays(1));

  const supplierOf = (id: string) => (suppliers.data ?? []).find((s) => s.id === id);
  const supplierName = (id: string) => {
    const s = supplierOf(id);
    return s ? (s.trade_name ?? s.legal_name) : 'supplier';
  };

  /** Quantities are decimal; keep the arithmetic off floating-point dust. */
  const round3 = (n: number) => Math.round(n * 1000) / 1000;

  /** Rows for a line, seeded with one row covering the whole quantity. */
  const rowsFor = (l: Pick): Alloc[] =>
    allocs[l.productId] ?? [{ supplierId: '', qty: l.qty, rate: Number(l.lastRate ?? 0) }];

  const setRows = (productId: string, rows: Alloc[]) =>
    setAllocs((s) => ({ ...s, [productId]: rows }));

  /**
   * Editing one slice re-balances the others so the split always adds up to
   * what was decided to buy. Type 5 against a second supplier and the first
   * drops from 20 to 15 — rather than quietly ordering 25 because two boxes
   * on the same screen were each filled in on their own.
   *
   * Surplus comes off the largest other slice first, which is the one the
   * person is most likely to have meant to take it from, and never below zero.
   */
  const patchRow = (l: Pick, i: number, p: Partial<Alloc>) => {
    let rows = rowsFor(l).map((r, j) => (j === i ? { ...r, ...p } : r));

    if (p.qty !== undefined && rows.length > 1) {
      // The edited slice can never exceed the whole line on its own.
      const capped = Math.min(Math.max(Number(p.qty) || 0, 0), l.qty);
      rows = rows.map((r, j) => (j === i ? { ...r, qty: capped } : r));

      let surplus = round3(rows.reduce((a, r) => a + (Number(r.qty) || 0), 0) - l.qty);
      while (surplus > 0.0005) {
        const victim = rows
          .map((r, j) => ({ j, qty: Number(r.qty) || 0 }))
          .filter((r) => r.j !== i && r.qty > 0)
          .sort((a, b) => b.qty - a.qty)[0];
        if (!victim) break;                       // nothing left to take from
        const take = Math.min(victim.qty, surplus);
        rows = rows.map((r, j) => (j === victim.j ? { ...r, qty: round3(victim.qty - take) } : r));
        surplus = round3(surplus - take);
      }
    }

    setRows(l.productId, rows);
  };

  const addRow = (l: Pick) => {
    const rows = rowsFor(l);
    const left = round3(l.qty - rows.reduce((a, r) => a + (Number(r.qty) || 0), 0));
    // Usually zero, because the first slice already holds the whole line —
    // so the new row starts empty and takes what you type off the others.
    setRows(l.productId, [...rows, {
      supplierId: '', qty: Math.max(0, left), rate: Number(l.lastRate ?? 0),
    }]);
  };

  const removeRow = (l: Pick, i: number) =>
    setRows(l.productId, rowsFor(l).filter((_, j) => j !== i));

  const allocatedOn = (l: Pick) => rowsFor(l).reduce((a, r) => a + (Number(r.qty) || 0), 0);
  const shortOn = (l: Pick) => Math.round((l.qty - allocatedOn(l)) * 1000) / 1000;

  /* One order per supplier. Splitting 50 kg across two mandis is two purchase
   * orders against one requirement — which is what actually happens, and what
   * the schema already models: requirement_lines.converted_qty accumulates and
   * the line goes PART_CONVERTED until the whole quantity is covered. */
  const bySupplier = () => {
    const map = new Map<string, { supplierId: string; lines: (Alloc & { line: Pick })[] }>();
    for (const l of chosen) {
      for (const r of rowsFor(l)) {
        if (!r.supplierId || !(Number(r.qty) > 0)) continue;
        if (!map.has(r.supplierId)) map.set(r.supplierId, { supplierId: r.supplierId, lines: [] });
        map.get(r.supplierId)!.lines.push({ ...r, line: l });
      }
    }
    return [...map.values()];
  };

  const orderTotal = (o: { lines: (Alloc & { line: Pick })[] }) =>
    o.lines.reduce((a, r) => a + Number(r.qty) * Number(r.rate), 0);

  /* --- step 3 ------------------------------------------------------------ */
  const [orders, setOrders] = useState<PlacedOrder[]>([]);

  const subtotal = bySupplier().reduce((a, o) => a + orderTotal(o), 0);
  // The limit applies to each order, not to the basket — splitting across two
  // suppliers can keep both inside an authority that the total would exceed.
  const overLimit = me?.limits.maxPoValue != null
    && bySupplier().some((o) => orderTotal(o) > me.limits.maxPoValue!);

  const allocProblem = (() => {
    for (const l of chosen) {
      const rows = rowsFor(l);
      if (rows.some((r) => !r.supplierId)) return `Choose a supplier for ${l.name}`;
      if (rows.some((r) => !(Number(r.rate) > 0))) return `Enter a rate for ${l.name}`;
      const short = shortOn(l);
      if (Math.abs(short) > 0.001) {
        return short > 0
          ? `${num(short, 2)} ${l.uom} of ${l.name} is not assigned to anyone`
          : `${num(-short, 2)} ${l.uom} more than needed is assigned for ${l.name}`;
      }
    }
    return null;
  })();

  /* Advisory only — the server decides, this just warns before you commit. */
  const checkRate = async (l: Pick, rate: number) => {
    if (!rate) return;
    try {
      const r = await api.get<any>(`/costing/rate-check?productId=${l.productId}&rate=${rate}`);
      patch(l.productId, { rateNote: r.message ?? '' });
    } catch { /* advisory only */ }
  };

  /* ---------------------------------------------------------------- moves */

  const createNeed = async () => {
    const missing = chosen.find((l) => l.qty !== l.suggestedQty && !l.editReason.trim());
    if (missing) {
      toast(`Say why you changed the quantity for ${missing.name}`, 'err');
      return;
    }
    for (const l of chosen) if (l.qty !== l.suggestedQty) reasonBank.remember(l.editReason);
    setBusy(true); setError(null);
    try {
      const created = await api.post<any>('/planning/requirements', {
        branchId,
        requiredDate,
        priority: chosen.some((l) => l.urgency === 'URGENT') ? 'URGENT' : priority,
        source: 'LOW_STOCK',
        lines: chosen.map((l) => ({
          productId: l.productId, uom: l.uom,
          finalQty: l.qty, suggestedQty: l.suggestedQty,
          suggestedBy: 'RULE', suggestionReason: l.reasons,
          editReason: l.editReason.trim() || null,
          currentStock: l.currentStock, availableStock: l.availableStock,
          openPoQty: l.openPoQty, avgDailySale: l.avgDailySale,
          leadTimeDays: l.leadTimeDays, minStock: l.minStock, maxStock: l.maxStock,
          advanceOrderQty: l.advanceOrderQty,
        })),
      });
      const outcome = await api.post<any>(`/planning/requirements/${created.id}/submit`);

      // Line ids only exist after the insert, and the order lines must point at
      // them so the requirement closes out properly when the PO is raised.
      const full = await api.get<any>(`/planning/requirements/${created.id}`);
      setPicked((s) => {
        const next = { ...s };
        for (const rl of full.lines ?? []) {
          if (next[rl.product_id]) next[rl.product_id].requirementLineId = rl.id;
        }
        return next;
      });

      setRequirement({ ...created, ...full });
      setReqOutcome(outcome);
      // Stay put and show what the approval rules decided. Silently jumping to
      // the next step would hide the one fact this step exists to establish.
    } catch (e: any) { setError(e); } finally { setBusy(false); }
  };

  const placeOrder = async () => {
    setBusy(true); setError(null);
    try {
      const groups = bySupplier();
      const placed: PlacedOrder[] = [];

      /* Sequential, not parallel. Each order takes a document number from the
       * same series and writes the same requirement's converted quantities, so
       * firing them together is asking two transactions to fight over the same
       * rows for no gain — there are rarely more than three. */
      for (const g of groups) {
        const sup = supplierOf(g.supplierId);
        const created = await api.post<any>('/planning/purchase-orders', {
          // The requirement's own branch, not the live one from the topbar: if
          // the branch is switched mid-flow, the order must still belong to the
          // branch the need was raised for.
          branchId: requirement?.branch_id ?? branchId,
          requirementId: requirement?.id ?? null,
          supplierId: g.supplierId,
          sourceType: sup?.source_type,
          expectedDate,
          isUrgent: priority === 'URGENT',
          paymentTermsDays: sup?.payment_terms_days ?? 0,
          lines: g.lines.map((r) => ({
            productId: r.line.productId,
            requirementLineId: r.line.requirementLineId ?? null,
            qty: Number(r.qty), uom: r.line.uom, rate: Number(r.rate),
          })),
          charges: [],
        });
        const outcome = await api.post<any>(`/planning/purchase-orders/${created.id}/submit`);
        placed.push({ po: created, supplierId: g.supplierId, outcome, confirmed: null });
        // Show progress as it happens — a three-order split is three round
        // trips, and a frozen button for all of them looks like a hang.
        setOrders([...placed]);
      }
      // Deliberately NOT confirmed here. Approval is an internal decision; the
      // supplier still knows nothing. Confirming is the next step, and it is a
      // record of a conversation that has actually happened.
      setStep(4);
    } catch (e: any) { setError(e); } finally { setBusy(false); }
  };

  /** Places one order on its supplier's panel. Each goes on its own — one
   *  supplier is not the others, and a decline should not hold up the rest. */
  const sendToSupplier = async (o: PlacedOrder) => {
    setOrders((s2) => s2.map((x) => (x.po.id === o.po.id ? { ...x, confirming: true } : x)));
    setError(null);
    try {
      const c = await api.post<any>(`/planning/purchase-orders/${o.po.id}/confirm`, { expectedDate });
      setOrders((s2) => s2.map((x) =>
        (x.po.id === o.po.id ? { ...x, confirmed: c, confirming: false } : x)));
    } catch (e: any) {
      setError(e);
      setOrders((s2) => s2.map((x) => (x.po.id === o.po.id ? { ...x, confirming: false } : x)));
    }
  };

  /* ----------------------------------------------------------------- gate */
  if (!can('purchase.requirement.create') || !can('purchase.po.create')) {
    return (
      <Layout title="Guided order">
        <div className="banner warn">
          <span><Icon name="lock" size={16} /></span>
          <div>This flow places orders end to end, so it needs both the raising and
            the ordering permission. Ask your owner.</div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout
      title="Guided order"
      subtitle="From what to buy, to a confirmed order — without leaving this page"
    >
      <Steps steps={STEPS} current={step} />
      <ErrorBanner error={error} />

      {/* ============================================ 0 — WHAT TO BUY ==== */}
      {step === 0 ? (
        <>
          <div className="banner info mb">
            <span><Icon name="info" size={16} /></span>
            <div>
              Quantities are calculated from your stock, the last 28 days of sales, open
              orders and lead time. Change anything you disagree with — you will be asked why.
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Pick what to order</h2>
              <label className="check small">
                <input type="checkbox" checked={onlyNeeded}
                  onChange={(e) => setOnlyNeeded(e.target.checked)} />
                Only what needs buying
              </label>
            </div>
            <div className="card-body tight">
              {buy.loading ? <Loading /> : items.length === 0 ? (
                <Empty
                  icon="👍"
                  title={onlyNeeded ? 'Nothing needs buying right now' : 'No products found'}
                  hint={onlyNeeded
                    ? 'Every product has enough stock and cover for its lead time. You can still order ahead.'
                    : undefined}
                  action={onlyNeeded ? (
                    <button className="btn" onClick={() => setOnlyNeeded(false)}>
                      Show all products anyway
                    </button>
                  ) : undefined}
                />
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th style={{ width: 36 }}></th>
                        <th>Product</th>
                        <th>Why</th>
                        <th className="num">Stock</th>
                        <th className="num">Cover</th>
                        <th className="num">Suggested</th>
                        <th className="num" style={{ width: 260 }}>Order qty</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((i: any) => {
                        const sel = picked[i.productId];
                        const changed = sel && sel.qty !== sel.suggestedQty;
                        return (
                          <tr key={i.productId}>
                            <td>
                              <input type="checkbox" style={{ width: 18, height: 18 }}
                                checked={!!sel}
                                onChange={(e) => toggle(i, e.target.checked)} />
                            </td>
                            <td>
                              <b>{i.name}</b>
                              <div className="small muted">{i.sku}</div>
                            </td>
                            <td>
                              <div className="row wrap" style={{ gap: 4 }}>
                                {(i.triggers ?? []).map((t: string) => (
                                  <Chip key={t} tone={t === 'LOW_STOCK' ? 'danger' : 'warn'}>
                                    {t.replace(/_/g, ' ').toLowerCase()}
                                  </Chip>
                                ))}
                              </div>
                            </td>
                            <td className="num mono">{num(i.currentStock, 0)}</td>
                            <td className="num">
                              <Chip tone={i.daysOfCover < 1 ? 'danger' : i.daysOfCover < i.leadTimeDays ? 'warn' : 'neutral'}>
                                {i.daysOfCover >= 999 ? '—' : `${num(i.daysOfCover, 1)}d`}
                              </Chip>
                            </td>
                            <td className="num mono"><b>{num(i.suggestedQty, 0)}</b> <span className="small muted">{i.uom}</span></td>
                            <td className="num">
                              {sel ? (
                                <>
                                  <input className="inline num" type="number" style={{ width: 90 }}
                                    value={sel.qty}
                                    onChange={(e) => patch(i.productId, { qty: Number(e.target.value) })} />
                                  {!(sel.qty > 0) ? (
                                    <div className="small" style={{ color: 'var(--accent)' }}>
                                      Enter a quantity
                                    </div>
                                  ) : null}
                                  {changed ? (
                                    <div className="mt" style={{ textAlign: 'left', width: '100%' }}>
                                      <ReasonPicker
                                        bank={reasonBank}
                                        placeholder="Why the change?"
                                        value={sel.editReason}
                                        onChange={(v) => patch(i.productId, { editReason: v })}
                                      />
                                    </div>
                                  ) : null}
                                </>
                              ) : <span className="muted small">—</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <div className="btn-row mt">
            <span className="muted">
              {chosen.length} product(s) ready
              {needsQty.length ? ` · ${needsQty.length} still need a quantity` : ''}
            </span>
            <span className="spacer" />
            <button className="btn primary lg"
              disabled={!chosen.length || needsQty.length > 0}
              onClick={() => setStep(1)}>
              Next — confirm the need
            </button>
          </div>
        </>
      ) : null}

      {/* ============================================ 1 — CONFIRM NEED === */}
      {step === 1 ? (
        <>
          <div className="card mb">
            <div className="card-head"><h2>What you are asking for</h2></div>
            <div className="card-body">
              <div className="grid c2">
                <Field label="Needed by">
                  <input type="date" value={requiredDate} disabled={!!requirement}
                    onChange={(e) => setRequiredDate(e.target.value)} />
                </Field>
                <Field label="Priority" hint="Urgent orders skip straight to the top of the queue.">
                  <select value={priority} disabled={!!requirement}
                    onChange={(e) => setPriority(e.target.value as any)}>
                    <option value="NORMAL">Normal</option>
                    <option value="HIGH">High</option>
                    <option value="URGENT">Urgent</option>
                  </select>
                </Field>
              </div>

              <div className="table-wrap mt">
                <table className="data">
                  <thead>
                    <tr><th>Product</th><th className="num">Qty</th><th>Reason for change</th></tr>
                  </thead>
                  <tbody>
                    {chosen.map((l) => (
                      <tr key={l.productId}>
                        <td><b>{l.name}</b><div className="small muted">{l.sku}</div></td>
                        <td className="num mono">{num(l.qty, 0)} {l.uom}</td>
                        <td className="small muted">
                          {l.qty === l.suggestedQty ? 'As suggested' : l.editReason || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {reqOutcome ? (
            <div className={`banner ${reqOutcome.status === 'APPROVED' ? 'ok' : 'warn'} mb`}>
              <span>{reqOutcome.status === 'APPROVED' ? '✓' : '⏳'}</span>
              <div>
                <b>{requirement?.req_no} — {reqOutcome.status === 'APPROVED' ? 'approved' : 'waiting for approval'}</b>
                <div className="small">{reqOutcome.message}</div>
                {reqOutcome.status !== 'APPROVED' ? (
                  <div className="small mt">
                    This one is above your authority, so somebody else has to approve it before
                    it can become an order. It is on their queue now.
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="btn-row">
            <button className="btn" disabled={busy || !!requirement} onClick={() => setStep(0)}>Back</button>
            <span className="spacer" />
            {!requirement ? (
              <button className="btn primary lg" disabled={busy} onClick={createNeed}>
                {busy ? 'Raising…' : 'Next — raise and approve'}
              </button>
            ) : reqOutcome?.status === 'APPROVED' ? (
              <button className="btn primary lg" onClick={() => setStep(2)}>
                Next — choose supplier
              </button>
            ) : (
              <button className="btn" onClick={() => nav(`/requirements/${requirement.id}`)}>
                Open the requirement
              </button>
            )}
          </div>
        </>
      ) : null}

      {/* ============================================ 2 — SUPPLIER ====== */}
      {step === 2 ? (
        <>
          <div className="banner info mb">
            <span><Icon name="info" size={16} /></span>
            <div>
              You can split a product across more than one source — 30 kg from the mandi
              and 20 from a farmer. Each supplier gets its own purchase order, all of them
              against this one requirement.
            </div>
          </div>

          <div className="card mb">
            <div className="card-head"><h2>Delivery</h2></div>
            <div className="card-body">
              <div className="grid c2">
                <Field label="Expected delivery" hint="Applies to every order raised here.">
                  <input type="date" value={expectedDate}
                    onChange={(e) => setExpectedDate(e.target.value)} />
                </Field>
              </div>
            </div>
          </div>

          <div className="stack mb">
            {chosen.map((l) => {
              const rows = rowsFor(l);
              const short = shortOn(l);
              return (
                <div className="card" key={l.productId}>
                  <div className="card-head">
                    <h2>{l.name}</h2>
                    <span className="muted small">
                      needs {num(l.qty, 0)} {l.uom} · last rate {inr(l.lastRate)}
                    </span>
                    <Chip tone={Math.abs(short) < 0.001 ? 'ok' : 'warn'}>
                      {Math.abs(short) < 0.001 ? 'fully assigned'
                        : short > 0 ? `${num(short, 2)} ${l.uom} left`
                        : `${num(-short, 2)} ${l.uom} over`}
                    </Chip>
                  </div>
                  <div className="card-body tight">
                    {/* Everybody's asking price for this product, side by side.
                        Cheapest first; click one to take it. */}
                    {ratesFor(l.productId).length ? (
                      <div className="rate-strip">
                        <span className="small muted">They are asking</span>
                        {ratesFor(l.productId).map((q: any) => (
                          <button key={q.quote_id} className={`rate-chip ${q.is_stale ? 'stale' : ''}`}
                            title={q.is_stale ? `Rate expired ${date(q.valid_till)}` : q.note ?? ''}
                            onClick={() => patchRow(l, 0, {
                              supplierId: q.supplier_id, rate: Number(q.quoted_rate),
                            })}>
                            <b>{inr(q.quoted_rate)}</b>
                            <span>{q.supplier_name}</span>
                            {q.available_qty != null ? (
                              <em>{num(q.available_qty, 0)} {q.uom}</em>
                            ) : null}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    <div className="table-wrap">
                      <table className="data">
                        <thead>
                          <tr>
                            <th>Supplier</th>
                            <th className="num" style={{ width: 130 }}>Quantity</th>
                            <th className="num" style={{ width: 150 }}>Rate</th>
                            <th className="num" style={{ width: 120 }}>Value</th>
                            <th style={{ width: 130 }}></th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r, i) => (
                            <tr key={i}>
                              <td>
                                <select value={r.supplierId}
                                  onChange={(e) => {
                                    const sid = e.target.value;
                                    /* Picking a supplier brings their posted
                                       rate with it. Choosing a name and then
                                       typing a number that is already on file
                                       is two jobs where there is one. */
                                    const asked = ratesFor(l.productId)
                                      .find((x: any) => x.supplier_id === sid);
                                    patchRow(l, i, asked
                                      ? { supplierId: sid, rate: Number(asked.quoted_rate) }
                                      : { supplierId: sid });
                                  }}>
                                  <option value="">Choose a supplier…</option>
                                  {(suppliers.data ?? []).filter((s2) => s2.status !== 'BLOCKED').map((s2) => (
                                    <option key={s2.id} value={s2.id}>
                                      {s2.trade_name ?? s2.legal_name} — {s2.source_type}
                                      {s2.performance_score ? ` (score ${Math.round(s2.performance_score)})` : ''}
                                    </option>
                                  ))}
                                </select>
                                {/* A supplier met this morning. Without this the
                                    only way to buy from him is to leave the
                                    order half made and go to a master screen. */}
                                {can('master.supplier.manage') ? (
                                  <button className="btn sm ghost" title="Add a supplier"
                                    onClick={() => setAddingSupplier({ line: l, index: i })}>+ New</button>
                                ) : null}
                              </td>
                              <td className="num">
                                <input className="inline num" type="number" style={{ width: 100 }}
                                  value={r.qty || ''}
                                  onChange={(e) => patchRow(l, i, { qty: Number(e.target.value) })} />
                              </td>
                              <td className="num">
                                <input className="inline num" type="number" style={{ width: 110 }}
                                  value={r.rate || ''}
                                  onChange={(e) => patchRow(l, i, { rate: Number(e.target.value) })}
                                  onBlur={(e) => checkRate(l, Number(e.target.value))} />
                                {l.rateNote ? (
                                  <div className="small" style={{ color: 'var(--accent)' }}>{l.rateNote}</div>
                                ) : null}
                              </td>
                              <td className="num mono">{inr(Number(r.qty) * Number(r.rate))}</td>
                              <td>
                                <div className="btn-row">
                                  {canCompare ? (
                                    <button className="btn sm ghost" title="Compare sources"
                                      onClick={() => setCompareFor({ line: l, index: i })}><Icon name="scale" size={15} /></button>
                                  ) : null}
                                  {rows.length > 1 ? (
                                    <button className="btn sm ghost" title="Remove this source"
                                      onClick={() => removeRow(l, i)}><Icon name="alert" size={15} /></button>
                                  ) : null}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="btn-row" style={{ padding: '10px 16px' }}>
                      <button className="btn sm" onClick={() => addRow(l)}>+ Split across another supplier</button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="card mb">
            <div className="card-head"><h2>Orders this will raise</h2></div>
            <div className="card-body tight">
              {bySupplier().length === 0 ? (
                <Empty icon="🤝" title="No supplier chosen yet" />
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr><th>Supplier</th><th className="num">Products</th><th className="num">Order value</th></tr>
                    </thead>
                    <tbody>
                      {bySupplier().map((o) => (
                        <tr key={o.supplierId}>
                          <td><b>{supplierName(o.supplierId)}</b></td>
                          <td className="num">{o.lines.length}</td>
                          <td className="num mono">{inr(orderTotal(o))}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td className="right"><b>{bySupplier().length} order(s)</b></td>
                        <td></td>
                        <td className="num mono"><b>{inr(subtotal)}</b></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          </div>

          {addingSupplier ? (
            <SupplierModal supplier={{}} onClose={() => setAddingSupplier(null)}
              onDone={() => { setAddingSupplier(null); suppliers.reload(); toast('Supplier added', 'ok'); }} />
          ) : null}

          {compareFor ? (
            <CompareModal
              line={{ ...compareFor.line, qty: Number(rowsFor(compareFor.line)[compareFor.index]?.qty) || compareFor.line.qty }}
              suppliers={suppliers.data ?? []}
              onClose={() => setCompareFor(null)}
              onPick={(sid, rate) => {
                // Applies to the row you opened it from, so comparing for the
                // 20 kg half does not overwrite the supplier on the 30 kg half.
                patchRow(compareFor.line, compareFor.index, { supplierId: sid, rate });
                setCompareFor(null);
              }}
            />
          ) : null}

          {overLimit ? (
            <div className="banner warn mb">
              <span><Icon name="alert" size={16} /></span>
              <div>
                At least one of these orders is above your own PO limit of
                {' '}{inr(me?.limits.maxPoValue, 0)}. It will go for approval instead of
                being confirmed straight away.
              </div>
            </div>
          ) : null}

          <div className="btn-row">
            <button className="btn" onClick={() => setStep(1)}>Back</button>
            <span className="spacer" />
            {allocProblem ? <span className="muted small">{allocProblem}</span> : null}
            <button className="btn primary lg" disabled={!!allocProblem}
              onClick={() => setStep(3)}>
              Next — review
            </button>
          </div>
        </>
      ) : null}

      {/* ============================================ 3 — REVIEW ======== */}
      {step === 3 ? (
        <>
          <div className="card mb">
            <div className="card-head">
              <h2>Check this before it goes out</h2>
              <span className="muted small">
                {bySupplier().length} order(s) · from requirement {requirement?.req_no ?? '—'}
              </span>
            </div>
            <div className="card-body tight">
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Supplier</th><th>Product</th>
                      <th className="num">Quantity</th><th className="num">Rate</th>
                      <th className="num">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bySupplier().flatMap((o) => o.lines.map((r, i) => (
                      <tr key={`${o.supplierId}-${r.line.productId}-${i}`}>
                        <td>{i === 0 ? <b>{supplierName(o.supplierId)}</b> : <span className="muted small">&#8627;</span>}</td>
                        <td>{r.line.name}</td>
                        <td className="num mono">{num(r.qty, 0)} {r.line.uom}</td>
                        <td className="num mono">{inr(r.rate)}</td>
                        <td className="num mono">{inr(Number(r.qty) * Number(r.rate))}</td>
                      </tr>
                    )))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={4} className="right"><b>Total across every order</b></td>
                      <td className="num mono"><b>{inr(subtotal)}</b></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          </div>

          <div className="banner info mb">
            <span>&#8505;</span>
            <div>
              This raises {bySupplier().length === 1 ? 'the order' : `${bySupplier().length} orders`} and
              runs {bySupplier().length === 1 ? 'it' : 'each'} through the approval rules. It does
              {' '}<b>not</b> place anything with a supplier — that is the next step.
            </div>
          </div>

          <div className="btn-row">
            <button className="btn" disabled={busy} onClick={() => setStep(2)}>Back</button>
            <span className="spacer" />
            <button className="btn primary lg" disabled={busy} onClick={placeOrder}>
              {busy ? `Raising… (${orders.length}/${bySupplier().length})`
                : `Raise ${bySupplier().length} order(s) — ${inr(subtotal)}`}
            </button>
          </div>
        </>
      ) : null}

      {/* ================================== 4 — SEND TO SUPPLIERS ====== */}
      {step === 4 ? (
        <>
          {orders.length > 0 && orders.every((o) => o.confirmed) ? (
            <div className="banner ok mb">
              <span>&#10003;</span>
              <div>
                <b>All {orders.length} order(s) sent.</b>
                <div className="small">
                  Each supplier accepts or declines on their own panel. You will be told
                  when they answer, and the gate is expecting them on {expectedDate}.
                </div>
              </div>
            </div>
          ) : (
            <div className="banner info mb">
              <span>&#8505;</span>
              <div>
                <b>
                  {orders.filter((o) => !o.confirmed).length} of {orders.length} order(s) not
                  sent yet.
                </b>
                <div className="small">
                  Sending puts the order on the supplier's panel. They confirm it there —
                  nobody has to ring round and agree it first.
                </div>
              </div>
            </div>
          )}

          <div className="stack mb">
            {orders.map((o) => {
              const sup = supplierOf(o.supplierId);
              const approved = o.outcome?.status === 'APPROVED';
              return (
                <div className="card" key={o.po.id}>
                  <div className="card-head">
                    <h2>{o.po.po_no}</h2>
                    <span className="muted small">{supplierName(o.supplierId)}</span>
                    <Chip value={o.confirmed ? 'CONFIRMED' : o.outcome?.status} />
                  </div>
                  <div className="card-body">
                    <dl className="kv">
                      <dt>Value</dt><dd><b>{inr(o.po.grand_total)}</b></dd>
                      <dt>Phone</dt>
                      <dd>
                        {/* Kept so you can ring them if you want to, not
                            because the flow needs a call. */}
                        {sup?.phone
                          ? <a href={`tel:${sup.phone}`}>{sup.phone}</a>
                          : <span className="muted">No number on file</span>}
                      </dd>
                      <dt>Expected</dt><dd>{expectedDate}</dd>
                    </dl>
                    {!approved ? (
                      <div className="small muted mt">{o.outcome?.message}</div>
                    ) : null}
                    <div className="btn-row mt">
                      {o.confirmed ? (
                        <span className="small" style={{ color: 'var(--ok)' }}>
                          &#10003; Sent — waiting for {supplierName(o.supplierId)} to accept
                        </span>
                      ) : approved ? (
                        /* Was "<supplier> has agreed", which claimed an
                           agreement nobody had obtained. This only places the
                           order on their panel; agreeing is their act. */
                        <button className="btn primary" disabled={!!o.confirming}
                          onClick={() => sendToSupplier(o)}>
                          {o.confirming ? 'Sending…' : `Send to ${supplierName(o.supplierId)}`}
                        </button>
                      ) : (
                        <span className="small muted">
                          Waiting for approval — it will appear on the team's queue once approved.
                        </span>
                      )}
                      <button className="btn sm ghost" onClick={() => nav(`/purchase-orders/${o.po.id}`)}>
                        Open &rarr;
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="btn-row">
            <button className="btn" onClick={() => {
              // A fresh run, not a reload — the buy list has moved on now that
              // these orders count as stock on the way.
              setStep(0); setPicked({}); setAllocs({}); setRequirement(null);
              setReqOutcome(null); setOrders([]); buy.reload();
            }}>
              Order something else
            </button>
          </div>
        </>
      ) : null}

      {/* ============================ ORDERS LEFT PART-WAY THROUGH ===== */}
      {step === 0 && (unsent.data ?? []).length ? (
        <div className="card mt">
          <div className="card-head">
            <h2>Left part-way through</h2>
            <span className="small muted">
              raised on an earlier run and never sent to the supplier
            </span>
          </div>
          <div className="card-body tight">
            <DataTable
              rows={unsent.data ?? []}
              onRowClick={(o: any) => nav(`/purchase-orders/${o.id}`)}
              cols={[
                { key: 'n', head: 'Order', render: (o: any) => (
                  <div><b className="mono">{o.po_no}</b>
                    <div className="small muted">{date(o.order_date)}</div></div>) },
                { key: 's', head: 'Supplier', render: (o: any) => o.supplier_name },
                { key: 'l', head: 'Items', num: true, render: (o: any) => o.line_count },
                { key: 'v', head: 'Value', num: true, render: (o: any) => inr(o.grand_total, 0) },
                { key: 'w', head: 'Waiting', render: (o: any) => (
                  <span className="small muted">{ago(o.created_at ?? o.order_date)}</span>) },
                { key: 'a', head: '', width: 150, render: () => (
                  <span className="btn sm primary">Pick it up &rarr;</span>) },
              ]}
            />
          </div>
          <div className="card-body">
            <p className="small muted" style={{ margin: 0 }}>
              These are approved and waiting to be sent. Opening one takes you to the
              order, where <b>Send to supplier</b> finishes the job — you do not have to
              start this flow again.
            </p>
          </div>
        </div>
      ) : null}

    </Layout>
  );
}
