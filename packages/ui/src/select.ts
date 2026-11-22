import { select } from "@ui-sdk/core/select";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import type { Snapshot } from "./internal/bind.ts";
import { primitiveOf } from "./internal/render.ts";
import { popupCompletions, popupFields, popupFold, popupInit } from "./popup.ts";

export const Item = Schema.Struct({ value: Schema.String, label: Schema.String });
export type Item = typeof Item.Type;

export const State = Schema.Struct({
  ...popupFields,
  /** The chosen value, or empty. */
  value: Schema.String,
  items: Schema.Array(Item),
});
export type State = typeof State.Type;

export const init = (state: {
  key: string;
  items: ReadonlyArray<Item>;
  value?: string;
  open?: boolean;
}): State => ({ ...popupInit(state), value: state.value ?? "", items: state.items });

export const labelOf = (state: State, value: string) =>
  state.items.find((item) => item.value === value)?.label ?? value;

type Slot =
  | "root"
  | "label"
  | "trigger"
  | "value"
  | "arrow"
  | "clear"
  | "input"
  | "content"
  | "viewport"
  | "list"
  | "item"
  | "item-text"
  | "item-indicator"
  | "group"
  | "group-label"
  | "separator"
  | "empty"
  | "status";

export const component = defineComponent<State, Slot>({
  name: "select",
  primitive: primitiveOf(select),
  state: State,
  key: (state) => state.key,
  options: (state) => ({
    value: state.value === "" ? null : state.value,
    open: state.open,
    items: state.items.map((item) => ({ ...item })),
    // ui-sdk also passes a bare selected value to these, not only an item.
    itemToValue: (item: Item | string) => (typeof item === "string" ? item : item.value),
    itemToLabel: (item: Item | string) =>
      typeof item === "string" ? labelOf(state, item) : item.label,
  }),
  controlled: ["value", "open"],
  callbacks: { onValueChange: "value", onOpenChange: "open" },
  completions: popupCompletions,
  renderState: (state) => ({ mounted: state.mounted }),
  fold: (state: State, snapshot: Snapshot): State => ({
    ...popupFold(state, snapshot),
    value: typeof snapshot["value"] === "string" ? snapshot["value"] : "",
  }),
  tags: {
    root: "div",
    label: "label",
    trigger: "button",
    value: "span",
    arrow: "span",
    clear: "button",
    input: "input",
    content: "div",
    viewport: "div",
    list: "div",
    item: "div",
    "item-text": "span",
    "item-indicator": "span",
    group: "div",
    "group-label": "div",
    separator: "div",
    empty: "div",
    status: "div",
  },
  bound: [
    "root",
    "label",
    "trigger",
    "value",
    "arrow",
    "clear",
    "input",
    "content",
    "viewport",
    "list",
    "item",
    "group",
    "group-label",
    "separator",
    "empty",
    "status",
  ],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
