import { Match } from "effect";
import { routeAgentRequest } from "agents";
import type { Env } from "./env";
import { createRequestLogger } from "./logger";
import { createBot } from "./messaging/bot";
import { createCloudflareState } from "chat-state-cloudflare-do";
import { DiscordGatewayDO } from "discord-gateway-cloudflare-do";
import {
  connectDiscordGateway,
  getDiscordGatewayStatus,
  disconnectDiscordGateway,
} from "./platforms/discord/gateway";

export { MizookAgent } from "./agent/mizook-agent";
export { ChatStateDO } from "chat-state-cloudflare-do";
export { DiscordGatewayDO };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const routed = await routeAgentRequest(request, env);
    if (routed) return routed;

    const log = createRequestLogger(request, ctx);
    const url = new URL(request.url);

    const createBotHandler = () => {
      const state = createCloudflareState({ namespace: env.CHAT_STATE });
      return createBot(env, state);
    };

    return Match.value({ pathname: url.pathname, method: request.method }).pipe(
      Match.when({ pathname: "/telegram" }, () =>
        createBotHandler().webhooks.telegram(request, { waitUntil: (p) => ctx.waitUntil(p) }),
      ),
      Match.when({ pathname: "/webhooks/discord" }, () =>
        createBotHandler().webhooks.discord(request, { waitUntil: (p) => ctx.waitUntil(p) }),
      ),
      Match.when({ pathname: "/discord/connect", method: "POST" }, () =>
        connectDiscordGateway(env, url.origin),
      ),
      Match.when({ pathname: "/discord/status" }, () => getDiscordGatewayStatus(env)),
      Match.when({ pathname: "/discord/disconnect", method: "POST" }, () =>
        disconnectDiscordGateway(env),
      ),
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
