import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth, inr, num, dateTime, ago } from '../lib/api';
import {
  Chip, DataTable, Empty, ErrorBanner, Layout, Loading, useApi,
  FilterBar, FilterTotals, useFilters,
} from '../components/ui';
import { CHART, ChartCard, FacingFlow, FlowDays, inrCompact } from '../components/charts';

/* ===========================================================================
 * THE MONEY BOARD
 *
 *   "there will be a page on which there will be total graph of where money
 *    went from where it came, also the latest money went and came should come
 *    there, it should update with every money transaction like payment to
 *    vehical, driver, any other cost. every income that warehouse has got
 *    there actually."
 *
 * The Finance desk answers "what do I have to do next" — it is a queue, and
 * everything on it is an action. This answers the question the desk cannot,
 * because a queue empties: what actually happened to the money.
 *
 * The one rule that shapes the whole page: CASH IS NOT THE SAME AS OWED. A
 * sale that has been billed is not income until somebody hands over the money;
 * an invoice sitting in the inbox is not spend until it is paid. Both are real
 * and both are on the page — but beside the cash, never added into it. Adding
 * the two together is how a money dashboard ends up flattering.
 * ======================================================================== */

const WINDOWS = [
  { d: 7, label: 'Last 7 days' },
  { d: 30, label: 'Last 30 days' },
  { d: 90, label: 'Last 90 days' },
  { d: 365, label: 'Last year' },
];

