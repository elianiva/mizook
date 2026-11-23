import { WebChat, type Approval } from "@mizook/chat-sync";
import { Cloudflare } from "@yielded/sync-platform-cloudflare";
import { Context, Effect, Layer, Schedule } from "effect";
import { StateError } from "../errors.ts";
import type { Env } from "../env.ts";
import { INTERNAL_PRINCIPAL } from "./web-chat-source.ts";

const threadIdOf = (place: string): string => place.replace(/^web:/, "");

// A getter, because the client spreads the identity on every request. A fixed
// `Date.now() + …` would expire an hour after the isolate loaded this module.
const internalIdentity = {
  principal: INTERNAL_PRINCIPAL,
  actorId: INTERNAL_PRINCIPAL,
  get expiresAtMillis() {
    return Date.now() + 3_600_000;
  },
};

/** The agent's write path into the web chat source. */
export class WebChatClient extends Context.Service<
  WebChatClient,
  {
    appendAgent(place: string, text: string): Effect.Effect<void, StateError>;
    setStatus(
      place: string,
      running: boolean,
      approvals: ReadonlyArray<Approval>,
    ): Effect.Effect<void, StateError>;
  }
>()("mizook/WebChatClient") {
  static readonly layer = (env: Env) =>
    Layer.effect(
      WebChatClient,
      Effect.gen(function* () {
        const client = yield* Cloudflare.client(WebChat, {
          address: WebChat.address("main"),
          identity: internalIdentity,
          fetch: (request) =>
            Effect.promise(() => env.WebChat.getByName("web-chat").fetch(request)),
        });
        return WebChatClient.of({
          appendAgent: (place, text) =>
            Effect.gen(function* () {
              const outcome = yield* client
                .execute(WebChat.actions.appendAgent, {
                  commandId: crypto.randomUUID(),
                  admittedGeneration: null,
                  payload: { threadId: threadIdOf(place), text },
                })
                .pipe(Effect.retry(Schedule.recurs(3)));
              if (outcome._tag === "Rejected")
                return yield* new StateError({
                  operation: "append a web message",
                  cause: outcome.error.reason,
                });
            }).pipe(
              Effect.mapError((cause) =>
                cause instanceof StateError
                  ? cause
                  : new StateError({ operation: "append a web message", cause }),
              ),
            ),
          setStatus: (place, running, approvals) =>
            Effect.gen(function* () {
              const outcome = yield* client
                .execute(WebChat.actions.setStatus, {
                  commandId: crypto.randomUUID(),
                  admittedGeneration: null,
                  payload: { threadId: threadIdOf(place), running, approvals },
                })
                .pipe(Effect.retry(Schedule.recurs(3)));
              if (outcome._tag === "Rejected")
                return yield* new StateError({
                  operation: "publish the web turn status",
                  cause: outcome.error.reason,
                });
            }).pipe(
              Effect.mapError((cause) =>
                cause instanceof StateError
                  ? cause
                  : new StateError({ operation: "publish the web turn status", cause }),
              ),
            ),
        });
      }),
    );
}
