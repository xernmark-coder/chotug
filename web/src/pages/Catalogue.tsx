import React, { useMemo, useState } from 'react';
import { api, useAuth, inr, num } from '../lib/api';
import {
  Chip, DataTable, Empty, ErrorBanner, Field, Layout, Loading, Modal, useApi, useToast,
  FilterBar, FilterTotals, useFilters,
} from '../components/ui';
import { Icon } from '../components/icons';

/* ===========================================================================
 * CATALOGUE — what a thing is called, and by whom.
 *
 * Three questions this page answers, which nothing in the system could answer
 * before:
 *
 *   What do we sell?      Fruits → Mango → Alphonso, Kesar, Kokani.
 *                         A breed is a product: it holds its own stock, its
 *                         own price and its own history, and rolls up to Mango
 *                         in every report.
 *
 *   What does the         The same Alphonso is "MNG-A1" on one aadhti's
 *   supplier call it?     delivery note and "AH-04" on the next. Both are
 *                         recorded against ours so nobody translates in their
 *                         head at 5 a.m.
 *
 *   What do we track      One generated code per supplier-product pair. It is
 *   it by?                printed on the label and scanned at the gate, at
 *                         packing and at audit.
 * ======================================================================== */

/* ===========================================================================
 * WHAT IT COSTS US, ALL IN — AND WHAT THAT MEANS IT HAS TO SELL FOR
 *
 *   "for every product it should calculate the total cost as its cost plus cost
 *    to take it to warehouse and then send to centers. on this total cost the
 *    admin should be able to set particular profit such as 20% and then selling
 *    cost will be such that overall 20% profit will be there including
 *    transport cost."
 *
 * The breakdown is shown rather than a single total, because the only useful
 * reaction to "this has to sell at ₹94" is to see which of the four numbers
 * made it ₹94 — and three of the four are things the business can change.
 *
 * None of them is typed. The purchase price comes off the batches, the overhead
 * off what Finance actually paid, the outbound freight off what the trips to
 * the shops actually cost. The one thing set by hand is the margin.
 * ======================================================================== */
function PricingPanel() {
  const toast = useToast();
  const { can } = useAuth();
  const rows = useApi<any[]>('/masters/pricing');
  const basis = useApi<any>('/masters/pricing/basis');
  const [editing, setEditing] = useState<any>(null);

  const canPrice = can('master.pricing.manage');
  const o = basis.data?.overhead ?? {};
  const ib = basis.data?.inbound ?? {};
  const ob = basis.data?.outbound ?? {};
  const co = basis.data?.company ?? {};

  const f = useFilters<any>(rows.data, {
    search: (r: any) => [r.product_name, r.sku, r.category_name].filter(Boolean).join(' '),
    facets: [
      { key: 'c', label: 'category', of: (r: any) => r.category_name },
      { key: 'm', label: 'margin', all: 'Any margin', of: (r: any) =>
        (r.margin_is_own ? 'set on this product' : 'company default') },
      { key: 'u', label: 'selling', all: 'Priced or not', of: (r: any) =>
        (r.sell_price == null ? 'no price set'
          : Number(r.sell_price) < Number(r.min_sell_price) ? 'below the floor'
          : 'at or above the floor') },
    ],
    totals: [
      { label: 'Stock', of: (r: any) => Number(r.qty_on_hand) || 0 },
      { label: 'At cost', of: (r: any) =>
        (Number(r.qty_on_hand) || 0) * (Number(r.total_cost) || 0), money: true },
    ],
  });

  if (rows.loading || basis.loading) return <Loading />;

  return (
    <>
      <ErrorBanner error={rows.error} />

      {/* The derived numbers, said out loud with what they were derived from.
          A per-kilo overhead nobody can trace is a per-kilo overhead nobody
          believes. */}
      <div className="grid c4 mb">
        <div className="card"><div className="card-body">
          <div className="small muted">Running the place, per kg</div>
          <div className="value" style={{ fontSize: 26, fontWeight: 700 }}>
            {inr(o.overhead_per_kg, 2)}
          </div>
          <div className="small muted">
            {inr(o.operating_spend, 0)} paid over {num(o.kg_handled, 0)} kg received
            in {o.window_days ?? 30} days
          </div>
        </div></div>
        <div className="card"><div className="card-body">
          <div className="small muted">Getting it here, per kg</div>
          <div className="value" style={{ fontSize: 26, fontWeight: 700 }}>
            {inr(ib.inbound_per_kg, 2)}
          </div>
          <div className="small muted">
            {inr(ib.supplier_carried, 0)} charged by suppliers +{' '}
            {inr(ib.we_collected, 0)} on our own vehicles, over{' '}
            {num(ib.kg_received, 0)} kg received
          </div>
        </div></div>
        <div className="card"><div className="card-body">
          <div className="small muted">Getting it to the shops, per kg</div>
          <div className="value" style={{ fontSize: 26, fontWeight: 700 }}>
            {inr(ob.outbound_per_kg, 2)}
          </div>
          <div className="small muted">
            {inr(ob.outbound_spend, 0)} on {num(ob.trips, 0)} trip(s) carrying{' '}
            {num(ob.kg_moved, 0)} kg
          </div>
        </div></div>
        <div className="card"><div className="card-body">
          <div className="small muted">Profit we aim for</div>
          <div className="value" style={{ fontSize: 26, fontWeight: 700 }}>
            {num(co.default_margin_pct, 0)}%
          </div>
          <div className="small muted">
            the company default, on the whole cost — what we paid, handling,
            and both journeys. Change it in Settings, or per product below.
          </div>
        </div></div>
      </div>

      <div className="card"><div className="card-body tight">
        <FilterBar f={f} placeholder="Search product, code, category" />
        <FilterTotals f={f} noun="product" />
        <DataTable
          rows={f.rows}
          defaultSort="t"
          rowTone={(r: any) => (r.sell_price != null
            && Number(r.sell_price) < Number(r.min_sell_price) ? 'crit' : undefined)}
          cols={[
            { key: 'p', head: 'Product', sort: (r: any) => r.product_name, render: (r: any) => (
              <div className="row" style={{ gap: 8 }}>
                <Icon name={r.icon ?? 'produce'} size={17} />
                <div><b>{r.product_name}</b>
                  <div className="small muted">{r.category_name} · {r.sku}</div></div>
              </div>
            ) },
            { key: 'b', head: 'Bought at', num: true, desc: true,
              sort: (r: any) => Number(r.cost_to_warehouse) || 0, render: (r: any) => (
              <span>{inr(r.cost_to_warehouse, 2)}
                <div className="small muted">per {r.base_uom?.toLowerCase() ?? 'kg'}</div></span>
            ) },
            { key: 'o', head: 'Handling', num: true, desc: true,
              sort: (r: any) => Number(r.overhead_cost) || 0,
              render: (r: any) => inr(r.overhead_cost, 2) },
            /* Both legs, separately. A single "transport" figure would hide
               which end of the journey is expensive, and they are two
               different problems with two different people to talk to. */
            { key: 'fi', head: 'Freight in', num: true, desc: true,
              sort: (r: any) => Number(r.freight_in) || 0,
              render: (r: any) => inr(r.freight_in, 2) },
            { key: 'f', head: 'To the shop', num: true, desc: true,
              sort: (r: any) => Number(r.cost_to_centre) || 0,
              render: (r: any) => inr(r.cost_to_centre, 2) },
            { key: 't', head: 'Total cost', num: true, desc: true,
              sort: (r: any) => Number(r.total_cost) || 0, render: (r: any) => (
              <b>{inr(r.total_cost, 2)}</b>
            ) },
            { key: 'm', head: 'Margin', num: true, desc: true,
              sort: (r: any) => Number(r.margin_pct) || 0, render: (r: any) => (
              <span>
                {num(r.margin_pct, 0)}%
                <div className="small muted">{r.margin_is_own ? 'its own' : 'company'}</div>
              </span>
            ) },
            { key: 'w', head: 'Wastage', num: true,
              sort: (r: any) => Number(r.wastage_pct) || 0, render: (r: any) =>
              Number(r.wastage_pct) > 0
                ? <span>{num(r.wastage_pct, 0)}%</span>
                : <span className="muted">—</span> },
            /* The number the whole table exists to produce. */
            { key: 'x', head: 'Sell at least for', num: true, desc: true,
              sort: (r: any) => Number(r.min_sell_price) || 0, render: (r: any) => (
              <b style={{ fontSize: 15 }}>{inr(r.min_sell_price, 2)}</b>
            ) },
            { key: 'a', head: 'Actually selling at', num: true, desc: true,
              sort: (r: any) => Number(r.sell_price ?? r.avg_sold_at) || 0, render: (r: any) => {
              const at = r.sell_price ?? r.avg_sold_at;
              if (at == null) return <span className="muted">—</span>;
              const under = Number(at) < Number(r.min_sell_price);
              return (
                <span>
                  <b>{inr(at, 2)}</b>
                  <div className="small">
                    {under
                      ? <Chip tone="danger">below the floor</Chip>
                      : <span className="muted">
                          {r.sell_price != null ? 'list price' : 'last 30 days'}
                        </span>}
                  </div>
                </span>
              );
            } },
            { key: 'act', head: '', width: 90, render: (r: any) => canPrice
              ? <button className="btn sm" onClick={() => setEditing(r)}>Price it</button>
              : null },
          ]}
          empty={<Empty icon="🏷️"
            title={f.active > 0 ? 'No product matches those filters' : 'No products yet'} />}
        />
      </div></div>

      {editing ? (
        <PriceModal row={editing} onClose={() => setEditing(null)}
          onDone={(m) => { setEditing(null); rows.reload(); toast(m, 'ok'); }} />
      ) : null}
    </>
  );
}

