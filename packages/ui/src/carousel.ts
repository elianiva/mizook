import { carousel } from "@ui-sdk/core/carousel";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";

export const State = Schema.Struct({ key: Schema.String, page: Schema.Finite });
export type State = typeof State.Type;

export const init = (state: { key: string; page?: number }): State => ({
  key: state.key,
  page: state.page ?? 1,
});

type Slot =
  | "root"
  | "viewport"
  | "content"
  | "item"
  | "previous"
  | "next"
  | "indicator-group"
  | "indicator";

export const component = defineComponent<State, Slot>({
  name: "carousel",
  primitive: primitiveOf(carousel),
  state: State,
  key: (state) => state.key,
  options: (state) => ({ page: state.page }),
  controlled: ["page"],
  callbacks: { onPageChange: "page" },
  fold: (state, snapshot) => ({
    ...state,
    page: typeof snapshot["page"] === "number" ? snapshot["page"] : state.page,
  }),
  tags: {
    root: "div",
    viewport: "div",
    content: "div",
    item: "div",
    previous: "button",
    next: "button",
    "indicator-group": "div",
    indicator: "button",
  },
  bound: [
    "root",
    "viewport",
    "content",
    "item",
    "previous",
    "next",
    "indicator-group",
    "indicator",
  ],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
