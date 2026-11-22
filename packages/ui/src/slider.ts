import { slider } from "@ui-sdk/core/slider";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { named } from "./form-inputs.ts";
import { primitiveOf } from "./internal/render.ts";

export const State = Schema.Struct({
  key: Schema.String,
  value: Schema.Array(Schema.Finite),
  min: Schema.Finite,
  max: Schema.Finite,
  step: Schema.Finite,
  name: Schema.String,
});
export type State = typeof State.Type;

export const init = (state: {
  key: string;
  value: ReadonlyArray<number>;
  min?: number;
  max?: number;
  step?: number;
  name?: string;
}): State => ({
  key: state.key,
  value: state.value,
  min: state.min ?? 0,
  max: state.max ?? 100,
  step: state.step ?? 1,
  name: state.name ?? "",
});

const numbers = Schema.decodeUnknownSync(Schema.Array(Schema.Finite));

type Slot =
  | "root"
  | "control"
  | "track"
  | "indicator"
  | "thumb"
  | "thumb-input"
  | "value"
  | "input";

export const component = defineComponent<State, Slot>({
  name: "slider",
  primitive: primitiveOf(slider),
  state: State,
  key: (state) => state.key,
  options: (state) => ({
    value: [...state.value],
    min: state.min,
    max: state.max,
    step: state.step,
    ...named(state.name),
  }),
  controlled: ["value"],
  callbacks: { onValueChange: "value" },
  fold: (state, snapshot) => ({ ...state, value: numbers(snapshot["value"]) }),
  tags: {
    root: "div",
    control: "div",
    track: "div",
    indicator: "div",
    thumb: "div",
    "thumb-input": "input",
    value: "output",
    input: "input",
  },
  bound: ["root", "control", "track", "thumb", "thumb-input"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