/**
 * Setting the margin on one product, with the floor price moving as it is
 * typed. The number that matters is the one at the bottom, so it is shown
 * before the button is pressed rather than after.
 */
function PriceModal({ row, onClose, onDone }: {
  row: any; onClose: () => void; onDone: (m: string) => void;
}) {
  const [ownMargin, setOwnMargin] = useState(!!row.margin_is_own);
  const [margin, setMargin] = useState(String(row.margin_pct ?? ''));
  const [wastage, setWastage] = useState(String(row.wastage_pct ?? '0'));
  const [sell, setSell] = useState(row.sell_price != null ? String(row.sell_price) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  const cost = Number(row.total_cost) || 0;
  const w = Math.min(Math.max(Number(wastage) || 0, 0), 95);
  const m = Number(margin) || 0;
  /* The same arithmetic the database does, so the preview and the saved value
     cannot disagree. The wastage DIVIDES: if a tenth is thrown away, the nine
     tenths that sell have to carry the whole crate. */
  const floor = cost / Math.max(1 - w / 100, 0.05) * (1 + m / 100);
  const belowFloor = sell !== '' && Number(sell) < floor;

  return (
    <Modal
      title={`Price ${row.product_name}`}
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={async () => {
          setBusy(true); setError(null);
          try {
            const r = await api.put<any>(`/masters/products/${row.product_id}/pricing`, {
              minMarginPct: ownMargin ? Number(margin) : null,
              sellPrice: sell === '' ? null : Number(sell),
              defaultWastagePct: Number(wastage) || 0,
            });
            onDone(r.message);
          } catch (e: any) { setError(e); } finally { setBusy(false); }
        }}>Save</button>
      </>}
    >
      <ErrorBanner error={error} />

      <div className="card mb"><div className="card-body">
        <table className="data" style={{ minWidth: 0 }}>
          <tbody>
            <tr><td>What we paid for it</td>
              <td className="num mono">{inr(row.cost_to_warehouse, 2)}</td></tr>
            <tr><td>Handling — wages, power, cold store, rent</td>
              <td className="num mono">{inr(row.overhead_cost, 2)}</td></tr>
            <tr><td>Getting it here — what suppliers charged to bring it,
              and what we paid to fetch it</td>
              <td className="num mono">{inr(row.freight_in, 2)}</td></tr>
            <tr><td>Carrying it out to the shops</td>
              <td className="num mono">{inr(row.cost_to_centre, 2)}</td></tr>
            <tr><td><b>Total cost per {row.base_uom?.toLowerCase() ?? 'kg'}</b></td>
              <td className="num mono"><b>{inr(cost, 2)}</b></td></tr>
          </tbody>
        </table>
      </div></div>

      <label className="row mb" style={{ gap: 8, cursor: 'pointer' }}>
        <input type="checkbox" style={{ width: 17, height: 17 }}
          checked={ownMargin} onChange={(e) => setOwnMargin(e.target.checked)} />
        <span className="small">
          Give this product its own profit target.
          <span className="muted">
            {' '}Off means it follows the company default, and moves when that moves.
          </span>
        </span>
      </label>

      <div className="grid c2">
        <Field label="Profit on top of total cost" hint="20 means twenty per cent.">
          <input type="number" min={0} max={500} value={margin} disabled={!ownMargin}
            onChange={(e) => setMargin(e.target.value)} />
        </Field>
        <Field label="Wastage we expect"
          hint="What gets thrown away. The rest has to carry its cost.">
          <input type="number" min={0} max={95} value={wastage}
            onChange={(e) => setWastage(e.target.value)} />
        </Field>
      </div>

      <div className={`banner ${belowFloor ? 'danger' : 'ok'} mb`}>
        <span><Icon name={belowFloor ? 'alert' : 'check'} size={16} /></span>
        <div>
          <b>Sell at {inr(floor, 2)} or more</b>
          <div className="small">
            to make {num(m, 0)}% on a total cost of {inr(cost, 2)}
            {w > 0 ? `, with ${num(w, 0)}% thrown away` : ''}.
          </div>
        </div>
      </div>

      <Field label="List price (optional)"
        hint="Leave it empty to sell off the floor price above.">
        <input type="number" min={0} step="0.01" value={sell}
          onChange={(e) => setSell(e.target.value)}
          placeholder={floor.toFixed(2)} />
      </Field>
    </Modal>
  );
}

