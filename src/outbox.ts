import { Context, Duration, Effect, Layer } from "effect";
import { ToolError } from "./errors.ts";
import { State } from "./state.ts";
import type { StateError } from "./errors.ts";

/** Puts one bubble in front of the user. Set once by the bot, which owns the Telegram connection. */
export type Sink = (threadId: string, text: string) => Effect.Effect<void>;

/** How long a person takes to type the next bubble: a beat, longer for a longer one. */
export const typingPause = (text: string): Duration.Duration =>
  Duration.millis(Math.min(1_500, 300 + 25 * text.length));

/**
 * How the agent talks: `send_to_user` puts bubbles in the chat while the turn goes on, like a person
 * texting, so the final text of a turn is not what the user reads. Counts what a turn sent, so a
 * turn that sent nothing still gets its final text posted.
 */
export class Outbox extends Context.Service<
  Outbox,
  {
    attach(sink: Sink): Effect.Effect<void>;
    /** Send the bubbles in order, with a typing pause between them. */
    send(
      threadId: string,
      texts: ReadonlyArray<string>,
    ): Effect.Effect<void, ToolError | StateError>;
    /** How many bubbles the turn of this chat sent; resets the count. */
    take(threadId: string): Effect.Effect<number, StateError>;
  }
>()("mizook/Outbox") {
  static readonly layer = Layer.effect(
    Outbox,
    Effect.gen(function* () {
      const state = yield* State;
      let sink: Sink | undefined;
      const key = (threadId: string) => `sent:${threadId}`;
      return Outbox.of({
        attach: (next) => Effect.sync(() => void (sink = next)),
        send: (threadId, texts) =>
          Effect.gen(function* () {
            const out = sink;
            if (!out) return yield* new ToolError({ reason: "the chat is not connected" });
            for (const [i, text] of texts.entries()) {
              if (i > 0) yield* Effect.sleep(typingPause(text));
              yield* out(threadId, text);
              const sent = Number((yield* state.meta(key(threadId))) ?? "0");
              yield* state.setMeta(key(threadId), String(sent + 1));
            }
          }),
        take: (threadId) =>
          Effect.gen(function* () {
            const sent = Number((yield* state.meta(key(threadId))) ?? "0");
            if (sent > 0) yield* state.deleteMeta(key(threadId));
            return sent;
          }),
      });
    }),
  );
}
