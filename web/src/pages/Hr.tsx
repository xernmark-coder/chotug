import React, { useEffect, useMemo, useState } from 'react';
import { api, useAuth, inr, num, date, ago } from '../lib/api';
import {
  Chip, DataTable, Empty, ErrorBanner, Field, Kpi, Layout, Loading, Modal, useApi, useToast,
  FilterBar, FilterTotals, useFilters,
} from '../components/ui';
import { Icon } from '../components/icons';

/* ===========================================================================
 * HR — the people who do the work
 *
 * Three screens' worth of job, kept as three tabs because they happen at
 * different times of day:
 *
 *   Today   — somebody walks the floor at 8am and taps who is in.
 *   People  — the records behind those taps.
 *   Wages   — once a fortnight, what it all comes to, sent to Finance.
 *
 * Attendance is the one that has to be fast: a row per person, three big
 * buttons, no dialog. Anything slower and it stops being taken.
 * ======================================================================== */

const STATUSES = [
  { key: 'PRESENT', label: 'In', tone: 'ok' },
  { key: 'HALF_DAY', label: 'Half', tone: 'primary' },
  { key: 'ABSENT', label: 'Absent', tone: 'danger' },
  { key: 'LEAVE', label: 'Leave', tone: 'warn' },
  { key: 'WEEKLY_OFF', label: 'Off', tone: 'neutral' },
];

