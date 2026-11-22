import { scrollArea } from "@ui-sdk/core/scroll-area";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";

// Scroll position is DOM state, so nothing here is controlled.
export const State = Schema.Struct({ key: Schema.String });
export type State = typeof State.Type;

export const init = (state: { key: string }): State => ({ key: state.key });

type Slot = "root" | "viewport" | "content" | "scrollbar" | "thumb" | "corner";

export const component = defineComponent<State, Slot>({
  name: "scroll-area",
  primitive: primitiveOf(scrollArea),
  state: State,
  key: (state) => state.key,
  options: () => ({ type: "always" }),
  controlled: [],
  callbacks: {},
  fold: (state) => state,
  tags: {
    root: "div",
    viewport: "div",
    content: "div",
    scrollbar: "div",
    thumb: "div",
    corner: "div",
  },
  bound: ["root", "viewport", "scrollbar", "thumb", "corner"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
