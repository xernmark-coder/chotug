import React from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';

/* ===========================================================================
   CHART KIT

   One place that decides how every chart in the product looks, so a bar on the
   purchase dashboard and a bar on the farm dashboard are the same object.

   Colour follows the job it does, not taste:

   · STATUS   — cyan "accepted", red "rejected", amber "attention". These are
                the app's existing semantics (styles.css) and are reserved:
                they never stand in for "the fourth series".
   · SERIES   — identity, for things that are merely different from each other
                (source types). Fixed order, never cycled, never reassigned by
                rank. Validated with the dataviz palette checker: lightness
                band, chroma floor, colour-blind separation, normal-vision
                separation and contrast all pass on this surface.
   · MAGNITUDE— one hue, for "bigger means more". Ranked bars use a single hue,
                because colouring by rank makes the colour meaningless the
                moment a filter changes the order.
   ======================================================================== */

export const CHART = {
  /** Fixed categorical order. Adding a 5th category means folding into
   *  "Other" or faceting — not inventing a hue. */
  series: ['#4F46E5', '#DB2777', '#9A3412', '#0369A1'],
  magnitude: '#4F46E5',
  status: {
    ok: '#0891B2',
    warn: '#D97706',
    danger: '#DC2626',
    neutral: '#94A3B8',
  },
  grid: '#E8ECF3',
  axis: '#94A3B8',
  ink: '#334155',
  surface: '#FFFFFF',
};

const AXIS = {
  tick: { fontSize: 11, fill: CHART.axis },
  axisLine: false as const,
  tickLine: false as const,
};

/**
 * Indian short form for an axis. Carries a decimal below 10 of each unit,
 * because rounding 1,500 and 2,400 both to "2k" prints the same label twice on
 * one axis and makes the scale unreadable.
 */
export function compact(v: number): string {
  const n = Math.abs(v);
  const f = (x: number, u: string) => `${x < 10 ? x.toFixed(1) : Math.round(x)}${u}`;
  if (n >= 1e7) return f(v / 1e7, 'Cr');
  if (n >= 1e5) return f(v / 1e5, 'L');
  if (n >= 1e3) return f(v / 1e3, 'k');
  return String(Math.round(v));
}

export const inrCompact = (v: number) => `₹${compact(v)}`;

/** Recessive grid: horizontal rules only, so bars are compared not decorated. */
export const Grid = () => (
  <CartesianGrid stroke={CHART.grid} strokeDasharray="0" vertical={false} />
);

/* ------------------------------------------------------------- tooltip --- */

type Fmt = (v: any) => string;

/**
 * One tooltip for everything. Values wear text tokens, and a colour chip
 * carries the series identity — the number itself is never coloured.
 */
export function TipCard({ active, payload, label, labelFmt, valueFmt, unit }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tip">
      {label != null ? <div className="chart-tip-head">{labelFmt ? labelFmt(label) : label}</div> : null}
      {payload.map((p: any) => (
        <div className="chart-tip-row" key={p.dataKey}>
          <i style={{ background: p.color ?? p.fill }} />
          <span>{p.name}</span>
          <b>{valueFmt ? valueFmt(p.value) : p.value}{unit ?? ''}</b>
        </div>
      ))}
    </div>
  );
}

const tip = (labelFmt?: Fmt, valueFmt?: Fmt, unit?: string) => (
  <Tooltip
    cursor={{ fill: 'rgba(79,70,229,.06)' }}
    content={<TipCard labelFmt={labelFmt} valueFmt={valueFmt} unit={unit} />}
  />
);

/* -------------------------------------------------------------- legend --- */

/** Present whenever there is more than one series — identity must never rest
 *  on colour alone. */
