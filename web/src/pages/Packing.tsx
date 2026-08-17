import React, { useState } from 'react';
import { api, useAuth, inr, num, date } from '../lib/api';
import {
  Chip, DataTable, Empty, ErrorBanner, Field, Kpi, Layout, Loading, Modal, useApi, useToast,
} from '../components/ui';
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
  const toast = useToast();
  const { warehouseId, can } = useAuth();
  const wh = warehouseId ?? '';

  const packable = useApi<any[]>(`/inventory/packable?warehouseId=${wh}`, [wh]);
  const runs = useApi<any[]>(`/inventory/pack-runs?warehouseId=${wh}`, [wh]);
  const packs = useApi<any[]>(`/inventory/packs?status=IN_STOCK&warehouseId=${wh}`, [wh]);

  const [packing, setPacking] = useState<any>(null);
  const [printing, setPrinting] = useState<any[] | null>(null);
  const [selling, setSelling] = useState<any[] | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});

  const chosen = inStockChosen();
  function inStockChosen() { return (packs.data ?? []).filter((p: any) => picked[p.id]); }

  const canPack = can('inventory.stock.issue');
  const inStock = packs.data ?? [];
  const stockValue = inStock.reduce((a: number, p: any) => a + Number(p.price), 0);

  const reloadAll = () => { packable.reload(); runs.reload(); packs.reload(); };

  return (
    <Layout
      title="Packing &amp; labels"
      subtitle="Turn a batch into packs with their own size, price and barcode"
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
      <div className="section-head"><h2>Pack a batch</h2><span className="rule" /></div>
      <div className="card mb">
        <div className="card-body tight">
          <DataTable
            loading={packable.loading}
            rows={packable.data ?? []}
            rowTone={(b: any) => (b.days_left != null && b.days_left <= 2 ? 'crit'
              : b.days_left != null && b.days_left <= 5 ? 'warn' : undefined)}
            cols={[
              { key: 'p', head: 'Product', render: (b: any) => (
                <div><b>{b.product_name}</b>
                  <div className="small muted mono">{b.batch_no}{b.grade ? ` · ${b.grade}` : ''}</div>
                </div>
              ) },
              { key: 'a', head: 'On hand', num: true, render: (b: any) => (
                <div>{num(b.available_qty, 0)} <span className="small muted">{b.base_uom}</span></div>
              ) },
              { key: 'k', head: 'Already packed', num: true, render: (b: any) =>
                Number(b.packed_qty) > 0
                  ? <span>{num(b.packed_qty, 0)} <span className="small muted">{b.base_uom}</span></span>
                  : <span className="muted">—</span> },
              { key: 'u', head: 'Still loose', num: true, render: (b: any) => {
                const free = Number(b.available_qty) - Number(b.packed_qty);
                return <b>{num(free, 0)} <span className="small muted">{b.base_uom}</span></b>;
              } },
              { key: 'e', head: 'Shelf life', render: (b: any) =>
                b.days_left == null ? <span className="muted">—</span>
                  : <Chip tone={b.days_left <= 2 ? 'danger' : b.days_left <= 5 ? 'warn' : 'neutral'}>
                      {b.days_left <= 0 ? 'past date' : `${b.days_left}d left`}
                    </Chip> },
              { key: 'c', head: 'Cost', num: true, render: (b: any) => inr(b.landed_rate) },
              { key: 'a2', head: '', width: 90, render: (b: any) => canPack
                ? <button className="btn sm primary" onClick={() => setPacking(b)}>Pack</button>
                : null },
            ]}
            empty={<Empty icon="📦" title="Nothing in stock to pack"
              hint="Post a goods receipt and the batch shows up here." />}
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
                  <button className="btn sm primary" onClick={() => setSelling(chosen)}>
                    Sell {chosen.length} pack(s)
                  </button>
                  <button className="btn sm" onClick={() => setPrinting(chosen)}>🖨 Labels</button>
                </>
              ) : inStock.length ? (
                <button className="btn sm" onClick={() => setPrinting(inStock)}>
                  🖨 Print all labels
                </button>
              ) : null}
            </div>
            <div className="card-body tight">
              <DataTable
                loading={packs.loading}
                rows={inStock}
                cols={[
                  { key: 'sel', head: '', width: 34, render: (p: any) => (
                    <input type="checkbox" style={{ width: 17, height: 17 }}
                      checked={!!picked[p.id]}
                      onChange={(e) => setPicked((s2) => ({ ...s2, [p.id]: e.target.checked }))} />
                  ) },
                  { key: 'c', head: 'Barcode', render: (p: any) => (
                    <div>
                      <b className="mono">{p.code}</b>
                      <div className="small muted">{p.group_label ?? `pack ${p.pack_no}`}</div>
                    </div>
                  ) },
                  { key: 'p', head: 'Product', render: (p: any) => (
                    <div>{p.product_name}<div className="small muted mono">{p.batch_no}</div></div>
                  ) },
                  { key: 'q', head: 'Contains', num: true, render: (p: any) =>
                    <span>{num(p.qty, 2)} <span className="small muted">{p.uom}</span></span> },
                  { key: 'r', head: 'Price', num: true, render: (p: any) => <b>{inr(p.price)}</b> },
                  { key: 'x', head: '', width: 74, render: (p: any) => (
                    <button className="btn sm ghost" onClick={() => setPrinting([p])}>Label</button>
                  ) },
                ]}
                empty={<Empty icon="🏷️" title="No packs made yet"
                  hint="Pack a batch above and every pack gets its own barcode." />}
              />
            </div>
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>Recent runs</h2></div>
            <div className="card-body tight">
              <DataTable
                rows={runs.data ?? []}
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
                empty={<Empty icon="🧾" title="No packing runs yet" />}
              />
            </div>
          </div>
        </div>
      </div>

      {packing ? (
        <PackModal batch={packing} onClose={() => setPacking(null)}
          onDone={(made) => { setPacking(null); reloadAll(); setPrinting(made); }} />
      ) : null}

      {printing ? (
        <LabelSheet packs={printing} onClose={() => { setPrinting(null); packs.reload(); }} />
      ) : null}

      {selling ? (
        <SellPacksModal packs={selling} onClose={() => setSelling(null)}
          onDone={() => { setSelling(null); setPicked({}); reloadAll(); }} />
      ) : null}
    </Layout>
  );
}

