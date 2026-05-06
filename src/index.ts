import { routeAgentRequest } from "agents";
import type { Env } from "./env";
import { createRequestLogger } from "./logger";
import { createBot } from "./bot";
import { createCloudflareState } from "chat-state-cloudflare-do";
import { DiscordGatewayDO, getGatewayStub } from "discord-gateway-cloudflare-do";

export { MizookAgent } from "./agent";
export { ChatStateDO } from "chat-state-cloudflare-do";
export { DiscordGatewayDO };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const routed = await routeAgentRequest(request, env);
    if (routed) return routed;

    const log = createRequestLogger(request, ctx);
    const url = new URL(request.url);

    if (url.pathname === "/telegram") {
      const state = createCloudflareState({ namespace: env.CHAT_STATE });
      const bot = createBot(env, state);
      return bot.webhooks.telegram(request, { waitUntil: (p) => ctx.waitUntil(p) });
    }

    if (url.pathname === "/webhooks/discord") {
      const state = createCloudflareState({ namespace: env.CHAT_STATE });
      const bot = createBot(env, state);
      return bot.webhooks.discord(request, { waitUntil: (p) => ctx.waitUntil(p) });
    }

    if (url.pathname === "/discord/connect" && request.method === "POST") {
      const gateway = getGatewayStub({ namespace: env.DISCORD_GATEWAY }) as any;
      return Response.json(
        await gateway.connect({
          botToken: env.DISCORD_BOT_TOKEN,
          webhookUrl: `${url.origin}/webhooks/discord`,
        }),
      );
    }

    if (url.pathname === "/discord/status") {
      const gateway = getGatewayStub({ namespace: env.DISCORD_GATEWAY }) as any;
      return Response.json(await gateway.status());
    }

    if (url.pathname === "/discord/disconnect" && request.method === "POST") {
      const gateway = getGatewayStub({ namespace: env.DISCORD_GATEWAY }) as any;
      return Response.json(await gateway.disconnect());
    }

    if (url.pathname === "/health") {
      log.set({ detail: { action: "health_check" } });
      log.emit({ message: "health_check", detail: { status: 200 } });
      return new Response("OK", { status: 200 });
    }

    log.set({ detail: { action: "not_found", path: url.pathname } });
    log.emit({ message: "not_found", detail: { status: 404 } });
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
