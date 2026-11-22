import { fuzzyScore } from "@ui-sdk/core/text-match";
import { command } from "@ui-sdk/core/command";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import type { Snapshot } from "./internal/bind.ts";
import { primitiveOf } from "./internal/render.ts";

export const Item = Schema.Struct({ value: Schema.String, label: Schema.String });
export type Item = typeof Item.Type;

export const State = Schema.Struct({
  key: Schema.String,
  query: Schema.String,
  /** The highlighted command's value. */
  value: Schema.String,
  items: Schema.Array(Item),
});
export type State = typeof State.Type;

export const init = (state: { key: string; items: ReadonlyArray<Item> }): State => ({
  key: state.key,
  query: "",
  value: "",
  items: state.items,
});

export const visibleItems = (state: State): ReadonlyArray<Item> =>
  state.query === ""
    ? state.items
    : state.items
        .map((item) => ({ item, score: fuzzyScore(item.label, state.query) }))
        .filter(({ score }) => score > 0)
        .toSorted((a, b) => b.score - a.score)
        .map(({ item }) => item);

type Slot =
  | "root"
  | "input"
  | "list"
  | "item"
  | "item-text"
  | "empty"
  | "status"
  | "group"
  | "group-label"
  | "separator"
  | "page"
  | "shortcut";

export const component = defineComponent<State, Slot>({
  name: "command",
  primitive: primitiveOf(command),
  state: State,
  key: (state) => state.key,
  options: (state) => ({
    query: state.query,
    value: state.value === "" ? null : state.value,
    items: state.items.map((item) => ({ ...item })),
    itemToValue: (item: Item | string) => (typeof item === "string" ? item : item.value),
    itemToLabel: (item: Item | string) =>
      typeof item === "string"
        ? (state.items.find((entry) => entry.value === item)?.label ?? item)
        : item.label,
  }),
  controlled: ["query", "value"],
  callbacks: { onQueryChange: "query", onValueChange: "value" },
  fold: (state, snapshot: Snapshot): State => ({
    ...state,
    query: typeof snapshot["query"] === "string" ? snapshot["query"] : "",
    value: typeof snapshot["value"] === "string" ? snapshot["value"] : "",
  }),
  typed: (state, text) => ({ ...state, query: text }),
  text: "input",
  tags: {
    root: "div",
    input: "input",
    list: "div",
    item: "div",
    "item-text": "span",
    empty: "div",
    status: "div",
    group: "div",
    "group-label": "div",
    separator: "div",
    page: "div",
    shortcut: "span",
  },
  bound: [
    "root",
    "input",
    "list",
    "item",
    "empty",
    "status",
    "group",
    "group-label",
    "separator",
    "page",
  ],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