/* The units this trade actually uses. Same list the centre's stock request
   offers, so a product added here can be asked for in the unit it was created
   in rather than in whatever that screen happened to default to. */
const UOMS = [
  { v: 'KG', label: 'Kilograms (kg)' },
  { v: 'BOX', label: 'Boxes' },
  { v: 'CRATE', label: 'Crates' },
  { v: 'BAG', label: 'Bags' },
  { v: 'PCS', label: 'Pieces' },
  { v: 'DOZ', label: 'Dozens' },
  { v: 'QTL', label: 'Quintals' },
  { v: 'TON', label: 'Tonnes' },
];

const ICON_CHOICES = [
  'mango', 'apple', 'banana', 'grapes', 'tomato', 'onion', 'potato',
  'leafy', 'cauliflower', 'cucumber', 'capsicum', 'produce', 'basket', 'sprout',
];

export function CataloguePage() {
  const toast = useToast();
  const { can } = useAuth();
  const cats = useApi<any>('/masters/categories');
  const prods = useApi<any[]>('/masters/products');
  const links = useApi<any[]>('/masters/supplier-products');

  const [tab, setTab] = useState<'tree' | 'codes' | 'price' | 'qc'>('tree');
  const [addCat, setAddCat] = useState<any>(null);      // parent, or {} for top level
  const [addProd, setAddProd] = useState<any>(null);    // the category it goes in
  const [addLink, setAddLink] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const canEdit = can('master.category.manage', 'master.product.manage');
  const byCat = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const p of prods.data ?? []) {
      const k = p.category_id;
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return m;
  }, [prods.data]);

  const reloadAll = () => { cats.reload(); prods.reload(); links.reload(); };

  /** One category and everything under it, drawn as an indented row. */
  const fLinks = useFilters<any>(links.data, {
    search: (r: any) => [r.product_name, r.sku, r.category_name, r.supplier_name,
      r.supplier_code, r.supplier_name_for_product, r.tracking_code].filter(Boolean).join(' '),
    facets: [
      { key: 'sup', label: 'supplier', of: (r: any) => r.supplier_name },
      { key: 'cat', label: 'category', of: (r: any) => r.category_name },
      { key: 'prod', label: 'product', of: (r: any) => r.product_name },
      { key: 'pref', label: 'preference', all: 'Preferred or not', of: (r: any) =>
        (r.is_preferred ? 'preferred' : 'other') },
    ],
    totals: [],
  });

  const renderCat = (c: any, depth = 0): React.ReactNode => {
    const mine = byCat.get(c.id) ?? [];
    const kids = c.children ?? [];
    const isOpen = open[c.id] ?? depth < 1;
    return (
      <React.Fragment key={c.id}>
        {/* The indent is a CSS variable rather than a pixel padding so a phone
            can shrink the step — a four-deep tree indented 26px a level eats
            half a 390px screen before the name starts. */}
        <div className="cat-row" style={{ '--depth': depth } as React.CSSProperties}>
          <button className="cat-toggle" onClick={() => setOpen((s) => ({ ...s, [c.id]: !isOpen }))}
            disabled={!kids.length && !mine.length}>
            {kids.length || mine.length ? (isOpen ? '−' : '+') : '·'}
          </button>
          <Icon name={c.icon ?? 'basket'} size={18} />
          <b>{c.name}</b>
          {c.name_hi ? <span className="small muted">{c.name_hi}</span> : null}
          <Chip tone="neutral">{c.segment?.toLowerCase()}</Chip>
          {mine.length ? <span className="small muted">{mine.length} product(s)</span> : null}
          <span className="spacer" />
          {canEdit ? (
            <>
              <button className="btn sm ghost" onClick={() => setAddCat({ parent: c })}>
                + Sub-category
              </button>
              <button className="btn sm" onClick={() => setAddProd(c)}>+ Product / breed</button>
            </>
          ) : null}
        </div>

        {isOpen ? (
          <>
            {mine.map((p: any) => (
              <div key={p.id} className="prod-row" style={{ '--depth': depth } as React.CSSProperties}>
                <Icon name={p.effective_icon ?? p.icon ?? 'produce'} size={17} />
                <span>{p.name}</span>
                {p.name_hi ? <span className="small muted">{p.name_hi}</span> : null}
                <span className="mono small muted">{p.sku}</span>
                <span className="spacer" />
                <span className="small muted">
                  {Number(p.current_stock) > 0
                    ? `${num(p.current_stock, 0)} ${p.base_uom} in stock`
                    : 'no stock'}
                </span>
              </div>
            ))}
            {kids.map((k: any) => renderCat(k, depth + 1))}
          </>
        ) : null}
      </React.Fragment>
    );
  };

  return (
    <Layout
      title="Catalogue"
      subtitle="Categories, breeds, and what each supplier calls them"
      actions={canEdit ? (
        <div className="btn-row">
          <button className="btn sm" onClick={() => setAddCat({ parent: null })}>+ Category</button>
          <button className="btn sm primary" onClick={() => setAddLink(true)}>+ Supplier code</button>
        </div>
      ) : undefined}
    >
      <ErrorBanner error={cats.error ?? prods.error} />

      <div className="tabs">
        <button className={`tab ${tab === 'tree' ? 'active' : ''}`} onClick={() => setTab('tree')}>
          What we sell
        </button>
        <button className={`tab ${tab === 'codes' ? 'active' : ''}`} onClick={() => setTab('codes')}>
          Supplier codes {links.data?.length ? `(${links.data.length})` : ''}
        </button>
        <button className={`tab ${tab === 'price' ? 'active' : ''}`} onClick={() => setTab('price')}>
          Cost &amp; price
        </button>
        {/* The checklist the floor works to. It lived only in the seed and
            could only be changed in SQL, so a product added today was
            inspected against whatever its category happened to default to. */}
        {can('quality.template.manage') ? (
          <button className={`tab ${tab === 'qc' ? 'active' : ''}`} onClick={() => setTab('qc')}>
            Quality checklists
          </button>
        ) : null}
      </div>

      {tab === 'qc' ? <QcTemplatesPanel /> : null}

      {tab === 'price' ? <PricingPanel /> : null}

      {tab === 'tree' ? (
        <div className="card">
          <div className="card-body tight">
            {cats.loading ? <Loading /> : (cats.data?.tree ?? []).length ? (
              <div className="cat-tree">{(cats.data.tree as any[]).map((c) => renderCat(c))}</div>
            ) : <Empty icon="📦" title="No categories yet" />}
          </div>
          <div className="card-body" style={{ borderTop: '1px solid var(--border)' }}>
            <div className="small muted">
              A breed is a product. Alphonso under Mango keeps its own stock, its own
              price and its own supplier codes, and still rolls up to Mango — and to
              Fruits — in every report.
            </div>
          </div>
        </div>
      ) : tab === 'codes' ? (
        <div className="card"><div className="card-body tight">
          <FilterBar f={fLinks} placeholder="Search product, supplier, code" />
          <FilterTotals f={fLinks} noun="code" />
          <DataTable
            loading={links.loading}
            rows={fLinks.rows}
            cols={[
              { key: 'p', head: 'Product', render: (r: any) => (
                <div className="row" style={{ gap: 8 }}>
                  <Icon name={r.icon ?? 'produce'} size={17} />
                  <div><b>{r.product_name}</b>
                    <div className="small muted">{r.category_name} · {r.sku}</div></div>
                </div>) },
              { key: 's', head: 'Supplier', render: (r: any) => (
                <div>{r.supplier_name}<div className="small muted">{r.supplier_short_code}</div></div>) },
              { key: 'c', head: 'They call it', render: (r: any) => (
                <div><b className="mono">{r.supplier_code ?? '—'}</b>
                  {r.supplier_name_for_product
                    ? <div className="small muted">{r.supplier_name_for_product}</div> : null}</div>) },
              { key: 't', head: 'We track it as', render: (r: any) =>
                <b className="mono small">{r.tracking_code}</b> },
              { key: 'r', head: 'Last rate', num: true, render: (r: any) =>
                r.last_rate ? inr(r.last_rate) : <span className="muted">—</span> },
              { key: 'f', head: '', render: (r: any) =>
                r.is_preferred ? <Chip tone="ok">preferred</Chip> : null },
            ]}
            empty={<Empty icon="🏷️"
              title={fLinks.active > 0 ? 'No code matches those filters' : 'No supplier codes recorded'}
              hint={fLinks.active > 0 ? 'Clear a filter to widen the search.'
                : 'Record what each supplier calls a product and their delivery note reads itself.'} />}
          />
        </div></div>
      ) : null}

      {addCat ? (
        <CategoryModal parent={addCat.parent} onClose={() => setAddCat(null)}
          onDone={() => { setAddCat(null); reloadAll(); toast('Category added', 'ok'); }} />
      ) : null}
      {addProd ? (
        <ProductModal category={addProd} onClose={() => setAddProd(null)}
          onDone={() => { setAddProd(null); reloadAll(); toast('Added', 'ok'); }} />
      ) : null}
      {addLink ? (
        <SupplierCodeModal products={prods.data ?? []} onClose={() => setAddLink(false)}
          onDone={() => { setAddLink(false); links.reload(); toast('Supplier code saved', 'ok'); }} />
      ) : null}
    </Layout>
  );
}

