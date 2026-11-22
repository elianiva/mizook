import { menubar } from "@ui-sdk/core/menubar";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";

// The bar owns only its own ARIA. Its menus are separate `Menu` instances in the registry:
// ui-sdk links them through a context function the Model cannot hold. See docs/adapter-api.md.
export const State = Schema.Struct({ key: Schema.String });
export type State = typeof State.Type;

export const init = (state: { key: string }): State => ({ key: state.key });

type Slot = "root";

export const component = defineComponent<State, Slot>({
  name: "menubar",
  primitive: primitiveOf(menubar),
  state: State,
  key: (state) => state.key,
  options: () => ({}),
  controlled: [],
  callbacks: {},
  fold: (state) => state,
  tags: { root: "div" },
  bound: ["root"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
