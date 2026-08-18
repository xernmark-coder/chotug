import React, { useState } from 'react';
import { api, useAuth, inr, num, date } from '../lib/api';
import {
  Chip, DataTable, Empty, ErrorBanner, Field, Kpi, Layout, Loading, Modal, useApi, useToast,
} from '../components/ui';
import { Icon } from '../components/icons';

/* ===========================================================================
 * THE SUPPLIER'S OWN SCREEN
 *
 * An outside user. Everything shown here is scoped on the SERVER by the
 * supplier_id on their own user row — this page cannot widen it by asking for
 * more, because there is no parameter to ask with.
 *
 * The one job that matters: file an invoice against what was actually
 * accepted. Quantities are taken from the receipt rather than typed, so the
 * only thing left to disagree about is the rate — which is exactly what the
 * three-way match exists to arbitrate.
 * ======================================================================== */

export function SupplierPortalPage() {
  const { me } = useAuth();
  const [tab, setTab] = useState<'orders' | 'bill' | 'invoices'>('orders');
  const [billing, setBilling] = useState<any>(null);

  const meSup = useApi<any>('/supplier/me');
  const orders = useApi<any[]>('/supplier/orders');
  const receipts = useApi<any[]>('/supplier/receipts');
  const invoices = useApi<any[]>('/supplier/invoices');

  if (meSup.loading) return <Layout title="Supplier portal"><Loading /></Layout>;
  if (meSup.error) {
    return (
      <Layout title="Supplier portal">
        <ErrorBanner error={meSup.error} />
      </Layout>
    );
  }

  const s = meSup.data;
  const open = (orders.data ?? []).filter((o: any) =>
    ['CONFIRMED', 'APPROVED', 'PART_RECEIVED'].includes(o.status));
  const unbilled = (receipts.data ?? []).filter((r: any) => !r.already_billed);
  const outstanding = (invoices.data ?? [])
    .reduce((a: number, i: any) => a + Number(i.balance ?? 0), 0);
  const held = (invoices.data ?? []).filter((i: any) => ['HOLD', 'MISMATCH'].includes(i.status));

  return (
    <Layout
      title={s.trade_name ?? s.legal_name}
      subtitle={`Supplying ${s.buyer_name} · ${s.payment_terms_days} day terms`}
    >
      <div className="grid c4 mb">
        <Kpi label="Open orders" value={num(open.length, 0)} foot="confirmed with you" />
        <Kpi label="Delivered, not billed" value={num(unbilled.length, 0)}
          tone={unbilled.length ? 'warn' : undefined}
          foot={unbilled.length ? 'file an invoice for these' : 'nothing waiting'} />
        <Kpi label="Awaiting payment" value={inr(outstanding, 0)}
          foot="approved and payable" />
        <Kpi label="Needs your attention" value={num(held.length, 0)}
          tone={held.length ? 'crit' : 'good'}
          foot={held.length ? 'invoices on hold' : 'nothing on hold'} />
      </div>

      <div className="tabs">
        {([['orders', `Orders (${open.length})`],
           ['bill', `To bill (${unbilled.length})`],
           ['invoices', `My invoices (${(invoices.data ?? []).length})`]] as const).map(([k, l]) => (
          <button key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab === 'orders' ? (
        <div className="card"><div className="card-body tight">
          <DataTable
            loading={orders.loading}
            rows={orders.data ?? []}
            cols={[
              { key: 'n', head: 'Order', render: (o: any) => (
                <div><b className="mono">{o.po_no}</b>
                  <div className="small muted">{date(o.order_date)} · {o.branch_name}</div></div>
              ) },
              { key: 'e', head: 'Wanted by', render: (o: any) => date(o.expected_date) },
              { key: 'l', head: 'Items', num: true, render: (o: any) => o.line_count },
              { key: 'v', head: 'Value', num: true, render: (o: any) => inr(o.grand_total, 0) },
              { key: 's', head: 'Status', render: (o: any) => <Chip value={o.status} /> },
              { key: 'b', head: 'Billed', render: (o: any) => o.invoiced
                ? <Chip tone="ok">invoiced</Chip>
                : Number(o.receipts) > 0 ? <Chip tone="warn">delivered</Chip>
                : <span className="muted small">—</span> },
            ]}
            empty={<Empty icon="📄" title="No orders yet"
              hint="Orders appear here once they are confirmed with you." />}
          />
        </div></div>
      ) : null}

      {tab === 'bill' ? (
        <>
          <div className="banner info mb">
            <span><Icon name="info" size={16} /></span>
            <div>
              Bill against what was <b>accepted</b>, not what was ordered. The quantities below
              are what the warehouse booked in; you set the rate.
            </div>
          </div>
          <div className="card"><div className="card-body tight">
            <DataTable
              loading={receipts.loading}
              rows={receipts.data ?? []}
              rowTone={(r: any) => (r.already_billed ? undefined : 'warn')}
              cols={[
                { key: 'g', head: 'Delivery', render: (r: any) => (
                  <div><b className="mono">{r.grn_no}</b>
                    <div className="small muted">{date(r.posting_date)}{r.po_no ? ` · ${r.po_no}` : ''}</div></div>
                ) },
                { key: 'l', head: 'Items', num: true, render: (r: any) => (r.lines ?? []).length },
                { key: 'q', head: 'Accepted', num: true, render: (r: any) =>
                  num((r.lines ?? []).reduce((a: number, l: any) => a + Number(l.acceptedQty), 0), 0) },
                { key: 's', head: '', render: (r: any) => r.already_billed
                  ? <Chip tone="ok">billed</Chip> : <Chip tone="warn">not billed</Chip> },
                { key: 'a', head: '', width: 110, render: (r: any) => r.already_billed ? null : (
                  <button className="btn sm primary" onClick={() => setBilling(r)}>File invoice</button>
                ) },
              ]}
              empty={<Empty icon="✅" title="Nothing waiting to be billed" />}
            />
          </div></div>
        </>
      ) : null}

      {tab === 'invoices' ? (
        <div className="card"><div className="card-body tight">
          <DataTable
            loading={invoices.loading}
            rows={invoices.data ?? []}
            rowTone={(i: any) => (['HOLD', 'MISMATCH'].includes(i.status) ? 'crit' : undefined)}
            cols={[
              { key: 'n', head: 'Invoice', render: (i: any) => (
                <div><b className="mono">{i.invoice_no}</b>
                  <div className="small muted">{date(i.invoice_date)}{i.po_no ? ` · ${i.po_no}` : ''}</div></div>
              ) },
              { key: 't', head: 'Amount', num: true, render: (i: any) => inr(i.total, 0) },
              { key: 's', head: 'Status', render: (i: any) => (
                <div>
                  <Chip value={i.status} />
                  {i.hold_reason ? <div className="small muted">{i.hold_reason}</div> : null}
                </div>
              ) },
              { key: 'd', head: 'Due', render: (i: any) => i.due_date ? date(i.due_date) : '—' },
              { key: 'b', head: 'Outstanding', num: true, render: (i: any) =>
                i.balance == null ? <span className="muted">—</span> : inr(i.balance, 0) },
              { key: 'nt', head: 'Notes', render: (i: any) => (i.notes ?? []).length
                ? <div className="btn-row">{(i.notes ?? []).map((n: any) => (
                    <Chip key={n.noteNo} tone={n.type === 'DEBIT' ? 'danger' : 'primary'}>
                      {n.type === 'DEBIT' ? '−' : '+'}{inr(n.amount, 0)}
                    </Chip>))}</div>
                : <span className="muted small">—</span> },
            ]}
            empty={<Empty icon="🧾" title="You have not filed any invoices yet" />}
          />
        </div></div>
      ) : null}

      {billing ? (
        <FileInvoiceModal receipt={billing} onClose={() => setBilling(null)}
          onDone={() => { setBilling(null); receipts.reload(); invoices.reload(); setTab('invoices'); }} />
      ) : null}
    </Layout>
  );
}

/* -------------------------------------------------------------- file it --- */

function FileInvoiceModal({ receipt, onClose, onDone }: {
  receipt: any; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const lines: any[] = receipt.lines ?? [];
  const [rates, setRates] = useState<Record<string, string>>(
    Object.fromEntries(lines.map((l) => [l.grnLineId, String(l.rate ?? '')])));
  const [invoiceNo, setInvoiceNo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [tax, setTax] = useState('0');
  const [charges, setCharges] = useState('0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  const subtotal = lines.reduce(
    (a, l) => a + Number(l.acceptedQty) * (Number(rates[l.grnLineId]) || 0), 0);
  const total = subtotal + (Number(tax) || 0) + (Number(charges) || 0);
  const agreedDiffers = lines.some(
    (l) => l.rate != null && Math.abs((Number(rates[l.grnLineId]) || 0) - Number(l.rate)) > 0.001);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.post<any>('/supplier/invoices', {
        grnId: receipt.id,
        invoiceNo, invoiceDate,
        taxAmount: Number(tax) || 0,
        charges: Number(charges) || 0,
        lines: lines.map((l) => ({ grnLineId: l.grnLineId, rate: Number(rates[l.grnLineId]) || 0 })),
      });
      toast(r.message, 'ok');
      onDone();
    } catch (e: any) { setError(e); } finally { setBusy(false); }
  };

  return (
    <Modal
      title={`Invoice for ${receipt.grn_no}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !invoiceNo.trim() || total <= 0}
            onClick={submit}>
            {busy ? 'Filing…' : `File invoice — ${inr(total)}`}
          </button>
        </>
      }
    >
      <ErrorBanner error={error} />

      <div className="grid c2">
        <Field label="Your invoice number">
          <input value={invoiceNo} autoFocus placeholder="e.g. 2026-27/114"
            onChange={(e) => setInvoiceNo(e.target.value)} />
        </Field>
        <Field label="Invoice date">
          <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
        </Field>
      </div>

      <div className="table-wrap mb">
        <table className="data">
          <thead>
            <tr>
              <th>Item</th>
              <th className="num">Accepted</th>
              <th className="num">Agreed rate</th>
              <th className="num" style={{ width: 130 }}>Your rate</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const rate = Number(rates[l.grnLineId]) || 0;
              const differs = l.rate != null && Math.abs(rate - Number(l.rate)) > 0.001;
              return (
                <tr key={l.grnLineId}>
                  <td><b>{l.product}</b><div className="small muted">{l.sku}</div></td>
                  <td className="num mono">
                    {num(l.acceptedQty, 2)} <span className="small muted">{l.uom}</span>
                    {Number(l.rejectedQty) > 0 ? (
                      <div className="small" style={{ color: 'var(--danger)' }}>
                        {num(l.rejectedQty, 2)} rejected
                      </div>
                    ) : null}
                  </td>
                  <td className="num mono">{l.rate != null ? inr(l.rate) : '—'}</td>
                  <td className="num">
                    <input className="inline num" type="number" step="0.01" style={{ width: 100 }}
                      value={rates[l.grnLineId] ?? ''}
                      onChange={(e) => setRates((s) => ({ ...s, [l.grnLineId]: e.target.value }))} />
                  </td>
                  <td className="num mono">
                    {inr(Number(l.acceptedQty) * rate)}
                    {differs ? <div className="small" style={{ color: 'var(--accent)' }}>differs</div> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr><td colSpan={4} className="right">Subtotal</td>
              <td className="num mono">{inr(subtotal)}</td></tr>
          </tfoot>
        </table>
      </div>

      <div className="grid c2">
        <Field label="Tax" hint="Total tax on this invoice.">
          <input type="number" step="0.01" value={tax} onChange={(e) => setTax(e.target.value)} />
        </Field>
        <Field label="Other charges" hint="Freight, loading — if you are charging for them.">
          <input type="number" step="0.01" value={charges} onChange={(e) => setCharges(e.target.value)} />
        </Field>
      </div>

      <div className={`banner ${agreedDiffers ? 'warn' : 'info'}`}>
        <span>{agreedDiffers ? '⚠' : 'ℹ'}</span>
        <div>
          <b>{inr(total)} total</b>
          <div className="small">
            {agreedDiffers
              ? 'One or more rates differ from what was agreed on the order. You can still file it — it will be checked and someone will come back to you.'
              : 'Quantities are what the warehouse accepted. This will be checked against the order and the receipt automatically.'}
          </div>
        </div>
      </div>
    </Modal>
  );
}
