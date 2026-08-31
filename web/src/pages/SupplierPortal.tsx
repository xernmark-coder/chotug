import React, { useState } from 'react';
import { api, useAuth, inr, num, date, ago } from '../lib/api';
import {
  Chip, DataTable, Empty, ErrorBanner, Field, Kpi, Layout, Loading, Modal, useApi, useToast,
  FilterBar, FilterTotals, useFilters,
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
 * only thing left to disagree about is the rate — and the office is shown that
 * difference automatically when the bill lands.
 * ======================================================================== */

export function SupplierPortalPage() {
  const { me } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<'orders' | 'rates' | 'bill' | 'invoices'>('orders');
  const [billing, setBilling] = useState<any>(null);
  const [pricing, setPricing] = useState<any>(null);
  const [askingVehicle, setAskingVehicle] = useState<any>(null);
  const [addingProduct, setAddingProduct] = useState(false);

  const meSup = useApi<any>('/supplier/me');
  const orders = useApi<any[]>('/supplier/orders');
  const [sending, setSending] = useState<any>(null);
  const [responding, setResponding] = useState<any>(null);
  const [askingFor, setAskingFor] = useState<any>(null);
  const receipts = useApi<any[]>('/supplier/receipts');
  const invoices = useApi<any[]>('/supplier/invoices');
  const rates = useApi<any[]>('/supplier/rates');
  const catalogue = useApi<any[]>('/supplier/catalogue');

  /* Declared above the loading guard: a hook cannot sit behind an early
   * return. A supplier with two hundred orders needs these as much as the
   * buyer does. */
  const fOrders = useFilters<any>(orders.data, {
    date: (o: any) => o.order_date,
    search: (o: any) => [o.po_no, o.branch_name, o.status,
      ...(o.lines ?? []).map((l: any) => `${l.productName} ${l.sku}`)].filter(Boolean).join(' '),
    facets: [
      { key: 'st', label: 'state', all: 'Any state', of: (o: any) => o.status },
      { key: 'ans', label: 'answer', all: 'Any answer', of: (o: any) => o.supplier_response },
      { key: 'br', label: 'branch', of: (o: any) => o.branch_name },
      { key: 'bill', label: 'billing', all: 'Billed or not', of: (o: any) => (o.invoiced ? 'invoiced' : 'not billed') },
      { key: 'prod', label: 'product', of: (o: any) => (o.lines ?? [])[0]?.productName },
    ],
    totals: [
      { label: 'Items', of: (o: any) => Number(o.line_count) || 0 },
      { label: 'Value', of: (o: any) => Number(o.grand_total) || 0, money: true },
    ],
  });
  const fReceipts = useFilters<any>(receipts.data, {
    date: (r: any) => r.posting_date,
    search: (r: any) => [r.grn_no, r.po_no].filter(Boolean).join(' '),
    facets: [
      { key: 'b', label: 'billing', all: 'Billed or not', of: (r: any) => (r.already_billed ? 'billed' : 'not billed') },
    ],
    totals: [
      { label: 'Deliveries', of: () => 1 },
      { label: 'Accepted', of: (r: any) =>
        (r.lines ?? []).reduce((a: number, l: any) => a + Number(l.acceptedQty || 0), 0) },
    ],
  });
  const fRates = useFilters<any>(rates.data, {
    search: (r: any) => [r.product_name, r.sku, r.category_name, r.supplier_code]
      .filter(Boolean).join(' '),
    facets: [
      { key: 'cat', label: 'category', of: (r: any) => r.category_name },
      { key: 'set', label: 'priced', all: 'Priced or not', of: (r: any) =>
        r.quoted_rate == null ? 'no price yet' : r.is_stale ? 'out of date' : 'current' },
    ],
    totals: [
      { label: 'Products', of: () => 1 },
      { label: 'Priced', of: (r: any) => (r.quoted_rate != null ? 1 : 0) },
    ],
  });
  const fInvoices = useFilters<any>(invoices.data, {
    date: (i: any) => i.invoice_date,
    search: (i: any) => [i.invoice_no, i.po_no, i.status].filter(Boolean).join(' '),
    facets: [
      { key: 'st', label: 'status', of: (i: any) => i.status },
    ],
    totals: [
      { label: 'Billed', of: (i: any) => Number(i.total) || 0, money: true },
      { label: 'Outstanding', of: (i: any) => Number(i.balance ?? 0), money: true },
    ],
  });

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
  /* The order the buyer has placed but nobody has answered. This is the most
   * urgent thing on the whole portal: until it is answered the buyer is
   * planning against a promise that was never made. */
  const toAnswer = (orders.data ?? []).filter(
    (o: any) => o.placed && o.supplier_response === 'PENDING'
      && ['CONFIRMED'].includes(o.status));
  const outstanding = (invoices.data ?? [])
    .reduce((a: number, i: any) => a + Number(i.balance ?? 0), 0);
  const held = (invoices.data ?? []).filter((i: any) => ['HOLD', 'MISMATCH'].includes(i.status));

  return (
    <Layout
      title={s.trade_name ?? s.legal_name}
      subtitle={`Supplying ${s.buyer_name} · ${s.payment_terms_days} day terms`}
    >
      <div className="grid c5 mb">
        {/* Each card is the front door to the tab that answers it. A number
            you cannot click is a number you have to go and find again. */}
        <Kpi label="Waiting for your answer" value={num(toAnswer.length, 0)}
          tone={toAnswer.length ? 'crit' : 'good'}
          foot={toAnswer.length ? 'accept or decline these' : 'nothing to answer'}
          onClick={() => setTab('orders')} />
        <Kpi label="Open orders" value={num(open.length, 0)} foot="confirmed with you"
          onClick={() => setTab('orders')} />
        <Kpi label="Delivered, not billed" value={num(unbilled.length, 0)}
          tone={unbilled.length ? 'warn' : undefined}
          foot={unbilled.length ? 'file an invoice for these' : 'nothing waiting'}
          onClick={() => setTab('bill')} />
        <Kpi label="Awaiting payment" value={inr(outstanding, 0)}
          foot="approved and payable"
          onClick={() => setTab('invoices')} />
        <Kpi label="Needs your attention" value={num(held.length, 0)}
          tone={held.length ? 'crit' : 'good'}
          foot={held.length ? 'invoices on hold' : 'nothing on hold'}
          onClick={() => setTab('invoices')} />
      </div>

      <div className="tabs">
        {([['orders', `Orders (${open.length})`],
           ['rates', `My rates (${(rates.data ?? []).filter((r: any) => r.quoted_rate != null).length}/${(rates.data ?? []).length})`],
           ['bill', `To bill (${unbilled.length})`],
           ['invoices', `My invoices (${(invoices.data ?? []).length})`]] as const).map(([k, l]) => (
          <button key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab === 'orders' ? (
        <>
        <FilterBar f={fOrders} placeholder="Search a product or order number" />
        <FilterTotals f={fOrders} noun="order" />
        <div className="card"><div className="card-body tight">
          <DataTable
            loading={orders.loading}
            rows={fOrders.rows}
            cols={[
              /* What they are being asked for, first. The order number is a
                 reference for us and means nothing to them — they were being
                 asked to accept a number and a total, with no way to see that
                 it was 200 kg of Kesar until they opened something else. */
              { key: 'w', head: 'What we want', render: (o: any) => (
                <div className="stack" style={{ gap: 2 }}>
                  {(o.lines ?? []).map((l: any, i: number) => (
                    <div key={i} className="row" style={{ gap: 7 }}>
                      <Icon name={l.icon ?? 'produce'} size={16} />
                      <span>
                        <b>{num(l.qty, 0)} {l.uom}</b> {l.productName}
                        {l.grade ? <span className="small muted"> · grade {l.grade}</span> : null}
                        <span className="small muted"> @ {inr(l.rate)}</span>
                      </span>
                    </div>
                  ))}
                  {!(o.lines ?? []).length ? <span className="muted small">—</span> : null}
                </div>
              ) },
              { key: 'n', head: 'Order', render: (o: any) => (
                <div><span className="mono small">{o.po_no}</span>
                  <div className="small muted">{date(o.order_date)} · {o.branch_name}</div></div>
              ) },
              { key: 'e', head: 'Wanted by', render: (o: any) => date(o.expected_date) },
              { key: 'v', head: 'Value', num: true, render: (o: any) => inr(o.grand_total, 0) },
              /* Their words, not our workflow's. A supplier does not care that
                 an order is "PART_RECEIVED"; they care whether it is theirs to
                 act on, whether they have sent it, and whether it arrived. */
              { key: 's', head: 'Where it stands', render: (o: any) => <OrderState o={o} /> },
              /* One button: whatever this order needs from them next. A
                 supplier should never have to work out which of four actions
                 applies — the order already knows. */
              { key: 'x', head: '', width: 170, render: (o: any) => (
                <OrderAction o={o}
                  onRespond={() => setResponding(o)}
                  onAsk={() => setAskingFor(o)}
                  onSend={() => setSending(o)} />
              ) },
              /* Whether a lorry is coming, and a way to ask for one. Until
                 this was here the only way to ask was the telephone. */
              { key: 'tr', head: 'Transport', render: (o: any) => (
                o.pickup_no ? (
                  <div><Chip tone="ok">{String(o.pickup_status ?? '').toLowerCase() || 'arranged'}</Chip>
                    <div className="small muted">
                      {o.pickup_vehicle ?? o.pickup_driver ?? o.pickup_no}
                      {o.pickup_on ? ` · ${date(o.pickup_on)}` : ''}
                    </div></div>
                ) : o.transport_requested_at ? (
                  <Chip tone="warn">asked {ago(o.transport_requested_at)}</Chip>
                ) : ['APPROVED', 'CONFIRMED'].includes(o.status)
                     && Number(o.receipts) === 0 && !o.supplier_marked_sent_at ? (
                  <button className="btn sm ghost" onClick={() => setAskingVehicle(o)}>
                    Ask for a vehicle
                  </button>
                ) : <span className="muted small">—</span>
              ) },
              { key: 'b', head: 'Billed', render: (o: any) => o.invoiced
                ? <Chip tone="ok">invoiced</Chip>
                : Number(o.receipts) > 0 ? <Chip tone="warn">bill it</Chip>
                : <span className="muted small">—</span> },
            ]}
            empty={<Empty icon="📄"
              title={fOrders.active > 0 ? 'No order matches those filters' : 'No orders yet'}
              hint={fOrders.active > 0 ? 'Clear a filter to widen the search.'
                : 'Orders appear here once they are confirmed with you.'} />}
          />
        </div></div>
        </>
      ) : null}

      {tab === 'rates' ? (
        <>
          <div className="banner info mb">
            <span><Icon name="info" size={16} /></span>
            <div>
              Put your rate against each product and the buyer sees it straight away —
              no phone call. Change it whenever you like; the old rate is kept, so you
              both have a record of what you were asking and when.
            </div>
          </div>
          <FilterBar f={fRates} placeholder="Search a product">
            <span className="spacer" />
            <button className="btn sm" onClick={() => setAddingProduct(true)}>
              + I also sell…
            </button>
          </FilterBar>
          <FilterTotals f={fRates} noun="product" />
          <div className="card"><div className="card-body tight">
            <DataTable
              loading={rates.loading}
              rows={fRates.rows}
              rowTone={(r: any) => (r.is_stale ? 'warn' : undefined)}
              cols={[
                { key: 'p', head: 'Product', render: (r: any) => (
                  <div className="row" style={{ gap: 8 }}>
                    <Icon name={r.icon ?? 'produce'} size={17} />
                    <div><b>{r.product_name}</b>
                      <div className="small muted">
                        {r.category_name ?? r.sku}
                        {r.supplier_code ? ` · you call it ${r.supplier_code}` : ''}
                      </div></div>
                  </div>) },
                { key: 'lp', head: 'We last paid you', num: true, render: (r: any) =>
                  r.last_paid_rate != null
                    ? <div>{inr(r.last_paid_rate)}
                        <div className="small muted">{r.last_purchase_at ? date(r.last_purchase_at) : ''}</div></div>
                    : <span className="muted small">never bought</span> },
                { key: 'now', head: 'You are asking', num: true, render: (r: any) =>
                  r.quoted_rate == null
                    ? <span className="muted small">not set</span>
                    : <div>
                        <b>{inr(r.quoted_rate)}</b>
                        {r.change_pct != null ? (
                          <div className={`small ${Number(r.change_pct) > 0 ? 'text-danger' : 'muted'}`}>
                            {Number(r.change_pct) > 0 ? '+' : ''}{num(r.change_pct, 1)}% on last
                          </div>) : null}
                      </div> },
                { key: 'q', head: 'You have', num: true, render: (r: any) =>
                  r.available_qty != null
                    ? <span>{num(r.available_qty, 0)} <span className="small muted">{r.uom ?? r.base_uom}</span></span>
                    : <span className="muted">—</span> },
                { key: 'v', head: 'Good until', render: (r: any) =>
                  r.valid_till
                    ? <span className={r.is_stale ? 'chip warn' : 'small'}>{date(r.valid_till)}</span>
                    : <span className="muted small">no end date</span> },
                { key: 'w', head: 'Told them', render: (r: any) =>
                  r.quoted_at ? <span className="small muted">{ago(r.quoted_at)}</span> : '—' },
                { key: 'a', head: '', width: 110, render: (r: any) => (
                  <button className="btn sm primary" onClick={() => setPricing(r)}>
                    {r.quoted_rate == null ? 'Set a rate' : 'Change'}
                  </button>) },
              ]}
              empty={<Empty icon="🏷️"
                title={fRates.active > 0 ? 'No product matches those filters'
                  : 'Nothing to price yet'}
                hint={fRates.active > 0 ? 'Clear a filter to widen the search.'
                  : 'Products appear here once the buyer sets you up to supply them, or once you have supplied one.'} />}
            />
          </div></div>
        </>
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
          <FilterBar f={fReceipts} placeholder="Search delivery or order number" />
          <FilterTotals f={fReceipts} noun="delivery" />
          <div className="card"><div className="card-body tight">
            <DataTable
              loading={receipts.loading}
              rows={fReceipts.rows}
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
              empty={<Empty icon="✅" title={fReceipts.active > 0
                ? 'Nothing matches those filters' : 'Nothing waiting to be billed'} />}
            />
          </div></div>
        </>
      ) : null}

      {tab === 'invoices' ? (
        <>
        <FilterBar f={fInvoices} placeholder="Search invoice or order number" />
        <FilterTotals f={fInvoices} noun="invoice" />
        <div className="card"><div className="card-body tight">
          <DataTable
            loading={invoices.loading}
            rows={fInvoices.rows}
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
            empty={<Empty icon="🧾" title={fInvoices.active > 0
              ? 'No invoice matches those filters'
              : 'You have not filed any invoices yet'} />}
          />
        </div></div>
        </>
      ) : null}

      {addingProduct ? (
        <AddMyProductModal rows={catalogue.data ?? []} onClose={() => setAddingProduct(false)}
          onDone={(m) => {
            setAddingProduct(false); catalogue.reload(); rates.reload(); toast(m, 'ok');
          }} />
      ) : null}

      {askingVehicle ? (
        <AskVehicleModal order={askingVehicle} onClose={() => setAskingVehicle(null)}
          onDone={(m) => { setAskingVehicle(null); orders.reload(); toast(m, 'ok'); }} />
      ) : null}

      {pricing ? (
        <RateModal row={pricing} onClose={() => setPricing(null)}
          onDone={(m) => { setPricing(null); rates.reload(); toast(m, 'ok'); }} />
      ) : null}

      {billing ? (
        <FileInvoiceModal receipt={billing} onClose={() => setBilling(null)}
          onDone={() => { setBilling(null); receipts.reload(); invoices.reload(); setTab('invoices'); }} />
      ) : null}

      {responding ? (
        <RespondModal order={responding} onClose={() => setResponding(null)}
          onDone={() => { setResponding(null); orders.reload(); }} />
      ) : null}
      {askingFor ? (
        <AskForPaymentModal order={askingFor} onClose={() => setAskingFor(null)}
          onDone={() => { setAskingFor(null); orders.reload(); }} />
      ) : null}
      {sending ? (
        <MarkSentModal order={sending} onClose={() => setSending(null)}
          onDone={() => { setSending(null); orders.reload(); }} />
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


/* ---------------------------------------------------------------------------
 * "It has left." Two fields, both of which the supplier already knows, and a
 * date we pre-fill from the order so the common case is one tap.
 * ------------------------------------------------------------------------ */
function MarkSentModal({ order, onClose, onDone }: {
  order: any; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [vehicle, setVehicle] = useState(order.vehicle_hint ?? '');
  const [when, setWhen] = useState(String(order.arrival_date ?? order.expected_date ?? '').slice(0, 10));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  /* Sending before the money has come. The supplier says so deliberately, per
     load — it is never a silent fallback, because the whole value of the
     payment gate is that it holds when nobody meant to open it. */
  const [onCredit, setOnCredit] = useState(false);

  const stage = paymentStage(order);
  const unpaid = stage !== 'paid';
  const outstanding = Number(order.payment_amount ?? order.grand_total ?? 0)
    - Number(order.payment_paid ?? 0);

  const send = async (withoutPayment: boolean) => {
    setBusy(true); setError(null);
    try {
      const r = await api.post<any>(`/supplier/orders/${order.id}/dispatch`, {
        vehicleReg: vehicle.trim() || undefined,
        expectedDate: when || undefined,
        note: note.trim() || undefined,
        withoutPayment,
      });
      toast(r.message, 'ok');
      onDone();
    } catch (e: any) { setError(e); } finally { setBusy(false); }
  };

  return (
    <Modal
      title={`Send ${order.po_no}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className={`btn ${onCredit ? 'warn' : 'primary'}`} disabled={busy}
            onClick={() => send(onCredit)}>
            {busy ? 'Telling them…' : onCredit ? 'Send it — collect later' : 'It has left'}
          </button>
        </>
      }
    >
      <ErrorBanner error={error} />
      <p className="small muted mb">
        This tells the gate to expect you. They see the vehicle number at the
        barrier, so the load is checked in against this rather than held up.
      </p>

      {unpaid && stage !== 'refused' ? (
        <div className={`banner ${onCredit ? 'warn' : 'info'} mb`} style={{ display: 'block' }}>
          <label className="row" style={{ gap: 9, cursor: 'pointer', alignItems: 'flex-start' }}>
            <input type="checkbox" style={{ width: 17, height: 17, marginTop: 2 }}
              checked={onCredit} onChange={(e) => setOnCredit(e.target.checked)} />
            <span>
              <b>Send it now and collect the payment later</b>
              <div className="small mt">
                {outstanding > 0
                  ? `${inr(outstanding, 0)} has not been paid yet. `
                  : 'Nothing has been paid against this order yet. '}
                Tick this and the load goes anyway — the amount becomes a due
                with the buyer&rsquo;s finance desk and is settled from there.
                {order.payment_terms_days
                  ? ` Your terms are ${order.payment_terms_days} days from arrival.`
                  : ''}
              </div>
            </span>
          </label>
        </div>
      ) : null}
      <div className="grid c2">
        <Field label="Vehicle number" hint="As painted on the lorry.">
          <input value={vehicle} onChange={(e) => setVehicle(e.target.value.toUpperCase())}
            placeholder="MH12AB1234" />
        </Field>
        <Field label="Arriving on">
          <input type="date" value={when} onChange={(e) => setWhen(e.target.value)} />
        </Field>
      </div>
      <Field label="Anything to tell them? (optional)">
        <input value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="Leaving after 6pm, driver will call" />
      </Field>
    </Modal>
  );
}

/* ===========================================================================
 * THE CONVERSATION AROUND ONE ORDER
 *
 *   we place it  →  they accept  →  they ask for the money
 *                →  Finance pays →  they send it  →  it arrives
 *
 * Both components below read the same order object and agree on which step it
 * is at, so the label and the button can never contradict each other.
 * ======================================================================== */

function paymentStage(o: any) {
  if (!o.payment_request_no) return 'none';
  if (o.payment_status === 'PAID') return 'paid';
  if (o.payment_status === 'REJECTED') return 'refused';
  return 'waiting';
}

function OrderState({ o }: { o: any }) {
  if (!o.placed) return <Chip tone="neutral">being placed</Chip>;
  if (Number(o.receipts) > 0) {
    /* Delivered is not the end of the story when the money never went first —
     * this is the order the supplier is still waiting to be paid for, and it
     * has to keep saying so. */
    return o.payment_due_since && o.payment_status !== 'PAID'
      ? <Chip tone="warn">delivered — payment due</Chip>
      : <Chip tone="ok">delivered</Chip>;
  }
  if (o.supplier_response === 'DECLINED') {
    return <Chip tone="danger">you declined{o.supplier_response_note ? ` — ${o.supplier_response_note}` : ''}</Chip>;
  }
  if (o.supplier_response !== 'ACCEPTED') return <Chip tone="danger">answer this</Chip>;
  if (o.supplier_marked_sent_at) {
    return o.sent_without_payment && o.payment_status !== 'PAID'
      ? <Chip tone="warn">on the way — payment due</Chip>
      : <Chip tone="primary">on the way</Chip>;
  }

  const stage = paymentStage(o);
  if (stage === 'refused') {
    return <Chip tone="danger">payment turned down — {o.payment_reject_reason}</Chip>;
  }
  if (stage === 'waiting') {
    const paid = Number(o.payment_paid ?? 0);
    return (
      <Chip tone="warn">
        {paid > 0
          ? `part paid — ${inr(paid, 0)} of ${inr(o.payment_amount, 0)}`
          : 'waiting for payment'}
      </Chip>
    );
  }
  return <Chip tone="warn">{stage === 'paid' ? 'paid — send it' : 'to send'}</Chip>;
}

function OrderAction({ o, onRespond, onAsk, onSend }: {
  o: any; onRespond: () => void; onAsk: () => void; onSend: () => void;
}) {
  if (!o.placed) return <span className="small muted">not yet placed</span>;
  if (Number(o.receipts) > 0) return <span className="small muted">received</span>;
  if (o.supplier_response === 'DECLINED') return <span className="small muted">declined</span>;

  if (o.supplier_response !== 'ACCEPTED') {
    return <button className="btn sm primary" onClick={onRespond}>Accept or decline</button>;
  }
  if (o.supplier_marked_sent_at) {
    return <button className="btn sm" onClick={onSend}>Update</button>;
  }

  const stage = paymentStage(o);
  if (stage === 'none') {
    return (
      <div className="btn-row">
        <button className="btn sm primary" onClick={onAsk}>Ask for payment</button>
        <button className="btn sm" onClick={onSend}>Send</button>
      </div>
    );
  }
  if (stage === 'paid') return <button className="btn sm primary" onClick={onSend}>Mark as sent</button>;
  if (stage === 'refused') return <span className="small muted">speak to the buyer</span>;
  /* Waiting on Finance used to be a dead end — the only thing to do was wait.
     Sending anyway is now a choice the supplier can make, so it is a button
     rather than a sentence. */
  return (
    <div className="btn-row">
      <span className="small muted">with Finance</span>
      <button className="btn sm" onClick={onSend}>Send anyway</button>
    </div>
  );
}

function RespondModal({ order, onClose, onDone }: {
  order: any; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  /* Accepting is also when they record the invoice and lorry. The gate then
   * needs only the invoice number and can correct details if the load changes. */
  const [invoiceNo, setInvoiceNo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [invoiceTotal, setInvoiceTotal] = useState(String(order.grand_total));
  const [vehicleReg, setVehicleReg] = useState('');
  const [driverName, setDriverName] = useState('');
  const [driverPhone, setDriverPhone] = useState('');
  const [transporter, setTransporter] = useState('');
  const [lrNo, setLrNo] = useState('');
  const [mandiPattiNo, setMandiPattiNo] = useState('');

  const send = async (decision: 'ACCEPT' | 'DECLINE') => {
    setBusy(true); setError(null);
    try {
      const r = await api.post<any>(`/supplier/orders/${order.id}/respond`, {
        decision,
        note: note.trim() || undefined,
        ...(decision === 'ACCEPT' ? {
          invoiceNo: invoiceNo.trim() || undefined,
          invoiceDate: invoiceNo.trim() ? invoiceDate : undefined,
          invoiceTotal: invoiceNo.trim() ? Number(invoiceTotal) : undefined,
          vehicleReg: vehicleReg.trim() || undefined,
          driverName: driverName.trim() || undefined,
          driverPhone: driverPhone.trim() || undefined,
          transporter: transporter.trim() || undefined,
          lrNo: lrNo.trim() || undefined,
          mandiPattiNo: mandiPattiNo.trim() || undefined,
        } : {}),
      });
      toast(r.message, decision === 'ACCEPT' ? 'ok' : 'info');
      onDone();
    } catch (e: any) { setError(e); } finally { setBusy(false); }
  };

  return (
    <Modal
      title={`${order.po_no} — can you supply this?`}
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Not now</button>
        <button className="btn danger" disabled={busy || !note.trim()}
          onClick={() => send('DECLINE')}>Cannot supply</button>
        <button className="btn primary" disabled={busy || !invoiceNo.trim() || !vehicleReg.trim()}
          onClick={() => send('ACCEPT')}>Yes, I accept</button>
      </>}
    >
      <ErrorBanner error={error} />
      <dl className="kv mb">
        <dt>Wanted by</dt><dd>{date(order.expected_date)}</dd>
        <dt>Items</dt><dd>{order.line_count}</dd>
        <dt>Order value</dt><dd><b>{inr(order.grand_total)}</b></dd>
        <dt>Deliver to</dt><dd>{order.branch_name}</dd>
      </dl>
      <p className="small muted mb">
        Accepting tells the buyer the load is coming, and lets you ask for the
        money. If you cannot supply it, say so now — while there is still time
        for them to buy it elsewhere.
      </p>

      <div className="section-head sm"><h3>Your invoice</h3><span className="rule" /></div>
      <div className="grid c3">
        <Field label="Invoice number (required)"><input value={invoiceNo}
          onChange={(e) => setInvoiceNo(e.target.value)} placeholder="SAH/26-27/118" /></Field>
        <Field label="Invoice date"><input type="date" value={invoiceDate}
          disabled={!invoiceNo.trim()} onChange={(e) => setInvoiceDate(e.target.value)} /></Field>
        <Field label="Invoice total (₹)"><input type="number" step="0.01" value={invoiceTotal}
          disabled={!invoiceNo.trim()} onChange={(e) => setInvoiceTotal(e.target.value)} /></Field>
      </div>

      <div className="section-head sm"><h3>The vehicle</h3><span className="rule" /></div>
      <p className="small muted mb">
        Give these and the gate will find the lorry by your invoice number — the
        driver will not be kept waiting while somebody types them in again.
      </p>
      <div className="grid c2">
        <Field label="Vehicle number (required)"><input value={vehicleReg}
          onChange={(e) => setVehicleReg(e.target.value.toUpperCase())}
          placeholder="MH14CD5678" /></Field>
        <Field label="Transporter"><input value={transporter}
          onChange={(e) => setTransporter(e.target.value)} placeholder="Pawar Roadlines" /></Field>
      </div>
      <div className="grid c3">
        <Field label="Driver"><input value={driverName}
          onChange={(e) => setDriverName(e.target.value)} placeholder="Balu Pawar" /></Field>
        <Field label="Driver's phone"><input value={driverPhone}
          onChange={(e) => setDriverPhone(e.target.value)} placeholder="98220 11223" /></Field>
        <Field label="LR number"><input value={lrNo}
          onChange={(e) => setLrNo(e.target.value)} placeholder="LR-8891" /></Field>
        <Field label="Mandi patti number"><input value={mandiPattiNo}
          onChange={(e) => setMandiPattiNo(e.target.value)} placeholder="Optional" /></Field>
      </div>

      <div className="section-head sm"><h3>Message to the buyer</h3><span className="rule" /></div>
      <Field label="" hint="Required if you cannot supply it. Say why, and when you could.">
        <input value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="Rain damage — can supply 100 kg next week" />
      </Field>
    </Modal>
  );
}

function AskForPaymentModal({ order, onClose, onDone }: {
  order: any; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [amount, setAmount] = useState(String(order.grand_total));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);
  const part = Number(amount) > 0 && Number(amount) < Number(order.grand_total) - 0.01;

  return (
    <Modal
      title={`Ask for payment — ${order.po_no}`}
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary"
          disabled={busy || !Number(amount) || Number(amount) > Number(order.grand_total) + 0.01}
          onClick={async () => {
            setBusy(true); setError(null);
            try {
              const r = await api.post<any>(`/supplier/orders/${order.id}/request-payment`,
                { amount: Number(amount), note: note.trim() || undefined });
              toast(r.message, 'ok');
              onDone();
            } catch (e: any) { setError(e); } finally { setBusy(false); }
          }}>
          Send to Finance
        </button>
      </>}
    >
      <ErrorBanner error={error} />
      <p className="small muted mb">
        This goes straight to the buyer's Finance desk. They check it and pay —
        and once it is paid you can send the load.
      </p>
      <dl className="kv mb">
        <dt>Order value</dt><dd><b>{inr(order.grand_total)}</b></dd>
        <dt>Wanted by</dt><dd>{date(order.expected_date)}</dd>
      </dl>
      <Field label="How much are you asking for (₹)"
        hint="You can ask for part of it now and bill the rest after delivery.">
        <input type="number" step="0.01" value={amount} autoFocus
          onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <Field label="Anything they should know">
        <input value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="Advance needed before loading" />
      </Field>
      {part ? (
        <div className="banner info">
          <span><Icon name="info" size={16} /></span>
          <div className="small">
            You are asking for <b>{inr(Number(amount), 0)}</b> of {inr(order.grand_total, 0)}.
            You can only ask once per order, so include everything you need up front.
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

/* ---------------------------------------------------------------------------
 * WHAT THEY ARE ASKING TODAY
 *
 * Deliberately four fields. A supplier updating a price is standing in a mandi
 * on a phone, and every extra box is a reason to do it tomorrow instead.
 * ------------------------------------------------------------------------ */
function RateModal({ row, onClose, onDone }: {
  row: any; onClose: () => void; onDone: (m: string) => void;
}) {
  const [rate, setRate] = useState(row.quoted_rate != null ? String(row.quoted_rate) : '');
  const [qty, setQty] = useState(row.available_qty != null ? String(row.available_qty) : '');
  const [grade, setGrade] = useState(row.offered_grade ?? row.typical_grade ?? '');
  const [validTill, setValidTill] = useState(row.valid_till ?? '');
  const [note, setNote] = useState(row.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  const n = Number(rate);
  const last = Number(row.last_paid_rate);
  const movePct = last > 0 && n > 0 ? ((n - last) / last) * 100 : null;

  return (
    <Modal
      title={row.product_name}
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !(n > 0)}
          onClick={async () => {
            setBusy(true); setError(null);
            try {
              const r = await api.post<any>('/supplier/rates', {
                productId: row.product_id,
                rate: n,
                availableQty: qty ? Number(qty) : undefined,
                grade: grade || undefined,
                validTill: validTill || undefined,
                note: note.trim() || undefined,
              });
              onDone(r.message);
            } catch (e: any) { setError(e); } finally { setBusy(false); }
          }}>Tell the buyer</button>
      </>}
    >
      <ErrorBanner error={error} />
      <div className="grid c2">
        <Field label={`Your rate per ${row.base_uom}`}>
          <input type="number" step="0.01" min={0} autoFocus value={rate}
            onChange={(e) => setRate(e.target.value)} placeholder="72" />
        </Field>
        <Field label="How much you have" hint="Optional — helps the buyer size the order.">
          <input type="number" step="0.001" min={0} value={qty}
            onChange={(e) => setQty(e.target.value)} placeholder="400" />
        </Field>
      </div>

      {/* The number that starts the argument, shown before it is sent rather
          than after. A supplier who has not noticed they are asking 30% more
          than last week would rather find out here. */}
      {movePct != null && Math.abs(movePct) >= 0.5 ? (
        <div className={`banner ${Math.abs(movePct) > 20 ? 'warn' : 'info'} mb`}>
          <span><Icon name={Math.abs(movePct) > 20 ? 'alert' : 'info'} size={16} /></span>
          <div className="small">
            That is <b>{movePct > 0 ? 'up' : 'down'} {num(Math.abs(movePct), 1)}%</b> on the{' '}
            {inr(row.last_paid_rate)} we last paid you
            {row.last_purchase_at ? ` on ${date(row.last_purchase_at)}` : ''}.
            {movePct > 20 ? ' The buyer will ask why — the note below is the place to say.' : ''}
          </div>
        </div>
      ) : null}

      <div className="grid c2">
        <Field label="Grade" hint="Optional.">
          <select value={grade} onChange={(e) => setGrade(e.target.value)}>
            <option value="">Not stated</option>
            {['A', 'B', 'C'].map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </Field>
        <Field label="Good until" hint="Leave blank if it stands until you change it.">
          <input type="date" value={validTill} onChange={(e) => setValidTill(e.target.value)} />
        </Field>
      </div>
      <Field label="Anything the buyer should know">
        <input value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="Ratnagiri lot, small size this week" />
      </Field>
    </Modal>
  );
}

/* ---------------------------------------------------------------------------
 * ASKING FOR A LORRY
 *
 * A request, not a booking. The office still arranges it and may say no — what
 * this guarantees is that the asking is on somebody's list rather than
 * depending on who answered the phone.
 * ------------------------------------------------------------------------ */
function AskVehicleModal({ order, onClose, onDone }: {
  order: any; onClose: () => void; onDone: (m: string) => void;
}) {
  const [note, setNote] = useState('');
  const [readyOn, setReadyOn] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  return (
    <Modal
      title={`A vehicle for ${order.po_no}`}
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy}
          onClick={async () => {
            setBusy(true); setError(null);
            try {
              const r = await api.post<any>(`/supplier/orders/${order.id}/request-vehicle`, {
                note: note.trim() || undefined,
                readyOn: readyOn || undefined,
              });
              onDone(r.message);
            } catch (e: any) { setError(e); } finally { setBusy(false); }
          }}>Ask the buyer</button>
      </>}
    >
      <ErrorBanner error={error} />
      <p className="small muted mb">
        {order.transport_by === 'SUPPLIER'
          ? 'This order is marked as your transport. Asking is still fine — the buyer can send a vehicle if they have one free.'
          : 'The buyer arranges the vehicle for this order.'}
      </p>
      <Field label="When will it be ready" hint="Optional — helps them plan the run.">
        <input type="date" value={readyOn} onChange={(e) => setReadyOn(e.target.value)} />
      </Field>
      <Field label="Anything they should know">
        <input value={note} autoFocus onChange={(e) => setNote(e.target.value)}
          placeholder="40 crates, needs a closed body" />
      </Field>
    </Modal>
  );
}

/* ---------------------------------------------------------------------------
 * "I ALSO SELL THIS"
 *
 * Picked from the catalogue, never typed. A supplier inventing "Aphonso" would
 * sit next to Alphonso in every report from then on, and no report would ever
 * add the two together again. Adding a genuinely new product stays the buyer's
 * job; saying which existing ones you stock does not need to.
 * ------------------------------------------------------------------------ */
function AddMyProductModal({ rows, onClose, onDone }: {
  rows: any[]; onClose: () => void; onDone: (m: string) => void;
}) {
  const [productId, setProductId] = useState('');
  const [code, setCode] = useState('');
  const [grade, setGrade] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  const available = rows.filter((r) => !r.already_mine);
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? available.filter((r) =>
        `${r.name} ${r.sku} ${r.category_name ?? ''}`.toLowerCase().includes(needle))
    : available;

  return (
    <Modal
      title="Something else you sell"
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !productId}
          onClick={async () => {
            setBusy(true); setError(null);
            try {
              const r = await api.post<any>('/supplier/catalogue', {
                productId,
                supplierCode: code.trim() || undefined,
                typicalGrade: grade || undefined,
              });
              onDone(r.message);
            } catch (e: any) { setError(e); } finally { setBusy(false); }
          }}>Add it to my list</button>
      </>}
    >
      <ErrorBanner error={error} />
      {!available.length ? (
        <Empty icon="👍" title="You are already on every product we buy"
          hint="Put a rate against the ones you have today." />
      ) : (
        <>
          <Field label="Which one">
            <input value={q} autoFocus onChange={(e) => setQ(e.target.value)}
              placeholder="Search the list…" />
          </Field>
          <div className="table-wrap" style={{ maxHeight: '38vh', overflowY: 'auto' }}>
            <table className="data">
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} className={productId === r.id ? 'row-ok' : ''}
                    style={{ cursor: 'pointer' }} onClick={() => setProductId(r.id)}>
                    <td style={{ width: 34 }}>
                      <input type="radio" readOnly checked={productId === r.id}
                        style={{ width: 16, height: 16 }} />
                    </td>
                    <td>
                      <div className="row" style={{ gap: 8 }}>
                        <Icon name={r.icon ?? 'produce'} size={17} />
                        <div><b>{r.name}</b>
                          <div className="small muted">{r.category_name ?? r.sku}</div></div>
                      </div>
                    </td>
                  </tr>
                ))}
                {!shown.length ? (
                  <tr><td className="muted small" style={{ padding: 12 }}>
                    Nothing matches that. If we do not buy it at all, ask the buyer to add it.
                  </td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <div className="grid c2" style={{ marginTop: 12 }}>
            <Field label="What you call it" hint="Optional — printed on your delivery note.">
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="HAP-01" />
            </Field>
            <Field label="Grade you usually send" hint="Optional.">
              <select value={grade} onChange={(e) => setGrade(e.target.value)}>
                <option value="">Not stated</option>
                {['A', 'B', 'C'].map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </Field>
          </div>
        </>
      )}
    </Modal>
  );
}
