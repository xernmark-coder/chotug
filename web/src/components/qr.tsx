import React from 'react';

/* ===========================================================================
   QR — drawn, not fetched
 *
 * The audit team scans shelves with the phone in their pocket. A phone camera
 * reads QR; it does not reliably read the Code 128 we print on pack labels. So
 * this is a real QR encoder, for the same reason barcode.tsx exists: a label
 * that only prints when some CDN is reachable is not a label, and a warehouse
 * basement is exactly where the signal dies.
 *
 * Deliberately narrow: **version 1 (21×21), EC level M, alphanumeric mode**.
 * That is 20 characters, and every code this system prints — SH-D63H9A,
 * FL-9WQT8N — is ten. Supporting versions we will never emit would be more
 * code to be wrong in. Anything that does not fit falls back to printing the
 * text, which is still readable by a human and still typeable into the app.
 * ======================================================================== */

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

/* Version 1-M: 26 codewords total, 16 data, 10 error correction. */
const DATA_CODEWORDS = 16;
const EC_CODEWORDS = 10;
const SIZE = 21;

/* ------------------------------------------------------------- GF(256) --- */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;           // the QR field polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Generator polynomial for `n` error-correction codewords. */
function generator(n: number) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

function reedSolomon(data: number[], n: number) {
  const g = generator(n);
  const out = new Array(n).fill(0);
  for (const byte of data) {
    const factor = byte ^ out[0];
    out.shift();
    out.push(0);
    for (let i = 0; i < n; i++) out[i] ^= mul(g[i + 1], factor);
  }
  return out;
}

/* -------------------------------------------------------------- encode --- */
function encode(text: string): number[] | null {
  const s = text.toUpperCase();
  for (const ch of s) if (!ALNUM.includes(ch)) return null;
  if (s.length > 20) return null;

  const bits: number[] = [];
  const push = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  push(0b0010, 4);                        // alphanumeric mode
  push(s.length, 9);                      // character count, 9 bits at version 1
  for (let i = 0; i + 1 < s.length; i += 2) {
    push(ALNUM.indexOf(s[i]) * 45 + ALNUM.indexOf(s[i + 1]), 11);
  }
  if (s.length % 2) push(ALNUM.indexOf(s[s.length - 1]), 6);

  const capacity = DATA_CODEWORDS * 8;
  for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0);   // terminator
  while (bits.length % 8) bits.push(0);

  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  }
  /* The spec's alternating pad bytes, not zeroes — zero padding decodes on
   * some readers and not others. */
  const PADS = [0xec, 0x11];
  while (data.length < DATA_CODEWORDS) data.push(PADS[(data.length - bits.length / 8) % 2]);

  return [...data, ...reedSolomon(data, EC_CODEWORDS)];
}

