import { resizable } from "@ui-sdk/core/resizable";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";

// The layout is not in the Model: sizes are a pointer-drag detail with no meaning to the app.
// The instance keeps them, and the app only chooses the orientation.
export const State = Schema.Struct({ key: Schema.String, vertical: Schema.Boolean });
export type State = typeof State.Type;

export const init = (state: { key: string; vertical?: boolean }): State => ({
  key: state.key,
  vertical: state.vertical ?? false,
});

type Slot = "root" | "panel" | "handle";

export const component = defineComponent<State, Slot>({
  name: "resizable",
  primitive: primitiveOf(resizable),
  state: State,
  key: (state) => state.key,
  options: (state) => ({ orientation: state.vertical ? "vertical" : "horizontal" }),
  controlled: [],
  callbacks: {},
  fold: (state) => state,
  tags: { root: "div", panel: "div", handle: "div" },
  bound: ["root", "panel", "handle"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
