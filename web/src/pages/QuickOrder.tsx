import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, useAuth, inr, num, addDays } from '../lib/api';
import {
  Chip, Empty, ErrorBanner, Field, Layout, Loading, ReasonPicker, Steps,
  useApi, useReasonBank, useToast,
} from '../components/ui';
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

const STEPS = ['What to buy', 'Confirm need', 'Supplier & rates', 'Raise order', 'Confirm with supplier'];

export function QuickOrderPage() {
  const nav = useNavigate();
  const toast = useToast();
  const { branchId, me, can } = useAuth();

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
  const [supplierId, setSupplierId] = useState('');
  const [compareFor, setCompareFor] = useState<Pick | null>(null);
  // The compare endpoint is permission-gated server-side; hide the button
  // rather than offer a click that can only 403.
  const canCompare = can('purchase.quote.compare');
  const supplier = (suppliers.data ?? []).find((s) => s.id === supplierId);
  const [expectedDate, setExpectedDate] = useState(addDays(1));

  /* --- step 3 ------------------------------------------------------------ */
  const [po, setPo] = useState<any>(null);
  const [poOutcome, setPoOutcome] = useState<any>(null);
  const [confirmed, setConfirmed] = useState<any>(null);

  const subtotal = chosen.reduce((a, l) => a + l.qty * l.rate, 0);
  const overLimit = me?.limits.maxPoValue != null && subtotal > me.limits.maxPoValue;

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
      const created = await api.post<any>('/planning/purchase-orders', {
        // The requirement's own branch, not the live one from the topbar: if
        // the branch is switched mid-flow, the order must still belong to the
        // branch the need was raised for.
        branchId: requirement?.branch_id ?? branchId,
        requirementId: requirement?.id ?? null,
        supplierId,
        sourceType: supplier?.source_type,
        expectedDate,
        isUrgent: priority === 'URGENT',
        paymentTermsDays: supplier?.payment_terms_days ?? 0,
        lines: chosen.map((l) => ({
          productId: l.productId,
          requirementLineId: l.requirementLineId ?? null,
          qty: l.qty, uom: l.uom, rate: l.rate,
        })),
        charges: [],
      });
      setPo(created);
      const outcome = await api.post<any>(`/planning/purchase-orders/${created.id}/submit`);
      setPoOutcome(outcome);
      // Deliberately NOT confirmed here. Approval is an internal decision; the
      // supplier still knows nothing. Confirming is the next step, and it is a
      // record of a conversation that has actually happened.
      setStep(4);
    } catch (e: any) { setError(e); } finally { setBusy(false); }
  };

  /** Only after somebody has actually spoken to the supplier. */
  const confirmWithSupplier = async () => {
    setBusy(true); setError(null);
    try {
      const c = await api.post<any>(`/planning/purchase-orders/${po.id}/confirm`, { expectedDate });
      setConfirmed(c);
    } catch (e: any) { setError(e); } finally { setBusy(false); }
  };

  /* ----------------------------------------------------------------- gate */
  if (!can('purchase.requirement.create') || !can('purchase.po.create')) {
    return (
      <Layout title="Guided order">
        <div className="banner warn">
          <span>🔒</span>
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
            <span>💡</span>
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
          <div className="card mb">
            <div className="card-head"><h2>Who are you buying from?</h2></div>
            <div className="card-body">
              <div className="grid c2">
                <Field label="Supplier" hint="Blocked suppliers cannot be chosen.">
                  <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                    <option value="">Choose a supplier…</option>
                    {(suppliers.data ?? []).filter((s) => s.status !== 'BLOCKED').map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.trade_name ?? s.legal_name} — {s.source_type}
                        {s.performance_score ? ` (score ${Math.round(s.performance_score)})` : ''}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Expected delivery">
                  <input type="date" value={expectedDate}
                    onChange={(e) => setExpectedDate(e.target.value)} />
                </Field>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h2>Rates</h2></div>
            <div className="card-body tight">
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Product</th><th className="num">Qty</th>
                      <th className="num">Last rate</th>
                      <th className="num" style={{ width: 150 }}>Your rate</th>
                      <th className="num">Line total</th>
                      {canCompare ? <th style={{ width: 96 }}></th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {chosen.map((l) => (
                      <tr key={l.productId}>
                        <td><b>{l.name}</b><div className="small muted">{l.sku}</div></td>
                        <td className="num mono">{num(l.qty, 0)} {l.uom}</td>
                        <td className="num mono">{inr(l.lastRate)}</td>
                        <td className="num">
                          <input className="inline num" type="number" style={{ width: 110 }}
                            value={l.rate || ''}
                            onChange={(e) => patch(l.productId, { rate: Number(e.target.value) })}
                            onBlur={(e) => checkRate(l, Number(e.target.value))} />
                          {l.rateNote ? <div className="small" style={{ color: 'var(--accent)' }}>{l.rateNote}</div> : null}
                        </td>
                        <td className="num mono">{inr(l.qty * l.rate)}</td>
                        {canCompare ? (
                          <td>
                            <button className="btn sm ghost" onClick={() => setCompareFor(l)}>
                              ⚖ Compare
                            </button>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={4} className="right"><b>Order total</b></td>
                      <td className="num mono"><b>{inr(subtotal)}</b></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          </div>

          {compareFor ? (
            <CompareModal
              line={compareFor}
              suppliers={suppliers.data ?? []}
              onClose={() => setCompareFor(null)}
              onPick={(sid, rate) => {
                // One order goes to one supplier, so picking a source here sets
                // it for the whole order, not just this line.
                setSupplierId(sid);
                patch(compareFor.productId, { rate });
                setCompareFor(null);
              }}
            />
          ) : null}

          {overLimit ? (
            <div className="banner warn mt">
              <span>⚠</span>
              <div>
                This is above your own PO limit of {inr(me?.limits.maxPoValue, 0)}. You can still
                place it — it will go for approval instead of being confirmed straight away.
              </div>
            </div>
          ) : null}

          <div className="btn-row mt">
            <button className="btn" onClick={() => setStep(1)}>Back</button>
            <span className="spacer" />
            <button className="btn primary lg"
              disabled={!supplierId || chosen.some((l) => !l.rate)}
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
            <div className="card-head"><h2>Check this before it goes out</h2></div>
            <div className="card-body">
              <dl className="kv">
                <dt>Supplier</dt><dd>{supplier?.trade_name ?? supplier?.legal_name}</dd>
                <dt>Source type</dt><dd>{supplier?.source_type}</dd>
                <dt>Expected delivery</dt><dd>{expectedDate}</dd>
                <dt>Payment terms</dt><dd>{supplier?.payment_terms_days ?? 0} days</dd>
                <dt>From requirement</dt><dd>{requirement?.req_no ?? '—'}</dd>
                <dt>Products</dt><dd>{chosen.length}</dd>
                <dt>Order total</dt><dd><b>{inr(subtotal)}</b></dd>
              </dl>
            </div>
          </div>

          <div className="banner info mb">
            <span>ℹ</span>
            <div>
              This raises the order and runs it through the approval rules. It does <b>not</b>
              tell the supplier anything — that is the next step, and it is a phone call.
            </div>
          </div>

          <div className="btn-row">
            <button className="btn" disabled={busy} onClick={() => setStep(2)}>Back</button>
            <span className="spacer" />
            <button className="btn primary lg" disabled={busy} onClick={placeOrder}>
              {busy ? 'Raising…' : `Raise the order — ${inr(subtotal)}`}
            </button>
          </div>
        </>
      ) : null}

      {/* ================================= 4 — CONFIRM WITH SUPPLIER ==== */}
      {step === 4 ? (
        <>
          {confirmed ? (
            <div className="banner ok mb">
              <span>✓</span>
              <div>
                <b>{po?.po_no} — confirmed with {supplier?.trade_name ?? supplier?.legal_name}</b>
                <div className="small">The gate has been told to expect this on {expectedDate}.</div>
              </div>
            </div>
          ) : poOutcome?.status === 'APPROVED' ? (
            <div className="banner warn mb">
              <span>📞</span>
              <div>
                <b>{po?.po_no} is approved — but nobody has told the supplier yet.</b>
                <div className="small">
                  This panel is internal. {supplier?.trade_name ?? supplier?.legal_name} knows
                  nothing about this order until someone speaks to them. Confirm below only once
                  they have agreed to supply it.
                </div>
              </div>
            </div>
          ) : (
            <div className="banner warn mb">
              <span>⏳</span>
              <div>
                <b>{po?.po_no} — waiting for approval</b>
                <div className="small">{poOutcome?.message}</div>
                <div className="small mt">
                  Once it is approved it will appear on the team's queue as a call to make.
                </div>
              </div>
            </div>
          )}

          <div className="card mb">
            <div className="card-body">
              <dl className="kv">
                <dt>Requirement</dt><dd>{requirement?.req_no ?? '—'}</dd>
                <dt>Purchase order</dt><dd>{po?.po_no}</dd>
                <dt>Supplier</dt><dd>{supplier?.trade_name ?? supplier?.legal_name}</dd>
                <dt>Phone</dt>
                <dd>
                  {supplier?.phone
                    ? <a href={`tel:${supplier.phone}`}>{supplier.phone}</a>
                    : <span className="muted">No number on file</span>}
                </dd>
                <dt>Total</dt><dd><b>{inr(po?.grand_total ?? subtotal)}</b></dd>
                <dt>Expected</dt><dd>{expectedDate}</dd>
                <dt>Status</dt><dd><Chip value={confirmed ? 'CONFIRMED' : poOutcome?.status} /></dd>
              </dl>
            </div>
          </div>

          {!confirmed && poOutcome?.status === 'APPROVED' ? (
            <div className="btn-row mb">
              <button className="btn primary lg" disabled={busy} onClick={confirmWithSupplier}>
                {busy ? 'Confirming…' : '✓ Supplier has agreed — confirm the order'}
              </button>
              <span className="muted small">
                Not spoken to them yet? Leave it — it is saved, and sits on the team's
                queue as “Confirm {po?.po_no}” until someone does.
              </span>
            </div>
          ) : null}

          <div className="btn-row">
            <button className="btn primary" onClick={() => nav(`/purchase-orders/${po.id}`)}>
              Open the order
            </button>
            <button className="btn" onClick={() => {
              // A fresh run, not a reload — the buy list has moved on now that
              // this order counts as stock on the way.
              setStep(0); setPicked({}); setRequirement(null); setReqOutcome(null);
              setPo(null); setPoOutcome(null); setConfirmed(null); setSupplierId('');
              buy.reload();
            }}>
              Order something else
            </button>
          </div>
        </>
      ) : null}
    </Layout>
  );
}
