import { popover } from "@ui-sdk/core/popover";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";
import { popupCompletions, popupFields, popupFold, popupInit } from "./popup.ts";

export const State = Schema.Struct({ ...popupFields, titled: Schema.Boolean });
export type State = typeof State.Type;

export const init = (state: { key: string; open?: boolean; titled?: boolean }): State => ({
  ...popupInit(state),
  titled: state.titled ?? true,
});

type Slot =
  | "trigger"
  | "content"
  | "viewport"
  | "arrow"
  | "title"
  | "description"
  | "close"
  | "shortcut";

export const component = defineComponent<State, Slot>({
  name: "popover",
  primitive: primitiveOf(popover),
  state: State,
  key: (state) => state.key,
  options: (state) => ({ open: state.open }),
  controlled: ["open"],
  callbacks: { onOpenChange: "open" },
  completions: popupCompletions,
  renderState: (state) => ({ mounted: state.mounted, titled: state.titled }),
  fold: popupFold,
  tags: {
    trigger: "button",
    content: "div",
    viewport: "div",
    arrow: "span",
    shortcut: "span",
    title: "h3",
    description: "p",
    close: "button",
  },
  bound: ["trigger", "content", "viewport", "arrow", "title", "description", "close"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
