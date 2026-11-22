import { switchPrimitive } from "@ui-sdk/core/switch";
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

type Slot = "root" | "input" | "thumb";

export const component = defineComponent<State, Slot>({
  name: "switch",
  primitive: primitiveOf(switchPrimitive),
  state: State,
  key: (state) => state.key,
  options: (state) => ({ checked: state.checked, disabled: state.disabled, ...named(state.name) }),
  controlled: ["checked"],
  callbacks: { onCheckedChange: "checked" },
  fold: (state, snapshot) => ({ ...state, checked: snapshot["checked"] === true }),
  tags: { root: "button", input: "input", thumb: "span" },
  bound: ["root"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
