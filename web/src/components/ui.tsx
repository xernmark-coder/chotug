import React, { createContext, useContext, useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { api, useAuth } from '../lib/api';

/* ------------------------------------------------------------- toasts ---- */
type Toast = { id: number; text: string; kind: 'ok' | 'err' | 'info' };
const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = (text: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, text, kind }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), 5200);
  };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'err' ? 'err' : t.kind === 'ok' ? 'ok' : ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* -------------------------------------------------------------- chips ---- */
const STATUS_TONE: Record<string, string> = {
  DRAFT: 'neutral', SUBMITTED: 'warn', PENDING: 'warn', APPROVED: 'primary',
  CONFIRMED: 'primary', PART_RECEIVED: 'warn', RECEIVED: 'ok', POSTED: 'ok',
  CLOSED: 'neutral', CANCELLED: 'neutral', REJECTED: 'danger', REJECTED_AT_GATE: 'danger',
  HELD: 'warn', HOLD: 'warn', ARRIVED: 'primary', WEIGHED: 'primary',
  QC_PENDING: 'warn', QC_COMPLETE: 'ok', GRN_PENDING: 'warn', COMPLETED: 'ok',
  ACCEPT: 'ok', PARTIAL: 'warn', MATCH: 'ok', MATCHED: 'ok', MISMATCH: 'danger',
  CRITICAL_MISMATCH: 'danger', PAYABLE: 'primary', PAID: 'ok', PART_PAID: 'warn',
  ACTIVE: 'ok', PREFERRED: 'ok', ON_HOLD: 'warn', BLOCKED: 'danger',
  GREEN: 'ok', AMBER: 'warn', RED: 'danger', CRITICAL: 'danger',
  URGENT: 'danger', HIGH: 'warn', NORMAL: 'neutral', LOW: 'neutral',
  MEDIUM: 'warn', OPEN: 'warn', ACK: 'primary', RESOLVED: 'ok',
  CONVERTED: 'primary', DONE: 'ok', EXCEPTION: 'danger', EXPECTED: 'primary',
  // Farming. GREEN already maps to the cyan "ok" token above; YELLOW joins it
  // here so the module's 🟢/🟡/🔴 vocabulary needs no second palette.
  YELLOW: 'warn', PLANNED: 'primary', GROWING: 'primary', HARVESTING: 'warn',
  PROBLEM: 'danger', SKIPPED: 'neutral', FAILED: 'danger', READY: 'ok',
  DISPATCHED: 'primary', PART_DISPATCHED: 'warn',
  IDLE: 'neutral', CROPPED: 'primary', RESTING: 'neutral',
  AVAILABLE: 'ok', IN_USE: 'primary', MAINTENANCE_DUE: 'warn', BREAKDOWN: 'danger',
};

export function Chip({ value, tone, children }: { value?: string | null; tone?: string; children?: React.ReactNode }) {
  const t = tone ?? STATUS_TONE[String(value ?? '')] ?? 'neutral';
  return <span className={`chip ${t}`}>{children ?? (value ?? '—').replace(/_/g, ' ')}</span>;
}

/* ---------------------------------------------------------------- KPI ---- */
export function Kpi({ label, value, foot, tone, onClick }: {
  label: string; value: React.ReactNode; foot?: React.ReactNode;
  tone?: 'warn' | 'crit' | 'good'; onClick?: () => void;
}) {
  return (
    <div className={`kpi ${tone ?? ''}`} onClick={onClick} style={onClick ? { cursor: 'pointer' } : undefined}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {foot ? <div className="foot">{foot}</div> : null}
    </div>
  );
}

/* -------------------------------------------------------------- fields --- */
export function Field({ label, hint, error, children }: {
  label: string; hint?: string; error?: string; children: React.ReactNode;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && !error ? <div className="hint">{hint}</div> : null}
      {error ? <div className="err">{error}</div> : null}
    </div>
  );
}

/**
 * §24 — anything the system can know is prefilled and read-only, with an
 * explicit "Edit" that demands a reason. This component is that rule.
 */
