import { navigationMenu } from "@ui-sdk/core/navigation-menu";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";

export const State = Schema.Struct({
  key: Schema.String,
  /** The open item's value, or empty when none is open. */
  value: Schema.String,
});
export type State = typeof State.Type;

export const init = (state: { key: string }): State => ({ key: state.key, value: "" });

type Slot = "root" | "list" | "item" | "trigger" | "content" | "link" | "indicator" | "viewport";

export const component = defineComponent<State, Slot>({
  name: "navigation-menu",
  primitive: primitiveOf(navigationMenu),
  state: State,
  key: (state) => state.key,
  options: (state) => ({ value: state.value === "" ? null : state.value }),
  controlled: ["value"],
  callbacks: { onValueChange: "value" },
  fold: (state, snapshot) => ({
    ...state,
    value: typeof snapshot["value"] === "string" ? snapshot["value"] : "",
  }),
  tags: {
    root: "nav" as never,
    list: "ul",
    item: "li",
    trigger: "button",
    content: "div",
    link: "span",
    indicator: "div",
    viewport: "div",
  },
  bound: ["root", "list", "item", "trigger", "content", "link", "indicator", "viewport"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
