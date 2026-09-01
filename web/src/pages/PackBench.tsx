import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, useAuth, inr, num, ago } from '../lib/api';
import { Chip, Empty, ErrorBanner, Kpi, Layout, Loading, Modal, useApi, useToast } from '../components/ui';
import { Icon } from '../components/icons';
import { LabelSheet, RemovePackModal } from './Packing';

/* ===========================================================================
 * THE PACKING BENCH — QUALITY AND PACKING ARE ONE JOB
 *
 * The client described one job, not two: "they take all product and then while
 * packing them they just give each box a quality and then store it to
 * warehouse."
 *
 * Lot QC — one grade for everything that came off one lorry — happens at the
 * vehicle and decides what we accept. But the person at the bench has each box
 * in their hands and can see that this one is A and the next is B. Grading the
 * lot and packing separately throws that judgement away, and puts a grade on
 * the label that the label is supposed to be about.
 *
 * So: pick a grade, put in the weight, one tap. The box gets its own label at
 * its own grade, and either goes straight onto a scanned shelf or waits on the
 * bench for the trolley run.
 * ======================================================================== */

/* What this box has to fetch, and therefore what the label should say.
 *
 *   what it cost us + overheads + freight in + freight to the shop
 *   ───────────────────────────────────────────────────────────────  × (1 + margin)
 *                          1 − wastage
 *
 * The database does that sum per unit in v_batch_pricing (the margin coming
 * from the product, or the company default where the product has none). All
 * that is left here is the size of the box, because that is chosen on this
 * screen and nowhere else. Rounded UP to the rupee — a suggestion that lands a
 * few paise under the floor it was computed from would be its own bug report.
 */
function suggestPrice(minSellPerUnit: number, qtyPerPack: number): string {
  const floor = Number(minSellPerUnit) || 0;
  const per = Number(qtyPerPack) || 0;
  if (floor <= 0 || per <= 0) return '';
  return String(Math.ceil(floor * per));
}

const GRADES = [
  { key: 'A', label: 'A', hint: 'best', tone: 'ok' },
  { key: 'B', label: 'B', hint: 'good', tone: 'primary' },
  { key: 'C', label: 'C', hint: 'usable', tone: 'warn' },
  { key: 'REJECT', label: 'Reject', hint: 'not for sale', tone: 'danger' },
];

