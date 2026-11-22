import type { Line } from "./types.ts";

export const span = (l: number): number => 2 ** l;
export const first = (l: number, i: number): number => i * span(l);
export const last = (l: number, i: number): number => first(l, i) + span(l) - 1;
export const label = (l: number, i: number): string => `${first(l, i)}+${span(l)}`;

export const parent = (l: number, i: number): Line => ({ l: l + 1, i: i >> 1 });
export const children = (l: number, i: number): [Line, Line] => [
  { l: l - 1, i: 2 * i },
  { l: l - 1, i: 2 * i + 1 },
];

export function parseLabel(id: number, n: number): Line {
  if (!Number.isInteger(id) || !Number.isInteger(n) || id < 0 || n < 1) {
    throw new RangeError(`zoom(${id}, ${n}): id and n must be non-negative integers, n >= 1`);
  }
  const l = Math.log2(n);
  if (!Number.isInteger(l)) throw new RangeError(`zoom(${id}, ${n}): n must be a power of 2`);
  if (id % n !== 0) throw new RangeError(`zoom(${id}, ${n}): id must be a multiple of n`);
  return { l, i: id / n };
}
