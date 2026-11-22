import { triggerMenu } from "@ui-sdk/core/trigger-menu";
import { fuzzyScore } from "@ui-sdk/core/text-match";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";
import { popupCompletions, popupFields, popupFold } from "./popup.ts";

export const Item = Schema.Struct({ value: Schema.String, label: Schema.String });
export type Item = typeof Item.Type;

export const State = Schema.Struct({
  ...popupFields,
  /** The character that opens the menu, such as `@`. */
  trigger: Schema.String,
  items: Schema.Array(Item),
  /** What follows the trigger, mirrored from the instance. */
  query: Schema.String,
});
export type State = typeof State.Type;

export const init = (state: {
  key: string;
  trigger: string;
  items: ReadonlyArray<Item>;
}): State => ({
  key: state.key,
  open: false,
  mounted: false,
  trigger: state.trigger,
  items: state.items,
  query: "",
});

/** The items that match the query. The app owns filtering, so it decides which parts exist. */
export const visibleItems = (state: State): ReadonlyArray<Item> =>
  state.query === ""
    ? state.items
    : state.items
        .map((item) => ({ item, score: fuzzyScore(item.label, state.query) }))
        .filter(({ score }) => score > 0)
        .toSorted((a, b) => b.score - a.score)
        .map(({ item }) => item);

type Slot =
  | "input"
  | "content"
  | "list"
  | "item"
  | "group"
  | "separator"
  | "empty"
  | "status"
  | "hint";

export const component = defineComponent<State, Slot>({
  name: "trigger-menu",
  primitive: primitiveOf(triggerMenu),
  state: State,
  key: (state) => state.key,
  options: (state) => ({
    open: state.open,
    triggers: [{ char: state.trigger, items: state.items.map((item) => ({ ...item })) }],
  }),
  controlled: ["open"],
  callbacks: { onOpenChange: "open" },
  completions: popupCompletions,
  // The query is the instance's: it reads the caret in the live input.
  mirror: ["query"],
  renderState: (state) => ({ mounted: state.mounted, query: state.query }),
  fold: (state, snapshot) => ({
    ...("open" in snapshot || "mounted" in snapshot ? popupFold(state, snapshot) : state),
    query: typeof snapshot["query"] === "string" ? snapshot["query"] : state.query,
  }),
  tags: {
    input: "input",
    content: "div",
    list: "div",
    item: "div",
    group: "div",
    separator: "div",
    empty: "div",
    status: "div",
    hint: "div",
  },
  bound: ["input", "content", "list", "item", "group", "empty", "status"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
