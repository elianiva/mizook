import { tabs } from "@ui-sdk/core/tabs";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";

export const State = Schema.Struct({ key: Schema.String, value: Schema.String });
export type State = typeof State.Type;

export const init = (state: { key: string; value: string }): State => ({
  key: state.key,
  value: state.value,
});

type Slot = "root" | "list" | "tab" | "indicator" | "panel";

export const component = defineComponent<State, Slot>({
  name: "tabs",
  primitive: primitiveOf(tabs),
  state: State,
  key: (state) => state.key,
  options: (state) => ({ value: state.value }),
  controlled: ["value"],
  callbacks: { onValueChange: "value" },
  fold: (state, snapshot) => ({
    ...state,
    value: typeof snapshot["value"] === "string" ? snapshot["value"] : state.value,
  }),
  tags: { root: "div", list: "div", tab: "button", indicator: "div", panel: "div" },
  bound: ["root", "list", "tab", "indicator", "panel"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
