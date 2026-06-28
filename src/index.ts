import { Match } from "effect";
import { routeAgentRequest } from "agents";
import type { Env } from "./core/env";
import { createRequestLogger } from "./core/logger";
import { handleTelegramWebhook } from "./features/telegram/webhook";
import { serveScreenshot } from "./features/browser/routes";

export { MizookAgent } from "./core/agent";
export { ChatStateDO } from "chat-state-cloudflare-do";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const routed = await routeAgentRequest(request, env);
    if (routed) return routed;

    const log = createRequestLogger(request, ctx);
    const url = new URL(request.url);

    return Match.value({ pathname: url.pathname, method: request.method }).pipe(
      Match.when({ pathname: "/telegram" }, () => handleTelegramWebhook(request, env, ctx)),
      Match.when({ pathname: "/screenshots/" }, () => serveScreenshot(url, env)),
      Match.when({ pathname: "/health" }, () => {
        log.set({ detail: { action: "health_check" } });
        log.emit({ message: "health_check", detail: { status: 200 } });
        return new Response("OK", { status: 200 });
      }),
      Match.orElse(({ pathname }) => {
        log.set({ detail: { action: "not_found", path: pathname } });
        log.emit({ message: "not_found", detail: { status: 404 } });
        return new Response("Not found", { status: 404 });
      }),
    );
  },
} satisfies ExportedHandler<Env>;
