import { checkbox, checkboxGroup } from "@ui-sdk/core/checkbox";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { named } from "./form-inputs.ts";
import { primitiveOf } from "./internal/render.ts";

export const State = Schema.Struct({
  key: Schema.String,
  checked: Schema.Boolean,
  disabled: Schema.Boolean,
  /** The name a form submits the hidden `input` under. Empty: not part of a form. */
  name: Schema.String,
});
export type State = typeof State.Type;

export const init = (state: {
  key: string;
  checked?: boolean;
  disabled?: boolean;
  name?: string;
}): State => ({
  key: state.key,
  checked: state.checked ?? false,
  disabled: state.disabled ?? false,
  name: state.name ?? "",
});

type Slot = "root" | "input" | "indicator";

export const component = defineComponent<State, Slot>({
  name: "checkbox",
  primitive: primitiveOf(checkbox),
  state: State,
  key: (state) => state.key,
  options: (state) => ({ checked: state.checked, disabled: state.disabled, ...named(state.name) }),
  controlled: ["checked"],
  callbacks: { onCheckedChange: "checked" },
  fold: (state, snapshot) => ({ ...state, checked: snapshot["checked"] === true }),
  tags: { root: "button", input: "input", indicator: "span" },
  bound: ["root"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);

// A checkbox cannot join a group's instance: a group lives in the registry, a checkbox in its own
// instance. So the group is Model-driven: the app folds each checkbox into `value` with `toggled`,
// and the group renders `group` and one hidden `group-input` per checked value.
export const GroupState = Schema.Struct({
  key: Schema.String,
  value: Schema.Array(Schema.String),
  name: Schema.String,
  disabled: Schema.Boolean,
});
export type GroupState = typeof GroupState.Type;

export const groupInit = (state: {
  key: string;
  value?: ReadonlyArray<string>;
  name?: string;
  disabled?: boolean;
}): GroupState => ({
  key: state.key,
  value: state.value ?? [],
  name: state.name ?? "",
  disabled: state.disabled ?? false,
});

/** The group's state after the checkbox for `value` is checked or unchecked. */
export const toggled = (state: GroupState, value: string, checked: boolean): GroupState => ({
  ...state,
  value: checked
    ? state.value.includes(value)
      ? state.value
      : [...state.value, value]
    : state.value.filter((existing) => existing !== value),
});

type GroupSlot = "group" | "group-input";

export const groupComponent = defineComponent<GroupState, GroupSlot>({
  name: "checkbox-group",
  primitive: primitiveOf(checkboxGroup),
  state: GroupState,
  key: (state) => state.key,
  options: (state) => ({
    value: [...state.value],
    disabled: state.disabled,
    ...named(state.name),
  }),
  controlled: [],
  callbacks: {},
  fold: (state) => state,
  tags: { group: "div", "group-input": "input" },
  bound: [],
});

export const groupParts = makeParts(groupComponent);