export function PackBenchPage() {
  const { batchId } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<any>(`/inventory/pack-bench/${batchId}`, [batchId]);

  const [grade, setGrade] = useState('A');
  const [making, setMaking] = useState(false);
  const [printing, setPrinting] = useState<any[] | null>(null);
  const [removing, setRemoving] = useState<any>(null);
  const [qty, setQty] = useState('');
  const [price, setPrice] = useState('');
  const [binCode, setBinCode] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [postError, setPostError] = useState<any>(null);
  const [storing, setStoring] = useState(false);

  /* Price is per grade in practice, so remembering the last one for this grade
     saves typing it on every box. A price somebody set by hand outranks the
     worked-out one — they had the fruit in front of them. */
  const [priceByGrade, setPriceByGrade] = useState<Record<string, string>>({});
  const [pricedByHand, setPricedByHand] = useState(false);

  /* The label price, worked out from what this batch cost and the margin set
     on the product. It follows the weight as it is keyed in, because a box
     price without a box size is not a number anybody can check. */
  const suggested = suggestPrice(Number(data?.min_sell_price) || 0, Number(qty) || 0);
  useEffect(() => {
    const own = priceByGrade[grade];
    if (own != null) { setPrice(own); setPricedByHand(true); return; }
    setPricedByHand(false);
  }, [grade]); // eslint-disable-line
  useEffect(() => {
    if (!pricedByHand) setPrice(suggested);
  }, [suggested, pricedByHand]);

  const addBox = async () => {
    if (!Number(qty)) return;
    setBusy(true); setPostError(null);
    try {
      const r = await api.post<any>(`/inventory/pack-bench/${batchId}/box`, {
        warehouseId: data.warehouse_id,
        qty: Number(qty),
        weightKg: data.base_uom === 'KG' ? Number(qty) : undefined,
        grade,
        price: Number(price) || 0,
        note: note.trim() || undefined,
        binCode: binCode.trim() || undefined,
      });
      toast(r.message, 'ok');
      /* Remember only a price somebody chose. Storing the worked-out one would
         freeze it, and the next box of a different size would carry the last
         box's price. */
      if (pricedByHand) setPriceByGrade((s) => ({ ...s, [grade]: price }));
      setNote('');
      reload();
      setPrinting([r]);
    } catch (e: any) { setPostError(e); } finally { setBusy(false); }
  };

  if (loading) return <Layout title="Packing bench"><Loading /></Layout>;
  if (error) return <Layout title="Packing bench"><ErrorBanner error={error} /></Layout>;

  const onBench = (data.recent ?? []).filter((p: any) => !p.bin_id);
  const canGrade = can('inventory.pack.grade');

  return (
    <Layout
      title={`Packing ${data.product_name}`}
      subtitle={`${data.batch_no} · ${num(data.unpacked, 1)} ${data.base_uom} still unpacked`}
      touch
      actions={<button className="btn sm" onClick={() => nav('/packing')}>All packing →</button>}
    >
      <ErrorBanner error={postError} />

      <div className="grid c4 mb">
        <Kpi label="Still to pack" value={`${num(data.unpacked, 1)} ${data.base_uom}`}
          tone={Number(data.unpacked) <= 0 ? 'good' : undefined}
          foot={`${num(data.packed_qty, 1)} already packed`} />
        <Kpi label="Boxes on the bench" value={onBench.length}
          tone={onBench.length > 0 ? 'warn' : 'good'}
          foot={onBench.length ? 'not on a shelf yet' : 'everything is put away'} />
        <Kpi label="Graded so far"
          value={(data.byGrade ?? []).reduce((a: number, g: any) => a + g.packs, 0)}
          foot={(data.byGrade ?? []).map((g: any) => `${g.packs}×${g.grade}`).join(' · ') || '—'} />
        <Kpi label="Quality off the vehicle" value={data.lot_grade ?? '—'}
          foot="what the lot was graded" />
      </div>

      {/* Labels outliving their stock. Sending a batch to a shop takes the
          produce and leaves the boxes' labels behind, and until they are voided
          every count on this screen is wrong. */}
      {Number(data.overPacked) > 0 ? (
        <div className="banner danger mb">
          <span><Icon name="alert" size={16} /></span>
          <div>
            <b>There are labels here for {num(data.overPacked, 1)} {data.base_uom} more than
            this batch still holds.</b>{' '}
            The produce has gone — sold, sent to a shop or written off — and its boxes were
            left behind. Void the labels whose boxes are no longer here; nothing can be
            packed from this batch until the two agree.
          </div>
        </div>
      ) : null}

      <div className="grid sidebar-right">
        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>1 · What quality is this box?</h2></div>
            <div className="card-body">
              <div className="tile-grid">
                {GRADES.map((g) => {
                  const seen = (data.byGrade ?? []).find((x: any) => x.grade === g.key);
                  return (
                    <button key={g.key}
                      className={`product-tile ${grade === g.key ? 'on' : ''}`}
                      onClick={() => setGrade(g.key)}>
                      <span className="grade-mark">{g.label}</span>
                      <span className="small">{g.hint}</span>
                      <span className="small muted">
                        {seen ? `${seen.packs} boxes · ${num(seen.qty, 1)} ${data.base_uom}` : 'none yet'}
                      </span>
                    </button>
                  );
                })}
              </div>
              {data.lot_grade && grade !== data.lot_grade ? (
                <div className="banner warn mt">
                  <span><Icon name="info" size={16} /></span>
                  <div className="small">
                    The lot was graded <b>{data.lot_grade}</b> off the vehicle and you are
                    calling this box <b>{grade}</b>. That is allowed — you are holding it — and
                    the difference is recorded against your name.
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>2 · How much is in it?</h2>
              <span className="small muted">grade {grade}</span>
            </div>
            <div className="card-body">
              <div className="weigh-readout">{qty || '0'}<span>{data.base_uom}</span></div>
              <div className="keypad">
                {['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0', '⌫'].map((k) => (
                  <button key={k} className="key" onClick={() => {
                    if (k === '⌫') return setQty((w) => w.slice(0, -1));
                    if (k === '.' && qty.includes('.')) return;
                    setQty((w) => (w + k).slice(0, 8));
                  }}>{k}</button>
                ))}
              </div>
              <div className="grid c2 mt">
                <div>
                  <label className="lbl">Price on the label (₹)</label>
                  <input type="number" value={price}
                    onChange={(e) => { setPrice(e.target.value); setPricedByHand(true); }} />
                  {/* Worked out rather than remembered: cost, overheads, both
                      freight legs and the margin on this product. Editable,
                      because the person holding the box can see it. */}
                  {suggested ? (
                    <div className="small muted mt">
                      {pricedByHand && price !== suggested ? (
                        <>Worked out at {inr(Number(suggested))} ·{' '}
                          <button className="btn sm ghost" type="button"
                            onClick={() => {
                              setPrice(suggested); setPricedByHand(false);
                              setPriceByGrade((s2) => { const n2 = { ...s2 }; delete n2[grade]; return n2; });
                            }}>use it</button></>
                      ) : (
                        <>cost + {num(data.margin_pct, 0)}% margin on {qty || 0} {data.base_uom}</>
                      )}
                    </div>
                  ) : null}
                </div>
                <div>
                  <label className="lbl">Shelf, if it goes now</label>
                  <input value={binCode} onChange={(e) => setBinCode(e.target.value.toUpperCase())}
                    placeholder="scan · R-A1-2" />
                </div>
              </div>
              <div className="mt">
                <label className="lbl">Anything worth noting</label>
                <input value={note} onChange={(e) => setNote(e.target.value)}
                  placeholder="A few soft ones near the top" />
              </div>
              <button className="btn primary block lg mt"
                disabled={busy || !canGrade || !Number(qty)}
                onClick={addBox}>
                {busy ? 'Labelling…' : `Pack this box as ${grade}`}
              </button>
              {/* One at a time is right for odd boxes and wrong for the common
                  case: two crates of 50 kg become twenty 5 kg boxes, and that
                  was twenty identical taps. */}
              {canGrade ? (
                <button className="btn block mt" onClick={() => setMaking(true)}>
                  …or make a run of the same size
                </button>
              ) : null}
              {!canGrade ? (
                <p className="small muted mt">You can watch this, but not grade boxes.</p>
              ) : null}
            </div>
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head">
              <h2>On the bench</h2>
              {onBench.length && can('inventory.pack.store') ? (
                <button className="btn sm primary" onClick={() => setStoring(true)}>
                  Put on a shelf
                </button>
              ) : null}
            </div>
            <div className="card-body tight">
              <table className="mini">
                <tbody>
                  {onBench.map((p: any) => (
                    <tr key={p.id}>
                      <td>
                        <b className="mono">{p.code}</b> <Chip tone={toneFor(p.grade)}>{p.grade}</Chip>
                        <div className="small muted">
                          {num(p.qty, 1)} {p.uom} · {ago(p.created_at)} · {p.graded_by_name}
                          {p.qc_note ? ` · ${p.qc_note}` : ''}
                        </div>
                      </td>
                      <td className="num">
                        <div>{inr(p.price, 0)}</div>
                        <button className="btn sm ghost" onClick={() => setPrinting([p])}>Label</button>
                        {canGrade ? (
                          <button className="btn sm danger" onClick={() => setRemoving(p)}>Remove</button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                  {!onBench.length ? (
                    <tr><td className="muted small">Nothing waiting — every box is on a shelf.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h2>Already on shelves</h2></div>
            <div className="card-body tight">
              <table className="mini">
                <tbody>
                  {(data.recent ?? []).filter((p: any) => p.bin_id).slice(0, 10).map((p: any) => (
                    <tr key={p.id}>
                      <td>
                        <b className="mono">{p.code}</b> <Chip tone={toneFor(p.grade)}>{p.grade}</Chip>
                        <div className="small muted">{num(p.qty, 1)} {p.uom}</div>
                      </td>
                      <td className="num">
                        <Chip tone="primary">{p.bin_code}</Chip>
                        <button className="btn sm ghost" onClick={() => setPrinting([p])}>Label</button>
                        {canGrade ? (
                          <button className="btn sm danger" onClick={() => setRemoving(p)}>Remove</button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                  {!(data.recent ?? []).some((p: any) => p.bin_id) ? (
                    <tr><td className="muted small">Nothing stored from this batch yet.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {printing ? (
        <LabelSheet packs={printing} onClose={() => { setPrinting(null); reload(); }} />
      ) : null}

      {removing ? (
        <RemovePackModal pack={removing} onClose={() => setRemoving(null)}
          onDone={() => { setRemoving(null); reload(); }} />
      ) : null}

      {making ? (
        <MakeBoxesModal bench={data} grade={grade} onClose={() => setMaking(false)}
          onDone={(m, made) => {
            setMaking(false); reload(); toast(m, 'ok');
            if (made?.length) setPrinting(made);
          }} />
      ) : null}

      {storing ? (
        <StoreModal packs={onBench} bins={data.bins ?? []}
          onClose={() => setStoring(false)}
          onDone={(m) => { setStoring(false); reload(); toast(m, 'ok'); }} />
      ) : null}
    </Layout>
  );
}

function toneFor(grade: string) {
  return grade === 'A' ? 'ok' : grade === 'B' ? 'primary'
    : grade === 'C' ? 'warn' : 'danger';
}

function StoreModal({ packs, bins, onClose, onDone }: {
  packs: any[]; bins: any[]; onClose: () => void; onDone: (m: string) => void;
}) {
  const [binCode, setBinCode] = useState('');
  const [picked, setPicked] = useState<Record<string, boolean>>(
    Object.fromEntries(packs.map((p) => [p.id, true])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  const chosen = packs.filter((p) => picked[p.id]);

  /* Grouped the way the warehouse is: rack, then the shelves on it. */
  const racks = React.useMemo(() => {
    const m = new Map<string, any[]>();
    for (const b of bins) {
      const k = b.rack_code ?? 'Unracked';
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(b);
    }
    return [...m.entries()];
  }, [bins]);

  return (
    <Modal
      title="Put these on a shelf"
      wide
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !binCode.trim() || !chosen.length}
          onClick={async () => {
            setBusy(true); setError(null);
            try {
              const r = await api.post<any>('/inventory/packs/store', {
                binCode: binCode.trim(), packIds: chosen.map((p) => p.id),
              });
              onDone(r.message);
            } catch (e: any) { setError(e); } finally { setBusy(false); }
          }}>
          Store {chosen.length} box{chosen.length === 1 ? '' : 'es'}
        </button>
      </>}
    >
      <ErrorBanner error={error} />
      <label className="lbl">Scan the shelf label</label>
      <input value={binCode} autoFocus onChange={(e) => setBinCode(e.target.value.toUpperCase())}
        placeholder="R-A1-2" />

      {/* Or point at it. A scanner is quicker when the label is in front of
          you, and useless when you are deciding WHERE to put something —
          twelve codes in a row told nobody which rack was nearly full or
          which one is by the door. This is the same rack-and-shelf layout as
          the warehouse map, small enough to sit in a dialog. */}
      <div className="row mt" style={{ justifyContent: 'space-between' }}>
        <label className="lbl" style={{ margin: 0 }}>…or pick it off the map</label>
        {bins.length > 0 ? (
          <span className="small muted">{bins.length} shelves · filled ones are shaded</span>
        ) : null}
      </div>
      <div className="store-map">
        {racks.map(([rack, shelves]) => (
          <div className="loc-rack" key={rack}>
            <div className="loc-rack-name"><b className="small">{rack}</b></div>
            <div className="shelf-row">
              {shelves.map((b: any) => (
                <button key={b.id}
                  className={`shelf ${Number(b.packs) ? 'full' : ''} ${binCode === b.code ? 'on' : ''}`}
                  title={b.capacity_kg
                    ? `${num(b.current_fill_kg ?? 0, 0)} of ${num(b.capacity_kg, 0)} kg`
                    : 'no stated capacity'}
                  onClick={() => setBinCode(b.code)}>
                  <b>{b.code}</b>
                  <span className="small">
                    {Number(b.packs) ? `${b.packs} box${Number(b.packs) === 1 ? '' : 'es'}` : 'empty'}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
        {!racks.length ? (
          <p className="small muted">
            No shelves set up yet. Build the racks on the warehouse map, or type a code above.
          </p>
        ) : null}
      </div>

      <label className="lbl mt">Which boxes</label>
      <table className="mini">
        <tbody>
          {packs.map((p) => (
            <tr key={p.id}>
              <td style={{ width: 30 }}>
                <input type="checkbox" checked={!!picked[p.id]}
                  onChange={(e) => setPicked((s) => ({ ...s, [p.id]: e.target.checked }))} />
              </td>
              <td><b className="mono">{p.code}</b> <Chip tone={toneFor(p.grade)}>{p.grade}</Chip></td>
              <td className="num">{num(p.qty, 1)} {p.uom}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!packs.length ? <Empty title="Nothing on the bench" /> : null}
    </Modal>
  );
}

/* ---------------------------------------------------------------------------
 * A RUN OF BOXES
 *
 * What came off the vehicle is not what gets stored. Two crates holding 50 kg
 * each become twenty 5 kg boxes, every one with its own grade, price and QR
 * label, and it is those boxes that go on a shelf.
 *
 * The arithmetic is shown as it is typed, because "how many can I make out of
 * what is left" is the question being answered, and getting it wrong means
 * either boxes with nothing to put in them or produce left on the bench.
 * ------------------------------------------------------------------------ */
function MakeBoxesModal({ bench, grade: initialGrade, onClose, onDone }: {
  bench: any; grade: string; onClose: () => void;
  onDone: (m: string, made?: any[]) => void;
}) {
  const [count, setCount] = useState('');
  const [size, setSize] = useState('');
  const [grade, setGrade] = useState(initialGrade);
  const [price, setPrice] = useState('');
  /* Whether the person has priced this themselves. Until they do, the box
     price follows the size they are typing; the moment they overrule it, it
     stays overruled — a field that keeps rewriting what you typed is worse
     than one that starts empty. */
  const [pricedByHand, setPricedByHand] = useState(false);
  const [binCode, setBinCode] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  const n = Number(count) || 0;
  const per = Number(size) || 0;
  const uses = n * per;
  const free = Number(bench.unpacked) || 0;
  const over = Number(bench.overPacked) || 0;
  const tooMuch = uses > free + 0.001;
  const leftOver = Math.max(0, free - uses);

  /* The whole point of the screen: how many boxes this size fit in what is
     left. Offered rather than imposed — an odd last box is normal. */
  const fits = per > 0 ? Math.floor((free + 0.001) / per) : 0;

  /* The least this box can sell for and still make the margin, given what the
     produce cost, what it costs to handle and what the trip to the shop costs.
     Per box, not per kilo, because per box is what goes on the label. */
  const floorPerUnit = Number(bench.min_sell_price) || 0;
  const floorPerBox = floorPerUnit > 0 && per > 0 ? floorPerUnit * per : 0;
  const belowFloor = floorPerBox > 0 && Number(price) > 0 && Number(price) < floorPerBox;
  const suggested = suggestPrice(floorPerUnit, per);

  /* Fill it in as soon as the size is known. Somebody at a bench should not be
     doing this arithmetic in their head against a floor printed underneath the
     box — and before this, the field started empty and most boxes went out at
     whatever was typed last. */
  useEffect(() => {
    if (!pricedByHand) setPrice(suggested);
  }, [suggested, pricedByHand]);

  return (
    <Modal
      title={`Make boxes out of ${bench.product_name}`}
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !n || !per || tooMuch}
          onClick={async () => {
            setBusy(true); setError(null);
            try {
              const r = await api.post<any>(`/inventory/pack-bench/${bench.batch_id}/run`, {
                warehouseId: bench.warehouse_id,
                binCode: binCode.trim() || undefined,
                note: note.trim() || undefined,
                groups: [{
                  count: n, qtyPerPack: per, grade,
                  price: Number(price) || 0,
                }],
              });
              onDone(r.message, r.packs);
            } catch (e: any) { setError(e); } finally { setBusy(false); }
          }}>
          {n && per ? `Make ${n} box${n === 1 ? '' : 'es'}` : 'Make them'}
        </button>
      </>}
    >
      <ErrorBanner error={error} />
      {over > 0 ? (
        <div className="banner danger mb">
          <span><Icon name="alert" size={16} /></span>
          <div className="small">
            This batch already has labels for <b>{num(over, 1)} {bench.base_uom}</b> more than it
            holds. Void the stale ones before packing any more, or the counts stay wrong.
          </div>
        </div>
      ) : (
        <p className="small muted mb">
          <b>{num(free, 1)} {bench.base_uom}</b> of {bench.product_name} is still loose on this
          batch. Every box gets its own label, so they can be sold and traced separately.
        </p>
      )}

      {/* What the shops have actually asked for. Packing 2 kg bags while three
          centres wait for 5 kg boxes is work that has to be done twice, and
          until this was here the bench had no way to know. */}
      {(bench.wanted ?? []).length ? (
        <div className="banner info mb" style={{ display: 'block' }}>
          <b className="small">Shops are waiting for these sizes</b>
          <div className="chip-row mt">
            {(bench.wanted ?? []).map((wnt: any) => (
              <button key={`${wnt.centre_name}-${wnt.pack_size_kg}`} type="button"
                className={`chip ${Number(size) === Number(wnt.pack_size_kg) ? 'primary' : 'neutral'}`}
                onClick={() => {
                  setSize(String(Number(wnt.pack_size_kg)));
                  setCount(String(wnt.boxes_wanted));
                }}>
                {wnt.centre_name ?? 'A shop'}: {wnt.boxes_wanted} × {num(wnt.pack_size_kg, 1)} kg
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="grid c2">
        <div>
          <label className="lbl">How much in each box ({bench.base_uom})</label>
          <input type="number" step="0.001" min={0} autoFocus value={size}
            onChange={(e) => setSize(e.target.value)} placeholder="5" />
        </div>
        <div>
          <label className="lbl">How many boxes</label>
          <input type="number" min={1} value={count}
            onChange={(e) => setCount(e.target.value)} placeholder="20" />
          {fits > 0 && n !== fits ? (
            <button className="btn sm ghost mt" onClick={() => setCount(String(fits))}>
              {fits} fit{fits === 1 ? 's' : ''} — use that
            </button>
          ) : null}
        </div>
      </div>

      <div className="grid c2 mt">
        <div>
          <label className="lbl">Quality of these boxes</label>
          <div className="row" style={{ gap: 5 }}>
            {GRADES.map((g) => (
              <button key={g.key} className={`btn sm ${grade === g.key ? 'primary' : ''}`}
                onClick={() => setGrade(g.key)}>{g.label}</button>
            ))}
          </div>
        </div>
        <div>
          <label className="lbl">Price on each label (₹)</label>
          <input type="number" step="0.01" min={0} value={price}
            onChange={(e) => { setPrice(e.target.value); setPricedByHand(true); }}
            placeholder="120" />
          {/* Selling happens from the box now, so this IS the selling price and
              this is where it is decided. Worked out from what the produce cost
              and the margin set on it, then left editable — the number is a
              starting point, not a rule, and the person at the bench can see
              the fruit. */}
          {floorPerBox > 0 ? (
            <div className={`small mt ${belowFloor ? 'chip danger' : 'muted'}`}>
              {belowFloor
                ? `Under the ${inr(floorPerBox)} this box has to fetch`
                : pricedByHand && price !== suggested
                  ? <>Worked out at {inr(Number(suggested))} for a {num(per, 1)}{' '}
                      {bench.base_uom} box ·{' '}
                      <button className="btn sm ghost" type="button"
                        onClick={() => { setPrice(suggested); setPricedByHand(false); }}>
                        use it
                      </button></>
                  : `Worked out from cost + ${num(bench.margin_pct, 0)}% margin, `
                    + `for a ${num(per, 1)} ${bench.base_uom} box. Change it if you need to.`}
            </div>
          ) : null}
        </div>
      </div>

      <div className="grid c2 mt">
        <div>
          <label className="lbl">Shelf, if they go now</label>
          <input value={binCode} onChange={(e) => setBinCode(e.target.value.toUpperCase())}
            placeholder="scan · R-A1-2" />
        </div>
        <div>
          <label className="lbl">Anything worth noting</label>
          <input value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="Small size this lot" />
        </div>
      </div>

      {n > 0 && per > 0 ? (
        <div className={`banner ${tooMuch ? 'danger' : 'info'} mt`}>
          <span><Icon name={tooMuch ? 'alert' : 'info'} size={16} /></span>
          <div className="small">
            {tooMuch ? (
              <>That is <b>{num(uses, 1)} {bench.base_uom}</b> of boxes out of{' '}
              <b>{num(free, 1)}</b> still loose. Make fewer, or smaller.</>
            ) : (
              <>
                {n} × {num(per, 1)} {bench.base_uom} = <b>{num(uses, 1)} {bench.base_uom}</b>
                {leftOver > 0.001
                  ? <> · {num(leftOver, 1)} {bench.base_uom} left loose on the bench</>
                  : <> · nothing left over</>}
                {Number(price) > 0
                  ? <> · {inr(Number(price) * n, 0)} of labels</> : null}
              </>
            )}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