export function HrPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<'today' | 'people' | 'wages'>('today');
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10));

  const summary = useApi<any>('/hr/summary');
  const attendance = useApi<any>(`/hr/attendance?date=${day}`, [day]);
  const workers = useApi<any[]>('/hr/workers');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<any>(null);

  const k = summary.data?.kpis ?? {};

  const fWorkers = useFilters<any>(workers.data, {
    search: (w: any) => [w.full_name, w.code, w.designation, w.place_name, w.phone]
      .filter(Boolean).join(' '),
    facets: [
      { key: 'pl', label: 'place', of: (w: any) => w.place_name },
      { key: 'dg', label: 'job', of: (w: any) => w.designation },
      { key: 'em', label: 'employment', of: (w: any) => w.employment },
      { key: 'wt', label: 'paid', of: (w: any) => w.wage_type },
      { key: 'ac', label: 'on the books', all: 'Working or left', of: (w: any) => (w.is_active ? 'working' : 'left') },
    ],
    totals: [
      { label: 'Days in, 30d', of: (w: any) => Number(w.present_30d) || 0 },
      { label: 'Hours, 30d', of: (w: any) => Number(w.hours_30d) || 0 },
    ],
  });

  return (
    <Layout
      title="People"
      subtitle="Who works here, who turned up, and what they are owed"
      actions={can('hr.worker.manage')
        ? <button className="btn sm primary" onClick={() => setAdding(true)}>Add a person</button>
        : undefined}
    >
      <ErrorBanner error={summary.error} />

      <div className="grid c4 mb">
        <Kpi label="On the books" value={k.workers ?? 0}
          foot={(summary.data?.byPlace ?? []).map((p: any) =>
            `${p.workers} at ${p.place}`).join(' · ') || '—'} />
        <Kpi label="In today" value={k.present_today ?? 0}
          tone={(k.unmarked_today ?? 0) > 0 ? 'warn' : 'good'}
          foot={(k.unmarked_today ?? 0) > 0
            ? `${k.unmarked_today} not marked yet` : 'everybody marked'} />
        <Kpi label="Absent today" value={k.absent_today ?? 0}
          tone={(k.absent_today ?? 0) > 0 ? 'warn' : 'good'} />
        <Kpi label="Wages, 30 days" value={inr(k.wages_30d, 0)}
          foot={Number(k.bonus_90d) > 0 ? `${inr(k.bonus_90d, 0)} of bonuses in 90 days` : 'no bonuses paid'} />
      </div>

      <div className="tabs">
        {([['today', 'Today'],
           ['people', `People (${(workers.data ?? []).length})`],
           ['wages', 'Wages']] as const).map(([key, label]) => (
          <button key={key} className={`tab ${tab === key ? 'active' : ''}`}
            onClick={() => setTab(key)}>{label}</button>))}
      </div>

      {tab === 'today' ? (
        <AttendanceBoard day={day} setDay={setDay} data={attendance}
          onSaved={() => { attendance.reload(); summary.reload(); }} />
      ) : null}

      {tab === 'people' ? (
        <div className="card"><div className="card-body tight">
          <FilterBar f={fWorkers} placeholder="Search name, code, job" />
          <FilterTotals f={fWorkers} noun="person" />
          <DataTable
            loading={workers.loading}
            rows={fWorkers.rows}
            onRowClick={(w: any) => can('hr.worker.manage') && setEditing(w)}
            rowTone={(w: any) => (!w.is_active ? 'warn' : undefined)}
            cols={[
              { key: 'n', head: 'Person', render: (w: any) => (
                <div><b>{w.full_name}</b> <span className="small muted mono">{w.code}</span>
                  <div className="small muted">
                    {w.designation ?? '—'}{w.place_name ? ` · ${w.place_name}` : ''}
                    {w.phone ? ` · ${w.phone}` : ''}
                  </div></div>) },
              { key: 'w', head: 'Paid', render: (w: any) => (
                <div><b>{inr(w.wage_rate, 0)}</b>
                  <div className="small muted">
                    {w.wage_type === 'MONTHLY' ? 'a month'
                      : w.wage_type === 'HOURLY' ? 'an hour'
                      : w.wage_type === 'PIECE' ? 'per piece' : 'a day'}
                    {' · '}{w.employment.toLowerCase()}
                  </div></div>) },
              { key: 'a', head: 'Last 30 days', render: (w: any) => (
                <div className="small">
                  <b>{w.present_30d ?? 0}</b> in
                  {Number(w.absent_30d) > 0
                    ? <span className="text-danger"> · {w.absent_30d} absent</span> : null}
                  {Number(w.leave_30d) > 0 ? ` · ${w.leave_30d} leave` : ''}
                  <div className="muted">{num(w.hours_30d, 0)} hours</div>
                </div>) },
              /* Output, not a rating. A number somebody earned beats a star
                 somebody gave them. */
              { key: 'o', head: 'What they did', render: (w: any) => {
                const bits = [
                  Number(w.boxes_weighed) ? `${w.boxes_weighed} boxes weighed` : null,
                  Number(w.boxes_packed) ? `${w.boxes_packed} packed` : null,
                  Number(w.audits_done) ? `${w.audits_done} shelves counted` : null,
                ].filter(Boolean);
                return bits.length
                  ? <div className="small">{bits.join(' · ')}</div>
                  : <span className="muted small">{w.login_name ? 'nothing logged' : 'no login'}</span>;
              } },
              { key: 'p', head: 'Paid up to', render: (w: any) =>
                w.paid_upto ? <div><span className="small">{date(w.paid_upto)}</span>
                  <div className="small muted">{inr(w.paid_12m, 0)} in a year</div></div>
                  : <Chip tone="warn">never</Chip> },
              { key: 's', head: '', render: (w: any) =>
                w.is_active ? null : <Chip tone="warn">left</Chip> },
            ]}
            empty={<Empty icon="🧑‍🌾" title="Nobody on the books yet"
              hint="Add the loaders, packers and shop hands — they are paid through Finance like everyone else." />}
          />
        </div></div>
      ) : null}

      {tab === 'wages' ? <WagesTab onDone={() => { summary.reload(); workers.reload(); }}
        recent={summary.data?.recent ?? []} /> : null}

      {adding || editing ? (
        <WorkerModal worker={editing} onClose={() => { setAdding(false); setEditing(null); }}
          onDone={(m) => {
            setAdding(false); setEditing(null);
            workers.reload(); summary.reload(); attendance.reload(); toast(m, 'ok');
          }} />
      ) : null}
    </Layout>
  );
}

