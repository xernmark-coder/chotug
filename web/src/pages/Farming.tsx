/* ===========================================================================
 * FARMING — the screens.
 *
 * Two audiences, deliberately different:
 *
 *   The field.  FARM TODAY, the plot QR screen and HARVEST. Big targets, three
 *               buttons, no forms, works one-handed in sunlight. A worker
 *               should never see a crop calendar, a cost, or a dropdown he
 *               cannot answer from where he is standing.
 *
 *   The desk.   Crop cycles, planning, the owner dashboard. Dense tables, the
 *               same DataTable/Chip/Kpi vocabulary as the rest of the app, so
 *               a buyer moving between purchase and farming is not relearning
 *               the product.
 * ======================================================================== */

import React, { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { api, date, idempotencyKey, inr, num, today, useAuth } from '../lib/api';
import {
  Chip, Col, DataTable, Empty, ErrorBanner, Field, Kpi, Layout, Loading, Modal,
  Steps, useApi, useToast,
} from '../components/ui';

/* ----------------------------------------------------------- primitives -- */

type Colour = 'GREEN' | 'YELLOW' | 'RED';

/** 🟢 🟡 🔴 — the entire status vocabulary of the module, in one dot. */
function Light({ c, label }: { c?: string | null; label?: React.ReactNode }) {
  return (
    <span className="row" style={{ gap: 7, display: 'inline-flex' }}>
      <i className={`light ${c ?? 'GREEN'}`} />
      {label != null ? <span>{label}</span> : null}
    </span>
  );
}

const TASK_ICON: Record<string, string> = {
  IRRIGATION: '💧', FERTILIZER: '🧪', SPRAY: '🌫️', INSPECTION: '🔍',
  WEEDING: '🌱', HARVEST: '🧺', MACHINE: '🚜', OTHER: '📌',
};

const PROBLEMS = [
  { code: 'DISEASE', label: 'Disease — रोग' },
  { code: 'PEST', label: 'Pest / insect — कीड़ा' },
  { code: 'WEATHER', label: 'Weather — मौसम' },
  { code: 'WATER', label: 'No water — पानी नहीं' },
  { code: 'MACHINE', label: 'Machine problem — मशीन' },
  { code: 'LABOUR', label: 'No labour — मजदूर नहीं' },
  { code: 'INPUT_MISSING', label: 'Input not available — सामान नहीं' },
  { code: 'OTHER', label: 'Something else — अन्य' },
];

const LOSS_REASONS = [
  'DISEASE', 'PEST', 'WEATHER', 'WATER', 'QUALITY_REJECT', 'HARVEST_DAMAGE',
  'SUSPECTED_THEFT', 'OTHER',
];

const EXPENSE_TYPES = [
  'LABOUR', 'FERTILIZER', 'PESTICIDE', 'WATER', 'ELECTRICITY', 'MACHINE',
  'FUEL', 'SEED', 'HARVEST', 'PACKING', 'TRANSPORT', 'RENT', 'OTHER',
];

/** A phone camera returns a File; the API stores the data URI, like QC does. */
function readPhoto(file: File): Promise<{ data: string; mime: string }> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ data: String(r.result), mime: file.type });
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/* ===========================================================================
 * §3 — FARM TODAY. The only screen a field worker opens.
 * ======================================================================== */

