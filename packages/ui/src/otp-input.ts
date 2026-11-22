import { otpInput } from "@ui-sdk/core/otp-input";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";

export const State = Schema.Struct({
  key: Schema.String,
  value: Schema.String,
  maxLength: Schema.Finite,
});
export type State = typeof State.Type;

export const init = (state: { key: string; maxLength?: number }): State => ({
  key: state.key,
  value: "",
  maxLength: state.maxLength ?? 6,
});

type Slot = "root" | "control" | "group" | "slot" | "separator";

export const component = defineComponent<State, Slot>({
  name: "otp-input",
  primitive: primitiveOf(otpInput),
  state: State,
  key: (state) => state.key,
  options: (state) => ({ value: state.value, maxLength: state.maxLength }),
  controlled: ["value"],
  callbacks: { onValueChange: "value" },
  fold: (state, snapshot) => ({
    ...state,
    value: typeof snapshot["value"] === "string" ? snapshot["value"] : "",
  }),
  tags: { root: "div", control: "input", group: "div", slot: "div", separator: "div" },
  bound: ["root", "control", "group", "slot"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
