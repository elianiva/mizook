import { Schema } from "effect";
import { Machine } from "foldkit/experimental";
import { to } from "foldkit/experimental/machine";
import { defineTaggedUnion } from "foldkit/schema";

import { Message } from "./message.ts";

export const PaletteState = defineTaggedUnion({
  Closed: {},
  Open: { query: Schema.String, index: Schema.Finite },
});
export type PaletteState = typeof PaletteState.Type;

const OPEN_AT_START = { query: "", index: 0 } as const;

/** The ⌘K jump menu. Its query and selection exist only while it is open. */
export const paletteMachine = Machine.define({
  state: PaletteState,
  message: Message,
  context: Schema.Struct({ resultCount: Schema.Finite }),
})({
  initial: PaletteState.Closed(),
  shared: [
    Machine.forStates(["Open"]).on({
      ClosedPalette: to("Closed", () => ({ model: PaletteState.Closed() })),
      ChosePalette: to("Closed", () => ({ model: PaletteState.Closed() })),
      PressedGo: to("Closed", () => ({ model: PaletteState.Closed() })),
    }),
  ],
  states: {
    Closed: {
      on: {
        PressedPalette: to("Open", () => ({ model: PaletteState.Open(OPEN_AT_START) })),
      },
    },
    Open: {
      on: {
        PressedPalette: to("Closed", () => ({ model: PaletteState.Closed() })),
        TypedPaletteQuery: to("Open", ({ message }) => ({
          model: PaletteState.Open({ query: message.value, index: 0 }),
        })),
        MovedPaletteSelection: to("Open", ({ state, message, context }) => ({
          model: PaletteState.Open({
            query: state.query,
            index:
              context.resultCount === 0
                ? state.index
                : (((state.index + message.by) % context.resultCount) + context.resultCount) %
                  context.resultCount,
          }),
        })),
      },
    },
  },
});
