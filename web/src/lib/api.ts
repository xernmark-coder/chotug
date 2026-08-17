import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/* ---------------------------------------------------------------- API ---- */

const TOKEN_KEY = 'chotug_token';
// Empty by design: requests go out same-origin as /api/… and the Vite dev
// proxy forwards them to the API. An absolute localhost URL would break every
// device that is not this machine (phones, ngrok/tunnel links) and would drag
// CORS into a request that never needed it. Deployments set VITE_API_URL.
const API_BASE = import.meta.env.VITE_API_URL || '';

export class ApiError extends Error {
  constructor(public status: number, message: string, public detail?: any, public code?: string) {
    super(message);
  }
}

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch(`${API_BASE}/api${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401) localStorage.removeItem(TOKEN_KEY);
    throw new ApiError(res.status, data?.error ?? 'Something went wrong', data?.detail, data?.code);
  }
  return data as T;
}

export const api = {
  get: <T,>(p: string) => request<T>(p),
  post: <T,>(p: string, b?: any) => request<T>(p, { method: 'POST', body: JSON.stringify(b ?? {}) }),
  put: <T,>(p: string, b?: any) => request<T>(p, { method: 'PUT', body: JSON.stringify(b ?? {}) }),
  setToken: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clearToken: () => localStorage.removeItem(TOKEN_KEY),
  hasToken: () => !!localStorage.getItem(TOKEN_KEY),
};

/** Stable key so a retried POST never posts stock twice (§9.2). */
export function idempotencyKey(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

/* --------------------------------------------------------------- types --- */

export type Me = {
  id: string; fullName: string; email: string; employeeCode: string | null;
  locale: string; companyName: string; defaultBranchId: string | null;
  branches: { id: string; code: string; name: string; type: string }[];
  warehouses: { id: string; code: string; name: string; branchId: string }[];
  roles: string[]; permissions: string[];
  limits: {
    maxPoValue: number | null; maxApprovalLevel: number;
    maxRateVariancePct: number | null; maxWeightVariancePct: number | null;
    maxBackdateDays: number; maxInvoiceMismatchValue: number | null;
  };
};

/* ---------------------------------------------------------------- auth --- */

type AuthCtx = {
  me: Me | null;
  loading: boolean;
  branchId: string | null;
  warehouseId: string | null;
  setBranchId: (id: string) => void;
  setWarehouseId: (id: string) => void;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  can: (...codes: string[]) => boolean;
};

const Ctx = createContext<AuthCtx>(null as any);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [branchId, setBranchIdState] = useState<string | null>(localStorage.getItem('chotug_branch'));
  const [warehouseId, setWarehouseIdState] = useState<string | null>(localStorage.getItem('chotug_wh'));

  const load = useCallback(async () => {
    if (!api.hasToken()) { setLoading(false); return; }
    try {
      const profile = await api.get<Me>('/auth/me');
      setMe(profile);
      if (!branchId) {
        const b = profile.defaultBranchId ?? profile.branches[0]?.id ?? null;
        if (b) { setBranchIdState(b); localStorage.setItem('chotug_branch', b); }
      }
      if (!warehouseId && profile.warehouses[0]) {
        setWarehouseIdState(profile.warehouses[0].id);
        localStorage.setItem('chotug_wh', profile.warehouses[0].id);
      }
    } catch {
      api.clearToken();
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void load(); }, [load]);

  const value = useMemo<AuthCtx>(() => ({
    me, loading, branchId, warehouseId,
    setBranchId: (id) => { setBranchIdState(id); localStorage.setItem('chotug_branch', id); },
    setWarehouseId: (id) => { setWarehouseIdState(id); localStorage.setItem('chotug_wh', id); },
    login: async (email, password) => {
      const r = await api.post<{ token: string; user: Me }>('/auth/login', { email, password });
      api.setToken(r.token);
      setMe(r.user);
      const b = r.user.defaultBranchId ?? r.user.branches[0]?.id ?? null;
      if (b) { setBranchIdState(b); localStorage.setItem('chotug_branch', b); }
      if (r.user.warehouses[0]) {
        setWarehouseIdState(r.user.warehouses[0].id);
        localStorage.setItem('chotug_wh', r.user.warehouses[0].id);
      }
    },
    logout: () => { api.clearToken(); setMe(null); },
    // Mirrors the server guard, but the server is the authority — this only
    // decides what to render, never what is allowed.
    can: (...codes) => !!me && (me.permissions.includes('admin.override')
      || codes.some((c) => me.permissions.includes(c))),
  }), [me, loading, branchId, warehouseId]);

  return React.createElement(Ctx.Provider, { value }, children);
}

/* ------------------------------------------------------------ formatting - */

export const inr = (n: number | string | null | undefined, dp = 2) =>
  n === null || n === undefined || n === ''
    ? '—'
    : `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

export const num = (n: number | string | null | undefined, dp = 2) =>
  n === null || n === undefined || n === ''
    ? '—'
    : Number(n).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });

export const pctText = (n: number | string | null | undefined, dp = 1) =>
  n === null || n === undefined || n === '' ? '—' : `${Number(n) > 0 ? '+' : ''}${Number(n).toFixed(dp)}%`;

export const date = (d: string | null | undefined) =>
  !d ? '—' : new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });

export const dateTime = (d: string | null | undefined) =>
  !d ? '—' : new Date(d).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });

export const ago = (d: string | null | undefined) => {
  if (!d) return '—';
  const mins = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
};

export const today = () => new Date().toISOString().slice(0, 10);
export const addDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
