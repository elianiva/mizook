import { segmentedControl } from "@ui-sdk/core/segmented-control";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";

export const State = Schema.Struct({
  key: Schema.String,
  /** The chosen item's value, or empty when none is chosen. */
  value: Schema.String,
  disabled: Schema.Boolean,
});
export type State = typeof State.Type;

export const init = (state: { key: string; value?: string; disabled?: boolean }): State => ({
  key: state.key,
  value: state.value ?? "",
  disabled: state.disabled ?? false,
});

type Slot = "root" | "item" | "indicator" | "input";

export const component = defineComponent<State, Slot>({
  name: "segmented-control",
  primitive: primitiveOf(segmentedControl),
  state: State,
  key: (state) => state.key,
  options: (state) => ({
    value: state.value === "" ? null : state.value,
    disabled: state.disabled,
  }),
  controlled: ["value"],
  callbacks: { onValueChange: "value" },
  fold: (state, snapshot) => ({
    ...state,
    value: typeof snapshot["value"] === "string" ? snapshot["value"] : "",
  }),
  tags: { root: "div", item: "button", indicator: "span", input: "input" },
  bound: ["root", "item", "indicator", "input"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
