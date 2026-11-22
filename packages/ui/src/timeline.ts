import { timeline } from "@ui-sdk/core/timeline";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";

export const State = Schema.Struct({
  key: Schema.String,
  vertical: Schema.Boolean,
});
export type State = typeof State.Type;

export const init = (state: { key: string; vertical?: boolean }): State => ({
  key: state.key,
  vertical: state.vertical ?? true,
});

type Slot = "root" | "item" | "marker" | "connector" | "time" | "title" | "description";

export const component = defineComponent<State, Slot>({
  name: "timeline",
  primitive: primitiveOf(timeline),
  state: State,
  key: (state) => state.key,
  options: (state) => ({ orientation: state.vertical ? "vertical" : "horizontal" }),
  controlled: [],
  callbacks: {},
  fold: (state) => state,
  tags: {
    root: "ul",
    item: "li",
    marker: "span",
    connector: "span",
    time: "span",
    title: "h3",
    description: "p",
  },
  bound: ["root", "item", "time", "title", "description"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
