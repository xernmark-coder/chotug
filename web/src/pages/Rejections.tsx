import React, { useState } from 'react';
import { api, useAuth, inr, num, date, ago } from '../lib/api';
import {
  Chip, DataTable, Empty, ErrorBanner, Field, Kpi, Layout, Modal, useApi, useToast,
  FilterBar, FilterTotals, useFilters,
} from '../components/ui';
import { Icon } from '../components/icons';

/* ===========================================================================
 * WHAT WE TURNED AWAY
 *
 * Rejecting produce and sending it back are two different events. QC decides at
 * the bay; hours later somebody in the warehouse puts it on a lorry — or dumps
 * it, or agrees a discount and keeps it. Only the first was ever recorded, so a
 * supplier whose load was refused found out from a phone call, if at all, and
 * three weeks later the short payment was an argument about what had actually
 * been in the crates.
 *
 * This is the list of rejections with no answer yet, and the one place the
 * answer is given. Whatever is recorded here appears on the supplier's own
 * panel, in the unit it was measured in.
 * ======================================================================== */

const OUTCOMES = [
  { key: 'SENT_BACK', label: 'All of it went back',
    hint: 'On a vehicle, back to the supplier' },
  { key: 'PART_SENT_BACK', label: 'Part of it went back',
    hint: 'Say how much — the rest stayed with us' },
  { key: 'DESTROYED', label: 'Thrown away',
    hint: 'Not fit to travel. Written off' },
  { key: 'KEPT_AT_A_DISCOUNT', label: 'Kept at a discount',
    hint: 'We are using it. Say what was agreed' },
];
const OUTCOME_LABEL: Record<string, string> = Object.fromEntries(
  OUTCOMES.map((o) => [o.key, o.label]));
const OUTCOME_TONE: Record<string, 'warn' | 'ok' | 'danger' | 'neutral'> = {
  SENT_BACK: 'warn', PART_SENT_BACK: 'warn', DESTROYED: 'danger',
  KEPT_AT_A_DISCOUNT: 'ok',
};

