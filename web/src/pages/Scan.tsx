import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, num, inr, date } from '../lib/api';
import { ErrorBanner, Loading, useApi } from '../components/ui';

/* ===========================================================================
 * THE SCAN PAGE
 *
 * Where a barcode leads. No login, because a shopkeeper holding a crate has no
 * account — so this page shows only what the label itself already tells you,
 * plus the provenance a produce buyer is entitled to. The server decides that;
 * this just renders it.
 *
 * Handheld scanners type: they send the code followed by Enter, exactly like a
 * keyboard. So the landing page is one autofocused box and nothing else.
 * ======================================================================== */

export function ScanLandingPage() {
  const nav = useNavigate();
  const [code, setCode] = useState('');
  return (
    <div className="scan-page">
      <div className="scan-card">
        <div className="scan-brand">ChotuG</div>
        <h1>Scan a pack</h1>
        <p className="muted small mb">
          Point a scanner at the barcode, or type the code printed under it.
        </p>
        <form onSubmit={(e) => { e.preventDefault(); if (code.trim()) nav(`/p/${code.trim().toUpperCase()}`); }}>
          <input
            autoFocus
            value={code}
            placeholder="PK…"
            onChange={(e) => setCode(e.target.value)}
            style={{ textAlign: 'center', fontSize: 20, letterSpacing: 2, textTransform: 'uppercase' }}
          />
          <button className="btn primary block lg mt" disabled={!code.trim()}>Look it up</button>
        </form>
      </div>
    </div>
  );
}

export function ScanResultPage() {
  const { code } = useParams();
  const nav = useNavigate();
  const { data, loading, error } = useApi<any>(`/public/pack/${code}`, [code]);

  if (loading) {
    return <div className="scan-page"><div className="scan-card"><Loading label="Looking it up…" /></div></div>;
  }

  if (error) {
    return (
      <div className="scan-page">
        <div className="scan-card">
          <div className="scan-brand">ChotuG</div>
          <h1>Not found</h1>
          <p className="muted small">
            No pack with the code <b className="mono">{code}</b>. Check the last few characters —
            the code uses no letter O and no digit 0.
          </p>
          <button className="btn block mt" onClick={() => nav('/p')}>Try another</button>
        </div>
      </div>
    );
  }

  const fresh = data.isFresh;
  return (
    <div className="scan-page">
      <div className="scan-card">
        <div className="scan-brand">{data.packedBy}</div>

        <h1 style={{ marginBottom: 2 }}>{data.product}</h1>
        {data.productHi ? <div className="muted" style={{ marginBottom: 10 }}>{data.productHi}</div> : null}

        <div className="scan-hero">
          <div>
            <span className="lbl">In this pack</span>
            <b>{num(data.quantity, 2)} {data.uom}</b>
          </div>
          <div>
            <span className="lbl">Price</span>
            <b>{inr(data.price)}</b>
          </div>
        </div>

        {data.bestBefore ? (
          <div className={`banner ${fresh === false ? 'danger' : data.daysLeft <= 2 ? 'warn' : 'ok'} mb`}>
            <span>{fresh === false ? '⚠' : data.daysLeft <= 2 ? '⏳' : '✓'}</span>
            <div>
              <b>
                {fresh === false ? 'Past its best-before date'
                  : data.daysLeft === 0 ? 'Best before today'
                  : `Best before ${date(data.bestBefore)}`}
              </b>
              {fresh !== false && data.daysLeft > 0 ? (
                <div className="small">{data.daysLeft} day(s) of shelf life left</div>
              ) : null}
            </div>
          </div>
        ) : null}

        <dl className="kv">
          <dt>Grade</dt><dd>{data.grade ?? '—'}</dd>
          <dt>Packed on</dt><dd>{date(data.packedOn)}</dd>
          {data.harvestedOn ? <><dt>Harvested</dt><dd>{date(data.harvestedOn)}</dd></> : null}
          {data.origin ? (
            <>
              <dt>{data.originKind === 'FARM' ? 'Grown at' : 'Sourced from'}</dt>
              <dd>{data.origin}</dd>
            </>
          ) : null}
          <dt>Lot</dt><dd className="mono">{data.batchRef}</dd>
          <dt>Code</dt><dd className="mono">{data.code}</dd>
        </dl>

        <button className="btn block mt" onClick={() => nav('/p')}>Scan another</button>
      </div>
    </div>
  );
}
