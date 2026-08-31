import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, useAuth, inr, num, date, ago } from '../lib/api';
import {
  Chip, DataTable, Empty, ErrorBanner, Field, Kpi, Layout, Loading, Modal, useApi, useToast,
  FilterBar, FilterTotals, useFilters,
} from '../components/ui';
import { Icon } from '../components/icons';

/* NOTE ON FIELD NAMES
 * /receiving/pipeline reads from v_receiving_pipeline, whose key is
 * `gate_entry_id` and whose plate is `vehicle_reg_captured` — not `id` and
 * `vehicle_no`. Getting that wrong posted to /gate-entries/undefined/weighments
 * and 500'd on a uuid cast, so the names here match the view exactly.
 */

/* ===========================================================================
 * WAREHOUSE INTAKE
 *
 * The first physical step: a vehicle is at the door, somebody weighs what is
 * on it and counts the crates, and it moves on to the quality check.
 *
 * This used to live inside the gate screen, mixed in with paperwork the
 * warehouse never touches. It is its own panel because it is its own person's
 * whole job — and because counting crates and reading a weighbridge are done
 * standing up, on a tablet, with gloves on.
 * ======================================================================== */

const STAGE: Record<string, { label: string; tone: 'warn' | 'primary' | 'ok' | 'danger' }> = {
  ARRIVED:      { label: 'Waiting to be weighed', tone: 'warn' },
  WEIGHED:      { label: 'Weighed', tone: 'primary' },
  QC_PENDING:   { label: 'With quality', tone: 'primary' },
  QC_COMPLETE:  { label: 'Quality done', tone: 'ok' },
  GRN_PENDING:  { label: 'Ready to book in', tone: 'warn' },
  COMPLETED:    { label: 'Booked in', tone: 'ok' },
};

/* The chain, in the order it actually happens. Sorting the Stage column reads
   this rather than the label, because the labels are English sentences and
   English sentences do not sort into a workflow. */
const STAGE_ORDER = ['ARRIVED', 'WEIGHED', 'QC_PENDING', 'QC_COMPLETE',
  'GRN_PENDING', 'COMPLETED', 'REJECTED_AT_GATE'];

