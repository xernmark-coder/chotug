import React from 'react';
import { inr, num, date } from '../lib/api';
import { ErrorBanner, Loading, Modal, useApi } from './ui';
import { Icon } from './icons';

/* ===========================================================================
 * AN INVOICE, ON PAPER
 *
 * One component for all three places it is asked for — the Finance desk, the
 * gate, and the supplier's own panel. Three screens each laying out a bill from
 * the same tables is three chances for them to disagree about what was owed,
 * and this is the piece of paper the argument gets settled with.
 *
 * `endpoint` is the only difference between them: staff read it through
 * /costing, a supplier through /supplier, and the server scopes that one to
 * their own invoices. The document itself is identical.
 * ======================================================================== */

export function InvoiceSheet({ invoiceId, endpoint, onClose }: {
  invoiceId: string;
  /** '/costing/invoices' for staff, '/supplier/invoices' for the supplier. */
  endpoint?: string;
  onClose: () => void;
}) {
  const base = endpoint ?? '/costing/invoices';
  const { data, loading, error } = useApi<any>(`${base}/${invoiceId}/print`, [invoiceId]);

  return (
    <Modal
      title={data ? `Invoice ${data.invoice_no}` : 'Invoice'}
      onClose={onClose}
      wide
      className="print-label-modal"
      footer={<>
        <button className="btn" onClick={onClose}>Close</button>
        <button className="btn primary" disabled={!data} onClick={() => window.print()}>
          <Icon name="inbox" size={15} /> Print
        </button>
      </>}
    >
      <ErrorBanner error={error} />
      {loading || !data ? <Loading /> : (
        <div className="invoice-sheet">
          <div className="inv-head">
            <div>
              <div className="inv-title">TAX INVOICE</div>
              <div className="inv-no">{data.invoice_no}</div>
              <div className="small muted">
                Dated {date(data.invoice_date)}
                {data.due_date ? ` · due ${date(data.due_date)}` : ''}
              </div>
            </div>
            <div className="inv-buyer">
              <b>{data.buyer?.trade_name ?? data.buyer?.legal_name}</b>
              {data.buyer?.legal_name && data.buyer?.trade_name
                && data.buyer.legal_name !== data.buyer.trade_name
                ? <div className="small">{data.buyer.legal_name}</div> : null}
              {data.buyer?.registered_address
                ? <div className="small muted">{data.buyer.registered_address}</div> : null}
              {data.buyer?.gstin ? <div className="small">GSTIN {data.buyer.gstin}</div> : null}
              {data.buyer?.fssai_lic_no
                ? <div className="small">FSSAI {data.buyer.fssai_lic_no}</div> : null}
            </div>
          </div>

          <div className="inv-parties">
            <div>
              <div className="inv-label">Billed by</div>
              <b>{data.supplier_name}</b>
              {data.supplier_legal_name && data.supplier_legal_name !== data.supplier_name
                ? <div className="small">{data.supplier_legal_name}</div> : null}
              {data.supplier_address
                ? <div className="small muted">{data.supplier_address}</div> : null}
              {data.supplier_gstin ? <div className="small">GSTIN {data.supplier_gstin}</div> : null}
              {data.supplier_pan ? <div className="small">PAN {data.supplier_pan}</div> : null}
              {data.supplier_phone ? <div className="small">{data.supplier_phone}</div> : null}
            </div>
            <div>
              <div className="inv-label">Against</div>
              {data.po_no
                ? <><b className="mono">{data.po_no}</b>
                    {data.order_date
                      ? <div className="small muted">ordered {date(data.order_date)}</div> : null}</>
                : <span className="muted">no order</span>}
              {data.delivered_to
                ? <div className="small">Delivered to {data.delivered_to}</div> : null}
            </div>
          </div>

          <table className="inv-lines">
            <thead>
              <tr>
                <th style={{ width: 34 }}>#</th>
                <th>Item</th>
                <th className="num">Qty</th>
                <th className="num">Rate</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {(data.lines ?? []).map((l: any, i: number) => (
                <tr key={i}>
                  <td>{l.line_no ?? i + 1}</td>
                  <td>{l.product_name}
                    {l.sku ? <div className="small muted">{l.sku}</div> : null}</td>
                  <td className="num">{num(l.qty, 2)} {l.uom}</td>
                  <td className="num">{inr(l.rate, 2)}</td>
                  <td className="num">{inr(l.amount, 2)}</td>
                </tr>
              ))}
              {!(data.lines ?? []).length ? (
                <tr><td colSpan={5} className="muted">
                  No lines were filed against this invoice.
                </td></tr>
              ) : null}
            </tbody>
          </table>

          <div className="inv-totals">
            <div><span>Subtotal</span><b>{inr(data.subtotal, 2)}</b></div>
            {Number(data.tax_amount) > 0
              ? <div><span>Tax</span><b>{inr(data.tax_amount, 2)}</b></div> : null}
            {/* Named on the paper too. A fare inside a goods total is the kind
                of thing nobody queries until year end. */}
            {data.transportAmount != null
              ? <div><span>of which transport</span><b>{inr(data.transportAmount, 2)}</b></div>
              : null}
            <div className="inv-grand"><span>Total</span><b>{inr(data.total, 2)}</b></div>
            {data.paidAmount > 0 ? (
              <>
                <div><span>Paid</span><b>{inr(data.paidAmount, 2)}</b></div>
                <div className={data.balance > 0.01 ? 'inv-due' : ''}>
                  <span>{data.balance > 0.01 ? 'Balance due' : 'Settled in full'}</span>
                  <b>{data.balance > 0.01 ? inr(data.balance, 2) : '—'}</b>
                </div>
              </>
            ) : (
              <div className="inv-due"><span>Balance due</span><b>{inr(data.total, 2)}</b></div>
            )}
          </div>

          <div className="inv-foot small muted">
            {data.filed_by_supplier
              ? 'Filed by the supplier on their own panel.'
              : 'Entered by the buyer.'}
            {data.paymentRequestNo ? ` Payment reference ${data.paymentRequestNo}.` : ''}
            <div>This is a computer-generated document.</div>
          </div>
        </div>
      )}
    </Modal>
  );
}