export function Legend({ items }: { items: { label: string; color: string }[] }) {
  if (items.length < 2) return null;
  return (
    <div className="chart-legend">
      {items.map((i) => (
        <span key={i.label}><i style={{ background: i.color }} />{i.label}</span>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- frame --- */

export function ChartCard({ title, action, legend, hint, children, empty }: {
  title: string; action?: React.ReactNode;
  legend?: { label: string; color: string }[];
  hint?: string; children: React.ReactNode; empty?: React.ReactNode;
}) {
  return (
    <div className="card">
      <div className="card-head">
        <h2>{title}</h2>
        {legend ? <Legend items={legend} /> : null}
        {action}
      </div>
      <div className="card-body">
        {empty ?? (
          <>
            {children}
            {hint ? <div className="chart-hint">{hint}</div> : null}
          </>
        )}
      </div>
    </div>
  );
}

/* ================================================================ forms == */

/**
 * Change over time, one measure. A single series needs no legend — the card
 * title names it.
 */
export function TrendArea({ data, x, y, height = 230, labelFmt, valueFmt }: {
  data: any[]; x: string; y: string; height?: number; labelFmt?: Fmt; valueFmt?: Fmt;
}) {
  /* A filled slope drawn through two or three points reads as a trend, and
   * there is no trend in three days of data. Below that threshold the honest
   * mark is a bar per day: it says "these are the days we have". */
  if (data.length < 5) {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 6, right: 6, left: -14, bottom: 0 }} barCategoryGap="34%">
          <Grid />
          <XAxis dataKey={x} {...AXIS} tickFormatter={labelFmt} />
          <YAxis {...AXIS} width={62} tickFormatter={valueFmt} />
          {tip(labelFmt, valueFmt)}
          <Bar dataKey={y} name="Value" fill={CHART.magnitude} radius={[4, 4, 0, 0]} maxBarSize={54} />
        </BarChart>
      </ResponsiveContainer>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 6, right: 6, left: -14, bottom: 0 }}>
        <defs>
          <linearGradient id="cg-trend" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={CHART.magnitude} stopOpacity={0.22} />
            <stop offset="100%" stopColor={CHART.magnitude} stopOpacity={0.01} />
          </linearGradient>
        </defs>
        <Grid />
        <XAxis dataKey={x} {...AXIS} tickFormatter={labelFmt} minTickGap={22} />
        <YAxis {...AXIS} width={62} tickFormatter={valueFmt} />
        {tip(labelFmt, valueFmt)}
        <Area type="monotone" dataKey={y} name="Value"
          stroke={CHART.magnitude} strokeWidth={2}
          fill="url(#cg-trend)" dot={false}
          activeDot={{ r: 4, strokeWidth: 2, stroke: CHART.surface }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/**
 * Two parts of a whole, where the parts are states — good and bad. Status
 * colours, a 2px surface gap between the segments, legend always.
 */
export function StackedStatus({ data, x, series, height = 230, labelFmt, valueFmt }: {
  data: any[]; x: string;
  series: { key: string; label: string; color: string }[];
  height?: number; labelFmt?: Fmt; valueFmt?: Fmt;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 6, right: 6, left: -14, bottom: 0 }} barCategoryGap="22%">
        <Grid />
        <XAxis dataKey={x} {...AXIS} tickFormatter={labelFmt} minTickGap={22} />
        <YAxis {...AXIS} width={54} tickFormatter={valueFmt} />
        {tip(labelFmt, valueFmt)}
        {series.map((s, i) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} stackId="a"
            fill={s.color}
            // 2px of surface between stacked segments keeps the boundary
            // readable without a border that thickens the mark.
            stroke={CHART.surface} strokeWidth={i === 0 ? 0 : 2}
            radius={i === series.length - 1 ? [4, 4, 0, 0] : undefined} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * Magnitude across named things — horizontal, because the names are words and
 * words read left to right. One hue: the bar's length is the comparison, its
 * colour is not.
 */
export function RankedBars({ data, label, value, height, valueFmt, color = CHART.magnitude, colors }: {
  data: any[]; label: string; value: string; height?: number;
  valueFmt?: Fmt; color?: string; colors?: string[];
}) {
  const h = height ?? Math.max(150, data.length * 34 + 20);
  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={data} layout="vertical" margin={{ top: 2, right: 56, left: 6, bottom: 2 }}>
        <CartesianGrid stroke={CHART.grid} strokeDasharray="0" horizontal={false} />
        <XAxis type="number" {...AXIS} tickFormatter={valueFmt} hide />
        <YAxis type="category" dataKey={label} {...AXIS} width={116}
          tick={{ fontSize: 12, fill: CHART.ink }} />
        {tip(undefined, valueFmt)}
        <Bar dataKey={value} name="Value" radius={[0, 4, 4, 0]} barSize={16}
          label={{
            position: 'right', fontSize: 11.5, fill: CHART.ink,
            formatter: (v: any) => (valueFmt ? valueFmt(v) : v),
          }}>
          {data.map((_, i) => (
            <Cell key={i} fill={colors ? colors[i % colors.length] : color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/* --------------------------------------------------------------- meter --- */

/** A bar in a table cell: magnitude you can scan down a column. */
export function Meter({ pct, tone = 'ok', label }: {
  pct: number; tone?: 'ok' | 'warn' | 'danger'; label?: string;
}) {
  const w = Math.max(0, Math.min(100, pct));
  return (
    <div className="meter" title={label}>
      <div className="meter-track"><i style={{ width: `${w}%`, background: CHART.status[tone] }} /></div>
      {label ? <span className="meter-label">{label}</span> : null}
    </div>
  );
}

/** Tiny inline trend for a KPI tile — shape only, no axes, no numbers. */
export function Spark({ data, y, tone = CHART.magnitude }: {
  data: any[]; y: string; tone?: string;
}) {
  if (!data?.length) return null;
  return (
    <div className="spark">
      <ResponsiveContainer width="100%" height={30}>
        <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={`sp-${y}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={tone} stopOpacity={0.26} />
              <stop offset="100%" stopColor={tone} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area type="monotone" dataKey={y} stroke={tone} strokeWidth={1.75}
            fill={`url(#sp-${y})`} dot={false} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
