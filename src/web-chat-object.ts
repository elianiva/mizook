import { DurableObject } from "cloudflare:workers";
import { ProtocolError } from "@yielded/sync";
import { Cloudflare } from "@yielded/sync-platform-cloudflare";
import { Deferred, Effect } from "effect";
import { makeWebChatServer } from "./chat/web-chat-source.ts";
import type { Env } from "./env.ts";

/**
 * The web chat source. Its Durable Object storage, replay log, receipts, and
 * Effect RPC WebSocket all belong to this one object, so the browser replica
 * and the agent append through the same writer.
 */
export class WebChatObject extends DurableObject<Env> {
  private readonly ready: Promise<Cloudflare.Handlers>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const ready = Deferred.makeUnsafe<Cloudflare.Handlers, string>();
    this.ready = Effect.runPromise(Deferred.await(ready));
    const start = Effect.gen(function* () {
      const handlers = yield* Cloudflare.make(makeWebChatServer(env), ctx, {
        turnTimeoutMillis: 15_000,
      });
      yield* Deferred.succeed(ready, handlers);
      return yield* Effect.never;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logError("the web chat source could not start", cause);
          yield* Deferred.fail(ready, "The web chat source could not start.");
        }),
      ),
    );
    void Effect.runPromise(Effect.scoped(start).pipe(Effect.ignoreCause));
    void ctx.blockConcurrencyWhile(() =>
      Effect.runPromise(Effect.ignoreCause(Effect.promise(() => this.ready))),
    );
  }

  override async fetch(request: Request): Promise<Response> {
    const handlers = await this.ready;
    return Effect.runPromise(
      handlers.fetch(request).pipe(
        Effect.catchIf(
          (error): error is ProtocolError => error instanceof ProtocolError,
          (error) => Effect.succeed(Cloudflare.errorResponse(error)),
        ),
      ),
    );
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const handlers = await this.ready;
    await Effect.runPromise(handlers.webSocketMessage(socket, message));
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    const handlers = await this.ready;
    await Effect.runPromise(handlers.webSocketClose(socket));
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    const handlers = await this.ready;
    await Effect.runPromise(handlers.webSocketError(socket));
  }
}
