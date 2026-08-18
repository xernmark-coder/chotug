import React, { useState } from 'react';
import { api, useAuth, date, num } from '../lib/api';
import {
  Chip, DataTable, Empty, ErrorBanner, Field, Layout, Modal, useApi, useToast,
} from '../components/ui';
import { Icon } from '../components/icons';

/* ===========================================================================
 * FLEET — the vehicles and drivers the gate picks from.
 *
 * Both dropdowns on the gate-entry screen read this list. Adding a truck here
 * is what turns its registration from free text into a record whose fitness,
 * insurance and PUC expiry are checked on every arrival.
 *
 * "Remove" retires; it never deletes. Every gate entry, weighment and receipt
 * that names a truck or a driver keeps pointing at the same row.
 * ======================================================================== */

const VEHICLE_TYPES = ['TRUCK', 'TEMPO', 'PICKUP', 'TRACTOR', 'REEFER', 'CONTAINER', 'TWO_WHEELER'];
const STATUSES = ['ACTIVE', 'WATCH', 'BLOCKED'];

export function FleetPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'vehicles' | 'drivers'>('vehicles');
  const [showRetired, setShowRetired] = useState(false);
  const manage = can('master.vehicle.manage');

  return (
    <Layout title="Vehicles &amp; Drivers"
      subtitle="The list the gate chooses from"
      actions={
        <div className="btn-row">
          <label className="small muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={showRetired}
              onChange={(e) => setShowRetired(e.target.checked)} />
            Show removed
          </label>
        </div>
      }>
      <div className="banner info mb">
        <span><Icon name="truckIn" size={16} /></span>
        <div>
          A truck that is on this list is checked for expired fitness, insurance and PUC
          every time it reaches the gate. One that is not can still be received — the gate
          accepts any registration typed by hand — but nothing about it is verified.
          {manage ? '' : ' Ask a gate supervisor to add or remove entries.'}
        </div>
      </div>

      <div className="search-bar">
        <div className="btn-row">
          <button className={`btn ${tab === 'vehicles' ? 'primary' : ''}`}
            onClick={() => setTab('vehicles')}>Vehicles</button>
          <button className={`btn ${tab === 'drivers' ? 'primary' : ''}`}
            onClick={() => setTab('drivers')}>Drivers</button>
        </div>
      </div>

      {tab === 'vehicles'
        ? <VehiclesCard showRetired={showRetired} manage={manage} />
        : <DriversCard showRetired={showRetired} manage={manage} />}
    </Layout>
  );
}

