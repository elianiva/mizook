import { Bot, webhookCallback } from "grammy";

export interface Env {
  BOT_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const bot = new Bot(env.BOT_TOKEN);

    bot.command("start", async (ctx) => {
      await ctx.reply("Started!");
    });

    bot.on("message:text", async (ctx) => {
      await ctx.reply("It's working!");
    });

    if (url.pathname === "/telegram") {
      return webhookCallback(bot, "cloudflare-mod")(request);
    }

    return new Response("Nothing to see here...", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