/* ---------------------------------------------------------------- pack --- */

function PackModal({ batch, onClose, onDone }: {
  batch: any; onClose: () => void; onDone: (packs: any[]) => void;
}) {
  const toast = useToast();
  const [groups, setGroups] = useState<Group[]>([emptyGroup()]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  const uom = batch.base_uom;
  const free = Number(batch.available_qty) - Number(batch.packed_qty);
  const cost = Number(batch.landed_rate ?? 0);

  const set = (i: number, p: Partial<Group>) =>
    setGroups((s) => s.map((g, j) => (j === i ? { ...g, ...p } : g)));

  const totalQty = groups.reduce((a, g) => a + (Number(g.count) || 0) * (Number(g.qtyPerPack) || 0), 0);
  const totalPacks = groups.reduce((a, g) => a + (Number(g.count) || 0), 0);
  const revenue = groups.reduce((a, g) => a + (Number(g.count) || 0) * (Number(g.price) || 0), 0);
  const costOut = totalQty * cost;
  const over = totalQty > free + 0.001;

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.post<any>('/inventory/pack-runs', {
        batchId: batch.batch_id,
        warehouseId: batch.warehouse_id,
        note: note || undefined,
        groups: groups.map((g) => ({
          label: g.label || undefined,
          count: Number(g.count),
          qtyPerPack: Number(g.qtyPerPack),
          price: Number(g.price),
        })),
      });
      toast(`${r.run_no} — ${r.packs.length} pack(s) made`, 'ok');
      onDone(r.packs.map((p: any) => ({
        ...p, product_name: r.productName, batch_no: r.batchNo,
      })));
    } catch (e: any) { setError(e); } finally { setBusy(false); }
  };

  return (
    <Modal
      title={`Pack ${batch.product_name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || over || !totalPacks
            || groups.some((g) => !(Number(g.price) > 0) || !(Number(g.qtyPerPack) > 0))}
            onClick={submit}>
            {busy ? 'Packing…' : `Make ${totalPacks} pack(s)`}
          </button>
        </>
      }
    >
      <ErrorBanner error={error} />
      <dl className="kv mb">
        <dt>Batch</dt><dd className="mono">{batch.batch_no}</dd>
        <dt>Still loose</dt><dd>{num(free, 2)} {uom}</dd>
        <dt>It cost you</dt><dd>{inr(cost)} per {uom}</dd>
        <dt>Shelf life</dt>
        <dd>{batch.days_left == null ? 'not recorded'
          : batch.days_left <= 0 ? 'past its date' : `${batch.days_left} day(s) left`}</dd>
      </dl>

      <p className="small muted mb">
        Each group is “this many packs, this size, at this price”. Add a second group to
        price part of the batch differently.
      </p>

      <div className="table-wrap mb">
        <table className="data">
          <thead>
            <tr>
              <th>Group</th>
              <th className="num" style={{ width: 90 }}>Packs</th>
              <th className="num" style={{ width: 110 }}>Each holds</th>
              <th className="num" style={{ width: 120 }}>Price per pack</th>
              <th className="num">Uses</th>
              <th style={{ width: 44 }}></th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g, i) => {
              const uses = (Number(g.count) || 0) * (Number(g.qtyPerPack) || 0);
              const perUnit = Number(g.qtyPerPack) > 0 ? (Number(g.price) || 0) / Number(g.qtyPerPack) : 0;
              return (
                <tr key={i}>
                  <td>
                    <input value={g.label} placeholder={`e.g. ${g.qtyPerPack || '5'} ${uom} crate`}
                      onChange={(e) => set(i, { label: e.target.value })} />
                  </td>
                  <td className="num">
                    <input className="inline num" type="number" style={{ width: 70 }} value={g.count}
                      onChange={(e) => set(i, { count: e.target.value })} />
                  </td>
                  <td className="num">
                    <input className="inline num" type="number" step="0.01" style={{ width: 84 }}
                      value={g.qtyPerPack} onChange={(e) => set(i, { qtyPerPack: e.target.value })} />
                    <div className="small muted">{uom}</div>
                  </td>
                  <td className="num">
                    <input className="inline num" type="number" step="0.01" style={{ width: 96 }}
                      value={g.price} placeholder="0" onChange={(e) => set(i, { price: e.target.value })} />
                    {perUnit > 0 ? (
                      <div className="small" style={{ color: perUnit < cost ? 'var(--danger)' : 'var(--muted)' }}>
                        {inr(perUnit)}/{uom}{perUnit < cost ? ' — under cost' : ''}
                      </div>
                    ) : null}
                  </td>
                  <td className="num mono">{num(uses, 2)} {uom}</td>
                  <td>
                    {groups.length > 1 ? (
                      <button className="btn sm ghost"
                        onClick={() => setGroups((s) => s.filter((_, j) => j !== i))}>✕</button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="btn-row mb">
        <button className="btn sm" onClick={() => setGroups((s) => [...s, emptyGroup()])}>
          + Another group at a different price
        </button>
      </div>

      <Field label="Note" hint="Optional — anything the next person should know.">
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>

      <div className={`banner ${over ? 'danger' : revenue > costOut ? 'ok' : 'warn'}`}>
        <span>{over ? '⚠' : revenue > costOut ? '✓' : 'ℹ'}</span>
        <div>
          {over ? (
            <b>That is {num(totalQty, 2)} {uom} of packs from {num(free, 2)} {uom} still loose.</b>
          ) : (
            <>
              <b>
                {totalPacks} pack(s) using {num(totalQty, 2)} {uom} —
                {' '}{inr(revenue, 0)} if they all sell
              </b>
              <div className="small">
                {inr(costOut, 0)} of stock goes into them
                {revenue > 0 ? ` · ${num(((revenue - costOut) / revenue) * 100, 1)}% margin` : ''}
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Where a scanned label sends someone. Taken from the running origin so a
 *  label printed from the deployed site carries the deployed address. */
function scanHost() {
  return typeof window === 'undefined' ? '' : window.location.host;
}

/* --------------------------------------------------------------- print --- */

/**
 * The label sheet. Printing is a browser print of a plain grid — no PDF
 * service, no CDN, and the barcode is drawn as SVG so it stays sharp at any
 * printer resolution.
 */
function LabelSheet({ packs, onClose }: { packs: any[]; onClose: () => void }) {
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
      footer={
        <>
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={print}>🖨 Print</button>
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
              <b>{p.product_name}</b>
              <span>{p.group_label ?? ''}</span>
            </div>
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

/* ---------------------------------------------------------------- sell --- */

/**
 * Selling packs is one call. The server posts the stock issue and marks the
 * packs sold inside a single transaction, so there is no state where the stock
 * has gone but the pack still looks sellable.
 */
function SellPacksModal({ packs, onClose, onDone }: {
  packs: any[]; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [party, setParty] = useState('');
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  const revenue = packs.reduce((a, p) => a + Number(p.price), 0);
  const qty = packs.reduce((a, p) => a + Number(p.qty), 0);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.post<any>('/inventory/packs/sell', {
        packIds: packs.map((p) => p.id),
        partyName: party || undefined,
        referenceNo: ref || undefined,
      });
      toast(`${r.issue_no} — ${r.packsSold} pack(s) sold for ${inr(r.totalValue, 0)}`, 'ok');
      onDone();
    } catch (e: any) { setError(e); } finally { setBusy(false); }
  };

  return (
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
          <input value={party} onChange={(e) => setParty(e.target.value)} placeholder="Buyer name" />
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
  );
}