export function WarehouseIntakePage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<any[]>('/receiving/pipeline');
  const [weighing, setWeighing] = useState<any>(null);

  const rows = data ?? [];
  const waiting = rows.filter((g: any) => g.status === 'ARRIVED');
  const withQc = rows.filter((g: any) => ['WEIGHED', 'QC_PENDING'].includes(g.status));
  const toBook = rows.filter((g: any) => ['QC_COMPLETE', 'GRN_PENDING'].includes(g.status));

  const f = useFilters<any>(rows, {
    date: (g: any) => g.arrived_at,
    search: (g: any) => [g.vehicle_reg_captured, g.gate_no, g.supplier_name, g.po_no]
      .filter(Boolean).join(' '),
    facets: [
      { key: 'sup', label: 'supplier', of: (g: any) => g.supplier_name },
      { key: 'st', label: 'stage', of: (g: any) => STAGE[g.status]?.label ?? g.status },
      { key: 'veh', label: 'vehicle', of: (g: any) => g.vehicle_reg_captured },
    ],
    totals: [
      { label: 'Net kg', of: (g: any) => Number(g.net_kg ?? 0), decimals: 1 },
    ],
  });

  return (
    <Layout
      title="Warehouse intake"
      subtitle="Weigh what arrived, count the crates, hand it to quality"
      touch
    >
      <ErrorBanner error={error} />

      <div className="grid c4 mb">
        <Kpi label="At the door" value={num(waiting.length, 0)}
          tone={waiting.length ? 'warn' : undefined}
          foot="waiting to be weighed" />
        <Kpi label="With quality" value={num(withQc.length, 0)} foot="weighed, being checked" />
        <Kpi label="Ready to book in" value={num(toBook.length, 0)}
          tone={toBook.length ? 'warn' : undefined} foot="quality done" />
        <Kpi label="On site" value={num(rows.length, 0)} foot="vehicles in the yard" />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Vehicles in the yard</h2>
          <button className="btn sm" onClick={reload}>Refresh</button>
        </div>
        <div className="card-body tight">
          <FilterBar f={f} placeholder="Search vehicle, gate pass, supplier" />
          <FilterTotals f={f} noun="vehicle" />
          <DataTable
            loading={loading}
            rows={f.rows}
            rowTone={(g: any) => (g.status === 'ARRIVED' ? 'warn' : undefined)}
            cols={[
              { key: 'v', head: 'Vehicle', sort: (g: any) => g.vehicle_reg_captured, render: (g: any) => (
                <div>
                  <b className="mono">{g.vehicle_reg_captured ?? '—'}</b>
                  <div className="small muted">{g.gate_no}{g.supplier_name ? ` · ${g.supplier_name}` : ''}</div>
                </div>
              ) },
              /* Sorts on the raw age in minutes, not on the words "3h ago" —
                 which would order 9h before 3h because that is how strings
                 compare. Longest wait first, which is the order the yard is
                 actually worked in. */
              { key: 'w', head: 'Waiting', desc: true,
                sort: (g: any) => Number(g.age_minutes) || 0, render: (g: any) => (
                <span className="small">{g.arrived_at ? ago(g.arrived_at) : '—'}</span>
              ) },
              /* Where the load is standing while quality look at it. Before
                 this there was no answer to "which bay is gate 41 in" except
                 asking whoever carried it. */
              { key: 'bay', head: 'In QC bay', sort: (g: any) => g.qc_bay_code, render: (g: any) => (
                g.qc_bay_code
                  ? <div><b className="mono">{g.qc_bay_code}</b>
                      <div className="small muted">{g.qc_parked_at ? ago(g.qc_parked_at) : ''}</div></div>
                  : <span className="muted small">—</span>
              ) },
              { key: 'r', head: 'Readings', render: (g: any) => (
                <div className="small">
                  <Chip tone={g.has_gross ? 'ok' : 'neutral'}>
                    {g.has_gross ? <Icon name="check" size={12} /> : null} gross
                  </Chip>
                  {' '}
                  <Chip tone={g.has_tare ? 'ok' : 'neutral'}>
                    {g.has_tare ? <Icon name="check" size={12} /> : null} tare
                  </Chip>
                </div>
              ) },
              { key: 's', head: 'Stage',
                /* Sorted by where it is in the chain, not alphabetically —
                   "Booked in" before "Waiting to be weighed" is no use to
                   anybody standing in the yard. */
                sort: (g: any) => STAGE_ORDER.indexOf(g.status), render: (g: any) => {
                const st = STAGE[g.status] ?? { label: g.status, tone: 'neutral' as const };
                return <Chip tone={st.tone as any}>{st.label}</Chip>;
              } },
              { key: 'a', head: '', width: 330, render: (g: any) => (
                <div className="btn-row">
                  {!['COMPLETED', 'REJECTED_AT_GATE'].includes(g.status)
                    && !(g.has_gross && g.has_tare) && can('receiving.weighment.create') ? (
                    <button className="btn sm primary" onClick={() => setWeighing(g)}>
                      {g.has_gross ? 'Tare weight' : 'Weigh in'}
                    </button>
                  ) : null}
                  {/* The weighbridge weighs the lorry; this weighs what comes
                      off it. On a mixed load it is the only way to know how
                      much of each product actually arrived. */}
                  {!['REJECTED_AT_GATE'].includes(g.status) && can('receiving.box.weigh') ? (
                    <button className="btn sm" onClick={() => nav(`/unload/${g.gate_entry_id}`)}>
                      Weigh boxes
                    </button>
                  ) : null}
                  {['WEIGHED', 'QC_PENDING'].includes(g.status) ? (
                    <button className="btn sm" onClick={() => nav(`/gate/${g.gate_entry_id}`)}>Quality check →</button>
                  ) : null}
                  {['QC_COMPLETE', 'GRN_PENDING'].includes(g.status) ? (
                    <button className="btn sm primary" onClick={() => nav(`/gate/${g.gate_entry_id}`)}>Book in →</button>
                  ) : null}
                  <button className="btn sm ghost" onClick={() => nav(`/gate/${g.gate_entry_id}`)}>Open</button>
                </div>
              ) },
            ]}
            empty={<Empty icon="🚚"
              title={f.active > 0 ? 'No vehicle matches those filters' : 'Nothing in the yard'}
              hint={f.active > 0 ? 'Clear a filter to widen the search.'
                : 'Vehicles appear here once the gate has logged them in.'} />}
            defaultSort="w"
          />
        </div>
      </div>

      {weighing ? (
        <WeighInModal gate={weighing} onClose={() => setWeighing(null)}
          onDone={(nextStep) => {
            setWeighing(null);
            reload();
            if (nextStep === 'BOX_WEIGHING') nav(`/unload/${weighing.gate_entry_id}`);
          }} />
      ) : null}
    </Layout>
  );
}

