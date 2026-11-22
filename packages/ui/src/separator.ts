import { separator } from "@ui-sdk/core/separator";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";

export const State = Schema.Struct({
  key: Schema.String,
  vertical: Schema.Boolean,
  decorative: Schema.Boolean,
});
export type State = typeof State.Type;

export const init = (state: { key: string; vertical?: boolean; decorative?: boolean }): State => ({
  key: state.key,
  vertical: state.vertical ?? false,
  decorative: state.decorative ?? false,
});

type Slot = "root";

export const component = defineComponent<State, Slot>({
  name: "separator",
  primitive: primitiveOf(separator),
  state: State,
  key: (state) => state.key,
  options: (state) => ({
    orientation: state.vertical ? "vertical" : "horizontal",
    decorative: state.decorative,
  }),
  controlled: [],
  callbacks: {},
  fold: (state) => state,
  tags: { root: "div" },
  bound: [],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
