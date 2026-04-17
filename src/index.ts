import { webhookCallback, type Bot } from "grammy";
import { createBot } from "./telegram";

export interface Env {
  BOT_TOKEN: string;
}

let bot: Bot | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/telegram") {
      bot ??= createBot(env.BOT_TOKEN);
      return webhookCallback(bot, "cloudflare-mod")(request);
    }

    return new Response("Nothing to see here...", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
