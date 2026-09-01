import React, { createContext, useContext, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api, useAuth, inr, num, ago } from '../lib/api';
import { Icon } from './icons';

/* ------------------------------------------------------------- toasts ---- */
type Toast = { id: number; text: string; kind: 'ok' | 'err' | 'info' };
const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
const EmbeddedCtx = createContext(false);
export const EmbeddedPage = ({ children }: { children: React.ReactNode }) => (
  <EmbeddedCtx.Provider value>{children}</EmbeddedCtx.Provider>
);

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
export function Modal({ title, onClose, children, footer, wide, className }: {
  title: string; onClose: () => void; children: React.ReactNode;
  footer?: React.ReactNode; wide?: boolean; className?: string;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return createPortal((
    <div className={`modal-back ${className ?? ''}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`}>
        <div className="modal-head">
          <h2 style={{ flex: 1 }}>{title}</h2>
          <button className="btn ghost sm" onClick={onClose}><Icon name="alert" size={15} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  ), document.body);
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

const TRANSLATION_LANGUAGES = [
  ['en', 'English'], ['hi', 'Hindi'], ['mr', 'Marathi'], ['pa', 'Punjabi'],
  ['bn', 'Bengali'], ['gu', 'Gujarati'], ['ta', 'Tamil'],
] as const;

export function LanguageSelector() {
  const [language, setLanguage] = useState(() => localStorage.getItem('chotug_language') ?? 'en');

  useEffect(() => {
    const win = window as any;
    const removeGoogleBanner = () => {
      document.querySelectorAll('.goog-te-banner-frame, iframe.skiptranslate').forEach((node) => {
        (node as HTMLElement).style.display = 'none';
        (node as HTMLElement).style.visibility = 'hidden';
      });
      document.documentElement.style.marginTop = '0';
      document.body.style.top = '0';
      document.body.style.marginTop = '0';
    };
    const bannerObserver = new MutationObserver(removeGoogleBanner);
    bannerObserver.observe(document.documentElement, { childList: true, subtree: true });
    removeGoogleBanner();
    const applySavedLanguage = () => {
      const combo = document.querySelector<HTMLSelectElement>('.goog-te-combo');
      if (!combo || combo.value === (language === 'en' ? '' : language)) return;
      combo.value = language === 'en' ? '' : language;
      combo.dispatchEvent(new Event('change'));
    };
    win.googleTranslateElementInit = () => {
      if (document.getElementById('google_translate_element')?.children.length) return;
      new win.google.translate.TranslateElement({
        pageLanguage: 'en',
        includedLanguages: TRANSLATION_LANGUAGES.map(([code]) => code).filter((code) => code !== 'en').join(','),
        autoDisplay: false,
      }, 'google_translate_element');
      window.setTimeout(applySavedLanguage, 0);
    };

    if (!document.getElementById('google-translate-script')) {
      const script = document.createElement('script');
      script.id = 'google-translate-script';
      script.src = 'https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit';
      script.async = true;
      document.body.appendChild(script);
    } else if (win.google?.translate) {
      win.googleTranslateElementInit();
      window.setTimeout(applySavedLanguage, 0);
    }
    return () => bannerObserver.disconnect();
  }, [language]);

  const changeLanguage = (next: string) => {
    setLanguage(next);
    localStorage.setItem('chotug_language', next);
    if (next === 'en') {
      /* Google keeps the selected language in a cookie. Resetting only its
       * hidden select leaves already-translated DOM nodes in place. */
      document.cookie = 'googtrans=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
      document.cookie = 'googtrans=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=' + window.location.hostname;
      window.location.reload();
      return;
    }
    const combo = document.querySelector<HTMLSelectElement>('.goog-te-combo');
    if (!combo) return;
    combo.value = next === 'en' ? '' : next;
    combo.dispatchEvent(new Event('change'));
  };

  return (
    <div className="language-picker">
      <label htmlFor="language-select">Language</label>
      <select id="language-select" value={language} onChange={(e) => changeLanguage(e.target.value)}>
        {TRANSLATION_LANGUAGES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
      </select>
      <div id="google_translate_element" aria-hidden="true" />
    </div>
  );
}

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
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const embedded = useContext(EmbeddedCtx);

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
  const centreUser = !!me?.roles.includes('CENTRE_EXEC');
  const auditor = !!me?.roles.includes('AUDITOR');
  const groups: { label: string; items: NavDef[] }[] = outside ? [
    {
      label: me?.roles.includes('DRIVER') ? 'Driver' : 'Supplier',
      items: [
        me?.roles.includes('DRIVER')
          ? { to: '/', label: 'My pickups', icon: 'truck' }
          : { to: '/', label: 'My orders & invoices', icon: 'doc' },
      ],
    },
  ] : centreUser ? [
    {
      label: 'Centre',
      items: [
        { to: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
        { to: '/sell', label: 'Sell', icon: 'coins', perms: ['inventory.stock.issue'] },
        { to: '/requirements', label: 'Raise requirement', icon: 'clipboard',
          perms: ['purchase.requirement.create'] },
        { to: me?.warehouses[0] ? `/centres/${me.warehouses[0].id}` : '/',
          label: 'Receive & close day', icon: 'truckIn', perms: ['centre.stock.receive', 'centre.day.close'] },
      ],
    },
  ] : [
    {
      label: 'Work',
      items: [
        { to: '/', label: 'Home', icon: 'dashboard' },
        { to: '/my-work', label: 'My Work', icon: 'target', badge: queueCount },
        { to: '/audit', label: 'Audit', icon: 'clipboard',
          perms: ['audit.count.record', 'audit.report.view', 'audit.task.raise'] },
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
        /* Next to the orders, not down in the warehouse block. Arranging a
           lorry is something you decide while looking at an order — most often
           because the supplier has just asked for one — and having to cross the
           whole menu to do it was a reason to leave it until later. */
        { to: '/dispatch', label: 'Dispatch', icon: 'route', perms: ['logistics.pickup.manage', 'receiving.gate.create'] },
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
        { to: '/arrivals', label: 'Deliveries & Receiving', icon: 'truckIn', perms: ['receiving.gate.create'] },
        // The warehouse's own first step: weigh it, count the crates, pass it on.
        { to: '/intake', label: 'Warehouse Intake', icon: 'scale', perms: ['receiving.weighment.create'] },
        /* Refusing a load and telling the supplier are two different acts, and
           the second was nobody's job. It sits next to receiving because that
           is where the crates are still standing. */
        { to: '/rejections', label: 'Turned Away', icon: 'alert', perms: ['quality.inspection.view'] },
        { to: '/grns', label: 'Goods Receipts', icon: 'inbox', perms: ['receiving.grn.create', 'receiving.grn.submit'] },
        // Selling is where stock stops being cost and becomes revenue, so it
        // sits with the money, not with the warehouse shelves.
        /* Quality and packing are one job at one bench, so the people who do
           the grading have to be able to reach it. QC holds inventory.pack.*
           and used to be locked out of the only screen that leads there. */
        { to: '/packing', label: 'Quality & Packing', icon: 'tag',
          perms: ['inventory.stock.issue', 'inventory.pack.grade'] },
      ],
    },
    {
      label: 'Inventory',
      items: [
        { to: '/warehouse-map', label: 'Warehouse', icon: 'shelf',
          perms: ['master.location.manage', 'inventory.pack.store'] },
      ],
    },
    {
      label: 'Sell',
      items: [
        { to: '/sales', label: 'Sell to customer', icon: 'coins', perms: ['inventory.stock.issue'] },
        { to: '/centres', label: 'Centres', icon: 'home',
          perms: ['centre.performance.view', 'centre.day.close', 'centre.stock.receive'] },
      ],
    },
    {
      label: 'Finance',
      items: [
        { to: '/finance', label: can('finance.expense.view') ? 'Finance Desk' : 'Money Requests',
          icon: 'coins',
          perms: ['finance.request.create', 'finance.request.verify', 'finance.payment.make', 'finance.receipt.record'] },
        /* The desk is a queue; this is the record. Different question, so it is
           a different item rather than a sixth tab on the desk. */
        { to: '/money', label: 'Money In & Out', icon: 'chart',
          perms: ['finance.expense.view'] },
        { to: '/invoices', label: 'Invoices & Match', icon: 'invoice', perms: ['finance.invoice.create', 'finance.invoice.match'] },
        { to: '/payments', label: 'Payment Status', icon: 'card', perms: ['finance.payment.view'] },
      ],
    },
    {
      label: 'People',
      items: [
        { to: '/customers', label: 'Customers', icon: 'people',
          perms: ['master.customer.manage'] },
        { to: '/hr', label: 'Workers & Wages', icon: 'user',
          perms: ['hr.report.view', 'hr.attendance.mark', 'hr.worker.manage'] },
        { to: '/people', label: 'Users & Permissions', icon: 'people', perms: ['admin.rbac.manage'] },
      ],
    },
    {
      label: 'Insights',
      items: [
        { to: '/analytics', label: 'Analytics', icon: 'chart',
          perms: ['reports.purchase.view', 'inventory.stock.issue', 'data.margin.view',
            'reports.supplier.view', 'master.supplier.manage', 'finance.expense.view',
            'finance.request.verify', 'finance.payment.make', 'finance.request.create'] },
        { to: '/performance', label: 'Product Performance', icon: 'chart',
          perms: ['reports.purchase.view'] },
        { to: '/ai', label: 'AI Centre', icon: 'sparkle',
          perms: ['ai.feature.manage', 'ai.suggestion.accept'] },
        { to: '/alerts', label: 'Alerts', icon: 'bell', badge: alertCount,
          perms: ['reports.purchase.view', 'admin.settings.manage', 'quality.inspection.approve', 'farming.report.view'] },
      ],
    },
    {
      label: 'Admin',
      items: [
        { to: '/master-data', label: 'Master Data', icon: 'box',
          perms: ['master.product.manage', 'master.category.manage', 'master.supplier.manage',
            'master.vehicle.manage', 'master.customer.manage', 'master.location.manage',
            'admin.settings.manage'] },
        { to: '/catalogue', label: 'Catalogue', icon: 'basket',
          perms: ['master.product.manage', 'master.category.manage', 'reports.purchase.view'] },
        { to: '/settings', label: 'Settings', icon: 'gear', perms: ['admin.settings.manage'] },
      ],
    },
  ];

  useEffect(() => {
    const active = groups.find((g) => g.label !== 'Work' && g.items.some((i) =>
      i.to !== '/' && (pathname === i.to || pathname.startsWith(`${i.to}/`))));
    if (active) setOpenGroup(active.label);
  }, [pathname]);

  const sectionIcons: Record<string, string> = {
    'Plan & Buy': 'box', Receive: 'truckIn', Inventory: 'crates', Sell: 'coins',
    Finance: 'coins', People: 'people', Insights: 'chart', Admin: 'gear',
  };

  if (embedded) {
    return (
      <div className="embedded-page">
        <div className="embedded-head">
          <div><h2>{title}</h2>{subtitle ? <div className="sub">{subtitle}</div> : null}</div>
          {actions ? <div className="btn-row">{actions}</div> : null}
        </div>
        {children}
      </div>
    );
  }

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
          const items = g.items.filter((i) => !i.perms || can(...i.perms))
            .filter((i) => !(auditor && i.to === '/alerts'));
          if (!items.length) return null;
          const active = items.some((i) => i.to !== '/' &&
            (pathname === i.to || pathname.startsWith(`${i.to}/`)));
          const expandable = g.label !== 'Work' && !outside && !centreUser;
          const expanded = openGroup === g.label;
          return (
            <div className={`sidebar-group ${active ? 'has-active' : ''}`} key={g.label}>
              {!expandable ? <div className="sidebar-group-label">{g.label}</div> : null}
              {expandable ? (
                <>
                  <button type="button" className={`nav-item nav-section ${active ? 'active-parent' : ''}`}
                    onClick={() => setOpenGroup(expanded ? null : g.label)}
                    aria-expanded={expanded}>
                    <span className="ic"><Icon name={sectionIcons[g.label] ?? 'dashboard'} /></span>
                    <span>{g.label}</span><span className="nav-chevron">{expanded ? '⌄' : '›'}</span>
                  </button>
                  {expanded ? <div className="nav-children">{items.map((i) => (
                    <NavLink key={i.to} to={i.to} end={i.to === '/'}
                      className={({ isActive }) => `nav-item nav-child ${isActive ? 'active' : ''}`}>
                      <span>{i.label}</span>
                      {i.badge ? <span className={`nav-badge ${i.label === 'Alerts' ? 'crit' : ''}`}>{i.badge}</span> : null}
                    </NavLink>
                  ))}</div> : null}
                </>
              ) : items.map((i) => (
                <NavLink key={i.to} to={i.to} end={i.to === '/'}
                  className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                  <span className="ic"><Icon name={i.icon} /></span>
                  <span>{i.label}</span>
                  {i.badge ? <span className="nav-badge">{i.badge}</span> : null}
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
            <LanguageSelector />
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
  /**
   * What this column sorts on. Give it and the heading becomes clickable.
   *
   * It has to be separate from `render`, which returns JSX — sorting on the
   * rendered output would order "₹1,200" before "₹900" because that is how
   * strings compare, which is the exact bug this exists to avoid.
   */
  sort?: (row: T) => string | number | null | undefined;
  /** Sort descending on the first click — right for anything money or dated. */
  desc?: boolean;
};

/**
 * Sorting lives here rather than in each screen because a table that sorts
 * differently on two pages is worse than one that does not sort at all. Give a
 * column a `sort` and its heading becomes clickable; give it none and it stays
 * exactly as it was.
 *
 * Nulls always sink, ascending or descending: a row with no date is not the
 * oldest row, it is a row somebody has not filled in yet, and putting it at the
 * top of "oldest first" hides the thing that was actually being looked for.
 */
/* The fields a row might carry its own age in, best first. Every list on every
 * screen wants "oldest first / newest first" and none of them should have to
 * add the column by hand — a table that can be sorted by time on one page and
 * not the next is the same inconsistency `sort` exists to prevent. */
const TIME_FIELDS = [
  'created_at', 'requested_at', 'issued_at', 'received_at', 'ordered_at',
  'recorded_at', 'posted_at', 'entered_at', 'inspected_at', 'updated_at',
];

function timeOf(row: any): string | null {
  if (!row || typeof row !== 'object') return null;
  for (const f of TIME_FIELDS) if (row[f]) return String(row[f]);
  return null;
}

export function DataTable<T>({
  rows, cols, onRowClick, rowTone, empty, loading, defaultSort, noAddedColumn,
}: {
  rows: T[]; cols: Col<T>[];
  onRowClick?: (row: T) => void;
  rowTone?: (row: T) => 'warn' | 'crit' | undefined;
  empty?: React.ReactNode; loading?: boolean;
  /** Column key to sort by before anybody clicks anything. */
  defaultSort?: string;
  /** Opt out where the row's own age is genuinely not information. */
  noAddedColumn?: boolean;
}) {
  /* "Added" is appended rather than asked for, so it is on every table that has
     a time to show without eighty screens each remembering to add it. Rows that
     carry no timestamp — anything grouped or aggregated — get no column, which
     is the right answer rather than an empty one. */
  const cols2 = React.useMemo(() => {
    if (noAddedColumn) return cols;
    if (!rows.length || !rows.some((r) => timeOf(r))) return cols;
    if (cols.some((c) => c.key === '_added')) return cols;
    /* Some screens already show the row's age under their own heading. Match on
       the VALUE rather than the label, so "When", "Added" and "Raised" are all
       recognised and none of them ends up next to a second identical column. */
    const probe = rows.find((r) => timeOf(r));
    if (probe && cols.some((c) => c.sort && String(c.sort(probe) ?? '') === timeOf(probe))) {
      return cols;
    }
    return [...cols, {
      key: '_added',
      head: 'Added',
      desc: true,
      sort: (r: T) => timeOf(r) ?? null,
      render: (r: T) => {
        const t = timeOf(r);
        return t
          ? <span className="small muted" title={new Date(t).toLocaleString()}>{ago(t)}</span>
          : <span className="small muted">—</span>;
      },
    } as Col<T>];
  }, [cols, rows, noAddedColumn]);

  const [sortKey, setSortKey] = React.useState<string | null>(defaultSort ?? null);
  const [dir, setDir] = React.useState<'asc' | 'desc'>(() =>
    (cols.find((c) => c.key === defaultSort)?.desc ? 'desc' : 'asc'));

  const sorted = React.useMemo(() => {
    const col = cols2.find((c) => c.key === sortKey);
    if (!col?.sort) return rows;
    const sign = dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = col.sort!(a);
      const y = col.sort!(b);
      const xEmpty = x == null || x === '';
      const yEmpty = y == null || y === '';
      if (xEmpty && yEmpty) return 0;
      if (xEmpty) return 1;
      if (yEmpty) return -1;
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
      return String(x).localeCompare(String(y), undefined, { numeric: true }) * sign;
    });
  }, [rows, cols2, sortKey, dir]);

  const click = (c: Col<T>) => {
    if (!c.sort) return;
    if (sortKey === c.key) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(c.key); setDir(c.desc ? 'desc' : 'asc'); }
  };

  if (loading) return <Loading />;
  if (!rows.length) return <>{empty ?? <Empty title="Nothing here yet" />}</>;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>{cols2.map((c) => (
            <th key={c.key}
              className={`${c.num ? 'num' : ''} ${c.sort ? 'sortable' : ''} ${sortKey === c.key ? 'sorted' : ''}`}
              style={c.width ? { width: c.width } : undefined}
              onClick={() => click(c)}
              title={c.sort ? `Sort by ${c.head.toLowerCase()}` : undefined}>
              {c.head}
              {c.sort ? (
                <span className="sort-arrow">
                  {sortKey === c.key ? (dir === 'asc' ? '▲' : '▼') : '↕'}
                </span>
              ) : null}
            </th>
          ))}</tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => {
            const tone = rowTone?.(r);
            return (
              <tr key={i}
                className={`${onRowClick ? 'clickable' : ''} ${tone === 'crit' ? 'row-crit' : tone === 'warn' ? 'row-warn' : ''}`}
                onClick={() => onRowClick?.(r)}>
                {cols2.map((c) => (
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
  /**
   * The "no filter" option. Defaults to `Every {label}`, which reads correctly
   * for a noun — "Every supplier", "Every grade" — and badly for anything
   * else: "Every priced", "Every freshness", "Every timing". Where the facet
   * is a state rather than a thing, name the option here.
   */
  all?: string;
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
  /* Nothing to filter, nothing to filter with. FilterTotals already hides
   * itself on an empty list; the bar did not, so a screen with no rows still
   * offered a search box and a row of dropdowns that could never do anything.
   *
   * Children are the exception and the reason this is not simply
   * `if (!f.all.length) return null`: they are server-side controls — a date
   * range, a branch picker — and the list may be empty *because* of them.
   * Hiding those would strand somebody with no way to widen the search. */
  if (!f.all.length && !children) return null;

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
          <option value="">{facet.all ?? `Every ${facet.label.toLowerCase()}`}</option>
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
  /* The plural belongs on the head noun, not the tail: twenty KINDS of box,
     not twenty kind of boxes. */
  'kind of box': 'kinds of box',
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
