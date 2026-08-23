import React, { createContext, useContext, useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api, useAuth, inr, num } from '../lib/api';
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
          <button className="btn ghost sm" onClick={onClose}><Icon name="alert" size={15} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- states ---- */
/**
 * Empty and loading states.
 *
 * Call sites still pass an emoji as `icon` — forty of them — and rather than
 * touch every one, that string is mapped onto the stroked set. An emoji with
 * no mapping falls back to the neutral glyph instead of rendering somebody
 * else's artwork at three times the weight of the text beside it.
 */
const EMPTY_ICON: Record<string, string> = {
  '✅': 'checkDoc', '👍': 'checkDoc', '🤝': 'handshake', '📦': 'box',
  '🏷️': 'tag', '🏷': 'tag', '🧾': 'receipt', '🚜': 'tractor', '🚛': 'truckIn',
  '🚚': 'truck', '📈': 'chart', '🌾': 'sprout', '🌱': 'sprout', '🧪': 'scale',
  '₹': 'coins', '🛃': 'gate', '🔕': 'bell', '🔒': 'gear', '📥': 'inbox',
  '📤': 'inbox', '📝': 'clipboard', '📄': 'doc', '📊': 'dashboard',
  '🧺': 'crates', '📦️': 'box', '📅': 'clipboard', '🗓': 'clipboard',
  '💰': 'coins', '🧮': 'calculator', '⏳': 'target', '📭': 'inbox',
  '🌤️': 'sun', '🏡': 'home', '🧭': 'compass', '📍': 'pin', '👥': 'people',
};

export function Empty({ icon = '📭', title, hint, action }: {
  icon?: string; title: string; hint?: string; action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-ic"><Icon name={EMPTY_ICON[icon] ?? 'inbox'} size={26} /></div>
      <div style={{ fontWeight: 600, color: 'var(--text-2)' }}>{title}</div>
      {hint ? <div className="small mt">{hint}</div> : null}
      {action ? <div className="mt">{action}</div> : null}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="empty">
      <div className="spinner" role="status" aria-label={label} />
      <div className="mt">{label}</div>
    </div>
  );
}