export function RejectionsPage() {
  const { can } = useAuth();
  const rows = useApi<any[]>('/receiving/rejections');
  const [answering, setAnswering] = useState<any>(null);

  const all = rows.data ?? [];
  const open = all.filter((r: any) => r.awaiting_decision);
  const canAnswer = can('quality.rejection.return');

  const f = useFilters<any>(all, {
    date: (r: any) => r.inspected_at,
    search: (r: any) => [r.inspection_no, r.po_no, r.supplier_name, r.product_name,
      r.warehouse_name].filter(Boolean).join(' '),
    facets: [
      { key: 'sup', label: 'supplier', of: (r: any) => r.supplier_name ?? 'no order behind it' },
      { key: 'p', label: 'product', of: (r: any) => r.product_name },
      { key: 'st', label: 'answered', all: 'Answered or not', of: (r: any) =>
        (r.awaiting_decision ? 'nobody has said yet' : OUTCOME_LABEL[r.return_outcome] ?? 'answered') },
      { key: 'w', label: 'warehouse', of: (r: any) => r.warehouse_name },
    ],
    totals: [
      { label: 'Rejections', of: () => 1 },
      { label: 'Value refused', of: (r: any) => Number(r.rejected_value) || 0, money: true },
    ],
  });

  return (
    <Layout title="Turned away"
      subtitle="What quality refused, and what became of it">
      <ErrorBanner error={rows.error} />

      <div className="grid c3 mb">
        <Kpi label="Waiting on an answer" value={num(open.length, 0)}
          tone={open.length ? 'warn' : 'good'}
          foot="rejected, nobody has said where it went" />
        <Kpi label="Value refused" value={inr(all.reduce(
          (a: number, r: any) => a + (Number(r.rejected_value) || 0), 0), 0)}
          foot="at the rate we ordered it" />
        <Kpi label="Suppliers told" value={num(
          all.filter((r: any) => r.return_seen_at).length, 0)}
          foot="have opened it on their panel" />
      </div>

      {open.length && canAnswer ? (
        <div className="banner warn mb">
          <span><Icon name="alert" size={16} /></span>
          <div>
            <b>{open.length} rejection(s) with nobody saying what happened.</b> Until
            somebody answers, the supplier has not been told their goods were refused —
            and by the time the invoice is short it is an argument instead of a
            collection.
          </div>
        </div>
      ) : null}

      <FilterBar f={f} placeholder="Search inspection, order, supplier, product" />
      <FilterTotals f={f} noun="rejection" />
      <div className="card"><div className="card-body tight">
        <DataTable
          loading={rows.loading}
          rows={f.rows}
          rowTone={(r: any) => (r.awaiting_decision ? 'crit' : undefined)}
          cols={[
            { key: 'p', head: 'Product', sort: (r: any) => r.product_name, render: (r: any) => (
              <div className="row" style={{ gap: 8 }}>
                <Icon name={r.product_icon ?? 'produce'} size={17} />
                <div><b>{r.product_name}</b>
                  <div className="small muted mono">{r.inspection_no}</div></div>
              </div>
            ) },
            { key: 's', head: 'From', render: (r: any) => (
              <div>{r.supplier_name ?? <span className="muted">—</span>}
                <div className="small muted">{r.po_no ?? 'no order'}</div></div>
            ) },
            /* Never a bare number. This column is the whole reason the unit is
               now stored on the inspection. */
            { key: 'rj', head: 'Refused', num: true, desc: true,
              sort: (r: any) => Number(r.rejected_qty) || 0, render: (r: any) => (
              <span><b style={{ color: 'var(--danger)' }}>{num(r.rejected_qty, 2)}</b>{' '}
                <span className="small muted">{r.uom}</span>
                <div className="small muted">of {num(r.received_qty, 2)} {r.uom}</div></span>
            ) },
            { key: 'v', head: 'Worth', num: true, desc: true,
              sort: (r: any) => Number(r.rejected_value) || 0,
              render: (r: any) => inr(r.rejected_value, 0) },
            { key: 'why', head: 'Why', render: (r: any) => (
              <div className="small">
                {(r.rejection_reason_codes ?? []).join(', ') || <span className="muted">—</span>}
                {r.remarks ? <div className="muted">{r.remarks}</div> : null}
              </div>
            ) },
            { key: 'o', head: 'What happened', render: (r: any) => r.awaiting_decision ? (
              <Chip tone="danger">nobody has said</Chip>
            ) : (
              <div>
                <Chip tone={OUTCOME_TONE[r.return_outcome] ?? 'neutral'}>
                  {OUTCOME_LABEL[r.return_outcome] ?? r.return_outcome}
                </Chip>
                <div className="small muted">
                  {Number(r.returned_qty) > 0
                    ? `${num(r.returned_qty, 2)} ${r.uom} back` : 'nothing went back'}
                  {r.return_vehicle_reg ? ` · ${r.return_vehicle_reg}` : ''}
                </div>
              </div>
            ) },
            { key: 'seen', head: 'Supplier', render: (r: any) =>
              r.awaiting_decision ? <span className="small muted">not told yet</span>
              : r.return_seen_at ? <Chip tone="ok">seen {ago(r.return_seen_at)}</Chip>
              : <span className="small muted">on their panel</span> },
            { key: 'a', head: '', width: 130, render: (r: any) =>
              canAnswer && r.awaiting_decision ? (
                <button className="btn sm primary" onClick={() => setAnswering(r)}>
                  Say what happened
                </button>
              ) : null },
          ]}
          empty={<Empty icon="✅" title={f.active > 0
            ? 'No rejection matches those filters'
            : 'Nothing has been turned away'} />}
        />
      </div></div>

      {answering ? (
        <AnswerModal r={answering} onClose={() => setAnswering(null)}
          onDone={() => { setAnswering(null); rows.reload(); }} />
      ) : null}
    </Layout>
  );
}

/* The one place the answer is given. Deliberately a small form: the person
   filling it in is standing next to the crates, not at a desk. */