/* -------------------------------------------------------------- weigh --- */

/**
 * Gross first, then tare. Crate counts sit beside the weights rather than
 * replacing them: the weighbridge says what the load weighs and the count says
 * what it is made of, and a shortage argument needs both.
 */
function WeighInModal({ gate, onClose, onDone }: {
  gate: any; onClose: () => void; onDone: (nextStep?: string) => void;
}) {
  const toast = useToast();
  const containers = useApi<any[]>('/masters/container-types');
  const [kind, setKind] = useState<'GROSS' | 'TARE'>(gate.has_gross ? 'TARE' : 'GROSS');
  const [weight, setWeight] = useState('');
  const [containerTypeId, setContainerTypeId] = useState('');
  const [count, setCount] = useState('');
  /* Packing material: pick a known packet and it fills the weight, or type the
   * figure straight in. Both, because a warehouse has a standard sack most days
   * and something nobody has a record of on the others. */
  const [packTypeId, setPackTypeId] = useState('');
  const [packCount, setPackCount] = useState('');
  const [packingTare, setPackingTare] = useState('');
  const [packManual, setPackManual] = useState(false);
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  const ct = (containers.data ?? []).find((c: any) => c.id === containerTypeId);
  const crateTare = ct && count ? Number(ct.tare_kg) * Number(count) : 0;
  const pt = (containers.data ?? []).find((c: any) => c.id === packTypeId);

  /** Choosing a packet type and a count writes the weight into the same field
   *  the manual entry uses, so there is one number and it is always visible. */
  const fillPacking = (typeId: string, n: string) => {
    const t = (containers.data ?? []).find((c: any) => c.id === typeId);
    if (!t || !n) return;
    setPackingTare(String(Math.round(Number(t.tare_kg) * Number(n) * 1000) / 1000));
  };
  const net = kind === 'GROSS' && weight
    ? Number(weight) - crateTare - (Number(packingTare) || 0)
    : null;

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const result = await api.post<any>(`/receiving/gate-entries/${gate.gate_entry_id}/weighments`, {
        kind,
        method: containerTypeId ? 'CRATE_COUNT' : 'TWO_WEIGHMENT',
        grossKg: kind === 'GROSS' ? Number(weight) : null,
        tareKg: kind === 'TARE' ? Number(weight) : null,
        containerTypeId: containerTypeId || null,
        containerCount: count ? Number(count) : null,
        packingTareKg: packingTare ? Number(packingTare) : null,
        captureMode: 'MANUAL',
        remarks: remarks || undefined,
      });
      toast(`${kind === 'GROSS' ? 'Gross' : 'Tare'} weight recorded`, 'ok');
      onDone(result.nextStep === 'QC' ? 'BOX_WEIGHING' : undefined);
    } catch (e: any) { setError(e); } finally { setBusy(false); }
  };

  return (
    <Modal
      title={`Weigh in ${gate.vehicle_reg_captured ?? gate.gate_no}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !weight} onClick={submit}>
            {busy ? 'Saving…' : 'Record weight'}
          </button>
        </>
      }
    >
      <ErrorBanner error={error} />

      <Field label="Which reading is this?">
        <select value={kind} onChange={(e) => setKind(e.target.value as any)}>
          <option value="GROSS">Gross — loaded vehicle</option>
          <option value="TARE">Tare — empty vehicle</option>
        </select>
      </Field>

      <Field label="Weight (kg)" hint="Straight off the weighbridge.">
        <input type="number" step="0.001" value={weight} autoFocus
          onChange={(e) => setWeight(e.target.value)} />
      </Field>

      <div className="card mb" style={{ background: 'var(--surface-2)' }}>
        <div className="card-head">
          <h2 style={{ fontSize: 14 }}>Packing material</h2>
          <button className="btn sm ghost" onClick={() => setPackManual((v) => !v)}>
            {packManual ? 'Pick from the list' : 'Type the weight instead'}
          </button>
        </div>
        <div className="card-body">
          {packManual ? (
            <Field label="Packing weight (kg)" hint="Sacks, liners — the whole load.">
              <input type="number" step="0.01" value={packingTare} autoFocus
                onChange={(e) => setPackingTare(e.target.value)} />
            </Field>
          ) : (
            <>
              <div className="grid c2">
                <Field label="What is it packed in?">
                  <select value={packTypeId}
                    onChange={(e) => { setPackTypeId(e.target.value); fillPacking(e.target.value, packCount); }}>
                    <option value="">Nothing / not counted</option>
                    {(containers.data ?? []).map((c: any) => (
                      <option key={c.id} value={c.id}>
                        {c.name} — {num(c.tare_kg, 3)} kg each
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="How many?" hint="Filled in for you from the weight of one.">
                  <input type="number" value={packCount} disabled={!packTypeId}
                    onChange={(e) => { setPackCount(e.target.value); fillPacking(packTypeId, e.target.value); }} />
                </Field>
              </div>
              <Field label="Packing weight (kg)"
                hint={pt && packCount
                  ? `${packCount} × ${num(pt.tare_kg, 3)} kg. Change it if the real figure differs.`
                  : 'Choose a packet above, or type the figure in.'}>
                <input type="number" step="0.01" value={packingTare}
                  onChange={(e) => setPackingTare(e.target.value)} />
              </Field>
            </>
          )}
        </div>
      </div>

      <div className="grid c2">
        <Field label="Crates / bags counted" hint="Leave blank for loose stock.">
          <select value={containerTypeId} onChange={(e) => setContainerTypeId(e.target.value)}>
            <option value="">Loose / not counted</option>
            {(containers.data ?? []).map((c: any) => (
              <option key={c.id} value={c.id}>
                {c.name} — {num(c.tare_kg, 2)} kg each
              </option>
            ))}
          </select>
        </Field>
        <Field label="How many?" hint="Count them as they come off.">
          <input type="number" value={count} disabled={!containerTypeId}
            onChange={(e) => setCount(e.target.value)} />
        </Field>
      </div>

      <Field label="Note" hint="Anything unusual about the load.">
        <input value={remarks} onChange={(e) => setRemarks(e.target.value)} />
      </Field>

      {kind === 'GROSS' && weight ? (
        <div className="banner info">
          <span><Icon name="scale" size={16} /></span>
          <div>
            {/* Deliberately NOT called "goods". The final net also has the
                vehicle's own weight taken off it, which comes from the TARE
                reading — so a figure claimed here would be out by the weight
                of a truck, and it was: the screen said 1,361 kg where the
                system recorded 861. Show the arithmetic we can actually
                defend, and say who does the rest. */}
            <b>
              {num(Number(weight), 2)} kg on the bridge
              {crateTare > 0 || Number(packingTare) > 0
                ? `, less ${num(crateTare + (Number(packingTare) || 0), 2)} kg of packaging`
                : ''}
            </b>
            <div className="small">
              {crateTare > 0
                ? `${count} × ${num(Number(ct?.tare_kg ?? 0), 3)} kg ${String(ct?.name ?? '').toLowerCase()}`
                : 'no crates counted'}
              {Number(packingTare) > 0 ? ` · ${num(Number(packingTare), 2)} kg packing` : ''}
              {'. '}
              {gate.has_tare
                ? 'The vehicle’s own weight is already recorded, so the system works out the final net itself.'
                : 'The vehicle’s own weight comes off when the tare reading is taken — the system works out the final net then.'}
            </div>
          </div>
        </div>
      ) : null}

    </Modal>
  );
}