/* ==================================================== VEHICLES =========== */
function VehiclesCard({ showRetired, manage }: { showRetired: boolean; manage: boolean }) {
  const toast = useToast();
  const { data, loading, error, reload } = useApi<any[]>(
    `/masters/vehicles?includeRetired=${showRetired ? 1 : 0}`, [showRetired]);
  const [editing, setEditing] = useState<any>(null);
  const [retiring, setRetiring] = useState<any>(null);

  const restore = async (v: any) => {
    try {
      await api.post(`/masters/vehicles/${v.id}/restore`);
      toast(`${v.reg_no} is back on the list`, 'ok');
      reload();
    } catch (e: any) { toast(e.message, 'err'); }
  };

  return (
    <>
      <ErrorBanner error={error} />
      <div className="card">
        <div className="card-head">
          <h3>Vehicles</h3>
          <div style={{ flex: 1 }} />
          {manage ? (
            <button className="btn primary" onClick={() => setEditing({})}>Add vehicle</button>
          ) : null}
        </div>
        <div className="card-body tight">
          <DataTable
            rows={data ?? []} loading={loading}
            rowTone={(v: any) => (!v.is_active ? undefined
              : v.status === 'BLOCKED' ? 'crit' : v.compliance_expired ? 'warn' : undefined)}
            cols={[
              { key: 'r', head: 'Vehicle', render: (v: any) => (
                <div>
                  <b className="mono" style={{ fontSize: 15 }}>{v.reg_no}</b>
                  <div className="small muted">
                    {v.vehicle_type}{v.make_model ? ` · ${v.make_model}` : ''}
                  </div>
                </div>
              ) },
              { key: 't', head: 'Transporter', render: (v: any) => v.transporter_name ?? '—' },
              { key: 'c', head: 'Capacity', num: true, render: (v: any) =>
                v.capacity_kg ? `${num(v.capacity_kg, 0)} kg` : '—' },
              { key: 'tare', head: 'Tare ref.', num: true, render: (v: any) =>
                v.tare_reference_kg ? `${num(v.tare_reference_kg, 0)} kg` : '—' },
              { key: 'd', head: 'Papers valid to', render: (v: any) => (
                <div className="small">
                  <div>Fitness {v.fitness_expiry ? date(v.fitness_expiry) : '—'}</div>
                  <div>Insurance {v.insurance_expiry ? date(v.insurance_expiry) : '—'}</div>
                  <div>PUC {v.puc_expiry ? date(v.puc_expiry) : '—'}</div>
                </div>
              ) },
              { key: 'st', head: 'Status', render: (v: any) => (
                <div>
                  {v.is_active ? <Chip value={v.status} /> : <Chip tone="neutral">removed</Chip>}
                  {v.is_active && v.compliance_expired
                    ? <div><Chip tone="warn">papers expired</Chip></div> : null}
                  {!v.is_active && v.retired_reason
                    ? <div className="small muted">{v.retired_reason}</div> : null}
                </div>
              ) },
              { key: 'a', head: '', width: 170, render: (v: any) => !manage ? null : (
                <div className="btn-row" onClick={(e) => e.stopPropagation()}>
                  {v.is_active ? (
                    <>
                      <button className="btn sm" onClick={() => setEditing(v)}>Edit</button>
                      <button className="btn sm danger" onClick={() => setRetiring(v)}>Remove</button>
                    </>
                  ) : (
                    <button className="btn sm" onClick={() => restore(v)}>Restore</button>
                  )}
                </div>
              ) },
            ]}
            empty={<Empty icon="🚛" title="No vehicles on the list"
              hint="Add the trucks that deliver to you so their papers are checked at the gate." />}
          />
        </div>
      </div>

      {editing ? (
        <VehicleModal vehicle={editing} onClose={() => setEditing(null)}
          onSaved={(msg) => { setEditing(null); toast(msg, 'ok'); reload(); }} />
      ) : null}

      {retiring ? (
        <RetireModal
          title={`Remove ${retiring.reg_no}`}
          what="This vehicle leaves the gate dropdown. Every past gate entry, weighment and receipt keeps its record."
          hint="e.g. sold, scrapped, transporter changed"
          onClose={() => setRetiring(null)}
          onConfirm={async (reason) => {
            await api.post(`/masters/vehicles/${retiring.id}/retire`, { reason });
            setRetiring(null);
            toast(`${retiring.reg_no} removed from the list`, 'ok');
            reload();
          }} />
      ) : null}
    </>
  );
}

/** Also opened straight from the gate screen, so a truck that turns up
 *  unannounced can be put on the list without leaving the arrival. */
