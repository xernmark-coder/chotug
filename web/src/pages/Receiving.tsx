import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, useAuth, inr, num, date, dateTime, ago, idempotencyKey, today } from '../lib/api';
import {
  AiBox, Chip, Col, DataTable, Empty, ErrorBanner, Field, Layout, Loading, Modal, Steps, useApi, useToast,
} from '../components/ui';
import { DriverModal, VehicleModal } from './Fleet';

/* ================================================= EXPECTED ARRIVALS ===== */
export function ArrivalsPage() {
  const nav = useNavigate();
  const { data, loading, error } = useApi<any[]>('/planning/expected-arrivals');

  return (
    <Layout title="Expected arrivals" subtitle="Vehicles we are waiting for"
      actions={<button className="btn primary" onClick={() => nav('/gate/new')}>Vehicle at gate</button>}>
      <ErrorBanner error={error} />
      <div className="card"><div className="card-body tight">
        <DataTable
          rows={data ?? []} loading={loading}
          rowTone={(a: any) => (a.overdue ? 'crit' : undefined)}
          onRowClick={(a: any) => nav(`/gate/new?poId=${a.po_id}`)}
          cols={[
            { key: 'd', head: 'Expected', render: (a: any) => (
              <div>{date(a.expected_date)}
                {a.overdue ? <div><Chip tone="danger">not arrived</Chip></div> : null}</div>
            ) },
            { key: 'po', head: 'Order', render: (a: any) => <b className="mono">{a.po_no}</b> },
            { key: 's', head: 'Supplier', render: (a: any) => (
              <div><b>{a.supplier_name}</b><div className="small muted">{a.source_type}</div></div>
            ) },
            { key: 'w', head: 'Warehouse', render: (a: any) => a.warehouse_name },
            { key: 'v', head: 'Vehicle hint', render: (a: any) => <span className="mono">{a.vehicle_hint ?? '—'}</span> },
            { key: 'l', head: 'Products', num: true, render: (a: any) => a.line_count },
            { key: 'val', head: 'Value', num: true, render: (a: any) => inr(a.grand_total, 0) },
            { key: 'go', head: '', width: 130, render: () => <span className="btn sm primary">Record arrival</span> },
          ]}
          empty={<Empty icon="🚛" title="No vehicles expected"
            hint="Confirm an approved purchase order to schedule an arrival." />}
        />
      </div></div>
    </Layout>
  );
}

/* ================================================ RECEIVING PIPELINE ===== */
export function GatePipelinePage() {
  const nav = useNavigate();
  const { warehouseId } = useAuth();
  const { data, loading, error, reload } = useApi<any[]>(
    `/receiving/pipeline?warehouseId=${warehouseId ?? ''}`, [warehouseId]);

  const stage = (g: any) =>
    g.status === 'ARRIVED' && !g.has_gross ? 0
    : g.status === 'ARRIVED' || g.status === 'WEIGHED' ? 1
    : g.status === 'QC_PENDING' ? 2
    : g.status === 'QC_COMPLETE' || g.status === 'GRN_PENDING' ? 3 : 4;

  const NEXT = ['Weigh in', 'Weigh out', 'Quality check', 'Post receipt', 'Done'];

  return (
    <Layout title="Gate &amp; receiving" subtitle="Every vehicle currently inside the chain" touch
      actions={
        <div className="btn-row">
          <button className="btn sm" onClick={reload}>Refresh</button>
          <button className="btn primary" onClick={() => nav('/gate/new')}>Vehicle at gate</button>
        </div>
      }>
      <ErrorBanner error={error} />
      <div className="card"><div className="card-body tight">
        <DataTable
          rows={data ?? []} loading={loading}
          rowTone={(g: any) => (g.critical_fail ? 'crit' : g.age_minutes > 180 ? 'warn' : undefined)}
          onRowClick={(g: any) => nav(`/gate/${g.gate_entry_id}`)}
          cols={[
            { key: 'v', head: 'Vehicle', render: (g: any) => (
              <div>
                <b className="mono" style={{ fontSize: 15 }}>{g.vehicle_reg_captured}</b>
                <div className="small muted">{g.gate_no}</div>
              </div>
            ) },
            { key: 's', head: 'Supplier', render: (g: any) => (
              <div>{g.supplier_name}{g.po_no ? <div className="small muted mono">{g.po_no}</div>
                : <div><Chip tone="warn">no order</Chip></div>}</div>
            ) },
            { key: 'st', head: 'Stage', render: (g: any) => <Chip value={g.status} /> },
            { key: 'next', head: 'Next step', render: (g: any) => <b>{NEXT[stage(g)]}</b> },
            { key: 'w', head: 'Weighed', render: (g: any) => (
              <span className="small">{g.has_gross ? '✓ gross' : '—'} {g.has_tare ? '· ✓ tare' : ''}</span>
            ) },
            { key: 'q', head: 'QC', num: true, render: (g: any) => g.qc_count || '—' },
            { key: 'a', head: 'Waiting', render: (g: any) => (
              <span className={g.age_minutes > 180 ? 'chip danger' : 'small muted'}>
                {Math.round(g.age_minutes)} min
              </span>
            ) },
            { key: 'f', head: '', render: (g: any) =>
              g.critical_fail ? <Chip tone="danger">hygiene fail</Chip>
                : g.is_unplanned ? <Chip tone="warn">unplanned</Chip> : null },
          ]}
          empty={<Empty icon="🛃" title="No vehicles at the gate"
            hint="Record an arrival when a truck reaches you." />}
        />
      </div></div>
    </Layout>
  );
}

