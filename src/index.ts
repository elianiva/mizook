import { routeAgentRequest } from "agents";
import type { Env } from "./env";
import { createRequestLogger } from "./logger";
import { createBot } from "./bot";
import { createCloudflareState } from "chat-state-cloudflare-do";

export { MizookAgent } from "./agent";
export { ChatStateDO } from "chat-state-cloudflare-do";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const routed = await routeAgentRequest(request, env);
    if (routed) return routed;

    const log = createRequestLogger(request, ctx);
    const url = new URL(request.url);

    if (url.pathname === "/telegram") {
      const state = createCloudflareState({ namespace: env.CHAT_STATE });
      const bot = createBot(env, state);
      return bot.webhooks.telegram(request);
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
