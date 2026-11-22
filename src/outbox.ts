import { Context, Duration, Effect, Layer } from "effect";
import { ToolError } from "./errors.ts";
import { State } from "./state.ts";
import type { StateError } from "./errors.ts";

export type Sink = (threadId: string, text: string) => Effect.Effect<void>;

const BASE_TYPING_PAUSE_MS = 300;
const TYPING_MS_PER_CHARACTER = 25;
const MAX_TYPING_PAUSE_MS = 1_500;

export const typingPause = (text: string): Duration.Duration =>
  Duration.millis(
    Math.min(MAX_TYPING_PAUSE_MS, BASE_TYPING_PAUSE_MS + TYPING_MS_PER_CHARACTER * text.length),
  );

export class Outbox extends Context.Service<
  Outbox,
  {
    attach(
      sink: Sink,
      options?: { readonly pace?: (threadId: string) => boolean },
    ): Effect.Effect<void>;
    send(
      threadId: string,
      texts: ReadonlyArray<string>,
    ): Effect.Effect<void, ToolError | StateError>;
    take(threadId: string): Effect.Effect<number, StateError>;
  }
>()("mizook/Outbox") {
  static readonly layer = Layer.effect(
    Outbox,
    Effect.gen(function* () {
      const state = yield* State;
      let sink: Sink | undefined;
      let pace: ((threadId: string) => boolean) | undefined;
      const key = (threadId: string) => `sent:${threadId}`;
      return Outbox.of({
        attach: (next, options) =>
          Effect.sync(() => {
            sink = next;
            pace = options?.pace;
          }),
        send: (threadId, texts) =>
          Effect.gen(function* () {
            const out = sink;
            if (!out) return yield* new ToolError({ reason: "the chat is not connected" });
            const shouldPace = pace?.(threadId) ?? true;
            for (const [i, text] of texts.entries()) {
              if (i > 0 && shouldPace) yield* Effect.sleep(typingPause(text));
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
