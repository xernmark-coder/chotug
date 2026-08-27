import React, { useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import { api, useAuth, inr, num, date, dateTime } from '../lib/api';
import {
  Chip, DataTable, Empty, ErrorBanner, Field, Kpi, Layout, Loading, Modal, useApi, useToast,
  FilterBar, FilterTotals, useFilters,
} from '../components/ui';
import { Icon } from '../components/icons';

/* ===========================================================================
 * THE FINANCE DESK
 *
 * The client's words: every rupee, in or out, is handled here. So this is one
 * screen with one queue, not a set of reports:
 *
 *   TO VERIFY    somebody has asked for money — check it against the document
 *   TO PAY       verified; move the money and record how
 *   COMING IN    a centre or customer says they paid — confirm it landed
 *   SPENT        where the money actually went, by category and by mode
 *
 * Everything on it is an action or the consequence of one. Numbers that cannot
 * be acted on live on the dashboard, not here.
 * ======================================================================== */

const MODES = ['CASH', 'UPI', 'BANK', 'CHEQUE', 'CARD'] as const;

export function FinanceDeskPage() {
  const { can } = useAuth();
  /* Anyone can ask for money; only Finance sees the whole inbox. Without this
   * split the desk would 403 on its own overview for the warehouse hand who
   * just wanted to claim a transport bill. */
  return can('finance.expense.view') ? <TheDesk /> : <MyRequests />;
}

function TheDesk() {
  const toast = useToast();
  const { can } = useAuth();
  const [tab, setTab] = useState<'verify' | 'pay' | 'in' | 'paid' | 'spent'>('verify');
  const [range, setRange] = useState(30);

  const from = useMemo(() => {
    const d = new Date(); d.setDate(d.getDate() - range);
    return d.toISOString().slice(0, 10);
  }, [range]);

  const overview = useApi<any>(`/finance/overview?from=${from}`, [from]);
  const toVerify = useApi<any[]>('/finance/requests?status=REQUESTED');
  const toPay = useApi<any[]>('/finance/requests?status=VERIFIED');
  const partPaid = useApi<any[]>('/finance/requests?status=PART_PAID');
  const receipts = useApi<any[]>('/finance/receipts');
  /* Everything already paid. Until this was here the desk could show that
     ₹4 lakh had gone out and offer no way to see a single payment that made it
     up — or to reverse one paid by mistake, though the endpoint existed. */
  const paid = useApi<any[]>('/finance/requests?status=PAID');
  const [opening, setOpening] = useState<any>(null);

  const [verifying, setVerifying] = useState<any>(null);
  const [paying, setPaying] = useState<any>(null);
  const [confirming, setConfirming] = useState<any>(null);
  const [raising, setRaising] = useState(false);
  const [collecting, setCollecting] = useState(false);

  const k = overview.data?.kpis ?? {};
  const payable = [...(toPay.data ?? []), ...(partPaid.data ?? [])];
  const openReceipts = (receipts.data ?? []).filter((r: any) => r.status === 'DECLARED');
  const settledReceipts = (receipts.data ?? []).filter((r: any) => r.status !== 'DECLARED');

  /* Every queue on this desk is filterable by the same handful of things,
   * because they are the same handful of questions: whose money, what kind of
   * expense, which shop, who asked. Declared once, applied four times. */
  const fVerify = useFilters<any>(toVerify.data, requestFilterSpec());
  const fPay = useFilters<any>(payable, {
    ...requestFilterSpec(),
    totals: [
      { label: 'Asked for', of: (r: any) => Number(r.amount), money: true },
      { label: 'Outstanding', of: (r: any) => Number(r.amount) - Number(r.paid_amount), money: true },
    ],
  });
  const fPaid = useFilters<any>(paid.data, {
    ...requestFilterSpec(),
    totals: [{ label: 'Paid out', of: (r: any) => Number(r.paid_amount) || 0, money: true }],
  });
  const fIn = useFilters<any>(openReceipts, receiptFilterSpec());
  const fSettled = useFilters<any>(settledReceipts, receiptFilterSpec());

  const reloadAll = () => {
    overview.reload(); toVerify.reload(); toPay.reload(); partPaid.reload(); receipts.reload();
  };

  const netFlow = Number(k.collected ?? 0) - Number(k.paid_out ?? 0);

  return (
    <Layout
      title="Finance desk"
      subtitle="Every rupee in and out of the business"
      actions={
        <div className="btn-row">
          <select className="branch-select" value={range} onChange={(e) => setRange(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          {can('finance.receipt.record') ? (
            <button className="btn sm" onClick={() => setCollecting(true)}>Money received</button>
          ) : null}
          {can('finance.request.create') ? (
            <button className="btn sm primary" onClick={() => setRaising(true)}>Ask to pay</button>
          ) : null}
        </div>
      }
    >
      <ErrorBanner error={overview.error} />

      <div className="grid c4 mb">
        <Kpi label="Waiting to be verified" value={k.to_verify ?? 0}
          tone={(k.to_verify ?? 0) > 0 ? 'warn' : 'good'}
          foot="claims to check" onClick={() => setTab('verify')} />
        <Kpi label="Verified, to pay" value={inr(k.to_pay_value, 0)}
          tone={(k.overdue ?? 0) > 0 ? 'crit' : (k.to_pay ?? 0) > 0 ? 'warn' : 'good'}
          foot={(k.overdue ?? 0) > 0 ? `${k.overdue} past due` : `${k.to_pay ?? 0} request(s)`}
          onClick={() => setTab('pay')} />
        <Kpi label="Money to confirm" value={inr(k.to_confirm_value, 0)}
          tone={(k.disputed ?? 0) > 0 ? 'crit' : (k.to_confirm ?? 0) > 0 ? 'warn' : 'good'}
          foot={(k.disputed ?? 0) > 0 ? `${k.disputed} disputed` : `${k.to_confirm ?? 0} declared`}
          onClick={() => setTab('in')} />
        <Kpi label="Owed to suppliers" value={inr(k.supplier_outstanding, 0)}
          foot="across all open invoices" />
      </div>

      <div className="grid c4 mb">
        <Kpi label={`Paid out, ${range} days`} value={inr(k.paid_out, 0)}
          foot={`${inr(k.paid_today, 0)} today`} onClick={() => setTab('spent')} />
        <Kpi label={`Collected, ${range} days`} value={inr(k.collected, 0)} />
        <Kpi label="Net movement" value={inr(netFlow, 0)}
          tone={netFlow < 0 ? 'warn' : 'good'}
          foot={netFlow < 0 ? 'more went out than came in' : 'more came in than went out'} />
        <Kpi label="Cash vs online"
          value={(() => {
            const m = overview.data?.byMode ?? [];
            const cash = Number(m.find((x: any) => x.mode === 'CASH')?.amount ?? 0);
            const all = m.reduce((a: number, x: any) => a + Number(x.amount), 0);
            return all > 0 ? `${num((cash / all) * 100, 0)}% cash` : '—';
          })()}
          foot="of everything paid out" />
      </div>

      <div className="tabs">
        {([['verify', `To verify (${k.to_verify ?? 0})`],
           ['pay', `To pay (${payable.length})`],
           ['in', `Coming in (${openReceipts.length})`],
           ['paid', `Paid (${(paid.data ?? []).length})`],
           ['spent', 'Where it went']] as const).map(([key, label]) => (
          <button key={key} className={`tab ${tab === key ? 'active' : ''}`}
            onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>

      {tab === 'verify' ? (
        <>
        <FilterBar f={fVerify} placeholder="Search payee, request no, note" />
        <FilterTotals f={fVerify} noun="request" />
        <div className="card"><div className="card-body tight">
          <DataTable
            loading={toVerify.loading}
            rows={fVerify.rows}
            rowTone={(r: any) => (r.overdue ? 'crit' : r.priority === 'URGENT' ? 'warn' : undefined)}
            cols={[
              ...requestCols(),
              { key: 'a', head: '', width: 120, render: (r: any) =>
                can('finance.request.verify')
                  ? <button className="btn sm primary" onClick={() => setVerifying(r)}>Check it</button>
                  : null },
            ]}
            empty={<Empty icon="✅"
              title={fVerify.active > 0 ? 'Nothing matches those filters' : 'Nothing waiting to be checked'}
              hint={fVerify.active > 0 ? 'Clear a filter to widen the search.'
                : 'Requests appear here the moment somebody asks for money.'} />}
          />
        </div></div>
        </>
      ) : null}

      {tab === 'pay' ? (
        <>
        <FilterBar f={fPay} placeholder="Search payee, request no, note" />
        <FilterTotals f={fPay} noun="request" />
        <div className="card"><div className="card-body tight">
          <DataTable
            rows={fPay.rows}
            rowTone={(r: any) => (r.overdue ? 'crit' : undefined)}
            cols={[
              ...requestCols(),
              { key: 'b', head: 'Outstanding', num: true, render: (r: any) => (
                <b>{inr(Number(r.amount) - Number(r.paid_amount), 0)}</b>) },
              { key: 'a', head: '', width: 110, render: (r: any) =>
                can('finance.payment.make')
                  ? <button className="btn sm primary" onClick={() => setPaying(r)}>Pay</button>
                  : null },
            ]}
            empty={<Empty icon="💸"
              title={fPay.active > 0 ? 'Nothing matches those filters'
                : 'Nothing verified is waiting to be paid'} />}
          />
        </div></div>
        </>
      ) : null}

      {tab === 'in' ? (
        <>
          <FilterBar f={fIn} placeholder="Search payer, receipt no, reference" />
          <FilterTotals f={fIn} noun="receipt" />
          <div className="card mb">
            <div className="card-head"><h2>Declared, not yet confirmed</h2></div>
            <div className="card-body tight">
              <DataTable
                rows={fIn.rows}
                cols={[
                  ...receiptCols(),
                  /* keyed 'act', not 'a' — receiptCols already uses 'a' for the
                     declared amount, and two columns with one key makes React
                     drop one of them. */
                  { key: 'act', head: '', width: 130, render: (r: any) =>
                    can('finance.receipt.confirm')
                      ? <button className="btn sm primary" onClick={() => setConfirming(r)}>Confirm</button>
                      : null },
                ]}
                empty={<Empty icon="🧾"
                  title={fIn.active > 0 ? 'Nothing matches those filters'
                    : 'Nothing waiting to be confirmed'} />}
              />
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h2>Settled</h2></div>
            <div className="card-body tight">
              <FilterBar f={fSettled} placeholder="Search payer, receipt no, reference" />
              <FilterTotals f={fSettled} noun="receipt" />
              <DataTable rows={fSettled.rows} cols={receiptCols()}
                rowTone={(r: any) => (r.status === 'DISPUTED' ? 'crit' : undefined)}
                empty={<Empty title={fSettled.active > 0
                  ? 'Nothing matches those filters' : 'Nothing collected yet'} />} />
            </div>
          </div>
        </>
      ) : null}

      {tab === 'paid' ? (
        <>
          <FilterBar f={fPaid} placeholder="Search payee, request no, note" />
          <FilterTotals f={fPaid} noun="payment" />
          <div className="card"><div className="card-body tight">
            <DataTable
              loading={paid.loading}
              rows={fPaid.rows}
              onRowClick={(r: any) => setOpening(r)}
              cols={[
                ...requestCols(),
                { key: 'pd', head: 'Paid', num: true, render: (r: any) => (
                  <b>{inr(r.paid_amount, 0)}</b>) },
                { key: 'go', head: '', width: 90,
                  render: () => <span className="btn sm ghost">Open</span> },
              ]}
              empty={<Empty icon="💸" title={fPaid.active > 0
                ? 'Nothing matches those filters' : 'Nothing paid out yet'} />}
            />
          </div></div>
        </>
      ) : null}

      {opening ? (
        <PaymentsModal request={opening} onClose={() => setOpening(null)}
          onDone={(m) => { setOpening(null); paid.reload(); overview.reload(); toast(m, 'ok'); }} />
      ) : null}

      {tab === 'spent' ? (
        <div className="grid c2">
          <div className="card">
            <div className="card-head"><h2>Where the money went</h2></div>
            <div className="card-body">
              {(overview.data?.byCategory ?? []).length ? (
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={overview.data.byCategory} layout="vertical"
                    margin={{ left: 90, right: 16 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 11 }}
                      tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}k`} />
                    <YAxis type="category" dataKey="label" width={86} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v: any) => inr(v, 0)} />
                    <Bar dataKey="amount" fill="#4338CA" radius={[0, 3, 3, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <Empty icon="📊" title="Nothing paid out in this period" />}
            </div>
          </div>

          <div className="stack">
            <div className="card">
              <div className="card-head"><h2>Cash or online</h2></div>
              <div className="card-body tight">
                <DataTable rows={overview.data?.byMode ?? []} cols={[
                  { key: 'm', head: 'Paid by', render: (r: any) => <b>{r.mode.toLowerCase()}</b> },
                  { key: 'n', head: 'Payments', num: true, render: (r: any) => r.n },
                  { key: 'a', head: 'Amount', num: true, render: (r: any) => inr(r.amount, 0) },
                ]} empty={<Empty title="Nothing paid out yet" />} />
              </div>
            </div>
            <div className="card">
              <div className="card-head"><h2>Collected, by mode</h2></div>
              <div className="card-body tight">
                <DataTable rows={overview.data?.collectionsByMode ?? []} cols={[
                  { key: 'm', head: 'Received by', render: (r: any) => <b>{r.mode.toLowerCase()}</b> },
                  { key: 'n', head: 'Receipts', num: true, render: (r: any) => r.n },
                  { key: 'a', head: 'Amount', num: true, render: (r: any) => inr(r.amount, 0) },
                ]} empty={<Empty title="Nothing collected yet" />} />
              </div>
            </div>
          </div>

          <div className="card" style={{ gridColumn: '1 / -1' }}>
            <div className="card-head"><h2>In and out, last 30 days</h2></div>
            <div className="card-body">
              <ResponsiveContainer width="100%" height={230}>
                <LineChart data={overview.data?.daily ?? []}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }}
                    tickFormatter={(d) => date(d).slice(0, 6)} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}k`} />
                  <Tooltip formatter={(v: any) => inr(v, 0)} labelFormatter={(l) => date(l)} />
                  <Legend />
                  <Line type="monotone" dataKey="in" name="collected" stroke="#0891B2" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="out" name="paid out" stroke="#D97706" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      ) : null}

      {verifying ? (
        <VerifyModal request={verifying} onClose={() => setVerifying(null)}
          onDone={(msg) => { setVerifying(null); reloadAll(); toast(msg, 'ok'); }} />
      ) : null}
      {paying ? (
        <PayModal request={paying} onClose={() => setPaying(null)}
          onDone={(msg) => { setPaying(null); reloadAll(); toast(msg, 'ok'); }} />
      ) : null}
      {confirming ? (
        <ConfirmReceiptModal receipt={confirming} onClose={() => setConfirming(null)}
          onDone={() => { setConfirming(null); reloadAll(); toast('Receipt settled', 'ok'); }} />
      ) : null}
      {raising ? (
        <RaiseRequestModal onClose={() => setRaising(false)}
          onDone={() => { setRaising(false); reloadAll(); toast('Sent to Finance', 'ok'); }} />
      ) : null}
      {collecting ? (
        <RecordReceiptModal onClose={() => setCollecting(false)}
          onDone={() => { setCollecting(false); reloadAll(); toast('Recorded', 'ok'); }} />
      ) : null}
    </Layout>
  );
}

/* Shared columns so the verify and pay queues read identically. */
/* The two shapes this desk deals in. Kept next to the column definitions so a
 * new column and the filter that narrows by it are changed in one place. */
function requestFilterSpec() {
  return {
    date: (r: any) => r.requested_at,
    search: (r: any) => [r.payee_name, r.request_no, r.note, r.supplier_name,
      r.requested_by_name, r.expense_category,
      ...(r.goods ?? []).map((g: any) => g.productName)].filter(Boolean).join(' '),
    facets: [
      { key: 'payee', label: 'payee', of: (r: any) => r.payee_name },
      { key: 'cat', label: 'expense', of: (r: any) => r.expense_category },
      { key: 'kind', label: 'kind', of: (r: any) => r.kind },
      { key: 'wh', label: 'place', of: (r: any) => r.warehouse_name },
      { key: 'pri', label: 'priority', of: (r: any) => r.priority },
      { key: 'by', label: 'asked by', of: (r: any) =>
        (r.is_system_raised ? 'the system' : r.requested_by_name) },
    ],
    totals: [
      { label: 'Asked for', of: (r: any) => Number(r.amount), money: true },
    ],
  };
}

function receiptFilterSpec() {
  return {
    date: (r: any) => r.received_on,
    search: (r: any) => [r.payer_name, r.receipt_no, r.transaction_ref, r.warehouse_name]
      .filter(Boolean).join(' '),
    facets: [
      { key: 'payer', label: 'payer', of: (r: any) => r.payer_name },
      { key: 'src', label: 'source', all: 'Any source', of: (r: any) => r.source },
      { key: 'mode', label: 'mode', of: (r: any) => r.mode },
      { key: 'wh', label: 'place', of: (r: any) => r.warehouse_name },
      { key: 'st', label: 'status', of: (r: any) => r.status },
    ],
    totals: [
      { label: 'Declared', of: (r: any) => Number(r.amount), money: true },
      { label: 'Landed', of: (r: any) => Number(r.confirmed_amount ?? 0), money: true },
    ],
  };
}

function requestCols() {
  return [
    { key: 'w', head: 'Who', render: (r: any) => (
      <div className="row" style={{ gap: 8 }}>
        <Icon name={r.expense_icon ?? 'receipt'} size={17} />
        <div><b>{r.payee_name}</b>
          <div className="small muted">
            {r.expense_category ?? r.kind.replace(/_/g, ' ').toLowerCase()}
            {r.warehouse_name ? ` · ${r.warehouse_name}` : ''}
          </div></div>
      </div>) },
    /* What the money is for. Verifying "₹38,280 to Sahyadri" without being
       able to see that it is 400 kg of Alphonso makes the check that exists to
       catch a wrong payment into a check on a name and a number. */
    { key: 'g', head: 'What for', render: (r: any) => (
      (r.goods ?? []).length ? (
        <div className="stack" style={{ gap: 1 }}>
          {(r.goods ?? []).slice(0, 3).map((g: any, i: number) => (
            <div key={i} className="row small" style={{ gap: 6 }}>
              <Icon name={g.icon ?? 'produce'} size={14} />
              <span><b>{num(g.qty, 0)} {g.uom}</b> {g.productName}</span>
            </div>
          ))}
          {(r.goods ?? []).length > 3 ? (
            <span className="small muted">and {r.goods.length - 3} more</span>
          ) : null}
        </div>
      ) : <span className="muted small">{r.note ?? '—'}</span>
    ) },
    { key: 'n', head: 'Request', render: (r: any) => (
      <div><span className="mono small">{r.request_no}</span>
        {r.note ? <div className="small muted">{r.note}</div> : null}</div>) },
    { key: 'p', head: '', render: (r: any) =>
      r.priority === 'URGENT' ? <Chip tone="danger">urgent</Chip>
      : r.priority === 'HIGH' ? <Chip tone="warn">high</Chip> : null },
    { key: 'd', head: 'Due', render: (r: any) => (
      r.due_date
        ? <span className={r.overdue ? 'chip danger' : 'small'}>{date(r.due_date)}</span>
        : <span className="muted small">—</span>) },
    { key: 'r', head: 'Asked by', render: (r: any) => (
      <span className="small muted">{r.is_system_raised ? 'the system' : r.requested_by_name}</span>) },
    { key: 'v', head: 'Amount', num: true, render: (r: any) => <b>{inr(r.amount, 0)}</b> },
  ];
}

function receiptCols() {
  return [
    { key: 'p', head: 'From', render: (r: any) => (
      <div><b>{r.payer_name}</b>
        <div className="small muted">{r.source.toLowerCase()}{r.warehouse_name ? ` · ${r.warehouse_name}` : ''}</div></div>) },
    { key: 'n', head: 'Receipt', render: (r: any) => (
      <div><span className="mono small">{r.receipt_no}</span>
        <div className="small muted">{date(r.received_on)}</div></div>) },
    { key: 'm', head: 'How', render: (r: any) => (
      <div>{r.mode.toLowerCase()}
        {r.transaction_ref ? <div className="mono small muted">{r.transaction_ref}</div> : null}</div>) },
    { key: 'a', head: 'Declared', num: true, render: (r: any) => inr(r.amount, 0) },
    { key: 'c', head: 'Landed', num: true, render: (r: any) =>
      r.confirmed_amount == null ? <span className="muted">—</span> : (
        <b className={Number(r.confirmed_amount) < Number(r.amount) ? 'text-danger' : ''}>
          {inr(r.confirmed_amount, 0)}
        </b>) },
    { key: 's', head: '', render: (r: any) => (
      r.status === 'DISPUTED'
        ? <Chip tone="danger">short — {r.dispute_note}</Chip>
        : r.status === 'CONFIRMED' ? <Chip tone="ok">confirmed</Chip>
        : <Chip tone="warn">declared</Chip>) },
  ];
}

/* --------------------------------------------------------------- modals -- */

function VerifyModal({ request, onClose, onDone }: {
  request: any; onClose: () => void; onDone: (msg: string) => void;
}) {
  const [amount, setAmount] = useState(String(request.amount));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  const changed = Number(amount) !== Number(request.amount);

  const send = async (decision: 'VERIFY' | 'REJECT') => {
    setBusy(true); setError(null);
    try {
      const r = await api.post<any>(`/finance/requests/${request.id}/verify`, {
        decision,
        reason: reason.trim() || undefined,
        approvedAmount: decision === 'VERIFY' && changed ? Number(amount) : undefined,
      });
      onDone(r.message);
    } catch (e: any) { setError(e); } finally { setBusy(false); }
  };

  return (
    <Modal
      title={`${request.request_no} — ${request.payee_name}`}
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn danger" disabled={busy} onClick={() => send('REJECT')}>Turn down</button>
        <button className="btn primary" disabled={busy} onClick={() => send('VERIFY')}>
          {changed ? `Approve ${inr(Number(amount), 0)}` : 'Approve'}
        </button>
      </>}
    >
      <ErrorBanner error={error} />
      <dl className="kv mb">
        <dt>For</dt><dd>{request.expense_category ?? request.kind.replace(/_/g, ' ').toLowerCase()}</dd>
        <dt>Asked by</dt><dd>{request.is_system_raised ? 'the system' : request.requested_by_name}</dd>
        <dt>Asked for</dt><dd><b>{inr(request.amount)}</b></dd>
        {request.due_date ? <><dt>Due</dt><dd>{date(request.due_date)}</dd></> : null}
        {request.note ? <><dt>Note</dt><dd>{request.note}</dd></> : null}
        {request.warehouse_name ? <><dt>Where</dt><dd>{request.warehouse_name}</dd></> : null}
      </dl>
      <Field label="Approve this much"
        hint="You can approve less than was asked for — never more.">
        <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <Field label="Reason" hint="Required if you turn it down.">
        <input value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="Bill does not match the meter reading" />
      </Field>
    </Modal>
  );
}

function PayModal({ request, onClose, onDone }: {
  request: any; onClose: () => void; onDone: (msg: string) => void;
}) {
  const outstanding = Number(request.amount) - Number(request.paid_amount);
  const [amount, setAmount] = useState(String(outstanding));
  const { can } = useAuth();
  const { data: savedModes } = useApi<string[]>('/finance/payment-modes');
  const [mode, setMode] = useState<string>('UPI');
  const [customMode, setCustomMode] = useState('');
  const [saveMode, setSaveMode] = useState(false);
  const [ref, setRef] = useState('');
  const [from, setFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  const actualMode = mode === '__CUSTOM__' ? customMode.trim() : mode;
  const needsRef = actualMode !== 'CASH';
  const part = Number(amount) > 0 && Number(amount) < outstanding - 0.01;

  return (
    <Modal
      title={`Pay ${request.payee_name}`}
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary"
          disabled={busy || !Number(amount) || actualMode.length < 2 || (needsRef && !ref.trim())}
          onClick={async () => {
            setBusy(true); setError(null);
            try {
              if (mode === '__CUSTOM__' && saveMode) {
                await api.post('/finance/payment-modes', { name: actualMode });
              }
              const r = await api.post<any>(`/finance/requests/${request.id}/pay`, {
                amount: Number(amount), mode: actualMode,
                transactionRef: ref.trim() || undefined,
                paidFrom: from.trim() || undefined,
              });
              onDone(r.message);
            } catch (e: any) { setError(e); } finally { setBusy(false); }
          }}>
          Pay {inr(Number(amount) || 0, 0)}
        </button>
      </>}
    >
      <ErrorBanner error={error} />
      <dl className="kv mb">
        <dt>Request</dt><dd className="mono">{request.request_no}</dd>
        <dt>Approved</dt><dd>{inr(request.amount)}</dd>
        {Number(request.paid_amount) > 0
          ? <><dt>Already paid</dt><dd>{inr(request.paid_amount)}</dd></> : null}
        <dt>Outstanding</dt><dd><b>{inr(outstanding)}</b></dd>
      </dl>
      <div className="grid c2">
        <Field label="Paying now">
          <input type="number" step="0.01" value={amount} autoFocus
            onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="How">
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            {[...new Set([...(savedModes ?? MODES), ...MODES])].map((m) =>
              <option key={m} value={m}>{m.toLowerCase()}</option>)}
            <option value="__CUSTOM__">Other payment method…</option>
          </select>
        </Field>
      </div>
      {mode === '__CUSTOM__' ? (
        <div className="grid c2">
          <Field label="Payment method">
            <input value={customMode} autoFocus onChange={(e) => setCustomMode(e.target.value)}
              placeholder="Wallet, RTGS, demand draft" />
          </Field>
          {can('finance.payment.make') ? (
            <label className="check" style={{ alignSelf: 'end' }}>
              <input type="checkbox" checked={saveMode} onChange={(e) => setSaveMode(e.target.checked)} />
              Add this method to the list
            </label>
          ) : null}
        </div>
      ) : null}
      <div className="grid c2">
        <Field
          label={needsRef ? 'Transaction reference (required)' : 'Reference (optional)'}
          hint={needsRef ? 'The UPI reference, UTR or cheque number — so it can be traced.' : undefined}>
          <input value={ref} onChange={(e) => setRef(e.target.value)}
            placeholder={actualMode === 'UPI' ? '4172…' : actualMode === 'CHEQUE' ? 'Cheque no.' : 'UTR'} />
        </Field>
        <Field label="Paid from" hint="Which account or till.">
          <input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="HDFC current" />
        </Field>
      </div>
      {part ? (
        <div className="banner warn">
          <span><Icon name="info" size={16} /></span>
          <div className="small">
            Part payment — <b>{inr(outstanding - Number(amount), 0)}</b> will still be outstanding
            and the request stays open.
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

function ConfirmReceiptModal({ receipt, onClose, onDone }: {
  receipt: any; onClose: () => void; onDone: () => void;
}) {
  const [amount, setAmount] = useState(String(receipt.amount));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  const short = Number(receipt.amount) - (Number(amount) || 0);
  const mismatch = Math.abs(short) > 0.01;

  return (
    <Modal
      title={`Confirm ${inr(receipt.amount, 0)} from ${receipt.payer_name}`}
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || (mismatch && !note.trim())}
          onClick={async () => {
            setBusy(true); setError(null);
            try {
              await api.post(`/finance/receipts/${receipt.id}/confirm`, {
                confirmedAmount: Number(amount),
                disputeNote: note.trim() || undefined,
              });
              onDone();
            } catch (e: any) { setError(e); } finally { setBusy(false); }
          }}>
          {mismatch ? 'Record the difference' : 'Confirm'}
        </button>
      </>}
    >
      <ErrorBanner error={error} />
      <dl className="kv mb">
        <dt>Declared</dt><dd><b>{inr(receipt.amount)}</b></dd>
        <dt>How</dt><dd>{receipt.mode.toLowerCase()}
          {receipt.transaction_ref ? ` · ${receipt.transaction_ref}` : ''}</dd>
        <dt>Declared by</dt><dd>{receipt.declared_by_name}</dd>
      </dl>
      <Field label="What actually landed">
        <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      {mismatch ? (
        <>
          <div className={`banner ${short > 0 ? 'danger' : 'warn'} mb`}>
            <span><Icon name="alert" size={16} /></span>
            <div>
              <b>{inr(Math.abs(short), 0)} {short > 0 ? 'short' : 'more'} than declared.</b>
              <div className="small">This will be flagged, and the person who declared it told.</div>
            </div>
          </div>
          <Field label="What happened? (required)">
            <input value={note} autoFocus onChange={(e) => setNote(e.target.value)}
              placeholder="Counted short at the bank" />
          </Field>
        </>
      ) : null}
    </Modal>
  );
}

function RaiseRequestModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { me, can } = useAuth();
  const { data: cats, reload: reloadCats } = useApi<any[]>('/finance/expense-categories');
  const [addingCat, setAddingCat] = useState(false);
  const [kind, setKind] = useState('EXPENSE');
  const [categoryId, setCategoryId] = useState('');
  const [payee, setPayee] = useState('');
  const [amount, setAmount] = useState('');
  const [due, setDue] = useState('');
  const [priority, setPriority] = useState('NORMAL');
  const [warehouseId, setWarehouseId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  const needsCat = kind === 'EXPENSE';

  /* One modal at a time. */
  if (addingCat) {
    return (
      <ExpenseTypeModal onClose={() => setAddingCat(false)}
        onDone={(created?: any) => {
          setAddingCat(false);
          reloadCats();
          if (created?.id) setCategoryId(created.id);
        }} />
    );
  }

  return (
    <Modal
      title="Ask Finance to pay something"
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary"
          disabled={busy || !payee.trim() || !Number(amount) || (needsCat && !categoryId)}
          onClick={async () => {
            setBusy(true); setError(null);
            try {
              await api.post('/finance/requests', {
                kind, amount: Number(amount), payeeName: payee.trim(),
                expenseCategoryId: categoryId || undefined,
                warehouseId: warehouseId || undefined,
                dueDate: due || undefined, priority,
                note: note.trim() || undefined,
              });
              onDone();
            } catch (e: any) { setError(e); } finally { setBusy(false); }
          }}>Send to Finance</button>
      </>}
    >
      <ErrorBanner error={error} />
      <p className="small muted mb">
        Finance checks it before any money moves. Somebody other than you has to
        approve it.
      </p>
      <div className="grid c2">
        <Field label="What kind">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="EXPENSE">An expense</option>
            <option value="WAGES">Wages</option>
            <option value="TRANSPORT">Transport</option>
            <option value="ADVANCE">An advance</option>
            <option value="REFUND">A refund</option>
          </select>
        </Field>
        {needsCat ? (
          <Field label="Expense type">
            <div className="row" style={{ gap: 6 }}>
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">Choose…</option>
                {(cats ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {/* An expense nobody anticipated — a broken shutter, a fine. The
                  alternative is filing it under something it is not, and then
                  the "where the money went" chart lies. */}
              {can('admin.settings.manage') ? (
                <button className="btn sm" onClick={() => setAddingCat(true)}>+ New</button>
              ) : null}
            </div>
          </Field>
        ) : <Field label="Priority">
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>
            {['LOW', 'NORMAL', 'HIGH', 'URGENT'].map((x) =>
              <option key={x} value={x}>{x.toLowerCase()}</option>)}
          </select>
        </Field>}
      </div>
      <div className="grid c2">
        <Field label="Who is being paid"><input value={payee} autoFocus
          onChange={(e) => setPayee(e.target.value)} placeholder="MSEDCL" /></Field>
        <Field label="How much (₹)"><input type="number" step="0.01" value={amount}
          onChange={(e) => setAmount(e.target.value)} /></Field>
      </div>
      <div className="grid c3">
        <Field label="Needed by"><input type="date" value={due}
          onChange={(e) => setDue(e.target.value)} /></Field>
        {needsCat ? (
          <Field label="Priority">
            <select value={priority} onChange={(e) => setPriority(e.target.value)}>
              {['LOW', 'NORMAL', 'HIGH', 'URGENT'].map((x) =>
                <option key={x} value={x}>{x.toLowerCase()}</option>)}
            </select>
          </Field>
        ) : null}
        <Field label="Which place" hint="So the cost lands in the right place.">
          <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">Whole company</option>
            {(me?.warehouses ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </Field>
      </div>
      <Field label="What is it for"><input value={note}
        onChange={(e) => setNote(e.target.value)} placeholder="Warehouse July bill" /></Field>
    </Modal>
  );
}

function RecordReceiptModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { me } = useAuth();
  const [source, setSource] = useState('CENTRE');
  const [payer, setPayer] = useState('');
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState('CASH');
  const [ref, setRef] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  const needsRef = mode !== 'CASH';

  return (
    <Modal
      title="Money received"
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary"
          disabled={busy || !payer.trim() || !Number(amount) || (needsRef && !ref.trim())}
          onClick={async () => {
            setBusy(true); setError(null);
            try {
              await api.post('/finance/receipts', {
                source, payerName: payer.trim(), amount: Number(amount), mode,
                transactionRef: ref.trim() || undefined,
                warehouseId: warehouseId || undefined,
              });
              onDone();
            } catch (e: any) { setError(e); } finally { setBusy(false); }
          }}>Record it</button>
      </>}
    >
      <ErrorBanner error={error} />
      <p className="small muted mb">
        Recording it is a declaration, not a confirmation — Finance confirms what
        actually landed, and any gap between the two is flagged.
      </p>
      <div className="grid c2">
        <Field label="Where from">
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="CENTRE">A centre</option>
            <option value="CUSTOMER">A customer</option>
            <option value="OTHER">Somewhere else</option>
          </select>
        </Field>
        <Field label="Who paid"><input value={payer} autoFocus
          onChange={(e) => setPayer(e.target.value)} placeholder="Kothrud centre" /></Field>
      </div>
      <div className="grid c3">
        <Field label="How much (₹)"><input type="number" step="0.01" value={amount}
          onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="How">
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            {MODES.map((m) => <option key={m} value={m}>{m.toLowerCase()}</option>)}
          </select>
        </Field>
        <Field label={needsRef ? 'Reference (required)' : 'Reference'}>
          <input value={ref} onChange={(e) => setRef(e.target.value)} />
        </Field>
      </div>
      {source === 'CENTRE' ? (
        <Field label="Which centre">
          <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">—</option>
            {(me?.warehouses ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </Field>
      ) : null}
    </Modal>
  );
}


/* ---------------------------------------------------------------------------
 * What everybody else sees: what I asked for, and what happened to it.
 * ------------------------------------------------------------------------ */
function MyRequests() {
  const toast = useToast();
  const mine = useApi<any[]>('/finance/requests?mine=1');
  const [raising, setRaising] = useState(false);
  const rows = mine.data ?? [];
  const open = rows.filter((r) => !['PAID', 'REJECTED', 'CANCELLED'].includes(r.status));
  const waiting = open.reduce((a, r) => a + (Number(r.amount) - Number(r.paid_amount)), 0);

  return (
    <Layout
      title="Money requests"
      subtitle="What you have asked Finance to pay, and where each one stands"
      actions={
        <button className="btn primary sm" onClick={() => setRaising(true)}>Ask to pay</button>
      }
    >
      <ErrorBanner error={mine.error} />
      <div className="grid c3 mb">
        <Kpi label="Still open" value={open.length} foot="not yet paid" />
        <Kpi label="Waiting on Finance" value={inr(waiting, 0)} />
        <Kpi label="Paid" value={rows.filter((r) => r.status === 'PAID').length} tone="good" />
      </div>
      <div className="card"><div className="card-body tight">
        <DataTable
          loading={mine.loading}
          rows={rows}
          rowTone={(r: any) => (r.status === 'REJECTED' ? 'crit' : r.overdue ? 'warn' : undefined)}
          cols={[
            { key: 'n', head: 'Request', render: (r: any) => (
              <div><span className="mono small">{r.request_no}</span>
                <div className="small muted">{dateTime(r.requested_at)}</div></div>) },
            { key: 'w', head: 'For', render: (r: any) => (
              <div><b>{r.payee_name}</b>
                <div className="small muted">
                  {r.expense_category ?? r.kind.replace(/_/g, ' ').toLowerCase()}
                  {r.note ? ` · ${r.note}` : ''}
                </div></div>) },
            { key: 'a', head: 'Amount', num: true, render: (r: any) => inr(r.amount, 0) },
            { key: 'p', head: 'Paid', num: true, render: (r: any) =>
              Number(r.paid_amount) > 0 ? inr(r.paid_amount, 0) : <span className="muted">—</span> },
            { key: 's', head: 'Where it stands', render: (r: any) => (
              r.status === 'REQUESTED' ? <Chip tone="warn">with Finance to check</Chip>
              : r.status === 'VERIFIED' ? <Chip tone="primary">approved, payment due</Chip>
              : r.status === 'PART_PAID' ? <Chip tone="primary">part paid</Chip>
              : r.status === 'PAID' ? <Chip tone="ok">paid</Chip>
              : r.status === 'REJECTED' ? <Chip tone="danger">turned down — {r.reject_reason}</Chip>
              : <Chip>{r.status.toLowerCase()}</Chip>) },
          ]}
          empty={<Empty icon="🧾" title="You have not asked for anything yet"
            hint="Raise a request and Finance will check it before paying." />}
        />
      </div></div>
      {raising ? (
        <RaiseRequestModal onClose={() => setRaising(false)}
          onDone={() => { setRaising(false); mine.reload(); toast('Sent to Finance', 'ok'); }} />
      ) : null}
    </Layout>
  );
}

/* ---------------------------------------------------------------------------
 * A KIND OF EXPENSE NOBODY ANTICIPATED
 *
 * A broken shutter, a fine, a one-off hire. Without this the clerk files it
 * under something it is not, and then "where the money went" quietly lies for
 * the rest of the year.
 * ------------------------------------------------------------------------ */
function ExpenseTypeModal({ onClose, onDone }: {
  onClose: () => void; onDone: (created?: any) => void;
}) {
  const [name, setName] = useState('');
  const [landed, setLanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  return (
    <Modal
      title="A new kind of expense"
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || name.trim().length < 2}
          onClick={async () => {
            setBusy(true); setError(null);
            try {
              onDone(await api.post<any>('/finance/expense-categories', {
                name: name.trim(), affectsLandedCost: landed,
              }));
            } catch (e: any) { setError(e); } finally { setBusy(false); }
          }}>Add</button>
      </>}
    >
      <ErrorBanner error={error} />
      <Field label="What is it" hint="How it will read on the spending chart.">
        <input value={name} autoFocus onChange={(e) => setName(e.target.value)}
          placeholder="Shutter repair" />
      </Field>
      <label className="check">
        <input type="checkbox" checked={landed} onChange={(e) => setLanded(e.target.checked)} />
        <span>
          <b className="small">Counts towards the cost of the goods</b>
          <div className="small muted">
            Tick for transport, loading, commission — anything that makes a crate
            cost more than its rate. Leave it for rent, wages and electricity:
            those are the cost of the business, not of a mango, and mixing them
            makes every landed cost wrong.
          </div>
        </span>
      </label>
    </Modal>
  );
}

/* ---------------------------------------------------------------------------
 * THE PAYMENTS BEHIND ONE REQUEST — AND UNDOING ONE
 *
 * A payment made to the wrong person, or twice, is not a hypothetical: it is
 * the single most expensive mistake this desk can make. The endpoint to undo
 * one has existed all along and nothing on any screen called it, so the only
 * remedy was a database console.
 *
 * Reversing does not delete anything. It marks the payment reversed and gives
 * the request its balance back, so the money is owed again and the trail shows
 * what happened and who said so.
 * ------------------------------------------------------------------------ */
function PaymentsModal({ request, onClose, onDone }: {
  request: any; onClose: () => void; onDone: (m: string) => void;
}) {
  const { can } = useAuth();
  const { data, loading, reload } = useApi<any>(`/finance/requests/${request.id}`, [request.id]);
  const [reversing, setReversing] = useState<any>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  const payments = data?.payments ?? [];

  if (reversing) {
    return (
      <Modal
        title={`Reverse ${inr(reversing.amount, 0)} to ${request.payee_name}?`}
        onClose={() => { setReversing(null); setReason(''); }}
        footer={<>
          <button className="btn" onClick={() => { setReversing(null); setReason(''); }}>
            Keep it
          </button>
          <button className="btn danger" disabled={busy || reason.trim().length < 4}
            onClick={async () => {
              setBusy(true); setError(null);
              try {
                await api.post(`/finance/payments/${reversing.id}/reverse`, {
                  reason: reason.trim(),
                });
                setReversing(null); setReason(''); reload();
                onDone(`Reversed. ${request.payee_name} is owed ${inr(reversing.amount, 0)} again.`);
              } catch (e: any) { setError(e); } finally { setBusy(false); }
            }}>Reverse it</button>
        </>}
      >
        <ErrorBanner error={error} />
        <div className="banner warn mb">
          <span><Icon name="alert" size={16} /></span>
          <div className="small">
            This does not move money back — somebody still has to get it back from{' '}
            <b>{request.payee_name}</b>. What it does is put the amount back on the
            request, so it shows as owed again and nobody pays it a second time
            thinking the first went astray.
          </div>
        </div>
        <dl className="kv mb">
          <dt>Paid</dt><dd>{dateTime(reversing.paid_at)}</dd>
          <dt>How</dt><dd>{String(reversing.mode).toLowerCase()}
            {reversing.transaction_ref ? ` · ${reversing.transaction_ref}` : ''}</dd>
          <dt>By</dt><dd>{reversing.paid_by_name ?? '—'}</dd>
        </dl>
        <Field label="Why is it being reversed? (required)">
          <input value={reason} autoFocus onChange={(e) => setReason(e.target.value)}
            placeholder="Paid to the wrong account" />
        </Field>
      </Modal>
    );
  }

  return (
    <Modal
      title={`${request.request_no} · ${request.payee_name}`}
      onClose={onClose}
      footer={<button className="btn" onClick={onClose}>Close</button>}
    >
      <dl className="kv mb">
        <dt>Asked for</dt><dd>{inr(request.amount, 0)}</dd>
        <dt>Paid</dt><dd><b>{inr(request.paid_amount, 0)}</b></dd>
        <dt>What for</dt>
        <dd>{request.expense_category ?? String(request.kind).replace(/_/g, ' ').toLowerCase()}</dd>
        {request.note ? <><dt>Note</dt><dd>{request.note}</dd></> : null}
      </dl>

      {loading ? <Loading /> : (
        <table className="mini">
          <tbody>
            {payments.map((p: any) => (
              <tr key={p.id} className={p.status === 'REVERSED' ? 'row-crit' : ''}>
                <td>
                  <b>{inr(p.amount, 0)}</b>
                  <div className="small muted">
                    {String(p.mode).toLowerCase()}
                    {p.transaction_ref ? ` · ${p.transaction_ref}` : ''}
                  </div>
                </td>
                <td className="small muted">
                  {dateTime(p.paid_at)}
                  <div>{p.paid_by_name ?? '—'}</div>
                </td>
                <td>
                  {p.status === 'REVERSED' ? (
                    <div>
                      <Chip tone="danger">reversed</Chip>
                      <div className="small muted">{p.reverse_reason}</div>
                    </div>
                  ) : <Chip tone="ok">paid</Chip>}
                </td>
                <td className="num">
                  {p.status !== 'REVERSED' && can('finance.payment.reverse') ? (
                    <button className="btn sm danger" onClick={() => setReversing(p)}>
                      Reverse
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
            {!payments.length ? (
              <tr><td className="muted small">Nothing paid against this yet.</td></tr>
            ) : null}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
