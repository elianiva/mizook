import { label } from "@ui-sdk/core/label";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";

export const State = Schema.Struct({ key: Schema.String });
export type State = typeof State.Type;

export const init = (state: { key: string }): State => ({ key: state.key });

type Slot = "root";

export const component = defineComponent<State, Slot>({
  name: "label",
  primitive: primitiveOf(label),
  state: State,
  key: (state) => state.key,
  options: () => ({}),
  controlled: [],
  callbacks: {},
  fold: (state) => state,
  tags: { root: "label" },
  bound: [],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
