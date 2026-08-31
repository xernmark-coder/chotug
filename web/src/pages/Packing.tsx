import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, useAuth, inr, num, date } from '../lib/api';
import {
  Chip, DataTable, Empty, ErrorBanner, Field, Kpi, Layout, Loading, Modal, useApi, useToast,
  FilterBar, FilterTotals, useFilters,
} from '../components/ui';
import { Icon } from '../components/icons';
import { AddCustomerModal } from './Centres';
import { Barcode } from '../components/barcode';

/* ===========================================================================
 * PACKING
 *
 * Loose stock becomes packs of a chosen size, each with its own price and its
 * own barcode. Packing does not move stock — the kilos stay on the batch until
 * a pack is sold, and that sale goes through the same stock issue every other
 * outward movement uses.
 *
 * A run can produce several groups at once: ten 5 kg crates at ₹300 and twenty
 * 2 kg bags at ₹140, off the same lot. That is how the trade actually prices.
 * ======================================================================== */

type Group = { label: string; count: string; qtyPerPack: string; price: string };

const emptyGroup = (): Group => ({ label: '', count: '10', qtyPerPack: '5', price: '' });

export function PackingPage() {
  const nav = useNavigate();
  const toast = useToast();
  const { warehouseId, can } = useAuth();
  const wh = warehouseId ?? '';

  const packable = useApi<any[]>(`/inventory/packable?warehouseId=${wh}`, [wh]);
  const runs = useApi<any[]>(`/inventory/pack-runs?warehouseId=${wh}`, [wh]);
  const packs = useApi<any[]>(`/inventory/packs?status=IN_STOCK&warehouseId=${wh}`, [wh]);

  const [printing, setPrinting] = useState<any[] | null>(null);
  const [removing, setRemoving] = useState<any>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});

  const chosen = inStockChosen();
  function inStockChosen() { return (packs.data ?? []).filter((p: any) => picked[p.id]); }

  /* Grading at the bench is the quality check, so the permission that opens
     it is the grading one — not the one that lets you move stock. */
  const canPack = can('inventory.pack.grade') || can('inventory.stock.issue');
  const inStock = packs.data ?? [];
  const stockValue = inStock.reduce((a: number, p: any) => a + Number(p.price), 0);

  const fPackable = useFilters<any>(packable.data, {
    search: (b: any) => [b.product_name, b.batch_no, b.grade].filter(Boolean).join(' '),
    facets: [
      { key: 'p', label: 'product', of: (b: any) => b.product_name },
      { key: 'g', label: 'grade', of: (b: any) => b.grade },
      { key: 'e', label: 'shelf life', all: 'Any shelf life', of: (b: any) =>
        b.days_left == null ? null
          : b.days_left <= 2 ? 'pack today'
          : b.days_left <= 5 ? 'this week' : 'plenty of time' },
    ],
    totals: [
      { label: 'On hand', of: (b: any) => Number(b.available_qty) || 0 },
      { label: 'Still loose', of: (b: any) =>
        (Number(b.available_qty) || 0) - (Number(b.packed_qty) || 0) },
    ],
  });
  const fStock = useFilters<any>(inStock, {
    search: (p2: any) => [p2.code, p2.product_name, p2.batch_no, p2.bin_code, p2.group_label]
      .filter(Boolean).join(' '),
    facets: [
      { key: 'p', label: 'product', of: (p2: any) => p2.product_name },
      { key: 'g', label: 'grade', of: (p2: any) => p2.grade },
      { key: 'b', label: 'shelf', of: (p2: any) => p2.bin_code ?? 'on the bench' },
    ],
    totals: [
      { label: 'Packs', of: () => 1 },
      { label: 'Worth', of: (p2: any) => Number(p2.price) || 0, money: true },
    ],
  });
  const fRuns = useFilters<any>(runs.data, {
    date: (r: any) => r.packed_on,
    search: (r: any) => [r.run_no, r.product_name].filter(Boolean).join(' '),
    facets: [
      { key: 'p', label: 'product', of: (r: any) => r.product_name },
    ],
    totals: [
      { label: 'Packs made', of: (r: any) => Number(r.pack_count) || 0 },
      { label: 'Sold', of: (r: any) => Number(r.sold) || 0 },
    ],
  });

  const reloadAll = () => { packable.reload(); runs.reload(); packs.reload(); };

  return (
    <Layout
      title="Quality &amp; packing"
      subtitle="Grade each box as you pack it, then put it straight on a shelf"
    >
      <ErrorBanner error={packable.error} />

      <div className="grid c4 mb">
        <Kpi label="Packs ready to sell" value={num(inStock.length, 0)}
          foot="labelled and priced" />
        <Kpi label="Value if all sell" value={inr(stockValue, 0)}
          foot="at the prices on the labels" />
        <Kpi label="Packing runs" value={num((runs.data ?? []).length, 0)}
          foot="most recent first" />
        <Kpi label="Batches you can pack" value={num((packable.data ?? []).length, 0)}
          foot="with stock still unpacked" />
      </div>

      {/* ------------------------------------------------ what to pack --- */}
      <div className="section-head"><h2>Grade and pack a batch</h2><span className="rule" /></div>
      <div className="card mb">
        <div className="card-body tight">
          <FilterBar f={fPackable} placeholder="Search product, batch, grade" />
          <FilterTotals f={fPackable} noun="batch" />
          <DataTable
            loading={packable.loading}
            rows={fPackable.rows}
            rowTone={(b: any) => (b.days_left != null && b.days_left <= 2 ? 'crit'
              : b.days_left != null && b.days_left <= 5 ? 'warn' : undefined)}
            cols={[
              { key: 'p', head: 'Product', sort: (b: any) => b.product_name, render: (b: any) => (
                <div><b>{b.product_name}</b>
                  <div className="small muted mono">{b.batch_no}{b.grade ? ` · ${b.grade}` : ''}</div>
                </div>
              ) },
              { key: 'a', head: 'On hand', num: true,
                sort: (b: any) => Number(b.available_qty) || 0, desc: true, render: (b: any) => (
                <div>{num(b.available_qty, 0)} <span className="small muted">{b.base_uom}</span></div>
              ) },
              { key: 'k', head: 'Already packed', num: true,
                sort: (b: any) => Number(b.packed_qty) || 0, desc: true, render: (b: any) =>
                Number(b.packed_qty) > 0
                  ? <span>{num(b.packed_qty, 0)} <span className="small muted">{b.base_uom}</span></span>
                  : <span className="muted">—</span> },
              { key: 'u', head: 'Still loose', num: true, desc: true,
                sort: (b: any) => (Number(b.available_qty) || 0) - (Number(b.packed_qty) || 0),
                render: (b: any) => {
                const free = Number(b.available_qty) - Number(b.packed_qty);
                return <b>{num(free, 0)} <span className="small muted">{b.base_uom}</span></b>;
              } },
              /* Shelf life sorts ascending by default and is the table's
                 opening order: the box closest to turning is the one that has
                 to be graded and packed first, and no other ordering of this
                 list is worth more than that. */
              { key: 'e', head: 'Shelf life', sort: (b: any) => b.days_left, render: (b: any) =>
                b.days_left == null ? <span className="muted">—</span>
                  : <Chip tone={b.days_left <= 2 ? 'danger' : b.days_left <= 5 ? 'warn' : 'neutral'}>
                      {b.days_left <= 0 ? 'past date' : `${b.days_left}d left`}
                    </Chip> },
              { key: 'c', head: 'Cost', num: true, desc: true,
                sort: (b: any) => Number(b.landed_rate) || 0,
                render: (b: any) => inr(b.landed_rate) },
              { key: 'a2', head: '', width: 90, render: (b: any) => canPack
                ? (
                  <div className="btn-row">
                    {/* One way in. There used to be two — "Bulk" for a run of
                        identical crates and the bench for one box at a time —
                        and having both meant choosing between them before you
                        knew which you needed. The bench now does both: a run of
                        the same size in one action, single boxes for the odd
                        ones, and the bulk path stamped the lot's grade on every
                        box, which was the wrong grade by definition. */}
                    <button className="btn sm primary"
                      onClick={() => nav(`/pack-bench/${b.batch_id}`)}>Grade &amp; pack</button>
                  </div>
                )
                : null },
            ]}
            empty={<Empty icon="📦"
              title={fPackable.active > 0 ? 'No batch matches those filters' : 'Nothing in stock to pack'}
              hint={fPackable.active > 0 ? 'Clear a filter to widen the search.'
                : 'Post a goods receipt and the batch shows up here.'} />}
            defaultSort="e"
          />
        </div>
      </div>

      {/* ------------------------------------------------------- packs --- */}
      <div className="grid sidebar-right">
        <div className="stack">
          <div className="card">
            <div className="card-head">
              <h2>Packs ready to sell</h2>
              {chosen.length ? (
                <>
                  <Chip tone="primary">{chosen.length} selected</Chip>
                  <button className="btn sm" onClick={() => setPrinting(chosen)}><Icon name="inbox" size={15} /> Labels</button>
                  {/* Selling used to live here as well as on Sell & Profit. Two
                      screens that both take money is one more than anybody can
                      keep straight — this page makes and labels packs, and
                      selling happens in the one place that reports on it. */}
                  <button className="btn sm primary" onClick={() => nav('/sales')}>
                    Sell them →
                  </button>
                </>
              ) : fStock.rows.length ? (
                <button className="btn sm" onClick={() => setPrinting(fStock.rows)}>
                  <Icon name="inbox" size={15} />{' '}
                  {fStock.active > 0 ? `Print these ${fStock.rows.length} labels` : 'Print all labels'}
                </button>
              ) : null}
            </div>
            <div className="card-body tight">
              <FilterBar f={fStock} placeholder="Search barcode, product, shelf" />
              <FilterTotals f={fStock} noun="pack" />
              <DataTable
                loading={packs.loading}
                rows={fStock.rows}
                cols={[
                  { key: 'sel', head: '', width: 34, render: (p: any) => (
                    <input type="checkbox" style={{ width: 17, height: 17 }}
                      checked={!!picked[p.id]}
                      onChange={(e) => setPicked((s2) => ({ ...s2, [p.id]: e.target.checked }))} />
                  ) },
                  { key: 'c', head: 'Barcode', sort: (p: any) => p.code, render: (p: any) => (
                    <div>
                      <b className="mono">{p.code}</b>
                      <div className="small muted">{p.group_label ?? `pack ${p.pack_no}`}</div>
                    </div>
                  ) },
                  { key: 'p', head: 'Product', sort: (p: any) => p.product_name, render: (p: any) => (
                    <div>{p.product_name}<div className="small muted mono">{p.batch_no}</div></div>
                  ) },
                  /* Grade and shelf together: the two things somebody sent to
                     fetch a box actually needs. */
                  /* Sorting by grade is the request: A boxes are picked for one
                     customer and C for another, and reading them out of a list
                     ordered by barcode is how the wrong box goes in the van. */
                  { key: 'g', head: 'Grade', sort: (p: any) => p.grade, render: (p: any) => (
                    p.grade ? <Chip tone={p.grade === 'A' ? 'ok' : p.grade === 'B' ? 'primary'
                      : p.grade === 'C' ? 'warn' : 'danger'}>{p.grade}</Chip>
                      : <span className="muted small">—</span>
                  ) },
                  { key: 'b', head: 'Where', sort: (p: any) => p.bin_code, render: (p: any) => (
                    p.bin_code
                      ? <div><b>{p.bin_code}</b><div className="small muted">rack {p.rack_code}</div></div>
                      : <span className="chip warn">on the bench</span>
                  ) },
                  { key: 'q', head: 'Contains', num: true, desc: true,
                    sort: (p: any) => Number(p.qty) || 0, render: (p: any) =>
                    <span>{num(p.qty, 2)} <span className="small muted">{p.uom}</span></span> },
                  { key: 'r', head: 'Price', num: true, desc: true,
                    sort: (p: any) => Number(p.price) || 0,
                    render: (p: any) => <b>{inr(p.price)}</b> },
                  { key: 'x', head: '', width: 74, render: (p: any) => (
                    <div className="btn-row">
                      <button className="btn sm ghost" onClick={() => setPrinting([p])}>Label</button>
                      {can('inventory.pack.grade') ? (
                        <button className="btn sm danger" onClick={() => setRemoving(p)}>Remove</button>
                      ) : null}
                    </div>
                  ) },
                ]}
                empty={<Empty icon="🏷️"
                  title={fStock.active > 0 ? 'No pack matches those filters' : 'No packs made yet'}
                  hint={fStock.active > 0 ? 'Clear a filter to widen the search.'
                    : 'Pack a batch above and every pack gets its own barcode.'} />}
              />
            </div>
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>Recent runs</h2></div>
            <div className="card-body tight">
              <FilterBar f={fRuns} placeholder="Search run or product" />
              <FilterTotals f={fRuns} noun="run" />
              <DataTable
                rows={fRuns.rows}
                cols={[
                  { key: 'r', head: 'Run', render: (r: any) => (
                    <div>
                      <b className="mono small">{r.run_no}</b>
                      <div className="small muted">{r.product_name} · {date(r.packed_on)}</div>
                    </div>
                  ) },
                  { key: 'n', head: 'Packs', num: true, render: (r: any) => (
                    <div>{r.pack_count}
                      <div className="small muted">{r.sold} sold</div>
                    </div>
                  ) },
                ]}
                empty={<Empty icon="🧾" title={fRuns.active > 0
                  ? 'No run matches those filters' : 'No packing runs yet'} />}
              />
            </div>
          </div>
        </div>
      </div>

      {printing ? (
        <LabelSheet packs={printing} onClose={() => { setPrinting(null); packs.reload(); }} />
      ) : null}
      {removing ? (
        <RemovePackModal pack={removing} onClose={() => setRemoving(null)}
          onDone={() => { setRemoving(null); reloadAll(); }} />
      ) : null}
    </Layout>
  );
}

