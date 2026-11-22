// What every popup component shares (tooltip, popover, menu, select): the
// lifecycle rule from docs/adapter-api.md. `open` is what the user asked for;
// `mounted` is whether the content is still on screen, including during its exit.
// The Model carries it, `renderState` patches it into the render phase, and
// `onOpenChangeComplete` clears it.
import { Schema } from "effect";
import type { Snapshot } from "./internal/bind.ts";

export const popupFields = {
  key: Schema.String,
  open: Schema.Boolean,
  mounted: Schema.Boolean,
};

export type PopupState = Readonly<{ key: string; open: boolean; mounted: boolean }>;

export const popupInit = (state: { key: string; open?: boolean }) => ({
  key: state.key,
  open: state.open ?? false,
  mounted: state.open ?? false,
});

/** Folds `open` and `mounted` out of a snapshot. `mounted` stays true until its completion lands. */
export const popupFold = <S extends PopupState>(state: S, snapshot: Snapshot): S => {
  const open = snapshot["open"] === true;
  const mounted = snapshot["mounted"];
  return {
    ...state,
    open,
    mounted: typeof mounted === "boolean" ? mounted : state.mounted || open,
  };
};

export const popupCompletions = { onOpenChangeComplete: "mounted" } as const;