export function VehicleModal({ vehicle, onClose, onSaved }: {
  vehicle: any; onClose: () => void; onSaved: (msg: string, saved: any) => void;
}) {
  const isNew = !vehicle.id;
  const [f, setF] = useState<any>({
    regNo: vehicle.reg_no ?? '',
    vehicleType: vehicle.vehicle_type ?? 'TRUCK',
    makeModel: vehicle.make_model ?? '',
    transporterName: vehicle.transporter_name ?? '',
    capacityKg: vehicle.capacity_kg ?? '',
    tareReferenceKg: vehicle.tare_reference_kg ?? '',
    isReefer: !!vehicle.is_reefer,
    fitnessExpiry: vehicle.fitness_expiry ?? '',
    insuranceExpiry: vehicle.insurance_expiry ?? '',
    pucExpiry: vehicle.puc_expiry ?? '',
    permitExpiry: vehicle.permit_expiry ?? '',
    status: vehicle.status ?? 'ACTIVE',
    statusReason: vehicle.status_reason ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  const set = (k: string, v: any) => setF({ ...f, [k]: v });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        regNo: f.regNo,
        vehicleType: f.vehicleType,
        makeModel: f.makeModel || null,
        transporterName: f.transporterName || null,
        capacityKg: f.capacityKg === '' ? null : Number(f.capacityKg),
        tareReferenceKg: f.tareReferenceKg === '' ? null : Number(f.tareReferenceKg),
        isReefer: f.isReefer,
        fitnessExpiry: f.fitnessExpiry || null,
        insuranceExpiry: f.insuranceExpiry || null,
        pucExpiry: f.pucExpiry || null,
        permitExpiry: f.permitExpiry || null,
        status: f.status,
        statusReason: f.statusReason || null,
      };
      const r: any = isNew
        ? await api.post('/masters/vehicles', payload)
        : await api.put(`/masters/vehicles/${vehicle.id}`, payload);
      onSaved(r.restored
        ? `${r.reg_no} was removed earlier — it is back on the list with its old history`
        : isNew ? `${r.reg_no} added` : `${r.reg_no} updated`, r);
    } catch (e: any) { setError(e); } finally { setBusy(false); }
  };

  return (
    <Modal title={isNew ? 'Add vehicle' : `Edit ${vehicle.reg_no}`} onClose={onClose} wide
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !f.regNo} onClick={save}>
          {busy ? 'Saving…' : isNew ? 'Add to list' : 'Save changes'}
        </button>
      </>}>
      <ErrorBanner error={error} />
      <div className="grid c2">
        <Field label="Vehicle number" hint="As painted on the truck">
          <input className="mono" style={{ textTransform: 'uppercase', fontWeight: 600 }}
            value={f.regNo} autoFocus placeholder="MH12AB1234"
            onChange={(e) => set('regNo', e.target.value.toUpperCase().replace(/\s/g, ''))} />
        </Field>
        <Field label="Type">
          <select value={f.vehicleType} onChange={(e) => set('vehicleType', e.target.value)}>
            {VEHICLE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
      </div>

      <div className="grid c2">
        <Field label="Make / model (optional)">
          <input value={f.makeModel} onChange={(e) => set('makeModel', e.target.value)}
            placeholder="Tata 407" />
        </Field>
        <Field label="Transporter (optional)">
          <input value={f.transporterName} onChange={(e) => set('transporterName', e.target.value)}
            placeholder="Self / transport company" />
        </Field>
      </div>

      <div className="grid c2">
        <Field label="Capacity (kg, optional)">
          <input type="number" step="1" value={f.capacityKg}
            onChange={(e) => set('capacityKg', e.target.value)} />
        </Field>
        <Field label="Reference tare (kg, optional)"
          hint="Empty weight — used only as a cross-check, never instead of the weighbridge">
          <input type="number" step="1" value={f.tareReferenceKg}
            onChange={(e) => set('tareReferenceKg', e.target.value)} />
        </Field>
      </div>

      <Field label="Refrigerated">
        <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={f.isReefer}
            onChange={(e) => set('isReefer', e.target.checked)} />
          This is a reefer vehicle
        </label>
      </Field>

      <div className="card-head" style={{ padding: '8px 0' }}><h3>Papers</h3></div>
      <p className="small muted mb">
        Left blank, nothing is checked. Filled in, the gate warns the moment a
        vehicle arrives with an expired document — it warns, it does not block,
        because a loaded truck standing outside is the bigger loss.
      </p>
      <div className="grid c2">
        <Field label="Fitness valid to">
          <input type="date" value={f.fitnessExpiry} onChange={(e) => set('fitnessExpiry', e.target.value)} />
        </Field>
        <Field label="Insurance valid to">
          <input type="date" value={f.insuranceExpiry} onChange={(e) => set('insuranceExpiry', e.target.value)} />
        </Field>
        <Field label="PUC valid to">
          <input type="date" value={f.pucExpiry} onChange={(e) => set('pucExpiry', e.target.value)} />
        </Field>
        <Field label="Permit valid to">
          <input type="date" value={f.permitExpiry} onChange={(e) => set('permitExpiry', e.target.value)} />
        </Field>
      </div>

      <div className="grid c2">
        <Field label="Standing">
          <select value={f.status} onChange={(e) => set('status', e.target.value)}>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Reason"
          hint={f.status === 'BLOCKED' ? 'A blocked vehicle is turned away at the gate' : 'Needed if not ACTIVE'}>
          <input value={f.statusReason} onChange={(e) => set('statusReason', e.target.value)}
            disabled={f.status === 'ACTIVE'} />
        </Field>
      </div>
    </Modal>
  );
}