/* ===========================================================================
 * The bulk pack modal used to live here: "make me 40 crates of 5 kg", raised
 * from this list. It is gone.
 *
 * Two problems with it. It sat beside "Grade & pack" as a second way to do the
 * same job, so the floor had to choose between them before knowing which they
 * needed. And it stamped the LOT's grade on every crate — the grade given to
 * the whole lorry — which is the one grade a packed box should never carry,
 * since the entire reason for grading at the bench is that the person holding
 * the box can see what the lorry inspection could not.
 *
 * The bench now does both: a run of the same size in one action, and single
 * boxes for the odd ones. See MakeBoxesModal in PackBench.tsx.
 * ======================================================================== */
function scanHost() {
  return typeof window === 'undefined' ? '' : window.location.host;
}

/* --------------------------------------------------------------- print --- */

/**
 * The label sheet. Printing is a browser print of a plain grid — no PDF
 * service, no CDN, and the barcode is drawn as SVG so it stays sharp at any
 * printer resolution.
 */
/** Exported: the bench prints the same sheet after a run of boxes. */
export function LabelSheet({ packs, onClose }: { packs: any[]; onClose: () => void }) {
  const toast = useToast();

  const print = async () => {
    try {
      await api.post('/inventory/packs/print', { packIds: packs.map((p) => p.id) });
    } catch { /* recording the print must not stop the print */ }
    window.print();
  };

  return (
    <Modal
      title={`${packs.length} label(s)`}
      onClose={onClose}
      wide
      className="print-label-modal"
      footer={
        <>
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={print}><Icon name="inbox" size={15} /> Print</button>
        </>
      }
    >
      <p className="small muted mb no-print">
        Stick one on each pack. A shopkeeper scanning it sees what is inside, where it came
        from and when it was packed.
      </p>
      <div className="label-sheet">
        {packs.map((p) => (
          <div className="pack-label" key={p.id ?? p.code}>
            <div className="pl-head">
              <b>{p.product_name ?? p.productName ?? 'Product'}</b>
              <span>{p.group_label ?? ''}</span>
            </div>
            <div className="pl-product">Product: {p.product_name ?? p.productName ?? '—'}</div>
            <div className="pl-meta">
              <span>{num(p.qty, 2)} {p.uom}</span>
              <b>{inr(p.price)}</b>
            </div>
            <Barcode value={p.code} height={42} module={2} />
            <div className="pl-foot">
              <span className="mono">{p.batch_no ?? ''}</span>
              <span>{p.grade ?? ''}</span>
            </div>
            <div className="pl-scan">{scanHost()}/p</div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export function RemovePackModal({ pack, onClose, onDone }: {
  pack: any; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  return (
    <Modal title={`Remove pack ${pack.code}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn danger" disabled={busy || reason.trim().length < 4}
        onClick={async () => {
          setBusy(true); setError(null);
          try {
            const r = await api.post<any>(`/inventory/packs/${pack.id}/void`, { reason: reason.trim() });
            toast(r.message ?? 'Pack removed', 'ok');
            onDone();
          } catch (e: any) { setError(e); } finally { setBusy(false); }
        }}>
        {busy ? 'Removing…' : 'Remove pack'}
      </button>
    </>}>
      <ErrorBanner error={error} />
      <p className="small muted mb">
        This removes the label from available stock and records the reason. The quantity becomes
        available to pack again; sold packs cannot be removed.
      </p>
      <dl className="kv mb">
        <dt>Product</dt><dd>{pack.product_name ?? pack.productName}</dd>
        <dt>Pack</dt><dd className="mono">{pack.code}</dd>
        <dt>Size</dt><dd>{num(pack.qty, 2)} {pack.uom}</dd>
      </dl>
      <Field label="Why is this pack being removed?">
        <input value={reason} autoFocus onChange={(e) => setReason(e.target.value)}
          placeholder="Wrong size / damaged box / repacking" />
      </Field>
    </Modal>
  );
}

/* ---------------------------------------------------------------- sell --- */

/**
 * Selling packs is one call. The server posts the stock issue and marks the
 * packs sold inside a single transaction, so there is no state where the stock
 * has gone but the pack still looks sellable.
 */
export function SellPacksModal({ packs, onClose, onDone }: {
  packs: any[]; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [party, setParty] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [addingCustomer, setAddingCustomer] = useState(false);
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  const revenue = packs.reduce((a, p) => a + Number(p.price), 0);
  const qty = packs.reduce((a, p) => a + Number(p.qty), 0);
  const warehouseId = packs[0]?.warehouse_id ?? '';
  const customers = useApi<any[]>(
    `/centres/customers/list?warehouseId=${warehouseId}`, [warehouseId]);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.post<any>('/inventory/packs/sell', {
        packIds: packs.map((p) => p.id),
        partyName: party || undefined,
        customerId: customerId || undefined,
        referenceNo: ref || undefined,
      });
      toast(`${r.issue_no} — ${r.packsSold} pack(s) sold for ${inr(r.totalValue, 0)}`, 'ok');
      onDone();
    } catch (e: any) { setError(e); } finally { setBusy(false); }
  };

  return (
    <>
    {addingCustomer ? <AddCustomerModal
      centres={[]}
      defaultCentre={warehouseId}
      lockCentre
      onClose={() => setAddingCustomer(false)}
      onDone={(m, customer) => {
        setAddingCustomer(false);
        customers.reload();
        if (customer?.id) { setCustomerId(customer.id); setParty(customer.name); }
        toast(m, 'ok');
      }} /> : null}
    <Modal
      title={`Sell ${packs.length} pack(s)`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={submit}>
            {busy ? 'Recording…' : `Record sale — ${inr(revenue, 0)}`}
          </button>
        </>
      }
    >
      <ErrorBanner error={error} />
      <dl className="kv mb">
        <dt>Packs</dt><dd>{packs.length}</dd>
        <dt>Total in them</dt><dd>{num(qty, 2)} {packs[0]?.uom}</dd>
        <dt>They sell for</dt><dd><b>{inr(revenue)}</b></dd>
      </dl>

      <div className="table-wrap mb" style={{ maxHeight: 190, overflowY: 'auto' }}>
        <table className="data">
          <tbody>
            {packs.map((p) => (
              <tr key={p.id}>
                <td className="mono small">{p.code}</td>
                <td className="small">{p.group_label ?? p.product_name}</td>
                <td className="num mono">{num(p.qty, 2)} {p.uom}</td>
                <td className="num mono">{inr(p.price)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid c2">
        <Field label="Sold to" hint="A name makes the sale traceable later.">
          <div className="row" style={{ gap: 6 }}>
            <select style={{ flex: 1 }} value={customerId}
              onChange={(e) => {
                setCustomerId(e.target.value);
                const customer = (customers.data ?? []).find((x: any) => x.id === e.target.value);
                setParty(customer?.name ?? '');
              }}>
              <option value="">Walk-in — no name</option>
              {(customers.data ?? []).map((customer: any) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}{customer.phone ? ` · ${customer.phone}` : ''}
                </option>
              ))}
            </select>
            <button className="btn sm" onClick={() => setAddingCustomer(true)}>+ New</button>
          </div>
        </Field>
        <Field label="Their reference" hint="Challan or order number, if any.">
          <input value={ref} onChange={(e) => setRef(e.target.value)} />
        </Field>
      </div>

      <div className="banner info">
        <span>&#8505;</span>
        <div className="small">
          This takes the stock off the batch these packs were made from and records the
          sale — the same movement any other sale makes.
        </div>
      </div>
    </Modal>
    </>
  );
}
