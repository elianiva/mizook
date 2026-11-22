import { numberInput } from "@ui-sdk/core/number-input";
import { Schema } from "effect";
import type { HtmlBuilder } from "foldkit/html";
import { defineComponent, makeParts, makeUpdate, type Parts, type PartsConfig } from "./core.ts";
import { named, withText } from "./form-inputs.ts";
import { primitiveOf } from "./internal/render.ts";

export const State = Schema.Struct({
  key: Schema.String,
  /** The number the control holds, or null while its text is empty or not a number. */
  value: Schema.NullOr(Schema.Finite),
  /** What is typed. It leads the value while the user types, and follows it after a step. */
  text: Schema.String,
  min: Schema.NullOr(Schema.Finite),
  max: Schema.NullOr(Schema.Finite),
  step: Schema.Finite,
  name: Schema.String,
  disabled: Schema.Boolean,
});
export type State = typeof State.Type;

export const init = (state: {
  key: string;
  value?: number | null;
  min?: number;
  max?: number;
  step?: number;
  name?: string;
  disabled?: boolean;
}): State => ({
  key: state.key,
  value: state.value ?? null,
  text: state.value === undefined || state.value === null ? "" : String(state.value),
  min: state.min ?? null,
  max: state.max ?? null,
  step: state.step ?? 1,
  name: state.name ?? "",
  disabled: state.disabled ?? false,
});

const textOf = (value: number | null) => (value === null ? "" : String(value));

type Slot =
  | "root"
  | "group"
  | "control"
  | "increment"
  | "decrement"
  | "scrub-area"
  | "hidden-input";

export const component = defineComponent<State, Slot>({
  name: "number-input",
  primitive: primitiveOf(numberInput),
  state: State,
  key: (state) => state.key,
  options: (state) => ({
    value: state.value,
    step: state.step,
    disabled: state.disabled,
    ...(state.min === null ? {} : { min: state.min }),
    ...(state.max === null ? {} : { max: state.max }),
    ...named(state.name),
  }),
  controlled: ["value"],
  callbacks: { onValueChange: "value" },
  fold: (state, snapshot) => {
    const value = typeof snapshot["value"] === "number" ? snapshot["value"] : null;
    return { ...state, value, text: textOf(value) };
  },
  typed: (state, text) => {
    const parsed = text.trim() === "" ? null : Number(text);
    return {
      ...state,
      text,
      value: parsed === null || Number.isFinite(parsed) ? parsed : state.value,
    };
  },
  text: "control",
  tags: {
    root: "div",
    group: "div",
    control: "input",
    increment: "button",
    decrement: "button",
    "scrub-area": "div",
    "hidden-input": "input",
  },
  bound: ["root", "group", "control", "increment", "decrement", "scrub-area"],
});

const base = makeParts(component);

export const parts = <AppMessage>(
  state: State,
  h: HtmlBuilder<AppMessage>,
  config: PartsConfig<AppMessage>,
): Parts<AppMessage, Slot> =>
  withText<AppMessage, Slot>(base(state, h, config), "control", h, state.text);

export const update = makeUpdate(component);