/* ===================================================== DRIVERS =========== */
function DriversCard({ showRetired, manage }: { showRetired: boolean; manage: boolean }) {
  const toast = useToast();
  const { data, loading, error, reload } = useApi<any[]>(
    `/masters/drivers?includeRetired=${showRetired ? 1 : 0}`, [showRetired]);
  const [editing, setEditing] = useState<any>(null);
  const [retiring, setRetiring] = useState<any>(null);

  const restore = async (d: any) => {
    try {
      await api.post(`/masters/drivers/${d.id}/restore`);
      toast(`${d.full_name} is back on the list`, 'ok');
      reload();
    } catch (e: any) { toast(e.message, 'err'); }
  };

  return (
    <>
      <ErrorBanner error={error} />
      <div className="card">
        <div className="card-head">
          <h3>Drivers</h3>
          <div style={{ flex: 1 }} />
          {manage ? (
            <button className="btn primary" onClick={() => setEditing({})}>Add driver</button>
          ) : null}
        </div>
        <div className="card-body tight">
          <DataTable
            rows={data ?? []} loading={loading}
            rowTone={(d: any) => (!d.is_active ? undefined
              : d.status === 'BLOCKED' ? 'crit' : d.licence_expired ? 'warn' : undefined)}
            cols={[
              { key: 'n', head: 'Driver', render: (d: any) => (
                <div><b>{d.full_name}</b>
                  <div className="small muted mono">{d.phone ?? '—'}</div></div>
              ) },
              { key: 'dl', head: 'Licence', render: (d: any) => (
                <div><span className="mono small">{d.dl_number ?? '—'}</span>
                  <div className="small muted">
                    {d.dl_expiry ? `valid to ${date(d.dl_expiry)}` : 'no expiry recorded'}
                  </div></div>
              ) },
              { key: 'st', head: 'Status', render: (d: any) => (
                <div>
                  {d.is_active ? <Chip value={d.status} /> : <Chip tone="neutral">removed</Chip>}
                  {d.is_active && d.licence_expired
                    ? <div><Chip tone="warn">licence expired</Chip></div> : null}
                  {!d.is_active && d.retired_reason
                    ? <div className="small muted">{d.retired_reason}</div> : null}
                </div>
              ) },
              { key: 'c', head: 'Consent', render: (d: any) =>
                d.consent_obtained_at
                  ? <span className="small">✓ {date(d.consent_obtained_at)}</span>
                  : <span className="small muted">not recorded</span> },
              { key: 'a', head: '', width: 170, render: (d: any) => !manage ? null : (
                <div className="btn-row" onClick={(e) => e.stopPropagation()}>
                  {d.is_active ? (
                    <>
                      <button className="btn sm" onClick={() => setEditing(d)}>Edit</button>
                      <button className="btn sm danger" onClick={() => setRetiring(d)}>Remove</button>
                    </>
                  ) : (
                    <button className="btn sm" onClick={() => restore(d)}>Restore</button>
                  )}
                </div>
              ) },
            ]}
            empty={<Empty icon="🧑‍✈️" title="No drivers on the list"
              hint="Add the drivers who come regularly so the gate can pick a name instead of typing one." />}
          />
        </div>
      </div>

      {editing ? (
        <DriverModal driver={editing} onClose={() => setEditing(null)}
          onSaved={(msg) => { setEditing(null); toast(msg, 'ok'); reload(); }} />
      ) : null}

      {retiring ? (
        <RetireModal
          title={`Remove ${retiring.full_name}`}
          what="This driver leaves the gate dropdown. Gate entries he already signed keep his name."
          hint="e.g. left the company, changed transporter"
          onClose={() => setRetiring(null)}
          onConfirm={async (reason) => {
            await api.post(`/masters/drivers/${retiring.id}/retire`, { reason });
            setRetiring(null);
            toast(`${retiring.full_name} removed from the list`, 'ok');
            reload();
          }} />
      ) : null}
    </>
  );
}

