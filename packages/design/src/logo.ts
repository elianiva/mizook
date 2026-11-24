/**
 * Mizook's logo, on a 32 px grid. The mark is a thread holding the memory
 * tree: one summary line, two halves, four quarters. The loop is the OO of
 * the wordmark, a chat that never ends. Each
 * shape names a tone the apps map to theme colors; this file is data only.
 */
export type Tone = "ink" | "accent" | "soft";

export type Shape =
  | { readonly kind: "path"; readonly d: string; readonly width: number; readonly tone: Tone }
  | {
      readonly kind: "rect";
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
      readonly tone: Tone;
    };

const cell = (x: number, y: number, w: number, tone: Tone): Shape => ({
  kind: "rect",
  x,
  y,
  w,
  h: 2,
  tone,
});

export const mark: ReadonlyArray<Shape> = [
  { kind: "path", d: "M4 4h24v17H12l-6 5v-5H4z", width: 2, tone: "ink" },
  cell(8, 8, 16, "accent"),
  cell(8, 12, 7.5, "ink"),
  cell(16.5, 12, 7.5, "ink"),
  ...[8, 12.25, 16.5, 20.75].map((x) => cell(x, 16, 3.25, "soft")),
];

/** The loop fills `loopViewBox`, its ink bounds on the grid. */
export const loop: ReadonlyArray<Shape> = [
  { kind: "path", d: "M16 16l5-5h6l2 2v6l-2 2h-6L11 11H5l-2 2v6l2 2h6z", width: 3, tone: "ink" },
];

export const loopViewBox = "1.5 9.5 29 13";

/**
 * How the logo sits next to Google Sans at weight 700 with 0.04em tracking, in
 * em of the text. Measured from the font: caps are 0.716em tall, and the O
 * overshoots them by 0.016em and has 0.045em side bearings.
 */
export const lockup = {
  /** The mark's size, its drop below the baseline, and the space after it. */
  markSize: 1.5,
  /** Centres the bubble's body (y 3 to 22) on the cap height. */
  markDrop: 0.556,
  markGap: 0.18,
  /** The loop is as tall as an O and drops below the baseline as far. */
  loopHeight: 0.748,
  loopDrop: 0.016,
  /** Halfway between the O's and a stem's side bearings, since the loop has flat sides;
   * after it also the tracking a letter carries. */
  loopBefore: 0.06,
  loopAfter: 0.1,
} as const;
