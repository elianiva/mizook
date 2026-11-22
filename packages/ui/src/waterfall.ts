import { waterfall } from "@ui-sdk/core/waterfall";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";

/** A span of time in milliseconds. `parent` is another row's value, or empty at the root. */
export const Row = Schema.Struct({
  value: Schema.String,
  label: Schema.String,
  start: Schema.Finite,
  duration: Schema.Finite,
  parent: Schema.String,
});
export type Row = typeof Row.Type;

export const State = Schema.Struct({
  key: Schema.String,
  rows: Schema.Array(Row),
  /** The selected row, or null. */
  value: Schema.NullOr(Schema.String),
  expanded: Schema.Array(Schema.String),
});
export type State = typeof State.Type;

export const init = (state: {
  key: string;
  rows: ReadonlyArray<Row>;
  value?: string;
  expanded?: ReadonlyArray<string>;
}): State => ({
  key: state.key,
  rows: state.rows,
  value: state.value ?? null,
  expanded: state.expanded ?? [],
});

/** Every row in document order, parents before their children. Core hides the collapsed ones. */
export const orderedRows = (state: State, parent = ""): ReadonlyArray<Row> =>
  state.rows
    .filter((row) => row.parent === parent)
    .flatMap((row) => [row, ...orderedRows(state, row.value)]);

export const isBranch = (state: State, value: string) =>
  state.rows.some((row) => row.parent === value);

export const levelOf = (state: State, row: Row): number =>
  row.parent === ""
    ? 1
    : 1 +
      levelOf(
        state,
        state.rows.find((other) => other.value === row.parent) ?? { ...row, parent: "" },
      );

/** The span all rows cover, from the first start to the last end. */
export const rangeOf = (state: State): [number, number] => [
  Math.min(...state.rows.map((row) => row.start)),
  Math.max(...state.rows.map((row) => row.start + row.duration)),
];

/** Round times along the range, as many as `count`. */
export const ticksOf = (state: State, count = 5): ReadonlyArray<number> => {
  const [from, to] = rangeOf(state);
  return Array.from({ length: count }, (_, index) =>
    Math.round(from + ((to - from) * index) / (count - 1)),
  );
};

type WaterfallItem = {
  value: string;
  label: string;
  start: number;
  duration: number;
  children?: Array<WaterfallItem>;
};

const nest = (state: State, parent: string): Array<WaterfallItem> =>
  state.rows
    .filter((row) => row.parent === parent)
    .map((row) => {
      const children = nest(state, row.value);
      const { value, label, start, duration } = row;
      return children.length === 0
        ? { value, label, start, duration }
        : { value, label, start, duration, children };
    });

const strings = Schema.decodeUnknownSync(Schema.Array(Schema.String));

type Slot =
  | "root"
  | "header-row"
  | "column-header"
  | "axis"
  | "tick"
  | "mark"
  | "row"
  | "row-header"
  | "indicator"
  | "cell"
  | "bar";

export const component = defineComponent<State, Slot>({
  name: "waterfall",
  primitive: primitiveOf(waterfall),
  state: State,
  key: (state) => state.key,
  options: (state) => ({
    items: nest(state, ""),
    range: rangeOf(state),
    value: state.value,
    expanded: [...state.expanded],
    locale: "en-US",
  }),
  controlled: ["value", "expanded"],
  callbacks: { onValueChange: "value", onExpandedChange: "expanded" },
  fold: (state, snapshot) => ({
    ...state,
    value: typeof snapshot["value"] === "string" ? snapshot["value"] : null,
    expanded: strings(snapshot["expanded"] ?? state.expanded),
  }),
  tags: {
    root: "div",
    "header-row": "div",
    "column-header": "div",
    axis: "div",
    tick: "span",
    mark: "div",
    row: "div",
    "row-header": "div",
    indicator: "span",
    cell: "div",
    bar: "div",
  },
  bound: ["root", "row", "row-header", "indicator", "cell", "bar"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