export function DriverModal({ driver, onClose, onSaved }: {
  driver: any; onClose: () => void; onSaved: (msg: string, saved: any) => void;
}) {
  const isNew = !driver.id;
  const [f, setF] = useState<any>({
    fullName: driver.full_name ?? '',
    phone: driver.phone ?? '',
    dlNumber: driver.dl_number ?? '',
    dlExpiry: driver.dl_expiry ?? '',
    status: driver.status ?? 'ACTIVE',
    consentObtained: !!driver.consent_obtained_at,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  const { can } = useAuth();
  // Creating a login is an admin act, so only offer it to somebody who may.
  const mayInvite = can('admin.rbac.manage');
  const [saved, setSaved] = useState<any>(null);
  const set = (k: string, v: any) => setF({ ...f, [k]: v });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        fullName: f.fullName,
        phone: f.phone || null,
        dlNumber: f.dlNumber ? f.dlNumber.toUpperCase().replace(/\s/g, '') : null,
        dlExpiry: f.dlExpiry || null,
        status: f.status,
        consentObtained: f.consentObtained,
      };
      const r: any = isNew
        ? await api.post('/masters/drivers', payload)
        : await api.put(`/masters/drivers/${driver.id}`, payload);

      /* A driver who cannot see his own pickups is a phone call waiting to
       * happen. Offer the login here, while his name and number are still on
       * screen, rather than sending someone to People & Access to find him
       * again — which is why almost nobody used to get one. */
      if (mayInvite && !r.has_login) { setSaved(r); return; }

      onSaved(r.restored
        ? `${r.full_name} was removed earlier — back on the list with his old record`
        : isNew ? `${r.full_name} added` : `${r.full_name} updated`, r);
    } catch (e: any) { setError(e); } finally { setBusy(false); }
  };

  if (saved) {
    return (
      <DriverLoginStep driver={saved}
        onSkip={() => onSaved(`${saved.full_name} added`, saved)}
        onDone={(msg) => onSaved(msg, saved)} />
    );
  }

  return (
    <Modal title={isNew ? 'Add driver' : `Edit ${driver.full_name}`} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || f.fullName.trim().length < 2} onClick={save}>
          {busy ? 'Saving…' : isNew ? 'Add to list' : 'Save changes'}
        </button>
      </>}>
      <ErrorBanner error={error} />
      <div className="grid c2">
        <Field label="Name">
          <input value={f.fullName} autoFocus onChange={(e) => set('fullName', e.target.value)} />
        </Field>
        <Field label="Phone (optional)">
          <input className="mono" value={f.phone} placeholder="+9190000 00000"
            onChange={(e) => set('phone', e.target.value)} />
        </Field>
      </div>

      <div className="grid c2">
        <Field label="Licence number (optional)"
          hint="Recording it lets the same driver be restored later with his history">
          <input className="mono" style={{ textTransform: 'uppercase' }} value={f.dlNumber}
            onChange={(e) => set('dlNumber', e.target.value)} />
        </Field>
        <Field label="Licence valid to">
          <input type="date" value={f.dlExpiry} onChange={(e) => set('dlExpiry', e.target.value)} />
        </Field>
      </div>

      <Field label="Standing">
        <select value={f.status} onChange={(e) => set('status', e.target.value)}>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </Field>

      <Field label="Consent"
        hint="A licence number and phone are personal data. Tick only if the driver was told why you keep them.">
        <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={f.consentObtained}
            onChange={(e) => set('consentObtained', e.target.checked)} />
          Consent taken for storing these details
        </label>
      </Field>
    </Modal>
  );
}

