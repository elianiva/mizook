import { dialog } from "@ui-sdk/core/dialog";
import { Schema } from "effect";
import { defineComponent, makeParts, makeUpdate } from "./core.ts";
import type { Snapshot } from "./internal/bind.ts";
import { primitiveOf } from "./internal/render.ts";

export const State = Schema.Struct({
  key: Schema.String,
  open: Schema.Boolean,
  /**
   * Still in the tree. True while open and while the exit animation runs. ui-sdk
   * keeps this in the instance and clears it when the animation settles, which a
   * pure render cannot see, so the Model carries it and `onOpenChangeComplete`
   * clears it.
   */
  mounted: Schema.Boolean,
  /** Whether the app renders a title and a description part. They name the content. */
  titled: Schema.Boolean,
  described: Schema.Boolean,
});
export type State = typeof State.Type;

export const init = (state: {
  key: string;
  open?: boolean;
  titled?: boolean;
  described?: boolean;
}): State => ({
  key: state.key,
  open: state.open ?? false,
  mounted: state.open ?? false,
  titled: state.titled ?? true,
  described: state.described ?? false,
});

const fold = (state: State, snapshot: Snapshot): State => {
  const open = snapshot["open"] === true;
  const mounted = snapshot["mounted"];
  return {
    ...state,
    open,
    mounted: typeof mounted === "boolean" ? mounted : state.mounted || open,
  };
};

type Slot = "trigger" | "backdrop" | "content" | "title" | "description" | "close" | "shortcut";

export const component = defineComponent<State, Slot>({
  name: "dialog",
  primitive: primitiveOf(dialog),
  state: State,
  key: (state) => state.key,
  options: (state) => ({ open: state.open }),
  controlled: ["open"],
  callbacks: { onOpenChange: "open" },
  completions: { onOpenChangeComplete: "mounted" },
  lockSlot: "content",
  fold,
  renderState: (state) => ({
    mounted: state.mounted,
    titled: state.titled,
    described: state.described,
  }),
  tags: {
    trigger: "button",
    backdrop: "div",
    content: "div",
    title: "h2",
    description: "p",
    close: "button",
    shortcut: "span",
  },
  bound: ["trigger", "backdrop", "content", "title", "description", "close"],
});

export const parts = makeParts(component);
export const update = makeUpdate(component);
