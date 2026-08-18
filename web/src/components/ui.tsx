import React, { createContext, useContext, useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api, useAuth } from '../lib/api';
import { Icon } from './icons';

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
export function Kpi({ label, value, foot, tone, onClick, delta, deltaLabel, spark }: {
  label: string; value: React.ReactNode; foot?: React.ReactNode;
  tone?: 'warn' | 'crit' | 'good'; onClick?: () => void;
  /** Signed change against the previous period. Direction is shown with an
   *  arrow as well as colour, so it survives a colour-blind reader. */
  delta?: number | null; deltaLabel?: string;
  spark?: React.ReactNode;
}) {
  const dir = delta == null ? null : delta > 0.05 ? 'up' : delta < -0.05 ? 'down' : 'flat';
  return (
    <div className={`kpi ${tone ?? ''} ${onClick ? 'clickable' : ''}`}
      onClick={onClick} style={onClick ? { cursor: 'pointer' } : undefined}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {dir ? (
        <div className={`delta ${dir}`}>
          <span>{dir === 'up' ? '▲' : dir === 'down' ? '▼' : '■'}</span>
          {Math.abs(delta!).toFixed(1)}%
          {deltaLabel ? <span style={{ color: 'var(--muted)', fontWeight: 500 }}> {deltaLabel}</span> : null}
        </div>
      ) : null}
      {foot ? <div className="foot">{foot}</div> : null}
      {spark}
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

/* ------------------------------------------------------- reason picker --- */

const TYPE_IT = '__type__';

export type ReasonBank = { reasons: string[]; remember: (r: string) => void };

/**
 * The company's shared list of reasons for changing a suggested quantity.
 * Call once per page and hand the result to every ReasonPicker on it, so ten
 * changed rows do not mean ten identical fetches.
 */
export function useReasonBank(): ReasonBank {
  const { data, reload } = useApi<string[]>('/masters/qty-change-reasons');
  const reasons = data ?? [];
  return {
    reasons,
    remember: (r: string) => {
      const t = r.trim();
      if (t.length < 3) return;
      if (reasons.some((x) => x.toLowerCase() === t.toLowerCase())) return;
      // Fire and forget: failing to save a reason to the shared list must never
      // block the order the buyer is in the middle of placing.
      api.post('/masters/qty-change-reasons', { reason: t }).then(reload).catch(() => undefined);
    },
  };
}

/** A dropdown of known reasons, plus the option to type one nobody has used
 *  before — which then joins the dropdown for everyone else. */
export function ReasonPicker({ bank, value, onChange, placeholder = 'Choose a reason…' }: {
  bank: ReasonBank; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  const known = bank.reasons.some((r) => r.toLowerCase() === value.trim().toLowerCase());
  // A typed reason that is not (yet) in the list means the box stays open, so
  // reopening a half-finished reason does not silently discard it.
  const [typing, setTyping] = useState(!!value && !known);

  return (
    <>
      <select
        value={typing ? TYPE_IT : known ? bank.reasons.find((r) => r.toLowerCase() === value.trim().toLowerCase()) : ''}
        onChange={(e) => {
          if (e.target.value === TYPE_IT) { setTyping(true); onChange(''); }
          else { setTyping(false); onChange(e.target.value); }
        }}
      >
        <option value="">{placeholder}</option>
        {bank.reasons.map((r) => <option key={r} value={r}>{r}</option>)}
        <option value={TYPE_IT}>✎ Something else — type it</option>
      </select>
      {typing ? (
        <input
          className="mt"
          autoFocus
          placeholder="Type the reason"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => bank.remember(e.target.value)}
        />
      ) : null}
    </>
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
  const { pathname } = useLocation();
  const [queueCount, setQueueCount] = useState(0);
  const [alertCount, setAlertCount] = useState(0);
  const [farmTasks, setFarmTasks] = useState(0);
  // Below the drawer breakpoint the sidebar is off-canvas; above it the class
  // does nothing and the aside is a plain column.
  const [navOpen, setNavOpen] = useState(false);

  // Tapping a link must dismiss the drawer, or the new page opens behind it.
  useEffect(() => { setNavOpen(false); }, [pathname]);

  useEffect(() => {
    if (!navOpen) return;
    document.body.classList.add('nav-lock');
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setNavOpen(false);
    window.addEventListener('keydown', esc);
    return () => {
      document.body.classList.remove('nav-lock');
      window.removeEventListener('keydown', esc);
    };
  }, [navOpen]);

  // An outside supplier has no work queue and no alerts, and asking for them
  // just prints 403s in their console on every page.
  const outside = !!me?.roles.includes('SUPPLIER') || !!me?.roles.includes('DRIVER');

  useEffect(() => {
    if (outside) return;
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
  }, [outside]);

  /* An outside supplier has one screen. Rendering the staff sidebar with 30
   * hidden items would leak the shape of our operation for no benefit. */
  const groups: { label: string; items: NavDef[] }[] = outside ? [
    {
      label: me?.roles.includes('DRIVER') ? 'Driver' : 'Supplier',
      items: [
        me?.roles.includes('DRIVER')
          ? { to: '/', label: 'My pickups', icon: 'truck' }
          : { to: '/', label: 'My orders & invoices', icon: 'doc' },
      ],
    },
  ] : [
    {
      label: 'Work',
      items: [
        { to: '/', label: 'Dashboard', icon: 'dashboard' },
        { to: '/my-work', label: 'My Work', icon: 'target', badge: queueCount },
        { to: '/alerts', label: 'Alerts', icon: 'bell', badge: alertCount },
      ],
    },
    {
      label: 'Plan & Buy',
      items: [
        // The whole raise → approve → order → confirm chain in one page, for
        // whoever owns the decision end to end. The separate screens below are
        // unchanged and remain the path when the work is split across people.
        { to: '/order-flow', label: 'Order in one flow', icon: 'bolt', perms: ['purchase.po.create'] },
        { to: '/buy-list', label: 'What to Buy', icon: 'calculator', perms: ['purchase.requirement.create'] },
        { to: '/requirements', label: 'Requirements', icon: 'clipboard', perms: ['purchase.requirement.create'] },
        { to: '/purchase-orders', label: 'Purchase Orders', icon: 'box', perms: ['purchase.po.create', 'purchase.po.approve'] },
        { to: '/approvals', label: 'Approvals', icon: 'checkDoc', perms: ['purchase.po.approve', 'purchase.requirement.approve', 'finance.invoice.approve'] },
      ],
    },
    {
      label: 'Farm',
      items: [
        // FARM TODAY first and deliberately: for a field worker this one line
        // is the entire product.
        { to: '/farm', label: 'Farm Today', icon: 'sun', perms: ['farming.task.complete'], badge: farmTasks },
        { to: '/farm/dashboard', label: 'Farm Control', icon: 'home', perms: ['farming.report.view'] },
        { to: '/farm/crops', label: 'Crops', icon: 'sprout', perms: ['farming.crop.start', 'farming.report.view'] },
        { to: '/farm/harvest', label: 'Harvest', icon: 'basket', perms: ['farming.harvest.record'] },
        { to: '/farm/dispatch', label: 'Farm → Warehouse', icon: 'tractor', perms: ['farming.dispatch.create', 'farming.dispatch.receive'] },
        { to: '/farm/expenses', label: 'Farm Expenses', icon: 'receipt', perms: ['farming.expense.create', 'farming.cost.view'] },
        { to: '/farm/planning', label: 'Crop Planning', icon: 'compass', perms: ['farming.report.view'] },
        { to: '/farm/setup', label: 'Farms & Plots', icon: 'pin', perms: ['farming.farm.manage', 'farming.report.view'] },
      ],
    },
    {
      label: 'Receive',
      items: [
        { to: '/arrivals', label: 'Expected Arrivals', icon: 'truckIn', perms: ['receiving.gate.create'] },
        // The warehouse's own first step: weigh it, count the crates, pass it on.
        { to: '/intake', label: 'Warehouse Intake', icon: 'scale', perms: ['receiving.weighment.create'] },
        { to: '/gate', label: 'Gate & Receiving', icon: 'gate', perms: ['receiving.gate.create', 'receiving.weighment.create', 'quality.inspection.create', 'receiving.grn.submit'] },
        { to: '/grns', label: 'Goods Receipts', icon: 'inbox', perms: ['receiving.grn.create', 'receiving.grn.submit'] },
        { to: '/putaway', label: 'Put-away', icon: 'shelf', perms: ['receiving.putaway.confirm'] },
        { to: '/stock', label: 'Stock & Batches', icon: 'crates' },
        // Selling is where stock stops being cost and becomes revenue, so it
        // sits with the money, not with the warehouse shelves.
        { to: '/packing', label: 'Packing & Labels', icon: 'tag', perms: ['inventory.stock.issue'] },
        { to: '/sales', label: 'Sell & Profit', icon: 'coins' },
        { to: '/dispatch', label: 'Dispatch', icon: 'route', perms: ['logistics.pickup.manage', 'receiving.gate.create'] },
        { to: '/fleet', label: 'Vehicles & Drivers', icon: 'truck', perms: ['master.vehicle.manage', 'receiving.gate.create'] },
      ],
    },
    {
      label: 'Money',
      items: [
        { to: '/invoices', label: 'Invoices & Match', icon: 'invoice', perms: ['finance.invoice.create', 'finance.invoice.match'] },
        { to: '/payments', label: 'Payment Status', icon: 'card', perms: ['finance.payment.view'] },
        { to: '/suppliers', label: 'Suppliers', icon: 'handshake' },
      ],
    },
    {
      label: 'Insight',
      items: [
        { to: '/reports', label: 'Reports', icon: 'chart', perms: ['reports.purchase.view'] },
        { to: '/ai', label: 'AI Centre', icon: 'sparkle' },
        { to: '/people', label: 'People & Access', icon: 'people', perms: ['admin.rbac.manage'] },
        { to: '/settings', label: 'Settings', icon: 'gear', perms: ['admin.settings.manage'] },
      ],
    },
  ];

  return (
    <div className={`app ${touch ? 'touch' : ''}`}>
      {navOpen ? <div className="nav-backdrop" onClick={() => setNavOpen(false)} /> : null}

      <aside className={`sidebar ${navOpen ? 'open' : ''}`}>
        <div className="sidebar-brand">
          <div style={{ flex: 1, minWidth: 0 }}>
            <b>ChotuG</b>
            <span>Purchase &amp; Receiving</span>
          </div>
          <button className="nav-close" onClick={() => setNavOpen(false)} aria-label="Close menu">✕</button>
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
                  <span className="ic"><Icon name={i.icon} /></span>
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
            <span className="ic"><Icon name="user" /></span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{me?.fullName}</span>
          </div>
          <div className="nav-item" onClick={() => { logout(); nav('/login'); }}>
            <span className="ic"><Icon name="signOut" /></span><span>Sign out</span>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="nav-toggle" onClick={() => setNavOpen(true)}
            aria-label="Open menu" aria-expanded={navOpen}>☰</button>
          <div className="topbar-head">
            <div className="title">{title}</div>
            {subtitle ? <div className="sub">{subtitle}</div> : null}
          </div>
          <div className="spacer" />
          <div className="topbar-actions">
            {/* Branch is our internal structure — an outside user has no use for
                it and no business seeing how many we have. */}
            {!outside && me && me.branches.length > 1 ? (
              <select className="branch-select" value={branchId ?? ''} onChange={(e) => setBranchId(e.target.value)}>
                {me.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            ) : null}
            {actions}
          </div>
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
