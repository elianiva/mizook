import { input } from "@ui-sdk/core/input";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate, type Parts, type PartsConfig } from "./core.ts";
import { withText } from "./form-inputs.ts";
import { primitiveOf } from "./internal/render.ts";
import type { HtmlBuilder } from "foldkit/html";

export const State = Schema.Struct({ key: Schema.String, value: Schema.String });
export type State = typeof State.Type;

export const init = (state: { key: string; value?: string }): State => ({
  key: state.key,
  value: state.value ?? "",
});

type Slot = "root";

export const component = defineComponent<State, Slot>({
  name: "input",
  primitive: primitiveOf(input),
  state: State,
  key: (state) => state.key,
  options: (state) => ({ value: state.value }),
  controlled: ["value"],
  callbacks: { onValueChange: "value" },
  fold: (state, snapshot) => ({
    ...state,
    value: typeof snapshot["value"] === "string" ? snapshot["value"] : "",
  }),
  typed: (state, text) => ({ ...state, value: text }),
  text: "root",
  tags: { root: "input" },
  bound: ["root"],
});

const base = makeParts(component);

export const parts = <AppMessage>(
  state: State,
  h: HtmlBuilder<AppMessage>,
  config: PartsConfig<AppMessage>,
): Parts<AppMessage, Slot> =>
  withText<AppMessage, Slot>(base(state, h, config), "root", h, state.value);

export const update = makeUpdate(component);
