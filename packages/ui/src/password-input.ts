import { passwordInput } from "@ui-sdk/core/password-input";
import { Schema } from "effect";
import type { HtmlBuilder } from "foldkit/html";
import { defineComponent, makeParts, makeUpdate, type Parts, type PartsConfig } from "./core.ts";
import { withText } from "./form-inputs.ts";
import { primitiveOf } from "./internal/render.ts";

export const State = Schema.Struct({
  key: Schema.String,
  value: Schema.String,
  visible: Schema.Boolean,
});
export type State = typeof State.Type;

export const init = (state: { key: string; value?: string; visible?: boolean }): State => ({
  key: state.key,
  value: state.value ?? "",
  visible: state.visible ?? false,
});

type Slot = "root" | "control" | "toggle";

export const component = defineComponent<State, Slot>({
  name: "password-input",
  primitive: primitiveOf(passwordInput),
  state: State,
  key: (state) => state.key,
  options: (state) => ({ value: state.value, visible: state.visible }),
  controlled: ["value", "visible"],
  callbacks: { onValueChange: "value", onVisibleChange: "visible" },
  fold: (state, snapshot) => ({
    ...state,
    value: typeof snapshot["value"] === "string" ? snapshot["value"] : state.value,
    visible: snapshot["visible"] === true,
  }),
  typed: (state, text) => ({ ...state, value: text }),
  text: "control",
  tags: { root: "div", control: "input", toggle: "button" },
  bound: ["root", "control", "toggle"],
});

const base = makeParts(component);

export const parts = <AppMessage>(
  state: State,
  h: HtmlBuilder<AppMessage>,
  config: PartsConfig<AppMessage>,
): Parts<AppMessage, Slot> =>
  withText<AppMessage, Slot>(base(state, h, config), "control", h, state.value);

export const update = makeUpdate(component);
