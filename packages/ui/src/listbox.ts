import { listbox } from "@ui-sdk/core/listbox";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";

export const State = Schema.Struct({
  key: Schema.String,
  value: Schema.Array(Schema.String),
  multiple: Schema.Boolean,
});
export type State = typeof State.Type;

export const init = (state: {
  key: string;
  value?: ReadonlyArray<string>;
  multiple?: boolean;
}): State => ({ key: state.key, value: state.value ?? [], multiple: state.multiple ?? false });

const strings = Schema.decodeUnknownSync(Schema.Array(Schema.String));
const asArray = (value: unknown): ReadonlyArray<string> =>
  value === null || value === undefined || value === ""
    ? []
    : Array.isArray(value)
      ? strings(value)
      : typeof value === "string"
        ? [value]
        : [];

type Slot = "root" | "item" | "item-indicator" | "group" | "group-label" | "separator";

export const component = defineComponent<State, Slot>({
  name: "listbox",
  primitive: primitiveOf(listbox),
  state: State,
  key: (state) => state.key,
  options: (state) => ({
    value: state.multiple ? [...state.value] : (state.value[0] ?? null),
    multiple: state.multiple,
  }),
  controlled: ["value"],
  callbacks: { onValueChange: "value" },
  fold: (state, snapshot) => ({ ...state, value: asArray(snapshot["value"]) }),
  tags: {
    root: "div",
    item: "div",
    "item-indicator": "span",
    group: "div",
    "group-label": "div",
    separator: "div",
  },
  bound: ["root", "item", "group", "group-label", "separator"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
