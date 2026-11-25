/**
 * Mizook's glyphs: one stroke path each on a 24 px grid, drawn with square
 * caps and mitred joins so they match the square corners. `fill` marks the
 * solid ones. The apps render them; this file is data only.
 */
export type Glyph = { readonly d: string; readonly fill?: true };

export const glyphs = {
  plus: { d: "M12 4v16M4 12h16" },
  close: { d: "M5 5l14 14M19 5L5 19" },
  check: { d: "M4 12.5l5 5L20 6.5" },
  shieldCheck: {
    d: "M12 2.5l8 3v6.5c0 5-3.5 8.2-8 9.5-4.5-1.3-8-4.5-8-9.5V5.5zM8.5 12l2.5 2.5 4.5-5",
  },
  menu: { d: "M3 6h18M3 12h18M3 18h12" },
  more: { d: "M4.5 10.5h3v3h-3zM10.5 10.5h3v3h-3zM16.5 10.5h3v3h-3z", fill: true },
  pencil: { d: "M4 20h4L19 9l-4-4L4 16zM13 7l4 4" },
  archive: { d: "M3 4h18v4H3zM5 8v12h14V8M10 12h4" },
  send: { d: "M12 20V5M5 12l7-7 7 7" },
  stop: { d: "M6 6h12v12H6z", fill: true },
  copy: { d: "M8 8h12v12H8zM16 8V4H4v12h4" },
  download: { d: "M12 3v12M6 9l6 6 6-6M4 21h16" },
  arrowDown: { d: "M12 4v15M5 12l7 7 7-7" },
  arrowLeft: { d: "M20 12H5M12 5l-7 7 7 7" },
  arrowRight: { d: "M4 12h15M12 5l7 7-7 7" },
  external: { d: "M14 3h7v7M21 3l-9 9M18 14v7H3V6h7" },
  chevronDown: { d: "M5 9l7 7 7-7" },
  chevronRight: { d: "M9 5l7 7-7 7" },
  thread: { d: "M3 4h18v13H8l-5 4zM12 7.5v6M9 10.5h6" },
  image: { d: "M3 4h18v16H3zM3 16l5-5 4 4 3-3 6 6M15 8.5h1" },
  grid: { d: "M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z" },
  log: { d: "M8 5h13M8 12h13M8 19h13M3 4h2v2H3zM3 11h2v2H3zM3 18h2v2H3z" },
  tree: { d: "M10 2h4v4h-4zM2 18h4v4H2zM10 18h4v4h-4zM18 18h4v4h-4zM12 6v6M4 18v-6h16v6M12 12v6" },
  bars: { d: "M3 21h18M6 17v-5M11 17V4M16 17V9M21 17v-3" },
  zap: { d: "M13 2L4 14h7l-1 8 9-12h-7z" },
  pulse: { d: "M2 12h4l3-8 6 16 3-8h4" },
  book: { d: "M3 4h7l2 2 2-2h7v15h-7l-2 2-2-2H3zM12 6v15" },
  sliders: { d: "M3 6h10M17 6h4M3 12h4M11 12h10M3 18h12M19 18h2M15 3v6M9 9v6M17 15v6" },
  file: { d: "M5 2h10l4 4v16H5zM14 2v5h5M9 13h6M9 17h6" },
  audit: { d: "M8 2h8v4H8zM6 4H4v18h16V4h-2M8 12l2 2 4-4M8 18h8" },
  user: { d: "M8 3h8v8H8zM4 21v-6h16v6" },
  bot: { d: "M4 7h16v13H4zM12 3v4M9 12v3M15 12v3M1 12v4M23 12v4" },
  search: { d: "M3 3h12v12H3zM15 15l6 6" },
  trash: { d: "M3 6h18M8 6V3h8v3M5 6l1 15h12l1-15M10 10v7M14 10v7" },
  eye: { d: "M2 12l4-6h12l4 6-4 6H6zM10 10h4v4h-4z" },
  lock: { d: "M5 11h14v10H5zM8 11V4h8v7M12 15v2" },
  play: { d: "M7 4l13 8-13 8z", fill: true },
  pause: { d: "M6 4h4v16H6zM14 4h4v16h-4z", fill: true },
  refresh: { d: "M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5" },
  alert: { d: "M12 3l10 18H2zM12 10v5M12 17.5v1" },
  clock: { d: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3.5 3.5" },
  save: { d: "M4 3h13l4 4v14H4zM8 3v5h8V3M8 21v-7h8v7" },
  coin: { d: "M12 2v20M17 6H9.5a3 3 0 0 0 0 6h5a3 3 0 0 1 0 6H6" },
  hook: { d: "M9 3h6v6H9zM12 9v6a4 4 0 0 0 8 0v-2M4 13l3-3 3 3" },
  command: {
    d: "M9 9h6v6H9zM9 9H6a3 3 0 1 1 3-3zM15 9V6a3 3 0 1 1 3 3zM15 15h3a3 3 0 1 1-3 3zM9 15v3a3 3 0 1 1-3-3z",
  },
} as const satisfies Record<string, Glyph>;

export type GlyphName = keyof typeof glyphs;
