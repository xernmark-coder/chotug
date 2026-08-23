import React from 'react';

/* ===========================================================================
   ICONS

   Emoji in a navigation rail are somebody else's design: they change shape
   between Windows, Android and a Mac, several render in full colour next to
   monochrome text, and a few (🧾 vs 📝, 🧺 twice) were doing duty for two
   different things at once.

   These are one stroked set instead — 24×24, 1.6 stroke, currentColor, so the
   rail inherits its own palette and the active row's white. Each is drawn from
   the thing it names rather than a generic glyph: put-away is a box going onto
   a shelf, weighing is a balance, approvals is a document with a tick.
   ======================================================================== */

const P: Record<string, React.ReactNode> = {
  /* --- work ------------------------------------------------------------- */
  target: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3.4" /><path d="M12 2v2.4M12 19.6V22M2 12h2.4M19.6 12H22" /></>,
  dashboard: <><rect x="3" y="3" width="7.5" height="8.5" rx="1.4" /><rect x="13.5" y="3" width="7.5" height="5" rx="1.4" /><rect x="13.5" y="11" width="7.5" height="10" rx="1.4" /><rect x="3" y="14.5" width="7.5" height="6.5" rx="1.4" /></>,
  bell: <><path d="M18 9a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16S18 14 18 9Z" /><path d="M10.4 19a2 2 0 0 0 3.2 0" /></>,

  /* --- plan & buy ------------------------------------------------------- */
  bolt: <path d="M13.2 2 4.5 13.4h6.1L10.2 22l8.7-11.4h-6.1L13.2 2Z" />,
  calculator: <><rect x="4" y="2.5" width="16" height="19" rx="2.2" /><path d="M8 7h8" /><path d="M8.5 12h.01M12 12h.01M15.5 12h.01M8.5 16.5h.01M12 16.5h.01M15.5 16.5h.01" /></>,
  clipboard: <><rect x="4.5" y="4" width="15" height="17.5" rx="2" /><path d="M9 4V3a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 3v1" /><path d="M8.5 11h7M8.5 15h4.5" /></>,
  box: <><path d="M3.5 7.6 12 3l8.5 4.6v8.8L12 21l-8.5-4.6V7.6Z" /><path d="m3.5 7.6 8.5 4.7 8.5-4.7M12 12.3V21" /></>,
  checkDoc: <><path d="M6 2.5h8.5L19 7v14.5H6z" /><path d="M14 2.5V7h5" /><path d="m9 14 2.2 2.2L15.5 12" /></>,

  /* --- farm ------------------------------------------------------------- */
  sun: <><circle cx="12" cy="12" r="4.2" /><path d="M12 2v2.6M12 19.4V22M4.2 4.2l1.9 1.9M17.9 17.9l1.9 1.9M2 12h2.6M19.4 12H22M4.2 19.8l1.9-1.9M17.9 6.1l1.9-1.9" /></>,
  home: <><path d="M3.5 10.5 12 3.5l8.5 7" /><path d="M5.5 9.7V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.7" /><path d="M9.8 21v-6h4.4v6" /></>,
  sprout: <><path d="M12 21v-8" /><path d="M12 13C12 9.5 9 7 5.5 7c0 3.5 3 6 6.5 6Z" /><path d="M12 13c0-3 2.6-5.4 5.6-5.4 0 3-2.6 5.4-5.6 5.4Z" /></>,
  basket: <><path d="M3 9.5h18l-1.6 9.1a2 2 0 0 1-2 1.6H6.6a2 2 0 0 1-2-1.6L3 9.5Z" /><path d="m8 9.5 2.4-6M16 9.5l-2.4-6" /><path d="M9.6 13.4v3M14.4 13.4v3" /></>,
  tractor: <><circle cx="7" cy="17" r="3.6" /><circle cx="18" cy="18" r="2.6" /><path d="M7 13.4V6.5h4.6l2.2 5.4H18v3.6" /><path d="M3.6 10.5H7" /></>,
  receipt: <><path d="M5.5 2.5h13v19l-2.2-1.6-2.2 1.6-2.1-1.6-2.2 1.6-2.2-1.6-2.1 1.6v-19Z" /><path d="M9 8h6M9 12h6" /></>,
  compass: <><circle cx="12" cy="12" r="9" /><path d="m15.2 8.8-1.9 4.4-4.5 1.9 1.9-4.4 4.5-1.9Z" /></>,
  pin: <><path d="M12 21.5s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11Z" /><circle cx="12" cy="10.4" r="2.7" /></>,

  /* --- produce ----------------------------------------------------------
     The staff were described as non-technical and asked to recognise a
     product by sight. Same stroked 24×24 language as the rest of the set, so
     a mango next to a nav label still looks like it belongs to the app —
     drawn from the fruit's actual silhouette rather than a generic circle. */
  mango: <><path d="M15.6 4.6c-2.6-1.1-6.2-.3-8.4 2.3s-2.7 6.6-.7 9.2 5.9 3 8.9 1 4.6-6 3.3-9.1a5.4 5.4 0 0 0-3.1-3.4Z" /><path d="M14.4 5.2c.6-1.4 2-2.4 3.5-2.5" /></>,
  apple: <><path d="M12 7.6c-1.1-1-3.2-1.6-4.9-.6C5 8.2 4.3 11.4 5.4 14.3c1 2.7 3 5 4.7 5 .9 0 1.3-.4 1.9-.4s1 .4 1.9.4c1.7 0 3.7-2.3 4.7-5 1.1-2.9.4-6.1-1.7-7.3-1.7-1-3.8-.4-4.9.6Z" /><path d="M12 7.6V4.8" /><path d="M12 5c1.2-.3 2.2-1.2 2.5-2.5-1.3.1-2.3.9-2.5 2.5Z" /></>,
  banana: <><path d="M4.5 8.5c0 6 4.6 10.5 10.4 10.5 2.6 0 4.6-1.1 4.6-2.4 0-.8-.7-1.2-1.5-1.2-3.9 0-9.4-2.7-9.4-8.6 0-.9-.5-1.6-1.4-1.6-1 0-1.7.6-2.7 3.3Z" /><path d="M7.2 5.2 6.5 3.4" /></>,
  tomato: <><circle cx="12" cy="14" r="6.6" /><path d="M12 7.4V5.2" /><path d="M8.4 6.1c1 .6 2.3.9 3.6.9s2.6-.3 3.6-.9c-.5 1.1-.6 1.9-.6 1.9-.9-.4-1.9-.6-3-.6s-2.1.2-3 .6c0 0-.1-.8-.6-1.9Z" /></>,
  onion: <><path d="M12 20.5c-3.6 0-6.4-2.4-6.4-5.6C5.6 11 9 8.4 12 5.4c3 3 6.4 5.6 6.4 9.5 0 3.2-2.8 5.6-6.4 5.6Z" /><path d="M12 20.4V8.6M9 19.8c-.7-3 0-6.4 1.4-9M15 19.8c.7-3 0-6.4-1.4-9" /><path d="M12 5.4 10.6 3M12 5.4 13.4 3" /></>,
  potato: <><path d="M17.8 7.4c1.9 2.4 1.5 6.2-1 8.7s-6.6 3.1-9 1.2-2.4-5.9 0-8.6 8-3.8 10-1.3Z" /><path d="M9.6 10.6h.01M13.4 9.4h.01M11.4 14h.01M15 13.2h.01" /></>,
  leafy: <><path d="M12 21V11" /><path d="M12 11C12 7 8.6 4.2 4.5 4.2c0 4 3.4 6.8 7.5 6.8Z" /><path d="M12 11c0-3.4 3-6 6.6-6 0 3.4-3 6-6.6 6Z" /><path d="M6.5 21h11" /></>,
  cauliflower: <><path d="M6.8 11a2.8 2.8 0 1 1 1.7-5 3.2 3.2 0 0 1 6 0 2.8 2.8 0 1 1 1.7 5Z" /><path d="M7 11c0 3.2 2.2 5.6 5 5.6s5-2.4 5-5.6" /><path d="M9.4 16.2 8 21M14.6 16.2 16 21" /></>,
  cucumber: <><path d="M18.6 5.4c2 2-.4 7-4.2 10.8S6 21.4 4 19.4s.4-7 4.2-10.8S16.6 3.4 18.6 5.4Z" /><path d="M9.4 11.2h.01M12.2 9.6h.01M11 13.8h.01M14 12.4h.01" /></>,
  capsicum: <><path d="M12 8.2c-3.3 0-5.6 2.4-5.6 5.6 0 3.6 2.2 6.6 4 6.6.8 0 1.1-.5 1.6-.5s.8.5 1.6.5c1.8 0 4-3 4-6.6 0-3.2-2.3-5.6-5.6-5.6Z" /><path d="M12 8.2V5.6" /><path d="M9.6 4.4c1.2.8 3.6.8 4.8 0" /></>,
  grapes: <><circle cx="12" cy="8.4" r="2" /><circle cx="8.6" cy="12" r="2" /><circle cx="15.4" cy="12" r="2" /><circle cx="12" cy="15.4" r="2" /><circle cx="12" cy="12" r="2" /><path d="M12 6.4V3.6" /><path d="M12 3.6c1.5-.2 2.6-1 3-2.1" /></>,
  produce: <><circle cx="12" cy="13.4" r="6.2" /><path d="M12 7.2V4.4" /><path d="M12 4.6c1.4-.3 2.5-1.3 2.8-2.7-1.5.1-2.6 1.1-2.8 2.7Z" /></>,

  /* --- receive ---------------------------------------------------------- */
  truckIn: <><path d="M2.5 6.5h10.5v10H2.5z" /><path d="M13 9.5h4l3 3.2v3.8h-7" /><circle cx="6.5" cy="18.5" r="2" /><circle cx="16.5" cy="18.5" r="2" /></>,
  route: <><circle cx="5.5" cy="5.5" r="2.5" /><circle cx="18.5" cy="18.5" r="2.5" /><path d="M8 5.5h6.5a4 4 0 0 1 0 8h-5a4 4 0 0 0 0 8H16" /></>,
  scale: <><path d="M12 4.5V21" /><path d="M7 21h10" /><path d="M4.5 7.5h15" /><path d="M7.6 7.7 4.5 14h6.2L7.6 7.7Z" /><path d="M16.4 7.7 13.3 14h6.2l-3.1-6.3Z" /></>,
  gate: <><path d="M3 21V6.5A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5V21" /><path d="M3 11h18M8 4v17M16 4v17" /></>,
  inbox: <><path d="M3.5 13.5 6 5.2A2 2 0 0 1 7.9 3.8h8.2A2 2 0 0 1 18 5.2l2.5 8.3" /><path d="M3.5 13.5h4.2l1.2 2.6h6.2l1.2-2.6h4.2v5.2a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5v-5.2Z" /></>,
  shelf: <><rect x="3.5" y="3.5" width="17" height="7" rx="1.4" /><rect x="3.5" y="13.5" width="17" height="7" rx="1.4" /><path d="M7.5 3.5v7M7.5 13.5v7" /></>,
  crates: <><rect x="2.5" y="9" width="9" height="11.5" rx="1.3" /><rect x="12.5" y="9" width="9" height="11.5" rx="1.3" /><rect x="7.5" y="2.5" width="9" height="6" rx="1.3" /></>,
  tag: <><path d="M11 2.5H20a1.5 1.5 0 0 1 1.5 1.5v9L12 22.5 1.5 12 11 2.5Z" /><circle cx="16.8" cy="7.2" r="1.5" /></>,
  coins: <><ellipse cx="12" cy="6.2" rx="7.5" ry="3.2" /><path d="M4.5 6.2v5.6c0 1.8 3.4 3.2 7.5 3.2s7.5-1.4 7.5-3.2V6.2" /><path d="M4.5 11.8v5.6c0 1.8 3.4 3.2 7.5 3.2s7.5-1.4 7.5-3.2v-5.6" /></>,
  truck: <><rect x="1.5" y="6.5" width="12" height="9.5" rx="1.4" /><path d="M13.5 10h3.6l3.4 3.6V16h-7" /><circle cx="6" cy="18.5" r="2.1" /><circle cx="17" cy="18.5" r="2.1" /></>,

  /* --- money ------------------------------------------------------------ */
  invoice: <><path d="M5.5 2.5h13v19l-2.2-1.6-2.2 1.6-2.1-1.6-2.2 1.6-2.2-1.6-2.1 1.6v-19Z" /><path d="M9.5 7.5h5M9.5 11h5M9.5 14.5h3" /></>,
  card: <><rect x="2.5" y="5" width="19" height="14" rx="2.4" /><path d="M2.5 9.8h19" /><path d="M6.5 14.6h3.5" /></>,
  handshake: <><path d="m2.5 12 3.6-3.6a2 2 0 0 1 2.8 0L12 11.5l1.6-1.6a2 2 0 0 1 2.8 0L21.5 15" /><path d="m12 11.5-2.6 2.6a1.8 1.8 0 0 0 2.5 2.5l1-1 2.2 2.2a1.7 1.7 0 0 0 2.4-2.4" /><path d="M2.5 12v-2.5M21.5 15v-3" /></>,

  /* --- insight ---------------------------------------------------------- */
  chart: <><path d="M3.5 20.5h17" /><path d="M6.5 20.5V13M11 20.5V6.5M15.5 20.5v-5M20 20.5V10" /></>,
  sparkle: <><path d="M12 2.5 13.9 8 19.5 10l-5.6 2L12 17.5 10.1 12 4.5 10 10.1 8 12 2.5Z" /><path d="M18.5 16.5 19.3 18.8 21.5 19.5 19.3 20.3 18.5 22.5 17.7 20.3 15.5 19.5 17.7 18.8 18.5 16.5Z" /></>,
  people: <><circle cx="9" cy="8" r="3.5" /><path d="M2.8 20.5a6.2 6.2 0 0 1 12.4 0" /><path d="M16.2 5.1a3.5 3.5 0 0 1 0 6.6" /><path d="M17.6 14.9a6.2 6.2 0 0 1 3.6 5.6" /></>,
  gear: <><circle cx="12" cy="12" r="3.2" /><path d="M19.5 12a7.6 7.6 0 0 0-.12-1.34l2-1.55-2-3.46-2.36.95a7.5 7.5 0 0 0-2.32-1.34L14.4 2.8h-4l-.3 2.46a7.5 7.5 0 0 0-2.32 1.34l-2.36-.95-2 3.46 2 1.55a7.6 7.6 0 0 0 0 2.68l-2 1.55 2 3.46 2.36-.95a7.5 7.5 0 0 0 2.32 1.34l.3 2.46h4l.3-2.46a7.5 7.5 0 0 0 2.32-1.34l2.36.95 2-3.46-2-1.55c.08-.44.12-.89.12-1.34Z" /></>,

  /* --- inline / banner --------------------------------------------------- */
  alert: <><path d="M12 3.2 1.8 20.8h20.4L12 3.2Z" /><path d="M12 9.6v4.6" /><path d="M12 17.6h.01" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5" /><path d="M12 7.6h.01" /></>,
  check: <><circle cx="12" cy="12" r="9" /><path d="m8 12.2 2.6 2.6L16 9.4" /></>,
  lock: <><rect x="4.5" y="10.5" width="15" height="10.5" rx="2" /><path d="M8 10.5V7.4a4 4 0 0 1 8 0v3.1" /></>,
  unlock: <><rect x="4.5" y="10.5" width="15" height="10.5" rx="2" /><path d="M8 10.5V7.4a4 4 0 0 1 7.5-1.9" /></>,
  plus: <><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 6.8V12l3.4 2" /></>,
  phone: <path d="M7.5 3.5 9.8 8l-2 1.9a12 12 0 0 0 5.4 5.4l1.9-2 4.4 2.3v3.2a1.7 1.7 0 0 1-1.9 1.7A17.5 17.5 0 0 1 2.6 5.4 1.7 1.7 0 0 1 4.3 3.5h3.2Z" />,

  /* --- shell ------------------------------------------------------------ */
  user: <><circle cx="12" cy="8" r="4" /><path d="M4.5 21a7.5 7.5 0 0 1 15 0" /></>,
  signOut: <><path d="M14.5 3.5h3.5A1.5 1.5 0 0 1 19.5 5v14a1.5 1.5 0 0 1-1.5 1.5h-3.5" /><path d="M9.5 16 5.5 12l4-4" /><path d="M5.5 12h9" /></>,
  doc: <><path d="M6 2.5h8.5L19 7v14.5H6z" /><path d="M14 2.5V7h5" /><path d="M9 12h6M9 16h4" /></>,
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 18, className }: {
  name: string; size?: number; className?: string;
}) {
  const path = P[name];
  if (!path) return null;
  return (
    <svg
      className={className}
      width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor"
      strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
      style={{ flex: '0 0 auto' }}
    >
      {path}
    </svg>
  );
}
