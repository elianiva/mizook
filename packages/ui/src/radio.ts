import { radioGroup } from "@ui-sdk/core/radio";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { named } from "./form-inputs.ts";
import { primitiveOf } from "./internal/render.ts";

export const State = Schema.Struct({
  key: Schema.String,
  /** The chosen option's value, or empty when none is chosen. */
  value: Schema.String,
  disabled: Schema.Boolean,
  name: Schema.String,
});
export type State = typeof State.Type;

export const init = (state: {
  key: string;
  value?: string;
  disabled?: boolean;
  name?: string;
}): State => ({
  key: state.key,
  value: state.value ?? "",
  disabled: state.disabled ?? false,
  name: state.name ?? "",
});

type Slot = "group" | "root" | "input" | "indicator";

export const component = defineComponent<State, Slot>({
  name: "radio",
  primitive: primitiveOf(radioGroup),
  state: State,
  key: (state) => state.key,
  options: (state) => ({
    value: state.value === "" ? null : state.value,
    disabled: state.disabled,
    ...named(state.name),
  }),
  controlled: ["value"],
  callbacks: { onValueChange: "value" },
  fold: (state, snapshot) => ({
    ...state,
    value: typeof snapshot["value"] === "string" ? snapshot["value"] : "",
  }),
  tags: { group: "div", root: "button", input: "input", indicator: "span" },
  bound: ["group", "root"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
