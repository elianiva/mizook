import { routeAgentRequest } from "agents";
import type { Env } from "./agent";
import { handleTelegramWebhook } from "./telegram";

export { ReiAgent } from "./agent";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const routed = await routeAgentRequest(request, env);
    if (routed) return routed;

    if (new URL(request.url).pathname === "/telegram") {
      return handleTelegramWebhook(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;