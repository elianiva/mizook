import { toggle, toggleGroup } from "@ui-sdk/core/toggle";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";

export const State = Schema.Struct({
  key: Schema.String,
  pressed: Schema.Boolean,
  disabled: Schema.Boolean,
});
export type State = typeof State.Type;

export const init = (state: { key: string; pressed?: boolean; disabled?: boolean }): State => ({
  key: state.key,
  pressed: state.pressed ?? false,
  disabled: state.disabled ?? false,
});

type Slot = "root" | "icon";

export const component = defineComponent<State, Slot>({
  name: "toggle",
  primitive: primitiveOf(toggle),
  state: State,
  key: (state) => state.key,
  options: (state) => ({ pressed: state.pressed, disabled: state.disabled }),
  controlled: ["pressed"],
  callbacks: { onPressedChange: "pressed" },
  fold: (state, snapshot) => ({ ...state, pressed: snapshot["pressed"] === true }),
  tags: { root: "button", icon: "span" },
  bound: ["root"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);

// Toggles cannot join a group's instance (see `Checkbox.groupComponent`). The group is
// Model-driven: the app keeps `value` with `pressed`, and each toggle's `pressed` follows it.
export const GroupState = Schema.Struct({
  key: Schema.String,
  value: Schema.Array(Schema.String),
  multiple: Schema.Boolean,
  disabled: Schema.Boolean,
});
export type GroupState = typeof GroupState.Type;

export const groupInit = (state: {
  key: string;
  value?: ReadonlyArray<string>;
  multiple?: boolean;
  disabled?: boolean;
}): GroupState => ({
  key: state.key,
  value: state.value ?? [],
  multiple: state.multiple ?? false,
  disabled: state.disabled ?? false,
});

/** The group's state after the toggle for `value` is pressed or released. */
export const pressed = (state: GroupState, value: string, on: boolean): GroupState => ({
  ...state,
  value: on
    ? state.multiple
      ? [...state.value.filter((existing) => existing !== value), value]
      : [value]
    : state.value.filter((existing) => existing !== value),
});

export const groupComponent = defineComponent<GroupState, "group">({
  name: "toggle-group",
  primitive: primitiveOf(toggleGroup),
  state: GroupState,
  key: (state) => state.key,
  options: (state) => ({
    value: [...state.value],
    multiple: state.multiple,
    disabled: state.disabled,
  }),
  controlled: [],
  callbacks: {},
  fold: (state) => state,
  tags: { group: "div" },
  bound: [],
});

export const groupParts = makeParts(groupComponent);
