import React from 'react';

/* ===========================================================================
   CODE 128-B — drawn, not fetched

   Every off-the-shelf barcode library is either a build dependency or a call
   to some image service, and a warehouse label that only prints when a CDN is
   reachable is not a label. Code 128-B is ~40 lines: encode the characters,
   add the modulo-103 check symbol, emit bar widths. It covers the full ASCII
   range we use and is what every retail scanner reads first.
   ======================================================================== */

/**
 * Bar/space widths for values 0–106. Six digits each (the STOP symbol has
 * seven), widths 1–4, starting with a bar.
 *
 * All 107 entries, and the count matters: an earlier version of this table
 * stopped at 101, so START-B (104) and STOP (106) indexed past the end, fell
 * back to entry 0, and produced a barcode whose payload was correct but whose
 * framing symbols were not. It printed, it looked like a barcode, and no
 * scanner would have read it.
 */
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
if (PATTERNS.length !== 107) throw new Error('Code128 table must hold 107 symbols');

const START_B = 104;
const STOP = 106;

function encode(value: string): number[] {
  const codes: number[] = [START_B];
  for (const ch of value) {
    const c = ch.charCodeAt(0);
    // 128-B covers ASCII 32..127, mapped to values 0..95.
    codes.push(c >= 32 && c <= 127 ? c - 32 : 0);
  }
  let sum = START_B;
  for (let i = 1; i < codes.length; i++) sum += codes[i] * i;
  codes.push(sum % 103);
  codes.push(STOP);
  return codes;
}

/**
 * A scannable Code 128-B barcode as inline SVG. `height` is the bar height;
 * the code itself is printed underneath so a failed scan can still be typed.
 */
export function Barcode({ value, height = 46, module = 2, showText = true }: {
  value: string; height?: number; module?: number; showText?: boolean;
}) {
  const codes = encode(value);
  const bars: { x: number; w: number }[] = [];
  let x = 0;
  for (const code of codes) {
    const pattern = PATTERNS[code] ?? PATTERNS[0];
    for (let i = 0; i < pattern.length; i++) {
      const w = Number(pattern[i]) * module;
      if (i % 2 === 0) bars.push({ x, w });   // even index = bar, odd = space
      x += w;
    }
  }
  const quiet = 10 * module;
  const width = x + quiet * 2;
  const textH = showText ? 15 : 0;

  return (
    <svg
      viewBox={`0 0 ${width} ${height + textH}`}
      width="100%"
      style={{ display: 'block', maxWidth: width }}
      role="img"
      aria-label={`Barcode ${value}`}
      shapeRendering="crispEdges"
    >
      <rect x={0} y={0} width={width} height={height + textH} fill="#fff" />
      {bars.map((b, i) => (
        <rect key={i} x={b.x + quiet} y={0} width={b.w} height={height} fill="#000" />
      ))}
      {showText ? (
        <text
          x={width / 2} y={height + 12}
          textAnchor="middle"
          fontFamily="ui-monospace, Menlo, Consolas, monospace"
          fontSize={12} letterSpacing={1.5} fill="#000"
        >
          {value}
        </text>
      ) : null}
    </svg>
  );
}
