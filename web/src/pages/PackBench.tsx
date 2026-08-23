import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, useAuth, inr, num, ago } from '../lib/api';
import { Chip, Empty, ErrorBanner, Kpi, Layout, Loading, Modal, useApi, useToast } from '../components/ui';
import { Icon } from '../components/icons';

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
  const [qty, setQty] = useState('');
  const [price, setPrice] = useState('');
  const [binCode, setBinCode] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [postError, setPostError] = useState<any>(null);
  const [storing, setStoring] = useState(false);

  /* Price is per grade in practice, so remembering the last one for this grade
     saves typing it on every box. */
  const [priceByGrade, setPriceByGrade] = useState<Record<string, string>>({});
  useEffect(() => { setPrice(priceByGrade[grade] ?? ''); }, [grade]); // eslint-disable-line

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
      setPriceByGrade((s) => ({ ...s, [grade]: price }));
      setNote('');
      reload();
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
                  <input type="number" value={price} onChange={(e) => setPrice(e.target.value)} />
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
                      <td className="num">{inr(p.price, 0)}</td>
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
                      <td className="num"><Chip tone="primary">{p.bin_code}</Chip></td>
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

  return (
    <Modal
      title="Put these on a shelf"
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
      <div className="chip-row mt mb">
        {bins.slice(0, 12).map((b: any) => (
          <button key={b.id} className={`chip ${binCode === b.code ? 'primary' : ''}`}
            onClick={() => setBinCode(b.code)}>
            {b.code}{b.packs ? ` · ${b.packs}` : ''}
          </button>
        ))}
      </div>
      <label className="lbl">Which boxes</label>
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
