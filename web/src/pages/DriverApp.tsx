import React, { useState } from 'react';
import { api, useAuth, num, date } from '../lib/api';
import {
  Chip, Empty, ErrorBanner, Field, Layout, Loading, Modal, useApi, useToast,
} from '../components/ui';

/* ===========================================================================
 * THE DRIVER'S APP
 *
 * Read on a phone, one-handed, often in the dark outside a mandi. So: no
 * tables, no dashboard, no sidebar full of things a driver cannot do. Cards
 * with one obvious button each, and a phone number that dials.
 *
 * Scoped on the server by the driver_id on their own user row.
 * ======================================================================== */

const STEP: Record<string, { next: string; label: string; done: string }> = {
  ASSIGNED: { next: 'start', label: "I'm on my way", done: 'Heading to the supplier' },
  EN_ROUTE: { next: 'loaded', label: 'Goods loaded', done: 'Loaded' },
  LOADED:   { next: 'delivered', label: 'Delivered at warehouse', done: 'Delivered' },
};

export function DriverAppPage() {
  const toast = useToast();
  const me = useApi<any>('/driver/me');
  const jobs = useApi<any>('/driver/pickups');
  const [loading, setLoading] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (me.loading) return <Layout title="Pickups"><Loading /></Layout>;
  if (me.error) return <Layout title="Pickups"><ErrorBanner error={me.error} /></Layout>;

  const offered = jobs.data?.offered ?? [];
  const mine = (jobs.data?.mine ?? []).filter((p: any) => p.status !== 'DELIVERED');
  const done = (jobs.data?.mine ?? []).filter((p: any) => p.status === 'DELIVERED');

  const accept = async (p: any) => {
    setBusy(p.id);
    try {
      await api.post(`/driver/pickups/${p.id}/accept`, {});
      toast(`${p.pickup_no} is yours`, 'ok');
      jobs.reload();
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(null); }
  };

  const advance = async (p: any) => {
    const step = STEP[p.status];
    if (!step) return;
    if (step.next === 'loaded') { setLoading(p); return; }
    setBusy(p.id);
    try {
      await api.post(`/driver/pickups/${p.id}/${step.next}`, {});
      toast(step.done, 'ok');
      jobs.reload();
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(null); }
  };

  const Card = ({ p, mineJob }: { p: any; mineJob: boolean }) => {
    const step = STEP[p.status];
    return (
      <div className="card mb">
        <div className="card-head">
          <h2>{p.supplier_name}</h2>
          <Chip value={p.status} />
        </div>
        <div className="card-body">
          <dl className="kv">
            <dt>Collect on</dt>
            <dd>
              {date(p.pickup_on)}
              {p.window_start ? ` · ${String(p.window_start).slice(0, 5)}` : ''}
              {p.window_end ? `–${String(p.window_end).slice(0, 5)}` : ''}
            </dd>
            <dt>From</dt><dd>{p.pickup_address ?? '—'}</dd>
            <dt>Deliver to</dt><dd>{p.warehouse_name ?? p.branch_name}</dd>
            <dt>Order</dt><dd className="mono">{p.po_no} · {p.item_count} item(s)</dd>
            <dt>Their number</dt>
            <dd>{p.supplier_phone
              ? <a href={`tel:${p.supplier_phone}`}>{p.supplier_phone}</a>
              : <span className="muted">not on file</span>}</dd>
          </dl>
          {p.notes ? <div className="small muted mt">{p.notes}</div> : null}

          <div className="btn-row mt">
            {!mineJob ? (
              <button className="btn primary lg block" disabled={busy === p.id}
                onClick={() => accept(p)}>
                {busy === p.id ? 'Taking…' : 'Take this job'}
              </button>
            ) : step ? (
              <button className="btn primary lg block" disabled={busy === p.id}
                onClick={() => advance(p)}>
                {busy === p.id ? 'Saving…' : step.label}
              </button>
            ) : (
              <span className="small muted">
                Delivered{p.reported_crates ? ` · you reported ${p.reported_crates} crate(s)` : ''}
              </span>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <Layout title={me.data.full_name} subtitle={`Driving for ${me.data.company_name}`} touch>
      <ErrorBanner error={jobs.error} />

      {mine.length ? (
        <>
          <div className="section-head"><h2>Your jobs</h2><span className="rule" /></div>
          {mine.map((p: any) => <Card key={p.id} p={p} mineJob />)}
        </>
      ) : null}

      <div className="section-head"><h2>Jobs going spare</h2><span className="rule" /></div>
      {offered.length
        ? offered.map((p: any) => <Card key={p.id} p={p} mineJob={false} />)
        : (
          <div className="card"><div className="card-body">
            <Empty icon="✅" title="Nothing going spare right now"
              hint="New pickups appear here as soon as they are published." />
          </div></div>
        )}

      {done.length ? (
        <>
          <div className="section-head"><h2>Done</h2><span className="rule" /></div>
          {done.slice(0, 5).map((p: any) => (
            <div className="card mb" key={p.id}>
              <div className="card-body">
                <b>{p.supplier_name}</b> · <span className="mono small">{p.po_no}</span>
                <div className="small muted">
                  Delivered {date(p.pickup_on)}
                  {p.reported_crates ? ` · ${p.reported_crates} crate(s)` : ''}
                </div>
              </div>
            </div>
          ))}
        </>
      ) : null}

      {loadingModal(loading, setLoading, jobs.reload, toast)}
    </Layout>
  );
}

/** Loading is the one step where the driver knows something we do not yet. */
function loadingModal(
  p: any, close: (v: any) => void, reload: () => void,
  toast: (t: string, k?: any) => void,
) {
  if (!p) return null;
  return <LoadedModal pickup={p} onClose={() => close(null)}
    onDone={() => { close(null); reload(); }} toast={toast} />;
}

function LoadedModal({ pickup, onClose, onDone, toast }: {
  pickup: any; onClose: () => void; onDone: () => void; toast: (t: string, k?: any) => void;
}) {
  const [crates, setCrates] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api.post(`/driver/pickups/${pickup.id}/loaded`, {
        crates: crates ? Number(crates) : null,
        note: note || undefined,
      });
      toast('Loaded — the warehouse has been told you are coming', 'ok');
      onDone();
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <Modal
      title="Goods loaded"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Back</button>
          <button className="btn primary" disabled={busy} onClick={submit}>
            {busy ? 'Saving…' : 'On my way to the warehouse'}
          </button>
        </>
      }
    >
      <p className="small muted mb">
        The warehouse gets told you are on the way as soon as you save this.
      </p>
      <Field label="How many crates did you load?"
        hint="A rough count is fine — the weighbridge is the final word.">
        <input type="number" value={crates} autoFocus onChange={(e) => setCrates(e.target.value)} />
      </Field>
      <Field label="Anything they should know?" hint="Short load, damage, a delay.">
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}
