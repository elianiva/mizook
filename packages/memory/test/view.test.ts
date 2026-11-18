import { expect, test } from "vite-plus/test";
import { BuiltIndex } from "../src/built.ts";
import { first, last } from "../src/tree.ts";
import { View } from "../src/view.ts";

// Taelin's rollback push (rollback_state_list.js, 2022), verbatim from the design.
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

/** Lines of a view as the start and length of each. */
const shape = (view: View) =>
  view.lines.map(({ l, i }) => [first(l, i), last(l, i) - first(l, i) + 1] as const);

/** Index of the first line that differs from `previous`, if any. */
const changedLine = (
  lines: ReadonlyArray<{ l: number; i: number }>,
  previous: ReadonlyArray<readonly [number, number]>,
): number | undefined => {
  for (let k = 0; k < previous.length; k++) {
    const line = lines[k];
    if (!line || line.l !== previous[k]![0] || line.i !== previous[k]![1]) return k;
  }
  return undefined;
};

test("with the push list's length as budget, the view merges exactly as push does", () => {
  const built = new BuiltIndex();
  // Every node is built, so only the merge order is under test.
  for (let l = 0; l < 12; l++) for (let i = 0; i < 2 ** (12 - l); i++) built.set(l, i, 10);
  const view = new View(built, { hi: Infinity, lo: Infinity });
  let states: States = null;
  for (let t = 0; t < 1500; t++) {
    states = push(t, states);
    view.append(0, t);
    const target = starts(states);
    while (view.lines.length > target.length) {
      if (!view.mergeOne(t + 1)) throw new Error(`no merge possible at t=${t}`);
    }
    const expected = target.map((s, k) => [s, (target[k + 1] ?? t + 1) - s] as const);
    expect(shape(view), `t=${t}`).toEqual(expected);
  }
});

test("measuring from a pair's first message would pick a different pair (old lines must not churn)", () => {
  // The design's own counter-example: T=10, view 0+4, 4+4, 8+1, 9+1. Push merges 8+1 and 9+1.
  const built = new BuiltIndex();
  for (let l = 0; l < 5; l++) for (let i = 0; i < 16; i++) built.set(l, i, 10);
  const view = new View(built, { hi: Infinity, lo: Infinity });
  view.lines = [
    { l: 2, i: 0 },
    { l: 2, i: 1 },
    { l: 0, i: 8 },
    { l: 0, i: 9 },
  ];
  expect(view.mergeOne(10)).toEqual({ l: 1, i: 4 });
});

test("a batch runs once past hi and stops at lo; it merges what it can until then", () => {
  const built = new BuiltIndex();
  const view = new View(built, { hi: 200, lo: 100 });
  const total = 40;
  for (let i = 0; i < total; i++) {
    built.set(0, i, 6);
    view.append(0, i);
    view.shrink(i + 1);
  }
  // Each line is "i+1|" (3-4 bytes), 6 bytes of text and a break: ~11 bytes. Level 1 is not built.
  expect(view.pending).toBe(true);
  expect(view.lines.length).toBe(total);
  // Building the parents lets the pending batch continue at the next step.
  for (let l = 1; l <= 5; l++) for (let i = 0; i < total / 2 ** l; i++) built.set(l, i, 6);
  view.shrink(total);
  expect(view.bytes()).toBeLessThanOrEqual(100);
  expect(view.pending).toBe(false);
});

test("coarsenTo collapses finer lines into the coarser lines of another view", () => {
  const built = new BuiltIndex();
  for (let l = 0; l < 4; l++) for (let i = 0; i < 16; i++) built.set(l, i, 5);
  const fine = new View(built, { hi: 1, lo: 1 });
  for (let i = 0; i < 6; i++) fine.append(0, i);
  fine.coarsenTo([
    { l: 2, i: 0 },
    { l: 0, i: 4 },
    { l: 0, i: 5 },
  ]);
  expect(shape(fine)).toEqual([
    [0, 4],
    [4, 1],
    [5, 1],
  ]);
});

test("over 5,000 messages the view stays between lo and hi and only grows at its end between batches", () => {
  const built = new BuiltIndex();
  // Every node is built, with a text of 200 bytes, so only the sawtooth is under test.
  for (let l = 0; l < 14; l++) for (let i = 0; i < 2 ** (14 - l); i++) built.set(l, i, 200);
  const view = new View(built, { hi: 128_000, lo: 64_000 });
  let batches = 0;
  let previous: Array<readonly [number, number]> = [];
  for (let t = 0; t < 5_000; t++) {
    view.append(0, t);
    const merged = view.shrink(t + 1);
    const bytes = view.bytes();
    if (merged.length > 0) {
      batches++;
      expect(bytes, `t=${t}`).toBeLessThanOrEqual(64_000);
    } else {
      // No batch: every earlier line is unchanged, so the prompt cache holds. A deep equal here
      // costs seconds over 5,000 steps of a few hundred lines, so compare the values directly.
      expect(changedLine(view.lines, previous), `t=${t}`).toBeUndefined();
    }
    expect(bytes).toBeLessThanOrEqual(128_000 + 300);
    previous = view.lines.map(({ l, i }) => [l, i] as const);
  }
  expect(batches).toBeGreaterThan(3);
  // The view covers the whole chat once, in order.
  let next = 0;
  for (const { l, i } of view.lines) {
    expect(first(l, i)).toBe(next);
    next = last(l, i) + 1;
  }
  expect(next).toBe(5_000);
});
