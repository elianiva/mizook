import { hoverCard } from "@ui-sdk/core/hover-card";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import { primitiveOf } from "./internal/render.ts";
import { popupCompletions, popupFields, popupFold, popupInit } from "./popup.ts";

export const State = Schema.Struct(popupFields);
export type State = typeof State.Type;
export const init = popupInit;

type Slot = "trigger" | "content" | "arrow";

export const component = defineComponent<State, Slot>({
  name: "hover-card",
  primitive: primitiveOf(hoverCard),
  state: State,
  key: (state) => state.key,
  options: (state) => ({ open: state.open, delay: 300 }),
  controlled: ["open"],
  callbacks: { onOpenChange: "open" },
  completions: popupCompletions,
  renderState: (state) => ({ mounted: state.mounted }),
  fold: popupFold,
  tags: { trigger: "button", content: "div", arrow: "span" },
  bound: ["trigger", "content", "arrow"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