/* ------------------------------------------------------------- pickers --- */
function IconPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="icon-picker">
      {ICON_CHOICES.map((k) => (
        <button key={k} type="button" title={k}
          className={`icon-choice ${value === k ? 'on' : ''}`} onClick={() => onChange(k)}>
          <Icon name={k} size={22} />
        </button>
      ))}
    </div>
  );
}

function CategoryModal({ parent, onClose, onDone }: {
  parent: any | null; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [nameHi, setNameHi] = useState('');
  const [code, setCode] = useState('');
  const [segment, setSegment] = useState(parent?.segment ?? 'FRUIT');
  const [icon, setIcon] = useState(parent?.icon ?? 'basket');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  return (
    <Modal
      title={parent ? `Add inside ${parent.name}` : 'Add a category'}
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !name.trim()} onClick={async () => {
          setBusy(true); setError(null);
          try {
            await api.post('/masters/categories', {
              name: name.trim(), nameHi: nameHi.trim() || undefined,
              // Derived so nobody has to invent one; still editable above.
              code: (code || name).trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12),
              parentId: parent?.id ?? null,
              segment: parent ? undefined : segment,
              icon,
            });
            onDone();
          } catch (e: any) { setError(e); } finally { setBusy(false); }
        }}>Add</button>
      </>}
    >
      <ErrorBanner error={error} />
      {parent ? (
        <p className="small muted mb">
          It will sit under <b>{parent.name}</b> and inherit its produce type.
          This is how Mango goes under Fruits, with the breeds as products inside it.
        </p>
      ) : null}
      <div className="grid c2">
        <Field label="Name"><input value={name} autoFocus
          onChange={(e) => setName(e.target.value)} placeholder="Mango" /></Field>
        <Field label="Name in Hindi / Marathi"><input value={nameHi}
          onChange={(e) => setNameHi(e.target.value)} placeholder="आम" /></Field>
      </div>
      <div className="grid c2">
        <Field label="Short code" hint="Left blank, it is made from the name.">
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="MANGO" />
        </Field>
        {!parent ? (
          <Field label="Kind of produce">
            <select value={segment} onChange={(e) => setSegment(e.target.value)}>
              {['FRUIT','VEGETABLE','GROCERY','DAIRY','SPICE','GRAIN','OTHER'].map((sgm) =>
                <option key={sgm} value={sgm}>{sgm.toLowerCase()}</option>)}
            </select>
          </Field>
        ) : null}
      </div>
      <Field label="Picture" hint="What the staff will recognise it by.">
        <IconPicker value={icon} onChange={setIcon} />
      </Field>
    </Modal>
  );
}

