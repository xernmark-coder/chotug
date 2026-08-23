import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, useAuth, dateTime, date, ago } from '../lib/api';
import {
  Chip, DataTable, Empty, ErrorBanner, Field, Layout, Loading, Modal, useApi, useToast,
  FilterBar, FilterTotals, useFilters,
} from '../components/ui';

type Person = {
  id: string; full_name: string; email: string | null; phone: string | null;
  status: string; last_login_at: string | null; created_at: string;
  roles: string[]; invite_expires_at: string | null;
  supplier_id: string | null; supplier_name: string | null;
  driver_id: string | null; driver_name: string | null;
};
type Role = { id: string; code: string; name: string; description: string | null };

/**
 * Shown after an invite is issued. If SMTP is configured the link has already
 * been emailed and this is just a receipt; if it is not, or the mail server
 * refused, this is how the admin gets the link out by hand. Either way the
 * invite itself exists — delivery never gates creation.
 */
function InviteLink({ url, email, sent, error }: {
  url: string; email: string; sent?: boolean; error?: string;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      toast('Could not copy — select the link and copy it manually', 'err');
    }
  };

  return (
    <div className={`banner ${sent ? 'ok' : 'info'}`} style={{ display: 'block' }}>
      <b>{sent ? `Invite emailed to ${email}` : `Send this link to ${email}`}</b>
      <div className="small mt" style={{ marginBottom: 8 }}>
        {sent
          ? 'Nothing more to do. The link below is the same one they received, in case it does not arrive.'
          : error
            ? `Could not email it — ${error}. Send the link yourself:`
            : 'It works once and expires in 7 days. They choose their own password — you never see it.'}
      </div>
      <div className="prefill">
        <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="btn sm primary" onClick={copy}>
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

/* ================================================== PEOPLE & ACCESS ===== */
export function PeoplePage() {
  const [tuning, setTuning] = useState<any>(null);
  const toast = useToast();
  const { me, can } = useAuth();
  const { data, loading, error, reload } = useApi<Person[]>('/masters/users');
  const roles = useApi<Role[]>('/masters/roles');
  const suppliers = useApi<any[]>('/masters/suppliers');
  const drivers = useApi<any[]>('/masters/drivers');

  const [open, setOpen] = useState(false);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [driverId, setDriverId] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<any>(null);
  const [link, setLink] = useState<{ url: string; email: string; sent?: boolean; error?: string } | null>(null);

  const reset = () => {
    setFullName(''); setEmail(''); setRoleId(''); setSupplierId(''); setDriverId(''); setFormError(null);
  };

  const invite = async () => {
    setBusy(true);
    setFormError(null);
    try {
      const r = await api.post<{ inviteUrl: string; email: string; emailSent: boolean; emailError?: string }>(
        '/masters/users/invite',
        { fullName, email, roleId, supplierId: supplierId || null, driverId: driverId || null });
      setLink({ url: r.inviteUrl, email: r.email, sent: r.emailSent, error: r.emailError });
      setOpen(false);
      reset();
      reload();
      toast(r.emailSent ? 'Invite emailed' : 'Invite created', 'ok');
    } catch (e: any) {
      setFormError(e);
    } finally {
      setBusy(false);
    }
  };

  const resend = async (p: Person) => {
    try {
      const r = await api.post<{ inviteUrl: string; email: string; emailSent: boolean; emailError?: string }>(
        `/masters/users/${p.id}/reinvite`);
      setLink({ url: r.inviteUrl, email: r.email, sent: r.emailSent, error: r.emailError });
      reload();
    } catch (e: any) { toast(e.message, 'err'); }
  };

  const setStatus = async (p: Person, status: 'ACTIVE' | 'SUSPENDED') => {
    try {
      await api.post(`/masters/users/${p.id}/status`, { status });
      toast(status === 'ACTIVE' ? 'Access restored' : 'Access suspended', 'ok');
      reload();
    } catch (e: any) { toast(e.message, 'err'); }
  };

  const f = useFilters<Person>(data, {
    search: (p2) => [p2.full_name, p2.email, p2.phone, p2.supplier_name, p2.driver_name,
      ...p2.roles].filter(Boolean).join(' '),
    facets: [
      { key: 'role', label: 'role', of: (p2) => p2.roles[0] ?? 'no role' },
      { key: 'st', label: 'status', of: (p2) => p2.status },
      { key: 'kind', label: 'kind', of: (p2) =>
        p2.supplier_name ? 'supplier' : p2.driver_name ? 'driver' : 'staff' },
      { key: 'seen', label: 'sign-in', of: (p2) =>
        (p2.last_login_at ? 'has signed in' : 'never signed in') },
    ],
    totals: [{ label: 'People', of: () => 1 }],
  });

  return (
    <Layout
      title="People & Access"
      subtitle="Add someone by email and pick their role — they set their own password"
      actions={<button className="btn primary" onClick={() => { reset(); setOpen(true); }}>Add person</button>}
    >
      <ErrorBanner error={error} />
      {link ? (
        <div className="mb"><InviteLink {...link} /></div>
      ) : null}

      <FilterBar f={f} placeholder="Search name, email, role" />
      <FilterTotals f={f} noun="person" />
      <div className="card">
        <DataTable<Person>
          loading={loading}
          rows={f.rows}
          cols={[
            {
              key: 'name',
              head: 'Person',
              render: (p) => (
                <div>
                  <b>{p.full_name}</b>
                  {p.id === me?.id ? <span className="muted small"> — you</span> : null}
                  {p.supplier_name ? <Chip tone="warn">outside · {p.supplier_name}</Chip> : null}
                  {p.driver_name ? <Chip tone="warn">driver · {p.driver_name}</Chip> : null}
                  <div className="small muted">{p.email ?? p.phone ?? '—'}</div>
                </div>
              ),
            },
            {
              key: 'roles',
              head: 'Role',
              render: (p) => p.roles.length
                ? <div className="btn-row">{p.roles.map((r) => <Chip key={r} tone="primary">{r}</Chip>)}</div>
                : <span className="muted">No role</span>,
            },
            { key: 'status', head: 'Status', render: (p) => <Chip value={p.status} /> },
            {
              key: 'seen',
              head: 'Last signed in',
              render: (p) => p.last_login_at
                ? <span title={dateTime(p.last_login_at)}>{ago(p.last_login_at)}</span>
                : <span className="muted">Never</span>,
            },
            {
              key: 'act',
              head: '',
              width: 200,
              render: (p) => (
                <div className="btn-row">
                  {p.status !== 'ACTIVE' ? (
                    <button className="btn sm" onClick={() => resend(p)}>Send new link</button>
                  ) : null}
                  {p.id !== me?.id && p.status === 'ACTIVE' ? (
                    <button className="btn sm" onClick={() => setStatus(p, 'SUSPENDED')}>Suspend</button>
                  ) : null}
                  {p.status === 'SUSPENDED' ? (
                    <button className="btn sm" onClick={() => setStatus(p, 'ACTIVE')}>Restore</button>
                  ) : null}
                  {/* Two people on one role do not always do the same job. */}
                  {p.id !== me?.id && can('admin.permission.override') ? (
                    <button className="btn sm" onClick={() => setTuning(p)}>Their panel</button>
                  ) : null}
                </div>
              ),
            },
          ]}
        />
      </div>

      {tuning ? (
        <PersonPanelModal person={tuning} onClose={() => setTuning(null)}
          onChanged={reload} />
      ) : null}

      {open ? (
        <Modal
          title="Add a person"
          onClose={() => setOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
              <button className="btn primary" disabled={busy} onClick={invite}>
                {busy ? 'Creating…' : 'Create invite'}
              </button>
            </>
          }
        >
          <ErrorBanner error={formError} />
          <Field label="Full name">
            <input value={fullName} autoFocus onChange={(e) => setFullName(e.target.value)}
              placeholder="Asha Kulkarni" />
          </Field>
          <Field label="Email" hint="The invite link is tied to this address.">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="asha@chotug.in" />
          </Field>
          <Field label="Role" hint="What they can do. You can change this later.">
            <select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              <option value="">Choose a role…</option>
              {(roles.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </Field>
          {(roles.data ?? []).find((r) => r.id === roleId)?.code === 'DRIVER' ? (
            <Field label="Which driver?"
              hint="They will see only the pickups offered to or assigned to them.">
              <select value={driverId} onChange={(e) => setDriverId(e.target.value)}>
                <option value="">Choose a driver…</option>
                {(drivers.data ?? []).map((d: any) => (
                  <option key={d.id} value={d.id}>{d.full_name}{d.phone ? ` — ${d.phone}` : ''}</option>
                ))}
              </select>
            </Field>
          ) : null}
          {(roles.data ?? []).find((r) => r.id === roleId)?.code === 'SUPPLIER' ? (
            <Field label="Which supplier?"
              hint="They will see only this supplier's orders, deliveries and invoices.">
              <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">Choose a supplier…</option>
                {(suppliers.data ?? []).map((s2: any) => (
                  <option key={s2.id} value={s2.id}>{s2.trade_name ?? s2.legal_name}</option>
                ))}
              </select>
            </Field>
          ) : null}
          {roleId ? (
            <div className="small muted">
              {(roles.data ?? []).find((r) => r.id === roleId)?.description}
            </div>
          ) : null}
        </Modal>
      ) : null}
    </Layout>
  );
}

/* ================================================== EMAIL SETTINGS ====== */
type Smtp = {
  host: string; port: number; secure: boolean; user: string;
  fromName: string; fromEmail: string; hasPassword: boolean; ready: boolean;
};

/**
 * Lives on the Settings page. Until this is filled in, invites still work —
 * the admin just sends the link themselves.
 */
export function EmailSettingsCard() {
  const toast = useToast();
  const { can } = useAuth();
  const { data, loading, error, reload } = useApi<Smtp>('/masters/smtp');
  const [form, setForm] = useState<Partial<Smtp> & { password?: string }>({});
  const [testTo, setTestTo] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [saveError, setSaveError] = useState<any>(null);

  const editable = can('admin.settings.manage');
  const v = <K extends keyof Smtp>(k: K): any => (form[k] !== undefined ? form[k] : data?.[k]);
  const set = (k: string, value: any) => setForm((s) => ({ ...s, [k]: value }));

  const save = async () => {
    setBusy('save');
    setSaveError(null);
    try {
      await api.put('/masters/smtp', {
        host: v('host') ?? '', port: Number(v('port') ?? 587), secure: !!v('secure'),
        user: v('user') ?? '', fromName: v('fromName') ?? 'ChotuG', fromEmail: v('fromEmail') ?? '',
        // Omitting the key entirely tells the server to keep the stored one.
        ...(form.password !== undefined ? { password: form.password } : {}),
      });
      toast('Email settings saved', 'ok');
      setForm({});
      reload();
    } catch (e: any) { setSaveError(e); } finally { setBusy(null); }
  };

  const test = async () => {
    setBusy('test');
    try {
      await api.post('/masters/smtp/test', { to: testTo });
      toast(`Test email sent to ${testTo}`, 'ok');
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(null); }
  };

  if (loading) return <div className="card"><div className="card-body"><Loading /></div></div>;

  return (
    <div className="card">
      <div className="card-head">
        <h2>Email (SMTP)</h2>
        {data?.ready
          ? <Chip tone="ok">Sending is on</Chip>
          : <Chip tone="warn">Not set up</Chip>}
      </div>
      <div className="card-body">
        <ErrorBanner error={error} />
        <ErrorBanner error={saveError} />
        <p className="small muted mb">
          Once this is filled in, invite links are emailed automatically. Until then
          they are shown on screen for you to send yourself.
        </p>

        <div className="grid c2">
          <Field label="Mail server" hint="e.g. smtp.gmail.com, smtp-relay.brevo.com">
            <input value={v('host') ?? ''} disabled={!editable}
              onChange={(e) => set('host', e.target.value)} />
          </Field>
          <Field label="Port" hint="587 for STARTTLS, 465 for SSL">
            <input type="number" value={v('port') ?? 587} disabled={!editable}
              onChange={(e) => set('port', e.target.value)} />
          </Field>
          <Field label="Username" hint="Usually the full email address">
            <input value={v('user') ?? ''} disabled={!editable}
              onChange={(e) => set('user', e.target.value)} />
          </Field>
          <Field
            label="Password"
            hint={data?.hasPassword
              ? 'A password is saved. Leave blank to keep it.'
              : 'Gmail and Zoho need an app password, not your login password.'}
          >
            <input type="password" placeholder={data?.hasPassword ? '••••••••' : ''}
              value={form.password ?? ''} disabled={!editable}
              onChange={(e) => set('password', e.target.value)} />
          </Field>
          <Field label="From name">
            <input value={v('fromName') ?? ''} disabled={!editable}
              placeholder="ChotuG" onChange={(e) => set('fromName', e.target.value)} />
          </Field>
          <Field label="From address" hint="What recipients see as the sender.">
            <input type="email" value={v('fromEmail') ?? ''} disabled={!editable}
              onChange={(e) => set('fromEmail', e.target.value)} />
          </Field>
        </div>

        <label className="check mb">
          <input type="checkbox" checked={!!v('secure')} disabled={!editable}
            onChange={(e) => set('secure', e.target.checked)} />
          Use SSL directly (tick only for port 465)
        </label>

        {editable ? (
          <>
            <div className="btn-row">
              <button className="btn primary" disabled={busy === 'save'} onClick={save}>
                {busy === 'save' ? 'Saving…' : 'Save email settings'}
              </button>
            </div>
            <div className="mt" style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
              <Field label="Send a test email to" hint="Proves the settings work before anyone depends on them.">
                <div className="prefill">
                  <input type="email" value={testTo} placeholder="you@example.com"
                    onChange={(e) => setTestTo(e.target.value)} />
                  <button className="btn" disabled={!testTo || busy === 'test'} onClick={test}>
                    {busy === 'test' ? 'Sending…' : 'Send test'}
                  </button>
                </div>
              </Field>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

/* ================================================== ACCEPT INVITE ======= */
/** Public page. The visitor has no account yet, so this must render without
 *  an authenticated session. */
export function AcceptInvitePage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const token = params.get('token') ?? '';

  const { data, loading, error } = useApi<{
    fullName: string; email: string; companyName: string; roleName: string | null;
  }>(token ? `/auth/invite/${token}` : null);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<any>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setFormError(new Error('The two passwords do not match'));
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const r = await api.post<{ token: string }>(`/auth/invite/${token}/accept`, { password });
      api.setToken(r.token);
      // Full reload so AuthProvider picks the session up from scratch, rather
      // than trying to graft a user onto a context that mounted signed-out.
      window.location.href = '/';
    } catch (err: any) {
      setFormError(err);
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <div className="login-page">
        <div className="login-card">
          <h1>Invite link incomplete</h1>
          <p className="muted small">
            That link is missing its code. Ask your admin to send a new one.
          </p>
          <button className="btn block mt" onClick={() => nav('/login')}>Go to sign in</button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-card">
        {loading ? <Loading label="Checking your invite…" /> : error ? (
          <>
            <h1>Link no longer valid</h1>
            <ErrorBanner error={error} />
            <button className="btn block mt" onClick={() => nav('/login')}>Go to sign in</button>
          </>
        ) : (
          <form onSubmit={submit}>
            <h1>Welcome, {data?.fullName.split(' ')[0]}</h1>
            <p className="muted small mb">
              You have been added to {data?.companyName}
              {data?.roleName ? <> as <b>{data.roleName}</b></> : null}. Choose a
              password and you are in.
            </p>
            <ErrorBanner error={formError} />
            <Field label="Your email">
              <input readOnly value={data?.email ?? ''} />
            </Field>
            <Field label="Choose a password" hint="At least 8 characters.">
              <input type="password" value={password} autoFocus
                onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field label="Type it again">
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </Field>
            <button className="btn primary block lg" disabled={busy}>
              {busy ? 'Setting up…' : 'Set password and sign in'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}


/* ===========================================================================
 * ONE PERSON'S PANEL
 *
 *   "there are two purchase executives, admin can set different things on
 *    their panels … person centric will override position and can be reset."
 *
 * The role is still the default and still where most of the thinking belongs.
 * This screen shows every permission in the system, where this person's answer
 * comes from, and lets the admin move one of them — with a reason, because the
 * question asked six months later is never "what" but "why".
 * ======================================================================== */
function PersonPanelModal({ person, onClose, onChanged }: {
  person: any; onClose: () => void; onChanged: () => void;
}) {
  const toast = useToast();
  const { data, loading, reload } = useApi<any>(`/masters/users/${person.id}/permissions`, [person.id]);
  const [q, setQ] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [asking, setAsking] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const perms = (data?.permissions ?? []).filter((p: any) => {
    if (onlyChanged && !p.effect) return false;
    if (!q.trim()) return true;
    const t = q.toLowerCase();
    return p.code.toLowerCase().includes(t) || (p.description ?? '').toLowerCase().includes(t);
  });

  const byModule = perms.reduce((acc: Record<string, any[]>, p: any) => {
    (acc[p.module] ??= []).push(p);
    return acc;
  }, {});

  const overrides = (data?.permissions ?? []).filter((p: any) => p.effect);

  const apply = async (code: string, effect: string, reason?: string, expiresOn?: string) => {
    setBusy(true);
    try {
      const r = await api.post<any>(`/masters/users/${person.id}/permissions`,
        { permissionCode: code, effect, reason, expiresOn });
      toast(r.message, 'ok');
      reload(); onChanged();
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); setAsking(null); }
  };

  return (
    <>
      <Modal
        title={`What ${person.full_name} can do`}
        onClose={onClose}
        wide
        footer={<>
          <button className="btn" onClick={onClose}>Done</button>
          {overrides.length ? (
            <button className="btn danger" disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await api.post<any>(`/masters/users/${person.id}/permissions/reset`, {});
                  toast(r.message, 'ok'); reload(); onChanged();
                } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
              }}>
              Put them back on their role
            </button>
          ) : null}
        </>}
      >
        <p className="small muted mb">
          They are on <b>{(data?.user?.roles ?? []).join(', ') || 'no role'}</b>. Everything
          below follows that role unless you change it here — and anything you
          change can be put back.
        </p>

        <div className="search-bar">
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search permissions" />
          <label className="row small" style={{ gap: 6, whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={onlyChanged}
              onChange={(e) => setOnlyChanged(e.target.checked)} />
            Only what is different from the role
          </label>
        </div>

        {loading ? <Loading /> : null}
        {!loading && !perms.length ? (
          <p className="small muted">
            {onlyChanged ? 'Nothing is different from their role.' : 'No permissions match that.'}
          </p>
        ) : null}

        <div className="perm-list">
          {Object.entries(byModule).map(([mod, list]) => (
            <div key={mod}>
              <div className="section-head sm"><h3>{mod}</h3><span className="rule" /></div>
              {(list as any[]).map((p) => (
                <div className={`perm-row ${p.effect ? 'changed' : ''}`} key={p.code}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <b>{p.description ?? p.code}</b>
                    <div className="small muted mono">{p.code}</div>
                    {p.effect ? (
                      <div className="small">
                        <Chip tone={p.effect === 'GRANT' ? 'ok' : 'danger'}>
                          {p.effect === 'GRANT' ? 'given to them' : 'taken away'}
                        </Chip>{' '}
                        {p.reason}
                        {p.expires_on ? ` · until ${date(p.expires_on)}` : ''}
                        {p.set_by ? ` · by ${p.set_by}` : ''}
                      </div>
                    ) : null}
                  </div>
                  <div className="btn-row">
                    {p.risk_level === 'CRITICAL' ? <Chip tone="danger">critical</Chip> : null}
                    <Chip tone={p.effective ? 'ok' : 'neutral'}>
                      {p.effective ? 'can' : 'cannot'}
                    </Chip>
                    {p.effect ? (
                      <button className="btn sm" disabled={busy}
                        onClick={() => apply(p.code, 'DEFAULT')}>Reset</button>
                    ) : p.from_role ? (
                      <button className="btn sm danger" disabled={busy}
                        onClick={() => setAsking({ code: p.code, effect: 'REVOKE', label: p.description })}>
                        Take away
                      </button>
                    ) : (
                      <button className="btn sm" disabled={busy}
                        onClick={() => setAsking({ code: p.code, effect: 'GRANT', label: p.description })}>
                        Give
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </Modal>
      {/* After the list, not before it. Two modals share one z-index, so the
          later one in the DOM is the one on top — rendering the reason dialog
          first put it behind the permission list, where the button was visible,
          enabled, and unclickable. */}
      {asking ? (
        <ReasonModal spec={asking} busy={busy}
          onClose={() => setAsking(null)}
          onGo={(reason, expiresOn) => apply(asking.code, asking.effect, reason, expiresOn)} />
      ) : null}
    </>
  );
}

function ReasonModal({ spec, busy, onClose, onGo }: {
  spec: any; busy: boolean; onClose: () => void;
  onGo: (reason: string, expiresOn?: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [expires, setExpires] = useState('');
  return (
    <Modal
      title={spec.effect === 'GRANT' ? 'Give this permission' : 'Take this permission away'}
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className={`btn ${spec.effect === 'GRANT' ? 'primary' : 'danger'}`}
          disabled={busy || reason.trim().length < 3}
          onClick={() => onGo(reason.trim(), expires || undefined)}>
          {spec.effect === 'GRANT' ? 'Give it' : 'Take it away'}
        </button>
      </>}
    >
      <p className="small muted mb"><b>{spec.label ?? spec.code}</b></p>
      <Field label="Why" hint="Read back months later, usually by somebody checking.">
        <input value={reason} autoFocus onChange={(e) => setReason(e.target.value)}
          placeholder="Covering Meera while she is on leave" />
      </Field>
      {spec.effect === 'GRANT' ? (
        <Field label="Until (optional)"
          hint="A permission that outlives its reason is how access creeps.">
          <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </Field>
      ) : null}
    </Modal>
  );
}
