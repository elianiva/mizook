import { Duration, Effect, Schema } from "effect";
import { Command } from "foldkit";
import { defineTaggedUnion, taggedStruct } from "foldkit/schema";

/**
 * A destructive action asks twice: the first press arms one key, the second one
 * does it. An armed key lapses by itself after a few seconds.
 */
export const Confirmation = defineTaggedUnion({
  Resting: {},
  Armed: { key: Schema.String },
});
export type Confirmation = typeof Confirmation.Type;

const ARMED_FOR = Duration.seconds(4);

/** What `ExpireArmed` sends back. The app's Message union declares the same case. */
export const ExpiredArmed = taggedStruct("ExpiredArmed", { key: Schema.String });

/**
 * Sends `ExpiredArmed` after four seconds. Update rests the Confirmation only if
 * `key` is still the armed one, so a newer arming keeps its own four seconds.
 */
export const ExpireArmed = Command.define("ExpireArmed", {
  args: { key: Schema.String },
  messages: [ExpiredArmed],
  execute: ({ key }) => Effect.sleep(ARMED_FOR).pipe(Effect.as(ExpiredArmed({ key }))),
});

export const isArmed = (confirmation: Confirmation, key: string): boolean =>
  Confirmation.match(confirmation, {
    Resting: () => false,
    Armed: (armed) => armed.key === key,
  });

/** Arms `key`, with the Command that lapses it. */
export const arm = (key: string) => ({
  confirmation: Confirmation.Armed({ key }),
  command: ExpireArmed({ key }),
});
