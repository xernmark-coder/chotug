import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, useAuth, num, ago } from '../lib/api';
import { Chip, Empty, ErrorBanner, Kpi, Layout, Loading, Modal, useApi, useToast } from '../components/ui';
import { Icon } from '../components/icons';

/* ===========================================================================
 * UNLOADING — ONE BOX AT A TIME
 *
 * This screen is used standing next to a lorry, on a tablet, by somebody
 * holding a box in the other hand. So:
 *
 *   · the product is a big tile, not a dropdown;
 *   · the weight is a number pad, not a text field;
 *   · one tap records the box and stays exactly where it is, ready for the
 *     next one — no dialog, no confirmation, no scrolling back up;
 *   · the running total per product is always visible, because that is the
 *     number the whole exercise exists to produce.
 *
 * A box is corrected by voiding it. Nothing here edits a weight, because a
 * weight that can be edited later is a weight nobody can be held to.
 * ======================================================================== */

export function UnloadPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<any>(`/receiving/gate-entries/${id}/boxes`, [id]);

  const [productId, setProductId] = useState<string>('');
  const [weight, setWeight] = useState('');
  const [count, setCount] = useState('');
  const [busy, setBusy] = useState(false);
  const [voiding, setVoiding] = useState<any>(null);
  const [postError, setPostError] = useState<any>(null);
  const scanRef = useRef<HTMLInputElement>(null);

  const boxCount = Math.max(1, Math.min(200, Number(count) || 1));
  const lines = data?.lines ?? [];
  const chosen = lines.find((l: any) => l.product_id === productId);

  /* One product on the lorry is the overwhelmingly common case; making them
   * pick it every time would be an insult. */
  useEffect(() => {
    if (!productId && lines.length === 1) setProductId(lines[0].product_id);
  }, [lines, productId]);

  const addBox = async (over?: { productId?: string; scannedCode?: string }) => {
    const kg = Number(weight);
    if (!kg || kg <= 0) return;
    setBusy(true); setPostError(null);
    try {
      const r = await api.post<any>(`/receiving/gate-entries/${id}/boxes`, {
        productId: over?.scannedCode ? undefined : (over?.productId ?? productId),
        scannedCode: over?.scannedCode,
        weightKg: kg,
        count: boxCount,
        captureMode: over?.scannedCode ? 'SCAN' : 'MANUAL',
      });
      toast(r.message, 'ok');
      setWeight('');
      setCount('');
      reload();
    } catch (e: any) { setPostError(e); } finally { setBusy(false); }
  };

  if (loading) return <Layout title="Unloading"><Loading /></Layout>;
  if (error) return <Layout title="Unloading"><ErrorBanner error={error} /></Layout>;

  const entry = data.entry;
  const canWeigh = can('receiving.box.weigh');

  return (
    <Layout
      title={`Unloading ${entry.gate_no}`}
      subtitle={entry.po_no ? `Against ${entry.po_no}` : 'No purchase order — unplanned arrival'}
      touch
      actions={<div className="btn-row">
        <button className="btn sm" onClick={() => nav('/intake')}>
          Warehouse intake
        </button>
        {data.totalBoxes > 0 ? (
          <button className="btn sm primary" onClick={() => nav(`/gate/${id}`)}>
            Done weighing boxes →
          </button>
        ) : null}
        {!data.totalBoxes ? (
          <button className="btn sm" onClick={() => nav(`/gate/${id}`)}>Vehicle file →</button>
        ) : null}
      </div>}
    >
      <ErrorBanner error={postError} />

      <div className="grid c3 mb">
        <Kpi label="Boxes off the lorry" value={num(data.totalBoxes, 0)} />
        <Kpi label="Weighed so far" value={`${num(data.totalKg, 1)} kg`} />
        <Kpi label="Products" value={lines.filter((l: any) => Number(l.boxes) > 0).length}
          foot={`${lines.length} on the order`} />
      </div>

      <div className="grid sidebar-right">
        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>1 · Which product is in the box?</h2></div>
            <div className="card-body">
              <div className="tile-grid">
                {lines.map((l: any) => {
                  const on = l.product_id === productId;
                  return (
                    <button key={l.product_id}
                      className={`product-tile ${on ? 'on' : ''}`}
                      onClick={() => setProductId(l.product_id)}>
                      <Icon name={l.icon ?? 'produce'} size={28} />
                      <b>{l.product_name}</b>
                      <span className="small">
                        {Number(l.boxes) > 0
                          ? `${l.boxes} box${Number(l.boxes) === 1 ? '' : 'es'} · ${num(l.net_kg, 1)} kg`
                          : 'nothing yet'}
                      </span>
                      {l.ordered_qty ? (
                        <span className="small muted">ordered {num(l.ordered_qty, 0)} {l.ordered_uom}</span>
                      ) : <Chip tone="warn">not ordered</Chip>}
                    </button>
                  );
                })}
              </div>
              {!lines.length ? (
                <Empty icon="📦" title="Nothing on this order"
                  hint="Scan a box code below and the product will be found from it." />
              ) : null}

              {/* The box carries the supplier's own code, not ours. */}
              <div className="row mt" style={{ gap: 8 }}>
                <input ref={scanRef} placeholder="…or scan the code printed on the box"
                  style={{ flex: 1 }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    const code = (e.target as HTMLInputElement).value.trim();
                    if (!code) return;
                    if (!Number(weight)) { toast('Put the weight in first', 'err'); return; }
                    addBox({ scannedCode: code });
                    (e.target as HTMLInputElement).value = '';
                  }} />
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>2 · What did it weigh?</h2>
              {chosen ? <span className="small muted">{chosen.product_name}</span> : null}
            </div>
            <div className="card-body">
              <div className="weigh-readout">{weight || '0'}<span>kg</span></div>
              <div className="keypad">
                {['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0', '⌫'].map((k) => (
                  <button key={k} className="key" onClick={() => {
                    if (k === '⌫') return setWeight((w) => w.slice(0, -1));
                    if (k === '.' && weight.includes('.')) return;
                    setWeight((w) => (w + k).slice(0, 8));
                  }}>{k}</button>
                ))}
              </div>
              {/* A lorry often holds a stack of identical boxes. Recording ten
                  of them was ten identical taps, so the floor stopped bothering
                  and typed one box of 200 kg — which cannot be corrected when
                  one of the ten turns out to be short. Each is still its own
                  row; this only saves the repetition. */}
              <div className="row mt" style={{ gap: 8, alignItems: 'flex-end' }}>
                <div style={{ width: 120 }}>
                  <label className="lbl">How many</label>
                  <input className="num" type="number" min={1} max={200} value={count}
                    onChange={(e) => setCount(e.target.value)} placeholder="1" />
                </div>
                <button
                  className="btn primary block lg"
                  disabled={busy || !canWeigh || !Number(weight) || !productId}
                  onClick={() => addBox()}>
                  {busy ? 'Recording…'
                    : boxCount > 1
                      ? `Add ${boxCount} boxes of ${weight || 0} kg`
                      : `Add box ${data.totalBoxes + 1}`}
                </button>
              </div>
              {boxCount > 1 && Number(weight) ? (
                <p className="small muted mt" style={{ textAlign: 'center' }}>
                  {boxCount} × {weight} kg = <b>{num(boxCount * Number(weight), 1)} kg</b>
                </p>
              ) : null}
              {!canWeigh ? (
                <p className="small muted mt">You can watch this, but not record boxes.</p>
              ) : null}
            </div>
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>Running total</h2></div>
            <div className="card-body tight">
              <table className="mini">
                <tbody>
                  {lines.filter((l: any) => Number(l.boxes) > 0).map((l: any) => {
                    /* Ordered in kilos and unloaded in kilos are comparable;
                       ordered in crates and unloaded in kilos are not, so we
                       only show the gap when the units agree. */
                    const comparable = (l.ordered_uom ?? '').toUpperCase() === 'KG';
                    const gap = comparable ? Number(l.net_kg) - Number(l.ordered_qty) : null;
                    return (
                      <tr key={l.product_id}>
                        <td>
                          <b>{l.product_name}</b>
                          <div className="small muted">
                            {l.boxes} boxes · avg {num(l.avg_box_kg, 2)} kg
                            {Number(l.min_box_kg) && Number(l.max_box_kg)
                              ? ` (${num(l.min_box_kg, 1)}–${num(l.max_box_kg, 1)})` : ''}
                          </div>
                        </td>
                        <td className="num">
                          <b>{num(l.net_kg, 1)} kg</b>
                          {gap != null ? (
                            <div className={`small ${Math.abs(gap) > Number(l.ordered_qty) * 0.05
                              ? 'text-danger' : 'muted'}`}>
                              {gap >= 0 ? '+' : ''}{num(gap, 1)} vs ordered
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                  {!data.totalBoxes ? (
                    <tr><td colSpan={2} className="muted small">No boxes weighed yet.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h2>Last boxes</h2></div>
            <div className="card-body tight">
              <table className="mini">
                <tbody>
                  {(data.boxes ?? []).slice(0, 12).map((b: any) => (
                    <tr key={b.id} className={b.voided_at ? 'voided' : ''}>
                      <td>
                        <b>#{b.box_no}</b> {b.product_name}
                        <div className="small muted">
                          {ago(b.weighed_at)} · {b.weighed_by_name}
                          {b.voided_at ? ` · voided: ${b.void_reason}` : ''}
                        </div>
                      </td>
                      <td className="num">{num(b.weight_kg, 2)} kg</td>
                      <td style={{ width: 60 }}>
                        {!b.voided_at && can('receiving.box.void') ? (
                          <button className="btn sm danger" onClick={() => setVoiding(b)}>Void</button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                  {!(data.boxes ?? []).length ? (
                    <tr><td className="muted small">Nothing recorded yet.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {voiding ? (
        <VoidBoxModal box={voiding} onClose={() => setVoiding(null)}
          onDone={(m) => { setVoiding(null); reload(); toast(m, 'ok'); }} />
      ) : null}
    </Layout>
  );
}

function VoidBoxModal({ box, onClose, onDone }: {
  box: any; onClose: () => void; onDone: (m: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  return (
    <Modal
      title={`Void box ${box.box_no} — ${num(box.weight_kg, 2)} kg`}
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Keep it</button>
        <button className="btn danger" disabled={busy || reason.trim().length < 3}
          onClick={async () => {
            setBusy(true); setError(null);
            try {
              const r = await api.post<any>(`/receiving/boxes/${box.id}/void`, { reason: reason.trim() });
              onDone(r.message);
            } catch (e: any) { setError(e); } finally { setBusy(false); }
          }}>Void this box</button>
      </>}
    >
      <ErrorBanner error={error} />
      <p className="small muted mb">
        The box stays on the record with your reason against it — it simply stops
        counting towards the total. Nothing here changes a weight.
      </p>
      <input value={reason} autoFocus onChange={(e) => setReason(e.target.value)}
        placeholder="Weighed with the crate still on the scale" />
    </Modal>
  );
}