export function FarmTodayPage() {
  const nav = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const farmId = params.get('farmId') ?? '';
  const { data, loading, error, reload } = useApi<any>(
    `/farming/today${farmId ? `?farmId=${farmId}` : ''}`, [farmId]);
  const [problemFor, setProblemFor] = useState<any>(null);
  const [qtyFor, setQtyFor] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (loading) return <Layout title="Farm today" touch><Loading /></Layout>;

  if (data?.needsFarm) {
    return (
      <Layout title="Farm today" subtitle="Which farm are you at?" touch>
        <div className="plot-grid">
          {(data.farms ?? []).map((f: any) => (
            <div key={f.id} className="plot-card GREEN"
              onClick={() => setParams({ farmId: f.id })}>
              <div className="code">{f.code}</div>
              <div className="crop">{f.name}</div>
            </div>
          ))}
        </div>
      </Layout>
    );
  }

  const act = async (task: any, action: 'DONE' | 'PROBLEM' | 'SKIP', extra: any = {}) => {
    setBusy(task.id);
    try {
      await api.post(`/farming/tasks/${task.id}/action`, { action, ...extra });
      toast(action === 'DONE' ? 'Done — next date is set' : action === 'PROBLEM'
        ? 'Reported. Your manager has been told.' : 'Skipped', action === 'PROBLEM' ? 'info' : 'ok');
      setProblemFor(null);
      setQtyFor(null);
      reload();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy(null);
    }
  };

  const onDone = (t: any) => (t.requires_qty ? setQtyFor(t) : act(t, 'DONE'));

  const p = data?.progress ?? {};
  const todays = (data?.tasks ?? []).filter((t: any) => !t.isTomorrow);
  const tomorrow = (data?.tasks ?? []).filter((t: any) => t.isTomorrow);
  const donePct = p.today_total > 0 ? Math.round((p.today_done / p.today_total) * 100) : 0;

  return (
    <Layout
      title="FARM TODAY"
      subtitle={`${data?.farm?.name ?? ''} · ${date(data?.date)}`}
      touch
      actions={
        <div className="btn-row">
          <button className="btn sm" onClick={() => nav('/farm/harvest')}>🧺 Harvest</button>
          <button className="btn sm" onClick={reload}>Refresh</button>
        </div>
      }
    >
      <ErrorBanner error={error} />

      {/* §9 — the weather answer, not the weather data. */}
      {(data?.advice ?? []).map((a: any) => (
        <div key={a.code} className={`banner ${a.colour === 'RED' ? 'danger' : 'warn'} mb`}>
          <span>{a.colour === 'RED' ? '⚠' : '🌦'}</span>
          <div><b>{a.message}</b><div className="small">{a.messageHi}</div></div>
        </div>
      ))}
      {data?.weather ? (
        <div className="small muted mb">
          {data.weather.condition} · {data.weather.tempMinC}–{data.weather.tempMaxC}°C ·
          {' '}rain {data.weather.rainMm} mm ({data.weather.rainProbPct}%) ·
          {' '}wind {data.weather.windKmph} km/h
        </div>
      ) : null}

      <div className="card mb">
        <div className="card-body">
          <div className="row mb">
            <b style={{ fontSize: 17 }}>{p.today_done ?? 0} of {p.today_total ?? 0} done today</b>
            <span className="spacer" />
            {p.overdue > 0 ? <Chip tone="danger">{p.overdue} overdue</Chip> : null}
            {p.today_skipped > 0 ? <Chip tone="neutral">{p.today_skipped} held by weather</Chip> : null}
          </div>
          <div className="progress"><i style={{ width: `${donePct}%` }} /></div>
        </div>
      </div>

      {/* --- the list. Three buttons and nothing else. --- */}
      {todays.length === 0 ? (
        <Empty icon="✅" title="Nothing left for today"
          hint="The system will put tomorrow's work here by itself." />
      ) : todays.map((t: any) => (
        <div key={t.id} className={`task-card ${t.colour}`}>
          <div className="ic">{TASK_ICON[t.task_type] ?? '📌'}</div>
          <div className="body">
            <b>{t.title}</b>
            <div className="small muted">
              {t.plot_code ? `Plot-${t.plot_code}` : data?.farm?.name}
              {t.crop_name ? ` · ${t.crop_name}` : ''}
              {t.crop_age_days != null ? ` · day ${t.crop_age_days}` : ''}
              {t.isOverdue ? ` · due ${date(t.due_date)}` : ''}
            </div>
            {t.requires_qty && t.planned_qty ? (
              <div className="small mt">
                Planned: <b>{num(t.planned_qty, 1)} {t.input_uom}</b> {t.input_name}
              </div>
            ) : null}
            <div className="acts">
              <button className="btn primary" disabled={busy === t.id} onClick={() => onDone(t)}>
                ✓ DONE
              </button>
              <button className="btn danger" disabled={busy === t.id} onClick={() => setProblemFor(t)}>
                ⚠ PROBLEM
              </button>
              <button className="btn" disabled={busy === t.id} onClick={() => act(t, 'SKIP')}>
                SKIP
              </button>
              {t.task_type === 'HARVEST' ? (
                <button className="btn accent"
                  onClick={() => nav(`/farm/harvest?cycleId=${t.cycle_id}`)}>
                  🧺 Weigh &amp; grade
                </button>
              ) : null}
              {t.task_type === 'INSPECTION' && t.cycle_id ? (
                <button className="btn ghost" onClick={() => nav(`/farm/crops/${t.cycle_id}`)}>
                  Crop check →
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ))}

      {tomorrow.length ? (
        <div className="card mt">
          <div className="card-head"><h2>Tomorrow</h2></div>
          <div className="card-body">
            {tomorrow.map((t: any) => (
              <div key={t.id} className="row" style={{ padding: '5px 0' }}>
                <span>{TASK_ICON[t.task_type]}</span>
                <span>{t.title}</span>
                <span className="spacer" />
                <span className="small muted">{t.plot_code ? `Plot-${t.plot_code}` : ''}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* §5 §7 — the plots, in three colours, with the water answer on each. */}
      <h2 className="mt mb">Plots</h2>
      <div className="plot-grid">
        {(data?.plots ?? []).map((pl: any) => (
          <div key={pl.plotId} className={`plot-card ${pl.health}`}
            onClick={() => nav(`/farm/crops/${pl.cycleId}`)}>
            <div className="row">
              <span className="code">{pl.plotCode}</span>
              <span className="spacer" />
              <Light c={pl.health} />
            </div>
            <div className="crop">{pl.cropName} · day {pl.cropAgeDays}</div>
            <dl>
              <dt>Water</dt>
              <dd>{pl.irrigation.action === 'WATER_TODAY' ? '💧 Today'
                : pl.irrigation.action === 'HOLD' ? '⏸ Hold' : 'Not due'}</dd>
              <dt>Harvest</dt>
              <dd>{pl.harvest.label}</dd>
            </dl>
          </div>
        ))}
      </div>

      {/* §31 — one button closes the day and writes the report. */}
      <div className="card mt">
        <div className="card-body row">
          <div>
            <b>{data?.dayClosed ? 'Day closed' : 'Finished for today?'}</b>
            <div className="small muted">
              {data?.dayClosed
                ? `Report written at ${new Date(data.dayClose.closed_at).toLocaleTimeString('en-IN')}`
                : 'The system writes the daily report from what actually happened.'}
            </div>
          </div>
          <span className="spacer" />
          <button className="btn primary lg" disabled={!!busy}
            onClick={async () => {
              setBusy('close');
              try {
                await api.post('/farming/day-close', { farmId: data.farm.id });
                toast('Day closed — report is ready', 'ok');
                reload();
              } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(null); }
            }}>
            {data?.dayClosed ? 'Update day close' : 'DAY CLOSE'}
          </button>
        </div>
      </div>

      {/* Only genuinely unknowable inputs are ever asked for. */}
      {qtyFor ? (
        <QtyModal task={qtyFor} onClose={() => setQtyFor(null)}
          onSave={(q, note) => act(qtyFor, 'DONE', { actualQty: q, note })} />
      ) : null}
      {problemFor ? (
        <ProblemModal task={problemFor} onClose={() => setProblemFor(null)}
          onSave={(v) => act(problemFor, 'PROBLEM', v)} />
      ) : null}
    </Layout>
  );
}

function QtyModal({ task, onClose, onSave }: {
  task: any; onClose: () => void; onSave: (qty: number, note?: string) => void;
}) {
  const [qty, setQty] = useState(String(task.planned_qty ?? ''));
  const [note, setNote] = useState('');
  return (
    <Modal title={task.title} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!qty}
          onClick={() => onSave(Number(qty), note || undefined)}>APPLIED</button>
      </>}>
      <p className="small muted mb">
        Date, your name, the farm and the plot are saved automatically. Only the
        quantity actually used is needed.
      </p>
      <Field label={`How much ${task.input_name ?? 'input'} was used? (${task.input_uom ?? 'KG'})`}
        hint={task.planned_qty ? `Plan was ${num(task.planned_qty, 1)} ${task.input_uom}` : undefined}>
        <input type="number" step="0.1" value={qty} autoFocus
          onChange={(e) => setQty(e.target.value)} />
      </Field>
      <Field label="Note (optional)">
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}

function ProblemModal({ task, onClose, onSave }: {
  task: any; onClose: () => void; onSave: (v: any) => void;
}) {
  const [code, setCode] = useState('');
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState<{ data: string; mime: string } | null>(null);
  return (
    <Modal title={`Problem — ${task.title}`} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn danger" disabled={!code}
          onClick={() => onSave({
            problemCode: code, note: note || undefined,
            photoData: photo?.data, photoMime: photo?.mime,
          })}>Report problem</button>
      </>}>
      <p className="small muted mb">Pick what is wrong. Your manager is told straight away.</p>
      <Field label="What is the problem?">
        <select value={code} onChange={(e) => setCode(e.target.value)}>
          <option value="">Choose…</option>
          {PROBLEMS.map((p) => <option key={p.code} value={p.code}>{p.label}</option>)}
        </select>
      </Field>
      <Field label="Anything to add? (optional)">
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <Field label="Photo (optional)">
        <input type="file" accept="image/*" capture="environment"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setPhoto(await readPhoto(f));
          }} />
      </Field>
      {photo ? <img src={photo.data} alt="" style={{ maxWidth: 200, borderRadius: 8 }} /> : null}
    </Modal>
  );
}

/* ===========================================================================
 * §6 — THE PLOT QR SCREEN. Scan the gate, get this plot and nothing else.
 * ======================================================================== */

export function PlotScanPage() {
  const { qr } = useParams();
  const nav = useNavigate();
  const { data, loading, error } = useApi<any>(`/farming/scan/${qr}`, [qr]);

  if (loading) return <Layout title="Scanning…" touch><Loading /></Layout>;
  if (error) {
    return (
      <Layout title="Plot" touch>
        <ErrorBanner error={error} />
        <Empty icon="🏷️" title="Unknown QR code"
          hint="Check that the label on the plot gate matches this farm." />
      </Layout>
    );
  }

  const { plot, cycle, tasks, last, harvest } = data;
  return (
    <Layout title={`Plot-${plot.code}`} subtitle={plot.farm_name} touch>
      <div className="plot-scan">
        <div className="hero">
          <div className="code">Plot-{plot.code}</div>
          <div className="crop">
            {cycle ? `${cycle.crop_name} · day ${cycle.crop_age_days}` : 'No crop growing here'}
          </div>
        </div>

        {cycle ? (
          <>
            <div className="card mb">
              <div className="card-body">
                <dl className="kv">
                  <dt>Crop</dt><dd>{cycle.crop_name} ({cycle.crop_name_hi})</dd>
                  <dt>Sown</dt><dd>{date(cycle.sowing_date)}</dd>
                  <dt>Last watering</dt><dd>{last?.last_irrigation ? date(last.last_irrigation) : '—'}</dd>
                  <dt>Last spray</dt><dd>{last?.last_spray ? date(last.last_spray) : '—'}</dd>
                  <dt>Last fertiliser</dt><dd>{last?.last_fertilizer ? date(last.last_fertilizer) : '—'}</dd>
                  <dt>Next harvest</dt><dd><Light c={harvest?.band} label={harvest?.label} /></dd>
                  <dt>Health</dt><dd><Light c={cycle.health} label={cycle.health} /></dd>
                </dl>
              </div>
            </div>

            <div className="card mb">
              <div className="card-head"><h2>Today's job here</h2></div>
              <div className="card-body">
                {tasks.length === 0 ? <span className="muted">Nothing due on this plot.</span>
                  : tasks.map((t: any) => (
                    <div key={t.id} className="row" style={{ padding: '6px 0' }}>
                      <span>{TASK_ICON[t.task_type]}</span><span>{t.title}</span>
                      <span className="spacer" />
                      <span className="small muted">{date(t.due_date)}</span>
                    </div>
                  ))}
              </div>
            </div>

            <div className="btn-row">
              <button className="btn primary lg" onClick={() => nav('/farm')}>Open FARM TODAY</button>
              <button className="btn lg" onClick={() => nav(`/farm/harvest?cycleId=${cycle.id}`)}>
                🧺 Harvest
              </button>
              <button className="btn lg" onClick={() => nav(`/farm/crops/${cycle.id}`)}>
                Report a problem
              </button>
            </div>
          </>
        ) : (
          <Empty icon="🌱" title="This plot is free"
            action={<button className="btn primary" onClick={() => nav('/farm/crops/new')}>
              Start a crop here
            </button>} />
        )}
      </div>
    </Layout>
  );
}

/* ===========================================================================
 * §2 — CROP START. Four answers, then a preview of everything that follows.
 * ======================================================================== */

export function CropStartPage() {
  const nav = useNavigate();
  const toast = useToast();
  const { data: farms } = useApi<any[]>('/farming/farms');
  const { data: crops } = useApi<any[]>('/farming/crops');

  const [farmId, setFarmId] = useState('');
  const [plotId, setPlotId] = useState('');
  const [cropId, setCropId] = useState('');
  const [area, setArea] = useState('');
  const [sowingDate, setSowingDate] = useState(today());
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  const farm = (farms ?? []).find((f) => f.id === farmId);
  const { data: farmDetail } = useApi<any>(farmId ? `/farming/farms/${farmId}` : null, [farmId]);
  const freePlots = (farmDetail?.plots ?? []).filter((p: any) => !p.cycle_id);

  React.useEffect(() => {
    if (!farmId && farms?.length === 1) setFarmId(farms[0].id);
  }, [farms, farmId]);

  // The preview is the point: nobody commits a crop without seeing the
  // harvest date, the expected yield and what it is going to cost.
  React.useEffect(() => {
    if (!cropId || !Number(area)) { setPreview(null); return; }
    let alive = true;
    api.post<any>('/farming/crop-cycles/preview',
      { cropId, areaAcre: Number(area), sowingDate })
      .then((p) => alive && setPreview(p))
      .catch(() => alive && setPreview(null));
    return () => { alive = false; };
  }, [cropId, area, sowingDate]);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.post<any>('/farming/crop-cycles',
        { farmId, plotId, cropId, areaAcre: Number(area), sowingDate });
      toast(`${r.cycle_no} started — ${r.tasksCreated} jobs scheduled automatically`, 'ok');
      nav(`/farm/crops/${r.id}`);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  const ready = farmId && plotId && cropId && Number(area) > 0;

  return (
    <Layout title="Start a crop" subtitle="Four answers. The system does the rest." touch>
      <ErrorBanner error={error} />
      <Steps steps={['Crop', 'Plot', 'Area', 'Date', 'Confirm']} current={
        !cropId ? 0 : !plotId ? 1 : !Number(area) ? 2 : !sowingDate ? 3 : 4} />

      <div className="grid sidebar-right">
        <div className="card">
          <div className="card-body">
            {(farms ?? []).length > 1 ? (
              <Field label="Which farm?">
                <select value={farmId} onChange={(e) => { setFarmId(e.target.value); setPlotId(''); }}>
                  <option value="">Choose…</option>
                  {(farms ?? []).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </Field>
            ) : null}

            <Field label="Which crop?">
              <select value={cropId} onChange={(e) => setCropId(e.target.value)}>
                <option value="">Choose…</option>
                {(crops ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} — {c.name_hi} ({c.duration_days} days)
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Which plot?"
              hint={farmId && !freePlots.length ? 'Every plot on this farm already has a crop.' : undefined}>
              <select value={plotId} onChange={(e) => {
                setPlotId(e.target.value);
                const p = freePlots.find((x: any) => x.id === e.target.value);
                if (p && !area) setArea(String(p.area_acre));
              }} disabled={!farmId}>
                <option value="">Choose…</option>
                {freePlots.map((p: any) => (
                  <option key={p.id} value={p.id}>
                    Plot-{p.code} {p.name ? `(${p.name})` : ''} — {p.area_acre} acre
                  </option>
                ))}
              </select>
            </Field>

            <Field label="How much area? (acre)">
              <input type="number" step="0.1" value={area} onChange={(e) => setArea(e.target.value)} />
            </Field>

            <Field label="Sowing date" hint="Everything else is calculated from this.">
              <input type="date" value={sowingDate} onChange={(e) => setSowingDate(e.target.value)} />
            </Field>

            <button className="btn primary block lg" disabled={!ready || busy} onClick={save}>
              {busy ? 'Starting…' : 'Start crop & build the calendar'}
            </button>
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>What the system will do</h2></div>
            <div className="card-body">
              {!preview ? (
                <span className="muted small">Choose a crop and an area to see the plan.</span>
              ) : (
                <>
                  <dl className="kv">
                    <dt>Harvest from</dt><dd>{date(preview.expectedHarvestDate)}</dd>
                    <dt>Harvest until</dt><dd>{date(preview.expectedHarvestEndDate)}</dd>
                    <dt>Crop duration</dt><dd>{preview.durationDays} days</dd>
                    <dt>Expected yield</dt><dd>{num(preview.expectedYieldKg, 0)} kg</dd>
                    <dt>Expected cost</dt><dd>{inr(preview.estimatedCost, 0)}</dd>
                    <dt>Cost per kg</dt><dd>{inr(preview.estimatedCostPerKg)}</dd>
                  </dl>
                  {preview.usedHistory ? (
                    <div className="banner info mt">
                      <span>📈</span>
                      <div className="small">
                        The yield estimate is blended with what this crop actually
                        gave you last time, not just the book figure.
                      </div>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </div>

          {preview ? (
            <div className="card">
              <div className="card-head"><h2>{preview.taskSummary.total} jobs, scheduled now</h2></div>
              <div className="card-body">
                <dl className="kv">
                  <dt>💧 Irrigation</dt><dd>{preview.taskSummary.irrigation}</dd>
                  <dt>🧪 Fertiliser</dt><dd>{preview.taskSummary.fertilizer}</dd>
                  <dt>🌫️ Spray checks</dt><dd>{preview.taskSummary.spray}</dd>
                  <dt>🔍 Inspections</dt><dd>{preview.taskSummary.inspection}</dd>
                </dl>
                <div className="small muted mt">
                  These appear on FARM TODAY on the day they are due — nobody has
                  to remember them.
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </Layout>
  );
}

/* ===========================================================================
 * Crop list and the one-screen crop file.
 * ======================================================================== */

export function CropListPage() {
  const nav = useNavigate();
  const [status, setStatus] = useState('');
  const { data, loading, error } = useApi<any[]>(`/farming/crop-cycles?status=${status}`, [status]);

  const cols: Col<any>[] = [
    { key: 'h', head: '', width: 34, render: (c) => <Light c={c.health} /> },
    { key: 'p', head: 'Plot', render: (c) => (
      <div><b>Plot-{c.plot_code}</b><div className="small muted">{c.farm_name}</div></div>) },
    { key: 'c', head: 'Crop', render: (c) => (
      <div><b>{c.crop_name}</b><div className="small muted">{c.cycle_no} · {c.area_acre} acre</div></div>) },
    { key: 'a', head: 'Age', num: true, render: (c) => `${c.crop_age_days}d` },
    { key: 'hv', head: 'Harvest', render: (c) => (
      c.days_to_harvest > 0
        ? <span className="small">in {c.days_to_harvest}d · {date(c.expected_harvest_date)}</span>
        : <Chip tone={c.days_to_harvest < -2 ? 'danger' : 'ok'}>
            {c.days_to_harvest < -2 ? 'delayed' : 'ready'}</Chip>) },
    { key: 'y', head: 'Yield', num: true, render: (c) => (
      <div>{num(c.harvested_kg, 0)}<div className="small muted">of {num(c.expected_yield_kg, 0)}</div></div>) },
    { key: 'w', head: 'Work', num: true, render: (c) => (
      c.overdue_tasks > 0 ? <Chip tone="danger">{c.overdue_tasks} late</Chip>
        : c.today_tasks > 0 ? <Chip tone="warn">{c.today_tasks} today</Chip>
        : <span className="muted small">clear</span>) },
    { key: 's', head: 'Status', render: (c) => <Chip value={c.status} /> },
  ];

  return (
    <Layout title="Crops" subtitle="Every crop cycle, coloured by what needs attention"
      actions={<button className="btn primary sm" onClick={() => nav('/farm/crops/new')}>
        Start a crop
      </button>}>
      <ErrorBanner error={error} />
      <div className="search-bar">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All crops</option>
          <option value="GROWING">Growing</option>
          <option value="HARVESTING">Harvesting</option>
          <option value="CLOSED">Closed</option>
        </select>
      </div>
      <div className="card"><div className="card-body tight">
        <DataTable rows={data ?? []} cols={cols} loading={loading}
          rowTone={(c) => (c.health === 'RED' ? 'crit' : c.health === 'YELLOW' ? 'warn' : undefined)}
          onRowClick={(c) => nav(`/farm/crops/${c.cycle_id}`)}
          empty={<Empty icon="🌾" title="No crops yet"
            action={<button className="btn primary" onClick={() => nav('/farm/crops/new')}>
              Start the first one</button>} />} />
      </div></div>
    </Layout>
  );
}

export function CropDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<any>(`/farming/crop-cycles/${id}`, [id]);
  const [tab, setTab] = useState<'work' | 'diary' | 'money' | 'harvest'>('work');
  const [checking, setChecking] = useState(false);
  const [closing, setClosing] = useState(false);
  const [expensing, setExpensing] = useState(false);

  if (loading) return <Layout title="Crop"><Loading /></Layout>;
  if (!data?.cycle) return <Layout title="Crop"><ErrorBanner error={error} /></Layout>;

  const c = data.cycle;
  const yv = data.yieldVariance;

  return (
    <Layout
      title={`${c.crop_name} · Plot-${c.plot_code}`}
      subtitle={`${c.cycle_no} · sown ${date(c.sowing_date)} · day ${c.crop_age_days} · ${c.area_acre} acre`}
      actions={
        <div className="btn-row">
          <button className="btn sm" onClick={() => setChecking(true)}>🔍 Crop check</button>
          <button className="btn sm" onClick={() => setExpensing(true)}>₹ Expense</button>
          <button className="btn sm accent" onClick={() => nav(`/farm/harvest?cycleId=${c.id}`)}>
            🧺 Harvest
          </button>
          {can('farming.crop.close') && !['CLOSED', 'FAILED'].includes(c.status) ? (
            <button className="btn sm primary" onClick={() => setClosing(true)}>Close crop</button>
          ) : null}
        </div>
      }
    >
      <ErrorBanner error={error} />

      <div className="grid c4 mb">
        <Kpi label="Health" value={<Light c={c.health} label={c.health} />}
          tone={c.health === 'RED' ? 'crit' : c.health === 'YELLOW' ? 'warn' : 'good'}
          foot={c.health_note ?? '—'} />
        <Kpi label="Harvest" value={data.harvest.label}
          tone={data.harvest.band === 'RED' ? 'crit' : data.harvest.band === 'YELLOW' ? 'warn' : undefined}
          foot={`${date(c.expected_harvest_date)} → ${date(c.expected_harvest_end_date)}`} />
        {/* The estimate becomes a verdict only when picking is over. */}
        <Kpi label="Harvested" value={`${num(c.harvested_kg, 0)} kg`}
          tone={!data.yieldWindowClosed ? undefined
            : yv.colour === 'RED' ? 'crit' : yv.colour === 'YELLOW' ? 'warn' : undefined}
          foot={data.yieldWindowClosed
            ? `expected ${num(c.expected_yield_kg, 0)} kg · ${yv.label}`
            : `${num(c.expected_yield_kg, 0)} kg expected · picking until ${date(c.expected_harvest_end_date)}`} />
        {data.cost ? (
          <Kpi label={data.yieldWindowClosed ? 'Cost per kg' : 'Cost per kg so far'}
            value={data.cost.costPerKg ? inr(data.cost.costPerKg) : '—'}
            foot={data.cost.costPerKg
              ? `${inr(data.cost.totalCost, 0)} spent on ${num(data.cost.sellableKg, 0)} kg`
                + (data.yieldWindowClosed ? '' : ' — falls as picking continues')
              : 'no produce yet — nothing to divide by'} />
        ) : (
          <Kpi label="Dispatched" value={`${num(c.dispatched_kg, 0)} kg`}
            foot={`${num(c.waste_kg, 0)} kg waste`} />
        )}
      </div>

      <div className="tabs">
        {([['work', 'Calendar'], ['diary', 'Photo diary'], ['harvest', 'Harvests'],
           ...(data.cost ? [['money', 'Cost & profit']] : [])] as const).map(([k, label]) => (
          <button key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k as any)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'work' ? (
        <div className="card"><div className="card-body tight">
          <DataTable rows={data.tasks} cols={[
            { key: 'l', head: '', width: 34, render: (t: any) => <Light c={t.colour} /> },
            { key: 'd', head: 'Due', render: (t: any) => (
              <div>{date(t.due_date)}<div className="small muted">day {t.day_number}</div></div>) },
            { key: 't', head: 'Job', render: (t: any) => (
              <div>{TASK_ICON[t.task_type]} {t.title}
                {t.note ? <div className="small muted">{t.note}</div> : null}
                {t.auto_skipped_reason ? <div className="small muted">↻ {t.auto_skipped_reason}</div> : null}
              </div>) },
            { key: 'q', head: 'Used', num: true, render: (t: any) =>
              t.actual_qty != null ? `${num(t.actual_qty, 1)} ${t.input_uom ?? ''}`
                : t.planned_qty != null ? <span className="muted">{num(t.planned_qty, 1)} planned</span> : '—' },
            { key: 's', head: 'Status', render: (t: any) => <Chip value={t.status} /> },
            { key: 'b', head: 'By', render: (t: any) => <span className="small muted">{t.done_by_name ?? '—'}</span> },
          ]} empty={<Empty title="No jobs scheduled" />} />
        </div></div>
      ) : null}

      {tab === 'diary' ? (
        <div className="card"><div className="card-body">
          {/* §11 — the timeline builds itself out of what was recorded. */}
          <ul className="timeline">
            {data.diary.map((d: any, i: number) => (
              <li key={i} className={d.health}>
                <div className="day">Day {d.day ?? 0} · {date(d.at)}</div>
                <div>{d.label}</div>
                {d.photo ? <img src={d.photo} alt="" /> : null}
              </li>
            ))}
          </ul>
        </div></div>
      ) : null}

      {tab === 'harvest' ? (
        <div className="card"><div className="card-body tight">
          <DataTable rows={data.harvests} cols={[
            { key: 'n', head: 'Harvest', render: (h: any) => (
              <div><b className="mono">{h.harvest_no}</b>
                <div className="small muted">{date(h.harvest_date)} · day {h.crop_age_days}</div></div>) },
            { key: 'w', head: 'Net', num: true, render: (h: any) => `${num(h.net_weight_kg, 1)} kg` },
            { key: 'c', head: 'Crates', num: true, render: (h: any) => h.crate_count },
            { key: 'g', head: 'Grades', render: (h: any) => (
              <div className="row wrap" style={{ gap: 6 }}>
                {(h.lines ?? []).map((l: any) => (
                  <Chip key={l.grade}
                    tone={l.grade === 'A' ? 'ok' : l.grade === 'B' ? 'warn'
                      : l.grade === 'C' ? 'neutral' : 'danger'}>
                    {l.grade} {num(l.weightKg, 0)}kg
                  </Chip>
                ))}
              </div>) },
            { key: 's', head: 'Status', render: (h: any) => <Chip value={h.status} /> },
            { key: 'b', head: 'By', render: (h: any) => <span className="small muted">{h.harvested_by_name}</span> },
          ]} empty={<Empty icon="🧺" title="Nothing harvested yet" />} />
        </div></div>
      ) : null}

      {tab === 'money' && data.cost ? (
        <div className="grid c2">
          <div className="card">
            <div className="card-head"><h2>Where the money went</h2></div>
            <div className="card-body">
              <dl className="kv">
                {Object.entries(data.cost.byType).map(([k, v]) => (
                  <React.Fragment key={k}>
                    <dt>{k.replace(/_/g, ' ').toLowerCase()}</dt><dd>{inr(v as number, 0)}</dd>
                  </React.Fragment>
                ))}
                <dt><b>Total</b></dt><dd><b>{inr(data.cost.totalCost, 0)}</b></dd>
                <dt>Against estimate</dt>
                <dd>{data.cost.budgetUsedPct != null ? `${num(data.cost.budgetUsedPct, 0)}% of ${inr(c.estimated_cost, 0)}` : '—'}</dd>
                <dt><b>Actual cost / kg</b></dt>
                <dd><b>{data.cost.costPerKg ? inr(data.cost.costPerKg) : '—'}</b></dd>
              </dl>
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h2>Expenses</h2></div>
            <div className="card-body tight">
              <DataTable rows={data.expenses} cols={[
                { key: 'd', head: 'Date', render: (e: any) => date(e.expense_date) },
                { key: 't', head: 'Type', render: (e: any) => <Chip tone="neutral">{e.expense_type}</Chip> },
                { key: 'n', head: 'Note', render: (e: any) => <span className="small">{e.note ?? '—'}</span> },
                { key: 'a', head: 'Amount', num: true, render: (e: any) => inr(e.amount, 0) },
              ]} empty={<Empty title="No expenses recorded" />} />
            </div>
          </div>
        </div>
      ) : null}

      {checking ? (
        <CropCheckModal cycleId={c.id} onClose={() => setChecking(false)}
          onDone={() => { setChecking(false); reload(); toast('Crop check saved', 'ok'); }} />
      ) : null}
      {expensing ? (
        <ExpenseModal farmId={c.farm_id} cycleId={c.id} onClose={() => setExpensing(false)}
          onDone={() => { setExpensing(false); reload(); toast('Expense saved', 'ok'); }} />
      ) : null}
      {closing ? (
        <CloseCropModal cycle={c} onClose={() => setClosing(false)}
          onDone={() => { setClosing(false); reload(); }} />
      ) : null}
    </Layout>
  );
}

function CropCheckModal({ cycleId, onClose, onDone }: {
  cycleId: string; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [health, setHealth] = useState<Colour | ''>('');
  const [note, setNote] = useState('');
  const [stage, setStage] = useState('');
  const [photo, setPhoto] = useState<{ data: string; mime: string } | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Modal title="How is the crop?" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!health || busy} onClick={async () => {
          setBusy(true);
          try {
            await api.post('/farming/observations', {
              cycleId, health, note: note || undefined, stage: stage || null,
              photoData: photo?.data, photoMime: photo?.mime,
            });
            onDone();
          } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
        }}>Save</button>
      </>}>
      <p className="small muted mb">
        One answer is enough. Yellow or red goes to the manager by itself.
      </p>
      <div className="btn-row mb">
        {(['GREEN', 'YELLOW', 'RED'] as Colour[]).map((h) => (
          <button key={h} type="button"
            className={`btn lg ${health === h ? (h === 'RED' ? 'danger' : h === 'YELLOW' ? 'accent' : 'primary') : ''}`}
            onClick={() => setHealth(h)}>
            {h === 'GREEN' ? '🟢 Good' : h === 'YELLOW' ? '🟡 Problem' : '🔴 Critical'}
          </button>
        ))}
      </div>
      <Field label="Growth stage (optional)">
        <select value={stage} onChange={(e) => setStage(e.target.value)}>
          <option value="">—</option>
          {['GERMINATION', 'VEGETATIVE', 'FLOWERING', 'FRUITING', 'HARVEST'].map((s) =>
            <option key={s} value={s}>{s.toLowerCase()}</option>)}
        </select>
      </Field>
      <Field label="Note (optional)">
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <Field label="Photo — builds the crop diary">
        <input type="file" accept="image/*" capture="environment"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setPhoto(await readPhoto(f));
          }} />
      </Field>
      {photo ? <img src={photo.data} alt="" style={{ maxWidth: 220, borderRadius: 8 }} /> : null}
    </Modal>
  );
}

function ExpenseModal({ farmId, cycleId, onClose, onDone }: {
  farmId: string; cycleId?: string | null; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [type, setType] = useState('LABOUR');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Add expense" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!Number(amount) || busy} onClick={async () => {
          setBusy(true);
          try {
            await api.post('/farming/expenses',
              { farmId, cycleId: cycleId ?? null, expenseType: type, amount: Number(amount), note });
            onDone();
          } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
        }}>SAVE</button>
      </>}>
      {/* §18 — three fields. Farm, plot, crop, date and user are attached for you. */}
      <p className="small muted mb">
        The farm, plot, crop, date and your name are attached automatically.
      </p>
      <Field label="What was it for?">
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {EXPENSE_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ').toLowerCase()}</option>)}
        </select>
      </Field>
      <Field label="Amount (₹)">
        <input type="number" step="1" value={amount} autoFocus
          onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <Field label="Note (optional)">
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}

function CloseCropModal({ cycle, onClose, onDone }: {
  cycle: any; onClose: () => void; onDone: () => void;
}) {
  const nav = useNavigate();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [failed, setFailed] = useState(false);
  const [revenue, setRevenue] = useState('');
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const { data: planning } = useApi<any>(
    result ? `/farming/planning?plotId=${cycle.plot_id}` : null, [result]);

  if (result) {
    // §30 — the crop is finished, so the very next question is what follows it.
    return (
      <Modal title="Crop closed — what next?" wide onClose={onClose}
        footer={<>
          <button className="btn" onClick={() => { onClose(); onDone(); }}>Later</button>
          <button className="btn primary" onClick={() => nav('/farm/crops/new')}>Start next crop</button>
        </>}>
        <div className="grid c2 mb">
          <Kpi label="Harvested" value={`${num(result.cycle.harvested_kg, 0)} kg`}
            foot={result.yieldVariance.label}
            tone={result.yieldVariance.colour === 'RED' ? 'crit'
              : result.yieldVariance.colour === 'YELLOW' ? 'warn' : 'good'} />
          <Kpi label="Actual cost per kg"
            value={result.cost.costPerKg ? inr(result.cost.costPerKg) : '—'}
            foot={`${inr(result.cost.totalCost, 0)} total`} />
        </div>
        <h3 className="mb">Suggested next crop for Plot-{cycle.plot_code}</h3>
        {!planning ? <Loading /> : (
          <DataTable rows={planning.suggestions.slice(0, 5)} cols={[
            { key: 'c', head: 'Crop', render: (s: any) => <b>{s.cropName}</b> },
            { key: 'w', head: 'Why', render: (s: any) => (
              <div className="small">
                {s.reasons.map((r: string, i: number) => <div key={i}>· {r}</div>)}
                {s.blockers.map((b: string, i: number) => (
                  <div key={i} className="chip danger" style={{ marginTop: 4 }}>{b}</div>))}
              </div>) },
            { key: 's', head: 'Score', num: true, render: (s: any) => (
              <Chip tone={s.recommended ? 'ok' : 'neutral'}>{num(s.score, 0)}</Chip>) },
          ]} />
        )}
      </Modal>
    );
  }

  return (
    <Modal title={`Close ${cycle.cycle_no}`} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || (failed && !reason)} onClick={async () => {
          setBusy(true);
          try {
            setResult(await api.post<any>(`/farming/crop-cycles/${cycle.id}/close`, {
              reason: reason || undefined, failed,
              revenue: revenue ? Number(revenue) : null,
            }));
          } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
        }}>Close crop</button>
      </>}>
      <Field label="Revenue from this crop (optional)"
        hint="Leave blank if it is still being sold — profit updates as sales land.">
        <input type="number" value={revenue} onChange={(e) => setRevenue(e.target.value)} />
      </Field>
      <Field label="Note">
        <input value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="Season finished" />
      </Field>
      <label className="row" style={{ gap: 8 }}>
        <input type="checkbox" checked={failed} onChange={(e) => setFailed(e.target.checked)}
          style={{ width: 'auto' }} />
        <span>The crop failed</span>
      </label>
      {failed ? <div className="small muted mt">A failed crop needs a note — it feeds next season's plan.</div> : null}
    </Modal>
  );
}

/* ===========================================================================
 * §13 §14 §15 — HARVEST. Scan · weigh · grade · print.
 * ======================================================================== */

export function HarvestPage() {
  const nav = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();
  const { data: cycles } = useApi<any[]>('/farming/crop-cycles?status=');
  const [cycleId, setCycleId] = useState(params.get('cycleId') ?? '');
  const [gross, setGross] = useState('');
  const [crates, setCrates] = useState('');
  const [containerTypeId, setContainerTypeId] = useState('');
  const { data: containers } = useApi<any[]>('/masters/container-types');
  const [grades, setGrades] = useState<Record<string, string>>({ A: '', B: '', C: '', WASTE: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  const [done, setDone] = useState<any>(null);

  const pickable = (cycles ?? []).filter((c) => ['GROWING', 'HARVESTING'].includes(c.status));
  const cycle = pickable.find((c) => c.cycle_id === cycleId);

  const tare = useMemo(() => {
    const ct = (containers ?? []).find((c) => c.id === containerTypeId);
    return ct ? Number(ct.tare_kg) * (Number(crates) || 0) : 0;
  }, [containerTypeId, crates, containers]);
  const net = Math.max((Number(gross) || 0) - tare, 0);
  const gradedTotal = Object.values(grades).reduce((a, v) => a + (Number(v) || 0), 0);
  const gradesEntered = gradedTotal > 0;
  const gradesMatch = !gradesEntered || Math.abs(gradedTotal - net) <= Math.max(net * 0.02, 0.5);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.post<any>('/farming/harvests', {
        cycleId,
        grossWeightKg: Number(gross),
        crateCount: Number(crates) || 0,
        containerTypeId: containerTypeId || null,
        grades: Object.entries(grades)
          .filter(([, v]) => Number(v) > 0)
          .map(([grade, v]) => ({ grade, weightKg: Number(v) })),
      });
      setDone(r);
      toast(`${r.harvest_no} recorded — warehouse has been told`, 'ok');
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  if (done) {
    // §13 — the printed label carries everything the system already knew.
    return (
      <Layout title="Harvest recorded" touch>
        <div className="card mb">
          <div className="card-head"><h2>Crate label — {done.label.code}</h2></div>
          <div className="card-body">
            <dl className="kv">
              <dt>Farm</dt><dd>{done.label.farm}</dd>
              <dt>Plot</dt><dd>Plot-{done.label.plot}</dd>
              <dt>Crop</dt><dd>{done.label.crop}</dd>
              <dt>Harvest</dt><dd>{done.label.harvestNo}</dd>
              <dt>Date</dt><dd>{date(done.label.harvestDate)}</dd>
              <dt>Crop age</dt><dd>{done.label.cropAgeDays} days</dd>
              <dt>Net weight</dt><dd>{num(done.label.netKg, 2)} kg in {done.label.crates} crates</dd>
            </dl>
            <div className="row wrap mt" style={{ gap: 8 }}>
              {done.lines.map((l: any) => (
                <Chip key={l.grade} tone={l.grade === 'A' ? 'ok' : l.grade === 'B' ? 'warn'
                  : l.grade === 'C' ? 'neutral' : 'danger'}>
                  {l.grade} · {num(l.weightKg, 1)} kg → {l.destination}
                </Chip>
              ))}
            </div>
            {done.harvestProgress?.pctOfExpected != null ? (
              <div className="small muted mt">
                {num(done.harvestProgress.harvestedKg, 0)} kg of an expected{' '}
                {num(done.harvestProgress.expectedYieldKg, 0)} kg
                ({num(done.harvestProgress.pctOfExpected, 0)}%), window ends{' '}
                {date(done.harvestProgress.windowEnds)}.
              </div>
            ) : null}
          </div>
        </div>
        <div className="btn-row">
          <button className="btn primary lg" onClick={() => window.print()}>🖨 Print label</button>
          <button className="btn lg accent" onClick={() => nav('/farm/dispatch')}>
            Send to warehouse →
          </button>
          <button className="btn lg" onClick={() => { setDone(null); setGross(''); setCrates('');
            setGrades({ A: '', B: '', C: '', WASTE: '' }); }}>Weigh another</button>
        </div>
      </Layout>
    );
  }

  return (
    <Layout title="Harvest" subtitle="Weigh · grade · print" touch>
      <ErrorBanner error={error} />
      <Steps steps={['Crop', 'Weigh', 'Grade', 'Print']} current={
        !cycleId ? 0 : !Number(gross) ? 1 : !gradesEntered ? 2 : 3} />

      <div className="grid sidebar-right">
        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>Which plot?</h2></div>
            <div className="card-body">
              <div className="plot-grid">
                {pickable.map((c) => (
                  <div key={c.cycle_id}
                    className={`plot-card ${cycleId === c.cycle_id ? 'YELLOW' : c.health}`}
                    onClick={() => setCycleId(c.cycle_id)}>
                    <div className="row">
                      <span className="code">{c.plot_code}</span>
                      <span className="spacer" />
                      {cycleId === c.cycle_id ? <Chip tone="primary">selected</Chip> : null}
                    </div>
                    <div className="crop">{c.crop_name} · day {c.crop_age_days}</div>
                    <dl>
                      <dt>Harvest</dt>
                      <dd>{c.days_to_harvest > 0 ? `in ${c.days_to_harvest}d` : 'ready'}</dd>
                    </dl>
                  </div>
                ))}
              </div>
              {!pickable.length ? <Empty icon="🌱" title="No crop is ready to pick" /> : null}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h2>Weigh</h2></div>
            <div className="card-body">
              {/* §14 — a connected scale writes this itself; typing is the fallback. */}
              <div className="scale-readout">
                {num(net, 2)} kg
                <small>net after {num(tare, 2)} kg crate tare — the system subtracts it</small>
              </div>
              <div className="grid c3">
                <Field label="Gross weight (kg)">
                  <input type="number" step="0.01" value={gross}
                    onChange={(e) => setGross(e.target.value)} />
                </Field>
                <Field label="Crates">
                  <input type="number" value={crates} onChange={(e) => setCrates(e.target.value)} />
                </Field>
                <Field label="Crate type">
                  <select value={containerTypeId} onChange={(e) => setContainerTypeId(e.target.value)}>
                    <option value="">No crate</option>
                    {(containers ?? []).map((c) => (
                      <option key={c.id} value={c.id}>{c.name} ({c.tare_kg} kg)</option>
                    ))}
                  </select>
                </Field>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Grade</h2>
              <span className={gradesMatch ? 'small muted' : 'chip danger'}>
                {num(gradedTotal, 1)} of {num(net, 1)} kg
              </span>
            </div>
            <div className="card-body">
              {/* §15 — four grades, and each already knows where it goes. */}
              {[
                { g: 'A', label: '🟢 A — Retail', dest: 'Retail shelves' },
                { g: 'B', label: '🟡 B — Hotel / B2B', dest: 'Bulk buyers' },
                { g: 'C', label: '🟠 C — Discount', dest: 'Processing' },
                { g: 'WASTE', label: '🔴 Waste', dest: 'Recorded as a loss' },
              ].map((row) => (
                <div key={row.g} className="grade-row">
                  <b>{row.label}</b>
                  <span className="small muted">{row.dest}</span>
                  <input type="number" step="0.1" value={grades[row.g]} placeholder="kg"
                    onChange={(e) => setGrades({ ...grades, [row.g]: e.target.value })} />
                  <span className="small muted">
                    {net > 0 && Number(grades[row.g]) > 0
                      ? `${num((Number(grades[row.g]) / net) * 100, 0)}%` : ''}
                  </span>
                </div>
              ))}
              <div className="small muted mt">
                Leave every grade blank and the whole lot is recorded as grade A.
              </div>
            </div>
          </div>

          <button className="btn primary block lg"
            disabled={!cycleId || !Number(gross) || !gradesMatch || busy} onClick={save}>
            {busy ? 'Saving…' : 'Record harvest & print label'}
          </button>
          {!gradesMatch ? (
            <div className="banner danger">
              <span>⚠</span>
              <div>The grades add up to {num(gradedTotal, 1)} kg but the net weight is
                {' '}{num(net, 1)} kg. They must match.</div>
            </div>
          ) : null}
        </div>

        <div className="card">
          <div className="card-head"><h2>The system fills in</h2></div>
          <div className="card-body">
            <dl className="kv">
              <dt>Farm</dt><dd>{cycle?.farm_name ?? '—'}</dd>
              <dt>Plot</dt><dd>{cycle ? `Plot-${cycle.plot_code}` : '—'}</dd>
              <dt>Crop</dt><dd>{cycle?.crop_name ?? '—'}</dd>
              <dt>Crop age</dt><dd>{cycle ? `${cycle.crop_age_days} days` : '—'}</dd>
              <dt>Date</dt><dd>{date(today())}</dd>
              <dt>Batch no.</dt><dd className="muted">on receipt</dd>
              <dt>Harvested by</dt><dd>you</dd>
            </dl>
          </div>
        </div>
      </div>
    </Layout>
  );
}

/* ===========================================================================
 * §16 §17 — DISPATCH AND RECEIVE. The variance is the whole point.
 * ======================================================================== */

export function DispatchPage() {
  const toast = useToast();
  const { can, warehouseId } = useAuth();
  const { data: ready, reload: reloadReady } = useApi<any[]>('/farming/harvests?status=READY');
  const { data: partial } = useApi<any[]>('/farming/harvests?status=PART_DISPATCHED');
  const { data: open, reload: reloadOpen } = useApi<any[]>('/farming/dispatches?status=DISPATCHED');
  const { data: recent } = useApi<any[]>('/farming/dispatches?status=RECEIVED');
  const [receiving, setReceiving] = useState<any>(null);
  const [sending, setSending] = useState(false);

  const sendable = [...(ready ?? []), ...(partial ?? [])];

  return (
    <Layout title="Farm to warehouse" subtitle="Send, then weigh what actually arrived"
      actions={can('farming.dispatch.create') && sendable.length ? (
        <button className="btn primary sm" onClick={() => setSending(true)}>Send to warehouse</button>
      ) : null}>

      <div className="card mb">
        <div className="card-head"><h2>Waiting to be received</h2></div>
        <div className="card-body tight">
          <DataTable rows={open ?? []} cols={[
            { key: 'n', head: 'Note', render: (d: any) => (
              <div><b className="mono">{d.dispatch_no}</b>
                <div className="small muted">{date(d.dispatch_date)} · {d.farm_name}</div></div>) },
            { key: 'w', head: 'Sent', num: true, render: (d: any) => `${num(d.dispatch_weight_kg, 1)} kg` },
            { key: 'l', head: 'What', render: (d: any) => (
              <div className="row wrap" style={{ gap: 6 }}>
                {(d.lines ?? []).map((l: any) => (
                  <Chip key={l.id} tone="neutral">{l.productName} {l.grade} · {num(l.dispatchWeightKg, 0)}kg</Chip>
                ))}
              </div>) },
            { key: 'v', head: 'Vehicle', render: (d: any) => <span className="small">{d.vehicle_reg ?? '—'}</span> },
            { key: 'a', head: '', width: 150, render: (d: any) =>
              can('farming.dispatch.receive')
                ? <button className="btn sm primary" onClick={() => setReceiving(d)}>Weigh &amp; receive</button>
                : <Chip value="DISPATCHED" /> },
          ]} empty={<Empty icon="🚜" title="Nothing on the road" />} />
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Received</h2></div>
        <div className="card-body tight">
          <DataTable rows={recent ?? []} cols={[
            { key: 'n', head: 'Note', render: (d: any) => <b className="mono">{d.dispatch_no}</b> },
            { key: 'd', head: 'Date', render: (d: any) => date(d.dispatch_date) },
            { key: 's', head: 'Farm sent', num: true, render: (d: any) => num(d.dispatch_weight_kg, 1) },
            { key: 'r', head: 'WH received', num: true, render: (d: any) => num(d.received_weight_kg, 1) },
            { key: 'v', head: 'Variance', num: true, render: (d: any) => (
              <Chip tone={d.variance_band === 'GREEN' ? 'ok' : d.variance_band === 'AMBER' ? 'warn' : 'danger'}>
                {num(d.variance_kg, 1)} kg ({num(d.variance_pct, 2)}%)
              </Chip>) },
            { key: 'x', head: 'Reason', render: (d: any) => <span className="small muted">{d.variance_reason ?? '—'}</span> },
          ]} rowTone={(d: any) => (['RED', 'CRITICAL'].includes(d.variance_band) ? 'crit'
            : d.variance_band === 'AMBER' ? 'warn' : undefined)}
            empty={<Empty title="Nothing received yet" />} />
        </div>
      </div>

      {sending ? (
        <SendModal harvests={sendable} warehouseId={warehouseId} onClose={() => setSending(false)}
          onDone={() => { setSending(false); reloadReady(); reloadOpen(); toast('Sent — warehouse notified', 'ok'); }} />
      ) : null}
      {receiving ? (
        <ReceiveModal dispatch={receiving} onClose={() => setReceiving(null)}
          onDone={() => { setReceiving(null); reloadOpen(); }} />
      ) : null}
    </Layout>
  );
}

function SendModal({ harvests, warehouseId, onClose, onDone }: {
  harvests: any[]; warehouseId: string | null; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const { data: warehouses } = useApi<any[]>('/masters/warehouses');
  const { data: vehicles } = useApi<any[]>('/masters/vehicles');
  const [whId, setWhId] = useState(warehouseId ?? '');
  const [vehicleReg, setVehicleReg] = useState('');
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  // Waste never travels: it is a loss on the farm, not stock in the warehouse.
  const rows = harvests.flatMap((h) => (h.lines ?? [])
    .filter((l: any) => l.grade !== 'WASTE' && Number(l.weightKg) - Number(l.dispatchedKg) > 0.001)
    .map((l: any) => ({
      key: `${h.id}:${l.grade}`, harvestId: h.id, harvestNo: h.harvest_no,
      product: h.product_name, plot: h.plot_code, grade: l.grade,
      remaining: Number(l.weightKg) - Number(l.dispatchedKg), crates: l.crateCount,
    })));

  const chosen = rows.filter((r) => picked[r.key]);
  const total = chosen.reduce((a, r) => a + r.remaining, 0);

  return (
    <Modal title="Send to warehouse" wide onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!whId || !chosen.length || busy} onClick={async () => {
          setBusy(true);
          try {
            await api.post('/farming/dispatches', {
              farmId: harvests[0].farm_id, warehouseId: whId,
              vehicleReg: vehicleReg || null,
              lines: chosen.map((r) => ({
                harvestId: r.harvestId, grade: r.grade,
                weightKg: r.remaining, crateCount: r.crates,
              })),
            });
            onDone();
          } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
        }}>Send {num(total, 1)} kg</button>
      </>}>
      <div className="grid c2 mb">
        <Field label="To which warehouse?">
          <select value={whId} onChange={(e) => setWhId(e.target.value)}>
            <option value="">Choose…</option>
            {(warehouses ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </Field>
        <Field label="Vehicle (optional)">
          <select value={vehicleReg} onChange={(e) => setVehicleReg(e.target.value)}>
            <option value="">—</option>
            {(vehicles ?? []).map((v) => <option key={v.id} value={v.reg_no}>{v.reg_no}</option>)}
          </select>
        </Field>
      </div>
      <DataTable rows={rows} cols={[
        { key: 'x', head: '', width: 40, render: (r: any) => (
          <input type="checkbox" checked={!!picked[r.key]} style={{ width: 'auto' }}
            onChange={(e) => setPicked({ ...picked, [r.key]: e.target.checked })} />) },
        { key: 'h', head: 'Harvest', render: (r: any) => (
          <div><b className="mono small">{r.harvestNo}</b>
            <div className="small muted">Plot-{r.plot} · {r.product}</div></div>) },
        { key: 'g', head: 'Grade', render: (r: any) => (
          <Chip tone={r.grade === 'A' ? 'ok' : r.grade === 'B' ? 'warn' : 'neutral'}>{r.grade}</Chip>) },
        { key: 'w', head: 'Available', num: true, render: (r: any) => `${num(r.remaining, 1)} kg` },
      ]} empty={<Empty title="Nothing left to send" />} />
    </Modal>
  );
}

function ReceiveModal({ dispatch, onClose, onDone }: {
  dispatch: any; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [weights, setWeights] = useState<Record<string, string>>(
    Object.fromEntries((dispatch.lines ?? []).map((l: any) => [l.id, String(l.dispatchWeightKg)])));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => idempotencyKey('farm-recv'));

  const received = Object.values(weights).reduce((a, v) => a + (Number(v) || 0), 0);
  const sent = Number(dispatch.dispatch_weight_kg);
  const varianceKg = received - sent;
  const variancePct = sent > 0 ? (varianceKg / sent) * 100 : 0;
  // Mirrors the server default; the server is still the authority.
  const needsReason = Math.abs(variancePct) > 3;

  return (
    <Modal title={`Receive ${dispatch.dispatch_no}`} wide onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || (needsReason && !reason)} onClick={async () => {
          setBusy(true);
          try {
            const r = await api.post<any>(`/farming/dispatches/${dispatch.id}/receive`, {
              idempotencyKey: key,
              lines: Object.entries(weights).map(([lineId, v]) => ({
                lineId, receivedWeightKg: Number(v) || 0,
              })),
              varianceReason: reason || undefined,
            });
            toast(`Received — ${r.batches.length} batch(es) now in stock`, 'ok');
            onDone();
          } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
        }}>Receive into stock</button>
      </>}>
      <p className="small muted mb">
        Weigh each grade as it comes off the vehicle. Accepted weight becomes a
        batch in the warehouse straight away, valued at what it cost to grow.
      </p>

      {(dispatch.lines ?? []).map((l: any) => (
        <div key={l.id} className="grade-row">
          <b>{l.productName} · {l.grade}</b>
          <span className="small muted">farm sent {num(l.dispatchWeightKg, 1)} kg</span>
          <input type="number" step="0.1" value={weights[l.id] ?? ''}
            onChange={(e) => setWeights({ ...weights, [l.id]: e.target.value })} />
          <span className="small muted">kg received</span>
        </div>
      ))}

      <div className={`banner ${Math.abs(variancePct) > 3 ? 'danger'
        : Math.abs(variancePct) > 1 ? 'warn' : 'ok'} mt`}>
        <span>⚖</span>
        <div>
          <b>Farm dispatch {num(sent, 1)} kg · Warehouse received {num(received, 1)} kg
            {' '}· Variance {num(varianceKg, 1)} kg ({num(variancePct, 2)}%)</b>
          {needsReason ? <div className="small">A gap this size needs a reason before it can be received.</div> : null}
        </div>
      </div>

      {needsReason ? (
        <Field label="Why is the weight different?">
          <input value={reason} autoFocus onChange={(e) => setReason(e.target.value)}
            placeholder="Moisture loss in transit / spillage / counted short at the farm" />
        </Field>
      ) : null}
    </Modal>
  );
}

/* ===========================================================================
 * §32 — THE OWNER DASHBOARD.
 * ======================================================================== */

export function FarmDashboardPage() {
  const nav = useNavigate();
  const { data, loading, error } = useApi<any>('/farming/dashboard');

  if (loading) return <Layout title="Farm"><Loading /></Layout>;
  const k = data?.kpis ?? {};

  return (
    <Layout title="Farm control" subtitle="Everything, in three colours">
      <ErrorBanner error={error} />

      <div className="grid c4 mb">
        <Kpi label="Farm health" value={<Light c={k.farm_health} label={k.farm_health} />}
          tone={k.farm_health === 'RED' ? 'crit' : k.farm_health === 'YELLOW' ? 'warn' : 'good'}
          foot={`${k.live_crops ?? 0} crops growing`} onClick={() => nav('/farm/crops')} />
        <Kpi label="Today's work" value={`${k.tasks_done ?? 0}/${k.tasks_today ?? 0}`}
          tone={k.tasks_overdue > 0 ? 'warn' : undefined}
          foot={k.tasks_overdue > 0 ? `${k.tasks_overdue} overdue` : 'on schedule'}
          onClick={() => nav('/farm')} />
        <Kpi label="Harvest today" value={`${num(k.harvest_today, 0)} kg`}
          foot={`${num(k.dispatched_today, 0)} kg sent to the warehouse`}
          onClick={() => nav('/farm/dispatch')} />
        <Kpi label="Critical problems" value={k.critical_problems ?? 0}
          tone={k.critical_problems > 0 ? 'crit' : 'good'}
          foot="crops needing action now" onClick={() => nav('/farm/crops')} />
      </div>

      <div className="grid c4 mb">
        <Kpi label="Next 7 days" value={`${num(data?.forecastSummary?.next7Days, 0)} kg`}
          foot="expected harvest" onClick={() => nav('/farm/planning')} />
        <Kpi label="Tomorrow" value={`${num(data?.forecastSummary?.tomorrow, 0)} kg`} />
        <Kpi label="Spent today" value={inr(k.expense_today, 0)}
          foot={data?.cost ? `${inr(data.cost.cost_open_crops, 0)} in growing crops` : undefined} />
        {data?.cost ? (
          <Kpi label="Cost per kg — finished crops"
            value={data.cost.cost_per_kg ? inr(data.cost.cost_per_kg) : '—'}
            foot={data.cost.cost_per_kg
              ? `measured over ${data.cost.closed_cycles} finished crop(s)`
              : 'finish one crop cycle to measure it'} />
        ) : (
          <Kpi label="Loss, 30 days" value={`${num(k.loss_30d, 0)} kg`} />
        )}
      </div>

      <div className="grid sidebar-right">
        <div className="stack">
          <div className="card">
            <div className="card-head">
              <h2>7-day harvest forecast</h2>
              <button className="btn sm ghost" onClick={() => nav('/farm/planning')}>Planning →</button>
            </div>
            <div className="card-body">
              {data?.forecast?.length ? (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={data.forecast}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
                    <XAxis dataKey="harvest_date" tick={{ fontSize: 11 }}
                      tickFormatter={(d) => date(d).slice(0, 6)} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v: any) => `${num(v, 0)} kg`} labelFormatter={(l) => date(l)} />
                    <Bar dataKey="expected_kg" fill="#4338CA" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <Empty icon="📅" title="No harvest expected in the next week" />}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Crops</h2>
              <button className="btn sm ghost" onClick={() => nav('/farm/crops')}>All →</button>
            </div>
            <div className="card-body tight">
              <DataTable rows={data?.crops ?? []} cols={[
                { key: 'l', head: '', width: 34, render: (c: any) => <Light c={c.health} /> },
                { key: 'p', head: 'Plot', render: (c: any) => <b>Plot-{c.plot_code}</b> },
                { key: 'c', head: 'Crop', render: (c: any) => (
                  <div>{c.crop_name}<div className="small muted">day {c.crop_age_days}</div></div>) },
                { key: 'h', head: 'Harvest', render: (c: any) =>
                  c.days_to_harvest > 3 ? <span className="small muted">in {c.days_to_harvest}d</span>
                    : c.days_to_harvest >= 0 ? <Chip tone="warn">in {c.days_to_harvest}d</Chip>
                    : <Chip tone="danger">delayed</Chip> },
                { key: 'e', head: 'Expected', num: true, render: (c: any) => `${num(c.expected_yield_kg, 0)} kg` },
                { key: 'w', head: 'Late jobs', num: true, render: (c: any) =>
                  c.overdue_tasks > 0 ? <Chip tone="danger">{c.overdue_tasks}</Chip> : '—' },
              ]} onRowClick={(c: any) => nav(`/farm/crops/${c.cycle_id}`)}
                empty={<Empty icon="🌾" title="No crops growing" />} />
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h2>Problems reported</h2></div>
          <div className="card-body tight">
            <DataTable rows={data?.problems ?? []} cols={[
              { key: 'p', head: 'Where', render: (p: any) => (
                <div><b>Plot-{p.plot_code}</b><div className="small muted">{p.crop_name}</div></div>) },
              { key: 'w', head: 'What', render: (p: any) => (
                <div><Chip tone="danger">{p.problem_code}</Chip>
                  {p.note ? <div className="small muted">{p.note}</div> : null}</div>) },
              { key: 'b', head: 'By', render: (p: any) => <span className="small muted">{p.by_name}</span> },
            ]} empty={<Empty icon="👍" title="Nothing reported" />} />
          </div>
        </div>
      </div>
    </Layout>
  );
}

/* ===========================================================================
 * §24 §25 §26 §27 §30 — PLANNING. Where farming and purchasing meet.
 * ======================================================================== */

export function FarmPlanningPage() {
  const { data: planning, loading } = useApi<any>('/farming/planning');
  const { data: forecast } = useApi<any>('/farming/harvest-forecast?days=14');
  const { data: staff } = useApi<any[]>('/farming/staff-performance');
  const [tab, setTab] = useState<'next' | 'buy' | 'forecast' | 'staff'>('next');

  if (loading) return <Layout title="Farm planning"><Loading /></Layout>;

  return (
    <Layout title="Farm planning" subtitle="What to grow next, and whether to grow it at all">
      <div className="tabs">
        {([['next', 'Next crop'], ['buy', 'Buy vs grow'],
           ['forecast', 'Harvest forecast'], ['staff', 'Staff']] as const).map(([k, l]) => (
          <button key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab === 'next' ? (
        <div className="card">
          <div className="card-head">
            <h2>Suggested next crops</h2>
            <Chip tone="neutral">{planning?.season} season</Chip>
            <Chip tone="neutral">{String(planning?.waterAvailability ?? '').toLowerCase()} water</Chip>
          </div>
          <div className="card-body tight">
            {/* §26 §30 — demand the business already has, against production it
                already expects, with rotation and season as vetoes. */}
            <DataTable rows={planning?.suggestions ?? []} cols={[
              { key: 'c', head: 'Crop', render: (s: any) => (
                <div><b>{s.cropName}</b>
                  <div className="small muted">{s.durationDays} days · {s.waterNeed.toLowerCase()} water</div></div>) },
              { key: 'd', head: '60-day demand', num: true, render: (s: any) => `${num(s.demandKg, 0)} kg` },
              { key: 's', head: 'Farm will give', num: true, render: (s: any) => `${num(s.expectedSupplyKg, 0)} kg` },
              { key: 'g', head: 'Shortfall', num: true, render: (s: any) =>
                s.shortageKg > 0 ? <Chip tone="warn">{num(s.shortageKg, 0)} kg</Chip>
                  : <span className="muted small">covered</span> },
              { key: 'm', head: 'Margin/kg', num: true, render: (s: any) =>
                s.marginPerKg != null ? inr(s.marginPerKg) : '—' },
              { key: 'w', head: 'Why not', render: (s: any) => s.blockers.length
                ? <div className="small">{s.blockers.map((b: string, i: number) =>
                    <div key={i} className="chip danger" style={{ margin: '2px 0' }}>{b}</div>)}</div>
                : <Chip tone="ok">clear to plant</Chip> },
              { key: 'x', head: 'Score', num: true, render: (s: any) => (
                <Chip tone={s.recommended ? 'ok' : 'neutral'}>{num(s.score, 0)}</Chip>) },
            ]} rowTone={(s: any) => (s.recommended ? undefined : 'warn')}
              empty={<Empty title="No crops configured" />} />
          </div>
        </div>
      ) : null}

      {tab === 'buy' ? (
        <div className="card">
          <div className="card-head"><h2>Grow it, or buy it?</h2></div>
          <div className="card-body tight">
            {/* §27 — own measured cost against today's market, with a risk
                premium on growing. The owner still decides. */}
            <DataTable rows={planning?.comparison ?? []} cols={[
              { key: 'c', head: 'Crop', render: (c: any) => (
                <div><b>{c.cropName}</b><div className="small muted">{c.sku ?? '—'}</div></div>) },
              { key: 'o', head: 'Own cost/kg', num: true, render: (c: any) =>
                c.ownCostPerKg != null ? inr(c.ownCostPerKg) : <span className="muted">no history</span> },
              { key: 'm', head: 'Market/kg', num: true, render: (c: any) =>
                c.marketRatePerKg != null ? inr(c.marketRatePerKg) : '—' },
              { key: 'g', head: 'Gap', num: true, render: (c: any) =>
                c.gapPerKg != null ? inr(c.gapPerKg) : '—' },
              { key: 'v', head: 'Verdict', render: (c: any) => (
                <Chip tone={c.verdict === 'GROW' ? 'ok' : c.verdict === 'BUY' ? 'warn' : 'neutral'}>
                  {c.verdict === 'GROW' ? '🟢 Growing is better'
                    : c.verdict === 'BUY' ? '🟡 Buying may be better'
                    : c.verdict === 'EITHER' ? 'Either works' : 'Not enough history'}
                </Chip>) },
              { key: 'w', head: '', render: (c: any) => <span className="small muted">{c.message}</span> },
            ]} empty={<Empty title="No crops configured" />} />
          </div>
        </div>
      ) : null}

      {tab === 'forecast' ? (
        <div className="grid c2">
          <div className="card">
            <div className="card-head"><h2>What is coming, and when</h2></div>
            <div className="card-body">
              <div className="grid c4 mb">
                <Kpi label="Today" value={`${num(forecast?.summary?.today, 0)} kg`} />
                <Kpi label="Tomorrow" value={`${num(forecast?.summary?.tomorrow, 0)} kg`} />
                <Kpi label="Next 3 days" value={`${num(forecast?.summary?.next3Days, 0)} kg`} />
                <Kpi label="Next 7 days" value={`${num(forecast?.summary?.next7Days, 0)} kg`} />
              </div>
              <div className="small muted">
                §25 — the buy list reads these figures, so the warehouse does not
                buy in the market what the field is about to deliver.
              </div>
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h2>By product</h2></div>
            <div className="card-body tight">
              <DataTable rows={forecast?.byProduct ?? []} cols={[
                { key: 'p', head: 'Product', render: (p: any) => <b>{p.productName}</b> },
                { key: 'k', head: 'Expected', num: true, render: (p: any) => `${num(p.kg, 0)} kg` },
              ]} empty={<Empty title="No harvest expected" />} />
            </div>
          </div>
        </div>
      ) : null}

      {tab === 'staff' ? (
        <div className="card">
          <div className="card-head"><h2>Staff performance — computed, not scored by hand</h2></div>
          <div className="card-body tight">
            {/* §22 — a manager's memory is not an appraisal system. */}
            <DataTable rows={staff ?? []} cols={[
              { key: 'l', head: '', width: 34, render: (s: any) => <Light c={s.rating} /> },
              { key: 'n', head: 'Name', render: (s: any) => <b>{s.name}</b> },
              { key: 'd', head: 'Jobs done', num: true, render: (s: any) => s.tasksDone },
              { key: 'o', head: 'On time', num: true, render: (s: any) =>
                `${num(s.breakdown.punctualityPct, 0)}%` },
              { key: 'r', head: 'Red issues', num: true, render: (s: any) =>
                s.redIssues > 0 ? <Chip tone="danger">{s.redIssues}</Chip> : '—' },
              { key: 'h', head: 'Harvested', num: true, render: (s: any) => `${num(s.harvestKg, 0)} kg` },
              { key: 'a', head: 'Grade A', num: true, render: (s: any) =>
                s.gradeAPct != null ? `${num(s.gradeAPct, 0)}%` : '—' },
              { key: 's', head: 'Rating', render: (s: any) => (
                <Chip tone={s.rating === 'GREEN' ? 'ok' : s.rating === 'YELLOW' ? 'warn' : 'danger'}>
                  {num(s.score, 0)}
                </Chip>) },
            ]} empty={<Empty icon="👥" title="Nobody has recorded farm work yet" />} />
          </div>
        </div>
      ) : null}
    </Layout>
  );
}

/* ===========================================================================
 * §1 §23 — SETUP. Done once; after this nobody types a farm detail again.
 * ======================================================================== */

export function FarmSetupPage() {
  const toast = useToast();
  const { can } = useAuth();
  const { data: farms, reload } = useApi<any[]>('/farming/farms');
  const { data: machines, reload: reloadMachines } = useApi<any[]>('/farming/machines');
  const [farmId, setFarmId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addingPlot, setAddingPlot] = useState(false);
  const [weather, setWeather] = useState(false);
  const selected = farmId ?? farms?.[0]?.id ?? null;
  const { data: detail, reload: reloadDetail } = useApi<any>(
    selected ? `/farming/farms/${selected}` : null, [selected]);

  return (
    <Layout title="Farm setup" subtitle="Fill this in once — the rest is automatic"
      actions={can('farming.farm.manage') ? (
        <div className="btn-row">
          <button className="btn sm" onClick={() => setWeather(true)}>🌦 Weather</button>
          <button className="btn sm primary" onClick={() => setAdding(true)}>Add farm</button>
        </div>
      ) : null}>

      <div className="grid c4 mb">
        {(farms ?? []).map((f) => (
          <div key={f.id} className={`plot-card ${f.health}`} onClick={() => setFarmId(f.id)}>
            <div className="row">
              <span className="code">{f.code}</span>
              <span className="spacer" />
              <Light c={f.health} />
            </div>
            <div className="crop">{f.name}</div>
            <dl>
              <dt>Area</dt><dd>{f.area_acre} acre</dd>
              <dt>Plots</dt><dd>{f.plot_count}</dd>
              <dt>Crops</dt><dd>{f.live_crops}</dd>
              <dt>Water</dt><dd>{(f.water_source ?? '').replace(/_/g, ' ').toLowerCase()}</dd>
            </dl>
          </div>
        ))}
      </div>

      {detail ? (
        <div className="grid c2">
          <div className="card">
            <div className="card-head">
              <h2>Plots — {detail.farm.name}</h2>
              {can('farming.farm.manage')
                ? <button className="btn sm" onClick={() => setAddingPlot(true)}>Add plot</button> : null}
            </div>
            <div className="card-body tight">
              <DataTable rows={detail.plots} cols={[
                { key: 'c', head: 'Plot', render: (p: any) => (
                  <div><b>Plot-{p.code}</b><div className="small muted">{p.name ?? ''}</div></div>) },
                { key: 'a', head: 'Area', num: true, render: (p: any) => `${p.area_acre} ac` },
                { key: 'cr', head: 'Crop', render: (p: any) => p.crop_name
                  ? <div><Light c={p.health} label={p.crop_name} />
                      <div className="small muted">day {p.crop_age_days}</div></div>
                  : <Chip tone="neutral">free</Chip> },
                { key: 'q', head: 'QR code', render: (p: any) => (
                  <a className="mono small" href={`/farm/plot/${p.qr_code}`}>{p.qr_code}</a>) },
              ]} empty={<Empty title="No plots yet" />} />
              <div className="small muted" style={{ padding: '10px 14px' }}>
                Print each QR and stick it on the plot gate. Scanning it opens
                that plot's screen — which is what stops entries landing on the
                wrong crop.
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h2>Machines</h2></div>
            <div className="card-body tight">
              {/* §23 — three colours, and nothing more to manage. */}
              <DataTable rows={machines ?? []} cols={[
                { key: 'n', head: 'Machine', render: (m: any) => (
                  <div><b>{m.name}</b><div className="small muted">{m.code} · {m.machine_type}</div></div>) },
                { key: 's', head: 'Status', render: (m: any) => (
                  <Chip tone={m.status === 'AVAILABLE' ? 'ok' : m.status === 'BREAKDOWN' ? 'danger'
                    : m.status === 'MAINTENANCE_DUE' ? 'warn' : 'primary'}>
                    {m.status.replace(/_/g, ' ').toLowerCase()}
                  </Chip>) },
                { key: 'v', head: 'Service', render: (m: any) => (
                  <span className={m.service_overdue ? 'chip warn' : 'small muted'}>
                    {m.next_service_date ? date(m.next_service_date) : '—'}
                  </span>) },
                { key: 'a', head: '', width: 130, render: (m: any) => (
                  <select value="" onChange={async (e) => {
                    if (!e.target.value) return;
                    try {
                      await api.post(`/farming/machines/${m.id}/status`,
                        e.target.value === 'SERVICED'
                          ? { status: 'AVAILABLE', serviceDone: true }
                          : { status: e.target.value });
                      toast('Machine updated', 'ok');
                      reloadMachines();
                    } catch (err: any) { toast(err.message, 'err'); }
                  }}>
                    <option value="">Change…</option>
                    <option value="AVAILABLE">🟢 Available</option>
                    <option value="IN_USE">In use</option>
                    <option value="MAINTENANCE_DUE">🟡 Maintenance due</option>
                    <option value="BREAKDOWN">🔴 Breakdown</option>
                    <option value="SERVICED">Serviced today</option>
                  </select>) },
              ]} empty={<Empty icon="🚜" title="No machines" />} />
            </div>
          </div>
        </div>
      ) : <Empty icon="🏡" title="No farms yet"
        action={can('farming.farm.manage')
          ? <button className="btn primary" onClick={() => setAdding(true)}>Add your first farm</button>
          : undefined} />}

      {adding ? <AddFarmModal onClose={() => setAdding(false)}
        onDone={() => { setAdding(false); reload(); toast('Farm added', 'ok'); }} /> : null}
      {addingPlot && detail ? <AddPlotModal farmId={detail.farm.id} onClose={() => setAddingPlot(false)}
        onDone={() => { setAddingPlot(false); reloadDetail(); toast('Plot added', 'ok'); }} /> : null}
      {weather && detail ? <WeatherModal farmId={detail.farm.id} onClose={() => setWeather(false)}
        onDone={() => { setWeather(false); toast('Weather saved', 'ok'); }} /> : null}
    </Layout>
  );
}

function AddFarmModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { me, branchId } = useAuth();
  const [f, setF] = useState({
    code: '', name: '', areaAcre: '', village: '', waterSource: 'TUBE_WELL',
    branchId: branchId ?? me?.branches[0]?.id ?? '',
    defaultWarehouseId: me?.warehouses[0]?.id ?? '',
  });
  const [plots, setPlots] = useState('A, B, C, D');
  const [busy, setBusy] = useState(false);

  const plotList = plots.split(',').map((s) => s.trim()).filter(Boolean);
  const perPlot = plotList.length && Number(f.areaAcre)
    ? Math.round((Number(f.areaAcre) / plotList.length) * 1000) / 1000 : 0;

  return (
    <Modal title="Add a farm" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!f.code || !f.name || !Number(f.areaAcre) || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.post('/farming/farms', {
                ...f, areaAcre: Number(f.areaAcre),
                defaultWarehouseId: f.defaultWarehouseId || null,
                plots: plotList.map((code) => ({ code, areaAcre: perPlot })),
              });
              onDone();
            } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
          }}>Add farm</button>
      </>}>
      <p className="small muted mb">This is asked once. After it, nobody types farm details again.</p>
      <div className="grid c2">
        <Field label="Short code"><input value={f.code}
          onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} placeholder="FARM-02" /></Field>
        <Field label="Name"><input value={f.name}
          onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="ChotuG Farm-02" /></Field>
        <Field label="Total area (acre)"><input type="number" step="0.1" value={f.areaAcre}
          onChange={(e) => setF({ ...f, areaAcre: e.target.value })} /></Field>
        <Field label="Village / location"><input value={f.village}
          onChange={(e) => setF({ ...f, village: e.target.value })} /></Field>
        <Field label="Water source">
          <select value={f.waterSource} onChange={(e) => setF({ ...f, waterSource: e.target.value })}>
            {['TUBE_WELL', 'BOREWELL', 'CANAL', 'RIVER', 'POND', 'RAIN_FED', 'DRIP', 'OTHER'].map((w) =>
              <option key={w} value={w}>{w.replace(/_/g, ' ').toLowerCase()}</option>)}
          </select>
        </Field>
        <Field label="Delivers to warehouse">
          <select value={f.defaultWarehouseId}
            onChange={(e) => setF({ ...f, defaultWarehouseId: e.target.value })}>
            <option value="">—</option>
            {(me?.warehouses ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Plots" hint={perPlot ? `${plotList.length} plots of about ${perPlot} acre each` : 'Comma separated'}>
        <input value={plots} onChange={(e) => setPlots(e.target.value)} />
      </Field>
    </Modal>
  );
}

function AddPlotModal({ farmId, onClose, onDone }: {
  farmId: string; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [area, setArea] = useState('');
  const [irr, setIrr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Add a plot" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!code || busy} onClick={async () => {
          setBusy(true);
          try {
            await api.post(`/farming/farms/${farmId}/plots`, {
              code, name: name || undefined, areaAcre: Number(area) || 0,
              irrigationType: irr || undefined,
            });
            onDone();
          } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
        }}>Add plot</button>
      </>}>
      <div className="grid c2">
        <Field label="Plot code"><input value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="E" /></Field>
        <Field label="Name (optional)"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Area (acre)"><input type="number" step="0.1" value={area}
          onChange={(e) => setArea(e.target.value)} /></Field>
        <Field label="Irrigation">
          <select value={irr} onChange={(e) => setIrr(e.target.value)}>
            <option value="">—</option>
            {['DRIP', 'SPRINKLER', 'FLOOD', 'FURROW', 'MANUAL'].map((i) =>
              <option key={i} value={i}>{i.toLowerCase()}</option>)}
          </select>
        </Field>
      </div>
      <div className="small muted">A QR code is generated for this plot automatically.</div>
    </Modal>
  );
}

