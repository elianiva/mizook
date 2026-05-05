import { routeAgentRequest } from "agents";
import type { Env } from "./env";
import { handleTelegramWebhook } from "./telegram";

export { MizookAgent } from "./agent";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const routed = await routeAgentRequest(request, env);
    if (routed) return routed;

    const url = new URL(request.url);

    if (url.pathname === "/telegram") {
      return handleTelegramWebhook(request, env);
    }

    // Health check
    if (url.pathname === "/health") {
      return new Response("OK", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
