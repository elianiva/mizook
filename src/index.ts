import { routeAgentRequest } from "agents";
import type { Env } from "./env";
import { handleTelegramWebhook } from "./telegram";
import { createRequestLogger } from "./logger";

export { MizookAgent } from "./agent";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const routed = await routeAgentRequest(request, env);
    if (routed) return routed;

    const log = createRequestLogger(request, ctx);
    const url = new URL(request.url);

    if (url.pathname === "/telegram") {
      return handleTelegramWebhook(request, env, log);
    }

    if (url.pathname === "/health") {
      log.set({ action: "health_check" });
      log.emit({ status: 200 });
      return new Response("OK", { status: 200 });
    }

    log.set({ action: "not_found", path: url.pathname });
    log.emit({ status: 404 });
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