/* ------------------------------------------------------------- matrix ---- */
function build(codewords: number[]) {
  const m: (0 | 1 | null)[][] = Array.from({ length: SIZE }, () => new Array(SIZE).fill(null));
  const reserved = Array.from({ length: SIZE }, () => new Array(SIZE).fill(false));

  const setF = (r: number, c: number, v: 0 | 1) => {
    if (r < 0 || c < 0 || r >= SIZE || c >= SIZE) return;
    m[r][c] = v;
    reserved[r][c] = true;
  };

  // Finder patterns and their separators.
  for (const [br, bc] of [[0, 0], [0, SIZE - 7], [SIZE - 7, 0]] as const) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const edge = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        setF(br + r, bc + c, inside && (edge || core) ? 1 : 0);
      }
    }
  }

  // Timing patterns.
  for (let i = 8; i < SIZE - 8; i++) {
    const v: 0 | 1 = i % 2 === 0 ? 1 : 0;
    setF(6, i, v);
    setF(i, 6, v);
  }

  // The dark module, and the format-information areas kept clear for now.
  setF(SIZE - 8, 8, 1);
  for (let i = 0; i <= 8; i++) {
    if (!reserved[8][i]) { m[8][i] = 0; reserved[8][i] = true; }
    if (!reserved[i][8]) { m[i][8] = 0; reserved[i][8] = true; }
  }
  for (let i = 0; i < 8; i++) {
    if (!reserved[8][SIZE - 1 - i]) { m[8][SIZE - 1 - i] = 0; reserved[8][SIZE - 1 - i] = true; }
    if (!reserved[SIZE - 1 - i][8]) { m[SIZE - 1 - i][8] = 0; reserved[SIZE - 1 - i][8] = true; }
  }

  // Data, zigzagging up and down two columns at a time from the bottom right.
  const bits: number[] = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);

  let bit = 0;
  let upward = true;
  for (let right = SIZE - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;                       // skip the timing column
    for (let step = 0; step < SIZE; step++) {
      const row = upward ? SIZE - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (reserved[row][col]) continue;
        m[row][col] = (bits[bit++] ?? 0) as 0 | 1;
      }
    }
    upward = !upward;
  }

  return { m, reserved };
}

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** Runs of five or more, and 2×2 blocks — the two penalties that matter most. */
function penalty(g: number[][]) {
  let p = 0;
  for (let i = 0; i < SIZE; i++) {
    for (const line of [g[i], g.map((row) => row[i])]) {
      let run = 1;
      for (let j = 1; j < SIZE; j++) {
        if (line[j] === line[j - 1]) run++;
        else { if (run >= 5) p += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) p += 3 + (run - 5);
    }
  }
  for (let r = 0; r < SIZE - 1; r++) {
    for (let c = 0; c < SIZE - 1; c++) {
      const v = g[r][c];
      if (v === g[r][c + 1] && v === g[r + 1][c] && v === g[r + 1][c + 1]) p += 3;
    }
  }
  return p;
}

/** BCH(15,5) format information, EC level M, XORed with the spec's mask. */
function formatBits(mask: number) {
  const data = (0b00 << 3) | mask;                    // 00 = EC level M
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= 0b10100110111 << (i - 10);
  return ((data << 10) | rem) ^ 0b101010000010010;
}

function render(text: string): number[][] | null {
  const codewords = encode(text);
  if (!codewords) return null;
  const { m, reserved } = build(codewords);

  let best: number[][] | null = null;
  let bestMask = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const g = m.map((row, r) => row.map((v, c) =>
      (reserved[r][c] ? (v ?? 0) : ((v ?? 0) ^ (MASKS[mask](r, c) ? 1 : 0)))));
    const score = penalty(g);
    if (score < bestScore) { bestScore = score; best = g; bestMask = mask; }
  }
  if (!best) return null;

  /* The 15 format bits are written twice, and the two copies do NOT run in the
   * same direction — which is exactly the sort of thing to get wrong by
   * symmetry. The mapping below is the spec's, bit 0 first:
   *
   *   down column 8 : bits 0-5 → rows 0-5, bits 6-7 → rows 7-8,
   *                   bits 8-14 → rows 14-20
   *   along row 8   : bits 0-7 → cols 20-13, bit 8 → col 7,
   *                   bits 9-14 → cols 5-0
   */
  const fmt = formatBits(bestMask);
  for (let i = 0; i < 15; i++) {
    const bit = (fmt >> i) & 1;
    if (i < 6) best[i][8] = bit;
    else if (i < 8) best[i + 1][8] = bit;
    else best[SIZE - 15 + i][8] = bit;

    if (i < 8) best[8][SIZE - 1 - i] = bit;
    else if (i === 8) best[8][7] = bit;
    else best[8][14 - i] = bit;
  }
  best[SIZE - 8][8] = 1;                              // the dark module survives masking

  return best;
}

export function QrCode({ value, size = 96, className }: {
  value: string; size?: number; className?: string;
}) {
  const grid = React.useMemo(() => render(value), [value]);

  if (!grid) {
    /* Still useful: a human can read it and type it in. Silently printing
       nothing would send somebody to a shelf with a blank sticker. */
    return (
      <div className={className} style={{
        width: size, height: size, display: 'grid', placeItems: 'center',
        border: '1px solid currentColor', fontSize: 10, fontFamily: 'monospace',
        padding: 4, textAlign: 'center', wordBreak: 'break-all',
      }}>{value}</div>
    );
  }

  const quiet = 2;
  const span = SIZE + quiet * 2;
  return (
    <svg className={className} width={size} height={size}
      viewBox={`0 0 ${span} ${span}`} shapeRendering="crispEdges"
      role="img" aria-label={`QR code ${value}`}>
      <rect width={span} height={span} fill="#fff" />
      {grid.flatMap((row, r) => row.map((v, c) => (v
        ? <rect key={`${r}-${c}`} x={c + quiet} y={r + quiet} width={1} height={1} fill="#000" />
        : null)))}
    </svg>
  );
}
