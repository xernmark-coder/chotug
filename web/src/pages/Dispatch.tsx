import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, useAuth, inr, num, date, ago, addDays } from '../lib/api';
import {
  Chip, DataTable, Empty, ErrorBanner, Field, Kpi, Layout, Loading, Modal, useApi, useToast,
  FilterBar, FilterTotals, useFilters,
} from '../components/ui';

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

  const rows = (pickups.data ?? []).filter((p: any) => p.status !== 'CANCELLED');
  const looking = rows.filter((p: any) => p.status === 'OFFERED');
  const moving = rows.filter((p: any) => ['ASSIGNED', 'EN_ROUTE', 'LOADED'].includes(p.status));

  const fCand = useFilters<any>(candidates.data, {
    date: (c: any) => c.expected_date,
    search: (c: any) => [c.po_no, c.supplier_name, c.pickup_address].filter(Boolean).join(' '),
    facets: [{ key: 'sup', label: 'supplier', of: (c: any) => c.supplier_name }],
    totals: [
      { label: 'Orders', of: () => 1 },
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
    ],
    totals: [
      { label: 'Pickups', of: () => 1 },
      { label: 'Crates reported', of: (p2: any) => Number(p2.reported_crates) || 0 },
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
          <FilterBar f={fCand} placeholder="Search order or supplier" />
          <FilterTotals f={fCand} noun="order" />
          <div className="card mb"><div className="card-body tight">
            <DataTable
              loading={candidates.loading}
              rows={fCand.rows}
              rowTone={() => 'warn'}
              cols={[
                { key: 'o', head: 'Order', render: (c: any) => (
                  <div><b className="mono">{c.po_no}</b>
                    <div className="small muted">wanted {date(c.expected_date)}</div></div>
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
            { key: 'a', head: '', width: 100, render: (p: any) =>
              canManage && !['DELIVERED', 'CANCELLED'].includes(p.status) ? (
                <button className="btn sm ghost" onClick={() => cancel(p)}>Cancel</button>
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
    </Modal>
  );
}
