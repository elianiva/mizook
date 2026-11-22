import { accordion } from "@ui-sdk/core/accordion";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";

export const State = Schema.Struct({
  key: Schema.String,
  /** Open items. */
  value: Schema.Array(Schema.String),
  multiple: Schema.Boolean,
});
export type State = typeof State.Type;

export const init = (state: {
  key: string;
  value?: ReadonlyArray<string>;
  multiple?: boolean;
}): State => ({
  key: state.key,
  value: state.value ?? [],
  multiple: state.multiple ?? false,
});

const strings = Schema.decodeUnknownSync(Schema.Array(Schema.String));

type Slot = "root" | "item" | "header" | "trigger" | "panel";

export const component = defineComponent<State, Slot>({
  name: "accordion",
  primitive: primitiveOf(accordion),
  state: State,
  key: (state) => state.key,
  options: (state) => ({ value: [...state.value], multiple: state.multiple }),
  controlled: ["value"],
  callbacks: { onValueChange: "value" },
  fold: (state, snapshot) => ({ ...state, value: strings(snapshot["value"]) }),
  tags: { root: "div", item: "div", header: "h3", trigger: "button", panel: "div" },
  keepMounted: ["panel"],
  bound: ["root", "item", "header", "trigger", "panel"],
});

export const parts = makeParts(component);

export const update = makeUpdate(component);