export function PrefilledField({ label, value, hint, onEdit, edited, children }: {
  label: string; value: React.ReactNode; hint?: string;
  onEdit?: () => void; edited?: boolean; children?: React.ReactNode;
}) {
  return (
    <div className="field">
      <label>{label} {edited ? <Chip tone="warn">edited</Chip> : null}</label>
      {children ?? (
        <div className="prefill">
          <input readOnly value={String(value ?? '')} />
          {onEdit ? <button type="button" className="btn sm" onClick={onEdit}>Edit</button> : null}
        </div>
      )}
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

/* --------------------------------------------------------------- modal --- */
export function Modal({ title, onClose, children, footer, wide }: {
  title: string; onClose: () => void; children: React.ReactNode;
  footer?: React.ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`}>
        <div className="modal-head">
          <h2 style={{ flex: 1 }}>{title}</h2>
          <button className="btn ghost sm" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- states ---- */
export function Empty({ icon = '📭', title, hint, action }: {
  icon?: string; title: string; hint?: string; action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <div className="big">{icon}</div>
      <div style={{ fontWeight: 600, color: 'var(--text-2)' }}>{title}</div>
      {hint ? <div className="small mt">{hint}</div> : null}
      {action ? <div className="mt">{action}</div> : null}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="empty"><div className="big">⏳</div>{label}</div>;
}

export function ErrorBanner({ error }: { error: any }) {
  if (!error) return null;
  const detail = error?.detail && typeof error.detail === 'object'
    ? Object.values(error.detail).join(' · ') : null;
  return (
    <div className="banner danger mb">
      <span>⚠</span>
      <div><b>{error.message ?? String(error)}</b>{detail ? <div className="small">{detail}</div> : null}</div>
    </div>
  );
}

/* ------------------------------------------------------------- AI box ---- */
export function AiBox({ title = 'AI suggestion', confidence, usedFallback, children, actions }: {
  title?: string; confidence?: number | null; usedFallback?: boolean;
  children: React.ReactNode; actions?: React.ReactNode;
}) {
  return (
    <div className="ai-box">
      <div className="ai-head">
        <span>✨ {title}</span>
        <span className="spacer" />
        {confidence != null ? (
          <span className="ai-conf">confidence {Math.round(confidence * 100)}%</span>
        ) : null}
      </div>
      {children}
      {usedFallback ? (
        <div className="small muted mt">
          Calculated from your own sales history — no external model was used.
        </div>
      ) : null}
      {actions ? <div className="btn-row mt">{actions}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------- layout ---- */
type NavDef = { to: string; label: string; icon: string; perms?: string[]; badge?: number };

export function Layout({ children, title, subtitle, actions, touch }: {
  children: React.ReactNode; title: string; subtitle?: string;
  actions?: React.ReactNode; touch?: boolean;
}) {
  const { me, can, logout, branchId, setBranchId } = useAuth();
  const nav = useNavigate();
  const [queueCount, setQueueCount] = useState(0);
  const [alertCount, setAlertCount] = useState(0);
  const [farmTasks, setFarmTasks] = useState(0);

  useEffect(() => {
    const load = async () => {
      try {
        const [q, a] = await Promise.all([
          api.get<any[]>('/insights/work-queue'),
          api.get<any[]>('/insights/alerts?status=OPEN&severity=CRITICAL'),
        ]);
        setQueueCount(q.length);
        setAlertCount(a.length);
        // The farm queue carries a count of jobs due, not a count of rows.
        setFarmTasks(q.filter((t) => t.queue_key === 'FARM_TASK')
          .reduce((n, t) => n + Number(t.payload?.due ?? 1), 0));
      } catch { /* the badge is not worth an error toast */ }
    };
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  const groups: { label: string; items: NavDef[] }[] = [
    {
      label: 'Work',
      items: [
        { to: '/', label: 'My Work', icon: '🎯', badge: queueCount },
        { to: '/dashboard', label: 'Dashboard', icon: '📊' },
        { to: '/alerts', label: 'Alerts', icon: '🔔', badge: alertCount },
      ],
    },
    {
      label: 'Plan & Buy',
      items: [
        { to: '/buy-list', label: 'What to Buy', icon: '🧮', perms: ['purchase.requirement.create'] },
        { to: '/requirements', label: 'Requirements', icon: '📝', perms: ['purchase.requirement.create'] },
        { to: '/purchase-orders', label: 'Purchase Orders', icon: '📦', perms: ['purchase.po.create', 'purchase.po.approve'] },
        { to: '/approvals', label: 'Approvals', icon: '✅', perms: ['purchase.po.approve', 'purchase.requirement.approve', 'finance.invoice.approve'] },
      ],
    },
    {
      label: 'Farm',
      items: [
        // FARM TODAY first and deliberately: for a field worker this one line
        // is the entire product.
        { to: '/farm', label: 'Farm Today', icon: '🌤️', perms: ['farming.task.complete'], badge: farmTasks },
        { to: '/farm/dashboard', label: 'Farm Control', icon: '🏡', perms: ['farming.report.view'] },
        { to: '/farm/crops', label: 'Crops', icon: '🌾', perms: ['farming.crop.start', 'farming.report.view'] },
        { to: '/farm/harvest', label: 'Harvest', icon: '🧺', perms: ['farming.harvest.record'] },
        { to: '/farm/dispatch', label: 'Farm → Warehouse', icon: '🚜', perms: ['farming.dispatch.create', 'farming.dispatch.receive'] },
        { to: '/farm/expenses', label: 'Farm Expenses', icon: '🧾', perms: ['farming.expense.create', 'farming.cost.view'] },
        { to: '/farm/planning', label: 'Crop Planning', icon: '🧭', perms: ['farming.report.view'] },
        { to: '/farm/setup', label: 'Farms & Plots', icon: '📍', perms: ['farming.farm.manage', 'farming.report.view'] },
      ],
    },
    {
      label: 'Receive',
      items: [
        { to: '/arrivals', label: 'Expected Arrivals', icon: '🚛', perms: ['receiving.gate.create'] },
        { to: '/gate', label: 'Gate & Receiving', icon: '🛃', perms: ['receiving.gate.create', 'receiving.weighment.create', 'quality.inspection.create', 'receiving.grn.submit'] },
        { to: '/grns', label: 'Goods Receipts', icon: '📥', perms: ['receiving.grn.create', 'receiving.grn.submit'] },
        { to: '/putaway', label: 'Put-away', icon: '🏷️', perms: ['receiving.putaway.confirm'] },
        { to: '/stock', label: 'Stock & Batches', icon: '🧺' },
        { to: '/fleet', label: 'Vehicles & Drivers', icon: '🚚', perms: ['master.vehicle.manage', 'receiving.gate.create'] },
      ],
    },
    {
      label: 'Money',
      items: [
        { to: '/invoices', label: 'Invoices & Match', icon: '🧾', perms: ['finance.invoice.create', 'finance.invoice.match'] },
        { to: '/payments', label: 'Payment Status', icon: '💳', perms: ['finance.payment.view'] },
        { to: '/suppliers', label: 'Suppliers', icon: '🤝' },
      ],
    },
    {
      label: 'Insight',
      items: [
        { to: '/reports', label: 'Reports', icon: '📈', perms: ['reports.purchase.view'] },
        { to: '/ai', label: 'AI Centre', icon: '✨' },
        { to: '/settings', label: 'Settings', icon: '⚙️', perms: ['admin.settings.manage'] },
      ],
    },
  ];

  return (
    <div className={`app ${touch ? 'touch' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <b>ChotuG</b>
          <span>Purchase &amp; Receiving</span>
        </div>
        {groups.map((g) => {
          const items = g.items.filter((i) => !i.perms || can(...i.perms));
          if (!items.length) return null;
          return (
            <div className="sidebar-group" key={g.label}>
              <div className="sidebar-group-label">{g.label}</div>
              {items.map((i) => (
                <NavLink key={i.to} to={i.to} end={i.to === '/'}
                  className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                  <span className="ic">{i.icon}</span>
                  <span>{i.label}</span>
                  {i.badge ? (
                    <span className={`nav-badge ${i.label === 'Alerts' ? 'crit' : ''}`}>{i.badge}</span>
                  ) : null}
                </NavLink>
              ))}
            </div>
          );
        })}
        <div style={{ flex: 1 }} />
        <div className="sidebar-group" style={{ paddingBottom: 14 }}>
          <div className="nav-item" onClick={() => nav('/profile')}>
            <span className="ic">👤</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{me?.fullName}</span>
          </div>
          <div className="nav-item" onClick={() => { logout(); nav('/login'); }}>
            <span className="ic">↩</span><span>Sign out</span>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <div className="title">{title}</div>
            {subtitle ? <div className="sub">{subtitle}</div> : null}
          </div>
          <div className="spacer" />
          {me && me.branches.length > 1 ? (
            <select style={{ width: 200 }} value={branchId ?? ''} onChange={(e) => setBranchId(e.target.value)}>
              {me.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          ) : null}
          {actions}
        </header>
        <div className="content">{children}</div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- table ---- */
export type Col<T> = {
  key: string;
  head: string;
  render: (row: T) => React.ReactNode;
  num?: boolean;
  width?: number | string;
};

export function DataTable<T>({ rows, cols, onRowClick, rowTone, empty, loading }: {
  rows: T[]; cols: Col<T>[];
  onRowClick?: (row: T) => void;
  rowTone?: (row: T) => 'warn' | 'crit' | undefined;
  empty?: React.ReactNode; loading?: boolean;
}) {
  if (loading) return <Loading />;
  if (!rows.length) return <>{empty ?? <Empty title="Nothing here yet" />}</>;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>{cols.map((c) => (
            <th key={c.key} className={c.num ? 'num' : ''} style={c.width ? { width: c.width } : undefined}>
              {c.head}
            </th>
          ))}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const tone = rowTone?.(r);
            return (
              <tr key={i}
                className={`${onRowClick ? 'clickable' : ''} ${tone === 'crit' ? 'row-crit' : tone === 'warn' ? 'row-warn' : ''}`}
                onClick={() => onRowClick?.(r)}>
                {cols.map((c) => (
                  <td key={c.key} className={c.num ? 'num mono' : ''}>{c.render(r)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* --------------------------------------------------------------- steps --- */
export function Steps({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div className="steps">
      {steps.map((s, i) => (
        <div key={s} className={`step ${i < current ? 'done' : i === current ? 'current' : ''}`}>
          {i < current ? '✓ ' : ''}{s}
        </div>
      ))}
    </div>
  );
}

/** Small data-loading hook — enough for this app, no query library needed. */
export function useApi<T>(path: string | null, deps: any[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [error, setError] = useState<any>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!path) { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    setError(null);
    api.get<T>(path)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [path, nonce, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps

  return { data, loading, error, reload: () => setNonce((n) => n + 1) };
}
