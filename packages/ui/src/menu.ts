import { menu } from "@ui-sdk/core/menu";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import type { Snapshot } from "./internal/bind.ts";
import { primitiveOf } from "./internal/render.ts";
import { popupCompletions, popupFields, popupFold, popupInit } from "./popup.ts";

export const State = Schema.Struct({
  ...popupFields,
  /** The value of the item last chosen. An item press is an event, not state, so this is its trace. */
  action: Schema.String,
});
export type State = typeof State.Type;

export const init = (state: { key: string; open?: boolean }): State => ({
  ...popupInit(state),
  action: "",
});

type Slot = "trigger" | "content" | "viewport" | "item" | "group" | "separator" | "shortcut";

export const component = defineComponent<State, Slot>({
  name: "menu",
  primitive: primitiveOf(menu),
  state: State,
  key: (state) => state.key,
  options: (state) => ({ open: state.open }),
  controlled: ["open"],
  callbacks: { onOpenChange: "open" },
  // `onAction` fires for an item press. It cannot be refused, so it rides the completion path.
  completions: { ...popupCompletions, onAction: "action" },
  renderState: (state) => ({ mounted: state.mounted }),
  fold: (state: State, snapshot: Snapshot): State => {
    const folded = popupFold(state, snapshot);
    const action = snapshot["action"];
    return typeof action === "string" ? { ...folded, action } : folded;
  },
  tags: {
    trigger: "button",
    content: "div",
    viewport: "div",
    item: "div",
    group: "div",
    separator: "div",
    shortcut: "span",
  },
  bound: ["trigger", "content", "viewport", "item", "group"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