function AnswerModal({ r, onClose, onDone }: {
  r: any; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const rejected = Number(r.rejected_qty) || 0;
  const [outcome, setOutcome] = useState('SENT_BACK');
  const [qty, setQty] = useState(String(rejected));
  const [vehicle, setVehicle] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  /* "All of it" and "part of it" are the same event with a different number, so
     the quantity follows the choice rather than being asked twice. */
  const pick = (k: string) => {
    setOutcome(k);
    setQty(k === 'SENT_BACK' ? String(rejected) : k === 'PART_SENT_BACK' ? '' : '0');
  };
  const goesBack = outcome === 'SENT_BACK' || outcome === 'PART_SENT_BACK';
  const bad = outcome === 'PART_SENT_BACK'
    && !(Number(qty) > 0 && Number(qty) < rejected);

  return (
    <Modal
      title={`${num(rejected, 2)} ${r.uom} of ${r.product_name} — what happened to it?`}
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary"
          disabled={busy || bad || (outcome === 'KEPT_AT_A_DISCOUNT' && !note.trim())}
          onClick={async () => {
            setBusy(true); setError(null);
            try {
              const res = await api.post<any>(`/receiving/rejections/${r.inspection_id}/return`, {
                outcome,
                returnedQty: goesBack ? Number(qty) : 0,
                vehicleReg: vehicle.trim() || undefined,
                note: note.trim() || undefined,
              });
              toast(res.message, 'ok');
              onDone();
            } catch (e: any) { setError(e); } finally { setBusy(false); }
          }}>
          {busy ? 'Saving…' : 'Record it'}
        </button>
      </>}
    >
      <ErrorBanner error={error} />
      <dl className="kv mb">
        <dt>Refused</dt>
        <dd><b>{num(rejected, 2)} {r.uom}</b> of {num(r.received_qty, 2)} {r.uom} received</dd>
        <dt>From</dt><dd>{r.supplier_name ?? '—'}{r.po_no ? ` · ${r.po_no}` : ''}</dd>
        <dt>Why</dt><dd>{(r.rejection_reason_codes ?? []).join(', ') || '—'}</dd>
        <dt>Worth</dt><dd>{inr(r.rejected_value, 0)} at the rate we ordered it</dd>
      </dl>

      <div className="stack mb">
        {OUTCOMES.map((o) => (
          <label key={o.key} className="row" style={{ gap: 9, cursor: 'pointer' }}>
            <input type="radio" name="outcome" checked={outcome === o.key}
              onChange={() => pick(o.key)} style={{ width: 16, height: 16 }} />
            <span><b className="small">{o.label}</b>
              <span className="small muted"> — {o.hint}</span></span>
          </label>
        ))}
      </div>

      {outcome === 'PART_SENT_BACK' ? (
        <Field label={`How much went back (${r.uom})`}
          hint={`Between 0 and ${num(rejected, 2)}. The rest stays with us.`}>
          <input type="number" step="0.001" min={0} max={rejected} value={qty} autoFocus
            onChange={(e) => setQty(e.target.value)} />
        </Field>
      ) : null}

      {goesBack ? (
        <Field label="Vehicle it went on"
          hint="Optional, but it is what the supplier will ask about.">
          <input value={vehicle} onChange={(e) => setVehicle(e.target.value.toUpperCase())}
            placeholder="MH14CD5678" />
        </Field>
      ) : null}

      <Field
        label={outcome === 'KEPT_AT_A_DISCOUNT' ? 'What was agreed (required)' : 'Anything to add'}
        hint={outcome === 'KEPT_AT_A_DISCOUNT'
          ? 'The supplier is being billed for goods we rejected. Say on whose word.'
          : 'The supplier sees this.'}>
        <input value={note} onChange={(e) => setNote(e.target.value)}
          placeholder={outcome === 'DESTROYED'
            ? 'Too far gone to travel — dumped at the yard'
            : 'Collected by their driver at 4pm'} />
      </Field>

      <div className="banner info">
        <span><Icon name="info" size={16} /></span>
        <div className="small">
          {r.supplier_name
            ? <>This appears on <b>{r.supplier_name}</b>&rsquo;s panel as soon as you save it,
                in {r.uom}. Telling them today is a collection; telling them at invoice
                time is an argument.</>
            : <>There is no order behind this inspection, so there is nobody to tell —
                it is recorded for our own books.</>}
        </div>
      </div>
    </Modal>
  );
}
