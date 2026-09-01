import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, useAuth, inr, num, date, ago, addDays } from '../lib/api';
import {
  Chip, DataTable, Empty, ErrorBanner, Field, Kpi, Layout, Loading, Modal, useApi, useToast,
  FilterBar, FilterTotals, useFilters,
} from '../components/ui';
import { Icon } from '../components/icons';

/* ===========================================================================
 * DISPATCH
 *
 * The other half of the driver app. A confirmed order needs a vehicle; this is
 * where somebody arranges one and then watches it happen.
 *
 * A pickup can be offered to everybody or handed to a named driver. Offering
 * it is usually right with a pool of freelance vehicles — the first driver to
 * accept gets it, which is how the phone calls worked anyway.
 * ======================================================================== */

const STAGE_TONE: Record<string, 'warn' | 'primary' | 'ok' | 'neutral'> = {
  OFFERED: 'warn', ASSIGNED: 'primary', EN_ROUTE: 'primary',
  LOADED: 'primary', DELIVERED: 'ok', CANCELLED: 'neutral',
};
const STAGE_LABEL: Record<string, string> = {
  OFFERED: 'Looking for a driver', ASSIGNED: 'Driver assigned',
  EN_ROUTE: 'On the way to collect', LOADED: 'Loaded, coming to us',
  DELIVERED: 'Delivered', CANCELLED: 'Cancelled',
};

