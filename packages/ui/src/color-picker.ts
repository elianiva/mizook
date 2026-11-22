import { colorPicker } from "@ui-sdk/core/color-picker";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";

export const State = Schema.Struct({
  key: Schema.String,
  /** The color as `#rrggbb`. */
  value: Schema.String,
  /** What is typed in the input and not yet a color. Null shows the value. */
  text: Schema.NullOr(Schema.String),
});
export type State = typeof State.Type;

export const init = (state: { key: string; value?: string }): State => ({
  key: state.key,
  value: state.value ?? "#0ea5e9",
  text: null,
});

const hexOf = (text: string): string | undefined => {
  const match = /^#?([0-9a-f]{6})$/i.exec(text.trim());
  return match?.[1] === undefined ? undefined : `#${match[1].toLowerCase()}`;
};

type Slot =
  | "root"
  | "area"
  | "area-thumb"
  | "slider"
  | "slider-thumb"
  | "input"
  | "swatch"
  | "swatches"
  | "swatch-item";

export const component = defineComponent<State, Slot>({
  name: "color-picker",
  primitive: primitiveOf(colorPicker),
  state: State,
  key: (state) => state.key,
  options: (state) => ({ value: state.value, space: "hsv", format: "hex" }),
  controlled: ["value"],
  callbacks: { onValueChange: "value" },
  renderState: (state) => ({ text: state.text }),
  fold: (state, snapshot) => ({
    ...state,
    value: typeof snapshot["value"] === "string" ? snapshot["value"] : state.value,
    text: null,
  }),
  typed: (state, text) => {
    const hex = hexOf(text);
    return hex === undefined ? { ...state, text } : { ...state, value: hex, text: null };
  },
  text: "input",
  tags: {
    root: "div",
    area: "div",
    "area-thumb": "div",
    slider: "div",
    "slider-thumb": "div",
    input: "input",
    swatch: "div",
    swatches: "div",
    "swatch-item": "button",
  },
  bound: [
    "root",
    "area",
    "area-thumb",
    "slider",
    "slider-thumb",
    "input",
    "swatches",
    "swatch-item",
  ],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