/** Exported so a product can be added from wherever one is being picked. */
/**
 * Adding a product.
 *
 * On the catalogue you are already standing inside a category, so it is passed
 * in. Opened from a product dropdown somewhere else — a centre asking for
 * stock, say — there is no category in hand, so it asks for one. A modal that
 * demands context the caller does not have is a modal that cannot be reused,
 * which is how "add new to every dropdown" ends up meaning "on one screen".
 */
export function ProductModal({ category, onClose, onDone }: {
  category?: any; onClose: () => void; onDone: (created?: any) => void;
}) {
  const cats = useApi<any>(category ? null : '/masters/categories');
  const [categoryId, setCategoryId] = useState(category?.id ?? '');
  const [name, setName] = useState('');
  const [nameHi, setNameHi] = useState('');
  const [icon, setIcon] = useState(category?.icon ?? 'produce');
  const [shelf, setShelf] = useState('');
  const [reorder, setReorder] = useState('');
  const [storage, setStorage] = useState('AMBIENT');
  /* What the product is counted in. Everything downstream reads this — the
     reorder point, the order quantity, the pack size, the price per unit — so
     leaving it to default to kilos silently turned every crate-traded product
     into a kilo-traded one. */
  const [uom, setUom] = useState('KG');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  /* The tree comes back nested; a dropdown wants it flat, indented so the
     shape is still readable. */
  const flat: { id: string; label: string }[] = [];
  const walk = (list: any[], depth = 0) => {
    for (const c of list ?? []) {
      flat.push({ id: c.id, label: `${'\u00a0\u00a0'.repeat(depth)}${c.name}` });
      walk(c.children ?? [], depth + 1);
    }
  };
  walk(cats.data?.tree ?? []);

  return (
    <Modal
      title={category ? `Add to ${category.name}` : 'Add a product'}
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !name.trim() || !categoryId}
          onClick={async () => {
          setBusy(true); setError(null);
          try {
            const created = await api.post<any>('/masters/products', {
              categoryId, name: name.trim(),
              nameHi: nameHi.trim() || undefined,
              variety: name.trim(), icon,
              baseUom: uom, purchaseUom: uom,
              storageType: storage,
              shelfLifeDays: shelf ? Number(shelf) : undefined,
              reorderPoint: reorder ? Number(reorder) : undefined,
            });
            onDone(created);
          } catch (e: any) { setError(e); } finally { setBusy(false); }
        }}>Add</button>
      </>}
    >
      <ErrorBanner error={error} />
      {category ? (
        <p className="small muted mb">
          A breed goes in here. <b>{name.trim() || 'Alphonso'}</b> will hold its own
          stock and its own price, and still count towards {category.name}.
        </p>
      ) : (
        <Field label="Which category" hint="A breed sits under the product it is a breed of.">
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Choose…</option>
            {flat.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </Field>
      )}
      <div className="grid c2">
        <Field label="Name"><input value={name} autoFocus
          onChange={(e) => setName(e.target.value)} placeholder="Alphonso" /></Field>
        <Field label="Name in Hindi / Marathi"><input value={nameHi}
          onChange={(e) => setNameHi(e.target.value)} placeholder="हापूस" /></Field>
      </div>
      <div className="grid c4">
        <Field label="Measured in"
          hint="How this is bought, counted and sold.">
          <select value={uom} onChange={(e) => setUom(e.target.value)}>
            {UOMS.map((u) => <option key={u.v} value={u.v}>{u.label}</option>)}
          </select>
        </Field>
        <Field label="Keeps for (days)"><input type="number" value={shelf}
          onChange={(e) => setShelf(e.target.value)} placeholder="10" /></Field>
        {/* The reorder point is a bare number, and "buy again below 150" says
            nothing until you know whether that is 150 kilos or 150 crates. */}
        <Field label={`Buy again below (${uom.toLowerCase()})`}>
          <input type="number" value={reorder}
            onChange={(e) => setReorder(e.target.value)} placeholder="150" /></Field>
        <Field label="Stored as">
          <select value={storage} onChange={(e) => setStorage(e.target.value)}>
            {['AMBIENT','CHILLED','COLD','FROZEN','RIPENING'].map((x) =>
              <option key={x} value={x}>{x.toLowerCase()}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Picture"><IconPicker value={icon} onChange={setIcon} /></Field>
    </Modal>
  );
}

function SupplierCodeModal({ products, onClose, onDone }: {
  products: any[]; onClose: () => void; onDone: () => void;
}) {
  const { data: suppliers } = useApi<any[]>('/masters/suppliers');
  const [supplierId, setSupplierId] = useState('');
  const [productId, setProductId] = useState('');
  const [code, setCode] = useState('');
  const [theirName, setTheirName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  return (
    <Modal
      title="What does this supplier call it?"
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !supplierId || !productId}
          onClick={async () => {
            setBusy(true); setError(null);
            try {
              await api.post('/masters/supplier-products', {
                supplierId, productId,
                supplierCode: code.trim() || undefined,
                supplierNameForProduct: theirName.trim() || undefined,
              });
              onDone();
            } catch (e: any) { setError(e); } finally { setBusy(false); }
          }}>Save</button>
      </>}
    >
      <ErrorBanner error={error} />
      <p className="small muted mb">
        Their code goes on their delivery note; ours goes on the label we print.
        Recording both means the two can be reconciled without anybody
        remembering which is which.
      </p>
      <div className="grid c2">
        <Field label="Supplier">
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">Choose…</option>
            {(suppliers ?? []).map((s: any) =>
              <option key={s.id} value={s.id}>{s.trade_name ?? s.legal_name}</option>)}
          </select>
        </Field>
        <Field label="Our product">
          <select value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">Choose…</option>
            {products.map((p: any) =>
              <option key={p.id} value={p.id}>{p.category_name} · {p.name} ({p.sku})</option>)}
          </select>
        </Field>
      </div>
      <div className="grid c2">
        <Field label="Their code" hint="As printed on their paperwork.">
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="MNG-A1" />
        </Field>
        <Field label="Their name for it">
          <input value={theirName} onChange={(e) => setTheirName(e.target.value)}
            placeholder="Hapus Petti" />
        </Field>
      </div>
    </Modal>
  );
}

