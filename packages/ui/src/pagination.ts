import { pagination } from "@ui-sdk/core/pagination";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";

export { paginationRange } from "@ui-sdk/core/pagination";

export const State = Schema.Struct({
  key: Schema.String,
  page: Schema.Int,
  pageCount: Schema.Int,
});
export type State = typeof State.Type;

export const init = (state: { key: string; page?: number; pageCount: number }): State => ({
  key: state.key,
  page: state.page ?? 1,
  pageCount: state.pageCount,
});

type Slot = "root" | "list" | "item" | "link" | "previous" | "next" | "first" | "last" | "ellipsis";

export const component = defineComponent<State, Slot>({
  name: "pagination",
  primitive: primitiveOf(pagination),
  state: State,
  key: (state) => state.key,
  options: (state) => ({ page: state.page, pageCount: state.pageCount }),
  controlled: ["page"],
  callbacks: { onPageChange: "page" },
  fold: (state, snapshot) => ({
    ...state,
    page: typeof snapshot["page"] === "number" ? snapshot["page"] : state.page,
  }),
  tags: {
    root: "nav",
    list: "ul",
    item: "li",
    link: "button",
    previous: "button",
    next: "button",
    first: "button",
    last: "button",
    ellipsis: "span",
  },
  bound: ["root", "link", "previous", "next", "first", "last"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
