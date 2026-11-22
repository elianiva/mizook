import { collapsible } from "@ui-sdk/core/collapsible";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";

export const State = Schema.Struct({ key: Schema.String, open: Schema.Boolean });
export type State = typeof State.Type;

export const init = (state: { key: string; open?: boolean }): State => ({
  key: state.key,
  open: state.open ?? false,
});

type Slot = "root" | "trigger" | "panel";

export const component = defineComponent<State, Slot>({
  name: "collapsible",
  primitive: primitiveOf(collapsible),
  state: State,
  key: (state) => state.key,
  options: (state) => ({ open: state.open }),
  controlled: ["open"],
  callbacks: { onOpenChange: "open" },
  fold: (state, snapshot) => ({ ...state, open: snapshot["open"] === true }),
  tags: { root: "div", trigger: "button", panel: "div" },
  keepMounted: ["panel"],
  bound: ["root", "trigger", "panel"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
