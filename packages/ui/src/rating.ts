import { rating, ratingItemValues } from "@ui-sdk/core/rating";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { named } from "./form-inputs.ts";
import { primitiveOf } from "./internal/render.ts";

export const State = Schema.Struct({
  key: Schema.String,
  /** The chosen rating, or null for none. */
  value: Schema.NullOr(Schema.Finite),
  max: Schema.Finite,
  /** 1 for whole stars, 0.5 for halves. */
  step: Schema.Finite,
  deselectable: Schema.Boolean,
  disabled: Schema.Boolean,
  readOnly: Schema.Boolean,
  name: Schema.String,
});
export type State = typeof State.Type;

export const init = (state: {
  key: string;
  value?: number | null;
  max?: number;
  step?: number;
  deselectable?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  name?: string;
}): State => ({
  key: state.key,
  value: state.value ?? null,
  max: state.max ?? 5,
  step: state.step ?? 1,
  deselectable: state.deselectable ?? false,
  disabled: state.disabled ?? false,
  readOnly: state.readOnly ?? false,
  name: state.name ?? "",
});

/** The values the radios of star `index` (from 1) stand for, as the `value` prop of `radio` and `input`. */
export const itemValues = (state: State, index: number): ReadonlyArray<string> =>
  ratingItemValues(index, state.step).map(String);

type Slot = "root" | "item" | "radio" | "input";

export const component = defineComponent<State, Slot>({
  name: "rating",
  primitive: primitiveOf(rating),
  state: State,
  key: (state) => state.key,
  options: (state) => ({
    value: state.value,
    max: state.max,
    step: state.step,
    deselectable: state.deselectable,
    disabled: state.disabled,
    readOnly: state.readOnly,
    ...named(state.name),
  }),
  controlled: ["value"],
  callbacks: { onValueChange: "value" },
  fold: (state, snapshot) => ({
    ...state,
    value: typeof snapshot["value"] === "number" ? snapshot["value"] : null,
  }),
  tags: { root: "div", item: "span", radio: "button", input: "input" },
  bound: ["root", "radio"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