export function MoneyFlowPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [days, setDays] = useState(30);
  const flow = useApi<any>(`/finance/money-flow?days=${days}`, [days]);

  /* "it should update with every money transaction."
   *
   * There is no push channel in this product, so the page re-reads itself
   * every twenty seconds — often enough that money paid at the desk shows up
   * here before the person who paid it has walked back, and cheap enough that
   * it can be left open on a screen all day. reload() replaces the data in
   * place, so the page never blanks while it refreshes. */
  useEffect(() => {
    const t = setInterval(() => flow.reload(), 20_000);
    return () => clearInterval(t);
  }, [days]); // eslint-disable-line react-hooks/exhaustive-deps

  const d = flow.data ?? {};
  const t = d.totals ?? {};
  const cx = d.context ?? {};
  const moneyIn = Number(t.in ?? 0);
  const moneyOut = Number(t.out ?? 0);
  const net = Number(t.net ?? 0);

  const latest = d.latest ?? [];
  /* Deliberately no `date` here. The page already has one window selector in
     its header and the feed is filtered to it on the server; a second date
     control inside the list would sit there reading "All time" underneath a
     header reading "Last 30 days" and there would be no way to tell which one
     the rows obeyed. One control, one meaning. */
  const f = useFilters<any>(latest, {
    search: (m: any) => [m.party, m.doc_no, m.reference, m.what, m.note, m.place]
      .filter(Boolean).join(' '),
    facets: [
      { key: 'dir', label: 'direction', all: 'In and out', of: (m: any) =>
        (m.direction === 'IN' ? 'money in' : 'money out') },
      { key: 'what', label: 'what for', of: (m: any) => m.what },
      { key: 'mode', label: 'how', of: (m: any) => m.mode },
      { key: 'who', label: 'who', of: (m: any) => m.party },
    ],
    /* Counted on the same definition as the figures at the top of the page:
       money that actually landed or actually left. A handover a centre has
       declared but Finance has not checked in is IN THE LIST — it is a real
       movement and the point of the list is to show it — but it is not added
       up here, because the two numbers would then disagree with the headline
       and a reader would have no way to know which was right. */
    totals: [
      { label: 'Landed', money: true, of: (m: any) =>
        (m.direction === 'IN' && (m.status === 'CONFIRMED' || m.status === 'DISPUTED')
          ? Number(m.amount) || 0 : 0) },
      { label: 'Paid out', money: true, of: (m: any) =>
        (m.direction === 'OUT' && m.status === 'POSTED' ? Number(m.amount) || 0 : 0) },
    ],
  });

  /* Every hook above runs on every render, including the first one where there
     is no data yet — the loading branch sits BELOW them for that reason. An
     early return above useFilters changes the hook count between renders,
     which React refuses outright. */
  if (flow.loading && !flow.data) return <Layout title="Money"><Loading /></Layout>;

  return (
    <Layout
      title="Money"
      subtitle="Where it came from, where it went, and what moved last"
      actions={
        <div className="btn-row">
          <select className="branch-select" value={days}
            onChange={(e) => setDays(Number(e.target.value))}>
            {WINDOWS.map((w) => <option key={w.d} value={w.d}>{w.label}</option>)}
          </select>
          <button className="btn sm" onClick={() => flow.reload()}>Refresh</button>
          <button className="btn sm primary" onClick={() => nav('/finance')}>Finance desk →</button>
        </div>
      }
    >
      <ErrorBanner error={flow.error} />

      {/* ---------------------------------------------- the three figures --- */}
      <div className="flow-heads mb">
        <div className="flow-head" style={{ borderTopColor: CHART.flow.in }}>
          <span className="lbl">Money in</span>
          <div className="amt" style={{ color: CHART.flow.in }}>{inr(moneyIn, 0)}</div>
          <div className="sub">
            {num(t.inCount, 0)} receipt(s) confirmed as landed
          </div>
        </div>
        <div className="flow-head" style={{ borderTopColor: CHART.flow.out }}>
          <span className="lbl">Money out</span>
          <div className="amt" style={{ color: CHART.flow.out }}>{inr(moneyOut, 0)}</div>
          <div className="sub">{num(t.outCount, 0)} payment(s) made</div>
        </div>
        <div className="flow-head"
          style={{ borderTopColor: net < 0 ? CHART.flow.out : CHART.flow.in }}>
          <span className="lbl">Net movement</span>
          <div className="amt">{inr(net, 0)}</div>
          <div className="sub">
            {net < 0
              ? `${inr(Math.abs(net), 0)} more went out than came in`
              : net > 0 ? 'more came in than went out' : 'in and out are level'}
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------ the graph --- */}
      <div className="mb">
        <ChartCard
          title="Where it came from, where it went"
          legend={[
            { label: 'Money in', color: CHART.flow.in },
            { label: 'Money out', color: CHART.flow.out },
          ]}
          hint={'Cash only, over the chosen window. Both columns are drawn to one '
            + 'scale, so a bar on the left and a bar on the right of the same length '
            + 'are the same amount of money.'}
          empty={!(d.sources ?? []).length && !(d.destinations ?? []).length ? (
            <Empty icon="💸" title="No money has moved in this period"
              hint="Payments made and money confirmed as received both show up here." />
          ) : undefined}
        >
          <FacingFlow
            left={(d.sources ?? []).map((s: any) => ({
              label: s.label, amount: Number(s.amount), movements: s.movements,
            }))}
            right={(d.destinations ?? []).map((x: any) => ({
              label: x.label, amount: Number(x.amount), movements: x.movements,
            }))}
            leftTitle="Came from"
            rightTitle="Went to"
            valueFmt={(v) => inr(v, 0)}
          />
        </ChartCard>
      </div>

      {/* ------------------------------------------------------ over time --- */}
      <div className="grid sidebar-right mb">
        <ChartCard
          title={`Day by day, last ${days} days`}
          legend={[
            { label: 'In', color: CHART.flow.in },
            { label: 'Out', color: CHART.flow.out },
          ]}
          hint="One axis, one measure: money in above the line, money out below it."
        >
          <FlowDays data={d.daily ?? []} valueFmt={inrCompact} />
        </ChartCard>

        <div className="card">
          <div className="card-head"><h2>How it moved</h2></div>
          <div className="card-body">
            <div className="small muted mb">
              Cash or online, in each direction. A business that is taking cash it
              cannot trace is a business with a hole in it.
            </div>
            {(['in', 'out'] as const).map((dir) => {
              const rows = d.byMode?.[dir] ?? [];
              const sum = rows.reduce((a: number, m: any) => a + Number(m.amount), 0);
              return (
                <div key={dir} className="mb">
                  <div className="lbl">{dir === 'in' ? 'Coming in' : 'Going out'}</div>
                  {rows.length ? rows.map((m: any) => (
                    <div className="flow-row" key={m.mode} style={{ marginBottom: 7 }}>
                      <span className="flow-label">{m.mode.toLowerCase()}</span>
                      <b className="flow-value">{inr(m.amount, 0)}</b>
                      <span className="flow-track">
                        <i style={{
                          width: `${sum > 0 ? (Number(m.amount) / sum) * 100 : 0}%`,
                          background: dir === 'in' ? CHART.flow.in : CHART.flow.out,
                        }} />
                      </span>
                    </div>
                  )) : <div className="flow-none">nothing yet</div>}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* --------------------------------------- real, but not cash yet --- */}
      <div className="section-head"><h2>Real, but not cash yet</h2><span className="rule" /></div>
      <div className="flow-aside mb">
        <div>
          <em>Billed, not collected</em>
          <b>{inr(cx.revenue_booked, 0)}</b>
          <span>sold over this window — the cash arrives when a centre hands it over</span>
        </div>
        <div>
          <em>Declared, not confirmed</em>
          <b>{inr(cx.awaiting_confirmation, 0)}</b>
          <span>{num(cx.awaiting_count, 0)} handover(s) Finance has still to check in</span>
        </div>
        <div>
          <em>Owed, not yet paid</em>
          <b>{inr(cx.owed_out, 0)}</b>
          <span>claims sitting in the inbox</span>
        </div>
        {/* The uncomfortable one. The client's rule is that every rupee leaves
            through Finance; this is the measure of how far that is from true. */}
        <div style={Number(cx.off_desk_spend) > 0
          ? { borderColor: 'var(--accent-border)', background: 'var(--accent-soft)' } : undefined}>
          <em>Spent off this desk</em>
          <b>{inr(cx.off_desk_spend, 0)}</b>
          <span>
            {num(cx.off_desk_count, 0)} farm cost(s) booked against a crop without a
            payment request — not counted above
          </span>
        </div>
      </div>

      {/* --------------------------------------------- the latest moves --- */}
      <div className="section-head">
        <h2>What moved last</h2>
        <span className="rule" />
        <span className="small muted">refreshes on its own</span>
      </div>
      <div className="card">
        <div className="card-body tight">
          <FilterBar f={f} placeholder="Search payee, reference, document" />
          <FilterTotals f={f} noun="movement" />
          <DataTable
            rows={f.rows}
            defaultSort="w"
            rowTone={(m: any) => (m.status === 'REVERSED' || m.status === 'DISPUTED'
              ? 'crit' : undefined)}
            cols={[
              {
                /* Direction reads from a glyph and a word as well as the hue —
                   the two-colour scheme never has to carry it alone. */
                key: 'd', head: '', width: 46, sort: (m: any) => m.direction,
                render: (m: any) => (
                  <span className="mv-dir" title={m.direction === 'IN' ? 'money in' : 'money out'}
                    style={{
                      background: m.direction === 'IN' ? '#EEF2FF' : '#FEF3E8',
                      color: m.direction === 'IN' ? CHART.flow.in : CHART.flow.out,
                    }}>
                    {m.direction === 'IN' ? '↓' : '↑'}
                  </span>
                ),
              },
              {
                key: 'w', head: 'When', desc: true, sort: (m: any) => m.at,
                render: (m: any) => (
                  <div><span className="small">{m.at ? ago(m.at) : '—'}</span>
                    <div className="small muted">{m.at ? dateTime(m.at) : ''}</div></div>
                ),
              },
              {
                key: 'p', head: 'Who', sort: (m: any) => m.party, render: (m: any) => (
                  <div><b>{m.party}</b>
                    {m.place ? <div className="small muted">{m.place}</div> : null}</div>
                ),
              },
              {
                key: 'f', head: 'What for', sort: (m: any) => m.what, render: (m: any) => (
                  <div>{m.what}
                    {m.note ? <div className="small muted" title={m.note}>
                      {String(m.note).length > 54 ? `${String(m.note).slice(0, 54)}…` : m.note}
                    </div> : null}</div>
                ),
              },
              {
                key: 'm', head: 'How', sort: (m: any) => m.mode, render: (m: any) => (
                  <div><Chip tone="neutral">{m.mode.toLowerCase()}</Chip>
                    {m.reference ? <div className="small muted mono">{m.reference}</div> : null}</div>
                ),
              },
              {
                key: 'n', head: 'Document', sort: (m: any) => m.doc_no,
                render: (m: any) => <span className="mono small">{m.doc_no}</span>,
              },
              {
                key: 'a', head: 'Amount', num: true, desc: true,
                sort: (m: any) => Number(m.amount) || 0, render: (m: any) => (
                  <b style={{ color: m.direction === 'IN' ? CHART.flow.in : CHART.flow.out }}>
                    {m.direction === 'IN' ? '+' : '−'}{inr(m.amount, 0)}
                  </b>
                ),
              },
              {
                key: 's', head: 'State', sort: (m: any) => m.status, render: (m: any) => (
                  m.status === 'POSTED' || m.status === 'CONFIRMED'
                    ? <Chip tone="ok">{m.status.toLowerCase()}</Chip>
                    : <Chip tone={m.status === 'DECLARED' ? 'warn' : 'danger'}>
                        {m.status.toLowerCase()}
                      </Chip>
                ),
              },
            ]}
            empty={<Empty icon="🧾"
              title={f.active > 0 ? 'Nothing matches those filters' : 'No money has moved yet'}
              hint={f.active > 0 ? 'Clear a filter to widen the search.'
                : 'Every payment made and every receipt confirmed lands here.'} />}
          />
        </div>
      </div>

      {!can('finance.payment.make') ? null : (
        <div className="small muted mt">
          Every row here is a payment or a receipt. Anything that spends money without
          one of those does not appear — which is the point of the figure above.
        </div>
      )}
    </Layout>
  );
}
