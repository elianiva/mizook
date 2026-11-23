import { Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

/** Archiving asks twice: the first press arms one thread, the second one archives it. */
export const Confirmation = defineTaggedUnion({
  Resting: {},
  Armed: { key: Schema.String },
});
export type Confirmation = typeof Confirmation.Type;

export const isArmed = (confirmation: Confirmation, key: string): boolean =>
  Confirmation.match(confirmation, {
    Resting: () => false,
    Armed: (armed) => armed.key === key,
  });
