import { WebChat, type Approval } from "@mizook/chat-sync";
import { Cloudflare } from "@yielded/sync-platform-cloudflare";
import { Context, Effect, Layer, Predicate, Schedule } from "effect";
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
    autoTitle(place: string, title: string, from: string): Effect.Effect<void, StateError>;
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
        const execute = <A extends Parameters<typeof client.execute>[0]>(
          operation: string,
          action: A,
          payload: Parameters<typeof client.execute<A>>[1]["payload"],
        ) =>
          client
            .execute(action, { commandId: crypto.randomUUID(), admittedGeneration: null, payload })
            .pipe(
              Effect.retry(Schedule.recurs(3)),
              Effect.mapError((cause) => new StateError({ operation, cause })),
              Effect.flatMap((outcome) =>
                Predicate.isTagged(outcome, "Rejected")
                  ? Effect.fail(new StateError({ operation, cause: outcome.error.reason }))
                  : Effect.void,
              ),
            );
        return WebChatClient.of({
          appendAgent: (place, text) =>
            execute("append a web message", WebChat.actions.appendAgent, {
              threadId: threadIdOf(place),
              text,
            }),
          setStatus: (place, running, approvals) =>
            execute("publish the web turn status", WebChat.actions.setStatus, {
              threadId: threadIdOf(place),
              running,
              approvals,
            }),
          autoTitle: (place, title, from) =>
            execute("name a web thread", WebChat.actions.autoTitle, {
              threadId: threadIdOf(place),
              title,
              from,
            }),
        });
      }),
    );
}