/* ===========================================================================
 * THE QUALITY CHECKLIST
 *
 * What the inspection screen asks about each product. It arrived with the seed
 * and had no editor, so a checklist could only be changed in SQL and a newly
 * added product was inspected against whatever its category happened to
 * default to — or, if the category had no default, nothing at all.
 *
 * Editing one that has been used makes a new version rather than changing it:
 * a past inspection scored "8 out of 10" against particular questions, and
 * those questions have to keep existing for that score to mean anything.
 * ======================================================================== */

const PARAM_TYPES = [
  { v: 'BOOLEAN', label: 'Yes / no',        hint: 'Is there mould?' },
  { v: 'PERCENT', label: 'A percentage',    hint: 'How much bruising?' },
  { v: 'NUMERIC', label: 'A number',        hint: 'Sweetness in brix' },
  { v: 'COUNT',   label: 'A count',         hint: 'Damaged pieces per crate' },
  { v: 'SELECT',  label: 'One of a list',   hint: 'Size: A, B or C' },
  { v: 'PHOTO',   label: 'A photo',         hint: 'Picture of the load' },
  { v: 'TEXT',    label: 'A note',          hint: 'Anything else' },
];
const NUMERIC_TYPES = ['NUMERIC', 'PERCENT', 'COUNT'];

/* A choice carries a score: "Fresh" is 100, "Wilted" is 30, and the
 * inspection's result is computed from those numbers. Editing had to keep
 * them, so they are written the way somebody would say them. */
function optionsToText(options: any): string {
  return (options ?? []).map((o: any) =>
    (typeof o === 'string' ? o : `${o.label} ${o.score}`)).join(', ');
}

function textToOptions(text: string) {
  return text.split(',').map((chunk) => {
    const t = chunk.trim();
    if (!t) return null;
    const m = t.match(/^(.*?)\s+(\d{1,3})$/);
    const label = (m ? m[1] : t).trim();
    const score = m ? Math.min(100, Number(m[2])) : 100;
    return {
      value: label.toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 40),
      label, score,
    };
  }).filter(Boolean) as { value: string; label: string; score: number }[];
}