/* ------------------------------------------------------------- today ----- */

function AttendanceBoard({ day, setDay, data, onSaved }: {
  day: string; setDay: (d: string) => void; data: any; onSaved: () => void;
}) {
  const toast = useToast();
  const { can } = useAuth();
  const [marks, setMarks] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);

  /* Whatever is already saved is the starting point, so re-opening the day
     shows what was marked rather than a blank sheet. */
  useEffect(() => {
    const seed: Record<string, any> = {};
    for (const w of data.data?.workers ?? []) {
      if (w.status) seed[w.worker_id] = { status: w.status, overtimeHours: Number(w.overtime_hours ?? 0) };
    }
    setMarks(seed);
  }, [data.data]);

  const rows = data.data?.workers ?? [];
  const changed = rows.filter((w: any) => {
    const m = marks[w.worker_id];
    if (!m) return false;
    return m.status !== w.status || Number(m.overtimeHours ?? 0) !== Number(w.overtime_hours ?? 0);
  });
  const unmarked = rows.filter((w: any) => !marks[w.worker_id]);
  const canMark = can('hr.attendance.mark');

  /* A supervisor marks their own shed, not the whole company. Narrowing here
   * also narrows "Everyone in" below, which is the point — otherwise the
   * button quietly marks people they never saw. */
  const f = useFilters<any>(rows, {
    search: (w: any) => [w.full_name, w.code, w.designation, w.place_name]
      .filter(Boolean).join(' '),
    facets: [
      { key: 'pl', label: 'place', of: (w: any) => w.place_name },
      { key: 'dg', label: 'job', of: (w: any) => w.designation },
      { key: 'mk', label: 'marked', all: 'Marked or not', of: (w: any) =>
        (marks[w.worker_id] ? 'marked' : 'not marked yet') },
    ],
    totals: [],
  });
  const unmarkedHere = f.rows.filter((w: any) => !marks[w.worker_id]);
  const future = day > new Date().toISOString().slice(0, 10);

  const save = async () => {
    setBusy(true);
    try {
      const r = await api.post<any>('/hr/attendance', {
        date: day,
        entries: Object.entries(marks).map(([workerId, m]: any) => ({
          workerId, status: m.status, overtimeHours: Number(m.overtimeHours) || 0,
        })),
      });
      toast(r.message, 'ok');
      onSaved();
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2>Who is in</h2>
        <div className="btn-row">
          <input type="date" value={day} max={new Date().toISOString().slice(0, 10)}
            onChange={(e) => setDay(e.target.value)} />
          {canMark && !future ? (
            <>
              <button className="btn sm" disabled={busy || !unmarkedHere.length}
                onClick={() => setMarks((s) => ({
                  ...s,
                  ...Object.fromEntries(unmarkedHere.map((w: any) =>
                    [w.worker_id, { status: 'PRESENT', overtimeHours: 0 }])),
                }))}>
                {f.active > 0 ? `These ${unmarkedHere.length} in` : 'Everyone in'}
              </button>
              <button className="btn sm primary" disabled={busy || !Object.keys(marks).length}
                onClick={save}>
                {busy ? 'Saving…' : changed.length ? `Save ${changed.length} change(s)` : 'Save'}
              </button>
            </>
          ) : null}
        </div>
      </div>
      <div className="card-body tight">
        {data.loading ? <Loading /> : null}
        {!data.loading && rows.length ? (
          <>
            <FilterBar f={f} placeholder="Search name, code, job" />
            <FilterTotals f={f} noun="person" />
          </>
        ) : null}
        {!data.loading && !rows.length ? (
          <Empty icon="🧑‍🌾" title="Nobody to mark"
            hint="Add people on the People tab first." />
        ) : null}
        {!data.loading && rows.length && !f.rows.length ? (
          <Empty icon="🧑‍🌾" title="Nobody matches those filters"
            hint="Clear a filter to widen the search." />
        ) : null}
        {f.rows.map((w: any) => {
          const m = marks[w.worker_id];
          return (
            <div className={`att-row ${m ? '' : 'unmarked'}`} key={w.worker_id}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{w.full_name}</b> <span className="small muted mono">{w.code}</span>
                <div className="small muted">
                  {w.designation ?? '—'}{w.place_name ? ` · ${w.place_name}` : ''}
                  {w.marked_by_name ? ` · marked by ${w.marked_by_name}` : ''}
                </div>
              </div>
              <div className="btn-row">
                {STATUSES.map((s) => (
                  <button key={s.key}
                    className={`btn sm ${m?.status === s.key ? 'primary' : ''}`}
                    disabled={!canMark || future}
                    onClick={() => setMarks((x) => ({
                      ...x, [w.worker_id]: { ...(x[w.worker_id] ?? {}), status: s.key },
                    }))}>{s.label}</button>
                ))}
                <input className="inline num" type="number" min={0} max={16} style={{ width: 62 }}
                  placeholder="OT h" disabled={!canMark || future || !m}
                  value={m?.overtimeHours ?? ''}
                  onChange={(e) => setMarks((x) => ({
                    ...x, [w.worker_id]: { ...(x[w.worker_id] ?? { status: 'PRESENT' }),
                      overtimeHours: e.target.value },
                  }))} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- wages ---- */

function WagesTab({ recent, onDone }: { recent: any[]; onDone: () => void }) {
  const toast = useToast();
  const { can } = useAuth();
  const monthStart = new Date().toISOString().slice(0, 8) + '01';
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const preview = useApi<any>(
    can('hr.wages.run') ? `/hr/wages/preview?from=${from}&to=${to}` : null, [from, to]);
  const [extras, setExtras] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);

  const rows = preview.data?.workers ?? [];
  const f = useFilters<any>(rows, {
    search: (w: any) => [w.name, w.code, w.designation].filter(Boolean).join(' '),
    facets: [
      { key: 'dg', label: 'job', of: (w: any) => w.designation },
      { key: 'wt', label: 'paid', of: (w: any) => w.wageType },
      { key: 'sent', label: 'sent', all: 'Sent or not', of: (w: any) =>
        (w.alreadyRun?.request_id ? 'already sent' : 'not sent') },
    ],
    totals: [
      { label: 'Days in', of: (w: any) => Number(w.daysPresent) || 0, decimals: 1 },
      { label: 'Hours', of: (w: any) => Number(w.hours) || 0 },
      { label: 'Earned', of: (w: any) => Number(w.subtotal) || 0, money: true },
    ],
  });
  const toRun = f.rows.filter((r: any) => !r.alreadyRun?.request_id);
  /* Counted over the same people the count above is counting: this is what the
     button is about to send, not what the period came to. */
  const total = toRun.reduce((a: number, r: any) => {
    const e = extras[r.workerId] ?? {};
    return a + r.subtotal + (Number(e.bonus) || 0) - (Number(e.deductions) || 0);
  }, 0);
  const fRecent = useFilters<any>(recent, {
    date: (r: any) => r.period_end,
    search: (r: any) => [r.full_name, r.request_no, r.bonus_reason].filter(Boolean).join(' '),
    facets: [
      { key: 'who', label: 'person', of: (r: any) => r.full_name },
      { key: 'pay', label: 'payment', of: (r: any) =>
        (!r.request_no ? 'not sent' : String(r.payment_status ?? '').toLowerCase()) },
    ],
    totals: [
      { label: 'Runs', of: () => 1 },
      { label: 'Base', of: (r: any) => Number(r.base_amount) || 0, money: true },
      { label: 'Bonus', of: (r: any) => Number(r.bonus_amount) || 0, money: true },
      { label: 'Net', of: (r: any) => Number(r.net_amount) || 0, money: true },
    ],
  });

  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post<any>('/hr/wages/run', {
        from, to,
        entries: toRun.map((w: any) => ({
          workerId: w.workerId,
          bonus: Number(extras[w.workerId]?.bonus) || 0,
          bonusReason: extras[w.workerId]?.bonusReason || undefined,
          deductions: Number(extras[w.workerId]?.deductions) || 0,
          deductionReason: extras[w.workerId]?.deductionReason || undefined,
        })),
      });
      toast(r.message, 'ok');
      preview.reload(); onDone();
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="card mb">
        <div className="card-head">
          <h2>Work out a period</h2>
          <div className="btn-row">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            {can('hr.wages.run') ? (
              <button className="btn sm primary" disabled={busy || !toRun.length} onClick={run}>
                {busy ? 'Sending…' : `Send ${toRun.length} to Finance`}
              </button>
            ) : null}
          </div>
        </div>
        <div className="card-body tight">
          <p className="small muted" style={{ padding: '8px 12px 0' }}>
            Worked out from the attendance, not typed. Each person becomes their
            own request so Finance can hold one without holding everybody.
          </p>
          <FilterBar f={f} placeholder="Search name, code, job" />
          <FilterTotals f={f} noun="person" />
          <DataTable
            loading={preview.loading}
            rows={f.rows}
            rowTone={(w: any) => (w.alreadyRun?.request_id ? 'warn' : undefined)}
            cols={[
              { key: 'n', head: 'Person', render: (w: any) => (
                <div><b>{w.name}</b> <span className="small muted mono">{w.code}</span>
                  <div className="small muted">{w.designation ?? '—'} · {inr(w.wageRate, 0)}{' '}
                    {w.wageType === 'MONTHLY' ? 'a month' : w.wageType === 'HOURLY' ? 'an hour' : 'a day'}
                  </div></div>) },
              { key: 'd', head: 'Days', render: (w: any) => (
                <div className="small"><b>{num(w.daysPresent, 1)}</b> in
                  {w.daysAbsent > 0 ? <span className="text-danger"> · {num(w.daysAbsent, 0)} absent</span> : null}
                  {w.daysLeave > 0 ? ` · ${num(w.daysLeave, 0)} leave` : ''}
                </div>) },
              { key: 'h', head: 'Hours', num: true, render: (w: any) => (
                <div>{num(w.hours, 0)}
                  {w.overtime > 0 ? <div className="small muted">+{num(w.overtime, 0)} OT</div> : null}</div>) },
              { key: 'b', head: 'Earned', num: true, render: (w: any) => (
                <div>{inr(w.baseAmount, 0)}
                  {w.overtimeAmount > 0
                    ? <div className="small muted">+{inr(w.overtimeAmount, 0)} OT</div> : null}</div>) },
              { key: 'x', head: 'Bonus', width: 200, render: (w: any) => (
                w.alreadyRun?.request_id ? <span className="muted small">—</span> : (
                  <div className="row" style={{ gap: 4 }}>
                    <input className="inline num" type="number" style={{ width: 66 }}
                      placeholder="₹" value={extras[w.workerId]?.bonus ?? ''}
                      onChange={(e) => setExtras((s) => ({
                        ...s, [w.workerId]: { ...(s[w.workerId] ?? {}), bonus: e.target.value } }))} />
                    <input className="inline" style={{ width: 118 }} placeholder="what for"
                      value={extras[w.workerId]?.bonusReason ?? ''}
                      onChange={(e) => setExtras((s) => ({
                        ...s, [w.workerId]: { ...(s[w.workerId] ?? {}), bonusReason: e.target.value } }))} />
                  </div>)) },
              { key: 't', head: 'Net', num: true, render: (w: any) => {
                const e = extras[w.workerId] ?? {};
                const net = w.subtotal + (Number(e.bonus) || 0) - (Number(e.deductions) || 0);
                return w.alreadyRun?.request_id
                  ? <Chip tone="ok">sent · {inr(w.alreadyRun.net_amount, 0)}</Chip>
                  : <b>{inr(net, 0)}</b>;
              } },
            ]}
            empty={<Empty title={f.active > 0
              ? 'Nobody matches those filters' : 'Nobody to pay for that period'} />}
          />
          {rows.length ? (
            <div className="filter-total">
              <span>
                <b>{toRun.length}</b> still to pay
                {toRun.length !== f.rows.length ? (
                  <span className="muted"> · {f.rows.length - toRun.length} already sent</span>
                ) : null}
              </span>
              <span className="ft-num"><em>This run</em><b>{inr(total, 0)}</b></span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Already run</h2></div>
        <div className="card-body tight">
          <FilterBar f={fRecent} placeholder="Search person or request number" />
          <FilterTotals f={fRecent} noun="run" />
          <DataTable
            rows={fRecent.rows}
            cols={[
              { key: 'n', head: 'Person', render: (r: any) => (
                <div><b>{r.full_name}</b>
                  <div className="small muted">{date(r.period_start)} – {date(r.period_end)}</div></div>) },
              { key: 'd', head: 'Days', num: true, render: (r: any) => num(r.days_present, 1) },
              { key: 'b', head: 'Base', num: true, render: (r: any) => inr(r.base_amount, 0) },
              { key: 'o', head: 'Overtime', num: true, render: (r: any) =>
                Number(r.overtime_amount) > 0 ? inr(r.overtime_amount, 0) : <span className="muted">—</span> },
              { key: 'x', head: 'Bonus', render: (r: any) =>
                Number(r.bonus_amount) > 0
                  ? <div><b>{inr(r.bonus_amount, 0)}</b>
                      <div className="small muted">{r.bonus_reason}</div></div>
                  : <span className="muted">—</span> },
              { key: 't', head: 'Net', num: true, render: (r: any) => <b>{inr(r.net_amount, 0)}</b> },
              { key: 's', head: 'Finance', render: (r: any) =>
                !r.request_no ? <Chip tone="warn">not sent</Chip>
                  : <div><span className="mono small">{r.request_no}</span>
                      <div><Chip tone={r.payment_status === 'PAID' ? 'ok' : 'warn'}>
                        {String(r.payment_status ?? '').toLowerCase()}</Chip></div></div> },
            ]}
            empty={<Empty title={fRecent.active > 0
              ? 'No run matches those filters' : 'No wages run yet'} />}
          />
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------- worker ---- */

function WorkerModal({ worker, onClose, onDone }: {
  worker?: any; onClose: () => void; onDone: (m: string) => void;
}) {
  const { me } = useAuth();
  const { data: users } = useApi<any[]>('/masters/users');
  const [f, setF] = useState<any>({
    fullName: worker?.full_name ?? '', phone: worker?.phone ?? '',
    designation: worker?.designation ?? '', warehouseId: worker?.warehouse_id ?? '',
    userId: worker?.user_id ?? '', employment: worker?.employment ?? 'DAILY',
    wageType: worker?.wage_type ?? 'DAILY', wageRate: String(worker?.wage_rate ?? ''),
    overtimeRate: worker?.overtime_rate != null ? String(worker.overtime_rate) : '',
    standardHours: String(worker?.standard_hours ?? 8),
    joinedOn: worker?.joined_on ?? '', idProof: worker?.id_proof ?? '',
    address: worker?.address ?? '', note: worker?.note ?? '',
    isActive: worker?.is_active ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  const set = (k: string) => (e: any) => setF((s: any) => ({ ...s, [k]: e.target.value }));

  return (
    <Modal
      title={worker ? worker.full_name : 'Add a person'}
      onClose={onClose}
      wide
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        {worker ? (
          <button className="btn danger" disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api.patch<any>(`/hr/workers/${worker.id}`, {
                  isActive: !f.isActive,
                  leftOn: f.isActive ? new Date().toISOString().slice(0, 10) : undefined,
                });
                onDone(r.message);
              } catch (e: any) { setError(e); } finally { setBusy(false); }
            }}>
            {f.isActive ? 'They have left' : 'Bring them back'}
          </button>
        ) : null}
        <button className="btn primary" disabled={busy || !f.fullName.trim()}
          onClick={async () => {
            setBusy(true); setError(null);
            try {
              const payload = {
                fullName: f.fullName.trim(), phone: f.phone || undefined,
                designation: f.designation || undefined,
                warehouseId: f.warehouseId || undefined,
                userId: f.userId || undefined,
                employment: f.employment, wageType: f.wageType,
                wageRate: Number(f.wageRate) || 0,
                overtimeRate: f.overtimeRate ? Number(f.overtimeRate) : undefined,
                standardHours: Number(f.standardHours) || 8,
                joinedOn: f.joinedOn || undefined,
                idProof: f.idProof || undefined, address: f.address || undefined,
                note: f.note || undefined,
              };
              const r = worker
                ? await api.patch<any>(`/hr/workers/${worker.id}`, payload)
                : await api.post<any>('/hr/workers', payload);
              onDone(r.message);
            } catch (e: any) { setError(e); } finally { setBusy(false); }
          }}>{worker ? 'Save' : 'Add'}</button>
      </>}
    >
      <ErrorBanner error={error} />
      <div className="grid c3">
        <Field label="Name"><input value={f.fullName} autoFocus onChange={set('fullName')} /></Field>
        <Field label="Phone"><input value={f.phone} onChange={set('phone')} /></Field>
        <Field label="What they do">
          <input value={f.designation} onChange={set('designation')} placeholder="Loader" />
        </Field>
      </div>
      <div className="grid c3">
        <Field label="Where they work">
          <select value={f.warehouseId} onChange={set('warehouseId')}>
            <option value="">Not assigned</option>
            {(me?.warehouses ?? []).map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </Field>
        <Field label="Kind of work">
          <select value={f.employment} onChange={set('employment')}>
            <option value="DAILY">Daily wage</option>
            <option value="PERMANENT">Permanent</option>
            <option value="CONTRACT">Contract</option>
            <option value="SEASONAL">Seasonal</option>
          </select>
        </Field>
        <Field label="Started on"><input type="date" value={f.joinedOn} onChange={set('joinedOn')} /></Field>
      </div>
      <div className="section-head sm"><h3>What they are paid</h3><span className="rule" /></div>
      <div className="grid c4">
        <Field label="Paid by">
          <select value={f.wageType} onChange={set('wageType')}>
            <option value="DAILY">The day</option>
            <option value="MONTHLY">The month</option>
            <option value="HOURLY">The hour</option>
            <option value="PIECE">The piece</option>
          </select>
        </Field>
        <Field label="Rate (₹)"><input type="number" value={f.wageRate} onChange={set('wageRate')} /></Field>
        <Field label="Overtime (₹ an hour)"
          hint="Left blank, an overtime hour is worth an hour of the normal day.">
          <input type="number" value={f.overtimeRate} onChange={set('overtimeRate')} />
        </Field>
        <Field label="A normal day (hours)">
          <input type="number" value={f.standardHours} onChange={set('standardHours')} />
        </Field>
      </div>
      <div className="grid c3">
        <Field label="Their login, if they have one"
          hint="Links what they do in the system to their record here.">
          <select value={f.userId} onChange={set('userId')}>
            <option value="">No login</option>
            {(users ?? []).map((u: any) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select>
        </Field>
        <Field label="ID proof"><input value={f.idProof} onChange={set('idProof')}
          placeholder="Aadhaar last 4" /></Field>
        <Field label="Where they live"><input value={f.address} onChange={set('address')} /></Field>
      </div>
      <Field label="Anything worth noting"><input value={f.note} onChange={set('note')} /></Field>
    </Modal>
  );
}