function WeatherModal({ farmId, onClose, onDone }: {
  farmId: string; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [w, setW] = useState({
    weatherDate: today(), tempMinC: '', tempMaxC: '', rainMm: '0',
    rainProbPct: '', windKmph: '', condition: '',
  });
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Record the weather" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={async () => {
          setBusy(true);
          try {
            await api.post('/farming/weather', {
              farmId, weatherDate: w.weatherDate,
              tempMinC: w.tempMinC ? Number(w.tempMinC) : null,
              tempMaxC: w.tempMaxC ? Number(w.tempMaxC) : null,
              rainMm: Number(w.rainMm) || 0,
              rainProbPct: w.rainProbPct ? Number(w.rainProbPct) : null,
              windKmph: w.windKmph ? Number(w.windKmph) : null,
              condition: w.condition || null,
            });
            onDone();
          } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
        }}>Save</button>
      </>}>
      <p className="small muted mb">
        Rain holds irrigation and reschedules it. Wind stops spraying. Heat and
        frost raise an inspection alert. Nobody has to decide any of that.
      </p>
      <div className="grid c2">
        <Field label="Date"><input type="date" value={w.weatherDate}
          onChange={(e) => setW({ ...w, weatherDate: e.target.value })} /></Field>
        <Field label="Condition"><input value={w.condition}
          onChange={(e) => setW({ ...w, condition: e.target.value })} placeholder="Clear / Cloudy" /></Field>
        <Field label="Min temp (°C)"><input type="number" value={w.tempMinC}
          onChange={(e) => setW({ ...w, tempMinC: e.target.value })} /></Field>
        <Field label="Max temp (°C)"><input type="number" value={w.tempMaxC}
          onChange={(e) => setW({ ...w, tempMaxC: e.target.value })} /></Field>
        <Field label="Rain (mm)"><input type="number" value={w.rainMm}
          onChange={(e) => setW({ ...w, rainMm: e.target.value })} /></Field>
        <Field label="Chance of rain (%)"><input type="number" value={w.rainProbPct}
          onChange={(e) => setW({ ...w, rainProbPct: e.target.value })} /></Field>
        <Field label="Wind (km/h)"><input type="number" value={w.windKmph}
          onChange={(e) => setW({ ...w, windKmph: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

/* ===========================================================================
 * §18 — the standalone expense screen, for a bill that arrives at the office.
 * ======================================================================== */

export function FarmExpensePage() {
  const toast = useToast();
  const { data: farms } = useApi<any[]>('/farming/farms');
  const [farmId, setFarmId] = useState('');
  const { data, loading, reload } = useApi<any[]>(
    `/farming/expenses${farmId ? `?farmId=${farmId}` : ''}`, [farmId]);
  const [adding, setAdding] = useState(false);
  const selected = farmId || farms?.[0]?.id || '';

  const total = (data ?? []).reduce((a, e) => a + Number(e.amount), 0);

  return (
    <Layout title="Farm expenses" subtitle="Type, amount, save — the rest is attached for you"
      actions={<button className="btn primary sm" disabled={!selected}
        onClick={() => setAdding(true)}>Add expense</button>}>
      <div className="search-bar">
        <select value={farmId} onChange={(e) => setFarmId(e.target.value)}>
          <option value="">All farms</option>
          {(farms ?? []).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <span className="spacer" />
        <Chip tone="neutral">{inr(total, 0)} shown</Chip>
      </div>
      <div className="card"><div className="card-body tight">
        <DataTable rows={data ?? []} loading={loading} cols={[
          { key: 'd', head: 'Date', render: (e: any) => date(e.expense_date) },
          { key: 't', head: 'Type', render: (e: any) => <Chip tone="neutral">{e.expense_type}</Chip> },
          { key: 'f', head: 'Where', render: (e: any) => (
            <div>{e.farm_name}
              <div className="small muted">{e.plot_code ? `Plot-${e.plot_code}` : 'whole farm'}
                {e.crop_name ? ` · ${e.crop_name}` : ''}</div></div>) },
          { key: 'n', head: 'Note', render: (e: any) => <span className="small">{e.note ?? '—'}</span> },
          { key: 'b', head: 'By', render: (e: any) => <span className="small muted">{e.by_name}</span> },
          { key: 'a', head: 'Amount', num: true, render: (e: any) => inr(e.amount, 0) },
        ]} empty={<Empty icon="₹" title="No expenses recorded" />} />
      </div></div>

      {adding ? (
        <ExpenseModal farmId={selected} onClose={() => setAdding(false)}
          onDone={() => { setAdding(false); reload(); toast('Expense saved', 'ok'); }} />
      ) : null}
    </Layout>
  );
}