export function LogisticsDispatchPage() {
  const toast = useToast();
  const { can } = useAuth();
  const pickups = useApi<any[]>('/receiving/pickups');
  const candidates = useApi<any[]>('/receiving/pickups/candidates');
  const [arranging, setArranging] = useState<any>(null);
  const [costing, setCosting] = useState<any>(null);

  const rows = (pickups.data ?? []).filter((p: any) => p.status !== 'CANCELLED');
  const looking = rows.filter((p: any) => p.status === 'OFFERED');
  const moving = rows.filter((p: any) => ['ASSIGNED', 'EN_ROUTE', 'LOADED'].includes(p.status));

  const fCand = useFilters<any>(candidates.data, {
    date: (c: any) => c.expected_date,
    search: (c: any) => [c.po_no, c.supplier_name, c.pickup_address].filter(Boolean).join(' '),
    facets: [
      { key: 'sup', label: 'supplier', of: (c: any) => c.supplier_name },
      { key: 'ask', label: 'request', all: 'Asked or not', of: (c: any) =>
        (c.transport_requested_at ? 'they asked for one' : 'nobody asked') },
      { key: 'frt', label: 'their freight', all: 'Charging or not', of: (c: any) =>
        (c.supplier_freight ? 'supplier is charging to bring it' : 'not charging') },
      { key: 'st', label: 'order', of: (c: any) => c.status },
    ],
    totals: [
      { label: 'Value', of: (c: any) => Number(c.grand_total) || 0, money: true },
    ],
  });
  const fPickups = useFilters<any>(rows, {
    date: (p2: any) => p2.pickup_on,
    search: (p2: any) => [p2.pickup_no, p2.po_no, p2.supplier_name, p2.driver_name, p2.driver_phone]
      .filter(Boolean).join(' '),
    facets: [
      { key: 'sup', label: 'supplier', of: (p2: any) => p2.supplier_name },
      { key: 'drv', label: 'driver', of: (p2: any) => p2.driver_name ?? 'nobody yet' },
      { key: 'st', label: 'stage', of: (p2: any) => STAGE_LABEL[p2.status] ?? p2.status },
      { key: 'fare', label: 'fare', all: 'Priced or not', of: (p2: any) =>
        (p2.transport_cost == null ? 'no fare recorded' : 'fare recorded') },
    ],
    totals: [
      { label: 'Pickups', of: () => 1 },
      { label: 'Crates reported', of: (p2: any) => Number(p2.reported_crates) || 0 },
      { label: 'Transport', of: (p2: any) => Number(p2.transport_cost) || 0, money: true },
    ],
  });
  const canManage = can('logistics.pickup.manage');

  const cancel = async (p: any) => {
    const reason = window.prompt(`Why is ${p.pickup_no} being cancelled?`);
    if (!reason || reason.trim().length < 4) return;
    try {
      await api.post(`/receiving/pickups/${p.id}/cancel`, { reason });
      toast(`${p.pickup_no} cancelled`, 'ok');
      pickups.reload(); candidates.reload();
    } catch (e: any) { toast(e.message, 'err'); }
  };

  return (
    <Layout
      title="Dispatch"
      subtitle="Get a vehicle to the supplier, and know where it is"
    >
      <ErrorBanner error={pickups.error} />

      <div className="grid c4 mb">
        <Kpi label="Orders with no vehicle" value={num((candidates.data ?? []).length, 0)}
          tone={(candidates.data ?? []).length ? 'warn' : 'good'}
          foot="confirmed, nobody collecting" />
        <Kpi label="Looking for a driver" value={num(looking.length, 0)}
          tone={looking.length ? 'warn' : undefined} foot="offered, not taken" />
        <Kpi label="On the road" value={num(moving.length, 0)} foot="assigned or moving" />
        <Kpi label="Delivered" value={num(rows.filter((p: any) => p.status === 'DELIVERED').length, 0)}
          foot="handed to the gate" />
      </div>

      {canManage ? (
        <>
          <div className="section-head"><h2>Needs a vehicle</h2><span className="rule" /></div>
          {(candidates.data ?? []).some((c: any) => c.transport_requested_at) ? (
            <div className="banner warn mb">
              <span><Icon name="truck" size={16} /></span>
              <div>
                <b>{(candidates.data ?? []).filter((c: any) => c.transport_requested_at).length} supplier(s)
                have asked for a vehicle.</b> They are at the top of the list — somebody is
                standing next to crates waiting for an answer.
              </div>
            </div>
          ) : null}
          <FilterBar f={fCand} placeholder="Search order or supplier" />
          <FilterTotals f={fCand} noun="order" />
          <div className="card mb"><div className="card-body tight">
            <DataTable
              loading={candidates.loading}
              rows={fCand.rows}
              rowTone={(c: any) => (c.transport_requested_at ? 'crit' : 'warn')}
              cols={[
                { key: 'o', head: 'Order', render: (c: any) => (
                  <div><b className="mono">{c.po_no}</b>
                    <div className="small muted">
                      wanted {date(c.expected_date)} · {String(c.status).toLowerCase().replace('_', ' ')}
                    </div></div>
                ) },
                { key: 'ask', head: '', render: (c: any) => (
                  <div>
                    {c.transport_requested_at ? (
                      <><Chip tone="warn">they asked</Chip>
                        {c.transport_request_note
                          ? <div className="small muted">{c.transport_request_note}</div> : null}</>
                    ) : null}
                    {/* One journey, two bills. Worth saying out loud before
                        somebody books a lorry for it. */}
                    {c.supplier_freight ? (
                      <div className="small muted">
                        supplier is already charging {inr(c.supplier_freight, 0)} to bring it
                      </div>
                    ) : null}
                  </div>
                ) },
                { key: 's', head: 'Collect from', render: (c: any) => (
                  <div>{c.supplier_name}
                    <div className="small muted">{c.pickup_address ?? '—'}</div></div>
                ) },
                { key: 'v', head: 'Value', num: true, render: (c: any) => inr(c.grand_total, 0) },
                { key: 'a', head: '', width: 130, render: (c: any) => (
                  <button className="btn sm primary" onClick={() => setArranging(c)}>Arrange pickup</button>
                ) },
              ]}
              empty={<Empty icon="✅" title={fCand.active > 0
                ? 'No order matches those filters' : 'Every confirmed order has a vehicle'} />}
            />
          </div></div>
        </>
      ) : null}

      <div className="section-head"><h2>Pickups</h2><span className="rule" /></div>
      <FilterBar f={fPickups} placeholder="Search pickup, order, supplier, driver" />
      <FilterTotals f={fPickups} noun="pickup" />
      <div className="card"><div className="card-body tight">
        <DataTable
          loading={pickups.loading}
          rows={fPickups.rows}
          rowTone={(p: any) => (p.status === 'OFFERED' ? 'warn' : undefined)}
          cols={[
            { key: 'n', head: 'Pickup', render: (p: any) => (
              <div><b className="mono">{p.pickup_no}</b>
                <div className="small muted">{p.po_no} · {date(p.pickup_on)}</div></div>
            ) },
            { key: 's', head: 'From', render: (p: any) => p.supplier_name },
            { key: 'd', head: 'Driver', render: (p: any) => p.driver_name ? (
              <div>{p.driver_name}
                {p.driver_phone ? <div className="small muted">{p.driver_phone}</div> : null}</div>
            ) : <span className="muted small">nobody yet</span> },
            { key: 'st', head: 'Where it is', render: (p: any) => (
              <div>
                <Chip tone={STAGE_TONE[p.status]}>{STAGE_LABEL[p.status] ?? p.status}</Chip>
                {p.reported_crates ? (
                  <div className="small muted">driver reports {p.reported_crates} crate(s)</div>
                ) : null}
              </div>
            ) },
            { key: 'f', head: 'Transport', num: true, render: (p: any) => p.transport_cost != null ? (
              <div><b>{inr(p.transport_cost, 0)}</b>
                <div className="small muted">
                  {p.fare_request_no
                    ? `${p.fare_request_no} · ${String(p.fare_status ?? '').toLowerCase().replace('_', ' ')}`
                    : 'nothing to pay'}
                </div></div>
            ) : <span className="muted small">not priced</span> },
            { key: 'a', head: '', width: 190, render: (p: any) => canManage ? (
              <div className="row">
                {p.status !== 'CANCELLED' ? (
                  <button className="btn sm" onClick={() => setCosting(p)}>
                    {p.transport_cost != null ? 'Fare' : 'Record fare'}
                  </button>
                ) : null}
                {!['DELIVERED', 'CANCELLED'].includes(p.status) ? (
                  <button className="btn sm ghost" onClick={() => cancel(p)}>Cancel</button>
                ) : null}
              </div>
            ) : null },
          ]}
          empty={<Empty icon="🚚"
            title={fPickups.active > 0 ? 'No pickup matches those filters' : 'No pickups arranged yet'}
            hint={fPickups.active > 0 ? 'Clear a filter to widen the search.'
              : 'Arrange one against a confirmed order above.'} />}
        />
      </div></div>

      {arranging ? (
        <ArrangeModal candidate={arranging} onClose={() => setArranging(null)}
          onDone={() => { setArranging(null); pickups.reload(); candidates.reload(); }} />
      ) : null}
      {costing ? (
        <FareModal pickup={costing} onClose={() => setCosting(null)}
          onDone={() => { setCosting(null); pickups.reload(); }} />
      ) : null}
    </Layout>
  );
}

