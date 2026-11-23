import { Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

/** A destructive action asks twice: the first click arms it, the second one does it. */
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
