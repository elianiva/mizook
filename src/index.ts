import { Effect, Match } from "effect";
import { routeAgentRequest } from "agents";
import type { Env } from "./core/env";
import { getRuntime } from "./core/runtime";
import { handleTelegramWebhook } from "./features/telegram/webhook";
import { serveScreenshot } from "./features/browser/routes";
import { serveArtifact, listArtifacts } from "./features/artifacts/routes";
import { serveAsset } from "./features/artifacts/asset-routes";

export { MizookAgent } from "./core/agent";
export { ChatStateDO } from "chat-state-cloudflare-do";

const route = (request: Request, env: Env, ctx: ExecutionContext) =>
  Effect.gen(function* () {
    const url = new URL(request.url);
    const pathname = url.pathname;

    return yield* Match.value(pathname).pipe(
      Match.when("/telegram", () =>
        Effect.tryPromise(() => handleTelegramWebhook(request, env, ctx)),
      ),
      Match.when(
        (p) => p.startsWith("/assets/"),
        () => Effect.tryPromise(() => serveAsset(url, env)),
      ),
      Match.when("/screenshots/", () => Effect.tryPromise(() => serveScreenshot(url, env))),
      Match.when(
        (p) => p.startsWith("/artifacts/"),
        () => Effect.tryPromise(() => serveArtifact(url, env)),
      ),
      Match.when("/", () => Effect.tryPromise(() => listArtifacts(env))),
      Match.when("/health", () => Effect.succeed(new Response("OK", { status: 200 }))),
      Match.orElse(() =>
        Effect.gen(function* () {
          yield* Effect.logInfo(`not_found path=${pathname}`);
          return new Response("Not found", { status: 404 });
        }),
      ),
    );
  });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const routed = await routeAgentRequest(request, env);
    if (routed) return routed;

    const url = new URL(request.url);
    return getRuntime(env).runPromise(
      route(request, env, ctx).pipe(
        Effect.annotateLogs({ method: request.method, path: url.pathname }),
        Effect.tap((resp) => Effect.logInfo(`http_response status=${resp.status}`)),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError("http_request_failed", cause);
            return new Response("Internal error", { status: 500 });
          }),
        ),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
