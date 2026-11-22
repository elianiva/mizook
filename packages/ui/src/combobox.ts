import { fuzzyScore } from "@ui-sdk/core/text-match";
import { combobox } from "@ui-sdk/core/combobox";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import type { Snapshot } from "./internal/bind.ts";
import { primitiveOf } from "./internal/render.ts";

export const Item = Schema.Struct({ value: Schema.String, label: Schema.String });
export type Item = typeof Item.Type;

export const State = Schema.Struct({
  key: Schema.String,
  /** Selected item values. Single mode holds zero or one. */
  value: Schema.Array(Schema.String),
  /** What is typed in the input. */
  query: Schema.String,
  open: Schema.Boolean,
  multiple: Schema.Boolean,
  items: Schema.Array(Item),
});
export type State = typeof State.Type;

export const init = (state: {
  key: string;
  items: ReadonlyArray<Item>;
  value?: ReadonlyArray<string>;
  multiple?: boolean;
}): State => ({
  key: state.key,
  value: state.value ?? [],
  query: "",
  open: false,
  multiple: state.multiple ?? false,
  items: state.items,
});

const strings = Schema.decodeUnknownSync(Schema.Array(Schema.String));
const asArray = (value: unknown): ReadonlyArray<string> =>
  value === null || value === undefined || value === ""
    ? []
    : Array.isArray(value)
      ? strings(value)
      : typeof value === "string"
        ? [value]
        : [];

export const labelOf = (state: State, value: string) =>
  state.items.find((item) => item.value === value)?.label ?? value;

const fold = (state: State, snapshot: Snapshot): State => {
  const value = asArray(snapshot["value"]);
  const query = snapshot["query"];
  return {
    ...state,
    value,
    // No query means "reset": ui-sdk asks for it when the list closes. Single mode shows the chosen label.
    query: typeof query === "string" ? query : state.multiple ? "" : labelOf(state, value[0] ?? ""),
    open: snapshot["open"] === true,
  };
};

/** The items to render. The app owns filtering, so it decides which parts exist. */
export const visibleItems = (state: State): ReadonlyArray<Item> => {
  const settled =
    !state.multiple &&
    state.value.length === 1 &&
    state.query === labelOf(state, state.value[0] ?? "");
  if (state.query === "" || settled) return state.items;
  return state.items
    .map((item) => ({ item, score: fuzzyScore(item.label, state.query) }))
    .filter(({ score }) => score > 0)
    .toSorted((a, b) => b.score - a.score)
    .map(({ item }) => item);
};

type Slot =
  | "root"
  | "label"
  | "input"
  | "trigger"
  | "content"
  | "list"
  | "item"
  | "item-text"
  | "item-indicator"
  | "empty"
  | "status"
  | "clear"
  | "value"
  | "arrow"
  | "viewport"
  | "header"
  | "group"
  | "group-label"
  | "separator";

export const component = defineComponent<State, Slot>({
  name: "combobox",
  primitive: primitiveOf(combobox),
  state: State,
  key: (state) => state.key,
  options: (state) => ({
    value: state.multiple ? [...state.value] : (state.value[0] ?? null),
    query: state.query,
    open: state.open,
    multiple: state.multiple,
    items: state.items.map((item) => ({ ...item })),
    // ui-sdk calls these with an item and also with a bare selected value (a string),
    // for example for a selected item the current filter hides. Handle both.
    itemToValue: (item: Item | string) => (typeof item === "string" ? item : item.value),
    itemToLabel: (item: Item | string) =>
      typeof item === "string" ? labelOf(state, item) : item.label,
  }),
  controlled: ["value", "query", "open"],
  callbacks: { onValueChange: "value", onQueryChange: "query", onOpenChange: "open" },
  fold,
  // Typing opens the list. Filtering stays with the app, in `visibleItems`.
  typed: (state, text) => ({ ...state, query: text, open: true }),
  text: "input",
  tags: {
    root: "div",
    label: "label",
    input: "input",
    trigger: "button",
    content: "div",
    list: "div",
    item: "div",
    "item-text": "span",
    "item-indicator": "span",
    empty: "div",
    status: "div",
    clear: "button",
    value: "span",
    arrow: "span",
    viewport: "div",
    header: "div",
    group: "div",
    "group-label": "div",
    separator: "div",
  },
  bound: [
    "root",
    "label",
    "input",
    "trigger",
    "content",
    "list",
    "item",
    "empty",
    "status",
    "clear",
    "value",
    "arrow",
    "viewport",
    "header",
    "group",
    "group-label",
    "separator",
  ],
});

export const parts = makeParts(component);

export const update = makeUpdate(component);