export function ErrorBanner({ error }: { error: any }) {
  if (!error) return null;
  const detail = error?.detail && typeof error.detail === 'object'
    ? Object.values(error.detail).join(' · ') : null;
  return (
    <div className="banner danger mb">
      <span><Icon name="alert" size={16} /></span>
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
        { to: '/alerts', label: 'Alerts', icon: 'bell', badge: alertCount,
          perms: ['reports.purchase.view', 'admin.settings.manage', 'quality.inspection.approve', 'farming.report.view'] },
      ],
    },
    {
      label: 'Plan & Buy',
      items: [
        // The whole raise → approve → order → confirm chain in one page, for
        // whoever owns the decision end to end. The separate screens below are
        // unchanged and remain the path when the work is split across people.
        // The one-page flow raises, approves and confirms in a single sweep, so it
        // hands whoever opens it the whole chain of authority at once. That is
        // only ever the owner's shortcut — everyone else uses the staged pages,
        // where raising, approving and confirming are separate acts by separate
        // people. Gated on admin.override, which only the Owner role holds.
        { to: '/order-flow', label: 'Order in one flow', icon: 'bolt', perms: ['admin.override'] },
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
        { to: '/farm/crops', label: 'Crops', icon: 'sprout', perms: ['farming.crop.start'] },
        { to: '/farm/harvest', label: 'Harvest', icon: 'basket', perms: ['farming.harvest.record'] },
        { to: '/farm/dispatch', label: 'Farm → Warehouse', icon: 'tractor', perms: ['farming.dispatch.create', 'farming.dispatch.receive'] },
        { to: '/farm/expenses', label: 'Farm Expenses', icon: 'receipt', perms: ['farming.expense.create', 'farming.cost.view'] },
        { to: '/farm/planning', label: 'Crop Planning', icon: 'compass', perms: ['farming.crop.start', 'farming.farm.manage'] },
        { to: '/farm/setup', label: 'Farms & Plots', icon: 'pin', perms: ['farming.farm.manage'] },
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
        { to: '/warehouse-map', label: 'Warehouse Map', icon: 'shelf',
          perms: ['master.location.manage', 'inventory.pack.store'] },
        { to: '/stock', label: 'Stock & Batches', icon: 'crates',
          perms: ['receiving.grn.create', 'receiving.putaway.confirm', 'inventory.stock.issue', 'reports.purchase.view'] },
        // Selling is where stock stops being cost and becomes revenue, so it
        // sits with the money, not with the warehouse shelves.
        { to: '/packing', label: 'Packing & Labels', icon: 'tag', perms: ['inventory.stock.issue'] },
        { to: '/sales', label: 'Sell & Profit', icon: 'coins',
          perms: ['inventory.stock.issue', 'data.margin.view'] },
        { to: '/dispatch', label: 'Dispatch', icon: 'route', perms: ['logistics.pickup.manage', 'receiving.gate.create'] },
        { to: '/fleet', label: 'Vehicles & Drivers', icon: 'truck', perms: ['master.vehicle.manage', 'receiving.gate.create'] },
      ],
    },
    {
      label: 'Sell',
      items: [
        { to: '/centres', label: 'Centres', icon: 'home',
          perms: ['centre.performance.view', 'centre.day.close', 'centre.stock.receive'] },
        { to: '/customers', label: 'Customers', icon: 'people',
          perms: ['master.customer.manage'] },
      ],
    },
    {
      label: 'Money',
      items: [
        /* The desk comes first: it is the one screen where money actually
         * moves, and the client asked for Finance to be the centre of the
         * business rather than a report at the end of it. */
        { to: '/finance', label: can('finance.expense.view') ? 'Finance Desk' : 'Money Requests',
          icon: 'coins',
          perms: ['finance.request.create', 'finance.request.verify', 'finance.payment.make', 'finance.receipt.record'] },
        { to: '/invoices', label: 'Invoices & Match', icon: 'invoice', perms: ['finance.invoice.create', 'finance.invoice.match'] },
        { to: '/payments', label: 'Payment Status', icon: 'card', perms: ['finance.payment.view'] },
        { to: '/suppliers', label: 'Suppliers', icon: 'handshake',
          perms: ['reports.supplier.view', 'master.supplier.manage'] },
      ],
    },
    {
      label: 'Insight',
      items: [
        { to: '/audit', label: 'Audit', icon: 'clipboard',
          perms: ['audit.count.record', 'audit.report.view', 'audit.task.raise'] },
        { to: '/performance', label: 'Product Performance', icon: 'chart',
          perms: ['reports.purchase.view'] },
        { to: '/reports', label: 'Reports', icon: 'doc', perms: ['reports.purchase.view'] },
        { to: '/ai', label: 'AI Centre', icon: 'sparkle',
          perms: ['ai.feature.manage', 'ai.suggestion.accept'] },
        { to: '/catalogue', label: 'Catalogue', icon: 'basket',
          perms: ['master.product.manage', 'master.category.manage', 'reports.purchase.view'] },
        { to: '/hr', label: 'Workers & Wages', icon: 'user',
          perms: ['hr.report.view', 'hr.attendance.mark', 'hr.worker.manage'] },
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
          <button className="nav-close" onClick={() => setNavOpen(false)} aria-label="Close menu"><Icon name="alert" size={15} /></button>
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


/* ===========================================================================
 * FILTERS, AND THE NUMBERS UNDER THEM
 *
 *   "there should be various filter on every list in the website, the one must
 *    filter is by time … after the filter there should come up numbers
 *    representing the filter like total entities in that filter, total cost."
 *
 * One hook, one bar, one totals strip — used by every list, so a filter behaves
 * the same on the order list as on the requirement list. Written once because
 * six hand-rolled filter bars is six sets of slightly different behaviour and
 * five of them will be subtly wrong.
 *
 * The totals are the point. A filtered list without them answers "which ones"
 * but not "how much", and "how much" is the question somebody filtered in order
 * to ask.
 * ======================================================================== */

export type Facet<T> = {
  key: string;
  label: string;
  /** The value this row falls under, or null to leave it out of that facet. */
  of: (row: T) => string | null | undefined;
};

export type Total<T> = {
  label: string;
  of: (row: T) => number;
  /** Render as rupees rather than a plain count. */
  money?: boolean;
  decimals?: number;
};

export type FilterSpec<T> = {
  /** The date this row belongs to. Omit for lists with no meaningful date. */
  date?: (row: T) => string | null | undefined;
  /** Everything a search should look through, joined. */
  search?: (row: T) => string;
  facets?: Facet<T>[];
  totals?: Total<T>[];
  /** Default window in days; 0 means everything. */
  defaultDays?: number;
};

const WINDOWS: { days: number; label: string }[] = [
  { days: 0, label: 'All time' },
  { days: 1, label: 'Today' },
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
  { days: 365, label: 'Last year' },
];

export function useFilters<T>(rows: T[] | null | undefined, spec: FilterSpec<T>) {
  const all = React.useMemo(() => rows ?? [], [rows]);
  const [days, setDays] = React.useState(spec.defaultDays ?? 0);
  const [q, setQ] = React.useState('');
  const [picked, setPicked] = React.useState<Record<string, string>>({});

  /* Options come from the data, not a hard-coded list: a supplier who has never
   * been ordered from should not sit in the dropdown, and one who was added
   * this morning should. */
  const options = React.useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const f of spec.facets ?? []) {
      const seen = new Set<string>();
      for (const r of all) {
        const v = f.of(r);
        if (v != null && v !== '') seen.add(String(v));
      }
      out[f.key] = [...seen].sort((a, b) => a.localeCompare(b));
    }
    return out;
  }, [all, spec.facets]);

  const filtered = React.useMemo(() => {
    const cutoff = days > 0
      ? new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
      : null;
    const needle = q.trim().toLowerCase();

    return all.filter((r) => {
      if (cutoff && spec.date) {
        const d = spec.date(r);
        /* A row with no date survives a date filter. Hiding it would quietly
         * drop draft records that have not been dated yet, and somebody would
         * spend an afternoon looking for them. */
        if (d && String(d).slice(0, 10) < cutoff) return false;
      }
      if (needle && spec.search && !spec.search(r).toLowerCase().includes(needle)) return false;
      for (const f of spec.facets ?? []) {
        const want = picked[f.key];
        if (!want) continue;
        if (String(f.of(r) ?? '') !== want) return false;
      }
      return true;
    });
  }, [all, days, q, picked, spec]);

  const totals = React.useMemo(() => (spec.totals ?? []).map((t) => ({
    label: t.label,
    money: t.money,
    decimals: t.decimals,
    value: filtered.reduce((a, r) => a + (Number(t.of(r)) || 0), 0),
  })), [filtered, spec.totals]);

  const active = Object.values(picked).filter(Boolean).length
    + (q.trim() ? 1 : 0) + (days > 0 ? 1 : 0);

  return {
    rows: filtered, all, days, setDays, q, setQ, picked, setPicked,
    options, totals, active, facets: spec.facets ?? [], hasDate: !!spec.date,
    clear: () => { setPicked({}); setQ(''); setDays(spec.defaultDays ?? 0); },
  };
}

