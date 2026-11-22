import { field, fieldSet } from "@ui-sdk/core/field";
import { Schema } from "effect";
import { defineComponent, makeParts } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";

/**
 * Field is render-only. With `invalid` supplied from outside, its parts are a
 * pure function of this state, so nothing binds and no Message comes back.
 */
export const State = Schema.Struct({
  key: Schema.String,
  invalid: Schema.Boolean,
  disabled: Schema.Boolean,
});
export type State = typeof State.Type;

export const init = (state: { key: string; invalid?: boolean; disabled?: boolean }): State => ({
  key: state.key,
  invalid: state.invalid ?? false,
  disabled: state.disabled ?? false,
});

type Slot = "root" | "label" | "description" | "error" | "control";

export const component = defineComponent<State, Slot>({
  name: "field",
  primitive: primitiveOf(field),
  state: State,
  key: (state) => state.key,
  options: (state) => ({ invalid: state.invalid, disabled: state.disabled }),
  controlled: [],
  callbacks: {},
  fold: (state) => state,
  tags: { root: "div", label: "label", description: "p", error: "p", control: "input" },
  bound: [],
});

export const parts = makeParts(component);

// A fieldset: `disabled` on it disables every control inside, and its legend names the group.
export const SetState = Schema.Struct({ key: Schema.String, disabled: Schema.Boolean });
export type SetState = typeof SetState.Type;

export const setInit = (state: { key: string; disabled?: boolean }): SetState => ({
  key: state.key,
  disabled: state.disabled ?? false,
});

export const setComponent = defineComponent<SetState, "set" | "legend" | "description">({
  name: "field-set",
  primitive: primitiveOf(fieldSet),
  state: SetState,
  key: (state) => state.key,
  options: (state) => ({ disabled: state.disabled }),
  controlled: [],
  callbacks: {},
  fold: (state) => state,
  tags: { set: "fieldset", legend: "legend", description: "p" },
  bound: [],
});

export const setParts = makeParts(setComponent);
