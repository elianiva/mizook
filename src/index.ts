import { Effect, Match } from "effect";
import { routeAgentRequest } from "agents";
import type { Env } from "./core/env";
import { getRuntime } from "./core/runtime";
import { serveScreenshot } from "./features/browser/routes";
import { ScreenshotError } from "./core/errors";

export { MizookAgent, ThinkMessengerStateAgent } from "./core/agent";

const route = Effect.fn("route")(function* (request: Request, env: Env, _ctx: ExecutionContext) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  return yield* Match.value(pathname).pipe(
    Match.when("/screenshots/", () =>
      Effect.tryPromise({
        try: () => serveScreenshot(url, env),
        catch: (cause) => new ScreenshotError({ cause }),
      }),
    ),
    Match.when("/", () => Effect.succeed(new Response("mizook", { status: 200 }))),
    Match.orElse(() =>
      Effect.gen(function* () {
        yield* Effect.logInfo(`not_found path=${pathname}`);
        return new Response("Not found", { status: 404 });
      }),
    ),
  );
});

function routeMessengerWebhook(request: Request, env: Env): Promise<Response> {
  // Route messenger webhooks (e.g. /messengers/telegram/webhook) to the
  // MizookAgent DO where Think's internal messenger runtime handles them.
  const name = env.MIZOOK_AGENT.idFromName("default");
  const stub = env.MIZOOK_AGENT.get(name);
  return stub.fetch(request);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const routed = await routeAgentRequest(request, env);
    if (routed) return routed;

    const url = new URL(request.url);

    // Messenger webhooks need to reach the MizookAgent DO so Think's
    // messenger runtime (ThinkMessengerRuntime.handleRequest) can process them.
    if (url.pathname.startsWith("/messengers/")) {
      return routeMessengerWebhook(request, env);
    }

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
