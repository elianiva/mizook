import { button } from "@ui-sdk/core/button";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";

// A button has no state to change. Presses are Foldkit's (`h.OnClick`): the part is
// pure, so nothing binds and no Message comes back.
export const State = Schema.Struct({ key: Schema.String, disabled: Schema.Boolean });
export type State = typeof State.Type;

export const init = (state: { key: string; disabled?: boolean }): State => ({
  key: state.key,
  disabled: state.disabled ?? false,
});

type Slot = "root";

export const component = defineComponent<State, Slot>({
  name: "button",
  primitive: primitiveOf(button),
  state: State,
  key: (state) => state.key,
  options: (state) => ({ disabled: state.disabled }),
  controlled: [],
  callbacks: {},
  fold: (state) => state,
  tags: { root: "button" },
  bound: [],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
