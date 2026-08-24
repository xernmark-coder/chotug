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

  const [tab, setTab] = useState<'tree' | 'codes'>('tree');
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
        <div className="cat-row" style={{ paddingLeft: 14 + depth * 26 }}>
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
              <div key={p.id} className="prod-row" style={{ paddingLeft: 52 + depth * 26 }}>
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
      </div>

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
      ) : (
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
      )}

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
      <div className="grid c3">
        <Field label="Keeps for (days)"><input type="number" value={shelf}
          onChange={(e) => setShelf(e.target.value)} placeholder="10" /></Field>
        <Field label="Buy again below"><input type="number" value={reorder}
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
