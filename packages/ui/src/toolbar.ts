import { toolbar } from "@ui-sdk/core/toolbar";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";

export const State = Schema.Struct({
  key: Schema.String,
  vertical: Schema.Boolean,
  disabled: Schema.Boolean,
});
export type State = typeof State.Type;

export const init = (state: { key: string; vertical?: boolean; disabled?: boolean }): State => ({
  key: state.key,
  vertical: state.vertical ?? false,
  disabled: state.disabled ?? false,
});

type Slot = "root" | "button" | "group" | "input" | "link" | "separator";

export const component = defineComponent<State, Slot>({
  name: "toolbar",
  primitive: primitiveOf(toolbar),
  state: State,
  key: (state) => state.key,
  options: (state) => ({
    orientation: state.vertical ? "vertical" : "horizontal",
    disabled: state.disabled,
  }),
  controlled: [],
  callbacks: {},
  fold: (state) => state,
  tags: {
    root: "div",
    button: "button",
    group: "div",
    input: "input",
    link: "a",
    separator: "div",
  },
  bound: ["root", "button", "group", "input", "link"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
