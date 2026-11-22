import { progress } from "@ui-sdk/core/progress";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";

export const State = Schema.Struct({
  key: Schema.String,
  value: Schema.Finite,
  min: Schema.Finite,
  max: Schema.Finite,
});
export type State = typeof State.Type;

export const init = (state: { key: string; value: number; min?: number; max?: number }): State => ({
  key: state.key,
  value: state.value,
  min: state.min ?? 0,
  max: state.max ?? 100,
});

type Slot = "root" | "track" | "indicator" | "label" | "value";

export const component = defineComponent<State, Slot>({
  name: "progress",
  primitive: primitiveOf(progress),
  state: State,
  key: (state) => state.key,
  options: (state) => ({ value: state.value, min: state.min, max: state.max }),
  controlled: [],
  callbacks: {},
  fold: (state) => state,
  tags: { root: "div", track: "div", indicator: "div", label: "span", value: "span" },
  bound: ["root", "label"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
