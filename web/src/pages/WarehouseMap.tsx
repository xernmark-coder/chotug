import React, { useMemo, useState } from 'react';
import { api, useAuth, num } from '../lib/api';
import { Chip, Empty, ErrorBanner, Field, Kpi, Layout, Loading, Modal, useApi, useToast } from '../components/ui';
import { Icon } from '../components/icons';
import { QrCode } from '../components/qr';

/* ===========================================================================
 * THE WAREHOUSE MAP — floor · section · rack · shelf
 *
 * The point of laying this out is not the diagram. It is that every level gets
 * a printed QR, and from then on "where is it" and "what is on this shelf" are
 * the same question answered by pointing a phone at a sticker.
 *
 * Building it has to be fast or it never gets built: racks and shelves are
 * created in runs ("six shelves on this rack"), because nobody is going to add
 * ninety shelves one at a time.
 * ======================================================================== */

export function WarehouseMapPage() {
  const { can, warehouseId } = useAuth();
  const toast = useToast();
  const [wh, setWh] = useState(warehouseId ?? '');
  const { data: warehouses } = useApi<any[]>('/masters/warehouses');
  const layout = useApi<any>(`/warehouse/layout${wh ? `?warehouseId=${wh}` : ''}`, [wh]);

  const [adding, setAdding] = useState<any>(null);
  const [printing, setPrinting] = useState<any[] | null>(null);
  const [openFloor, setOpenFloor] = useState<Record<string, boolean>>({});
  /* A map is a tree, not a list, so the filter prunes rather than narrowing a
   * table: a branch survives if it matches, or if anything under it does.
   * Typing "R-04" on a four-floor warehouse should leave one rack on screen. */
  const [q, setQ] = useState('');
  const [only, setOnly] = useState<'' | 'full' | 'empty'>('');

  const canManage = can('master.location.manage');
  const d = layout.data;

  /* Sections with no floor are the ones that existed before floors did. They
     still work; they just hang off "not on a floor yet" until somebody says
     where they are. */
  const grouped = useMemo(() => {
    if (!d) return [];
    const byFloor = new Map<string, any>();
    for (const f of d.floors) byFloor.set(f.id, { floor: f, sections: [] });
    byFloor.set('none', { floor: null, sections: [] });
    for (const s of d.sections) {
      (byFloor.get(s.floor_id ?? 'none') ?? byFloor.get('none')).sections.push({
        ...s,
        racks: d.racks.filter((r: any) => r.zone_id === s.id).map((r: any) => ({
          ...r, shelves: d.shelves.filter((b: any) => b.rack_id === r.id),
        })),
      });
    }
    const needle = q.trim().toLowerCase();
    const hit = (...bits: any[]) =>
      !needle || bits.filter(Boolean).join(' ').toLowerCase().includes(needle);

    const out = [...byFloor.values()].filter((g) => g.floor || g.sections.length);
    if (!needle && !only) return out;

    return out
      .map((g) => {
        const floorHit = hit(g.floor?.name, g.floor?.qr_code);
        const sections = g.sections
          .map((sec: any) => {
            const secHit = floorHit || hit(sec.name, sec.code, sec.qr_code);
            const racks = sec.racks
              .map((r: any) => {
                const rackHit = secHit || hit(r.code, r.qr_code);
                const shelves = r.shelves.filter((b: any) =>
                  (rackHit || hit(b.code, b.qr_code))
                  && (only === '' ? true
                    : only === 'full' ? Number(b.packs) > 0 : Number(b.packs) === 0));
                return { ...r, shelves };
              })
              .filter((r: any) => r.shelves.length || (hit(r.code, r.qr_code) && !only));
            return { ...sec, racks };
          })
          .filter((sec: any) => sec.racks.length);
        return { ...g, sections };
      })
      .filter((g) => g.sections.length);
  }, [d, q, only]);

  if (layout.loading) return <Layout title="Warehouse map"><Loading /></Layout>;

  const allShelves = d?.shelves ?? [];
  const used = allShelves.filter((s: any) => Number(s.packs) > 0);

  return (
    <Layout
      title="Warehouse map"
      subtitle="Floor, section, rack, shelf — each with its own scannable label"
      actions={
        <div className="btn-row">
          <select className="branch-select" value={wh} onChange={(e) => setWh(e.target.value)}>
            <option value="">All warehouses</option>
            {(warehouses ?? []).map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <button className="btn sm" onClick={() => setPrinting(allShelves)}>
            <Icon name="inbox" size={15} /> Print all shelf labels
          </button>
          {canManage ? (
            <button className="btn sm primary" onClick={() => setAdding({ level: 'FLOOR' })}>
              Add a floor
            </button>
          ) : null}
        </div>
      }
    >
      <ErrorBanner error={layout.error} />

      <div className="grid c4 mb">
        <Kpi label="Floors" value={d?.floors.length ?? 0} />
        <Kpi label="Sections" value={d?.sections.length ?? 0} />
        <Kpi label="Racks" value={d?.racks.length ?? 0} />
        <Kpi label="Shelves in use" value={`${used.length} / ${allShelves.length}`}
          foot={`${num(allShelves.reduce((a: number, s: any) => a + Number(s.packs), 0), 0)} boxes stored`} />
      </div>

      <div className="search-bar">
        <select value={only} onChange={(e) => setOnly(e.target.value as any)}>
          <option value="">Every shelf</option>
          <option value="full">Holding something</option>
          <option value="empty">Empty</option>
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search a floor, section, rack or shelf code" />
        {q || only ? (
          <button className="btn sm" onClick={() => { setQ(''); setOnly(''); }}>Clear</button>
        ) : null}
      </div>
      <div className="filter-total">
        <span>
          <b>{grouped.reduce((a, g) => a + g.sections.reduce((b: number, s2: any) =>
            b + s2.racks.reduce((c: number, r: any) => c + r.shelves.length, 0), 0), 0)}</b> shelves
          {q || only ? <span className="muted"> of {allShelves.length}</span> : null}
        </span>
        <span className="row" style={{ gap: 20 }}>
          <span className="ft-num"><em>Boxes</em><b>{num(grouped.reduce((a, g) =>
            a + g.sections.reduce((b: number, s2: any) => b + s2.racks.reduce((c: number, r: any) =>
              c + r.shelves.reduce((e: number, sh: any) => e + Number(sh.packs || 0), 0), 0), 0), 0), 0)}</b></span>
          <span className="ft-num"><em>Weight kg</em><b>{num(grouped.reduce((a, g) =>
            a + g.sections.reduce((b: number, s2: any) => b + s2.racks.reduce((c: number, r: any) =>
              c + r.shelves.reduce((e: number, sh: any) => e + Number(sh.weight_kg || 0), 0), 0), 0), 0), 1)}</b></span>
        </span>
      </div>

      {!grouped.length && (q || only) ? (
        <Empty icon="🗺️" title="Nothing matches that"
          hint="Clear the search to see the whole map." />
      ) : null}

      {grouped.map((g) => {
        const key = g.floor?.id ?? 'none';
        const open = openFloor[key] ?? true;
        return (
          <div className="card mb" key={key}>
            <div className="card-head">
              <h2>
                <button className="btn ghost sm" onClick={() => setOpenFloor((s) => ({ ...s, [key]: !open }))}>
                  {open ? '−' : '+'}
                </button>{' '}
                {g.floor ? g.floor.name : 'Not on a floor yet'}
                {g.floor ? <span className="small muted"> · {g.floor.warehouse_name}</span> : null}
              </h2>
              <div className="btn-row">
                {g.floor ? <Chip tone="neutral">{g.floor.qr_code}</Chip> : null}
                {canManage && g.floor ? (
                  <button className="btn sm" onClick={() => setAdding({ level: 'SECTION', parent: g.floor })}>
                    Add a section
                  </button>
                ) : null}
              </div>
            </div>
            {open ? (
              <div className="card-body">
                {!g.sections.length ? (
                  <Empty title="No sections on this floor yet"
                    hint="A section is a cold room, a ripening chamber, an ambient hall." />
                ) : null}
                {g.sections.map((s: any) => (
                  <div className="loc-section" key={s.id}>
                    <div className="loc-head">
                      <div>
                        <b>{s.name}</b> <span className="small muted mono">{s.code}</span>
                        <div className="small muted">
                          {s.racks.length} racks ·{' '}
                          {s.racks.reduce((a: number, r: any) => a + r.shelves.length, 0)} shelves
                        </div>
                      </div>
                      <div className="btn-row">
                        <Chip tone="neutral">{s.qr_code}</Chip>
                        {canManage ? (
                          <button className="btn sm" onClick={() => setAdding({ level: 'RACK', parent: s })}>
                            Add racks
                          </button>
                        ) : null}
                      </div>
                    </div>
                    {s.racks.map((r: any) => (
                      <div className="loc-rack" key={r.id}>
                        <div className="loc-rack-name">
                          <b>{r.code}</b>
                          <div className="small muted mono">{r.qr_code}</div>
                          {canManage ? (
                            <button className="btn sm ghost"
                              onClick={() => setAdding({ level: 'SHELF', parent: r })}>+ shelves</button>
                          ) : null}
                        </div>
                        <div className="shelf-row">
                          {r.shelves.map((b: any) => (
                            <button key={b.id} className={`shelf ${Number(b.packs) ? 'full' : ''}`}
                              onClick={() => setPrinting([b])}
                              title={`${b.qr_code} — click to print this label`}>
                              <b>{b.code}</b>
                              <span className="small">
                                {Number(b.packs)
                                  ? `${b.packs} · ${num(b.weight_kg, 0)} kg`
                                  : 'empty'}
                              </span>
                            </button>
                          ))}
                          {!r.shelves.length ? <span className="small muted">no shelves yet</span> : null}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}

      {adding ? (
        <AddLocationModal spec={adding} warehouseId={wh || (warehouses ?? [])[0]?.id}
          onClose={() => setAdding(null)}
          onDone={(m) => { setAdding(null); layout.reload(); toast(m, 'ok'); }} />
      ) : null}
      {printing ? (
        <LocationLabels shelves={printing} onClose={() => setPrinting(null)} />
      ) : null}
    </Layout>
  );
}

const LEVELS: Record<string, { title: string; path: string; hint: string; bulk: boolean }> = {
  FLOOR:   { title: 'Add a floor', path: '/warehouse/floors', bulk: false,
             hint: 'Ground floor, first floor, mezzanine.' },
  SECTION: { title: 'Add a section', path: '/warehouse/sections', bulk: false,
             hint: 'A cold room, a ripening chamber, the ambient hall.' },
  RACK:    { title: 'Add racks', path: '/warehouse/racks', bulk: true,
             hint: 'Racks get numbered from your code: A becomes A1, A2, A3…' },
  SHELF:   { title: 'Add shelves', path: '/warehouse/shelves', bulk: true,
             hint: 'Shelves get numbered from your code: S becomes S-1, S-2, S-3…' },
};

function AddLocationModal({ spec, warehouseId, onClose, onDone }: {
  spec: any; warehouseId?: string; onClose: () => void; onDone: (m: string) => void;
}) {
  const L = LEVELS[spec.level];
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [count, setCount] = useState('1');
  const [capacity, setCapacity] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<any>(null);

  return (
    <Modal
      title={L.title}
      onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !code.trim()}
          onClick={async () => {
            setBusy(true); setError(null);
            try {
              const r = await api.post<any>(L.path, {
                warehouseId,
                parentId: spec.parent?.id,
                code: code.trim(),
                name: name.trim() || undefined,
                count: L.bulk ? Number(count) || 1 : 1,
                capacityKg: capacity ? Number(capacity) : undefined,
              });
              onDone(r.made ? `${r.made} added.` : `${r.name ?? r.code} added.`);
            } catch (e: any) { setError(e); } finally { setBusy(false); }
          }}>Add</button>
      </>}
    >
      <ErrorBanner error={error} />
      {spec.parent ? (
        <p className="small muted mb">Inside <b>{spec.parent.name ?? spec.parent.code}</b>.</p>
      ) : null}
      <div className="grid c2">
        <Field label="Short code" hint={L.hint}>
          <input value={code} autoFocus onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder={spec.level === 'SHELF' ? 'S' : spec.level === 'RACK' ? 'A' : 'COLD1'} />
        </Field>
        {L.bulk ? (
          <Field label="How many">
            <input type="number" min={1} max={60} value={count}
              onChange={(e) => setCount(e.target.value)} />
          </Field>
        ) : (
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder={spec.level === 'FLOOR' ? 'Ground floor' : 'Cold room 1'} />
          </Field>
        )}
      </div>
      {spec.level === 'SHELF' ? (
        <Field label="How much fits on one shelf (kg)" hint="Optional — used to warn when a shelf is over-filled.">
          <input type="number" value={capacity} onChange={(e) => setCapacity(e.target.value)} />
        </Field>
      ) : null}
      <div className="banner info">
        <span><Icon name="info" size={16} /></span>
        <div className="small">
          Each one gets its own QR the moment it is created. Print the labels and
          stick them on — from then on the shelf answers for itself.
        </div>
      </div>
    </Modal>
  );
}

/** The label sheet. A browser print of a plain grid, exactly like pack labels. */
function LocationLabels({ shelves, onClose }: { shelves: any[]; onClose: () => void }) {
  return (
    <Modal
      title={`${shelves.length} shelf label(s)`}
      onClose={onClose}
      wide
      footer={<>
        <button className="btn" onClick={onClose}>Close</button>
        <button className="btn primary" onClick={() => window.print()}>
          <Icon name="inbox" size={15} /> Print
        </button>
      </>}
    >
      <p className="small muted mb no-print">
        Stick one on each shelf. Anybody scanning it — the audit team, a picker,
        the packer putting a box away — gets the same answer about what is there.
      </p>
      <div className="label-sheet">
        {shelves.map((s) => (
          <div className="loc-label" key={s.id}>
            <QrCode value={s.qr_code} size={104} />
            <div className="ll-text">
              <b>{s.code}</b>
              <span className="small">{s.section_name}</span>
              <span className="small muted">rack {s.rack_code}</span>
              <span className="mono small">{s.qr_code}</span>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