export function FilterBar({ f, placeholder, children }: {
  f: ReturnType<typeof useFilters<any>>; placeholder?: string; children?: React.ReactNode;
}) {
  return (
    <div className="search-bar">
      {f.hasDate ? (
        <select value={f.days} onChange={(e) => f.setDays(Number(e.target.value))}>
          {WINDOWS.map((w) => <option key={w.days} value={w.days}>{w.label}</option>)}
        </select>
      ) : null}
      {f.facets.map((facet) => (
        <select key={facet.key} value={f.picked[facet.key] ?? ''}
          onChange={(e) => f.setPicked((s: any) => ({ ...s, [facet.key]: e.target.value }))}>
          <option value="">{`Every ${facet.label.toLowerCase()}`}</option>
          {(f.options[facet.key] ?? []).map((o) => (
            <option key={o} value={o}>{o.replace(/_/g, ' ').toLowerCase()}</option>))}
        </select>
      ))}
      <input value={f.q} onChange={(e) => f.setQ(e.target.value)}
        placeholder={placeholder ?? 'Search'} />
      {children}
      {f.active > 0 ? (
        <button className="btn sm" onClick={f.clear}>
          Clear {f.active} filter{f.active === 1 ? '' : 's'}
        </button>
      ) : null}
    </div>
  );
}

/* "batchs", "deliverys" and "persons" all appeared on screen the first time
 * these strips went in. English plurals are irregular enough that a bare +'s'
 * is wrong often enough to notice, and a wrong plural on a number makes the
 * number itself look careless. */
const PLURAL: Record<string, string> = {
  person: 'people', delivery: 'deliveries', batch: 'batches', box: 'boxes',
  entry: 'entries', company: 'companies', category: 'categories', body: 'bodies',
  match: 'matches', dispatch: 'dispatches', loss: 'losses', class: 'classes',
};

function plural(noun: string) {
  if (PLURAL[noun]) return PLURAL[noun];
  if (/(s|x|z|ch|sh)$/.test(noun)) return `${noun}es`;
  if (/[^aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`;
  return `${noun}s`;
}

/** What is left after filtering, and what it adds up to. */
export function FilterTotals({ f, noun = 'row' }: {
  f: ReturnType<typeof useFilters<any>>; noun?: string;
}) {
  if (!f.all.length) return null;
  return (
    <div className="filter-total">
      <span>
        <b>{f.rows.length}</b> {f.rows.length === 1 ? noun : plural(noun)}
        {f.rows.length !== f.all.length ? (
          <span className="muted"> of {f.all.length}</span>
        ) : null}
      </span>
      <span className="row" style={{ gap: 20 }}>
        {f.totals.map((t: any) => (
          <span key={t.label} className="ft-num">
            <em>{t.label}</em>
            <b>{t.money ? inr(t.value, t.decimals ?? 0) : num(t.value, t.decimals ?? 0)}</b>
          </span>
        ))}
      </span>
    </div>
  );
}
