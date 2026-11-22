import { Arbitrary } from "effect";
import { expect } from "vite-plus/test";
import { BuiltIndex } from "../src/built.ts";
import { first, last } from "../src/tree.ts";
import { View } from "../src/view.ts";
import type { Line } from "../src/types.ts";
import { arrayOf, boolean, int } from "./helpers.ts";
import { property } from "./property.ts";

type States = { keep: number; life: number; state: number; older: States | null } | null;
function push(newState: number, states: States): NonNullable<States> {
  if (states === null) return { keep: 0, life: 0, state: newState, older: null };
  const { keep, life, state, older } = states;
  if (keep === 0) return { keep: 1, life, state, older };
  if (life > 0) {
    return { keep: 0, life: 0, state: newState, older: { keep: 0, life: life - 1, state, older } };
  }
  return { keep: 0, life, state: newState, older: push(state, older) };
}
const starts = (states: States): number[] => {
  const out: number[] = [];
  for (let s = states; s !== null; s = s.older) out.push(s.state);
  return out.reverse();
};

const shape = (lines: readonly Line[]) =>
  lines.map(({ l, i }) => [first(l, i), last(l, i) - first(l, i) + 1] as const);

const allBuilt = (levels: number, leaves: number, size: number) => {
  const built = new BuiltIndex();
  for (let l = 0; l <= levels; l++)
    for (let i = 0; i < Math.ceil(leaves / 2 ** l); i++) built.set(l, i, size);
  return built;
};

const covers = (lines: readonly Line[], total: number) => {
  let next = 0;
  for (const { l, i } of lines) {
    if (first(l, i) !== next) return false;
    next = last(l, i) + 1;
  }
  return next === total;
};

const isSiblingPair = (a: Line, b: Line) => a.l === b.l && a.i % 2 === 0 && b.i === a.i + 1;

const hasMergeablePair = (lines: readonly Line[], built: BuiltIndex) =>
  lines.some((a, k) => {
    const b = lines[k + 1];
    return b !== undefined && isSiblingPair(a, b) && built.has(a.l + 1, a.i >> 1);
  });

const decompose = (levels: readonly number[]): Line[] => {
  const lines: Line[] = [];
  let at = 0;
  for (let l of levels) {
    while (at % 2 ** l !== 0) l--;
    lines.push({ l, i: at / 2 ** l });
    at += 2 ** l;
  }
  return lines;
};

const levels = (maxLevel: number, maxLines: number) => arrayOf(int(0, maxLevel), 1, maxLines);

property(
  "with the push list's length as budget, the view after any number of messages matches push",
  int(1, 3_000),
  (messages) => {
    const built = allBuilt(12, messages, 10);
    const view = new View(built, { hi: Infinity, lo: Infinity });
    let states: States = null;
    for (let t = 0; t < messages; t++) {
      states = push(t, states);
      view.append(0, t);
      const target = starts(states).length;
      while (view.lines.length > target) {
        if (!view.mergeOne(t + 1)) return false;
      }
    }
    const target = starts(states);
    const expected = target.map((s, k) => [s, (target[k + 1] ?? messages) - s] as const);
    expect(shape(view.lines)).toEqual(expected);
  },
);

property(
  "one merge joins the built sibling pair that ended the most of its own spans ago, the oldest on ties, and changes nothing else",
  Arbitrary.all({
    levels: levels(4, 30),
    parentsBuilt: Arbitrary.array(boolean, { minLength: 30, maxLength: 30 }),
    later: int(0, 40),
  }),
  ({ levels, parentsBuilt, later }) => {
    const lines = decompose(levels);
    const built = new BuiltIndex();
    for (const { l, i } of lines) built.set(l, i, 10);
    lines.forEach(({ l, i }, k) => {
      if (parentsBuilt[k]) built.set(l + 1, i >> 1, 10);
    });
    const end = last(lines.at(-1)!.l, lines.at(-1)!.i) + 1;
    const total = end + later;
    let expected: number | undefined;
    let mostOverdue = -Infinity;
    for (let k = 0; k + 1 < lines.length; k++) {
      const a = lines[k]!;
      const b = lines[k + 1]!;
      if (!isSiblingPair(a, b) || !built.has(a.l + 1, a.i >> 1)) continue;
      const spansAgo = (total - (first(b.l, b.i) + 2 ** b.l - 1)) / 2 ** b.l;
      if (spansAgo > mostOverdue) {
        mostOverdue = spansAgo;
        expected = k;
      }
    }
    const view = new View(built, { hi: Infinity, lo: Infinity });
    view.lines = lines.map((line) => ({ ...line }));
    const merged = view.mergeOne(total);
    if (expected === undefined) {
      expect(merged).toBeUndefined();
      expect(view.lines).toEqual(lines);
      return;
    }
    const a = lines[expected]!;
    expect(merged).toEqual({ l: a.l + 1, i: a.i >> 1 });
    expect(view.lines).toEqual([
      ...lines.slice(0, expected),
      { l: a.l + 1, i: a.i >> 1 },
      ...lines.slice(expected + 2),
    ]);
    expect(covers(view.lines, end)).toBe(true);
  },
);