function QcTemplatesPanel() {
  const toast = useToast();
  const { can } = useAuth();
  const templates = useApi<any[]>('/masters/qc-templates');
  const products = useApi<any[]>('/masters/products');
  const [editing, setEditing] = useState<any>(null);
  const mayEdit = can('quality.template.manage');

  /* A product with no checklist gets inspected against nothing, which looks
     like a pass. Named at the top rather than left to be noticed. */
  const unchecked = (products.data ?? []).filter((p: any) => !p.qc_template_id);

  const f = useFilters<any>(templates.data, {
    search: (t: any) => [t.code, t.name, t.note,
      ...(t.parameters ?? []).map((p: any) => p.label)].filter(Boolean).join(' '),
    facets: [
      { key: 'used', label: 'use', all: 'Used or not', of: (t: any) =>
        (Number(t.products) > 0 ? 'in use' : 'not used by any product') },
    ],
    totals: [{ label: 'Checks', of: (t: any) => (t.parameters ?? []).length }],
  });

  return (
    <>
      {unchecked.length ? (
        <div className="banner warn mb">
          <span><Icon name="alert" size={16} /></span>
          <div>
            <b>{unchecked.length} product(s) have no checklist:</b>{' '}
            {unchecked.slice(0, 6).map((p: any) => p.name).join(', ')}
            {unchecked.length > 6 ? ` and ${unchecked.length - 6} more` : ''}.
            <div className="small">
              Quality checks on these ask nothing, which reads as a pass. Give them one
              below, or set a default on their category.
            </div>
          </div>
        </div>
      ) : null}

      <FilterBar f={f} placeholder="Search a checklist or a check">
        {mayEdit ? (
          <button className="btn primary" onClick={() => setEditing({ parameters: [] })}>
            New checklist
          </button>
        ) : null}
      </FilterBar>
      <FilterTotals f={f} noun="checklist" />

      <div className="stack">
        {f.rows.map((t: any) => (
          <div className="card" key={t.id}>
            <div className="card-head">
              <h2>{t.name}</h2>
              <span className="mono small muted">{t.code} · v{t.version}</span>
              {Number(t.products) > 0
                ? <Chip tone="primary">{t.products} product(s)</Chip>
                : <Chip tone="neutral">not in use</Chip>}
              {Number(t.inspections) > 0
                ? <Chip tone="ok">{t.inspections} inspection(s)</Chip> : null}
              <span className="spacer" />
              {mayEdit ? (
                <button className="btn sm" onClick={() => setEditing(t)}>Edit</button>
              ) : null}
            </div>
            <div className="card-body tight">
              {t.note ? <p className="small muted" style={{ padding: '6px 12px 0' }}>{t.note}</p> : null}
              <table className="mini">
                <tbody>
                  {(t.parameters ?? []).map((p: any) => (
                    <tr key={p.id}>
                      <td>
                        <b>{p.label}</b>
                        {p.isCritical ? <Chip tone="danger">critical</Chip> : null}
                        {!p.isMandatory ? <Chip tone="neutral">optional</Chip> : null}
                        <div className="small muted mono">{p.code}</div>
                      </td>
                      <td className="small">
                        {PARAM_TYPES.find((x) => x.v === p.paramType)?.label ?? p.paramType}
                        {NUMERIC_TYPES.includes(p.paramType) ? (
                          <div className="muted">
                            {p.minOk != null ? `at least ${p.minOk}` : ''}
                            {p.minOk != null && p.maxOk != null ? ' · ' : ''}
                            {p.maxOk != null ? `at most ${p.maxOk}` : ''}
                            {p.unit ? ` ${p.unit}` : ''}
                          </div>
                        ) : null}
                        {p.paramType === 'SELECT' && p.options?.length ? (
                          <div className="muted">
                            {p.options.map((o: any) =>
                              typeof o === 'string' ? o : `${o.label} ${o.score}`).join(' · ')}
                          </div>
                        ) : null}
                      </td>
                      <td className="num small muted">weight {p.weight}</td>
                    </tr>
                  ))}
                  {!(t.parameters ?? []).length ? (
                    <tr><td className="muted small">No checks on this one.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        ))}
        {!f.rows.length ? (
          <Empty icon="📋"
            title={f.active > 0 ? 'No checklist matches those filters' : 'No checklists yet'}
            hint={f.active > 0 ? 'Clear a filter to widen the search.'
              : 'A checklist is what the quality screen asks about a product.'} />
        ) : null}
      </div>

      {/* Which product is checked against what. This is the half the client
          asked for first — a product added today needs a checklist, and
          inheriting the category default silently is how one ends up with
          none. */}
      <div className="card mt">
        <div className="card-head"><h2>What each product is checked against</h2></div>
        <div className="card-body tight">
          <DataTable
            loading={products.loading}
            rows={products.data ?? []}
            rowTone={(p: any) => (!p.qc_template_id ? 'crit' : undefined)}
            cols={[
              { key: 'p', head: 'Product', render: (p: any) => (
                <div className="row" style={{ gap: 8 }}>
                  <Icon name={p.icon ?? 'produce'} size={17} />
                  <div><b>{p.name}</b><div className="small muted">{p.sku}</div></div>
                </div>) },
              { key: 't', head: 'Checked against', render: (p: any) => (
                mayEdit ? (
                  <select value={p.qc_template_id ?? ''}
                    onChange={async (e) => {
                      try {
                        const r = await api.put<any>(`/masters/products/${p.id}/qc-template`,
                          { templateId: e.target.value || null });
                        toast(r.message, e.target.value ? 'ok' : 'err');
                        products.reload(); templates.reload();
                      } catch (err: any) { toast(err.message, 'err'); }
                    }}>
                    <option value="">Nothing — the check asks nothing</option>
                    {(templates.data ?? []).map((t: any) => (
                      <option key={t.id} value={t.id}>{t.name} · v{t.version}</option>
                    ))}
                  </select>
                ) : (
                  <span>{(templates.data ?? []).find((t: any) => t.id === p.qc_template_id)?.name
                    ?? <span className="chip danger">none</span>}</span>
                )) },
            ]}
            empty={<Empty icon="📦" title="No products yet" />}
          />
        </div>
      </div>

      {editing ? (
        <QcTemplateModal template={editing} onClose={() => setEditing(null)}
          onDone={(m) => {
            setEditing(null); templates.reload(); products.reload(); toast(m, 'ok');
          }} />
      ) : null}
    </>
  );
}

function QcTemplateModal({ template, onClose, onDone }: {
  template: any; onClose: () => void; onDone: (m: string) => void;
}) {
  const isNew = !template.id;
  const [code, setCode] = useState(template.code ?? '');
  const [name, setName] = useState(template.name ?? '');
  const [note, setNote] = useState(template.note ?? '');
  const [rows, setRows] = useState<any[]>(
    (template.parameters ?? []).length
      ? template.parameters.map((p: any) => ({ ...p }))
      : [{ code: '', label: '', paramType: 'BOOLEAN', isCritical: false, isMandatory: true, weight: 1 }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  const patch = (i: number, p: any) =>
    setRows((s) => s.map((r, j) => (j === i ? { ...r, ...p } : r)));

  return (
    <Modal
      title={isNew ? 'A new quality checklist' : `${template.name} · v${template.version}`}
      wide
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !code.trim() || !name.trim() || !rows.length}
          onClick={async () => {
            setBusy(true); setError(null);
            try {
              const payload = {
                code: code.trim(), name: name.trim(), note: note.trim() || undefined,
                parameters: rows.map((r) => ({
                  code: (r.code || '').trim(),
                  label: (r.label || '').trim(),
                  paramType: r.paramType,
                  unit: r.unit || undefined,
                  minOk: r.minOk === '' || r.minOk == null ? undefined : Number(r.minOk),
                  maxOk: r.maxOk === '' || r.maxOk == null ? undefined : Number(r.maxOk),
                  options: r.paramType === 'SELECT'
                    ? textToOptions(String(r.optionsText ?? optionsToText(r.options)))
                    : undefined,
                  isCritical: !!r.isCritical,
                  isMandatory: r.isMandatory !== false,
                  weight: Number(r.weight) || 1,
                  helpText: r.helpText || undefined,
                })),
              };
              const res: any = isNew
                ? await api.post('/masters/qc-templates', payload)
                : await api.put(`/masters/qc-templates/${template.id}`, payload);
              onDone(res.message);
            } catch (e: any) { setError(e); } finally { setBusy(false); }
          }}>
          {isNew ? 'Create it' : 'Save'}
        </button>
      </>}
    >
      <ErrorBanner error={error} />

      {/* Said before they press Save, not after. Changing a checklist that has
          been used does not alter what was already inspected — it cannot, or
          past scores would stop meaning anything. */}
      {!isNew && Number(template.inspections) > 0 ? (
        <div className="banner info mb">
          <span><Icon name="info" size={16} /></span>
          <div className="small">
            This has been used on <b>{template.inspections} inspection(s)</b>. Saving makes{' '}
            <b>v{Number(template.version) + 1}</b> and keeps v{template.version} exactly as it
            is, so those inspections still say what they said. The{' '}
            {template.products} product(s) using it move to the new version.
          </div>
        </div>
      ) : null}

      <div className="grid c2">
        <Field label="Code" hint="Short, stable. It does not change between versions.">
          <input value={code} disabled={!isNew}
            onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="QC-BERRY" />
        </Field>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Berries" />
        </Field>
      </div>
      <Field label="Why this changed" hint="Optional, and the first thing anybody reads later.">
        <input value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="Added a stem rot check after the August losses" />
      </Field>

      <label className="lbl mt">What the inspector is asked</label>
      <div className="table-wrap">
        <table className="data">
          <thead><tr>
            <th style={{ width: 130 }}>Code</th><th>The question</th>
            <th style={{ width: 150 }}>Answer</th><th style={{ width: 170 }}>Acceptable</th>
            <th style={{ width: 100 }}>Weight</th><th style={{ width: 120 }}>Flags</th><th />
          </tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td><input className="inline mono" value={r.code ?? ''}
                  onChange={(e) => patch(i, { code: e.target.value.toUpperCase() })}
                  placeholder="MOULD" /></td>
                <td><input className="inline" value={r.label ?? ''}
                  onChange={(e) => patch(i, { label: e.target.value })}
                  placeholder="Any mould in the crate?" /></td>
                <td>
                  <select value={r.paramType}
                    onChange={(e) => patch(i, { paramType: e.target.value })}>
                    {PARAM_TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
                  </select>
                </td>
                <td>
                  {NUMERIC_TYPES.includes(r.paramType) ? (
                    <div className="row" style={{ gap: 3 }}>
                      <input className="inline num" style={{ width: 56 }} type="number"
                        value={r.minOk ?? ''} placeholder="min"
                        onChange={(e) => patch(i, { minOk: e.target.value })} />
                      <input className="inline num" style={{ width: 56 }} type="number"
                        value={r.maxOk ?? ''} placeholder="max"
                        onChange={(e) => patch(i, { maxOk: e.target.value })} />
                      <input className="inline" style={{ width: 44 }} value={r.unit ?? ''}
                        placeholder="unit" onChange={(e) => patch(i, { unit: e.target.value })} />
                    </div>
                  ) : r.paramType === 'SELECT' ? (
                    /* "Fresh 100, Acceptable 75, Wilted 30". The number after
                       each is what that answer scores — the inspection's total
                       comes from it, so dropping it would quietly turn a graded
                       choice into three unscored words. */
                    <input className="inline" placeholder="Fresh 100, Wilted 30"
                      value={r.optionsText ?? optionsToText(r.options)}
                      onChange={(e) => patch(i, { optionsText: e.target.value })} />
                  ) : <span className="muted small">—</span>}
                </td>
                <td className="num">
                  <input className="inline num" style={{ width: 60 }} type="number" step="0.5"
                    value={r.weight ?? 1} onChange={(e) => patch(i, { weight: e.target.value })} />
                </td>
                <td>
                  <label className="check small">
                    <input type="checkbox" checked={!!r.isCritical}
                      onChange={(e) => patch(i, { isCritical: e.target.checked })} />
                    <span>critical</span>
                  </label>
                  <label className="check small">
                    <input type="checkbox" checked={r.isMandatory !== false}
                      onChange={(e) => patch(i, { isMandatory: e.target.checked })} />
                    <span>must answer</span>
                  </label>
                </td>
                <td>
                  <button className="btn sm ghost" title="Remove this check"
                    disabled={rows.length === 1}
                    onClick={() => setRows((s) => s.filter((_, j) => j !== i))}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="btn sm mt" onClick={() => setRows((s) => [...s, {
        code: '', label: '', paramType: 'BOOLEAN', isCritical: false, isMandatory: true, weight: 1,
      }])}>Add another check</button>

      <p className="small muted mt">
        <b>Critical</b> means failing it fails the whole load, whatever the score.{' '}
        <b>Weight</b> is how much the check counts towards the score — a 3 matters three
        times as much as a 1.
      </p>
    </Modal>
  );
}
