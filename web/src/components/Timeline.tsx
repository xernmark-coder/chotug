import React from 'react';
import { dateTime, ago } from '../lib/api';
import { Empty, Loading, useApi } from './ui';
import { Icon } from './icons';

/* ===========================================================================
 * WHAT ACTUALLY HAPPENED, IN THE ORDER IT HAPPENED
 *
 * Every step already wrote an event — ordered, sent, accepted, weighed,
 * checked, booked in, paid. Nothing ever read them back, so an order that had
 * been PAID FOR BUT NEVER ACCEPTED looked no different on screen from one that
 * had gone through properly. It took reading the database to find out.
 *
 * The same component serves the buyer and the supplier. The supplier sees the
 * movements of their own load and not the buyer's internal approvals, because
 * those are not their business — the endpoint decides, not this.
 * ======================================================================== */

const LABEL: Record<string, string> = {
  'po.created': 'Order raised',
  'po.approved': 'Order approved',
  'po.submitted': 'Sent to the supplier',
  'po.confirmed': 'Placed with the supplier',
  'po.revised': 'Order revised',
  'po.cancelled': 'Order cancelled',
  'supplier.accepted': 'Supplier accepted',
  'supplier.declined': 'Supplier declined',
  'transport.requested': 'Supplier asked for a vehicle',
  'pickup.created': 'Vehicle arranged',
  'pickup.cost.recorded': 'Transport cost recorded',
  'supplier.dispatched': 'Supplier sent the load',
  'gate.created': 'Vehicle reached the gate',
  'gate.submitted': 'Gate entry completed',
  'goods.parked_for_qc': 'Parked for the quality check',
  'weighment.captured': 'Weighed',
  'qc.completed': 'Quality checked',
  'qc.rejection.returned': 'Rejected goods answered for',
  'grn.posted': 'Booked into stock',
  'grn.reversed': 'Receipt reversed',
  'invoice.payable': 'Invoice matched',
  'payment.requested': 'Money asked for',
  'payment.verified': 'Approved by Finance',
  'payment.made': 'Paid',
  'payment.rebilled': 'Claim moved onto the invoice',
  'payment.reversed': 'Payment reversed',
  'landing_cost.updated': 'Landed cost worked out',
};

const TONE: Record<string, string> = {
  'supplier.accepted': 'ok', 'grn.posted': 'ok', 'payment.made': 'ok',
  'supplier.declined': 'danger', 'po.cancelled': 'danger',
  'grn.reversed': 'danger', 'payment.reversed': 'danger',
  'qc.completed': 'warn', 'qc.rejection.returned': 'warn',
};

/** The one line of detail worth showing beside each step. */
function detail(e: any): string | null {
  const p = e.payload ?? {};
  const bits = [
    p.poNo, p.grnNo, p.gateNo, p.pickupNo, p.invoiceNo, p.requestNo, p.inspectionNo,
    p.vehicleReg, p.productName,
    p.amount != null ? `₹${Number(p.amount).toLocaleString('en-IN')}` : null,
    p.acceptedQty != null ? `${p.acceptedQty} accepted` : null,
    p.qty != null && p.uom ? `${p.qty} ${p.uom}` : null,
    p.result, p.reason, p.note,
  ].filter(Boolean);
  return bits.length ? bits.slice(0, 3).join(' · ') : null;
}

export function Timeline({ endpoint, title }: { endpoint: string; title?: string }) {
  const { data, loading, error } = useApi<any[]>(endpoint, [endpoint]);
  const events = data ?? [];

  return (
    <div className="card">
      <div className="card-head"><h2>{title ?? 'Everything that happened'}</h2></div>
      <div className="card-body">
        {loading ? <Loading /> : error ? (
          <Empty icon="—" title="Could not load the history" />
        ) : !events.length ? (
          <Empty icon="🕓" title="Nothing recorded yet" />
        ) : (
          <ol className="tl">
            {events.map((e: any) => {
              const tone = TONE[e.event_type];
              const d = detail(e);
              return (
                <li key={e.id} className={`tl-item ${tone ? `tl-${tone}` : ''}`}>
                  <span className="tl-dot" />
                  <div className="tl-body">
                    <div className="tl-what">
                      {LABEL[e.event_type] ?? e.event_type.replace(/[._]/g, ' ')}
                    </div>
                    {d ? <div className="small muted">{d}</div> : null}
                  </div>
                  <div className="tl-when small muted" title={dateTime(e.created_at)}>
                    {ago(e.created_at)}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