property(
  "with every node built, a batch starts only past hi, ends at lo or when no pair can merge, and between batches old lines never change",
  Arbitrary.all({
    messages: int(1, 600),
    size: int(1, 300),
    lo: int(50, 5_000),
    gap: int(0, 5_000),
  }),
  ({ messages, size, lo, gap }) => {
    const hi = lo + gap;
    const built = allBuilt(10, messages, size);
    const view = new View(built, { hi, lo });
    for (let t = 0; t < messages; t++) {
      const pendingBefore = view.pending;
      const previous = view.lines.map((line) => ({ ...line }));
      view.append(0, t);
      const bytesAfterAppend = view.bytes();
      const merged = view.shrink(t + 1);
      const bytes = view.bytes();
      const batchRuns = pendingBefore || bytesAfterAppend > hi;
      if (!batchRuns) {
        expect(merged).toEqual([]);
        expect(view.lines.slice(0, previous.length)).toEqual(previous);
      } else {
        expect(bytes <= lo || !hasMergeablePair(view.lines, built)).toBe(true);
        expect(view.pending).toBe(bytes > lo);
      }
      if (!view.pending) expect(bytes).toBeLessThanOrEqual(hi);
      expect(covers(view.lines, t + 1)).toBe(true);
    }
  },
  { runs: 50 },
);

property(
  "while parents are unbuilt a pending batch merges nothing, and once they are built the next step finishes it",
  Arbitrary.all({
    messages: int(2, 80),
    lo: int(10, 400),
    gap: int(0, 400),
    size: int(1, 20),
  }),
  ({ messages, lo, gap, size }) => {
    const hi = lo + gap;
    const built = new BuiltIndex();
    const view = new View(built, { hi, lo });
    let everOverHi = false;
    for (let i = 0; i < messages; i++) {
      built.set(0, i, size);
      view.append(0, i);
      everOverHi ||= view.bytes() > hi;
      expect(view.shrink(i + 1)).toEqual([]);
      expect(view.pending).toBe(everOverHi);
      expect(view.lines.length).toBe(i + 1);
    }
    for (let l = 1; l <= 7; l++)
      for (let i = 0; i < Math.floor(messages / 2 ** l); i++) built.set(l, i, size);
    view.shrink(messages);
    const bytes = view.bytes();
    if (everOverHi) {
      expect(bytes <= lo || !hasMergeablePair(view.lines, built)).toBe(true);
      expect(view.pending).toBe(bytes > lo);
    } else {
      expect(view.lines.length).toBe(messages);
    }
    expect(covers(view.lines, messages)).toBe(true);
  },
);

property(
  "coarsenTo turns a view into any coarser view of the same messages, and leaves it alone given a finer one",
  Arbitrary.all({
    levels: levels(3, 40),
    picks: arrayOf(int(0, 1_000), 0, 40),
  }),
  ({ levels, picks }) => {
    const fine = decompose(levels);
    const end = last(fine.at(-1)!.l, fine.at(-1)!.i) + 1;
    let coarse = fine.map((line) => ({ ...line }));
    for (const pick of picks) {
      const pairs = coarse.flatMap((a, k) =>
        coarse[k + 1] && isSiblingPair(a, coarse[k + 1]!) ? [k] : [],
      );
      if (pairs.length === 0) break;
      const k = pairs[pick % pairs.length]!;
      const a = coarse[k]!;
      coarse = [...coarse.slice(0, k), { l: a.l + 1, i: a.i >> 1 }, ...coarse.slice(k + 2)];
    }
    const built = allBuilt(8, end, 5);
    const fineView = new View(built, { hi: 1, lo: 1 });
    fineView.lines = fine.map((line) => ({ ...line }));
    fineView.coarsenTo(coarse);
    expect(fineView.lines).toEqual(coarse);
    const coarseView = new View(built, { hi: 1, lo: 1 });
    coarseView.lines = coarse.map((line) => ({ ...line }));
    coarseView.coarsenTo(fine);
    expect(coarseView.lines).toEqual(coarse);
    expect(covers(coarse, end)).toBe(true);
  },
);