/* ====================================================== SHARED =========== */
function RetireModal({ title, what, hint, onClose, onConfirm }: {
  title: string; what: string; hint: string;
  onClose: () => void; onConfirm: (reason?: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    try { await onConfirm(reason || undefined); }
    catch (e: any) { setError(e); setBusy(false); }
  };

  return (
    <Modal title={title} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn danger" disabled={busy} onClick={go}>
          {busy ? 'Removing…' : 'Remove from list'}
        </button>
      </>}>
      <ErrorBanner error={error} />
      <p className="small muted mb">{what}</p>
      <Field label="Reason (optional)" hint={hint}>
        <input value={reason} autoFocus onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Modal>
  );
}

/* ---------------------------------------------------------------------------
 *  The driver's own login, offered the moment he is added.
 *
 *  A pickup is only worth writing down if the person doing it can see it. This
 *  creates the account, links it to this driver row — which is the whole of
 *  what the driver portal scopes on — and hands back a link to send him.
 * ------------------------------------------------------------------------ */
export function DriverLoginStep({ driver, onSkip, onDone }: {
  driver: any; onSkip: () => void; onDone: (msg: string) => void;
}) {
  const toast = useToast();
  const { data: roles } = useApi<any[]>('/masters/roles');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  const [link, setLink] = useState<{ url: string; emailed: boolean } | null>(null);

  const driverRole = (roles ?? []).find((r) => r.code === 'DRIVER');

  const invite = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.post<any>('/masters/users/invite', {
        fullName: driver.full_name,
        email: email.trim().toLowerCase(),
        roleId: driverRole.id,
        driverId: driver.id,
      });
      setLink({ url: r.inviteUrl, emailed: !!r.emailed });
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  if (link) {
    return (
      <Modal title={`${driver.full_name} can now sign in`} onClose={() => onDone(`${driver.full_name} added and invited`)}
        footer={<button className="btn primary"
          onClick={() => onDone(`${driver.full_name} added and invited`)}>Done</button>}>
        <div className="banner ok mb">
          <span><Icon name="check" size={16} /></span>
          <div>
            {link.emailed
              ? <>The link has been emailed to <b>{email}</b>.</>
              : <>No mail server is configured, so <b>send him this link yourself</b>.</>}
            {' '}It works once and expires in 7 days.
          </div>
        </div>
        <Field label="His sign-in link">
          <div className="prefill">
            <input readOnly className="mono small" value={link.url}
              onFocus={(e) => e.currentTarget.select()} />
            <button className="btn sm" onClick={() => {
              navigator.clipboard?.writeText(link.url);
              toast('Link copied — paste it into WhatsApp or SMS', 'ok');
            }}>Copy</button>
          </div>
        </Field>
        <p className="small muted">
          Opening it lets him set a password. After that he sees only his own pickups —
          which order to collect, from whom, and where to deliver it.
        </p>
      </Modal>
    );
  }

  return (
    <Modal title={`Give ${driver.full_name} a login?`} onClose={onSkip}
      footer={<>
        <button className="btn" onClick={onSkip}>Not now</button>
        <button className="btn primary" disabled={busy || !email.includes('@') || !driverRole}
          onClick={invite}>{busy ? 'Creating…' : 'Create login & get link'}</button>
      </>}>
      <ErrorBanner error={error} />
      <p className="small muted mb">
        <b>{driver.full_name}</b> is on the list. With a login he can see the pickups assigned to
        him and mark each one collected and delivered, so the gate knows a vehicle is coming
        before it arrives.
      </p>
      <Field label="His email address"
        hint="Used only to sign in. You can also just copy the link and send it on WhatsApp.">
        <input value={email} autoFocus placeholder="driver@example.com"
          onChange={(e) => setEmail(e.target.value)} />
      </Field>
      {!driverRole ? (
        <div className="banner warn">
          <span><Icon name="alert" size={16} /></span>
          <div className="small">The Driver role is missing — run the migrations, then try again.</div>
        </div>
      ) : null}
    </Modal>
  );
}