function ArrangeModal({ candidate, onClose, onDone }: {
  candidate: any; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const drivers = useApi<any[]>('/masters/drivers');
  const [pickupOn, setPickupOn] = useState(candidate.expected_date?.slice(0, 10) ?? addDays(1));
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [driverId, setDriverId] = useState('');
  const [address, setAddress] = useState(candidate.pickup_address ?? '');
  const [notes, setNotes] = useState('');
  const [fare, setFare] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.post<any>('/receiving/pickups', {
        poId: candidate.po_id,
        pickupOn,
        windowStart: from || null,
        windowEnd: to || null,
        pickupAddress: address || undefined,
        notes: notes || undefined,
        driverId: driverId || null,
        transportCost: Number(fare) > 0 ? Number(fare) : undefined,
      });
      toast(driverId
        ? `${r.pickup_no} assigned`
        : `${r.pickup_no} offered — drivers can take it now`, 'ok');
      onDone();
    } catch (e: any) { setError(e); } finally { setBusy(false); }
  };

  return (
    <Modal
      title={`Arrange a pickup for ${candidate.po_no}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !pickupOn} onClick={submit}>
            {busy ? 'Saving…' : driverId ? 'Assign it' : 'Offer it to drivers'}
          </button>
        </>
      }
    >
      <ErrorBanner error={error} />
      <dl className="kv mb">
        <dt>Collect from</dt><dd>{candidate.supplier_name}</dd>
        <dt>Their number</dt>
        <dd>{candidate.supplier_phone
          ? <a href={`tel:${candidate.supplier_phone}`}>{candidate.supplier_phone}</a>
          : <span className="muted">not on file</span>}</dd>
        <dt>Order value</dt><dd>{inr(candidate.grand_total, 0)}</dd>
      </dl>

      <div className="grid c3">
        <Field label="Collect on">
          <input type="date" value={pickupOn} onChange={(e) => setPickupOn(e.target.value)} />
        </Field>
        <Field label="From" hint="Optional time window.">
          <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Until">
          <input type="time" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>

      <Field label="Pickup address" hint="Where the vehicle actually goes.">
        <input value={address} onChange={(e) => setAddress(e.target.value)} />
      </Field>

      <Field
        label="Give it to a particular driver?"
        hint="Leave it open and the first driver to accept gets it — usually what you want with a pool of vehicles."
      >
        <select value={driverId} onChange={(e) => setDriverId(e.target.value)}>
          <option value="">Offer it to everybody</option>
          {(drivers.data ?? []).filter((d: any) => d.status === 'ACTIVE').map((d: any) => (
            <option key={d.id} value={d.id}>{d.full_name}{d.phone ? ` — ${d.phone}` : ''}</option>
          ))}
        </select>
      </Field>

      <Field label="Anything the driver should know?">
        <input value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>

      <Field
        label="Agreed fare (₹)"
        hint="Leave it blank if the price is not settled yet — you can record it from the pickup afterwards."
      >
        <input type="number" step="0.01" min="0" value={fare} placeholder="0.00"
          onChange={(e) => setFare(e.target.value)} />
      </Field>
      {Number(fare) > 0 ? (
        <div className="banner info">
          <span><Icon name="info" size={16} /></span>
          <div className="small">
            {inr(Number(fare), 0)} goes to Finance as a transport claim, and lands on the
            cost of everything this vehicle brings in.
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

/* We sent a vehicle, so the fare is ours to pay.
 *
 * The point of recording it here is not bookkeeping. Freight in is part of what
 * the produce cost us, and until somebody types this number the goods look
 * cheaper than they were and get sold too cheap.
 */
function FareModal({ pickup, onClose, onDone }: {
  pickup: any; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [amount, setAmount] = useState(
    pickup.transport_cost != null ? String(pickup.transport_cost) : '');
  const [note, setNote] = useState(pickup.cost_note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  const locked = !!pickup.fare_request_no;

  return (
    <Modal
      title={`Transport for ${pickup.pickup_no}`}
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Close</button>
        {!locked ? (
          <button className="btn primary" disabled={busy || amount === ''}
            onClick={async () => {
              setBusy(true); setError(null);
              try {
                const r = await api.post<any>(`/receiving/pickups/${pickup.id}/cost`,
                  { transportCost: Number(amount), costNote: note.trim() || undefined });
                toast(r.message, 'ok');
                onDone();
              } catch (e: any) { setError(e); } finally { setBusy(false); }
            }}>
            {busy ? 'Saving…' : 'Record it'}
          </button>
        ) : null}
      </>}
    >
      <ErrorBanner error={error} />
      <dl className="kv mb">
        <dt>Collecting</dt><dd>{pickup.po_no} from {pickup.supplier_name}</dd>
        <dt>Driver</dt>
        <dd>{pickup.driver_name ?? <span className="muted">nobody yet</span>}</dd>
      </dl>

      {locked ? (
        <>
          <dl className="kv mb">
            <dt>Fare</dt><dd><b>{inr(pickup.transport_cost, 0)}</b></dd>
            <dt>With Finance as</dt>
            <dd><b className="mono">{pickup.fare_request_no}</b> ·{' '}
              {String(pickup.fare_status ?? '').toLowerCase().replace('_', ' ')}</dd>
          </dl>
          {pickup.cost_note ? <p className="small muted">{pickup.cost_note}</p> : null}
          <p className="small muted">
            Finance is already holding this claim. If the fare has changed, cancel the
            request on the Payments desk first and then record the new figure.
          </p>
        </>
      ) : (
        <>
          <Field label="What the trip cost (₹)"
            hint="What we are paying the driver or transporter. Zero if it cost us nothing.">
            <input type="number" step="0.01" min="0" value={amount} autoFocus
              onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          </Field>
          <Field label="Anything to note">
            <input value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Return trip empty — agreed round figure" />
          </Field>
          {Number(amount) > 0 ? (
            <div className="banner info">
              <span><Icon name="info" size={16} /></span>
              <div className="small">
                This goes to Finance as a transport claim, and is spread over the kilos
                coming in — so it shows up in what the produce costs and in its price.
              </div>
            </div>
          ) : null}
        </>
      )}
    </Modal>
  );
}