/* ==================================================== GATE ENTRY ========= */
export function GateEntryPage() {
  const nav = useNavigate();
  const toast = useToast();
  const { branchId, warehouseId, can } = useAuth();
  const [sp] = useSearchParams();
  const poId = sp.get('poId');

  const { data: arrivals } = useApi<any[]>('/planning/expected-arrivals');
  const { data: suppliers } = useApi<any[]>('/masters/suppliers');
  const { data: vehicles, reload: reloadVehicles } = useApi<any[]>('/masters/vehicles');
  const { data: drivers, reload: reloadDrivers } = useApi<any[]>('/masters/drivers');
  /* A truck nobody has seen before is the normal case at a mandi gate, so the
   * master record is created from here rather than sending the gate clerk to
   * another screen while the vehicle waits. */
  const [addingVehicle, setAddingVehicle] = useState<any>(null);
  const [addingDriver, setAddingDriver] = useState<any>(null);

  const [form, setForm] = useState<any>({
    poId: poId ?? '', supplierId: '', sourceType: 'MANDI',
    vehicleRegCaptured: '', vehicleId: '', driverId: '', driverName: '', driverPhone: '',
    sealNo: '', sealIntact: true, ewayBillNo: '', supplierInvoiceRef: '', mandiPattiNo: '',
    exceptionReason: '', remarks: '',
  });
  const [checklist, setChecklist] = useState<Record<string, boolean>>({
    vehicle_clean: true, no_odour: true, no_pest: true,
    hygiene_ok: true, no_contamination: true, temp_ok: true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  const arrival = arrivals?.find((a) => a.po_id === form.poId);
  useEffect(() => {
    if (!arrival) return;
    const s = suppliers?.find((x) => x.trade_name === arrival.supplier_name);
    setForm((f: any) => ({
      ...f,
      supplierId: s?.id ?? f.supplierId,
      sourceType: arrival.source_type ?? f.sourceType,
      vehicleRegCaptured: f.vehicleRegCaptured || (arrival.vehicle_hint ?? ''),
    }));
  }, [arrival, suppliers]);

  const vehicle = vehicles?.find((v) => v.id === form.vehicleId);
  const isUnplanned = !form.poId;

  const submit = async (lockNow: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const g = await api.post<any>('/receiving/gate-entries', {
        branchId, warehouseId,
        poId: form.poId || null,
        expectedArrivalId: arrival?.id ?? null,
        supplierId: form.supplierId,
        sourceType: form.sourceType,
        vehicleRegCaptured: form.vehicleRegCaptured,
        vehicleId: form.vehicleId || null,
        driverId: form.driverId || null,
        driverName: form.driverName || undefined,
        driverPhone: form.driverPhone || undefined,
        sealNo: form.sealNo || undefined,
        sealIntact: form.sealIntact,
        ewayBillNo: form.ewayBillNo || undefined,
        supplierInvoiceRef: form.supplierInvoiceRef || undefined,
        mandiPattiNo: form.mandiPattiNo || undefined,
        checklistResult: checklist,
        exceptionReason: form.exceptionReason || undefined,
        remarks: form.remarks || undefined,
      });
      if (g.warnings?.length) toast(`Recorded with warnings: ${g.warnings.join(', ')}`, 'err');
      if (lockNow) {
        await api.post(`/receiving/gate-entries/${g.id}/submit`);
        toast(`${g.gate_no} locked — send the vehicle to the weighbridge`, 'ok');
      } else {
        toast(`${g.gate_no} saved`, 'ok');
      }
      nav(`/gate/${g.id}`);
    } catch (e: any) { setError(e); } finally { setBusy(false); }
  };

  const CHECKS: { key: string; label: string; critical?: boolean }[] = [
    { key: 'vehicle_clean', label: 'Vehicle body is clean' },
    { key: 'no_odour', label: 'No bad smell inside' },
    { key: 'no_pest', label: 'No pests or droppings' },
    { key: 'hygiene_ok', label: 'Overall hygiene acceptable', critical: true },
    { key: 'no_contamination', label: 'No chemicals or non-food cargo', critical: true },
    { key: 'temp_ok', label: 'Temperature acceptable (if reefer)' },
  ];

  return (
    <Layout title="Vehicle at gate" subtitle="Record the truck before anything is unloaded" touch>
      <ErrorBanner error={error} />
      <div className="grid sidebar-right">
        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>1 · Which delivery is this?</h2></div>
            <div className="card-body">
              <Field label="Purchase order" hint="Leave blank only if the vehicle arrived without an order">
                <select value={form.poId} onChange={(e) => setForm({ ...form, poId: e.target.value })}>
                  <option value="">— No purchase order (unplanned) —</option>
                  {(arrivals ?? []).map((a) => (
                    <option key={a.po_id} value={a.po_id}>
                      {a.po_no} · {a.supplier_name} · expected {date(a.expected_date)}
                    </option>
                  ))}
                </select>
              </Field>

              {isUnplanned ? (
                <>
                  <div className="banner warn mb">
                    <span>⚠</span>
                    <div>
                      An arrival without a purchase order is an exception. It needs a reason and a
                      supervisor's approval, and it is flagged in the audit trail.
                    </div>
                  </div>
                  <div className="grid c2">
                    <Field label="Supplier">
                      <select value={form.supplierId} onChange={(e) => {
                        const s = suppliers?.find((x) => x.id === e.target.value);
                        setForm({ ...form, supplierId: e.target.value, sourceType: s?.source_type ?? form.sourceType });
                      }}>
                        <option value="">Choose…</option>
                        {(suppliers ?? []).map((s) => (
                          <option key={s.id} value={s.id}>{s.trade_name ?? s.legal_name}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Reason for allowing entry">
                      <input value={form.exceptionReason}
                        onChange={(e) => setForm({ ...form, exceptionReason: e.target.value })}
                        placeholder="e.g. Verbal order from owner, mandi purchase" />
                    </Field>
                  </div>
                  {!can('receiving.exception.approve') ? (
                    <div className="banner danger">
                      <span>🔒</span>
                      <div>You cannot approve an unplanned arrival. Call a manager to the gate —
                        what you type here is kept.</div>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h2>2 · Vehicle &amp; driver</h2></div>
            <div className="card-body">
              <div className="grid c2">
                <Field label="Vehicle number" hint="As painted on the truck">
                  <input className="mono" style={{ textTransform: 'uppercase', fontSize: 18, fontWeight: 600 }}
                    value={form.vehicleRegCaptured}
                    onChange={(e) => {
                      const reg = e.target.value.toUpperCase().replace(/\s/g, '');
                      const known = vehicles?.find((v) => v.reg_no === reg);
                      setForm({ ...form, vehicleRegCaptured: reg, vehicleId: known?.id ?? '' });
                    }}
                    placeholder="MH12AB1234" />
                </Field>
                <Field label="Known vehicle">
                  <select value={form.vehicleId} onChange={(e) => {
                    const v = vehicles?.find((x) => x.id === e.target.value);
                    setForm({ ...form, vehicleId: e.target.value, vehicleRegCaptured: v?.reg_no ?? form.vehicleRegCaptured });
                  }}>
                    <option value="">Not in our list</option>
                    {(vehicles ?? []).map((v) => (
                      // A blocked vehicle is refused by the server, so offering
                      // it here would only produce a dead end at the gate.
                      <option key={v.id} value={v.id} disabled={v.status === 'BLOCKED'}>
                        {v.reg_no} — {v.vehicle_type}{v.status === 'BLOCKED' ? ' (blocked)' : ''}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              {/* Unknown registration and the rights to fix that — offer it. */}
              {form.vehicleRegCaptured && !form.vehicleId && can('master.vehicle.manage') ? (
                <div className="banner info mb">
                  <span>➕</span>
                  <div style={{ flex: 1 }}>
                    <b>{form.vehicleRegCaptured} is not on our list.</b>{' '}
                    You can receive it as it is. Add it and its fitness, insurance and
                    PUC dates get checked on every future arrival.
                  </div>
                  <button className="btn sm" type="button"
                    onClick={() => setAddingVehicle({ reg_no: form.vehicleRegCaptured })}>
                    Add to list
                  </button>
                </div>
              ) : null}

              {vehicle?.compliance_expired ? (
                <div className="banner warn mb">
                  <span>⚠</span>
                  <div>
                    <b>This vehicle has expired documents.</b>{' '}
                    {vehicle.fitness_expiry < today() ? 'Fitness. ' : ''}
                    {vehicle.insurance_expiry < today() ? 'Insurance. ' : ''}
                    {vehicle.puc_expiry < today() ? 'PUC. ' : ''}
                    You can still receive the goods, but it is recorded.
                  </div>
                </div>
              ) : null}

              <div className="grid c2">
                <Field label="Driver">
                  <select value={form.driverId} onChange={(e) => {
                    const d = drivers?.find((x) => x.id === e.target.value);
                    setForm({ ...form, driverId: e.target.value, driverName: d?.full_name ?? '', driverPhone: d?.phone ?? '' });
                  }}>
                    <option value="">Not in our list</option>
                    {(drivers ?? []).map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}
                  </select>
                </Field>
                <Field label="Driver name">
                  <input value={form.driverName} onChange={(e) => setForm({ ...form, driverName: e.target.value })} />
                </Field>
              </div>

              {form.driverName && !form.driverId && can('master.vehicle.manage') ? (
                <div className="banner info">
                  <span>➕</span>
                  <div style={{ flex: 1 }}>
                    <b>{form.driverName} is not on our list.</b>{' '}
                    Add him once and the gate can pick the name next time.
                  </div>
                  <button className="btn sm" type="button"
                    onClick={() => setAddingDriver({ full_name: form.driverName, phone: form.driverPhone })}>
                    Add to list
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h2>3 · Documents</h2></div>
            <div className="card-body">
              <div className="grid c2">
                <Field label="E-way bill number"><input value={form.ewayBillNo}
                  onChange={(e) => setForm({ ...form, ewayBillNo: e.target.value })} /></Field>
                <Field label="Supplier invoice / bill number"><input value={form.supplierInvoiceRef}
                  onChange={(e) => setForm({ ...form, supplierInvoiceRef: e.target.value })} /></Field>
                <Field label="Mandi patti number"><input value={form.mandiPattiNo}
                  onChange={(e) => setForm({ ...form, mandiPattiNo: e.target.value })} /></Field>
                <Field label="Seal number"><input value={form.sealNo}
                  onChange={(e) => setForm({ ...form, sealNo: e.target.value })} /></Field>
              </div>
              <label className="check">
                <input type="checkbox" checked={form.sealIntact}
                  onChange={(e) => setForm({ ...form, sealIntact: e.target.checked })} />
                Seal was intact on arrival
              </label>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h2>4 · Vehicle hygiene check</h2></div>
            <div className="card-body">
              <p className="small muted mb">
                Two of these are critical. Failing one stops unloading until the QC head clears it.
              </p>
              {CHECKS.map((c) => (
                <label className="check mb" key={c.key}>
                  <input type="checkbox" checked={checklist[c.key]}
                    onChange={(e) => setChecklist((s) => ({ ...s, [c.key]: e.target.checked }))} />
                  {c.label}
                  {c.critical ? <Chip tone="danger">critical</Chip> : null}
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>Ready?</h2></div>
            <div className="card-body">
              <p className="small muted">
                Submitting locks this record. After that it cannot be edited — only amended with a
                reason. That is what makes the weight and quality that follow trustworthy.
              </p>
              <Field label="Remarks">
                <textarea value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
              </Field>
              <div className="btn-row">
                <button className="btn primary block lg"
                  disabled={busy || !form.vehicleRegCaptured || !form.supplierId && !form.poId}
                  onClick={() => submit(true)}>
                  {busy ? 'Saving…' : 'Submit & lock'}
                </button>
                <button className="btn block" disabled={busy || !form.vehicleRegCaptured}
                  onClick={() => submit(false)}>Save without locking</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {addingVehicle ? (
        <VehicleModal vehicle={addingVehicle} onClose={() => setAddingVehicle(null)}
          onSaved={(msg, saved) => {
            setAddingVehicle(null);
            // Link the arrival being recorded to the record just created, so
            // this entry is already a checked vehicle rather than the next one.
            setForm((s: any) => ({ ...s, vehicleId: saved.id, vehicleRegCaptured: saved.reg_no }));
            reloadVehicles();
            toast(msg, 'ok');
          }} />
      ) : null}

      {addingDriver ? (
        <DriverModal driver={addingDriver} onClose={() => setAddingDriver(null)}
          onSaved={(msg, saved) => {
            setAddingDriver(null);
            setForm((s: any) => ({
              ...s, driverId: saved.id, driverName: saved.full_name, driverPhone: saved.phone ?? '',
            }));
            reloadDrivers();
            toast(msg, 'ok');
          }} />
      ) : null}
    </Layout>
  );
}

/* ================================================= GATE DETAIL =========== */
export function GateDetailPage() {
  const { id } = useParams();
  const toast = useToast();
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<any>(`/receiving/gate-entries/${id}`, [id]);
  const [tab, setTab] = useState<'weigh' | 'qc' | 'grn'>('weigh');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data) return;
    if (data.status === 'QC_PENDING') setTab('qc');
    else if (['QC_COMPLETE', 'GRN_PENDING'].includes(data.status)) setTab('grn');
  }, [data?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <Layout title="Gate entry"><Loading /></Layout>;
  if (!data) return <Layout title="Gate entry"><ErrorBanner error={error} /></Layout>;

  const stepIdx = ['ARRIVED', 'WEIGHED', 'QC_PENDING', 'QC_COMPLETE', 'COMPLETED'].indexOf(data.status);
  const lock = async () => {
    setBusy(true);
    try {
      await api.post(`/receiving/gate-entries/${id}/submit`);
      toast('Gate entry locked', 'ok');
      reload();
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <Layout title={`${data.vehicle_reg_captured}`} touch
      subtitle={`${data.gate_no} · ${data.supplier_name} ${data.po_no ? `· ${data.po_no}` : '· no order'}`}
      actions={
        <div className="btn-row">
          <Chip value={data.status} />
          {!data.locked_at && can('receiving.gate.submit') ? (
            <button className="btn primary" disabled={busy} onClick={lock}>Submit &amp; lock</button>
          ) : null}
        </div>
      }>
      <ErrorBanner error={error} />
      <Steps steps={['At gate', 'Weighed', 'Quality check', 'QC done', 'Received']}
        current={stepIdx < 0 ? 4 : stepIdx} />

      {data.critical_fail ? (
        <div className="banner danger mb">
          <span>🛑</span>
          <div><b>Hygiene check failed on a critical item.</b> Do not unload until the QC head clears it.</div>
        </div>
      ) : null}
      {!data.locked_at ? (
        <div className="banner warn mb">
          <span>🔓</span>
          <div>This entry is not locked yet. Weighment cannot start until you submit and lock it.</div>
        </div>
      ) : null}

      <div className="tabs">
        <button className={`tab ${tab === 'weigh' ? 'active' : ''}`} onClick={() => setTab('weigh')}>
          Weighment {data.weighments?.length ? `(${data.weighments.length})` : ''}
        </button>
        <button className={`tab ${tab === 'qc' ? 'active' : ''}`} onClick={() => setTab('qc')}>
          Quality check {data.inspections?.length ? `(${data.inspections.length})` : ''}
        </button>
        <button className={`tab ${tab === 'grn' ? 'active' : ''}`} onClick={() => setTab('grn')}>
          Post receipt
        </button>
      </div>

      {tab === 'weigh' ? <WeighTab gate={data} onDone={reload} /> : null}
      {tab === 'qc' ? <QcTab gate={data} onDone={reload} /> : null}
      {tab === 'grn' ? <GrnTab gate={data} onDone={reload} /> : null}
    </Layout>
  );
}

/* ---------------------------------------------------------- WEIGHMENT --- */
function WeighTab({ gate, onDone }: { gate: any; onDone: () => void }) {
  const toast = useToast();
  const { can } = useAuth();
  const { data: containers } = useApi<any[]>('/masters/container-types');
  const [form, setForm] = useState<any>({
    kind: 'GROSS', method: 'TWO_WEIGHMENT', grossKg: '', tareKg: '',
    containerTypeId: '', containerCount: '', packingTareKg: '',
    captureMode: 'MANUAL', reweighReason: '', varianceReasonCode: '',
  });
  const [busy, setBusy] = useState(false);

  const hasGross = gate.weighments?.some((w: any) => w.kind === 'GROSS');
  const hasTare = gate.weighments?.some((w: any) => w.kind === 'TARE');
  const latest = gate.weighments?.[gate.weighments.length - 1];

  useEffect(() => {
    setForm((f: any) => ({ ...f, kind: hasGross && !hasTare ? 'TARE' : hasGross && hasTare ? 'REWEIGH' : 'GROSS' }));
  }, [hasGross, hasTare]);

  const container = containers?.find((c) => c.id === form.containerTypeId);
  const previewNet = useMemo(() => {
    const gross = Number(form.grossKg) || (hasGross ? Number(gate.weighments.find((w: any) => w.kind === 'GROSS')?.gross_kg ?? 0) : 0);
    const tare = Number(form.tareKg) || (hasTare ? Number(gate.weighments.find((w: any) => w.kind === 'TARE')?.tare_kg ?? 0) : 0);
    const cont = (Number(form.containerCount) || 0) * (Number(container?.tare_kg) || 0);
    return Math.max(0, gross - tare - cont - (Number(form.packingTareKg) || 0));
  }, [form, container, gate, hasGross, hasTare]);

  const save = async () => {
    setBusy(true);
    try {
      const w = await api.post<any>(`/receiving/gate-entries/${gate.id}/weighments`, {
        kind: form.kind, method: form.method,
        grossKg: form.grossKg ? Number(form.grossKg) : null,
        tareKg: form.tareKg ? Number(form.tareKg) : null,
        containerTypeId: form.containerTypeId || null,
        containerCount: form.containerCount ? Number(form.containerCount) : null,
        packingTareKg: form.packingTareKg ? Number(form.packingTareKg) : null,
        captureMode: form.captureMode,
        reweighReason: form.reweighReason || null,
        varianceReasonCode: form.varianceReasonCode || null,
      });
      toast(w.cycleComplete
        ? `Net weight ${num(w.net_kg, 1)} kg recorded — send for quality check`
        : `${form.kind} weight recorded — now take the ${form.kind === 'GROSS' ? 'empty' : 'loaded'} weight`, 'ok');
      setForm((f: any) => ({ ...f, grossKg: '', tareKg: '', reweighReason: '' }));
      onDone();
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <div className="grid sidebar-right">
      <div className="card">
        <div className="card-head"><h2>Weighments taken</h2></div>
        <div className="card-body tight">
          <DataTable
            rows={gate.weighments ?? []}
            rowTone={(w: any) => (w.variance_band === 'CRITICAL' || w.variance_band === 'RED' ? 'crit'
              : w.variance_band === 'AMBER' ? 'warn' : undefined)}
            cols={[
              { key: 's', head: '#', width: 40, render: (w: any) => w.seq },
              { key: 'k', head: 'Type', render: (w: any) => <Chip tone="neutral">{w.kind}</Chip> },
              { key: 'g', head: 'Gross', num: true, render: (w: any) => w.gross_kg ? `${num(w.gross_kg, 1)} kg` : '—' },
              { key: 't', head: 'Tare', num: true, render: (w: any) => w.tare_kg ? `${num(w.tare_kg, 1)} kg` : '—' },
              { key: 'c', head: 'Containers', num: true, render: (w: any) =>
                w.container_count ? `${w.container_count} × ${num(w.container_tare_kg, 2)}` : '—' },
              { key: 'n', head: 'Net', num: true, render: (w: any) => w.net_kg ? <b>{num(w.net_kg, 1)} kg</b> : '—' },
              { key: 'e', head: 'Expected', num: true, render: (w: any) => w.expected_kg ? `${num(w.expected_kg, 1)}` : '—' },
              { key: 'v', head: 'Variance', num: true, render: (w: any) => w.variance_pct == null ? '—'
                : <Chip value={w.variance_band}>{num(w.variance_pct, 2)}%</Chip> },
              { key: 'm', head: 'Mode', render: (w: any) => <span className="small muted">{w.capture_mode}</span> },
              { key: 'w', head: 'By', render: (w: any) => <span className="small">{w.weighed_by_name}</span> },
            ]}
            empty={<Empty icon="⚖️" title="No weighment yet" hint="Take the loaded weight first." />}
          />
        </div>
      </div>

      {can('receiving.weighment.create') && gate.locked_at && gate.status !== 'COMPLETED' ? (
        <div className="card">
          <div className="card-head"><h2>Record weight</h2></div>
          <div className="card-body">
            <Field label="Which weight is this?">
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                <option value="GROSS">Loaded vehicle (gross)</option>
                <option value="TARE">Empty vehicle (tare)</option>
                <option value="REWEIGH">Re-weighment</option>
              </select>
            </Field>

            {form.kind === 'REWEIGH' ? (
              <Field label="Why re-weigh?" hint="The earlier reading stays on record">
                <input value={form.reweighReason}
                  onChange={(e) => setForm({ ...form, reweighReason: e.target.value })}
                  placeholder="e.g. Scale showed unstable reading" />
              </Field>
            ) : null}

            {form.kind !== 'TARE' ? (
              <Field label="Gross weight (kg)">
                <input type="number" style={{ fontSize: 22, fontWeight: 700 }} value={form.grossKg}
                  onChange={(e) => setForm({ ...form, grossKg: e.target.value })} />
              </Field>
            ) : null}
            {form.kind !== 'GROSS' ? (
              <Field label="Empty vehicle weight (kg)">
                <input type="number" style={{ fontSize: 22, fontWeight: 700 }} value={form.tareKg}
                  onChange={(e) => setForm({ ...form, tareKg: e.target.value })} />
              </Field>
            ) : null}

            <Field label="Crate / bag type" hint="Container tare is subtracted from the net weight">
              <select value={form.containerTypeId}
                onChange={(e) => setForm({ ...form, containerTypeId: e.target.value })}>
                <option value="">None — loose load</option>
                {(containers ?? []).map((c) => (
                  <option key={c.id} value={c.id}>{c.name} ({num(c.tare_kg, 2)} kg each)</option>
                ))}
              </select>
            </Field>
            {form.containerTypeId ? (
              <Field label="How many crates / bags?">
                <input type="number" value={form.containerCount}
                  onChange={(e) => setForm({ ...form, containerCount: e.target.value })} />
              </Field>
            ) : null}

            <Field label="How was this weight taken?">
              <select value={form.captureMode} onChange={(e) => setForm({ ...form, captureMode: e.target.value })}>
                <option value="MANUAL">Typed from the display</option>
                <option value="SCALE">Read directly from the weighbridge</option>
              </select>
            </Field>

            {previewNet > 0 ? (
              <div className="banner info mb">
                <span>⚖️</span>
                <div><b>Net weight will be {num(previewNet, 1)} kg</b>
                  {container ? <div className="small">after {form.containerCount || 0} × {num(container.tare_kg, 2)} kg container tare</div> : null}
                </div>
              </div>
            ) : null}

            <button className="btn primary block lg" disabled={busy || (!form.grossKg && !form.tareKg)}
              onClick={save}>{busy ? 'Saving…' : 'Record weight'}</button>
          </div>
        </div>
      ) : (
        <div className="card"><div className="card-body">
          <Empty icon="🔒" title={gate.locked_at ? 'Weighment closed' : 'Lock the gate entry first'}
            hint={gate.locked_at ? undefined : 'Weighment can only start on a locked gate entry.'} />
        </div></div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- QC ---- */
function QcTab({ gate, onDone }: { gate: any; onDone: () => void }) {
  const [product, setProduct] = useState<any>(null);
  const done = new Set((gate.inspections ?? []).map((i: any) => i.product_id));
  const lines = gate.poLines ?? [];

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><h2>Products to inspect</h2></div>
        <div className="card-body tight">
          <DataTable
            rows={lines}
            cols={[
              { key: 'p', head: 'Product', render: (l: any) => (
                <div><b>{l.product_name}</b><div className="small muted">{l.sku}</div></div>
              ) },
              { key: 'q', head: 'Ordered', num: true, render: (l: any) => `${num(l.qty, 0)} ${l.uom}` },
              { key: 'g', head: 'Expected grade', render: (l: any) => l.expected_grade ?? '—' },
              { key: 's', head: 'Status', render: (l: any) =>
                done.has(l.product_id) ? <Chip tone="ok">inspected</Chip> : <Chip tone="warn">pending</Chip> },
              { key: 'a', head: '', width: 140, render: (l: any) =>
                done.has(l.product_id) ? null : (
                  <button className="btn sm primary" onClick={() => setProduct(l)}>Inspect</button>
                ) },
            ]}
            empty={<Empty icon="🧪" title="No purchase order lines"
              hint="For an unplanned arrival, inspect from the product list." />}
          />
        </div>
      </div>

      {gate.inspections?.length ? (
        <div className="card">
          <div className="card-head"><h2>Completed inspections</h2></div>
          <div className="card-body tight">
            <DataTable
              rows={gate.inspections}
              rowTone={(i: any) => (i.overall_result === 'REJECT' || i.overall_result === 'HOLD' ? 'crit'
                : i.overall_result === 'PARTIAL' ? 'warn' : undefined)}
              cols={[
                { key: 'n', head: 'Number', render: (i: any) => <span className="mono small">{i.inspection_no}</span> },
                { key: 'p', head: 'Product', render: (i: any) => i.product_name },
                { key: 'r', head: 'Result', render: (i: any) => <Chip value={i.overall_result} /> },
                { key: 's', head: 'Score', num: true, render: (i: any) => num(i.quality_score, 0) },
                { key: 'g', head: 'Grade', render: (i: any) => <Chip tone="neutral">{i.assigned_grade ?? '—'}</Chip> },
                { key: 'a', head: 'Accepted', num: true, render: (i: any) => num(i.accepted_qty, 0) },
                { key: 'rj', head: 'Rejected', num: true, render: (i: any) =>
                  Number(i.rejected_qty) > 0 ? <b style={{ color: 'var(--danger)' }}>{num(i.rejected_qty, 0)}</b> : '—' },
                { key: 'i', head: 'Inspector', render: (i: any) => <span className="small">{i.inspector_name}</span> },
              ]}
            />
          </div>
        </div>
      ) : null}

      {product ? (
        <QcModal gate={gate} line={product} onClose={() => setProduct(null)}
          onDone={() => { setProduct(null); onDone(); }} />
      ) : null}
    </div>
  );
}

function QcModal({ gate, line, onClose, onDone }: {
  gate: any; line: any; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const { branchId } = useAuth();
  const { data: plan, loading } = useApi<any>(
    `/receiving/gate-entries/${gate.id}/qc-plan/${line.product_id}`, [line.product_id]);

  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [aiMeta, setAiMeta] = useState<Record<string, boolean>>({});
  const [received, setReceived] = useState<number>(Number(line.qty ?? 0));
  const [accepted, setAccepted] = useState<number>(Number(line.qty ?? 0));
  const [rejected, setRejected] = useState(0);
  const [hold, setHold] = useState(0);
  const [grade, setGrade] = useState('');
  const [reasons, setReasons] = useState<string[]>([]);
  const [overrideReason, setOverrideReason] = useState('');
  const [aiRun, setAiRun] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const net = gate.weighments?.find((w: any) => w.net_kg)?.net_kg;
    if (net) { setReceived(Number(net)); setAccepted(Number(net)); }
  }, [gate]);

  useEffect(() => { setAccepted(Math.max(0, received - rejected - hold)); }, [received, rejected, hold]);

  const criticalFailed = (plan?.parameters ?? []).filter((p: any) => {
    if (!p.is_critical) return false;
    const a = answers[p.code];
    if (p.param_type === 'BOOLEAN') return a === true;
    return false;
  });

  const runPhotoAssist = async (files: FileList | null) => {
    if (!files?.length) return;
    const images = await Promise.all(Array.from(files).slice(0, 3).map(async (f) => ({
      mediaType: f.type,
      base64: await new Promise<string>((res) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(',')[1]);
        r.readAsDataURL(f);
      }),
    })));
    try {
      const r = await api.post<any>('/receiving/qc/photo-assist', {
        branchId, productId: line.product_id, templateId: plan.template.id, images,
      });
      setAiRun(r);
      const next = { ...answers };
      const meta: Record<string, boolean> = {};
      for (const s of r.suggestions ?? []) {
        if (s.value === null || s.value === undefined) continue;
        next[s.code] = s.value;
        meta[s.code] = true;
      }
      setAnswers(next);
      setAiMeta(meta);
      if (r.grade) setGrade(r.grade);
      toast(r.usedFallback
        ? 'No AI model is configured — fill the checklist manually'
        : `AI filled ${Object.keys(meta).length} field(s). Please confirm each one.`,
        r.usedFallback ? 'err' : 'ok');
    } catch (e: any) { toast(e.message, 'err'); }
  };

  /* Optional split of one load into graded groups. Empty means the whole line
   * carries one verdict, which is what most deliveries need. */
  const [groups, setGroups] = useState<any[]>([]);
  const groupSum = (d: string) => groups
    .filter((g) => g.disposition === d)
    .reduce((a, g) => a + (Number(g.qty) || 0), 0);
  const groupsBalance = !groups.length
    || (Math.abs(groupSum('ACCEPT') - accepted) < 0.001
      && Math.abs(groupSum('REJECT') - rejected) < 0.001
      && Math.abs(groupSum('HOLD') - hold) < 0.001);

  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/receiving/gate-entries/${gate.id}/inspections`, {
        productId: line.product_id,
        poLineId: line.id ?? null,
        templateId: plan.template.id,
        receivedQty: received,
        lotSize: plan.lotQty || received,
        sampleSize: plan.sampleSize,
        samplingNote: plan.samplingNote,
        expectedGrade: line.expected_grade ?? null,
        answers: (plan.parameters ?? []).map((p: any) => ({
          code: p.code,
          valueNum: ['NUMERIC', 'PERCENT', 'COUNT'].includes(p.param_type)
            ? (answers[p.code] === undefined || answers[p.code] === '' ? null : Number(answers[p.code])) : null,
          valueBool: p.param_type === 'BOOLEAN' ? !!answers[p.code] : null,
          valueText: ['SELECT', 'TEXT'].includes(p.param_type) ? (answers[p.code] ?? null) : null,
          aiPrefilled: !!aiMeta[p.code],
          inspectorChanged: !!aiMeta[p.code] && answers[p.code] !== undefined,
        })),
        acceptedQty: accepted, rejectedQty: rejected, holdQty: hold,
        assignedGrade: grade || null,
        rejectionReasonCodes: reasons,
        aiRunId: aiRun?.aiRunId ?? null,
        overrideReason: overrideReason || null,
        grades: groups.length ? groups.map((g) => ({
          label: g.label || undefined,
          grade: g.grade,
          containerCount: g.containerCount ? Number(g.containerCount) : null,
          qty: Number(g.qty),
          disposition: g.disposition,
          reasonCode: g.reasonCode || null,
          priceFactorPct: Number(g.priceFactorPct ?? 100),
        })) : undefined,
      });
      toast('Quality check saved', 'ok');
      onDone();
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const REJECT_REASONS = ['ROT', 'OVERRIPE', 'UNDERRIPE', 'DAMAGE', 'UNDERSIZE',
    'FOREIGN_MATTER', 'WET', 'PEST', 'WRONG_VARIETY', 'TEMPERATURE_ABUSE'];

  /* The grading panel. Kept out of the way until someone asks for it: most
   * loads are one grade, and a table of empty rows on every inspection is
   * noise. */
  const gradePanel = (
    <div className="card mt">
      <div className="card-head">
        <h2>Grade it in groups</h2>
        <span className="muted small">
          {groups.length
            ? `${groupSum('ACCEPT')} accepted · ${groupSum('REJECT')} rejected · ${groupSum('HOLD')} held`
            : 'optional — for when one load is not one quality'}
        </span>
        <button className="btn sm" onClick={() => setGroups((g) => [...g, {
          label: '', grade: grade || 'A', containerCount: '', qty: '',
          disposition: 'ACCEPT', reasonCode: '', priceFactorPct: 100,
        }])}>Add a group</button>
      </div>
      {groups.length ? (
        <div className="card-body tight">
          <div className="table-wrap">
            <table className="data">
              <thead><tr>
                <th>Which crates</th><th style={{ width: 80 }}>Grade</th>
                <th className="num" style={{ width: 90 }}>Crates</th>
                <th className="num" style={{ width: 100 }}>Quantity</th>
                <th style={{ width: 120 }}>What happens</th>
                <th className="num" style={{ width: 100 }}>% of rate</th>
                <th style={{ width: 44 }}></th>
              </tr></thead>
              <tbody>
                {groups.map((g, i) => {
                  const set = (p: any) => setGroups((s2) => s2.map((x, j) => j === i ? { ...x, ...p } : x));
                  return (
                    <tr key={i}>
                      <td>
                        <input className="inline" value={g.label} placeholder="top layer"
                          onChange={(e) => set({ label: e.target.value })} />
                        {g.disposition === 'REJECT' ? (
                          <select className="mt" value={g.reasonCode}
                            onChange={(e) => set({ reasonCode: e.target.value })}>
                            <option value="">Why rejected…</option>
                            {REJECT_REASONS.map((r) => <option key={r} value={r}>{r.replace(/_/g, ' ').toLowerCase()}</option>)}
                          </select>
                        ) : null}
                      </td>
                      <td>
                        <input className="inline" style={{ width: 60 }} value={g.grade}
                          onChange={(e) => set({ grade: e.target.value })} />
                      </td>
                      <td className="num">
                        <input className="inline num" style={{ width: 74 }} type="number" value={g.containerCount}
                          onChange={(e) => set({ containerCount: e.target.value })} />
                      </td>
                      <td className="num">
                        <input className="inline num" style={{ width: 84 }} type="number" value={g.qty}
                          onChange={(e) => set({ qty: e.target.value })} />
                      </td>
                      <td>
                        <select value={g.disposition} onChange={(e) => set({ disposition: e.target.value })}>
                          <option value="ACCEPT">Take it</option>
                          <option value="REJECT">Send back</option>
                          <option value="HOLD">Hold</option>
                        </select>
                      </td>
                      <td className="num">
                        <input className="inline num" style={{ width: 76 }} type="number" value={g.priceFactorPct}
                          onChange={(e) => set({ priceFactorPct: e.target.value })} />
                      </td>
                      <td>
                        <button className="btn sm ghost"
                          onClick={() => setGroups((s2) => s2.filter((_, j) => j !== i))}>✕</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!groupsBalance ? (
            <div className="banner danger" style={{ margin: 12 }}>
              <span>⚠</span>
              <div>
                <b>The groups do not add up to the totals above.</b>
                <div className="small">
                  Groups say {groupSum('ACCEPT')} accepted, {groupSum('REJECT')} rejected,
                  {' '}{groupSum('HOLD')} held — the totals say {accepted}, {rejected}, {hold}.
                </div>
              </div>
            </div>
          ) : (
            <div className="chart-hint" style={{ padding: '0 12px 12px' }}>
              A group at less than 100% of rate is the price you actually agreed for those
              crates. It is recorded against the delivery, not negotiated again later.
            </div>
          )}
        </div>
      ) : null}
    </div>
  );


  return (
    <Modal title={`Quality check — ${line.product_name}`} onClose={onClose} wide
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || loading || !groupsBalance || (criticalFailed.length > 0 && accepted > 0 && !overrideReason)}
          onClick={save}>{busy ? 'Saving…' : 'Save inspection'}</button>
      </>}>
      {loading ? <Loading /> : !plan ? <Empty title="No QC template for this product" /> : (
        <div className="stack">
          <div className="banner info">
            <span>🔬</span>
            <div>{plan.samplingNote}</div>
          </div>

          <div>
            <label className="btn" style={{ cursor: 'pointer' }}>
              📷 Take photos and let AI pre-fill
              <input type="file" accept="image/*" multiple capture="environment"
                style={{ display: 'none' }}
                onChange={(e) => runPhotoAssist(e.target.files)} />
            </label>
            {aiRun ? (
              <div className="small muted mt">
                {aiRun.usedFallback
                  ? 'AI is not configured — this is a manual inspection.'
                  : `AI confidence ${Math.round((aiRun.confidence ?? 0) * 100)}%. Every value below still needs your confirmation.`}
              </div>
            ) : null}
          </div>

          <div className="card"><div className="card-body">
            {(plan.parameters ?? []).map((p: any) => (
              <div className="field" key={p.code}>
                <label>
                  {p.label}
                  {p.is_critical ? <Chip tone="danger">critical</Chip> : null}
                  {aiMeta[p.code] ? <Chip tone="primary">AI filled — confirm</Chip> : null}
                  {p.unit ? <span className="muted small"> ({p.unit})</span> : null}
                </label>
                {p.param_type === 'BOOLEAN' ? (
                  <div className="btn-row">
                    <button className={`btn ${answers[p.code] === false ? 'primary' : ''}`}
                      onClick={() => setAnswers((s) => ({ ...s, [p.code]: false }))}>No</button>
                    <button className={`btn ${answers[p.code] === true ? 'danger' : ''}`}
                      onClick={() => setAnswers((s) => ({ ...s, [p.code]: true }))}>Yes</button>
                  </div>
                ) : p.param_type === 'SELECT' ? (
                  <div className="btn-row">
                    {(p.options ?? []).map((o: any) => (
                      <button key={o.value} className={`btn ${answers[p.code] === o.value ? 'primary' : ''}`}
                        onClick={() => setAnswers((s) => ({ ...s, [p.code]: o.value }))}>{o.label}</button>
                    ))}
                  </div>
                ) : (
                  <input type="number" value={answers[p.code] ?? ''}
                    placeholder={p.min_ok != null || p.max_ok != null
                      ? `Acceptable: ${p.min_ok ?? '0'} – ${p.max_ok ?? '∞'}` : ''}
                    onChange={(e) => setAnswers((s) => ({ ...s, [p.code]: e.target.value }))} />
                )}
                {p.help_text ? <div className="hint">{p.help_text}</div> : null}
              </div>
            ))}
          </div></div>

          {criticalFailed.length ? (
            <div className="banner danger">
              <span>🛑</span>
              <div><b>A critical parameter failed.</b> Accepting any quantity needs a written reason
                and goes to the QC head for approval.</div>
            </div>
          ) : null}

          <div className="card">
            <div className="card-head"><h3>Decision</h3></div>
            <div className="card-body">
              <div className="grid c4">
                <Field label="Received"><input type="number" value={received}
                  onChange={(e) => setReceived(Number(e.target.value))} /></Field>
                <Field label="Rejected"><input type="number" value={rejected}
                  onChange={(e) => setRejected(Number(e.target.value))} /></Field>
                <Field label="On hold"><input type="number" value={hold}
                  onChange={(e) => setHold(Number(e.target.value))} /></Field>
                <Field label="Accepted"><input type="number" readOnly value={accepted} /></Field>
              </div>
              <div className="grid c2">
                <Field label="Grade given">
                  <select value={grade} onChange={(e) => setGrade(e.target.value)}>
                    <option value="">Choose…</option>
                    {(plan.product.gradesAllowed ?? ['A', 'B', 'C']).map((g: string) =>
                      <option key={g} value={g}>{g}</option>)}
                  </select>
                </Field>
                {rejected > 0 ? (
                  <Field label="Rejection reasons">
                    <select multiple value={reasons} style={{ height: 92 }}
                      onChange={(e) => setReasons(Array.from(e.target.selectedOptions, (o) => o.value))}>
                      {REJECT_REASONS.map((r) => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
                    </select>
                  </Field>
                ) : null}
              </div>
              {criticalFailed.length && accepted > 0 ? (
                <Field label="Reason for accepting despite a critical failure">
                  <textarea value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
                </Field>
              ) : null}
            </div>
          </div>

          {gradePanel}
        </div>
      )}
    </Modal>
  );
}

/* --------------------------------------------------------------- GRN ---- */
function GrnTab({ gate, onDone }: { gate: any; onDone: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const { data: containers } = useApi<any[]>('/masters/container-types');
  const [idemKey] = useState(() => idempotencyKey('grn'));
  const [busy, setBusy] = useState(false);

  const [lines, setLines] = useState<any[]>([]);
  useEffect(() => {
    const netTotal = Number(gate.weighments?.find((w: any) => w.net_kg)?.net_kg ?? 0);
    const insByProduct = new Map((gate.inspections ?? []).map((i: any) => [i.product_id, i]));
    const src = (gate.poLines ?? []).length ? gate.poLines : (gate.inspections ?? []).map((i: any) => ({
      product_id: i.product_id, product_name: i.product_name, sku: i.sku,
      uom: 'KG', qty: i.received_qty, rate: 0, id: null,
    }));
    setLines(src.map((l: any) => {
      const ins: any = insByProduct.get(l.product_id);
      return {
        poLineId: l.id ?? null,
        qcInspectionId: ins?.id ?? null,
        productId: l.product_id, name: l.product_name, sku: l.sku,
        uom: l.uom ?? 'KG',
        receivedQty: Number(ins?.received_qty ?? l.qty ?? 0),
        acceptedQty: Number(ins?.accepted_qty ?? l.qty ?? 0),
        rejectedQty: Number(ins?.rejected_qty ?? 0),
        holdQty: Number(ins?.hold_qty ?? 0),
        netWeightKg: src.length === 1 ? netTotal : null,
        rate: Number(l.rate ?? 0),
        grade: ins?.assigned_grade ?? l.expected_grade ?? null,
        rejectionReasonCode: Number(ins?.rejected_qty ?? 0) > 0
          ? (ins?.rejection_reason_codes?.[0] ?? 'DAMAGE') : null,
        rejectionAction: Number(ins?.rejected_qty ?? 0) > 0 ? 'RETURN' : null,
        containerTypeId: null, containerCount: null, crateLabels: 0,
      };
    }));
  }, [gate]);

  const post = async () => {
    setBusy(true);
    try {
      const r = await api.post<any>(`/receiving/gate-entries/${gate.id}/grn`, {
        idempotencyKey: idemKey,
        postingDate: today(),
        lines: lines.map((l) => ({
          poLineId: l.poLineId, qcInspectionId: l.qcInspectionId, productId: l.productId,
          uom: l.uom, receivedQty: l.receivedQty, acceptedQty: l.acceptedQty,
          rejectedQty: l.rejectedQty, holdQty: l.holdQty,
          netWeightKg: l.netWeightKg ? Number(l.netWeightKg) : null,
          containerTypeId: l.containerTypeId || null,
          containerCount: l.containerCount ? Number(l.containerCount) : null,
          rate: Number(l.rate), grade: l.grade,
          rejectionReasonCode: l.rejectedQty > 0 ? l.rejectionReasonCode : null,
          rejectionAction: l.rejectedQty > 0 ? l.rejectionAction : null,
          crateLabels: Number(l.crateLabels) || 0,
        })),
      });
      toast(r.message, 'ok');
      onDone();
      nav(`/grns/${r.id}`);
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const totalValue = lines.reduce((a, l) => a + l.acceptedQty * l.rate, 0);
  const ready = ['QC_COMPLETE', 'GRN_PENDING'].includes(gate.status);
  const posted = gate.grns?.some((g: any) => g.status === 'POSTED');

  if (posted) {
    return (
      <div className="card"><div className="card-body">
        <Empty icon="✅" title="Stock already posted for this vehicle"
          action={<button className="btn primary" onClick={() => nav(`/grns/${gate.grns[0].id}`)}>
            Open {gate.grns[0].grn_no}</button>} />
      </div></div>
    );
  }

  return (
    <div className="stack">
      {!ready ? (
        <div className="banner warn">
          <span>⚠</span>
          <div>Quality check is not complete for this vehicle. Posting now needs an authorised exception.</div>
        </div>
      ) : null}

      <div className="card">
        <div className="card-head"><h2>What is entering stock</h2></div>
        <div className="card-body tight">
          <div className="table-wrap">
            <table className="data">
              <thead><tr>
                <th>Product</th><th className="num">Received</th><th className="num">Accepted</th>
                <th className="num">Rejected</th><th className="num">Net kg</th><th className="num">Rate</th>
                <th>Grade</th><th className="num">Crate labels</th><th className="num">Value</th>
              </tr></thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.productId}>
                    <td><b>{l.name}</b><div className="small muted">{l.sku}</div></td>
                    <td className="num mono">{num(l.receivedQty, 0)}</td>
                    <td className="num"><input className="inline num" style={{ width: 74 }} type="number"
                      value={l.acceptedQty}
                      onChange={(e) => setLines((s) => s.map((x, j) => j === i ? { ...x, acceptedQty: Number(e.target.value) } : x))} /></td>
                    <td className="num"><input className="inline num" style={{ width: 68 }} type="number"
                      value={l.rejectedQty}
                      onChange={(e) => setLines((s) => s.map((x, j) => j === i ? { ...x, rejectedQty: Number(e.target.value) } : x))} /></td>
                    <td className="num"><input className="inline num" style={{ width: 82 }} type="number"
                      value={l.netWeightKg ?? ''} placeholder="—"
                      onChange={(e) => setLines((s) => s.map((x, j) => j === i ? { ...x, netWeightKg: e.target.value } : x))} /></td>
                    <td className="num"><input className="inline num" style={{ width: 78 }} type="number"
                      value={l.rate}
                      onChange={(e) => setLines((s) => s.map((x, j) => j === i ? { ...x, rate: Number(e.target.value) } : x))} /></td>
                    <td>
                      <select className="inline" style={{ width: 68 }} value={l.grade ?? ''}
                        onChange={(e) => setLines((s) => s.map((x, j) => j === i ? { ...x, grade: e.target.value } : x))}>
                        <option value="">—</option>{['A', 'B', 'C'].map((g) => <option key={g}>{g}</option>)}
                      </select>
                    </td>
                    <td className="num"><input className="inline num" style={{ width: 62 }} type="number"
                      value={l.crateLabels}
                      onChange={(e) => setLines((s) => s.map((x, j) => j === i ? { ...x, crateLabels: e.target.value } : x))} /></td>
                    <td className="num mono"><b>{inr(l.acceptedQty * l.rate)}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-body">
          <div className="row wrap">
            <div>
              <div className="small muted">Total value entering stock</div>
              <div style={{ fontSize: 24, fontWeight: 700 }}>{inr(totalValue)}</div>
            </div>
            <div className="spacer" />
            {can('receiving.grn.submit') ? (
              <button className="btn primary lg" disabled={busy || !lines.length} onClick={post}>
                {busy ? 'Posting…' : 'Post receipt to stock'}
              </button>
            ) : (
              <div className="banner warn"><span>🔒</span><div>Your role cannot post stock.</div></div>
            )}
          </div>
          <p className="small muted mt">
            Posting creates batches, prints labels, updates stock and closes the purchase order line —
            all at once. It cannot be undone by editing; only by a reversal with a reason.
          </p>
        </div>
      </div>
    </div>
  );
}
